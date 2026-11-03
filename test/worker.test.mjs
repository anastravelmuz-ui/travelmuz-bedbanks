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

test('Worker : correspondance hôtels (admin) et recherche TBO', async t => {
  const { setStoreFactory } = await import('../server/auth-store-d1.mjs');
  const { createMemoryMapStore } = await import('../server/hotel-map.mjs');
  const store = createMemoryStore();
  setStoreFactory(db => (db.__memory ? db.__memory : null));
  const realFetch = globalThis.fetch;
  t.after(() => { setStoreFactory(null); globalThis.fetch = realFetch; });
  const e = env({ DB: { __memory: store, __mapMemory: createMemoryMapStore() } });
  // comptes : admin + agent
  const boot = await route(call('/api/auth/bootstrap', { method: 'POST', body: { code: CODE } }), e);
  await route(call('/api/auth/set-password', { method: 'POST', body: { token: (await boot.json()).link.split('#t=')[1], password: PWD } }), e);
  const adminCookie = (await route(call('/api/auth/login', { method: 'POST', body: { email: 'anas@travelmuz.fr', password: PWD } }), e)).headers.get('set-cookie').split(';')[0];
  const c = await route(call('/api/admin', { method: 'POST', cookie: adminCookie, body: { action: 'create', email: 'myriam@travelmuz.fr', role: 'agent' } }), e);
  await route(call('/api/auth/set-password', { method: 'POST', body: { token: (await c.json()).link.split('#t=')[1], password: PWD } }), e);
  const agentCookie = (await route(call('/api/auth/login', { method: 'POST', body: { email: 'myriam@travelmuz.fr', password: PWD } }), e)).headers.get('set-cookie').split(';')[0];

  const crit = { hotelId: 4, checkin: '2027-03-04', checkout: '2027-03-07', country: 'FR', nationality: 'FR', rooms: [{ adults: 2, children: [5] }] };
  // sans identifiants TBO
  assert.equal((await (await route(call('/api/tbo/search', { method: 'POST', cookie: agentCookie, body: crit }), e)).json()).error, 'CONFIGURATION_MISSING');
  const e2 = { ...e, TBO_USERNAME: 'u', TBO_PASSWORD: 'p', TBO_BASE_URL: 'https://tbo.example.test/api' };
  // nationalité obligatoire et distincte
  assert.equal((await (await route(call('/api/tbo/search', { method: 'POST', cookie: agentCookie, body: { ...crit, nationality: undefined } }), e2)).json()).detail, 'NATIONALITY_INVALID');
  // hôtel non associé : pas d'appel fournisseur
  globalThis.fetch = async () => { throw new Error('ne doit pas être appelé'); };
  assert.equal((await (await route(call('/api/tbo/search', { method: 'POST', cookie: agentCookie, body: crit }), e2)).json()).status, 'not_mapped');
  // l'agent ne peut pas gérer les correspondances
  assert.equal((await route(call('/api/admin/mappings', { method: 'POST', cookie: agentCookie, body: { action: 'set', hbPlaceId: 4, provider: 'tbo', code: '55' } }), e2)).status, 403);
  assert.equal((await route(call('/api/admin/tbo/cities?country=TR', { cookie: agentCookie, accept: 'application/json' }), e2)).status, 403);
  assert.equal((await route(call('/api/admin/mappings', { method: 'POST', cookie: adminCookie, body: { action: 'set', hbPlaceId: 4, provider: 'tbo', code: 'abc' } }), e2)).status, 400);
  const set = await route(call('/api/admin/mappings', { method: 'POST', cookie: adminCookie, body: { action: 'set', hbPlaceId: 4, provider: 'tbo', code: '55', name: 'Deluxe Golden Horn Sultanahmet' } }), e2);
  assert.equal((await set.json()).mapping.validatedBy, 'anas@travelmuz.fr');
  // recherche TBO réelle simulée
  let sent;
  globalThis.fetch = async (u, init) => { sent = { url: String(u), body: JSON.parse(init.body) }; return Response.json({ Status: { Code: 200 }, HotelResult: [{ HotelCode: '55', Currency: 'EUR', Rooms: [{ Name: ['Family'], TotalFare: 700, IsRefundable: true, MealType: 'BreakFast', CancelPolicies: [] }] }] }); };
  const r = await (await route(call('/api/tbo/search', { method: 'POST', cookie: agentCookie, body: crit }), e2)).json();
  assert.equal(sent.url, 'https://tbo.example.test/api/Search');
  assert.equal(sent.body.HotelCodes, '55');
  assert.deepEqual([r.status, r.offers[0].price, r.mapping.code], ['ok', 700, '55']);
  // villes via l'admin
  globalThis.fetch = async () => Response.json({ Status: { Code: 200 }, CityList: [{ Code: '1', Name: 'Istanbul' }, { Code: '2', Name: 'Ankara' }] });
  const cities = await (await route(call('/api/admin/tbo/cities?country=TR&q=ist', { cookie: adminCookie, accept: 'application/json' }), e2)).json();
  assert.deepEqual(cities.cities, [{ code: '1', name: 'Istanbul' }]);
});

