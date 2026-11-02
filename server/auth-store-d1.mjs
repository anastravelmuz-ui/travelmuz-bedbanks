// Stockage Cloudflare D1 (binding DB). Schéma créé à la première utilisation, idempotent.
export const AUTH_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('admin','agent')), active INTEGER NOT NULL DEFAULT 1, password_hash TEXT, failed_count INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS auth_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK (purpose IN ('invite','reset')), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens(user_id)`,
];
const COLS = { email: 'email', role: 'role', active: 'active', passwordHash: 'password_hash', failedCount: 'failed_count', lockedUntil: 'locked_until' };
const toUser = r => r && ({ id: r.id, email: r.email, role: r.role, active: !!r.active, passwordHash: r.password_hash, failedCount: r.failed_count, lockedUntil: r.locked_until, createdAt: r.created_at, updatedAt: r.updated_at });
let ready = null;

let factory = null;
/** Tests uniquement : substitue le stockage (null rétablit D1). */
export function setStoreFactory(f) { factory = f; }

export function createD1Store(db) {
  if (factory) return factory(db);
  const ensure = () => (ready ??= db.batch(AUTH_SCHEMA.map(s => db.prepare(s))).catch(e => { ready = null; throw e; }));
  const q = async (sql, ...args) => { await ensure(); return db.prepare(sql).bind(...args); };
  return {
    async countUsers() { return (await (await q('SELECT COUNT(*) AS n FROM users')).first()).n; },
    async countActiveAdmins() { return (await (await q("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1")).first()).n; },
    async getUserByEmail(email) { return toUser(await (await q('SELECT * FROM users WHERE email=?', email)).first()); },
    async getUserById(id) { return toUser(await (await q('SELECT * FROM users WHERE id=?', id)).first()); },
    async listUsers() { return ((await (await q('SELECT * FROM users ORDER BY email')).all()).results ?? []).map(toUser); },
    async insertUser(u) {
      await (await q('INSERT INTO users (id,email,role,active,password_hash,failed_count,locked_until,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        u.id, u.email, u.role, u.active ? 1 : 0, u.passwordHash ?? null, u.failedCount ?? 0, u.lockedUntil ?? null, u.createdAt, u.updatedAt)).run();
    },
    async updateUser(id, fields) {
      const keys = Object.keys(fields).filter(k => k in COLS);
      if (!keys.length) return;
      const vals = keys.map(k => (k === 'active' ? (fields[k] ? 1 : 0) : fields[k] ?? null));
      await (await q(`UPDATE users SET ${keys.map(k => COLS[k] + '=?').join(',')}, updated_at=? WHERE id=?`, ...vals, Date.now(), id)).run();
    },
    async deleteUser(id) {
      await ensure();
      await db.batch([db.prepare('DELETE FROM sessions WHERE user_id=?').bind(id), db.prepare('DELETE FROM auth_tokens WHERE user_id=?').bind(id), db.prepare('DELETE FROM users WHERE id=?').bind(id)]);
    },
    async insertSession(s) { await (await q('INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)', s.tokenHash, s.userId, s.expiresAt, s.createdAt)).run(); },
    async getSession(h) { const r = await (await q('SELECT * FROM sessions WHERE token_hash=?', h)).first(); return r && { tokenHash: r.token_hash, userId: r.user_id, expiresAt: r.expires_at }; },
    async deleteSession(h) { await (await q('DELETE FROM sessions WHERE token_hash=?', h)).run(); },
    async deleteUserSessions(userId) { await (await q('DELETE FROM sessions WHERE user_id=?', userId)).run(); },
    async insertToken(t) { await (await q('INSERT INTO auth_tokens (token_hash,user_id,purpose,expires_at,created_at) VALUES (?,?,?,?,?)', t.tokenHash, t.userId, t.purpose, t.expiresAt, t.createdAt)).run(); },
    async getToken(h) { const r = await (await q('SELECT * FROM auth_tokens WHERE token_hash=?', h)).first(); return r && { tokenHash: r.token_hash, userId: r.user_id, purpose: r.purpose, expiresAt: r.expires_at }; },
    async deleteToken(h) { await (await q('DELETE FROM auth_tokens WHERE token_hash=?', h)).run(); },
    async deleteUserTokens(userId, purpose) {
      await (purpose ? await q('DELETE FROM auth_tokens WHERE user_id=? AND purpose=?', userId, purpose) : await q('DELETE FROM auth_tokens WHERE user_id=?', userId)).run();
    },
  };
}
