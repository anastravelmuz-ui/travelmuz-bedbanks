// Taux de référence BCE (1 EUR = x devise), publiés à titre informatif chaque jour ouvré vers 16:00 CET.
// Sert uniquement à afficher un équivalent EUR indicatif : ne remplace jamais le prix fournisseur et n'entre pas dans la comparaison.
export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const TTL_MS = 6 * 3600 * 1000;
let cache = null;

export function parseEcbXml(text) {
  if (typeof text !== 'string' || text.length > 200000) throw new Error('FX_INVALID_RESPONSE');
  const day = text.match(/<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/);
  if (!day || !Number.isFinite(Date.parse(day[1]))) throw new Error('FX_INVALID_RESPONSE');
  const rates = {};
  for (const m of text.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"](\d+(?:\.\d+)?)['"]\s*\/?>/g)) {
    const r = Number(m[2]);
    if (Number.isFinite(r) && r > 0) rates[m[1]] = r;
  }
  if (Object.keys(rates).length < 5) throw new Error('FX_INVALID_RESPONSE');
  return { source: 'BCE', base: 'EUR', date: day[1], rates };
}

/** Taux BCE mis en cache 6 h ; en cas de panne, réutilise le dernier taux obtenu (sa date reste affichée). */
export async function getEurRates(fetcher = fetch, now = Date.now()) {
  if (cache && now - cache.fetchedAt < TTL_MS) return cache.data;
  try {
    const response = await fetcher(ECB_DAILY_URL, { headers: { Accept: 'application/xml' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('FX_UNAVAILABLE');
    const data = parseEcbXml(await response.text());
    cache = { fetchedAt: now, data: { ...data, fetchedAt: new Date(now).toISOString() } };
    return cache.data;
  } catch {
    if (cache) return cache.data;
    throw new Error('FX_UNAVAILABLE');
  }
}
export function resetFxCache() { cache = null; }
