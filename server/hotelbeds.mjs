// Connecteur Bedsonline / Hotelbeds APItude (Booking API + Content API). Consultation seule.
// Documentation : https://developer.hotelbeds.com/documentation/ (lue le 3 novembre 2026).
// Authentification : en-têtes Api-key et X-Signature = SHA-256 hex (clé + secret + horodatage en secondes).
import { mealCodeFromText } from '../public/meal-core.mjs';

export const HOTELBEDS_TEST_URL = 'https://api.test.hotelbeds.com';
export const HOTELBEDS_LIVE_URL = 'https://api.hotelbeds.com';
export const HOTELBEDS_ERRORS = ['CONFIGURATION_MISSING', 'INSECURE_ENDPOINT', 'SUPPLIER_AUTH_FAILED', 'SUPPLIER_UNREACHABLE', 'SUPPLIER_INVALID_RESPONSE', 'SUPPLIER_ERROR', 'QUOTA_EXCEEDED'];
export const PHOTO_BASE = 'https://photos.hotelbeds.com/giata/bigger/';

export function hotelbedsConfig(env) {
  if (!env?.HOTELBEDS_API_KEY || !env?.HOTELBEDS_SECRET) return null;
  return { base: String(env.HOTELBEDS_BASE_URL || HOTELBEDS_TEST_URL).replace(/\/+$/, ''), apiKey: env.HOTELBEDS_API_KEY, secret: env.HOTELBEDS_SECRET };
}

