// TravelMuz Bedbanks — routage du Worker Cloudflare (D-016).
// Toutes les requêtes passent ici avant les fichiers statiques : rien n'est visible sans compte.
import { createAuth } from '../server/auth-core.mjs';
import { createD1Store } from '../server/auth-store-d1.mjs';
import { handleAuth, currentUser } from '../server/auth-http.mjs';
import { validateSearch, searchHalalbooking, searchHalalbookingDestination, CRITERIA_ERRORS } from '../server/halalbooking.mjs';
import { createCatalog, placeRow, syncBatch } from '../server/hb-catalog.mjs';
import { tboConfig, searchTbo, tboCities, tboHotels, tboHotelDetails, attachRoomDetails, TBO_ERRORS } from '../server/tbo.mjs';
import { createDetailsCache, cachedDetails } from '../server/tbo-cache.mjs';
import { hotelbedsConfig, searchHotelbeds, hotelbedsStatus, hotelbedsHotels, hotelbedsDetails, attachHotelbedsDetails, hotelbedsRateComments, HOTELBEDS_ERRORS } from '../server/hotelbeds.mjs';

// Temporaire (demande du 3/11/2026) : offres TBO hors EUR affichées pour les tests, signalées et non comparées.
const ALLOW_NON_EUR = true;
import { createD1MapStore, validateMapping } from '../server/hotel-map.mjs';

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

async function readJson(request) {
  if (Number(request.headers.get('content-length') ?? 0) > 4096) throw new Error('BODY_TOO_LARGE');
  const raw = await request.text();
  if (raw.length > 4096) throw new Error('BODY_TOO_LARGE');
  return JSON.parse(raw);
}
const sameOrigin = request => request.headers.get('origin') === new URL(request.url).origin;
const supplierError = e => { const m = e instanceof Error ? e.message : ''; return TBO_ERRORS.includes(m) || HOTELBEDS_ERRORS.includes(m) ? m : 'SUPPLIER_ERROR'; };

// Les établissements vus en recherche enrichissent le catalogue (jamais bloquant).
async function rememberPlaces(env, places) {
  if (!env.DB) return;
  try { await createCatalog(env.DB).upsert(places.map(placeRow).filter(Boolean)); } catch { /* catalogue facultatif */ }
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

async function catalogAdmin(request, env, user, path) {
  if (!user) return json({ error: 'AUTHENTICATION_REQUIRED' }, 401);
  if (user.role !== 'admin') return json({ error: 'ADMIN_REQUIRED' }, 403);
  if (!env.DB) return json({ error: 'STORAGE_NOT_CONFIGURED' }, 503);
  const catalog = createCatalog(env.DB);
  if (path === '/api/admin/catalog/state' && request.method === 'GET') return json(await catalog.state());
  if (path === '/api/admin/catalog/sync' && request.method === 'POST') {
    if (!sameOrigin(request)) return json({ error: 'ORIGIN_REJECTED' }, 403);
    let b; try { b = await readJson(request); } catch { return json({ error: 'INVALID_BODY' }, 400); }
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
