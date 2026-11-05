// TravelMuz Bedbanks — routage du Worker Cloudflare (D-016).
// Toutes les requêtes passent ici avant les fichiers statiques : rien n'est visible sans compte.
import { createAuth } from '../server/auth-core.mjs';
import { createD1Store } from '../server/auth-store-d1.mjs';
import { handleAuth, currentUser } from '../server/auth-http.mjs';
import { validateSearch, searchHalalbooking, searchHalalbookingDestination, CRITERIA_ERRORS } from '../server/halalbooking.mjs';
import { createCatalog, placeRow, syncBatch, fetchContentPage } from '../server/hb-catalog.mjs';
import { rankCandidates, countryCode, pickCities } from '../server/matching.mjs';
import { tboConfig, searchTbo, tboCities, tboHotels, tboHotelDetails, attachRoomDetails, TBO_ERRORS } from '../server/tbo.mjs';
import { createDetailsCache, cachedDetails } from '../server/tbo-cache.mjs';
import { hotelbedsConfig, searchHotelbeds, hotelbedsStatus, hotelbedsHotels, hotelbedsDetails, attachHotelbedsDetails, hotelbedsRateComments, hotelbedsDestinations, hotelbedsAllHotels, HOTELBEDS_ERRORS } from '../server/hotelbeds.mjs';

// Temporaire (demande du 3/11/2026) : offres TBO hors EUR affichées pour les tests, signalées et non comparées.
const ALLOW_NON_EUR = true;
import { createD1MapStore, validateMapping } from '../server/hotel-map.mjs';
import { validateBooking, createBookingStore } from '../server/bookings.mjs';

export const FIRST_ADMIN_EMAIL = 'anas@travelmuz.fr'; // D-015

// Accessibles sans session : pages et ressources nécessaires pour se connecter.
const PUBLIC_PATHS = new Set([
  '/connexion.html', '/reinitialiser.html', '/comptes.mjs', '/comptes.css',
  '/style.css', '/live.css', '/favicon.ico',
]);
const PUBLIC_AUTH = new Set(['login', 'logout', 'me', 'forgot', 'link', 'set-password', 'bootstrap']);
const ADMIN_PAGES = new Set(['/admin.html']);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function secure(response, { noStore = false } = {}) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) r.headers.set(k, v);
  if (noStore) r.headers.set('Cache-Control', 'no-store');
  return r;
}
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

async function halalbookingSearch(request, env, user) {
  if (!user) return json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
  if (request.method !== 'POST') return json({ error: 'NOT_FOUND' }, 404);
  if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'ORIGIN_REJECTED' }, 403);
  if (Number(request.headers.get('content-length') ?? 0) > 4096) return json({ error: 'BODY_TOO_LARGE' }, 413);
  let criteria;
  try { const raw = await request.text(); if (raw.length > 4096) throw new Error(); criteria = validateSearch(JSON.parse(raw)); }
  catch (e) { const detail = e instanceof Error && CRITERIA_ERRORS.includes(e.message) ? e.message : 'CRITERIA_INVALID'; return json({ error: 'INVALID_CRITERIA', detail }, 400); }
  try {
    const { rawPlace, ...result } = await searchHalalbooking(criteria, { partner: env.HALALBOOKING_PARTNER_CODE, secret: env.HALALBOOKING_SECRET_KEY });
    await rememberPlaces(env, [rawPlace]);
    return json(result);
  } catch (e) {
    const error = e instanceof Error ? e.message : 'SUPPLIER_ERROR';
    const known = ['CONFIGURATION_MISSING', 'SUPPLIER_AUTH_FAILED', 'SUPPLIER_UNREACHABLE', 'SUPPLIER_INVALID_RESPONSE'];
    return json({ error: known.includes(error) ? error : 'SUPPLIER_ERROR' }, 502);
  }
}

