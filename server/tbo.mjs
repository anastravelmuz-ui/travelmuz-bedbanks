import { mealCodeFromTbo } from '../public/meal-core.mjs';
// Connecteur TBO Holidays (API Hotel REST/JSON, authentification Basic).
// Documentation : https://apidoc.tektravels.com/hotelnew/ (lue le 2 novembre 2026).
// Consultation seule : aucune méthode PreBook/Book/Cancel n'est implémentée.

export const TBO_ERRORS = ['CONFIGURATION_MISSING', 'INSECURE_ENDPOINT', 'SUPPLIER_AUTH_FAILED', 'SUPPLIER_UNREACHABLE', 'SUPPLIER_INVALID_RESPONSE', 'SUPPLIER_ERROR'];
const MAX_CHILD_AGE = 17; // TBO : enfants 0–18 ans selon la documentation ; 18 ans compté comme adulte par prudence.

// Adresse staging TBO (D-013, HTTPS vérifié le 2/11/2026) ; la production la remplacera via TBO_BASE_URL.
export const TBO_STAGING_URL = 'https://api.tbotechnology.in/TBOHolidays_HotelAPI';

/** Configuration serveur : URL HTTPS obligatoire, identifiants en secrets Cloudflare. */
export function tboConfig(env) {
  const base = String(env?.TBO_BASE_URL || TBO_STAGING_URL).replace(/\/+$/, '');
  const search = String(env?.TBO_SEARCH_URL ?? '').replace(/\/+$/, '') || base;
  if (!env?.TBO_USERNAME || !env?.TBO_PASSWORD || !base) return null;
  return { base, search, username: env.TBO_USERNAME, password: env.TBO_PASSWORD };
}

async function post(url, body, cfg, fetcher, timeoutMs) {
  let target;
  try { target = new URL(url); } catch { throw new Error('CONFIGURATION_MISSING'); }
  if (target.protocol !== 'https:') throw new Error('INSECURE_ENDPOINT'); // jamais d'identifiants en clair
  let response;
  try {
    response = await fetcher(target, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(cfg.username + ':' + cfg.password) },
      body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch { throw new Error('SUPPLIER_UNREACHABLE'); }
  if (response.status === 401 || response.status === 403) throw new Error('SUPPLIER_AUTH_FAILED');
  if (!response.ok) throw new Error('SUPPLIER_ERROR');
  let data;
  try { data = await response.json(); } catch { throw new Error('SUPPLIER_INVALID_RESPONSE'); }
  const code = data?.Status?.Code;
  if (code === 401) throw new Error('SUPPLIER_AUTH_FAILED');
  return data;
}

// ---- Données statiques (correspondance des hôtels) ----
export async function tboCities(countryCode, cfg, fetcher = fetch) {
  if (!/^[A-Z]{2}$/.test(String(countryCode))) throw new Error('CRITERIA_INVALID');
  const data = await post(cfg.base + '/CityList', { CountryCode: countryCode }, cfg, fetcher, 20000);
  if (data?.Status?.Code !== 200 || !Array.isArray(data.CityList)) throw new Error('SUPPLIER_INVALID_RESPONSE');
  return data.CityList.filter(c => c && c.Code != null && c.Name).map(c => ({ code: String(c.Code), name: String(c.Name) }));
}
export async function tboHotels(cityCode, cfg, fetcher = fetch) {
  if (!/^\d{1,12}$/.test(String(cityCode))) throw new Error('CRITERIA_INVALID');
  const data = await post(cfg.base + '/TBOHotelCodeList', { CityCode: String(cityCode), IsDetailedResponse: 'true' } /* format texte, comme les exemples TBO */, cfg, fetcher, 25000);
  if (data?.Status?.Code !== 200 || !Array.isArray(data.Hotels)) {
    const e = new Error('SUPPLIER_INVALID_RESPONSE');
    // Diagnostic administrateur : statut fournisseur et clés reçues, sans contenu.
    e.supplierStatus = { code: data?.Status?.Code ?? null, description: String(data?.Status?.Description ?? '').slice(0, 200), keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 10) : [] };
    throw e;
  }
  return data.Hotels.filter(h => h && h.HotelCode != null).map(h => ({
    code: String(h.HotelCode), name: h.HotelName ?? null, rating: h.HotelRating ?? null, address: h.Address ?? null,
    city: h.CityName ?? null, country: h.CountryCode ?? null, latitude: h.Latitude ?? null, longitude: h.Longitude ?? null,
  }));
}

