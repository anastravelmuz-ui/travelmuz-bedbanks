// Comparaison d'un dossier réservé avec les offres actuelles (étape 1 : à la demande, aucune action fournisseur).
// Règle : un gain n'est signalé que si devise, net agence, pension et souplesse d'annulation sont compatibles ;
// les chambres ne sont jamais rapprochées sur leur nom (l'agent compare les libellés). Aucun gain n'est garanti.
import { parseTboDate } from './tbo-core.mjs';
import { hbedsFreeUntil } from './hotelbeds-core.mjs';

const TBO_SLACK = 14 * 3600e3; // dates TBO sans fuseau : borne la plus prudente

/** Fin de l'annulation sans frais d'une offre (ms), au plus tôt ; null si inconnue ou non remboursable. */
export function freeUntilOf(provider, o) {
  if (provider === 'halalbooking') {
    const rules = Array.isArray(o.cancellation) ? o.cancellation : [];
    const first = rules[0];
    if (!first || first.penalty !== 0) return null;
    if (!first.until) return Infinity; // sans frais jusqu'à l'arrivée selon le fournisseur
    const t = Date.parse(first.until); return Number.isFinite(t) && /[Zz]|[+-]\d{2}:\d{2}$/.test(first.until) ? t : null;
  }
  if (provider === 'tbo') {
    if (o.isRefundable !== true) return null;
    const starts = (o.cancelPolicies ?? []).filter(r => typeof r.charge === 'number' && r.charge > 0).map(r => parseTboDate(r.from));
    if (!starts.length || starts.some(t => t == null)) return null;
    return Math.min(...starts) - TBO_SLACK;
  }
  if (provider === 'ratehawk') {
    const t = o.freeCancellationBefore ? Date.parse(o.freeCancellationBefore) : NaN; return Number.isFinite(t) ? t : null;
  }
  if (provider === 'bedsonline') {
    if (o.rateClass === 'NRF') return null;
    const iso = hbedsFreeUntil(o); return iso ? Date.parse(iso) : null;
  }
  return null;
}

export const bookingMeal = b => { const s = new Set((b.rooms ?? []).map(r => r.meal)); return s.size === 1 && !s.has('unknown') ? [...s][0] : null; };

/**
 * Évalue un cartouche fournisseur (hbPanel / tboPanel / bedsPanel) face au dossier.
 * status : 'gain' (gain potentiel, chambre à vérifier) | 'none' (pas moins cher) | 'check' (écart non concluant) | 'na' (pas d'offre comparable)
 */
export function assessPanel(panel, booking, now = Date.now()) {
  if (!panel || typeof panel.total !== 'number' || !panel.pick?.length) return { status: 'na', reasons: [] };
  const purchase = booking.purchase.amount / 100, reasons = [];
  const sameCurrency = panel.currency === booking.purchase.currency;
  const diff = sameCurrency ? Math.round((panel.total - purchase) * 100) / 100 : null;
  if (!sameCurrency) reasons.push(`devise ${panel.currency ?? 'inconnue'} ≠ ${booking.purchase.currency} du dossier (pas de conversion)`);
  if (!panel.netConfirmed) reasons.push('net agence non confirmé');
  const meal = bookingMeal(booking);
  if (!meal) reasons.push('pension du dossier à vérifier');
  else if (panel.mealCode !== meal) reasons.push('pension différente ou non reconnue');
  if (booking.nonRefundable) reasons.push('dossier non remboursable : pas d’annulation sans frais possible');
  else {
    const deadline = Date.parse(booking.deadline);
    if (!(deadline > now)) reasons.push('début des frais du dossier dépassé');
    const free = panel.pick.map(o => freeUntilOf(panel.provider, o));
    if (free.some(t => t == null)) reasons.push('annulation de l’offre non remboursable ou à vérifier');
    else if (Math.min(...free) < deadline) reasons.push('annulation sans frais moins longue que celle du dossier');
  }
  if (diff != null && diff >= 0) return { status: 'none', diff, reasons };
  return { status: reasons.length ? 'check' : 'gain', diff, reasons };
}
