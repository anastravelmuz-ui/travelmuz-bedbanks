// Cache des fiches hôtel TBO (données statiques) : TBO recommande un rafraîchissement tous les 15 jours.
export const DETAILS_TTL_MS = 15 * 24 * 3600e3;
const SCHEMA = 'CREATE TABLE IF NOT EXISTS tbo_hotel_details (hotel_code TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL)';
let ready = null;
export function createDetailsCache(db) {
  if (db?.__detailsMemory) return db.__detailsMemory;
  const ensure = () => (ready ??= db.prepare(SCHEMA).run().catch(e => { ready = null; throw e; }));
  return {
    async get(code) { await ensure(); const r = await db.prepare('SELECT payload, fetched_at FROM tbo_hotel_details WHERE hotel_code=?').bind(code).first(); return r ? { value: JSON.parse(r.payload), fetchedAt: r.fetched_at } : null; },
    async set(code, value) { await ensure(); await db.prepare('INSERT INTO tbo_hotel_details (hotel_code,payload,fetched_at) VALUES (?,?,?) ON CONFLICT(hotel_code) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at').bind(code, JSON.stringify(value), Date.now()).run(); },
  };
}
export function createMemoryDetailsCache() {
  const m = new Map();
  return { async get(c) { return m.get(c) ?? null; }, async set(c, v) { m.set(c, { value: v, fetchedAt: Date.now() }); } };
}
/** Fiche hôtel depuis le cache, sinon TBO ; une panne de la fiche n'empêche jamais l'affichage des tarifs. */
export async function cachedDetails(cache, code, load, now = Date.now()) {
  try {
    const hit = cache ? await cache.get(code) : null;
    if (hit && now - hit.fetchedAt < DETAILS_TTL_MS) return hit.value;
    const fresh = await load();
    if (cache) await cache.set(code, fresh);
    return fresh;
  } catch { return null; }
}