async function readJson(request, max = 4096) {
  if (Number(request.headers.get('content-length') ?? 0) > max) throw new Error('BODY_TOO_LARGE');
  const raw = await request.text();
  if (raw.length > max) throw new Error('BODY_TOO_LARGE');
  return JSON.parse(raw);
}
const sameOrigin = request => request.headers.get('origin') === new URL(request.url).origin;
const supplierError = e => { const m = e instanceof Error ? e.message : ''; return TBO_ERRORS.includes(m) || HOTELBEDS_ERRORS.includes(m) ? m : 'SUPPLIER_ERROR'; };

// Les établissements vus en recherche enrichissent le catalogue (jamais bloquant).
async function rememberPlaces(env, places) {
  if (!env.DB) return;
  try { await createCatalog(env.DB).insertMissing(places.map(placeRow).filter(Boolean)); } catch { /* catalogue facultatif */ }
}
const hbCreds = env => ({ partner: env.HALALBOOKING_PARTNER_CODE, secret: env.HALALBOOKING_SECRET_KEY });

async function destinationSearch(request, env, user) {
  if (!user) return json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
  if (request.method !== 'POST') return json({ error: 'NOT_FOUND' }, 404);
  if (!sameOrigin(request)) return json({ error: 'ORIGIN_REJECTED' }, 403);
  let body;
  try { body = await readJson(request); } catch { return json({ error: 'INVALID_CRITERIA', detail: 'CRITERIA_INVALID' }, 400); }
  try {
    const { rawPlaces, ...result } = await searchHalalbookingDestination(body, hbCreds(env));
    await rememberPlaces(env, rawPlaces);
    return json(result);
  } catch (e) {
    const m = e instanceof Error ? e.message : '';
    if (CRITERIA_ERRORS.includes(m)) return json({ error: 'INVALID_CRITERIA', detail: m }, 400);
    return json({ error: ['CONFIGURATION_MISSING', 'SUPPLIER_AUTH_FAILED', 'SUPPLIER_UNREACHABLE', 'SUPPLIER_INVALID_RESPONSE', 'QUOTA_EXCEEDED'].includes(m) ? m : 'SUPPLIER_ERROR' }, 502);
  }
}

async function placesSuggest(env, user, url) {
  if (!user) return json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
  if (!env.DB) return json({ hotels: [], cities: [] });
  const q = (url.searchParams.get('q') ?? '').slice(0, 80);
  try { return json(await createCatalog(env.DB).suggest(q)); } catch { return json({ hotels: [], cities: [] }); }
}

async function placeInfo(env, user, url) {
  if (!user) return json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
  const id = Number(url.searchParams.get('id'));
  if (!Number.isSafeInteger(id) || id < 1 || !env.DB) return json({ error: 'NOT_FOUND' }, 404);
  const p = await createCatalog(env.DB).get(id).catch(() => null);
  return p ? json({ place: p }) : json({ error: 'NOT_FOUND' }, 404);
}

// Cache 15 jours des listes statiques fournisseurs ; contrairement à cachedDetails, l'erreur est remontée.
async function cachedList(env, key, load) {
  const cache = env.DB ? createDetailsCache(env.DB) : null;
  const hit = cache ? await cache.get(key).catch(() => null) : null;
  if (hit && Date.now() - hit.fetchedAt < 15 * 24 * 3600e3) return { value: hit.value, cached: true };
  const value = await load();
  if (cache) await cache.set(key, value).catch(() => {});
  return { value, cached: false };
}
const compact = h => ({ code: h.code, name: h.name, address: typeof h.address === 'string' ? h.address.slice(0, 120) : null, rating: h.rating ?? null, lat: h.lat ?? (h.latitude != null ? Number(h.latitude) : null), lng: h.lng ?? (h.longitude != null ? Number(h.longitude) : null) });

