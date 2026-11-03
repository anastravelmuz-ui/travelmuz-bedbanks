import { mealCodeFromText } from '../public/meal-core.mjs';
// Codes d'erreur de critères exposables au navigateur (aucune donnée fournisseur).
export const CRITERIA_ERRORS = ['CRITERIA_INVALID', 'ROOMS_INVALID', 'ADULTS_INVALID', 'CHILDREN_INVALID', 'CHILD_AGE_INVALID', 'CHILD_AGE_OVER_12'];
const fail = code => { throw new Error(code); };
/**
 * Critères : hôtel, dates, pays du client et chambres [{adults, children:[âges à la date de départ]}].
 * Halalbooking : un « groupe » par chambre, enfants de 0 à 12 ans ; au-delà, l'agent les compte comme adultes (pas de conversion silencieuse).
 * Rétrocompatible : { adults } seul = une chambre d'adultes.
 */
export function validateSearch(input, now = new Date()) {
  if (!input || typeof input !== 'object') fail('CRITERIA_INVALID');
  const { hotelId, checkin, checkout, country } = input;
  const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  if (!Number.isSafeInteger(hotelId) || hotelId < 1 || !date(checkin) || !date(checkout) || checkin <= now.toISOString().slice(0, 10) || checkout <= checkin || (Date.parse(checkout) - Date.parse(checkin)) / 86400000 > 30 || typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) fail('CRITERIA_INVALID');
  const rawRooms = input.rooms === undefined && input.adults !== undefined ? [{ adults: input.adults, children: [] }] : input.rooms;
  if (!Array.isArray(rawRooms) || rawRooms.length < 1 || rawRooms.length > 4) fail('ROOMS_INVALID');
  const rooms = rawRooms.map(r => {
    if (!r || typeof r !== 'object' || !Number.isInteger(r.adults) || r.adults < 1 || r.adults > 6) fail('ADULTS_INVALID');
    const children = r.children ?? [];
    if (!Array.isArray(children) || children.length > 4) fail('CHILDREN_INVALID');
    for (const a of children) {
      if (!Number.isInteger(a) || a < 0) fail('CHILD_AGE_INVALID');
      if (a > 12) fail('CHILD_AGE_OVER_12');
    }
    return { adults: r.adults, children: [...children] };
  });
  return { hotelId, checkin, checkout, rooms, country };
}
/** Photos de chambre : URL HTTPS uniquement, 8 au maximum (documentation : utilisation autorisée). */
export function safePhotos(list) {
  return (Array.isArray(list) ? list : []).filter(u => typeof u === 'string' && u.length < 2048 && /^https:\/\/[^\s"'<>]+$/.test(u)).slice(0, 8);
}
export const groupOf = room => [room.adults, ...room.children].join(',');

/** Commission Halalbooking : nombre ou texte à virgule décimale (« 20,720 »). Retourne un pourcentage ou null. */
export function parseCommission(value) {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,2}(?:[.,]\d{1,4})?$/.test(raw)) return null;
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n < 100 ? n : null;
}
/** D-017 : net agence ESTIMÉ = prix × (1 − commission du tarif), concordant avec le portail le 2/11/2026, à reconfirmer. */
export function netEstimate(price, commission) {
  const rate = parseCommission(commission);
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || rate === null) return { commissionRate: rate, netEstimate: null, netBasis: 'not_computable' };
  return { commissionRate: rate, netEstimate: Math.round(price * (100 - rate)) / 100, netBasis: 'estimate_price_minus_rate_commission' };
}
/**
 * Net agence : Halalbooking fournit affiliate_net_price et affiliate_commission_amount depuis le 30/10/2026
 * (documentation API v2.6 : « utiliser les montants retournés plutôt que les recalculer »). Hors frais payables sur place.
 * Repli uniquement si absents : estimation prix × (1 − commission), signalée comme telle (D-017).
 */
export function agencyNet(rate) {
  const fromSupplier = typeof rate?.affiliate_net_price === 'number' && Number.isFinite(rate.affiliate_net_price) && rate.affiliate_net_price > 0;
  const est = netEstimate(rate?.price, rate?.affiliate_commission_percentage);
  if (fromSupplier) return { netPrice: rate.affiliate_net_price, netSource: 'supplier', commissionAmount: typeof rate.affiliate_commission_amount === 'number' ? rate.affiliate_commission_amount : null, commissionRate: est.commissionRate };
  if (typeof est.netEstimate === 'number') return { netPrice: est.netEstimate, netSource: 'estimate', commissionAmount: null, commissionRate: est.commissionRate };
  return { netPrice: null, netSource: null, commissionAmount: null, commissionRate: est.commissionRate };
}
export async function searchHalalbooking(input, credentials, fetcher = fetch) {
  const q=validateSearch(input);
  if (!credentials.partner || !credentials.secret) throw new Error('CONFIGURATION_MISSING');
  const url=new URL('https://halalbooking.com/api/v2/fr/places');
  const params=new URLSearchParams({currency:'EUR',checkin:q.checkin,checkout:q.checkout,holiday_type:'hotel','place_ids[]':String(q.hotelId),customer_country_code:q.country});
  for (const room of q.rooms) params.append('groups[]', groupOf(room));
  url.search=params.toString();
  let response;
  try { response=await fetcher(url,{headers:{Accept:'application/json',Authorization:'Basic '+btoa(credentials.partner+':'+credentials.secret)},redirect:'manual',signal:AbortSignal.timeout(25000)}); } catch { throw new Error('SUPPLIER_UNREACHABLE'); }
  if (!response.ok) throw new Error(response.status===401 || response.status===403 ? 'SUPPLIER_AUTH_FAILED' : 'SUPPLIER_ERROR');
  let data; try {data=await response.json()} catch {throw new Error('SUPPLIER_INVALID_RESPONSE')}
  if (!Array.isArray(data.offers) || data.currency!=='EUR') throw new Error('SUPPLIER_INVALID_RESPONSE');
  const offers=[];
  for(const hotel of data.offers) (hotel.groups??[]).forEach((group,roomIndex)=>{ for(const room of group.offers??[]) for(const rate of room.rate_plans??[]) {
    const plan=rate.rate_plan??{};
    offers.push({hotelId:hotel.place?.id,hotel:hotel.place?.name,roomIndex,group:group.group??null,requestedGroup:q.rooms[roomIndex]?groupOf(q.rooms[roomIndex]):null,
      roomId:room.room?.id,room:room.room?.name,description:room.room?.long_description??null,photos:safePhotos(room.room?.photos),confirmation:room.confirmation??null,
      quantity:rate.quantity??null,price:rate.price??null,currency:data.currency,priceBasis:'public_price_total_group',
      commissionPercent:rate.affiliate_commission_percentage??null,...agencyNet(rate),
      meal:plan.meal_plan_name??null,mealCode:mealCodeFromText(plan.meal_plan_name),inclusions:Array.isArray(plan.inclusions)?plan.inclusions.filter(x=>typeof x==='string'):[],cancellation:plan.cancellation_policy??null});
  }});
  return {provider:'Halalbooking',observedAt:new Date().toISOString(),criteria:q,scope:'one_hotel_rooms_children',offers,notice:'Prix de recherche, à reconfirmer (cache fournisseur jusqu’à 5 min ; commission susceptible d’évoluer à la vérification). Net agence fourni par Halalbooking, hors frais payables sur place. Aucun rapprochement automatique de chambres.'};
}
