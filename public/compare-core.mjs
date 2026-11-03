// Comparateur multi-fournisseurs : calcul des cartouches et de la comparabilité (sans DOM, testé dans Node).
import { cancellationState } from './live-core.mjs';
import { tboCancellationState } from './tbo-core.mjs';

// La nature nette du montant TBO (TotalFare) n'est pas encore confirmée par TBO : pas de comparaison stricte.
export const TBO_NET_CONFIRMED = false;
export const REQUIRED_CURRENCY = 'EUR';

const passBudget = (cost, budget) => budget === '' || budget == null || (typeof cost === 'number' && cost <= Number(budget));
const order = (sort) => (a, b) => (sort === 'desc' ? -1 : 1) * ((a.cost ?? Infinity) - (b.cost ?? Infinity));

/** Halalbooking : une offre par chambre ; coût = net agence fourni (repli : estimé). */
export function hbPanel(snapshot, f = {}, now = Date.now()) {
  if (!snapshot?.offers) return null;
  const offers = snapshot.offers.map(o => ({ ...o, provider: 'halalbooking', cost: typeof o.netPrice === 'number' ? o.netPrice : null, state: cancellationState(o.cancellation, now) }))
    .filter(o => (!f.meal || o.mealCode === f.meal) && (!f.refund || o.state === f.refund) && (!f.room || String(o.roomId) === f.room) && passBudget(o.cost ?? o.price, f.budget))
    .sort(order(f.sort));
  const rooms = snapshot.criteria?.rooms?.length ?? 1;
  const pick = [];
  for (let i = 0; i < rooms; i++) {
    const cheapest = offers.filter(o => (o.roomIndex ?? 0) === i && typeof o.cost === 'number').sort((a, b) => a.cost - b.cost)[0];
    if (!cheapest) return { provider: 'halalbooking', offers, pick: null, total: null, missingRoom: i, received: snapshot.offers.length };
    pick.push(cheapest);
  }
  return {
    provider: 'halalbooking', offers, pick, received: snapshot.offers.length, currency: REQUIRED_CURRENCY,
    total: Math.round(pick.reduce((s, o) => s + o.cost, 0) * 100) / 100,
    publicTotal: pick.every(o => typeof o.price === 'number') ? Math.round(pick.reduce((s, o) => s + o.price, 0) * 100) / 100 : null,
    netConfirmed: pick.every(o => o.netSource === 'supplier'),
    mealCode: new Set(pick.map(o => o.mealCode)).size === 1 ? pick[0].mealCode : null,
    state: new Set(pick.map(o => o.state)).size === 1 ? pick[0].state : 'unknown',
  };
}

/** TBO : une offre couvre toutes les chambres ; coût = TotalFare (nature nette à confirmer). */
export function tboPanel(result, f = {}, now = Date.now()) {
  if (!result?.offers) return null;
  const offers = result.offers.map(o => ({ ...o, provider: 'tbo', cost: typeof o.price === 'number' ? o.price : null, state: tboCancellationState(o, now) }))
    .filter(o => (!f.meal || o.mealCode === f.meal) && (!f.refund || o.state === f.refund) && passBudget(o.cost, f.budget))
    .sort(order(f.sort));
  const pick = offers.filter(o => typeof o.cost === 'number').sort((a, b) => a.cost - b.cost)[0] ?? null;
  return { provider: 'tbo', offers, pick: pick ? [pick] : null, received: result.offers.length, currency: pick?.currency ?? null,
    total: pick?.cost ?? null, netConfirmed: TBO_NET_CONFIRMED, mealCode: pick?.mealCode ?? null, state: pick?.state ?? 'unknown' };
}

/** Désigne le prix affiché le plus bas et dit s'il est strictement comparable, avec les raisons sinon. */
export function comparePanels(panels) {
  const priced = panels.filter(p => p && typeof p.total === 'number');
  if (!priced.length) return { lowest: null, comparable: false, reasons: [] };
  // Devises différentes : aucun « prix le plus bas » n'est désigné (pas de conversion).
  if (new Set(priced.map(p => p.currency)).size > 1) return { lowest: null, comparable: false, reasons: ['devises différentes : aucun prix le plus bas désigné, pas de conversion'], currencyMismatch: true };
  const lowest = priced.reduce((a, b) => (b.total < a.total ? b : a));
  if (priced.length < 2) return { lowest, comparable: false, reasons: ['un seul fournisseur a des offres pour ces critères'] };
  const reasons = [];
  if (priced.some(p => p.currency !== REQUIRED_CURRENCY)) reasons.push('devises différentes');
  if (priced.some(p => !p.netConfirmed)) reasons.push('net agence non confirmé chez au moins un fournisseur');
  if (priced.some(p => !p.mealCode) || new Set(priced.map(p => p.mealCode)).size > 1) reasons.push('pensions différentes ou non reconnues');
  if (priced.some(p => p.state === 'unknown') || new Set(priced.map(p => p.state)).size > 1) reasons.push('conditions d’annulation différentes ou à vérifier');
  reasons.push('chambres non rapprochées (libellés fournisseurs)');
  return { lowest, comparable: false, reasons };
}
