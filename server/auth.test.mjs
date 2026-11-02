import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, hashPassword, verifyPassword, POLICY } from './auth-core.mjs';
import { createMemoryStore } from './auth-store-memory.mjs';
import { handleAuth, SESSION_COOKIE } from './auth-http.mjs';

const ORIGIN = 'https://exemple.test';
const PWD = 'motdepasse-solide-2026';
function setup(start = Date.UTC(2026, 10, 2)) {
  let t = start; const store = createMemoryStore();
  return { store, auth: createAuth(store, () => t), advance: ms => { t += ms; } };
}
async function admin(auth) { const b = await auth.bootstrap('anas@travelmuz.fr'); await auth.setPassword(b.token, PWD); return (await auth.login('anas@travelmuz.fr', PWD)).user; }

test('hachage : vérifie le bon mot de passe, rejette le mauvais, sel différent', async () => {
  const a = await hashPassword(PWD), b = await hashPassword(PWD);
  assert.notEqual(a, b);
  assert.ok(a.startsWith(`pbkdf2$sha256$${POLICY.iterations}$`));
  assert.equal(await verifyPassword(PWD, a), true);
  assert.equal(await verifyPassword('autre-mot-de-passe', a), false);
  assert.equal(await verifyPassword(PWD, 'n-importe-quoi'), false);
});

test('premier administrateur : une seule fois, lien unique, connexion', async () => {
  const { auth, store } = setup();
  const b = await auth.bootstrap(' Anas@TravelMuz.fr ');
  assert.equal(b.user.email, 'anas@travelmuz.fr'); assert.equal(b.user.role, 'admin'); assert.equal(b.user.hasPassword, false);
  await assert.rejects(auth.bootstrap('x@travelmuz.fr'), { code: 'ALREADY_INITIALIZED' });
  await assert.rejects(auth.login('anas@travelmuz.fr', ''), { code: 'INVALID_CREDENTIALS' });
  await assert.rejects(auth.setPassword(b.token, 'court'), { code: 'PASSWORD_TOO_SHORT' });
  await auth.setPassword(b.token, PWD);
  await assert.rejects(auth.setPassword(b.token, PWD), { code: 'LINK_INVALID' });
  const s = await auth.login('anas@travelmuz.fr', PWD);
  assert.equal((await auth.session(s.token)).email, 'anas@travelmuz.fr');
  for (const v of store._debug.sessions.keys()) assert.notEqual(v, s.token); // jeton jamais stocké en clair
});

test('verrouillage après 5 échecs, message identique, déverrouillage après 15 min', async () => {
  const { auth, advance } = setup(); await admin(auth);
  for (let i = 0; i < POLICY.maxFailures; i++) await assert.rejects(auth.login('anas@travelmuz.fr', 'mauvais-mot-de-passe'), { code: 'INVALID_CREDENTIALS' });
  await assert.rejects(auth.login('anas@travelmuz.fr', PWD), { code: 'INVALID_CREDENTIALS' });
  await assert.rejects(auth.login('inconnu@travelmuz.fr', PWD), { code: 'INVALID_CREDENTIALS' });
  advance(POLICY.lockMinutes * 60e3 + 1);
  assert.ok((await auth.login('anas@travelmuz.fr', PWD)).token);
});

test('session expirée après 12 h ; déconnexion', async () => {
  const { auth, advance } = setup(); await admin(auth);
  const s = await auth.login('anas@travelmuz.fr', PWD);
  advance(POLICY.sessionHours * 3600e3 - 1); assert.ok(await auth.session(s.token));
  advance(2); assert.equal(await auth.session(s.token), null);
  const s2 = await auth.login('anas@travelmuz.fr', PWD); await auth.logout(s2.token);
  assert.equal(await auth.session(s2.token), null);
});

test('administration : agent créé, invitation 72 h, droits admin requis', async () => {
  const { auth, advance } = setup(); const me = await admin(auth);
  const c = await auth.createUser(me, { email: 'mehdi@travelmuz.fr', role: 'agent' });
  await assert.rejects(auth.createUser(me, { email: 'mehdi@travelmuz.fr', role: 'agent' }), { code: 'EMAIL_EXISTS' });
  await assert.rejects(auth.createUser(me, { email: 'x@travelmuz.fr', role: 'superadmin' }), { code: 'ROLE_INVALID' });
  assert.deepEqual(await auth.checkLink(c.token), { email: 'mehdi@travelmuz.fr', purpose: 'invite' });
  advance(POLICY.inviteHours * 3600e3 + 1);
  await assert.rejects(auth.setPassword(c.token, PWD), { code: 'LINK_INVALID' });
  const l = await auth.issueLink(me, c.user.id); assert.equal(l.purpose, 'invite');
  await auth.setPassword(l.token, PWD);
  const agent = (await auth.login('mehdi@travelmuz.fr', PWD)).user;
  assert.equal(agent.role, 'agent');
  await assert.rejects(auth.listUsers(agent), { code: 'ADMIN_REQUIRED' });
  await assert.rejects(auth.createUser(agent, { email: 'y@travelmuz.fr', role: 'admin' }), { code: 'ADMIN_REQUIRED' });
});

