// Comptes TravelMuz : logique pure, indépendante du stockage (testée sans réseau).
const enc = new TextEncoder();
export const POLICY = Object.freeze({
  iterations: 100000, // plafond PBKDF2 accepté par Cloudflare Workers
  minPasswordLength: 12, maxPasswordLength: 128,
  sessionHours: 12, resetMinutes: 60, inviteHours: 72,
  maxFailures: 5, lockMinutes: 15,
});
export const ROLES = Object.freeze(['admin', 'agent']);
const b64 = u => { let s = ''; for (const c of u) s += String.fromCharCode(c); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = u => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class AuthError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }

export function randomToken(bytes = 32) { return b64url(crypto.getRandomValues(new Uint8Array(bytes))); }
export function newId() { return crypto.randomUUID(); }
export async function hashToken(token) { return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(token))))); }
function sameBytes(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const e = value.trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}
export function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < POLICY.minPasswordLength) return 'PASSWORD_TOO_SHORT';
  if (p.length > POLICY.maxPasswordLength) return 'PASSWORD_TOO_LONG';
  return null;
}
export async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = POLICY.iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
  return `pbkdf2$sha256$${iterations}$${b64(salt)}$${b64(bits)}`;
}
export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 5 || parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > POLICY.iterations) return false;
  const again = await hashPassword(String(password), unb64(parts[3]), iterations);
  return sameBytes(unb64(again.split('$')[4]), unb64(parts[4]));
}
const DUMMY_HASH = 'pbkdf2$sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export function publicUser(u) {
  return { id: u.id, email: u.email, role: u.role, active: !!u.active, hasPassword: !!u.passwordHash, createdAt: u.createdAt };
}

