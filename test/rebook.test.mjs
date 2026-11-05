import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPanel, freeUntilOf } from '../public/rebook-core.mjs';

const now = Date.parse('2026-11-05T10:00:00Z');
const booking = (o = {}) => ({ purchase: { amount: 83743, currency: 'EUR' }, rooms: [{ meal: 'BB', adults: 2, childrenAges: [11, 9] }], deadline: '2026-12-03T00:00:00+09:00', nonRefundable: false, ...o });
const hb = (total, until = '2026-12-02T23:59:00+03:00', o = {}) => ({ provider: 'halalbooking', total, currency: 'EUR', netConfirmed: true, mealCode: 'BB', pick: [{ cancellation: [{ penalty: 0, until }, { penalty: 100 }] }], ...o });

test('dossier : gain potentiel seulement si devise, net, pension et annulation compatibles', () => {
  const a = assessPanel(hb(790, '2026-12-03T00:00:00+08:00'), booking(), now);
  assert.deepEqual([a.status, a.diff, a.reasons], ['gain', -47.43, []]);
  assert.equal(assessPanel(hb(900, '2026-12-03T00:00:00+08:00'), booking(), now).status, 'none');
  // annulation plus courte que celle du dossier
  const short = assessPanel(hb(790, '2026-11-20T00:00:00+03:00'), booking(), now);
  assert.equal(short.status, 'check'); assert.match(short.reasons.join(), /moins longue/);
  // devise différente : pas de conversion, écart non calculé
  const gbp = assessPanel(hb(600, '2026-12-03T00:00:00+08:00', { currency: 'GBP', netConfirmed: false, provider: 'tbo' }), booking(), now);
  assert.deepEqual([gbp.status, gbp.diff], ['check', null]);
  // pension différente
  assert.match(assessPanel(hb(700, '2026-12-03T00:00:00+08:00', { mealCode: 'RO' }), booking(), now).reasons.join(), /pension/);
  // dossier non remboursable ou échéance dépassée
  assert.equal(assessPanel(hb(700), booking({ nonRefundable: true, deadline: null }), now).status, 'check');
  assert.match(assessPanel(hb(700, '2026-12-03T00:00:00+08:00'), booking(), Date.parse('2026-12-04T00:00:00Z')).reasons.join(), /dépassé/);
  assert.equal(assessPanel({ total: null }, booking(), now).status, 'na');
});

test('fin de l’annulation sans frais par fournisseur (TBO : borne prudente de 14 h)', () => {
  assert.equal(freeUntilOf('tbo', { isRefundable: true, cancelPolicies: [{ charge: 50, from: '03-12-2026 00:00:00' }] }), Date.UTC(2026, 11, 3) - 14 * 3600e3);
  assert.equal(freeUntilOf('tbo', { isRefundable: false }), null);
  assert.equal(freeUntilOf('bedsonline', { rateClass: 'NRF' }), null);
  assert.equal(freeUntilOf('bedsonline', { cancellation: [{ amount: 10, from: '2027-03-01T23:59:00+03:00' }] }), Date.parse('2027-03-01T23:59:00+03:00'));
  assert.equal(freeUntilOf('halalbooking', { cancellation: [{ penalty: 50, until: null }] }), null);
});
