export function validateSearch(input, now = new Date()) {
  if (!input || typeof input !== 'object') throw new Error('Critères requis');
  const {hotelId, checkin, checkout, adults, country} = input;
  const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
  if (!Number.isSafeInteger(hotelId) || hotelId < 1 || !date(checkin) || !date(checkout) || checkin <= now.toISOString().slice(0,10) || checkout <= checkin || (Date.parse(checkout)-Date.parse(checkin))/86400000 > 30 || !Number.isInteger(adults) || adults < 1 || adults > 6 || !/^[A-Z]{2}$/.test(country)) throw new Error('Hôtel, dates futures (30 nuits maximum), adultes (1 à 6) et pays ISO requis');
  return {hotelId,checkin,checkout,adults,country};
}
export async function searchHalalbooking(input, credentials, fetcher = fetch) {
  const q=validateSearch(input);
  if (!credentials.partner || !credentials.secret) throw new Error('CONFIGURATION_MISSING');
  const url=new URL('https://halalbooking.com/api/v2/fr/places');
  url.search=new URLSearchParams({currency:'EUR',checkin:q.checkin,checkout:q.checkout,'groups[]':String(q.adults),holiday_type:'hotel','place_ids[]':String(q.hotelId),customer_country_code:q.country}).toString();
  let response;
  try { response=await fetcher(url,{headers:{Accept:'application/json',Authorization:'Basic '+btoa(credentials.partner+':'+credentials.secret)},redirect:'manual',signal:AbortSignal.timeout(25000)}); } catch { throw new Error('SUPPLIER_UNREACHABLE'); }
  if (!response.ok) throw new Error(response.status===401 || response.status===403 ? 'SUPPLIER_AUTH_FAILED' : 'SUPPLIER_ERROR');
  let data; try {data=await response.json()} catch {throw new Error('SUPPLIER_INVALID_RESPONSE')}
  if (!Array.isArray(data.offers) || data.currency!=='EUR') throw new Error('SUPPLIER_INVALID_RESPONSE');
  const offers=[];
  for(const hotel of data.offers) for(const group of hotel.groups??[]) for(const room of group.offers??[]) for(const rate of room.rate_plans??[]) {
    offers.push({hotelId:hotel.place?.id,hotel:hotel.place?.name,roomId:room.room?.id,room:room.room?.name,description:room.room?.long_description??null,quantity:rate.quantity??null,price:rate.price??null,currency:data.currency,priceBasis:'supplier_price_not_verified_as_net',commissionPercent:rate.affiliate_commission_percentage??null,meal:rate.rate_plan?.meal_plan_name??null,cancellation:rate.rate_plan?.cancellation_policy??null});
  }
  return {provider:'Halalbooking',observedAt:new Date().toISOString(),criteria:q,scope:'one_room_adults_only',offers,notice:'Prix fournisseur à reconfirmer. Net agence et frais non qualifiés. Aucun rapprochement automatique de chambres.'};
}