// ---- Annulation : logique partagée avec le navigateur ----
export { parseTboDate, tboCancellationState } from '../public/tbo-core.mjs';

const MEALS = { Room_Only: 'Chambre seule', BreakFast: 'Petit déjeuner', Breakfast: 'Petit déjeuner', Breakfast_For_1: 'Petit déjeuner (1 pers.)', Breakfast_For_2: 'Petit déjeuner (2 pers.)', Half_Board: 'Demi-pension', Full_Board: 'Pension complète', All_Inclusive_All_Meal: 'Tout inclus' };
export const mealLabel = v => (v == null ? null : MEALS[v] ?? String(v).replace(/_/g, ' '));

/** Recherche TBO : critères déjà validés par validateSearch (Halalbooking) + code hôtel TBO + nationalité. */
export function tboSearchBody(q, hotelCode, nationality) {
  if (!/^\d{1,12}$/.test(String(hotelCode))) throw new Error('CRITERIA_INVALID');
  if (!/^[A-Z]{2}$/.test(String(nationality))) throw new Error('NATIONALITY_INVALID');
  for (const r of q.rooms) if (r.children.some(a => a > MAX_CHILD_AGE)) throw new Error('CHILD_AGE_INVALID');
  return {
    CheckIn: q.checkin, CheckOut: q.checkout, HotelCodes: String(hotelCode), GuestNationality: nationality,
    PaxRooms: q.rooms.map(r => ({ Adults: r.adults, Children: r.children.length, ChildrenAges: r.children.length ? r.children : null })),
    ResponseTime: 20, IsDetailedResponse: true,
    Filters: { Refundable: false, NoOfRooms: 0, MealType: 'All' },
  };
}

export async function searchTbo(q, hotelCode, nationality, cfg, fetcher = fetch, { allowNonEur = false } = {}) {
  if (!cfg) throw new Error('CONFIGURATION_MISSING');
  const body = tboSearchBody(q, hotelCode, nationality);
  const data = await post(cfg.search + '/Search', body, cfg, fetcher, 25000);
  const code = data?.Status?.Code;
  const observedAt = new Date().toISOString();
  const base = { provider: 'TBO', observedAt, hotelCode: String(hotelCode), nationality, rooms: q.rooms.length };
  // TBO renvoie un code non-200 quand aucune chambre n'est disponible : absence d'offre ≠ panne.
  if (code !== 200) {
    if (code === 201 || /no (available )?(hotel|room)s?|not available/i.test(String(data?.Status?.Description ?? ''))) return { ...base, status: 'no_availability', offers: [] };
    throw new Error('SUPPLIER_ERROR');
  }
  if (!Array.isArray(data.HotelResult)) throw new Error('SUPPLIER_INVALID_RESPONSE');
  const offers = [];
  for (const hotel of data.HotelResult) for (const room of hotel.Rooms ?? []) {
    const supplements = (room.Supplements ?? []).flat().filter(Boolean).map(s => ({ roomIndex: s.Index ?? null, type: s.Type ?? null, description: s.Description ?? null, price: typeof s.Price === 'number' ? s.Price : null, currency: s.Currency ?? null }));
    offers.push({
      provider: 'TBO', hotelCode: String(hotel.HotelCode ?? hotelCode), currency: hotel.Currency ?? null,
      roomNames: Array.isArray(room.Name) ? room.Name.map(String) : [],
      roomIds: (Array.isArray(room.RoomID) ? room.RoomID : room.RoomID != null ? [room.RoomID] : []).map(String),
      meal: mealLabel(room.MealType), mealCode: mealCodeFromTbo(room.MealType), supplierMealType: room.MealType ?? null, inclusion: room.Inclusion ?? null,
      price: typeof room.TotalFare === 'number' ? room.TotalFare : null, // total de l'unité réservable, toutes chambres
      tax: typeof room.TotalTax === 'number' ? room.TotalTax : null,
      priceBasis: 'tbo_totalfare_all_rooms_nature_to_confirm',
      recommendedSellingRate: room.RecommendedSellingRate != null && room.RecommendedSellingRate !== '' ? Number(room.RecommendedSellingRate) : null,
      isRefundable: typeof room.IsRefundable === 'boolean' ? room.IsRefundable : null,
      cancelPolicies: (room.CancelPolicies ?? []).map(p => ({ roomIndex: p.Index ?? null, from: p.FromDate ?? null, type: p.ChargeType ?? null, charge: typeof p.CancellationCharge === 'number' ? p.CancellationCharge : null })),
      timezoneKnown: false,
      supplementsAtProperty: supplements.filter(s => s.type === 'AtProperty'),
      supplementsIncluded: supplements.filter(s => s.type === 'Included'),
      promotions: Array.isArray(room.RoomPromotion) ? room.RoomPromotion.map(String) : [],
      withTransfers: room.WithTransfers === true,
    });
  }
  // Euro imposé (D-020) : TBO n'accepte pas de devise dans la requête (devise du compte). Aucune conversion silencieuse.
  const foreign = [...new Set(offers.map(o => o.currency).filter(c => c !== 'EUR'))];
  if (foreign.length && !allowNonEur) return { ...base, status: 'currency_not_eur', currency: foreign.join(', '), offers: [], hidden: offers.length };
  if (foreign.length) return { ...base, status: 'ok', currencyWarning: foreign.join(', '), offers };
  return { ...base, status: offers.length ? 'ok' : 'no_availability', offers };
}

