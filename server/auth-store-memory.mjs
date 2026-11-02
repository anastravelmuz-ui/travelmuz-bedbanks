// Stockage en mémoire : tests et développement local uniquement (perdu au redémarrage).
// Contrat commun avec auth-store-d1.mjs.
export function createMemoryStore() {
  const users = new Map(), sessions = new Map(), tokens = new Map();
  const copy = v => (v ? { ...v } : null);
  return {
    async countUsers() { return users.size; },
    async countActiveAdmins() { return [...users.values()].filter(u => u.role === 'admin' && u.active).length; },
    async getUserByEmail(email) { return copy([...users.values()].find(u => u.email === email)); },
    async getUserById(id) { return copy(users.get(id)); },
    async listUsers() { return [...users.values()].sort((a, b) => a.email.localeCompare(b.email)).map(copy); },
    async insertUser(u) { if ([...users.values()].some(x => x.email === u.email)) throw new Error('UNIQUE'); users.set(u.id, { ...u }); },
    async updateUser(id, fields) { const u = users.get(id); if (u) users.set(id, { ...u, ...fields, updatedAt: Date.now() }); },
    async deleteUser(id) { users.delete(id); await this.deleteUserSessions(id); await this.deleteUserTokens(id); },
    async insertSession(s) { sessions.set(s.tokenHash, { ...s }); },
    async getSession(h) { return copy(sessions.get(h)); },
    async deleteSession(h) { sessions.delete(h); },
    async deleteUserSessions(userId) { for (const [k, s] of sessions) if (s.userId === userId) sessions.delete(k); },
    async insertToken(t) { tokens.set(t.tokenHash, { ...t }); },
    async getToken(h) { return copy(tokens.get(h)); },
    async deleteToken(h) { tokens.delete(h); },
    async deleteUserTokens(userId, purpose) { for (const [k, t] of tokens) if (t.userId === userId && (!purpose || t.purpose === purpose)) tokens.delete(k); },
    _debug: { users, sessions, tokens },
  };
}