test('Worker : suggestions de correspondance (admin), sans association automatique', async t => {
  const { setStoreFactory } = await import('../server/auth-store-d1.mjs');
  const { createMemoryMapStore } = await import('../server/hotel-map.mjs');
  const { createMemoryCatalog, placeRow } = await import('../server/hb-catalog.mjs');
  const { createMemoryDetailsCache } = await import('../server/tbo-cache.mjs');
  const store = createMemoryStore(); const maps = createMemoryMapStore(); const cat = createMemoryCatalog();
  await cat.upsert([placeRow({ id: 4, name: 'Deluxe Golden Horn Sultanahmet', stars: 4, location: { city: 'Istanbul', country: 'Turkey', latitude: '41.0071', longitude: '28.9746' } })]);
  setStoreFactory(db => db.__memory);
  const realFetch = globalThis.fetch; let calls = 0;
  t.after(() => { setStoreFactory(null); globalThis.fetch = realFetch; });
  const e = env({ DB: { __memory: store, __mapMemory: maps, __catalogMemory: cat, __detailsMemory: createMemoryDetailsCache() }, TBO_USERNAME: 'u', TBO_PASSWORD: 'p', TBO_BASE_URL: 'https://tbo.example.test/api' });
  const boot = await route(call('/api/auth/bootstrap', { method: 'POST', body: { code: CODE } }), e);
  await route(call('/api/auth/set-password', { method: 'POST', body: { token: (await boot.json()).link.split('#t=')[1], password: PWD } }), e);
  const cookie = (await route(call('/api/auth/login', { method: 'POST', body: { email: 'anas@travelmuz.fr', password: PWD } }), e)).headers.get('set-cookie').split(';')[0];
  globalThis.fetch = async u => { calls++; const p = new URL(u).pathname;
    if (p.endsWith('/CityList')) return Response.json({ Status: { Code: 200 }, CityList: [{ Code: '122728', Name: 'Istanbul-Silivri' }, { Code: '122727', Name: 'Istanbul' }] });
    return Response.json({ Status: { Code: 200 }, Hotels: [{ HotelCode: '1050432', HotelName: 'Golden Horn Hotel - Special Class', Latitude: '41.0145', Longitude: '28.9760' }, { HotelCode: '1235939', HotelName: 'Deluxe Golden Horn Sultanahmet Hotel', Latitude: '41.0072', Longitude: '28.9748', Address: 'Binbirdirek' }] }); };
  const r = await route(call('/api/admin/match?hotel=4&provider=tbo', { cookie, accept: 'application/json' }), e);
  const d = await r.json();
  assert.equal(r.status, 200); assert.equal(d.city.code, '122727');
  assert.deepEqual([d.candidates[0].code, d.candidates[0].strong], ['1235939', true]);
  assert.equal(await maps.get(4, 'tbo'), null); // rien n'est associé sans validation
  const before = calls;
  await route(call('/api/admin/match?hotel=4&provider=tbo', { cookie, accept: 'application/json' }), e);
  assert.equal(calls, before); // listes en cache
});
