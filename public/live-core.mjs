export function cancellationState(rules, now=Date.now()) {
  if (!Array.isArray(rules)||!rules.length) return 'unknown';
  const offsets=/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if(rules.some(r=>typeof r.penalty!=='number'||!Number.isFinite(r.penalty)||r.penalty<0||r.penalty>100||r.until&&(!offsets.test(r.until)||!Number.isFinite(Date.parse(r.until)))))return 'unknown';
  const current=rules.find(r=>!r.until||now<Date.parse(r.until));
  if(!current)return 'unknown';
  return current.penalty===0?'free':current.penalty===100&&!current.nights?'nonref':'fees';
}
export function filterOffers(offers,f,now=Date.now()) {
  return offers.filter(o=>(!f.meal||o.meal===f.meal)&&(!f.room||String(o.roomId)===f.room)&&(!f.refund||cancellationState(o.cancellation,now)===f.refund)&&(f.budget===''||f.budget==null||(typeof o.price==='number'&&o.price<=Number(f.budget))))
    .sort((a,b)=>{const av=typeof a.price==='number'?a.price:null,bv=typeof b.price==='number'?b.price:null;if(av===null)return bv===null?0:1;if(bv===null)return -1;return f.sort==='desc'?bv-av:av-bv});
}
export function cutoffLabel(iso) {
 const m=typeof iso==='string'&&iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}):\d{2}(Z|[+-]\d{2}:\d{2})$/);
 return m?`${m[3]}/${m[2]}/${m[1]} à ${m[4]} (UTC${m[5]==='Z'?'+00:00':m[5]})`:String(iso??'Échéance non renseignée');
}
