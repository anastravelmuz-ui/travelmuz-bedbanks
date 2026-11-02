// Tests du Worker sans réseau ni Cloudflare : base D1 simulée en mémoire via le stockage mémoire.
import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../src/router.mjs';
import { createMemoryStore } from '../server/auth-store-memory.mjs';
import * as d1 from '../server/auth-store-d1.mjs';

const ORIGIN = 'https://bedbanks.exemple.test';
const PWD = 'motdepasse-solide-2026';
const CODE = 'code-installation-de-test-123';
// Remplace le stockage D1 par le stockage mémoire pour ce test.
const mem = createMemoryStore();
const realCreate = d1.createD1Store;
function env(extra = {}) {
  return {
    DB: { __memory: mem }, SETUP_CODE: CODE,
    ASSETS: { fetch: async req => new Response('page ' + new URL(req.url).pathname, { headers: { 'content-type': 'text/html' } }) },
    ...extra,
  };
}
const call = (path, { method = 'GET', body, cookie, origin = ORIGIN, accept = 'text/html' } = {}) => new Request(ORIGIN + path, {
  method, headers: { accept, ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test('Worker : protection, installation, connexion, administration', async t => {
  const { setStoreFactory } = await import('../server/auth-store-d1.mjs');
  setStoreFactory(db => (db.__memory ? db.__memory : realCreate(db)));
  t.after(() => setStoreFactory(null));
  const e = env();

  for (const p of ['/', '/index.html', '/demo.html', '/admin.html', '/live.mjs']) {
    const r = await route(call(p), e);
    assert.equal(r.status, 302, p); assert.equal(r.headers.get('location'), ORIGIN + '/connexion.html');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  }
  assert.equal((await route(call('/live.mjs', { accept: '*/*' }), e)).status, 401);
  assert.equal((await route(call('/connexion.html'), e)).status, 200);
  assert.equal((await route(call('/fonts/outfit.ttf'), e)).status, 200);
  const hb = await route(call('/api/halalbooking/search', { method: 'POST', body: {} }), e);
  assert.equal(hb.status, 401);

  assert.equal((await route(call('/api/auth/bootstrap', { method: 'POST', body: { code: 'faux' } }), e)).status, 403);
  const boot = await route(call('/api/auth/bootstrap', { method: 'POST', body: { code: CODE } }), e);
  assert.equal(boot.status, 201);
  const token = (await boot.json()).link.split('#t=')[1];
  assert.equal((await route(call('/api/auth/set-password', { method: 'POST', body: { token, password: PWD } }), e)).status, 200);
  const login = await route(call('/api/auth/login', { method: 'POST', body: { email: 'anas@travelmuz.fr', password: PWD } }), e);
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const home = await route(call('/', { cookie }), e);
  assert.equal(home.status, 200); assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.equal((await route(call('/admin.html', { cookie }), e)).status, 200);

  const created = await route(call('/api/admin', { method: 'POST', cookie, body: { action: 'create', email: 'mehdi@travelmuz.fr', role: 'agent' } }), e);
  const agentToken = (await created.json()).link.split('#t=')[1];
  await route(call('/api/auth/set-password', { method: 'POST', body: { token: agentToken, password: PWD } }), e);
  const agentLogin = await route(call('/api/auth/login', { method: 'POST', body: { email: 'mehdi@travelmuz.fr', password: PWD } }), e);
  const agentCookie = agentLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await route(call('/', { cookie: agentCookie }), e)).status, 200);
  const blocked = await route(call('/admin.html', { cookie: agentCookie }), e);
  assert.equal(blocked.status, 302); assert.equal(blocked.headers.get('location'), ORIGIN + '/');
  assert.equal((await route(call('/api/admin', { cookie: agentCookie, accept: 'application/json' }), e)).status, 403);

  // Route fournisseur : authentifié mais secrets absents → erreur explicite, aucun tarif fictif.
  const crit = { hotelId: 4, checkin: '2027-03-04', checkout: '2027-03-07', adults: 2, country: 'FR' };
  const nocfg = await route(call('/api/halalbooking/search', { method: 'POST', cookie: agentCookie, body: crit }), e);
  assert.equal(nocfg.status, 502); assert.equal((await nocfg.json()).error, 'CONFIGURATION_MISSING');
  const foreign = await route(call('/api/halalbooking/search', { method: 'POST', cookie: agentCookie, body: crit, origin: 'https://pirate.test' }), e);
  assert.equal(foreign.status, 403);
});

test('Worker : base absente → comptes indisponibles, pages fermées', async () => {
  const e = env({ DB: undefined });
  assert.equal((await route(call('/'), e)).status, 302);
  assert.equal((await route(call('/api/auth/me', { accept: 'application/json' }), e)).status, 503);
});
