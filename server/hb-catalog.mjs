// Catalogue Halalbooking (GET /api/v2/content, 50 établissements par page) stocké dans D1,
// pour chercher par nom d'hôtel ou par ville sans appel fournisseur. Synchronisé par lots depuis l'administration.
const API = 'https://halalbooking.com/api/v2/content';
export const PAGES_PER_BATCH = 6; // limite de temps CPU / sous-requêtes par invocation du Worker

export const normalize = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const num = v => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };

export function placeRow(p) {
  if (!p || !Number.isSafeInteger(p.id)) return null;
  const loc = p.location ?? {};
  const photo = typeof p.photo === 'string' && /^https:\/\//.test(p.photo) ? p.photo : (Array.isArray(p.photos) && typeof p.photos[0] === 'string' && /^https:\/\//.test(p.photos[0]) ? p.photos[0] : null);
  return {
    id: p.id, name: String(p.name ?? '').slice(0, 200), nameNorm: normalize(p.name), stars: num(p.stars),
    city: loc.city ?? null, cityNorm: normalize(loc.city), region: loc.region ?? null, subregion: loc.subregion ?? null, country: loc.country ?? null,
    address: typeof loc.address === 'string' ? loc.address.slice(0, 300) : null, lat: num(loc.latitude), lng: num(loc.longitude),
    holidayType: p.holiday_type ?? null, photo,
  };
}

