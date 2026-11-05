// RateHawk / ETG API v3 (B2B) — consultation seule : multicomplete, hotel/info, search/serp/hotels puis search/hp.
// Aucun appel prebook / booking (D-001, flux « search-only » décrit à ETG le 4/11/2026).
// Demande ETG (5/11/2026) : SERP d'abord, /search/hp/ seulement si l'hôtel est disponible (RPM limité).
export const RATEHAWK_SANDBOX_URL = 'https://api-sandbox.ratehawk.com/api/b2b/v3';
export const RATEHAWK_ERRORS = ['CONFIGURATION_MISSING', 'SUPPLIER_AUTH_FAILED', 'SUPPLIER_UNREACHABLE', 'SUPPLIER_INVALID_RESPONSE', 'QUOTA_EXCEEDED', 'INSECURE_ENDPOINT', 'SUPPLIER_ERROR'];
const UA = 'TravelMuz/1.0 (internal bedbank comparator)'; // ETG demande un User-Agent PartnerName/ClientVersion

export function ratehawkConfig(env) {
  if (!env.RATEHAWK_KEY_ID || !env.RATEHAWK_API_KEY) return null;
  const base = (env.RATEHAWK_BASE_URL || RATEHAWK_SANDBOX_URL).replace(/\/+$/, '');
  return { base, keyId: String(env.RATEHAWK_KEY_ID), key: String(env.RATEHAWK_API_KEY), environment: /sandbox/.test(base) ? 'sandbox' : 'production' };
}

async function call(cfg, path, body, fetcher = fetch) {
  if (!/^https:\/\//.test(cfg.base)) throw new Error('INSECURE_ENDPOINT'); // identifiants jamais envoyés hors HTTPS
  let r;
  try {
    r = await fetcher(cfg.base + path, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA, Authorization: 'Basic ' + btoa(cfg.keyId + ':' + cfg.key) }, body: JSON.stringify(body) });
  } catch { throw new Error('SUPPLIER_UNREACHABLE'); }
  if (r.status === 401 || r.status === 403) throw new Error('SUPPLIER_AUTH_FAILED');
  if (r.status === 429) throw new Error('QUOTA_EXCEEDED');
  let d; try { d = await r.json(); } catch { throw new Error(r.ok ? 'SUPPLIER_INVALID_RESPONSE' : 'SUPPLIER_ERROR'); }
  if (d?.error === 'overlimit' || d?.debug?.api_endpoint?.is_limited && d?.debug?.api_endpoint?.remaining === 0 && !r.ok) throw new Error('QUOTA_EXCEEDED');
  if (!r.ok || (d?.status && d.status !== 'ok')) { const e = new Error('SUPPLIER_ERROR'); e.detail = typeof d?.error === 'string' ? d.error.slice(0, 80) : null; throw e; }
  return d.data ?? {};
}

/** Suggestions d'hôtels par nom (5 au plus). */
export async function ratehawkSuggest(query, cfg, fetcher = fetch) {
  const q = String(query ?? '').trim().slice(0, 100);
  if (q.length < 2) throw new Error('CRITERIA_INVALID');
  const d = await call(cfg, '/search/multicomplete/', { query: q, language: 'en' }, fetcher);
  return (d.hotels ?? []).filter(h => Number.isSafeInteger(h.hid) || typeof h.id === 'string').map(h => ({ hid: h.hid ?? null, id: typeof h.id === 'string' ? h.id : null, name: h.name ?? null, regionId: h.region_id ?? null }));
}

/** Fiche hôtel (nom, adresse, GPS, photos, groupes de chambres). Le bac à sable n'accepte que l'id texte. */
export async function ratehawkHotelInfo(ref, cfg, fetcher = fetch) {
  const body = cfg.environment === 'sandbox' && ref.id ? { id: ref.id, language: 'en' } : ref.hid ? { hid: ref.hid, language: 'en' } : { id: ref.id, language: 'en' };
  const h = await call(cfg, '/hotel/info/', body, fetcher);
  const img = u => typeof u === 'string' && /^https:\/\//.test(u) ? u.replace('{size}', '640x400') : null;
  return {
    hid: h.hid ?? ref.hid ?? null, id: h.id ?? ref.id ?? null, name: h.name ?? null, address: h.address ?? null,
    lat: typeof h.latitude === 'number' ? h.latitude : null, lng: typeof h.longitude === 'number' ? h.longitude : null,
    city: h.region?.name ?? null, country: h.region?.country_code ?? null, stars: h.star_rating || null,
    images: (h.images_ext ?? []).map(i => img(i.url)).filter(Boolean).slice(0, 6),
    rooms: (h.room_groups ?? []).map(g => ({ name: g.name ?? null, rgExt: g.rg_ext ?? null, images: (g.images_ext ?? []).map(i => img(i.url)).filter(Boolean).slice(0, 4) })),
  };
}