/** Suggestions de correspondance (administrateurs) : nom + distance GPS, jamais d'association automatique. */
async function matchSuggest(env, user, url) {
  if (!user) return json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
  if (user.role !== 'admin') return json({ error: 'ADMIN_REQUIRED' }, 403);
  const id = Number(url.searchParams.get('hotel')), provider = url.searchParams.get('provider');
  if (!Number.isSafeInteger(id) || id < 1 || !['tbo', 'hotelbeds'].includes(provider) || !env.DB) return json({ error: 'INVALID_CRITERIA' }, 400);
  const catalog = createCatalog(env.DB);
  let source = await catalog.get(id).catch(() => null);
  // Contenu anglais rechargé si coordonnées ou pays manquent / ne sont pas reconnus (ex. fiche créée depuis une recherche en français).
  if (!source || source.lat == null || !countryCode(source.country)) {
    try { const r = await fetchContentPage(1, hbCreds(env), fetch, [id]); await catalog.upsert(r.rows); source = await catalog.get(id); } catch { /* coordonnées indisponibles : nom seul */ }
  }
  if (!source) return json({ error: 'HOTEL_UNKNOWN' }, 404);
  const cc = countryCode(source.country);
  if (!cc) return json({ error: 'COUNTRY_UNKNOWN', source }, 422);
  try {
    // Plusieurs villes fournisseur explorées : un même quartier est souvent classé sous une autre ville (ex. Kuta / Seminyak, Bali).
    let explored, list = []; const skipped = [];
    if (provider === 'tbo') {
      const cfg = tboConfig(env); if (!cfg) return json({ error: 'CONFIGURATION_MISSING' }, 502);
      const cities = (await cachedList(env, `tbo-cities:${cc}`, () => tboCities(cc, cfg))).value;
      explored = pickCities(source, cities, 10);
      for (const c of explored) {
        try { list.push(...(await cachedList(env, `tbo-hotels:${c.code}`, async () => (await tboHotels(c.code, cfg)).map(compact))).value.map(h => ({ ...h, city: c.name }))); }
        catch (e) { if (e instanceof Error && e.message === 'SUPPLIER_AUTH_FAILED') throw e; skipped.push(c.name); } // ville vide ou en erreur : ignorée
      }
    } else {
      const cfg = hotelbedsConfig(env); if (!cfg) return json({ error: 'CONFIGURATION_MISSING' }, 502);
      const dests = (await cachedList(env, `hbeds-dest:${cc}`, () => hotelbedsDestinations(cc, cfg))).value;
      explored = pickCities(source, dests, 2); // quota d'évaluation : 2 destinations au plus
      for (const c of explored) {
        try { list.push(...(await cachedList(env, `hbeds-hotels:${c.code}`, async () => (await hotelbedsAllHotels(c.code, cfg)).map(compact))).value.map(h => ({ ...h, city: c.name }))); }
        catch (e) { if (e instanceof Error && ['SUPPLIER_AUTH_FAILED', 'QUOTA_EXCEEDED'].includes(e.message)) throw e; skipped.push(c.name); }
      }
    }
    if (!explored.length) return json({ error: 'CITY_NOT_FOUND', source, country: cc }, 404);
    const unique = [...new Map(list.map(h => [h.code, h])).values()];
    const candidates = rankCandidates(source, unique);
    const nearest = candidates.length ? Math.min(...candidates.map(c => c.distanceM ?? Infinity)) : Infinity;
    return json({ source: { id: source.id, name: source.name, city: source.city, subregion: source.subregion, region: source.region, country: source.country, address: source.address, lat: source.lat, lng: source.lng }, city: { code: explored[0].code, name: explored.map(c => c.name.replace(/\s+/g, ' ')).join(', ') }, explored: explored.map(c => c.name), skipped, scanned: unique.length, candidates, noneNearby: source.lat != null && !(nearest < 1000) });
  } catch (e) { return json({ error: supplierError(e) }, 502); }
}

/**
 * Synchronisation automatique (une exécution par minute) : continue l'import page par page ;
 * une fois terminé, ne recommence qu'après 7 jours. Les erreurs sont notées dans l'état, sans arrêter les exécutions suivantes.
 */
