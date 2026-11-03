import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { signature, hotelbedsConfig, hotelbedsOccupancies, searchHotelbeds, hotelbedsHotels, hotelbedsDetails, attachHotelbedsDetails, mealCodeFromBoard, HOTELBEDS_TEST_URL } from './hotelbeds.mjs';
import { hbedsCancellationState, hbedsFreeUntil } from '../public/hotelbeds-core.mjs';

const cfg = { base: HOTELBEDS_TEST_URL, apiKey: 'cle', secret: 'secret' };
const q = { hotelId: 4, checkin: '2027-03-04', checkout: '2027-03-07', country: 'FR', rooms: [{ adults: 2, children: [9, 5] }, { adults: 2, children: [] }, { adults: 2, children: [] }] };
const rate = (o = {}) => ({ rateKey: 'K', rateCommentsId: '102|166598|0', rateClass: 'NOR', rateType: 'BOOKABLE', net: '512.40', sellingRate: '620.00', hotelMandatory: false, rooms: 1, adults: 2, children: 2, childrenAges: '5,9', boardCode: 'BB', boardName: 'BED AND BREAKFAST',
  cancellationPolicies: [{ amount: '170.80', from: '2027-03-01T23:59:00+03:00' }], taxes: { allIncluded: false, taxes: [{ included: false, amount: '9.00', currency: 'EUR', subType: 'City tax' }] }, ...o });

test('signature X-Signature = SHA-256 hex(clé + secret + horodatage)', async () => {
  assert.equal(await signature('k', 's', 1700000000), createHash('sha256').update('ks1700000000').digest('hex'));
  assert.equal(hotelbedsConfig({ HOTELBEDS_API_KEY: 'k' }), null);
  assert.equal(hotelbedsConfig({ HOTELBEDS_API_KEY: 'k', HOTELBEDS_SECRET: 's' }).base, HOTELBEDS_TEST_URL);
});

test('occupations : chambres identiques regroupées, âges conservés', () => {
  const g = hotelbedsOccupancies(q.rooms);
  assert.deepEqual(g.map(x => [x.key, x.roomIndexes]), [['2|5,9', [0]], ['2|', [1, 2]]]);
});

test('recherche : requête, en-têtes, net fourni, taxes sur place, rattachement aux chambres', async () => {
  let seen;
  const r = await searchHotelbeds(q, '123456', cfg, async (url, init) => {
    seen = { url: String(url), init, body: JSON.parse(init.body) };
    return Response.json({ hotels: { total: 1, hotels: [{ code: 123456, name: 'Hotel', currency: 'EUR', rooms: [
      { code: 'DBL.ST', name: 'DOUBLE STANDARD', rates: [rate(), rate({ adults: 2, children: 0, childrenAges: '', rooms: 2, net: '700.00', rateClass: 'NRF' })] }] }] } });
  });
  assert.equal(seen.url, HOTELBEDS_TEST_URL + '/hotel-api/1.0/hotels');
  assert.equal(seen.init.headers['Api-key'], 'cle'); assert.match(seen.init.headers['X-Signature'], /^[0-9a-f]{64}$/); assert.equal(seen.init.redirect, 'manual');
  assert.deepEqual(seen.body.occupancies, [{ rooms: 1, adults: 2, children: 2, paxes: [{ type: 'CH', age: 9 }, { type: 'CH', age: 5 }] }, { rooms: 2, adults: 2, children: 0 }]);
  assert.deepEqual(seen.body.hotels, { hotel: [123456] });
  assert.equal(seen.body.sourceMarket, 'FR'); assert.equal(seen.init.headers['Accept-Encoding'], 'gzip');
  const [a, b] = r.offers;
  assert.deepEqual([a.net, a.sellingRate, a.mealCode, a.roomIndexes, a.taxesAtHotel[0].amount, a.environment], [512.4, 620, 'BB', [0], 9, undefined]);
  assert.deepEqual([b.net, b.units, b.roomIndexes, b.rateClass], [700, 2, [1, 2], 'NRF']);
  assert.equal(r.environment, 'test'); assert.equal(a.rateCommentsId, '102|166598|0');
  assert.equal(JSON.stringify(r).includes('"K"'), false); // rateKey non exposé
});