test('désactivation coupe les sessions ; réinitialisation 60 min ; suppression', async () => {
  const { auth, advance } = setup(); const me = await admin(auth);
  const c = await auth.createUser(me, { email: 'myriam@travelmuz.fr', role: 'agent' });
  await auth.setPassword(c.token, PWD);
  const s = await auth.login('myriam@travelmuz.fr', PWD);
  await auth.setActive(me, c.user.id, false);
  assert.equal(await auth.session(s.token), null);
  await assert.rejects(auth.login('myriam@travelmuz.fr', PWD), { code: 'INVALID_CREDENTIALS' });
  assert.equal(await auth.requestReset('myriam@travelmuz.fr'), null);
  await auth.setActive(me, c.user.id, true);
  const r = await auth.requestReset('myriam@travelmuz.fr'); assert.equal(r.purpose, 'reset');
  advance(POLICY.resetMinutes * 60e3 + 1);
  await assert.rejects(auth.setPassword(r.token, 'nouveau-mot-de-passe'), { code: 'LINK_INVALID' });
  await auth.deleteUser(me, c.user.id);
  assert.equal((await auth.listUsers(me)).length, 1);
});

test('garde-fous : ni auto-désactivation, ni suppression du dernier admin', async () => {
  const { auth } = setup(); const me = await admin(auth);
  await assert.rejects(auth.setActive(me, me.id, false), { code: 'SELF_FORBIDDEN' });
  await assert.rejects(auth.deleteUser(me, me.id), { code: 'SELF_FORBIDDEN' });
  const c = await auth.createUser(me, { email: 'mohamed@travelmuz.fr', role: 'admin' });
  await auth.setPassword(c.token, PWD);
  const other = (await auth.login('mohamed@travelmuz.fr', PWD)).user;
  await auth.setActive(other, me.id, false); // reste un admin actif : autorisé
  await assert.rejects(auth.deleteUser(me, other.id), { code: 'ADMIN_REQUIRED' }); // me désactivé
});

// ---- Parcours HTTP ----
const req = (method, body, cookie, origin = ORIGIN) => new Request(`${ORIGIN}/api/x`, {
  method, headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const cookieFrom = res => res.headers.get('set-cookie').split(';')[0];

test('HTTP : base absente → 503 ; origine étrangère → 403', async () => {
  assert.equal((await handleAuth('me', req('GET'), { auth: null })).status, 503);
  const { auth } = setup();
  const r = await handleAuth('login', req('POST', { email: 'a@b.fr', password: 'x' }, null, 'https://pirate.test'), { auth });
  assert.equal(r.status, 403);
  assert.equal((await handleAuth('login', req('POST', { email: 'a@b.fr' }, null, null), { auth })).status, 403); // Origin absent
});

test('HTTP : parcours complet admin → agent', async () => {
  const { auth } = setup(); const CODE = 'code-installation-tres-long';
  const ctx = { auth, setupCode: CODE, firstAdminEmail: 'anas@travelmuz.fr' };
  assert.equal((await handleAuth('bootstrap', req('POST', { code: CODE }), { ...ctx, setupCode: '' })).status, 403); // non configuré
  assert.equal((await handleAuth('bootstrap', req('POST', { code: 'mauvais' }), ctx)).status, 403);
  const boot = await handleAuth('bootstrap', req('POST', { code: CODE }), ctx);
  assert.equal(boot.status, 201);
  assert.equal((await handleAuth('bootstrap', req('POST', { code: CODE }), ctx)).status, 409); // une seule fois
  const link = (await boot.json()).link;
  assert.ok(link.startsWith(`${ORIGIN}/reinitialiser.html#t=`));
  const token = link.split('#t=')[1];
  assert.equal((await (await handleAuth('link', req('POST', { token }), ctx)).json()).purpose, 'invite');
  assert.equal((await handleAuth('set-password', req('POST', { token, password: PWD }), ctx)).status, 200);
  const login = await handleAuth('login', req('POST', { email: 'anas@travelmuz.fr', password: PWD }), ctx);
  assert.equal(login.status, 200);
  const sc = login.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(sc.includes(flag), flag);
  assert.ok(sc.startsWith(SESSION_COOKIE + '='));
  const cookie = cookieFrom(login);
  const created = await handleAuth('admin', req('POST', { action: 'create', email: 'mehdi@travelmuz.fr', role: 'agent' }, cookie), ctx);
  assert.equal(created.status, 201);
  const list = await (await handleAuth('admin', req('GET', undefined, cookie), ctx)).json();
  assert.deepEqual(list.users.map(u => [u.email, u.role, u.hasPassword]), [['anas@travelmuz.fr', 'admin', true], ['mehdi@travelmuz.fr', 'agent', false]]);
  assert.equal((await handleAuth('admin', req('GET'), ctx)).status, 401);
  assert.equal((await handleAuth('forgot', req('POST', { email: 'inconnu@x.fr' }), ctx)).status, 202);
  const out = await handleAuth('logout', req('POST', {}, cookie), ctx);
  assert.ok(out.headers.get('set-cookie').includes('Max-Age=0'));
  assert.equal((await handleAuth('me', req('GET', undefined, cookie), ctx)).status, 401);
});

test('HTTP : mot de passe oublié avec service email simulé', async () => {
  const { auth } = setup(); await admin(auth);
  const sent = [];
  const ctx = { auth, mailer: { sendReset: async (to, link) => sent.push([to, link]) } };
  assert.equal((await handleAuth('forgot', req('POST', { email: 'anas@travelmuz.fr' }), ctx)).status, 202);
  assert.equal((await handleAuth('forgot', req('POST', { email: 'inconnu@travelmuz.fr' }), ctx)).status, 202);
  assert.equal(sent.length, 1); assert.equal(sent[0][0], 'anas@travelmuz.fr');
});
