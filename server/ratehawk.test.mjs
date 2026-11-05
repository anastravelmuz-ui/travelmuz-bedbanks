import test from 'node:test';
import assert from 'node:assert/strict';
import { ratehawkConfig, searchRatehawk, ratehawkSuggest, ratehawkHotelInfo, mapRate, RATEHAWK_SANDBOX_URL } from './ratehawk.mjs';
import { rhPanel, rhCancellationState } from '../public/compare-core.mjs';

const cfg = ratehawkConfig({ RATEHAWK_KEY_ID: '1', RATEHAWK_API_KEY: 'k' });
const q = { checkin: '2027-03-04', checkout: '2027-03-07', rooms: [{ adults: 2, children: [9] }] };
const rate = (o = {}) => ({ room_name: 'Deluxe Double room', meal_data: { value: 'breakfast', has_breakfast: true }, allotment: 3,
  payment_options: { payment_types: [{ type: 'now', amount: '450.00', show_amount: '470.00', currency_code: 'USD', show_currency_code: 'EUR',
    tax_data: { taxes: [{ name: 'city_tax', amount: '9.00', currency_code: 'EUR', included_by_supplier: false }] },
    commission_info: { show: { amount_gross: '520.00', amount_net: '470.00', amount_commission: '50.00' } } }] },
  cancellation_penalties: { free_cancellation_before: '2027-03-01T21:00:00', policies: [{ start_at: null, end_at: '2027-03-01T21:00:00', amount_show: '0.00' }, { start_at: '2027-03-01T21:00:00', end_at: null, amount_show: '470.00' }] }, ...o });

test('configuration : bac à sable par défaut, HTTPS obligatoire', async () => {
  assert.equal(ratehawkConfig({}), null);
  assert.deepEqual([cfg.base, cfg.environment], [RATEHAWK_SANDBOX_URL, 'sandbox']);
  await assert.rejects(searchRatehawk(q, 1, 'FR', { ...cfg, base: 'http://x' }, async () => null), /INSECURE_ENDPOINT/);
});

test('recherche : SERP d’abord, page hôtel seulement si disponible ; net, taxes sur place, annulation UTC', async () => {
  const calls = [];
  const fetcher = async (url, init) => { const body = JSON.parse(init.body); calls.push([String(url).replace(RATEHAWK_SANDBOX_URL, ''), body]);
    assert.match(init.headers.Authorization, /^Basic /); assert.match(init.headers['User-Agent'], /TravelMuz/); assert.equal(init.redirect, 'manual');
    return Response.json({ status: 'ok', data: { hotels: [{ hid: 7, rates: [rate()] }] } }); };
  const r = await searchRatehawk(q, '7', 'FR', cfg, fetcher);
  assert.deepEqual(calls.map(c => c[0]), ['/search/serp/hotels/', '/search/hp/']);
  assert.deepEqual(calls[0][1].hids, [7]); assert.equal(calls[1][1].hid, 7); assert.equal(calls[0][1].residency, 'fr');
  assert.deepEqual(calls[0][1].guests, [{ adults: 2, children: [9] }]); assert.equal(calls[0][1].currency, 'EUR');
  const [o] = r.offers;
  assert.deepEqual([o.net, o.gross, o.currency, o.mealCode, o.netFromSupplier, o.freeCancellationBefore], [470, 520, 'EUR', 'BB', true, '2027-03-01T21:00:00Z']);
  assert.equal(o.taxesAtHotel[0].amount, 9);
  const p = rhPanel(r, {}, Date.parse('2026-11-05T00:00:00Z'));
  assert.deepEqual([p.total, p.state, p.netConfirmed], [470, 'free', true]);
  assert.equal(rhCancellationState(o, Date.parse('2027-03-02T00:00:00Z')), 'fees');
  assert.equal(rhCancellationState(mapRate(rate({ cancellation_penalties: { free_cancellation_before: null, policies: [{ start_at: null, end_at: null, amount_show: '470.00' }] } }))), 'nonref');
});

test('recherche : hôtel indisponible → pas d’appel à la page hôtel ; erreurs', async () => {
  let n = 0;
  const none = await searchRatehawk(q, 7, 'FR', cfg, async () => { n++; return Response.json({ status: 'ok', data: { hotels: [] } }); });
  assert.deepEqual([none.status, n], ['no_availability', 1]);
  await assert.rejects(searchRatehawk(q, 7, 'FR', cfg, async () => new Response('', { status: 401 })), /SUPPLIER_AUTH_FAILED/);
  await assert.rejects(searchRatehawk(q, 7, 'FR', cfg, async () => new Response('{}', { status: 429 })), /QUOTA_EXCEEDED/);
  await assert.rejects(searchRatehawk(q, 7, 'FR', cfg, async () => Response.json({ status: 'error', error: 'invalid_params' }, { status: 400 })), /SUPPLIER_ERROR/);
  const usd = async () => Response.json({ status: 'ok', data: { hotels: [{ hid: 7, rates: [rate({ payment_options: { payment_types: [{ type: 'now', show_amount: '400', show_currency_code: 'USD' }] } })] }] } });
  assert.equal((await searchRatehawk(q, 7, 'FR', cfg, usd)).status, 'currency_not_eur');
});

test('suggestions et fiche hôtel (bac à sable : id texte)', async () => {
  const s = await ratehawkSuggest('hilton nagoya', cfg, async () => Response.json({ status: 'ok', data: { hotels: [{ id: 'hilton_nagoya', hid: 8473727, name: 'Hilton Nagoya', region_id: 1 }] } }));
  assert.deepEqual(s[0], { hid: 8473727, id: 'hilton_nagoya', name: 'Hilton Nagoya', regionId: 1 });
  let sent;
  const h = await ratehawkHotelInfo(s[0], cfg, async (u, init) => { sent = JSON.parse(init.body); return Response.json({ status: 'ok', data: { name: 'Hilton Nagoya', address: '1-3-3 Sakae', latitude: 35.16, longitude: 136.89, region: { name: 'Nagoya', country_code: 'JP' }, star_rating: 5, images_ext: [{ url: 'https://cdn.worldota.net/t/{size}/a.jpg' }] } }); });
  assert.deepEqual(sent, { id: 'hilton_nagoya', language: 'en' });
  assert.deepEqual([h.lat, h.city, h.country, h.images[0]], [35.16, 'Nagoya', 'JP', 'https://cdn.worldota.net/t/640x400/a.jpg']);
});