/**
 * Tâche planifiée (toutes les 5 min) : un lot au plus tous les CATALOG_CRON_GAP_MIN minutes (45 par défaut),
 * pour rester sous les quotas gratuits D1 (5 M lignes lues, 100 000 écrites par jour) ; 1 si offre Workers Paid.
 * Import du catalogue d'abord, puis rattrapage de l'index des mots ; renouvellement tous les 30 jours.
 */
export async function runCatalogCron(env, now = Date.now()) {
  if (!env.DB || !env.HALALBOOKING_PARTNER_CODE || !env.HALALBOOKING_SECRET_KEY) return { skipped: 'configuration' };
  const gap = (Number(env.CATALOG_CRON_GAP_MIN) > 0 ? Number(env.CATALOG_CRON_GAP_MIN) : 45) * 60e3;
  const catalog = createCatalog(env.DB);
  const sync = await catalog.syncState(); // 1 ligne lue
  if (sync.lastBatchAt && now - sync.lastBatchAt < gap) return { skipped: 'trop tôt' };
  const fresh = sync.completedAt && now - sync.completedAt < 30 * 24 * 3600e3 && (sync.nextPage ?? 1) === 1;
  // Index des mots incomplet : un lot sur deux lui est consacré pendant l'import (recherche par nom rétablie plus vite).
  const wordsTurn = !sync.wordsDone && Math.floor(now / gap) % 2 === 0;
  if (fresh || wordsTurn) {
    if (sync.wordsDone) return { skipped: 'à jour' };
    const w = await catalog.backfillWords(sync.wordsAfter ?? 0);
    await catalog.setState('sync', { ...sync, wordsAfter: w.lastId, wordsDone: w.done, lastBatchAt: now });
    return { words: w };
  }
  try { return await syncBatch(catalog, sync.nextPage ?? 1, hbCreds(env), fetch, undefined, now); }
  catch (e) { await catalog.setState('sync', { ...sync, lastError: e instanceof Error ? e.message : 'SUPPLIER_ERROR', lastErrorAt: now, lastBatchAt: now }); return { error: true }; }
}

async function catalogAdmin(request, env, user, path) {
  if (!user) return json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
  if (user.role !== 'admin') return json({ error: 'ADMIN_REQUIRED' }, 403);
  if (!env.DB) return json({ error: 'STORAGE_NOT_CONFIGURED' }, 503);
  const catalog = createCatalog(env.DB);
  if (path === '/api/admin/catalog/state' && request.method === 'GET') return json(await catalog.state());
  if (path === '/api/admin/catalog/sync' && request.method === 'POST') {
    if (!sameOrigin(request)) return json({ error: 'ORIGIN_REJECTED' }, 403);
    let b; try { b = await readJson(request); } catch { return json({ error: 'INVALID_BODY' }, 400); }
    // Accélération manuelle : seulement si l'offre D1 le permet (sinon risque de bloquer toute l'application, connexions comprises).
    if (env.CATALOG_FAST !== 'true') return json({ error: 'QUOTA_PROTECTION' }, 409);
    const from = Number.isInteger(b.from) && b.from >= 1 ? b.from : 1;
    try { return json(await syncBatch(catalog, from, hbCreds(env))); }
    catch (e) { return json({ error: e instanceof Error ? e.message : 'SUPPLIER_ERROR' }, 502); }
  }
  return json({ error: 'NOT_FOUND' }, 404);
}