export async function fetchContentPage(page, credentials, fetcher = fetch, placeIds = null) {
  if (!credentials?.partner || !credentials?.secret) throw new Error('CONFIGURATION_MISSING');
  const url = new URL(API); url.searchParams.set('page', String(page));
  for (const id of placeIds ?? []) url.searchParams.append('place_ids[]', String(id));
  let r;
  try { r = await fetcher(url, { headers: { Accept: 'application/json', Authorization: 'Basic ' + btoa(credentials.partner + ':' + credentials.secret) }, redirect: 'manual', signal: AbortSignal.timeout(25000) }); }
  catch { throw new Error('SUPPLIER_UNREACHABLE'); }
  if (r.status === 401 || r.status === 403) throw new Error('SUPPLIER_AUTH_FAILED');
  if (r.status === 429) throw new Error('QUOTA_EXCEEDED');
  if (!r.ok) throw new Error('SUPPLIER_ERROR');
  let d; try { d = await r.json(); } catch { throw new Error('SUPPLIER_INVALID_RESPONSE'); }
  if (!Array.isArray(d?.data)) throw new Error('SUPPLIER_INVALID_RESPONSE');
  return { rows: d.data.map(placeRow).filter(Boolean), received: d.data.length, perPage: num(d.results_per_page) ?? 50, totalPages: num(d.total_pages ?? d.meta?.total_pages), total: num(d.total_results ?? d.meta?.total_results), hasNext: typeof d.links?.next === 'string' ? true : d.links ? false : null };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS hb_places (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_norm TEXT NOT NULL, stars REAL, city TEXT, city_norm TEXT, region TEXT, subregion TEXT, country TEXT, address TEXT, lat REAL, lng REAL, holiday_type TEXT, photo TEXT, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS hb_places_city ON hb_places(city_norm)`,
  `CREATE TABLE IF NOT EXISTS hb_catalog_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];
let ready = null;
const fromRow = r => r && { id: r.id, name: r.name, stars: r.stars, city: r.city, region: r.region, subregion: r.subregion, country: r.country, address: r.address, lat: r.lat, lng: r.lng, holidayType: r.holiday_type, photo: r.photo };

export function createCatalog(db) {
  if (db?.__catalogMemory) return db.__catalogMemory;
  const ensure = () => (ready ??= db.batch(SCHEMA.map(s => db.prepare(s))).catch(e => { ready = null; throw e; }));
  return {
    async upsert(rows, now = Date.now()) {
      await ensure();
      if (!rows.length) return;
      const st = db.prepare(`INSERT INTO hb_places (id,name,name_norm,stars,city,city_norm,region,subregion,country,address,lat,lng,holiday_type,photo,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_norm=excluded.name_norm,stars=COALESCE(excluded.stars,hb_places.stars),city=COALESCE(excluded.city,hb_places.city),city_norm=CASE WHEN excluded.city IS NULL THEN hb_places.city_norm ELSE excluded.city_norm END,region=COALESCE(excluded.region,hb_places.region),subregion=COALESCE(excluded.subregion,hb_places.subregion),country=COALESCE(excluded.country,hb_places.country),address=COALESCE(excluded.address,hb_places.address),lat=COALESCE(excluded.lat,hb_places.lat),lng=COALESCE(excluded.lng,hb_places.lng),holiday_type=COALESCE(excluded.holiday_type,hb_places.holiday_type),photo=COALESCE(excluded.photo,hb_places.photo),updated_at=excluded.updated_at`);
      await db.batch(rows.map(r => st.bind(r.id, r.name, r.nameNorm, r.stars, r.city, r.cityNorm, r.region, r.subregion, r.country, r.address, r.lat, r.lng, r.holidayType, r.photo, now)));
    },
    /** Ajout seulement (réponses de recherche en français) : ne remplace jamais le contenu anglais du catalogue. */
    async insertMissing(rows, now = Date.now()) {
      await ensure();
      if (!rows.length) return;
      const st = db.prepare('INSERT OR IGNORE INTO hb_places (id,name,name_norm,stars,city,city_norm,region,subregion,country,address,lat,lng,holiday_type,photo,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      await db.batch(rows.map(r => st.bind(r.id, r.name, r.nameNorm, r.stars, r.city, r.cityNorm, r.region, r.subregion, r.country, r.address, r.lat, r.lng, r.holidayType, r.photo, 0)));
    },
    async state() { await ensure(); const rs = (await db.prepare('SELECT k, v FROM hb_catalog_state').all()).results ?? []; const count = (await db.prepare('SELECT COUNT(*) AS n FROM hb_places').first()).n; return { ...Object.fromEntries(rs.map(r => [r.k, JSON.parse(r.v)])), count }; },
    async setState(k, v) { await ensure(); await db.prepare('INSERT INTO hb_catalog_state (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, JSON.stringify(v)).run(); },
    async get(id) { await ensure(); return fromRow(await db.prepare('SELECT * FROM hb_places WHERE id=?').bind(id).first()); },
    async suggest(q) {
      await ensure();
      const n = normalize(q);
      if (n.length < 2) return { hotels: [], cities: [] };
      const like = `%${n}%`;
      const hotels = ((await db.prepare('SELECT * FROM hb_places WHERE name_norm LIKE ? ORDER BY (name_norm LIKE ?) DESC, stars DESC LIMIT 8').bind(like, n + '%').all()).results ?? []).map(fromRow);
      const cities = ((await db.prepare('SELECT city, country, COUNT(*) AS n FROM hb_places WHERE city_norm LIKE ? AND city IS NOT NULL GROUP BY city, country ORDER BY (city_norm LIKE ?) DESC, n DESC LIMIT 6').bind(like, n + '%').all()).results ?? []).map(r => ({ city: r.city, country: r.country, count: r.n }));
      return { hotels, cities };
    },
  };
}

/** Mémoire (tests). */
export function createMemoryCatalog() {
  const rows = new Map(); const st = {};
  return {
    async insertMissing(list) { for (const r of list) if (!rows.has(r.id)) rows.set(r.id, r); },
    async upsert(list) { for (const r of list) { const old = rows.get(r.id); rows.set(r.id, old ? { ...r, lat: r.lat ?? old.lat, lng: r.lng ?? old.lng, address: r.address ?? old.address } : r); } },
    async state() { return { ...st, count: rows.size }; },
    async setState(k, v) { st[k] = v; },
    async get(id) { const r = rows.get(id); return r ? { id: r.id, name: r.name, stars: r.stars, city: r.city, region: r.region, subregion: r.subregion, country: r.country, address: r.address, lat: r.lat, lng: r.lng, holidayType: r.holidayType, photo: r.photo } : null; },
    async suggest(q) {
      const n = normalize(q); if (n.length < 2) return { hotels: [], cities: [] };
      const all = [...rows.values()];
      const hotels = all.filter(r => r.nameNorm.includes(n)).slice(0, 8).map(r => ({ id: r.id, name: r.name, stars: r.stars, city: r.city, country: r.country }));
      const cm = new Map(); for (const r of all.filter(r => r.cityNorm.includes(n) && r.city)) { const k = r.city + '|' + r.country; cm.set(k, { city: r.city, country: r.country, count: (cm.get(k)?.count ?? 0) + 1 }); }
      return { hotels, cities: [...cm.values()].slice(0, 6) };
    },
  };
}

/** Un lot de synchronisation : pages [from, from + n). */
export async function syncBatch(catalog, from, credentials, fetcher = fetch, n = PAGES_PER_BATCH) {
  let totalPages = null, imported = 0, page = from, ended = false;
  for (; page < from + n; page++) {
    const r = await fetchContentPage(page, credentials, fetcher);
    totalPages = r.totalPages ?? totalPages;
    await catalog.upsert(r.rows);
    imported += r.rows.length;
    // Fin : dernière page annoncée, absence de lien « next », ou page incomplète.
    if ((totalPages != null && page >= totalPages) || r.hasNext === false || r.received < r.perPage) { page++; ended = true; break; }
  }
  const done = ended;
  await catalog.setState('sync', { nextPage: done ? 1 : page, totalPages, lastBatchAt: Date.now(), ...(done ? { completedAt: Date.now() } : {}) });
  return { imported, nextPage: page, totalPages, done };
}