test('absence d’offre, devise, erreurs', async () => {
  const none = await searchHotelbeds(q, '1', cfg, async () => Response.json({ hotels: { total: 0 } }));
  assert.equal(none.status, 'no_availability');
  const usd = async () => Response.json({ hotels: { total: 1, hotels: [{ code: 1, currency: 'USD', rooms: [{ code: 'X', name: 'X', rates: [rate()] }] }] } });
  assert.equal((await searchHotelbeds(q, '1', cfg, usd)).status, 'currency_not_eur');
  assert.equal((await searchHotelbeds(q, '1', cfg, usd, { allowNonEur: true })).currencyWarning, 'USD');
  await assert.rejects(searchHotelbeds(q, '1', cfg, async () => new Response('', { status: 401 })), /SUPPLIER_AUTH_FAILED/);
  await assert.rejects(searchHotelbeds(q, '1', cfg, async () => new Response('', { status: 429 })), /QUOTA_EXCEEDED/);
  await assert.rejects(searchHotelbeds(q, '1', { ...cfg, base: 'http://api.test.hotelbeds.com' }, async () => null), /INSECURE_ENDPOINT/);
  await assert.rejects(searchHotelbeds(q, 'abc', cfg, async () => null), /CRITERIA_INVALID/);
});

test('annulation Hotelbeds : échéance avec fuseau', () => {
  const o = { net: 512.4, cancellation: [{ amount: 170.8, from: '2027-03-01T23:59:00+03:00' }] };
  assert.equal(hbedsCancellationState(o, Date.parse('2026-11-03T00:00:00Z')), 'free');
  assert.equal(hbedsCancellationState(o, Date.parse('2027-03-02T00:00:00Z')), 'fees');
  assert.equal(hbedsCancellationState({ ...o, cancellation: [{ amount: 512.4, from: '2027-03-01T23:59:00+03:00' }] }, Date.parse('2027-03-02T00:00:00Z')), 'nonref');
  assert.equal(hbedsCancellationState({ ...o, rateClass: 'NRF' }), 'nonref');
  assert.equal(hbedsCancellationState({ ...o, cancellation: [{ amount: 10, from: '2027-03-01 23:59' }] }), 'unknown');
  assert.equal(hbedsFreeUntil(o), '2027-03-01T23:59:00+03:00');
  assert.equal(mealCodeFromBoard('AI', 'ALL INCLUSIVE'), 'AI'); assert.equal(mealCodeFromBoard('ZZ', 'HALF BOARD'), 'HB');
});

test('Content API : hôtels de la destination et photos par code chambre', async () => {
  const list = await hotelbedsHotels('IST', 1, cfg, async url => { assert.match(String(url), /destinationCode=IST/); return Response.json({ total: 3100, hotels: [{ code: 777, name: { content: 'Deluxe Golden Horn Sultanahmet' }, address: { content: 'Binbirdirek' }, city: { content: 'ISTANBUL' }, categoryCode: '4EST' }] }); });
  assert.deepEqual(list.hotels[0], { code: '777', name: 'Deluxe Golden Horn Sultanahmet', address: 'Binbirdirek, ISTANBUL', rating: '4EST', lat: null, lng: null });
  const d = await hotelbedsDetails('777', cfg, async () => Response.json({ hotel: { code: 777, images: [{ path: '00/0007/a.jpg', roomCode: 'DBL.ST', order: 2 }, { path: '00/0007/h.jpg', order: 1 }, { path: '../../x"' }], rooms: [{ roomCode: 'DBL.ST', description: 'DOUBLE STANDARD', maxPax: 3 }] } }));
  assert.deepEqual(d.roomImages['DBL.ST'], ['https://photos.hotelbeds.com/giata/bigger/00/0007/a.jpg']);
  assert.equal(d.hotelImages.length, 1);
  const [o] = attachHotelbedsDetails([{ roomCode: 'DBL.ST' }], d);
  assert.equal(o.photos.length, 1); assert.equal(o.roomInfo.maxPax, 3);
  await assert.rejects(hotelbedsHotels('ist; drop', 1, cfg, async () => null), /CRITERIA_INVALID/);
});

import { hotelbedsRateComments } from './hotelbeds.mjs';
test('commentaires de tarif : code échappé, date, validation', async () => {
  const c = await hotelbedsRateComments('102|166598|0', '2027-03-04', cfg, async url => {
    assert.match(String(url), /types\/ratecommentdetails\?date=2027-03-04&code=102%7C166598%7C0/);
    return Response.json({ rateComments: [{ dateStart: '2017-08-10', dateEnd: '2030-12-31', description: 'no refundable rate.' }] });
  });
  assert.equal(c[0].description, 'no refundable rate.');
  await assert.rejects(hotelbedsRateComments('1;drop', '2027-03-04', cfg, async () => null), /CRITERIA_INVALID/);
});
