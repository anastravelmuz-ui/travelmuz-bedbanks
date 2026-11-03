import test from 'node:test';
import assert from 'node:assert/strict';
import { tboConfig, searchTbo, tboCities, tboHotels, parseTboDate, tboCancellationState, tboSearchBody } from './tbo.mjs';

const cfg = { base: 'https://api.example.test/TBOHolidays_HotelAPI', search: 'https://api.example.test/TBOHolidays_HotelAPI', username: 'u', password: 'p' };
const q = { hotelId: 4, checkin: '2027-03-04', checkout: '2027-03-07', country: 'FR', rooms: [{ adults: 2, children: [5, 9] }, { adults: 2, children: [] }] };
const sample = { Status: { Code: 200, Description: 'Successful' }, HotelResult: [{ HotelCode: '1279415', Currency: 'EUR', Rooms: [{
  Name: ['Family Room', 'Standard Room'], BookingCode: 'SECRET!TB!1', Inclusion: 'Breakfast', TotalFare: 1100.5, TotalTax: 90.1, RecommendedSellingRate: '1250',
  CancelPolicies: [{ Index: '1', FromDate: '01-03-2027 00:00:00', ChargeType: 'Percentage', CancellationCharge: 100 }],
  MealType: 'BreakFast', IsRefundable: true, Supplements: [[{ Index: 1, Type: 'AtProperty', Description: 'city_tax', Price: 12, Currency: 'EUR' }]], WithTransfers: false }] }] };

test('configuration : identifiants et URL requis', () => {
  assert.equal(tboConfig({}), null);
  assert.equal(tboConfig({ TBO_USERNAME: 'u', TBO_PASSWORD: 'p' }).base, 'https://api.tbotechnology.in/TBOHolidays_HotelAPI'); // repli staging
  assert.deepEqual(tboConfig({ TBO_USERNAME: 'u', TBO_PASSWORD: 'p', TBO_BASE_URL: 'https://x.test/api/' }).search, 'https://x.test/api');
});

test('HTTP refusé : aucun identifiant envoyé en clair', async () => {
  let called = false;
  await assert.rejects(searchTbo(q, '1', 'FR', { ...cfg, search: 'http://api.example.test/x' }, async () => { called = true; }), /INSECURE_ENDPOINT/);
  assert.equal(called, false);
});

test('requête : chambres, enfants et âges, nationalité, Basic, sans redirection', async () => {
  let seen;
  const r = await searchTbo(q, '1279415', 'MA', cfg, async (url, init) => { seen = { url: String(url), init, body: JSON.parse(init.body) }; return Response.json(sample); });
  assert.equal(seen.url, cfg.search + '/Search');
  assert.equal(seen.init.redirect, 'manual');
  assert.match(seen.init.headers.Authorization, /^Basic /);
  assert.deepEqual(seen.body.PaxRooms, [{ Adults: 2, Children: 2, ChildrenAges: [5, 9] }, { Adults: 2, Children: 0, ChildrenAges: null }]);
  assert.equal(seen.body.GuestNationality, 'MA');
  assert.equal(r.status, 'ok');
  const o = r.offers[0];
  assert.deepEqual([o.price, o.tax, o.currency, o.meal, o.roomNames.length], [1100.5, 90.1, 'EUR', 'Petit déjeuner', 2]);
  assert.equal(o.supplementsAtProperty[0].price, 12);
  assert.equal(o.recommendedSellingRate, 1250);
  assert.equal(JSON.stringify(r).includes('SECRET'), false); // le code de réservation n'est pas exposé
});

test('absence d’offre ≠ panne ; erreurs fournisseur explicites', async () => {
  const none = await searchTbo(q, '1', 'FR', cfg, async () => Response.json({ Status: { Code: 201, Description: 'No Available rooms for given criteria' } }));
  assert.deepEqual([none.status, none.offers.length], ['no_availability', 0]);
  await assert.rejects(searchTbo(q, '1', 'FR', cfg, async () => Response.json({ Status: { Code: 401, Description: 'Access Credentials is incorrect' } })), /SUPPLIER_AUTH_FAILED/);
  await assert.rejects(searchTbo(q, '1', 'FR', cfg, async () => Response.json({ Status: { Code: 500, Description: 'Unexpected' } })), /SUPPLIER_ERROR/);
  await assert.rejects(searchTbo(q, '1', 'FR', cfg, async () => { throw new Error('dns'); }), /SUPPLIER_UNREACHABLE/);
  await assert.rejects(searchTbo(q, '1', 'FR', null), /CONFIGURATION_MISSING/);
});