async function tboSearch(request, env, user) {
  if (!user) return json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
  if (request.method !== 'POST') return json({ error: 'NOT_FOUND' }, 404);
  if (!sameOrigin(request)) return json({ error: 'ORIGIN_REJECTED' }, 403);
  let body, criteria;
  try { body = await readJson(request); criteria = validateSearch(body); }
  catch (e) { const detail = e instanceof Error && CRITERIA_ERRORS.includes(e.message) ? e.message : 'CRITERIA_INVALID'; return json({ error: 'INVALID_CRITERIA', detail }, 400); }
  if (typeof body.nationality !== 'string' || !/^[A-Z]{2}$/.test(body.nationality)) return json({ error: 'INVALID_CRITERIA', detail: 'NATIONALITY_INVALID' }, 400);
  const cfg = tboConfig(env);
  if (!cfg) return json({ error: 'CONFIGURATION_MISSING' }, 502);
  const mapping = env.DB ? await createD1MapStore(env.DB).get(criteria.hotelId, 'tbo') : null;
  if (!mapping) return json({ provider: 'TBO', status: 'not_mapped', offers: [], observedAt: new Date().toISOString() });
  try {
    const r = await searchTbo(criteria, mapping.code, body.nationality, cfg, fetch, { allowNonEur: ALLOW_NON_EUR });
    if (r.offers.length) {
      const details = await cachedDetails(env.DB ? createDetailsCache(env.DB) : null, mapping.code, () => tboHotelDetails(mapping.code, cfg));
      if (details) r.offers = attachRoomDetails(r.offers, details);
      r.detailsAvailable = !!details;
    }
    return json({ ...r, criteria, mapping: { code: mapping.code, name: mapping.name } });
  } catch (e) { return json({ error: supplierError(e) }, 502); }
}

async function bedsonlineSearch(request, env, user) {
  if (!user) return json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
  if (request.method !== 'POST') return json({ error: 'NOT_FOUND' }, 404);
  if (!sameOrigin(request)) return json({ error: 'ORIGIN_REJECTED' }, 403);
  let criteria;
  try { criteria = validateSearch(await readJson(request)); }
  catch (e) { const detail = e instanceof Error && CRITERIA_ERRORS.includes(e.message) ? e.message : 'CRITERIA_INVALID'; return json({ error: 'INVALID_CRITERIA', detail }, 400); }
  const cfg = hotelbedsConfig(env);
  if (!cfg) return json({ error: 'CONFIGURATION_MISSING' }, 502);
  const mapping = env.DB ? await createD1MapStore(env.DB).get(criteria.hotelId, 'hotelbeds') : null;
  if (!mapping) return json({ provider: 'Bedsonline', status: 'not_mapped', offers: [], observedAt: new Date().toISOString() });
  try {
    const r = await searchHotelbeds(criteria, mapping.code, cfg, fetch, { allowNonEur: ALLOW_NON_EUR });
    if (r.offers.length) {
      const details = await cachedDetails(env.DB ? createDetailsCache(env.DB) : null, 'hotelbeds:' + mapping.code, () => hotelbedsDetails(mapping.code, cfg));
      if (details) r.offers = attachHotelbedsDetails(r.offers, details);
    }
    return json({ ...r, criteria, mapping: { code: mapping.code, name: mapping.name } });
  } catch (e) { return json({ error: supplierError(e) }, 502); }
}

async function bedsonlineRateComments(request, env, user, url) {
  if (!user) return json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
  if (request.method !== 'GET') return json({ error: 'NOT_FOUND' }, 404);
  const cfg = hotelbedsConfig(env);
  if (!cfg) return json({ error: 'CONFIGURATION_MISSING' }, 502);
  const code = url.searchParams.get('code') ?? '', date = url.searchParams.get('date') ?? '';
  if (!/^[\d|]{1,60}$/.test(code) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'INVALID_CRITERIA' }, 400);
  let failure = null;
  const comments = await cachedDetails(env.DB ? createDetailsCache(env.DB) : null, `hotelbeds-rc:${code}:${date}`, () => hotelbedsRateComments(code, date, cfg).catch(e => { failure = e; throw e; }));
  if (!comments) return json({ error: supplierError(failure) }, 502);
  return json({ comments });
}

