// TBO : logique partagée serveur/navigateur (sans dépendance).
// ---- Annulation : dates TBO « dd-MM-yyyy HH:mm:ss » SANS fuseau horaire ----
export function parseTboDate(value) {
  const m = typeof value === 'string' && value.trim().match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, d, mo, y, h, mi, s] = m.map(Number);
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(t);
  return check.getUTCDate() === d && check.getUTCMonth() === mo - 1 ? t : null; // heure « murale », fuseau inconnu
}
const SLACK = 14 * 3600e3; // écart maximal entre fuseaux : sans fuseau, on ne conclut pas à moins de 14 h près
/** free | fees | nonref | unknown — prudent : en cas de doute lié au fuseau, « unknown ». */
export function tboCancellationState(offer, now = Date.now()) {
  if (offer.isRefundable === false) return 'nonref';
  const rules = Array.isArray(offer.cancelPolicies) ? offer.cancelPolicies : [];
  if (offer.isRefundable !== true || !rules.length) return 'unknown';
  const charged = rules.filter(r => typeof r.charge === 'number' && r.charge > 0);
  if (!charged.length) return 'unknown';
  const starts = charged.map(r => parseTboDate(r.from));
  if (starts.some(t => t === null)) return 'unknown';
  const first = Math.min(...starts);
  if (now < first - SLACK) return 'free';
  if (now >= first + SLACK) {
    const current = charged.filter((r, i) => starts[i] + SLACK <= now).sort((a, b) => parseTboDate(b.from) - parseTboDate(a.from))[0];
    return current && current.type === 'Percentage' && current.charge >= 100 ? 'nonref' : 'fees';
  }
  return 'unknown';
}

