// Couche HTTP des comptes : testable sans serveur (Request/Response standards).
import { AuthError, POLICY, hashToken } from './auth-core.mjs';
async function sameSecret(a, b) { return typeof a === 'string' && a.length <= 256 && (await hashToken(a)) === (await hashToken(b)); }
export const SESSION_COOKIE = '__Host-tm_session';
const NO_STORE = { 'Cache-Control': 'no-store' };
const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...extra } });

export function readCookie(request, name = SESSION_COOKIE) {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
const sessionCookie = (token, maxAge) => `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
const linkFor = (request, token) => `${new URL(request.url).origin}/reinitialiser.html#t=${token}`;

async function body(request) {
  if (Number(request.headers.get('content-length') ?? 0) > 4096) throw new AuthError('BODY_TOO_LARGE', 413);
  const raw = await request.text();
  if (raw.length > 4096) throw new AuthError('BODY_TOO_LARGE', 413);
  try { const v = JSON.parse(raw || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch {}
  throw new AuthError('INVALID_BODY', 400);
}
function sameOrigin(request) {
  // Protection CSRF : toute écriture exige l'en-tête Origin du site lui-même.
  if (request.method === 'GET') return;
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new AuthError('ORIGIN_REJECTED', 403);
}
export async function currentUser(request, auth) { return auth ? auth.session(readCookie(request)) : null; }

/**
 * action : login | logout | me | forgot | link | set-password | bootstrap | admin
 * ctx : { auth (null si la base n'est pas configurée), setupCode, firstAdminEmail, mailer? }
 */
export async function handleAuth(action, request, ctx) {
  try {
    if (!ctx.auth) return json({ error: 'STORAGE_NOT_CONFIGURED' }, 503);
    const { auth } = ctx;
    sameOrigin(request);
    switch (`${request.method} ${action}`) {
      case 'POST login': {
        const b = await body(request);
        const r = await auth.login(b.email, b.password);
        return json({ user: r.user }, 200, { 'Set-Cookie': sessionCookie(r.token, POLICY.sessionHours * 3600) });
      }
      case 'POST logout':
        await auth.logout(readCookie(request));
        return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
      case 'GET me': {
        const user = await currentUser(request, auth);
        return user ? json({ user }) : json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
      }
      case 'POST forgot': {
        const b = await body(request);
        // Réponse identique que le compte existe ou non. Sans service d'email configuré, aucun lien n'est créé.
        if (ctx.mailer) { const r = await auth.requestReset(b.email); if (r) await ctx.mailer.sendReset(r.email, linkFor(request, r.token)); }
        return json({ accepted: true, emailDelivery: !!ctx.mailer }, 202);
      }
      case 'POST link': {
        const b = await body(request);
        const info = await auth.checkLink(b.token);
        return info ? json(info) : json({ error: 'LINK_INVALID' }, 400);
      }
      case 'POST set-password': {
        const b = await body(request);
        return json(await auth.setPassword(b.token, b.password));
      }
      case 'POST bootstrap': {
        // Premier administrateur : base vide + code d'installation défini côté serveur (secret SETUP_CODE).
        const b = await body(request);
        if (!ctx.setupCode || ctx.setupCode.length < 16) throw new AuthError('SETUP_DISABLED', 403);
        if (!(await sameSecret(b.code, ctx.setupCode))) throw new AuthError('SETUP_CODE_INVALID', 403);
        const r = await auth.bootstrap(ctx.firstAdminEmail);
        return json({ user: r.user, link: linkFor(request, r.token), expiresAt: r.expiresAt }, 201);
      }
      case 'GET admin': {
        const actor = await currentUser(request, auth);
        if (!actor) throw new AuthError('AUTHENTICATION_REQUIRED', 401);
        return json({ users: await auth.listUsers(actor), me: actor.id });
      }
      case 'POST admin': {
        const actor = await currentUser(request, auth);
        if (!actor) throw new AuthError('AUTHENTICATION_REQUIRED', 401);
        const b = await body(request);
        switch (b.action) {
          case 'create': { const r = await auth.createUser(actor, { email: b.email, role: b.role }); return json({ user: r.user, link: linkFor(request, r.token), expiresAt: r.expiresAt }, 201); }
          case 'link': { const r = await auth.issueLink(actor, b.id); return json({ user: r.user, link: linkFor(request, r.token), purpose: r.purpose, expiresAt: r.expiresAt }); }
          case 'activate': return json({ user: await auth.setActive(actor, b.id, true) });
          case 'deactivate': return json({ user: await auth.setActive(actor, b.id, false) });
          case 'delete': return json(await auth.deleteUser(actor, b.id));
          default: throw new AuthError('ACTION_INVALID', 400);
        }
      }
      default: return json({ error: 'NOT_FOUND' }, 404);
    }
  } catch (e) {
    if (e instanceof AuthError) return json({ error: e.code }, e.status);
    return json({ error: 'SERVER_ERROR' }, 500); // aucun détail interne exposé
  }
}