async function adminTbo(request, env, user, path, url) {
  if (!user) return json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
  if (user.role !== 'admin') return json({ error: 'ADMIN_REQUIRED' }, 403);
  const store = env.DB ? createD1MapStore(env.DB) : null;
  if (path === '/api/admin/mappings') {
    if (!store) return json({ error: 'STORAGE_NOT_CONFIGURED' }, 503);
    if (request.method === 'GET') return json({ mappings: await store.list() });
    if (request.method !== 'POST') return json({ error: 'NOT_FOUND' }, 404);
    if (!sameOrigin(request)) return json({ error: 'ORIGIN_REJECTED' }, 403);
    let b, m;
    try { b = await readJson(request); m = validateMapping(b); } catch { return json({ error: 'MAPPING_INVALID' }, 400); }
    if (b.action === 'delete') { await store.remove(m.hbPlaceId, m.provider); return json({ ok: true }); }
    if (b.action !== 'set') return json({ error: 'ACTION_INVALID' }, 400);
    await store.set(m, user.email);
    return json({ mapping: await store.get(m.hbPlaceId, m.provider) });
  }
  if (request.method !== 'GET') return json({ error: 'NOT_FOUND' }, 404);
  if (path.startsWith('/api/admin/hotelbeds/')) {
    const hcfg = hotelbedsConfig(env);
    if (!hcfg) return json({ error: 'CONFIGURATION_MISSING' }, 502);
    try {
      if (path === '/api/admin/hotelbeds/status') return json(await hotelbedsStatus(hcfg));
      if (path === '/api/admin/hotelbeds/hotels') {
        const name = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        const r = await hotelbedsHotels((url.searchParams.get('destination') ?? '').trim().toUpperCase(), Number(url.searchParams.get('from') ?? 1), hcfg);
        return json({ total: r.total, from: r.from, scanned: r.hotels.length, hotels: r.hotels.filter(h => !name || String(h.name ?? '').toLowerCase().includes(name)).slice(0, 50) });
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'CRITERIA_INVALID') return json({ error: 'INVALID_CRITERIA' }, 400);
      return json({ error: supplierError(e) }, 502);
    }
    return json({ error: 'NOT_FOUND' }, 404);
  }
  const cfg = tboConfig(env);
  if (!cfg) return json({ error: 'CONFIGURATION_MISSING' }, 502);
  try {
    if (path === '/api/admin/tbo/cities') {
      const name = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const cities = await tboCities(url.searchParams.get('country') ?? '', cfg);
      return json({ cities: cities.filter(c => !name || c.name.toLowerCase().includes(name)).slice(0, 50) });
    }
    if (path === '/api/admin/tbo/details') return json(await tboHotelDetails(url.searchParams.get('code') ?? '', cfg));
    if (path === '/api/admin/tbo/hotels') {
      const name = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const hotels = await tboHotels(url.searchParams.get('city') ?? '', cfg);
      const found = hotels.filter(h => !name || String(h.name ?? '').toLowerCase().includes(name));
      return json({ total: hotels.length, hotels: found.slice(0, 50) });
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : '';
    if (m === 'CRITERIA_INVALID') return json({ error: 'INVALID_CRITERIA' }, 400);
    return json({ error: supplierError(e), ...(e?.supplierStatus ? { supplierStatus: e.supplierStatus } : {}) }, 502);
  }
  return json({ error: 'NOT_FOUND' }, 404);
}

// ---- Module Réservations : dossiers partagés entre agents connectés ----
const BOOKING_ID = /^[0-9a-f-]{36}$/;
async function bookings(request, env, user, path) {
  if (!user) return json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
  if (!env.DB) return json({ error: 'STORAGE_NOT_CONFIGURED' }, 503);
  const store = createBookingStore(env.DB);
  const id = path.slice('/api/bookings/'.length);
  if (path === '/api/bookings' && request.method === 'GET') return json({ bookings: await store.list() });
  if (request.method !== 'GET' && !sameOrigin(request)) return json({ error: 'ORIGIN_REJECTED' }, 403);
  const body = async () => { try { return { data: validateBooking(await readJson(request, 32768)) }; } catch (e) { return { error: json({ error: 'INVALID_BOOKING', detail: e instanceof Error ? e.message : 'BODY_INVALID' }, 400) }; } };
  if (path === '/api/bookings' && request.method === 'POST') { const b = await body(); return b.error ?? json({ booking: await store.create(b.data, user.email) }, 201); }
  if (!BOOKING_ID.test(id)) return json({ error: 'NOT_FOUND' }, 404);
  if (request.method === 'GET') { const r = await store.get(id); return r ? json({ booking: r }) : json({ error: 'NOT_FOUND' }, 404); }
  if (request.method === 'PUT') { const b = await body(); if (b.error) return b.error; const r = await store.update(id, b.data, user.email); return r ? json({ booking: r }) : json({ error: 'NOT_FOUND' }, 404); }
  if (request.method === 'DELETE') {
    const r = await store.get(id); if (!r) return json({ error: 'NOT_FOUND' }, 404);
    if (user.role !== 'admin' && r.createdBy !== user.email) return json({ error: 'FORBIDDEN' }, 403); // créateur ou administrateur
    await store.remove(id); return json({ ok: true });
  }
  return json({ error: 'NOT_FOUND' }, 404);
}

export async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const auth = env.DB ? createAuth(createD1Store(env.DB)) : null;
  const ctx = { auth, setupCode: env.SETUP_CODE ?? '', firstAdminEmail: FIRST_ADMIN_EMAIL, mailer: null };

  const authMatch = path.match(/^\/api\/auth\/([a-z-]+)$/);
  if (authMatch && PUBLIC_AUTH.has(authMatch[1])) return secure(await handleAuth(authMatch[1], request, ctx), { noStore: true });
  if (path === '/api/admin') return secure(await handleAuth('admin', request, ctx), { noStore: true });

  let user = null;
  try { user = await currentUser(request, auth); } catch { user = null; }

  if (path === '/api/halalbooking/search') return secure(await halalbookingSearch(request, env, user), { noStore: true });
  if (path === '/api/halalbooking/destination') return secure(await destinationSearch(request, env, user), { noStore: true });
  if (path === '/api/places/suggest') return secure(await placesSuggest(env, user, url), { noStore: true });
  if (path === '/api/places/info') return secure(await placeInfo(env, user, url), { noStore: true });
  if (path.startsWith('/api/admin/catalog/')) return secure(await catalogAdmin(request, env, user, path), { noStore: true });
  if (path === '/api/admin/match') return secure(await matchSuggest(env, user, url), { noStore: true });
  if (path === '/api/bookings' || path.startsWith('/api/bookings/')) return secure(await bookings(request, env, user, path), { noStore: true });
  if (path === '/api/tbo/search') return secure(await tboSearch(request, env, user), { noStore: true });
  if (path === '/api/bedsonline/search') return secure(await bedsonlineSearch(request, env, user), { noStore: true });
  if (path === '/api/bedsonline/ratecomments') return secure(await bedsonlineRateComments(request, env, user, url), { noStore: true });
  if (path === '/api/admin/mappings' || path.startsWith('/api/admin/tbo/') || path.startsWith('/api/admin/hotelbeds/')) return secure(await adminTbo(request, env, user, path, url), { noStore: true });
  if (path.startsWith('/api/')) return secure(json({ error: 'NOT_FOUND' }, 404));

  const isPublic = PUBLIC_PATHS.has(path) || path.startsWith('/fonts/');
  if (!isPublic && !user) {
    const accept = request.headers.get('accept') ?? '';
    if (request.method === 'GET' && (accept.includes('text/html') || path === '/' || path.endsWith('.html'))) {
      return secure(Response.redirect(new URL('/connexion.html', url).toString(), 302), { noStore: true });
    }
    return secure(json({ error: 'AUTHENTICATION_REQUIRED' }, 401));
  }
  if (ADMIN_PAGES.has(path) && user?.role !== 'admin') return secure(Response.redirect(new URL('/', url).toString(), 302), { noStore: true });

  // La racine sert la page du comparateur.
  const assetRequest = path === '/' ? new Request(new URL('/index.html', url), request) : request;
  const asset = await env.ASSETS.fetch(assetRequest);
  // Pages privées : jamais en cache partagé.
  return secure(asset, { noStore: !isPublic });
}
