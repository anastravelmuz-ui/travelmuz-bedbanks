// Correspondance des hôtels entre fournisseurs : chaque lien est validé par un administrateur (jamais automatique).
// Clé interne actuelle : identifiant Halalbooking de l'hôtel (place id).
export const PROVIDERS = ['tbo'];
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS hotel_map (hb_place_id INTEGER NOT NULL, provider TEXT NOT NULL, provider_code TEXT NOT NULL, provider_name TEXT, provider_address TEXT, validated_by TEXT NOT NULL, validated_at INTEGER NOT NULL, PRIMARY KEY (hb_place_id, provider))`,
];

export function validateMapping(input) {
  const hbPlaceId = Number(input?.hbPlaceId);
  const provider = input?.provider;
  const code = String(input?.code ?? '');
  if (!Number.isSafeInteger(hbPlaceId) || hbPlaceId < 1 || !PROVIDERS.includes(provider) || !/^\d{1,12}$/.test(code)) throw new Error('MAPPING_INVALID');
  const text = v => (typeof v === 'string' ? v.slice(0, 300) : null);
  return { hbPlaceId, provider, code, name: text(input.name), address: text(input.address) };
}

export function createMemoryMapStore() {
  const rows = new Map();
  const key = (id, p) => `${id}:${p}`;
  return {
    async get(hbPlaceId, provider) { return rows.get(key(hbPlaceId, provider)) ?? null; },
    async list() { return [...rows.values()].sort((a, b) => a.hbPlaceId - b.hbPlaceId || a.provider.localeCompare(b.provider)); },
    async set(m, by) { rows.set(key(m.hbPlaceId, m.provider), { ...m, validatedBy: by, validatedAt: Date.now() }); },
    async remove(hbPlaceId, provider) { rows.delete(key(hbPlaceId, provider)); },
  };
}

let ready = null;
const toRow = r => r && { hbPlaceId: r.hb_place_id, provider: r.provider, code: r.provider_code, name: r.provider_name, address: r.provider_address, validatedBy: r.validated_by, validatedAt: r.validated_at };
export function createD1MapStore(db) {
  if (db?.__mapMemory) return db.__mapMemory; // tests
  const ensure = () => (ready ??= db.batch(SCHEMA.map(s => db.prepare(s))).catch(e => { ready = null; throw e; }));
  const q = async (sql, ...a) => { await ensure(); return db.prepare(sql).bind(...a); };
  return {
    async get(hbPlaceId, provider) { return toRow(await (await q('SELECT * FROM hotel_map WHERE hb_place_id=? AND provider=?', hbPlaceId, provider)).first()); },
    async list() { return ((await (await q('SELECT * FROM hotel_map ORDER BY hb_place_id, provider')).all()).results ?? []).map(toRow); },
    async set(m, by) {
      await (await q(`INSERT INTO hotel_map (hb_place_id,provider,provider_code,provider_name,provider_address,validated_by,validated_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(hb_place_id,provider) DO UPDATE SET provider_code=excluded.provider_code, provider_name=excluded.provider_name, provider_address=excluded.provider_address, validated_by=excluded.validated_by, validated_at=excluded.validated_at`,
        m.hbPlaceId, m.provider, m.code, m.name, m.address, by, Date.now())).run();
    },
    async remove(hbPlaceId, provider) { await (await q('DELETE FROM hotel_map WHERE hb_place_id=? AND provider=?', hbPlaceId, provider)).run(); },
  };
}
