import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, placeRow, syncBatch, createMemoryCatalog, fetchContentPage } from './hb-catalog.mjs';
import { searchHalalbookingDestination, validateDestination } from './halalbooking.mjs';

const creds = { partner: 'p', secret: 's' };
const place = (id, name, city, country = 'Turkey') => ({ id, name, stars: 4, location: { city, country, latitude: '41.0', longitude: '28.9', address: 'Rue 1' }, holiday_type: 'hotel', photos: ['https://cdn.halalstatic.com/x.jpg'] });

test('normalisation des noms (accents, ponctuation)', () => {
  assert.equal(normalize('Hôtel  Golden-Horn, Sultanahmet'), 'hotel golden horn sultanahmet');
  assert.equal(placeRow({ id: 'x' }), null);
  assert.deepEqual([placeRow(place(4, 'Deluxe Golden Horn', 'Istanbul')).lat, placeRow(place(4, 'A', 'B')).photo], [41, 'https://cdn.halalstatic.com/x.jpg']);
});

test('synchronisation par lots et suggestions hôtels / villes', async () => {
  const cat = createMemoryCatalog();
  const pages = { 1: [place(4, 'Deluxe Golden Horn Sultanahmet', 'Istanbul'), place(5, 'Bera Alanya', 'Alanya')], 2: [place(6, 'Golden Horn Bosphorus', 'Istanbul'), place(8, 'Side Resort', 'Side')], 3: [place(7, 'Riad Marrakech', 'Marrakech', 'Morocco')] };
  const fetcher = async url => { const p = Number(new URL(url).searchParams.get('page')); return Response.json({ page: p, total_pages: 3, total_results: 4, results_per_page: 2, data: pages[p], links: p < 3 ? { next: 'x' } : {} }); };
  const b1 = await syncBatch(cat, 1, creds, fetcher, 2);
  assert.deepEqual([b1.imported, b1.nextPage, b1.done], [4, 3, false]);
  const b2 = await syncBatch(cat, 3, creds, fetcher, 2);
  assert.deepEqual([b2.imported, b2.done], [1, true]);
  const s = await cat.suggest('golden horn');
  assert.deepEqual(s.hotels.map(h => h.id), [4, 6]);
  assert.deepEqual((await cat.suggest('istan')).cities, [{ city: 'Istanbul', country: 'Turkey', count: 2 }]);
  assert.deepEqual(await cat.suggest('g'), { hotels: [], cities: [] });
  await assert.rejects(fetchContentPage(1, creds, async () => new Response('', { status: 401 })), /SUPPLIER_AUTH_FAILED/);
});

test('recherche par destination : location, page, prix dès et net fournis', async () => {
  assert.throws(() => validateDestination({ checkin: '2027-03-04', checkout: '2027-03-07', country: 'FR', rooms: [{ adults: 2 }], location: '<script>' }, new Date('2026-11-03')), /LOCATION_INVALID/);
  const r = await searchHalalbookingDestination({ checkin: '2027-03-04', checkout: '2027-03-07', country: 'FR', rooms: [{ adults: 2, children: [5] }], location: 'Istanbul', page: 2 }, creds, async url => {
    const u = new URL(url);
    assert.deepEqual([u.searchParams.get('location'), u.searchParams.get('page'), u.searchParams.getAll('groups[]'), u.searchParams.get('holiday_type')], ['Istanbul', '2', ['2,5'], null]);
    return Response.json({ currency: 'EUR', page: 2, total_pages: 5, total_results: 92, offers: [{ min_price: 292.5, affiliate_net_price: 251.55, affiliate_commission_percentage: '14.000', quantity: 1, place: { ...place(4, 'Deluxe Golden Horn', 'Istanbul'), review_score: { numerical_rating: 8.3, textual_rating: 'Very good' } } }] });
  });
  assert.deepEqual([r.page, r.totalPages, r.total, r.hotels[0].net, r.hotels[0].reviewScore, r.hotels[0].photo], [2, 5, 92, 251.55, 8.3, 'https://cdn.halalstatic.com/x.jpg']);
  assert.equal(r.rawPlaces.length, 1);
});

test('fin de synchronisation sans total_pages : page incomplète', async () => {
  const cat = createMemoryCatalog();
  const full = Array.from({ length: 50 }, (_, i) => place(1000 + i, 'H' + i, 'Antalya'));
  const fetcher = async url => { const p = Number(new URL(url).searchParams.get('page')); return Response.json({ data: p === 1 ? full : [place(2000, 'Last', 'Antalya')] }); };
  const b = await syncBatch(cat, 1, creds, fetcher, 4);
  assert.deepEqual([b.imported, b.done, b.nextPage], [51, true, 3]);
});
