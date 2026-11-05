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
  `CREATE INDEX IF NOT EXISTS hb_places_name ON hb_places(name_norm)`,
  // Index des mots des noms (recherche « golden » → « Deluxe Golden Horn ») : lignes lues ≈ résultats.
  `CREATE TABLE IF NOT EXISTS hb_words (word TEXT NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (word, id)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS hb_catalog_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];
let ready = null;
export const nameWords = nameNorm => [...new Set(String(nameNorm).split(' ').filter(w => w.length >= 2))];
const wordStmts = (db, rows) => { const st = db.prepare('INSERT OR IGNORE INTO hb_words (word, id) VALUES (?, ?)'); return rows.flatMap(r => nameWords(r.nameNorm).map(w => st.bind(w, r.id))); };
/** Mots de la requête : le plus long sert à l'index, tous doivent commencer un mot du nom. */
export const matchesWords = (nameNorm, qWords) => { const ws = String(nameNorm).split(' '); return qWords.every(q => ws.some(w => w.startsWith(q))); };
const fromRow = r => r && { id: r.id, name: r.name, stars: r.stars, city: r.city, region: r.region, subregion: r.subregion, country: r.country, address: r.address, lat: r.lat, lng: r.lng, holidayType: r.holiday_type, photo: r.photo };

export function createCatalog(db) {
  if (db?.__catalogMemory) return db.__catalogMemory;
  const ensure = () => (ready ??= db.batch(SCHEMA.map(s => db.prepare(s))).catch(e => { ready = null; throw e; }));
  return {
    async upsert(rows, now = Date.now()) {
      await ensure();
      if (!rows.length) return;
      const st = db.prepare(`INSERT INTO hb_places (id,name,name_norm,stars,city,city_norm,region,subregion,country,address,lat,lng,holiday_type,photo,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_norm=excluded.name_norm,stars=COALESCE(excluded.stars,hb_places.stars),city=COALESCE(excluded.city,hb_places.city),city_norm=CASE WHEN excluded.city IS NULL THEN hb_places.city_norm ELSE excluded.city_norm END,region=COALESCE(excluded.region,hb_places.region),subregion=COALESCE(excluded.subregion,hb_places.subregion),country=COALESCE(excluded.country,hb_places.country),address=COALESCE(excluded.address,hb_places.address),lat=COALESCE(excluded.lat,hb_places.lat),lng=COALESCE(excluded.lng,hb_places.lng),holiday_type=COALESCE(excluded.holiday_type,hb_places.holiday_type),photo=COALESCE(excluded.photo,hb_places.photo),updated_at=excluded.updated_at
        WHERE hb_places.name IS NOT excluded.name OR hb_places.stars IS NOT COALESCE(excluded.stars,hb_places.stars) OR hb_places.city IS NOT COALESCE(excluded.city,hb_places.city) OR hb_places.region IS NOT COALESCE(excluded.region,hb_places.region) OR hb_places.subregion IS NOT COALESCE(excluded.subregion,hb_places.subregion) OR hb_places.country IS NOT COALESCE(excluded.country,hb_places.country) OR hb_places.address IS NOT COALESCE(excluded.address,hb_places.address) OR hb_places.lat IS NOT COALESCE(excluded.lat,hb_places.lat) OR hb_places.lng IS NOT COALESCE(excluded.lng,hb_places.lng) OR hb_places.holiday_type IS NOT COALESCE(excluded.holiday_type,hb_places.holiday_type) OR hb_places.photo IS NOT COALESCE(excluded.photo,hb_places.photo)`); // aucune écriture si rien n'a changé (quota D1)
      await db.batch([...rows.map(r => st.bind(r.id, r.name, r.nameNorm, r.stars, r.city, r.cityNorm, r.region, r.subregion, r.country, r.address, r.lat, r.lng, r.holidayType, r.photo, now)), ...wordStmts(db, rows)]);
    },
    /** Ajout seulement (réponses de recherche en français) : ne remplace jamais le contenu anglais du catalogue. */
    async insertMissing(rows, now = Date.now()) {
      await ensure();
      if (!rows.length) return;
      const st = db.prepare('INSERT OR IGNORE INTO hb_places (id,name,name_norm,stars,city,city_norm,region,subregion,country,address,lat,lng,holiday_type,photo,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      await db.batch([...rows.map(r => st.bind(r.id, r.name, r.nameNorm, r.stars, r.city, r.cityNorm, r.region, r.subregion, r.country, r.address, r.lat, r.lng, r.holidayType, r.photo, 0)), ...wordStmts(db, rows)]);
    },
    /** État de synchronisation seul (1 ligne lue). Ne jamais compter le catalogue ici : COUNT(*) lit toutes les lignes. */
    async syncState() { await ensure(); const r = await db.prepare("SELECT v FROM hb_catalog_state WHERE k='sync'").first(); return r ? JSON.parse(r.v) : {}; },
    /** Rattrapage de l'index des mots pour les établissements importés avant lui : lot d'identifiants > afterId. */
    async backfillWords(afterId, limit = 500) {
      await ensure();
      const rs = (await db.prepare('SELECT id, name_norm FROM hb_places WHERE id > ? ORDER BY id LIMIT ?').bind(afterId, limit).all()).results ?? [];
      const stmts = wordStmts(db, rs.map(r => ({ id: r.id, nameNorm: r.name_norm })));
      if (stmts.length) await db.batch(stmts);
      return { lastId: rs.length ? rs[rs.length - 1].id : afterId, done: rs.length < limit };
    },
    /** Avec le nombre d'établissements : lit tout le catalogue, réservé à l'affichage de l'administration. */
    async state() { await ensure(); const rs = (await db.prepare('SELECT k, v FROM hb_catalog_state').all()).results ?? []; const count = (await db.prepare('SELECT COUNT(*) AS n FROM hb_places').first()).n; return { ...Object.fromEntries(rs.map(r => [r.k, JSON.parse(r.v)])), count }; },
    async setState(k, v) { await ensure(); await db.prepare('INSERT INTO hb_catalog_state (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, JSON.stringify(v)).run(); },
    async get(id) { await ensure(); return fromRow(await db.prepare('SELECT * FROM hb_places WHERE id=?').bind(id).first()); },
    async suggest(q) {
      await ensure();
      const n = normalize(q);
      if (n.length < 2) return { hotels: [], cities: [] };
      // Recherche par début de nom ou de ville, sur index (lignes lues ≈ résultats) : un LIKE '%…%' lirait tout le catalogue à chaque frappe.
      const hi = n + '{';
      const qw = n.split(' ').filter(Boolean), key = [...qw].sort((a, b) => b.length - a.length)[0];
      const found = (await db.prepare('SELECT p.* FROM hb_words w JOIN hb_places p ON p.id = w.id WHERE w.word >= ? AND w.word < ? LIMIT 60').bind(key, key + '{').all()).results ?? [];
      // Secours sans écriture : début du nom complet (index name_norm), tant que l'index des mots n'est pas complet.
      if (found.length < 8) {
        const seen = new Set(found.map(r => r.id));
        for (const r of (await db.prepare('SELECT * FROM hb_places WHERE name_norm >= ? AND name_norm < ? ORDER BY name_norm LIMIT 8').bind(n, n + '{').all()).results ?? []) if (!seen.has(r.id)) found.push(r);
      }
      const hotels = found.filter(r => matchesWords(r.name_norm, qw)).sort((a, b) => (b.name_norm.startsWith(n) - a.name_norm.startsWith(n)) || (b.stars ?? 0) - (a.stars ?? 0)).slice(0, 8).map(fromRow);
      const cities = n.length < 3 ? [] : ((await db.prepare('SELECT city, country, COUNT(*) AS n FROM hb_places WHERE city_norm >= ? AND city_norm < ? AND city IS NOT NULL GROUP BY city, country ORDER BY n DESC LIMIT 6').bind(n, hi).all()).results ?? []).map(r => ({ city: r.city, country: r.country, count: r.n }));
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
    /** État de synchronisation seul (1 ligne lue). Ne jamais compter le catalogue ici : COUNT(*) lit toutes les lignes. */
    async syncState() { await ensure(); const r = await db.prepare("SELECT v FROM hb_catalog_state WHERE k='sync'").first(); return r ? JSON.parse(r.v) : {}; },
    /** Rattrapage de l'index des mots pour les établissements importés avant lui : lot d'identifiants > afterId. */
    async backfillWords(afterId, limit = 500) {
      await ensure();
      const rs = (await db.prepare('SELECT id, name_norm FROM hb_places WHERE id > ? ORDER BY id LIMIT ?').bind(afterId, limit).all()).results ?? [];
      const stmts = wordStmts(db, rs.map(r => ({ id: r.id, nameNorm: r.name_norm })));
      if (stmts.length) await db.batch(stmts);
      return { lastId: rs.length ? rs[rs.length - 1].id : afterId, done: rs.length < limit };
    },
    /** Avec le nombre d'établissements : lit tout le catalogue, réservé à l'affichage de l'administration. */
    async state() { return { ...st, count: rows.size }; },
    async syncState() { return st.sync ?? {}; },
    async backfillWords(afterId) { return { lastId: afterId, done: true }; },
    async setState(k, v) { st[k] = v; },
    async get(id) { const r = rows.get(id); return r ? { id: r.id, name: r.name, stars: r.stars, city: r.city, region: r.region, subregion: r.subregion, country: r.country, address: r.address, lat: r.lat, lng: r.lng, holidayType: r.holidayType, photo: r.photo } : null; },
    async suggest(q) {
      const n = normalize(q); if (n.length < 2) return { hotels: [], cities: [] };
      const all = [...rows.values()];
      const hotels = all.filter(r => matchesWords(r.nameNorm, n.split(' ').filter(Boolean))).slice(0, 8).map(r => ({ id: r.id, name: r.name, stars: r.stars, city: r.city, country: r.country }));
      const cm = new Map(); for (const r of all.filter(r => r.cityNorm.startsWith(n) && r.city)) { const k = r.city + '|' + r.country; cm.set(k, { city: r.city, country: r.country, count: (cm.get(k)?.count ?? 0) + 1 }); }
      return { hotels, cities: [...cm.values()].slice(0, 6) };
    },
  };
}

/** Un lot de synchronisation : pages [from, from + n). */
export async function syncBatch(catalog, from, credentials, fetcher = fetch, n = PAGES_PER_BATCH, now = Date.now()) {
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
  const prev = await catalog.syncState();
  // completedAt conservé tant qu'une nouvelle synchronisation complète n'est pas terminée
  await catalog.setState('sync', { ...(from === 1 ? {} : { wordsAfter: prev.wordsAfter, wordsDone: prev.wordsDone }), nextPage: done ? 1 : page, totalPages, lastBatchAt: now, startedAt: from === 1 ? now : prev.startedAt ?? null, completedAt: done ? now : (from === 1 ? null : prev.completedAt ?? null) });
  return { imported, nextPage: page, totalPages, done };
}
