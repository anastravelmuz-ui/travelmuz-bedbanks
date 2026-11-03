import test from 'node:test';
import assert from 'node:assert/strict';
import { nameScore, distanceM, rankCandidates, countryCode, pickCity } from './matching.mjs';

test('similarité des noms et distance', () => {
  assert.ok(nameScore('Deluxe Golden Horn Sultanahmet', 'Deluxe Golden Horn Sultanahmet Hotel') >= 0.85);
  assert.ok(nameScore('Deluxe Golden Horn Sultanahmet', 'Golden Horn Bosphorus Hotel') < 0.6);
  assert.equal(nameScore('Hotel', 'Hotel'), 1);
  assert.ok(nameScore('Deluxe Golden Horn Sultanahmet', 'Sultanahmet Suites') < 0.5); // un seul mot commun
  assert.equal(distanceM(41.0, 28.97, 41.0, 28.97), 0);
  assert.ok(Math.abs(distanceM(41.0, 28.97, 41.001, 28.97) - 111) <= 1);
  assert.equal(distanceM(null, 1, 2, 3), null);
});

test('classement : homonymes départagés par la distance, jamais d’association automatique', () => {
  const src = { name: 'Deluxe Golden Horn Sultanahmet', city: 'Istanbul', lat: 41.0071, lng: 28.9746 };
  const r = rankCandidates(src, [
    { code: '1050432', name: 'Golden Horn Hotel - Special Class', lat: '41.0145', lng: '28.9760' },
    { code: '1235939', name: 'Deluxe Golden Horn Sultanahmet Hotel', lat: '41.0072', lng: '28.9748' },
    { code: '1165886', name: 'Golden Horn Bosphorus Hotel', lat: '41.0150', lng: '28.9770' },
    { code: '9', name: 'Ritz Paris', lat: '48.8', lng: '2.3' },
  ]);
  assert.equal(r[0].code, '1235939'); assert.equal(r[0].strong, true);
  assert.ok(r.every(c => c.code !== '9'));
  assert.ok(r.slice(1).every(c => !c.strong));
  const noGps = rankCandidates({ name: 'Riad Atlas', city: 'Marrakech' }, [{ code: '1', name: 'Riad Atlas Marrakech' }]);
  assert.deepEqual([noGps[0].distanceM, noGps[0].strong], [null, false]);
});

test('pays et villes', () => {
  assert.equal(countryCode('Turkey'), 'TR'); assert.equal(countryCode('Morocco'), 'MA'); assert.equal(countryCode('United Arab Emirates'), 'AE');
  assert.equal(countryCode('Malaysia'), 'MY'); assert.equal(countryCode('Atlantis'), null);
  assert.deepEqual(pickCity('Istanbul', [{ code: '2', name: 'Istanbul-Silivri' }, { code: '1', name: 'Istanbul' }]), { code: '1', name: 'Istanbul' });
  assert.equal(pickCity('Nowhere', [{ code: '1', name: 'Istanbul' }]), null);
});