test('critères TBO validés', () => {
  assert.throws(() => tboSearchBody(q, 'abc', 'FR'), /CRITERIA_INVALID/);
  assert.throws(() => tboSearchBody(q, '1', 'France'), /NATIONALITY_INVALID/);
});

test('annulation sans fuseau : prudence à ±14 h', () => {
  assert.equal(parseTboDate('31-02-2027 00:00:00'), null);
  const base = { isRefundable: true, cancelPolicies: [{ from: '01-03-2027 00:00:00', type: 'Percentage', charge: 100 }] };
  const t = parseTboDate('01-03-2027 00:00:00');
  assert.equal(tboCancellationState(base, t - 15 * 3600e3), 'free');
  assert.equal(tboCancellationState(base, t - 3600e3), 'unknown');
  assert.equal(tboCancellationState(base, t + 15 * 3600e3), 'nonref');
  assert.equal(tboCancellationState({ ...base, cancelPolicies: [{ from: '01-03-2027 00:00:00', type: 'Fixed', charge: 50 }] }, t + 15 * 3600e3), 'fees');
  assert.equal(tboCancellationState({ isRefundable: false, cancelPolicies: [] }), 'nonref');
  assert.equal(tboCancellationState({ isRefundable: null, cancelPolicies: [] }), 'unknown');
  assert.equal(tboCancellationState({ isRefundable: true, cancelPolicies: [{ from: 'bientôt', type: 'Percentage', charge: 100 }] }), 'unknown');
});

test('données statiques : villes et hôtels', async () => {
  const cities = await tboCities('TR', cfg, async (url, init) => { assert.equal(String(url), cfg.base + '/CityList'); assert.deepEqual(JSON.parse(init.body), { CountryCode: 'TR' }); return Response.json({ Status: { Code: 200 }, CityList: [{ Code: '100', Name: 'Istanbul' }] }); });
  assert.deepEqual(cities, [{ code: '100', name: 'Istanbul' }]);
  const hotels = await tboHotels('100', cfg, async () => Response.json({ Status: { Code: 200 }, Hotels: [{ HotelCode: '55', HotelName: 'Deluxe Golden Horn Sultanahmet', HotelRating: 'FourStar', Address: 'Binbirdirek', CityName: 'Istanbul', CountryCode: 'TR' }] }));
  assert.equal(hotels[0].name, 'Deluxe Golden Horn Sultanahmet');
  await assert.rejects(tboCities('Turquie', cfg, async () => null), /CRITERIA_INVALID/);
  await assert.rejects(tboHotels('12;drop', cfg, async () => null), /CRITERIA_INVALID/);
});

test('euro imposé : offres TBO en autre devise masquées, jamais converties', async () => {
  const usd = structuredClone(sample); usd.HotelResult[0].Currency = 'USD';
  const r = await searchTbo(q, '1279415', 'FR', cfg, async () => Response.json(usd));
  assert.deepEqual([r.status, r.currency, r.offers.length, r.hidden], ['currency_not_eur', 'USD', 0, 1]);
  const eur = await searchTbo(q, '1279415', 'FR', cfg, async () => Response.json(sample));
  assert.equal(eur.offers[0].mealCode, 'BB');
});

test('mode test : devise autre que EUR autorisée mais signalée', async () => {
  const usd = structuredClone(sample); usd.HotelResult[0].Currency = 'USD';
  const r = await searchTbo(q, '1279415', 'FR', cfg, async () => Response.json(usd), { allowNonEur: true });
  assert.deepEqual([r.status, r.currencyWarning, r.offers[0].currency], ['ok', 'USD', 'USD']);
});
import { tboHotelDetails } from './tbo.mjs';
test('HotelDetails : images hôtel et chambre (HTTPS), structure de diagnostic', async () => {
  const d = await tboHotelDetails('1235939', cfg, async (url, init) => {
    assert.equal(String(url), cfg.base + '/Hoteldetails'); assert.equal(JSON.parse(init.body).IsRoomDetailRequired, true);
    return Response.json({ Status: { Code: 200 }, HotelDetails: [{ HotelCode: '1235939', HotelName: 'Deluxe Golden Horn', Images: ['https://api.tbotechnology.in/imageresource.aspx?img=a', 'http://x/b'], RoomDetails: [{ RoomId: '9', RoomName: 'Standard', Images: ['https://img.test/r.jpg'] }] }] });
  });
  assert.deepEqual(d.hotelImages, ['https://api.tbotechnology.in/imageresource.aspx?img=a']);
  assert.deepEqual(d.rooms, [{ id: '9', name: 'Standard', images: ['https://img.test/r.jpg'] }]);
  assert.deepEqual(d.structure.roomKeys, ['RoomId', 'RoomName', 'Images']);
});