export function mealCodeFromEtg(value) {
  const v = String(value ?? '').toLowerCase();
  if (/all-inclusive|all inclusive/.test(v)) return 'AI';
  if (/full-board|full board/.test(v)) return 'FB';
  if (/half-board|half board/.test(v)) return 'HB';
  if (/breakfast/.test(v)) return 'BB';
  if (/nomeal|room-only|no meal/.test(v)) return 'RO';
  return null;
}
const num = v => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null; };
/** Dates ETG sans fuseau = UTC selon la documentation. */
const utc = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s) ? s + (s.length === 16 ? ':00' : '') + 'Z' : typeof s === 'string' && /Z|[+-]\d{2}:\d{2}$/.test(s) ? s : null;

/** Tarif ETG → offre comparable (montants dans la devise demandée, net agence = commission_info.show.amount_net). */
export function mapRate(rate) {
  const types = rate?.payment_options?.payment_types ?? [];
  const pay = types.find(t => t.type === 'now') ?? types[0];
  if (!pay) return null;
  const show = pay.commission_info?.show ?? {};
  const net = num(show.amount_net) ?? num(pay.show_amount);
  const taxes = (pay.tax_data?.taxes ?? []).map(t => ({ name: t.name ?? null, amount: num(t.amount), currency: t.currency_code ?? null, included: t.included_by_supplier === true }));
  const pen = rate.cancellation_penalties ?? {};
  return {
    roomName: rate.room_name ?? null, mealCode: mealCodeFromEtg(rate.meal_data?.value ?? rate.meal), meal: rate.meal_data?.value ?? rate.meal ?? null,
    hasBreakfast: rate.meal_data?.has_breakfast ?? null,
    net, gross: num(show.amount_gross), currency: pay.show_currency_code ?? pay.currency_code ?? null,
    paymentType: pay.type ?? null, netFromSupplier: num(show.amount_net) != null,
    taxesAtHotel: taxes.filter(t => !t.included && t.amount != null),
    freeCancellationBefore: pen.free_cancellation_before == null ? null : utc(pen.free_cancellation_before),
    cancellation: (pen.policies ?? []).map(p => ({ start: utc(p.start_at), end: utc(p.end_at), amount: num(p.amount_show) })),
    allotment: num(rate.allotment), rgExt: rate.rg_ext ?? null,
  };
}

/** Recherche pour un hôtel associé : SERP (1 hid) puis page hôtel seulement si disponible. */
export async function searchRatehawk(q, hid, nationality, cfg, fetcher = fetch, { allowNonEur = false } = {}) {
  if (!Number.isSafeInteger(Number(hid))) throw new Error('CRITERIA_INVALID');
  const base = { checkin: q.checkin, checkout: q.checkout, residency: String(nationality).toLowerCase(), language: 'en', currency: 'EUR', guests: q.rooms.map(r => ({ adults: r.adults, children: [...r.children] })) };
  const serp = await call(cfg, '/search/serp/hotels/', { ...base, hids: [Number(hid)] }, fetcher);
  const environment = cfg.environment;
  if (!(serp.hotels ?? []).length) return { provider: 'RateHawk', status: 'no_availability', offers: [], environment };
  const hp = await call(cfg, '/search/hp/', { ...base, hid: Number(hid) }, fetcher);
  const rates = (hp.hotels ?? []).flatMap(h => h.rates ?? []);
  const offers = rates.map(mapRate).filter(o => o && o.net != null);
  if (!offers.length) return { provider: 'RateHawk', status: 'no_availability', offers: [], environment };
  const foreign = offers.filter(o => o.currency !== 'EUR');
  if (foreign.length && !allowNonEur) return { provider: 'RateHawk', status: 'currency_not_eur', currency: foreign[0].currency, hidden: foreign.length, offers: offers.filter(o => o.currency === 'EUR'), environment };
  return { provider: 'RateHawk', status: 'ok', offers, environment, currencyWarning: foreign[0]?.currency ?? null };
}