/** store : voir server/auth-store-memory.mjs pour le contrat. */
export function createAuth(store, now = () => Date.now()) {
  async function issueToken(userId, purpose) {
    await store.deleteUserTokens(userId, purpose);
    const token = randomToken();
    const ttl = purpose === 'invite' ? POLICY.inviteHours * 3600e3 : POLICY.resetMinutes * 60e3;
    const expiresAt = now() + ttl;
    await store.insertToken({ tokenHash: await hashToken(token), userId, purpose, expiresAt, createdAt: now() });
    return { token, purpose, expiresAt };
  }
  async function assertAdmin(actor) {
    // Droits relus en base à chaque action : un admin désactivé ou rétrogradé perd l'accès immédiatement.
    const fresh = actor && typeof actor.id === 'string' ? await store.getUserById(actor.id) : null;
    if (!fresh || fresh.role !== 'admin' || !fresh.active) throw new AuthError('ADMIN_REQUIRED', 403);
    return fresh;
  }
  async function target(id) { const u = typeof id === 'string' ? await store.getUserById(id) : null; if (!u) throw new AuthError('USER_NOT_FOUND', 404); return u; }
  async function keepOneAdmin(u) {
    if (u.role === 'admin' && u.active && await store.countActiveAdmins() <= 1) throw new AuthError('LAST_ADMIN', 409);
  }

  return {
    async login(emailInput, password) {
      const email = normalizeEmail(emailInput);
      const user = email ? await store.getUserByEmail(email) : null;
      const usable = user && user.active && user.passwordHash && !(user.lockedUntil && user.lockedUntil > now());
      const ok = await verifyPassword(String(password ?? ''), usable ? user.passwordHash : DUMMY_HASH);
      if (!usable || !ok) {
        if (usable) {
          const failed = (user.failedCount || 0) + 1;
          await store.updateUser(user.id, failed >= POLICY.maxFailures
            ? { failedCount: 0, lockedUntil: now() + POLICY.lockMinutes * 60e3 }
            : { failedCount: failed });
        }
        throw new AuthError('INVALID_CREDENTIALS', 401); // message identique : ne révèle ni l'existence ni le verrouillage
      }
      await store.updateUser(user.id, { failedCount: 0, lockedUntil: null });
      const token = randomToken();
      const expiresAt = now() + POLICY.sessionHours * 3600e3;
      await store.insertSession({ tokenHash: await hashToken(token), userId: user.id, expiresAt, createdAt: now() });
      return { token, expiresAt, user: publicUser(user) };
    },
    async session(token) {
      if (typeof token !== 'string' || !token || token.length > 128) return null;
      const h = await hashToken(token);
      const s = await store.getSession(h);
      if (!s) return null;
      if (s.expiresAt <= now()) { await store.deleteSession(h); return null; }
      const u = await store.getUserById(s.userId);
      if (!u || !u.active) { await store.deleteSession(h); return null; }
      return publicUser(u);
    },
    async logout(token) { if (typeof token === 'string' && token) await store.deleteSession(await hashToken(token)); },

    async checkLink(token) {
      if (typeof token !== 'string' || !token || token.length > 128) return null;
      const t = await store.getToken(await hashToken(token));
      if (!t || t.expiresAt <= now()) return null;
      const u = await store.getUserById(t.userId);
      return u && u.active ? { email: u.email, purpose: t.purpose } : null;
    },
    async setPassword(token, password) {
      const problem = passwordProblem(password);
      if (problem) throw new AuthError(problem, 400);
      if (typeof token !== 'string' || !token || token.length > 128) throw new AuthError('LINK_INVALID', 400);
      const h = await hashToken(token);
      const t = await store.getToken(h);
      if (!t || t.expiresAt <= now()) { if (t) await store.deleteToken(h); throw new AuthError('LINK_INVALID', 400); }
      const u = await store.getUserById(t.userId);
      if (!u || !u.active) throw new AuthError('LINK_INVALID', 400);
      await store.updateUser(u.id, { passwordHash: await hashPassword(password), failedCount: 0, lockedUntil: null });
      await store.deleteUserTokens(u.id);   // lien à usage unique
      await store.deleteUserSessions(u.id); // déconnecte les autres appareils
      return { email: u.email };
    },
    /** Retourne un lien à transmettre par email ; null si le compte n'est pas utilisable. */
    async requestReset(emailInput) {
      const email = normalizeEmail(emailInput);
      const u = email ? await store.getUserByEmail(email) : null;
      if (!u || !u.active) return null;
      return { email: u.email, ...(await issueToken(u.id, u.passwordHash ? 'reset' : 'invite')) };
    },

    async bootstrap(emailInput) {
      const email = normalizeEmail(emailInput);
      if (!email) throw new AuthError('EMAIL_INVALID', 400);
      if (await store.countUsers() > 0) throw new AuthError('ALREADY_INITIALIZED', 409);
      const user = { id: newId(), email, role: 'admin', active: true, passwordHash: null, failedCount: 0, lockedUntil: null, createdAt: now(), updatedAt: now() };
      await store.insertUser(user);
      return { user: publicUser(user), ...(await issueToken(user.id, 'invite')) };
    },
    async listUsers(actor) { await assertAdmin(actor); return (await store.listUsers()).map(publicUser); },
    async createUser(actor, { email: emailInput, role }) {
      await assertAdmin(actor);
      const email = normalizeEmail(emailInput);
      if (!email) throw new AuthError('EMAIL_INVALID', 400);
      if (!ROLES.includes(role)) throw new AuthError('ROLE_INVALID', 400);
      if (await store.getUserByEmail(email)) throw new AuthError('EMAIL_EXISTS', 409);
      const user = { id: newId(), email, role, active: true, passwordHash: null, failedCount: 0, lockedUntil: null, createdAt: now(), updatedAt: now() };
      await store.insertUser(user);
      return { user: publicUser(user), ...(await issueToken(user.id, 'invite')) };
    },
    async issueLink(actor, id) {
      await assertAdmin(actor);
      const u = await target(id);
      if (!u.active) throw new AuthError('USER_INACTIVE', 409);
      return { user: publicUser(u), ...(await issueToken(u.id, u.passwordHash ? 'reset' : 'invite')) };
    },
    async setActive(actor, id, active) {
      await assertAdmin(actor);
      const u = await target(id);
      if (u.id === actor.id) throw new AuthError('SELF_FORBIDDEN', 409);
      if (!active) { await keepOneAdmin(u); await store.deleteUserSessions(u.id); await store.deleteUserTokens(u.id); }
      await store.updateUser(u.id, { active: !!active, failedCount: 0, lockedUntil: null });
      return publicUser(await store.getUserById(u.id));
    },
    async deleteUser(actor, id) {
      await assertAdmin(actor);
      const u = await target(id);
      if (u.id === actor.id) throw new AuthError('SELF_FORBIDDEN', 409);
      await keepOneAdmin(u);
      await store.deleteUser(u.id);
      return { deleted: u.id };
    },
  };
}
