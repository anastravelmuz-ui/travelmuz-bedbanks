// Hotelbeds / Bedsonline : logique partagée serveur/navigateur (sans dépendance).
// Politique d'annulation : liste de { amount, from } — à partir de « from » (date ISO avec décalage), pénalité « amount ».
const OFFSET = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** free | fees | nonref | unknown */
export function hbedsCancellationState(offer, now = Date.now()) {
  if (offer.rateClass === 'NRF') return 'nonref';
  const rules = Array.isArray(offer.cancellation) ? offer.cancellation : [];
  if (!rules.length) return 'unknown';
  if (rules.some(r => typeof r.amount !== 'number' || !OFFSET.test(String(r.from ?? '')) || !Number.isFinite(Date.parse(r.from)))) return 'unknown';
  const sorted = [...rules].sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  if (now < Date.parse(sorted[0].from)) return sorted[0].amount > 0 ? 'free' : 'unknown';
  const current = sorted.filter(r => Date.parse(r.from) <= now).pop();
  return typeof offer.net === 'number' && current.amount >= offer.net ? 'nonref' : 'fees';
}

/** Première échéance avant frais (ISO), si connue. */
export function hbedsFreeUntil(offer) {
  const rules = (offer.cancellation ?? []).filter(r => OFFSET.test(String(r.from ?? '')));
  return rules.length ? rules.map(r => r.from).sort((a, b) => Date.parse(a) - Date.parse(b))[0] : null;
}