export async function signature(apiKey, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey + secret + nowSeconds)));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function call(cfg, path, { method = 'GET', body, base = cfg.base, timeoutMs = 25000 } = {}, fetcher = fetch) {
  let target;
  try { target = new URL(base + path); } catch { throw new Error('CONFIGURATION_MISSING'); }
  if (target.protocol !== 'https:') throw new Error('INSECURE_ENDPOINT');
  let response;
  try {
    response = await fetcher(target, {
      method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'Api-key': cfg.apiKey, 'X-Signature': await signature(cfg.apiKey, cfg.secret), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new Error('SUPPLIER_UNREACHABLE'); }
  if (response.status === 401 || response.status === 403) throw new Error(response.status === 403 && /quota/i.test(response.headers.get('x-error') ?? '') ? 'QUOTA_EXCEEDED' : 'SUPPLIER_AUTH_FAILED');
  if (response.status === 429) throw new Error('QUOTA_EXCEEDED');
  if (!response.ok) throw new Error('SUPPLIER_ERROR');
  try { return await response.json(); } catch { throw new Error('SUPPLIER_INVALID_RESPONSE'); }
}

/** Détecte l'environnement des clés : test (évaluation) ou production, via /status. */
export async function hotelbedsStatus(cfg, fetcher = fetch) {
  const out = {};
  for (const [env, base] of [['test', HOTELBEDS_TEST_URL], ['production', HOTELBEDS_LIVE_URL]]) {
    try { const d = await call(cfg, '/hotel-api/1.0/status', { base, timeoutMs: 15000 }, fetcher); out[env] = d?.status === 'OK' ? 'ok' : 'unexpected'; }
    catch (e) { out[env] = e instanceof Error ? e.message : 'SUPPLIER_ERROR'; }
  }
  return { ...out, configured: cfg.base === HOTELBEDS_LIVE_URL ? 'production' : cfg.base === HOTELBEDS_TEST_URL ? 'test' : 'personnalisé' };
}

// ---- Pensions Hotelbeds (codes « board ») ----
const BOARDS = { RO: 'RO', SC: 'RO', BB: 'BB', AB: 'BB', CB: 'BB', DB: 'BB', IB: 'BB', HB: 'HB', MP: 'HB', FB: 'FB', PC: 'FB', AI: 'AI', TI: 'AI', TL: 'AI', UI: 'AI' };
export const mealCodeFromBoard = (code, name) => BOARDS[String(code ?? '').toUpperCase()] ?? mealCodeFromText(name);

const num = v => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
const occKey = (adults, ages) => `${adults}|${[...ages].map(Number).sort((a, b) => a - b).join(',')}`;

/** Occupations Hotelbeds : chambres identiques regroupées (rooms: n), âges des enfants transmis. */
export function hotelbedsOccupancies(rooms) {
  const groups = new Map();
  rooms.forEach((r, i) => {
    const k = occKey(r.adults, r.children);
    if (!groups.has(k)) groups.set(k, { key: k, roomIndexes: [], adults: r.adults, ages: [...r.children] });
    groups.get(k).roomIndexes.push(i);
  });
  return [...groups.values()];
}

export async function searchHotelbeds(q, hotelCode, cfg, fetcher = fetch, { allowNonEur = false } = {}) {
  if (!cfg) throw new Error('CONFIGURATION_MISSING');
  if (!/^\d{1,10}$/.test(String(hotelCode))) throw new Error('CRITERIA_INVALID');
  const groups = hotelbedsOccupancies(q.rooms);
  const body = {
    sourceMarket: q.country, // marché du client : prix utilisés uniquement pour ce marché (règle Hotelbeds)
    stay: { checkIn: q.checkin, checkOut: q.checkout },
    occupancies: groups.map(g => ({ rooms: g.roomIndexes.length, adults: g.adults, children: g.ages.length, ...(g.ages.length ? { paxes: g.ages.map(age => ({ type: 'CH', age })) } : {}) })),
    hotels: { hotel: [Number(hotelCode)] },
  };
  const data = await call(cfg, '/hotel-api/1.0/hotels', { method: 'POST', body }, fetcher);
  const base = { provider: 'Bedsonline', observedAt: new Date().toISOString(), hotelCode: String(hotelCode), environment: cfg.base === HOTELBEDS_LIVE_URL ? 'production' : 'test' };
  const hotels = data?.hotels?.hotels;
  if (!data?.hotels || (hotels !== undefined && !Array.isArray(hotels))) throw new Error('SUPPLIER_INVALID_RESPONSE');
  const offers = [];
  for (const h of hotels ?? []) for (const room of h.rooms ?? []) for (const rate of room.rates ?? []) {
    const ages = typeof rate.childrenAges === 'string' && rate.childrenAges.trim() ? rate.childrenAges.split(',').map(Number) : [];
    const group = groups.find(g => g.key === occKey(rate.adults, ages)) ?? null;
    const taxes = Array.isArray(rate.taxes?.taxes) ? rate.taxes.taxes : [];
    offers.push({
      provider: 'Bedsonline', hotelCode: String(h.code ?? hotelCode), hotel: h.name ?? null, category: h.categoryName ?? null, categoryCode: h.categoryCode ?? null, currency: h.currency ?? null,
      rateCommentsId: typeof rate.rateCommentsId === 'string' && /^[\d|]{1,60}$/.test(rate.rateCommentsId) ? rate.rateCommentsId : null, sourceMarket: q.country,
      roomCode: room.code ?? null, room: room.name ?? null,
      roomIndexes: group?.roomIndexes ?? [], units: num(rate.rooms), adults: num(rate.adults), childrenAges: ages, occupancyMatched: !!group,
      net: num(rate.net), sellingRate: num(rate.sellingRate), hotelMandatory: rate.hotelMandatory === true,
      rateClass: rate.rateClass ?? null, rateType: rate.rateType ?? null, paymentType: rate.paymentType ?? null, packaging: rate.packaging === true,
      boardCode: rate.boardCode ?? null, meal: rate.boardName ?? null, mealCode: mealCodeFromBoard(rate.boardCode, rate.boardName),
      cancellation: (rate.cancellationPolicies ?? []).map(p => ({ amount: num(p.amount), from: p.from ?? null })),
      taxesAllIncluded: rate.taxes?.allIncluded === true,
      taxesAtHotel: taxes.filter(t => t.included === false).map(t => ({ type: t.subType ?? t.type ?? null, amount: num(t.amount), currency: t.currency ?? null, clientAmount: num(t.clientAmount), clientCurrency: t.clientCurrency ?? null })),
      promotions: (rate.promotions ?? []).map(p => p?.name).filter(Boolean),
      recheck: rate.rateType === 'RECHECK',
    });
  }
  if (!offers.length) return { ...base, status: 'no_availability', offers: [] };
  const foreign = [...new Set(offers.map(o => o.currency).filter(c => c !== 'EUR'))];
  if (foreign.length && !allowNonEur) return { ...base, status: 'currency_not_eur', currency: foreign.join(', '), offers: [], hidden: offers.length };
  return { ...base, status: 'ok', ...(foreign.length ? { currencyWarning: foreign.join(', ') } : {}), offers };
}

// ---- Content API : correspondance des hôtels et photos ----
const content = v => (v && typeof v === 'object' ? v.content ?? null : typeof v === 'string' ? v : null);
export async function hotelbedsHotels(destinationCode, from, cfg, fetcher = fetch) {
  if (!/^[A-Z0-9]{2,6}$/.test(String(destinationCode))) throw new Error('CRITERIA_INVALID');
  const start = Number.isInteger(from) && from >= 1 ? from : 1;
  const qs = new URLSearchParams({ destinationCode, fields: 'code,name,address,categoryCode,city,postalCode', language: 'ENG', from: String(start), to: String(start + 999), useSecondaryLanguage: 'false' });
  const data = await call(cfg, `/hotel-content-api/1.0/hotels?${qs}`, {}, fetcher);
  if (!Array.isArray(data?.hotels)) throw new Error('SUPPLIER_INVALID_RESPONSE');
  return { total: num(data.total), from: start, hotels: data.hotels.map(h => ({ code: String(h.code), name: content(h.name), address: [content(h.address), h.postalCode, content(h.city)].filter(Boolean).join(', '), rating: h.categoryCode ?? null })) };
}

export async function hotelbedsDetails(hotelCode, cfg, fetcher = fetch) {
  if (!/^\d{1,10}$/.test(String(hotelCode))) throw new Error('CRITERIA_INVALID');
  const data = await call(cfg, `/hotel-content-api/1.0/hotels/${hotelCode}/details?language=ENG&useSecondaryLanguage=false`, {}, fetcher);
  const h = data?.hotel;
  if (!h) throw new Error('SUPPLIER_INVALID_RESPONSE');
  const safe = p => (typeof p === 'string' && /^[\w./-]+$/.test(p) && !p.includes('..') ? PHOTO_BASE + p.replace(/^\/+/, '') : null);
  const images = (h.images ?? []).filter(i => safe(i.path)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const rooms = (h.rooms ?? []).map(r => ({ code: r.roomCode ?? null, description: content(r.description) ?? r.description ?? null, maxPax: num(r.maxPax), maxAdults: num(r.maxAdults) }));
  return {
    code: String(h.code ?? hotelCode), name: content(h.name),
    hotelImages: images.filter(i => !i.roomCode).slice(0, 10).map(i => safe(i.path)),
    roomImages: Object.fromEntries([...new Set(images.filter(i => i.roomCode).map(i => i.roomCode))].map(code => [code, images.filter(i => i.roomCode === code).slice(0, 8).map(i => safe(i.path))])),
    rooms,
  };
}

export function attachHotelbedsDetails(offers, details) {
  const roomsByCode = new Map((details?.rooms ?? []).map(r => [r.code, r]));
  return offers.map(o => ({ ...o, photos: details?.roomImages?.[o.roomCode] ?? [], roomInfo: roomsByCode.get(o.roomCode) ?? null }));
}

/** Commentaires de tarif (Content API) : à lire avant toute réservation ; chargés à la demande. */
export async function hotelbedsRateComments(code, date, cfg, fetcher = fetch) {
  if (!/^[\d|]{1,60}$/.test(String(code)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('CRITERIA_INVALID');
  const qs = new URLSearchParams({ date, code, language: 'ENG', useSecondaryLanguage: 'true' });
  const data = await call(cfg, `/hotel-content-api/1.0/types/ratecommentdetails?${qs}`, {}, fetcher);
  if (!Array.isArray(data?.rateComments)) throw new Error('SUPPLIER_INVALID_RESPONSE');
  return data.rateComments.map(c => ({ dateStart: c.dateStart ?? null, dateEnd: c.dateEnd ?? null, description: typeof c.description === 'string' ? c.description.slice(0, 2000) : null })).filter(c => c.description);
}