/** HotelDetails (données statiques) : images d'hôtel et, si TBO les fournit, détails par chambre. */
const imgList = v => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).filter(u => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u.trim())).map(u => u.trim()).slice(0, 30);
export async function tboHotelDetails(hotelCode, cfg, fetcher = fetch) {
  if (!/^\d{1,12}$/.test(String(hotelCode))) throw new Error('CRITERIA_INVALID');
  const data = await post(cfg.base + '/Hoteldetails', { Hotelcodes: String(hotelCode), Language: 'EN', IsRoomDetailRequired: true }, cfg, fetcher, 25000);
  const h = Array.isArray(data?.HotelDetails) ? data.HotelDetails[0] : null;
  if (data?.Status?.Code !== 200 || !h) {
    const e = new Error('SUPPLIER_INVALID_RESPONSE');
    e.supplierStatus = { code: data?.Status?.Code ?? null, description: String(data?.Status?.Description ?? '').slice(0, 200), keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 10) : [] };
    throw e;
  }
  const roomsRaw = h.RoomDetails ?? h.Rooms ?? h.RoomDetail ?? null;
  const text = v => (typeof v === 'string' ? v.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600) : null);
  const rooms = (Array.isArray(roomsRaw) ? roomsRaw : []).map(r => ({
    id: r.RoomId ?? r.RoomID ?? r.Id ?? null, name: r.RoomName ?? r.Name ?? null,
    size: r.RoomSize != null && r.RoomSize !== '' ? String(r.RoomSize).slice(0, 60) : null, description: text(r.RoomDescription),
    images: imgList(r.Images ?? r.RoomImages ?? r.Image ?? r.imageURL).slice(0, 8),
  })).filter(r => r.id != null).map(r => ({ ...r, id: String(r.id) }));
  return {
    code: String(h.HotelCode ?? hotelCode), name: h.HotelName ?? null, hotelImages: imgList(h.Images), rooms,
    // Diagnostic : structure reçue, sans contenu
    structure: { hotelKeys: Object.keys(h).slice(0, 40), roomKeys: Array.isArray(roomsRaw) && roomsRaw[0] ? Object.keys(roomsRaw[0]).slice(0, 40) : [] },
  };
}

/** Enrichit les offres de recherche avec les fiches chambres (photos, superficie) par identifiant RoomID. */
export function attachRoomDetails(offers, details) {
  const byId = new Map((details?.rooms ?? []).map(r => [r.id, r]));
  return offers.map(o => {
    const found = (o.roomIds ?? []).map(id => byId.get(String(id)) ?? null);
    return { ...o, roomDetails: found.map(r => (r ? { name: r.name, size: r.size, description: r.description, images: r.images } : null)) };
  });
}
