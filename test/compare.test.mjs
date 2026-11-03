import test from 'node:test';
import assert from 'node:assert/strict';
import { mealCodeFromText, mealCodeFromTbo } from '../public/meal-core.mjs';
import { hbPanel, tboPanel, comparePanels, bedsPanel } from '../public/compare-core.mjs';

const NOW = Date.parse('2026-11-03T08:00:00Z');
const free = [{ until: '2027-03-03T00:00:00+03:00', penalty: 0 }, { penalty: 100 }];
const hb = (roomIndex, room, price, net, mealCode = 'BB', extra = {}) => ({ roomIndex, room, roomId: room.length, price, netPrice: net, netSource: 'supplier', mealCode, cancellation: free, ...extra });

test('pensions : codes communs, inconnu = null', () => {
  assert.equal(mealCodeFromText('Petit déjeuner inclus'), 'BB');
  assert.equal(mealCodeFromText('Demi-pension'), 'HB');
  assert.equal(mealCodeFromText('Pension complète'), 'FB');
  assert.equal(mealCodeFromText('All Inclusive'), 'AI');
  assert.equal(mealCodeFromText('Room only'), 'RO');
  assert.equal(mealCodeFromText('Formule spéciale'), null);
  assert.equal(mealCodeFromTbo('Breakfast_For_2'), 'BB');
  assert.equal(mealCodeFromTbo('Mystère'), null);
});

test('Halalbooking : total du groupe = net le moins cher de chaque chambre', () => {
  const snap = { criteria: { rooms: [{}, {}] }, offers: [hb(0, 'Familiale', 864, 684.98), hb(0, 'Suite', 960, 761.09), hb(1, 'Standard', 292.5, 251.55)] };
  const p = hbPanel(snap, {}, NOW);
  assert.deepEqual([p.total, p.publicTotal, p.pick.length, p.mealCode, p.state, p.netConfirmed], [936.53, 1156.5, 2, 'BB', 'free', true]);
  // une chambre sans offre après filtre → pas de total (jamais de total partiel)
  const p2 = hbPanel(snap, { budget: 300 }, NOW);
  assert.equal(p2.total, null); assert.equal(p2.missingRoom, 0);
  assert.equal(hbPanel(snap, { meal: 'HB' }, NOW).offers.length, 0);
});

test('TBO : offre la moins chère toutes chambres, net non confirmé', () => {
  const p = tboPanel({ offers: [{ price: 900, currency: 'EUR', mealCode: 'BB', isRefundable: false, cancelPolicies: [] }, { price: 880, currency: 'EUR', mealCode: 'RO', isRefundable: false, cancelPolicies: [] }] }, {}, NOW);
  assert.deepEqual([p.total, p.mealCode, p.state, p.netConfirmed], [880, 'RO', 'nonref', false]);
  assert.equal(tboPanel({ offers: [] }, {}, NOW).total, null);
});

test('comparaison : prix le plus bas désigné, jamais « comparable » sans preuves', () => {
  const a = { provider: 'halalbooking', total: 936.53, currency: 'EUR', netConfirmed: true, mealCode: 'BB', state: 'free' };
  const b = { provider: 'tbo', total: 880, currency: 'EUR', netConfirmed: false, mealCode: 'RO', state: 'nonref' };
  const c = comparePanels([a, b, null]);
  assert.equal(c.lowest.provider, 'tbo'); assert.equal(c.comparable, false);
  assert.ok(c.reasons.includes('pensions différentes ou non reconnues'));
  assert.ok(c.reasons.includes('net agence non confirmé chez au moins un fournisseur'));
  assert.deepEqual(comparePanels([a]).reasons, ['un seul fournisseur a des offres pour ces critères']);
  assert.equal(comparePanels([]).lowest, null);
});

test('devises différentes : aucun prix le plus bas désigné', () => {
  const c = comparePanels([{ provider: 'halalbooking', total: 900, currency: 'EUR' }, { provider: 'tbo', total: 800, currency: 'USD' }]);
  assert.equal(c.lowest, null); assert.equal(c.currencyMismatch, true);
});

test('Bedsonline : total = net le moins cher par occupation ; aucune chambre oubliée', () => {
  const cancel = [{ amount: 100, from: '2027-03-01T23:59:00+03:00' }];
  const o = (idx, net, mealCode = 'BB') => ({ roomIndexes: idx, occupancyMatched: true, net, currency: 'EUR', mealCode, cancellation: cancel });
  const p = bedsPanel({ offers: [o([0], 500), o([0], 450), o([1, 2], 700)] }, {}, 3, NOW);
  assert.deepEqual([p.total, p.pick.length, p.state, p.netConfirmed], [1150, 2, 'free', true]);
  assert.equal(bedsPanel({ offers: [o([0], 500)] }, {}, 2, NOW).total, null); // chambre 2 non couverte
});
