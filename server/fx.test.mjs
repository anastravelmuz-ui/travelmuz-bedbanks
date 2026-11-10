import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEcbXml, getEurRates, resetFxCache, ECB_DAILY_URL } from './fx.mjs';
import { convertToEur } from '../public/fx-core.mjs';
import { route } from '../src/router.mjs';

const xml = `<?xml version="1.0"?><gesmes:Envelope><Cube><Cube time='2026-11-06'><Cube currency='USD' rate='1.1165'/><Cube currency='JPY' rate='170.12'/><Cube currency='GBP' rate='0.83415'/><Cube currency='TRY' rate='55.9957'/><Cube currency='CHF' rate='0.93'/></Cube></Cube></gesmes:Envelope>`;

test('BCE : lecture du flux quotidien, réponse invalide refusée', () => {
  const r = parseEcbXml(xml);
  assert.equal(r.date, '2026-11-06'); assert.equal(r.rates.GBP, 0.83415); assert.equal(r.base, 'EUR');
  for (const bad of ['', null, '<html>erreur</html>', xml.replace("time='2026-11-06'", '')]) assert.throws(() => parseEcbXml(bad), /FX_INVALID_RESPONSE/);
});

test('BCE : source HTTPS fixe, sans redirection, cache 6 h, dernier taux réutilisé en cas de panne', async () => {
  resetFxCache(); let calls = 0;
  const ok = async (url, init) => { calls++; assert.equal(url, ECB_DAILY_URL); assert.ok(url.startsWith('https://')); assert.equal(init.redirect, 'manual'); return new Response(xml); };
  await getEurRates(ok, 0); await getEurRates(ok, 3600e3); assert.equal(calls, 1);
  const down = async () => { throw new Error('réseau'); };
  assert.equal((await getEurRates(down, 7 * 3600e3)).date, '2026-11-06');
  resetFxCache();
  await assert.rejects(() => getEurRates(down, 0), /FX_UNAVAILABLE/);
  await assert.rejects(() => getEurRates(async () => new Response(null, { status: 302 }), 0), /FX_UNAVAILABLE/);
  resetFxCache();
});

test('conversion indicative : arrondi au centime, jamais de taux inventé', () => {
  const fx = parseEcbXml(xml);
  assert.deepEqual(convertToEur(216.32, 'GBP', fx), { amount: 259.33, rate: 0.83415, date: '2026-11-06', currency: 'GBP' });
  assert.equal(convertToEur(1000, 'gbp', fx).amount, 1198.83);
  assert.equal(convertToEur(1000, 'AED', fx), null);
  assert.equal(convertToEur(1000, 'GBP', null), null);
  assert.equal(convertToEur(null, 'GBP', fx), null);
  assert.equal(convertToEur(500, 'EUR', fx).amount, 500);
});

test('/api/fx exige une session', async () => {
  const r = await route(new Request('https://bedbanks.exemple.test/api/fx', { headers: { accept: 'application/json' } }), { DB: {}, ASSETS: { fetch: async () => new Response('') } });
  assert.notEqual(r.status, 200);
});
