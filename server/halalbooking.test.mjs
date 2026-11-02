import test from 'node:test';import assert from 'node:assert/strict';import {validateSearch,searchHalalbooking} from './halalbooking.mjs';
const q={hotelId:4,checkin:'2027-03-04',checkout:'2027-03-07',adults:2,country:'FR'};
test('invalid criteria rejected before supplier request',()=>{for(const p of [{adults:0},{hotelId:'4'},{checkout:'2027-02-30'},{country:''},{checkin:'2020-01-01'},{checkout:'2027-05-01'}])assert.throws(()=>validateSearch({...q,...p},new Date('2026-10-31')))});
test('fixed HTTPS destination, no redirect, preserve absent conditions and net uncertainty',async()=>{const r=await searchHalalbooking(q,{partner:'test',secret:'test'},async(url,init)=>{assert.equal(url.origin,'https://halalbooking.com');assert.equal(url.searchParams.get('groups[]'),'2');assert.equal(init.redirect,'manual');return Response.json({currency:'EUR',offers:[{place:{id:4,name:'Hotel'},groups:[{offers:[{room:{id:1,name:'Standard'},rate_plans:[{price:292.5,rate_plan:{meal_plan_name:'BB'}}]}]}]}]})});assert.equal(r.offers[0].price,292.5);assert.equal(r.offers[0].cancellation,null);assert.equal(r.offers[0].netPrice,null);assert.equal(r.offers[0].netSource,null)});
test('supplier authentication error never becomes empty offers',async()=>{await assert.rejects(()=>searchHalalbooking(q,{partner:'test',secret:'test'},async()=>new Response('secret echo',{status:401})),/SUPPLIER_AUTH_FAILED/)});

test('redirects rejected without forwarding secret',async()=>{await assert.rejects(()=>searchHalalbooking(q,{partner:'test',secret:'test'},async()=>new Response(null,{status:302,headers:{Location:'https://example.com'}})),/SUPPLIER_ERROR/)});

import { parseCommission, netEstimate } from './halalbooking.mjs';
test('D-017 : commission texte et net estimé, concordants avec le portail', () => {
  assert.equal(parseCommission('20,720'), 20.72); assert.equal(parseCommission('14,000'), 14); assert.equal(parseCommission(14), 14);
  for (const bad of [null, '', 'abc', '0', '100', '-5', '12,5%']) assert.equal(parseCommission(bad), null, String(bad));
  // Nets lus au portail le 30/10/2026 (arrondis à l'euro inférieur) : 251, 283, 380.
  assert.equal(Math.floor(netEstimate(292.5, '14,000').netEstimate), 251);
  assert.equal(Math.floor(netEstimate(330, '14,000').netEstimate), 283);
  assert.equal(Math.floor(netEstimate(480, '20,720').netEstimate), 380);
  assert.equal(netEstimate(480, '20,720').netEstimate, 380.54);
  assert.deepEqual(netEstimate(null, '14,000'), { commissionRate: 14, netEstimate: null, netBasis: 'not_computable' });
  assert.equal(netEstimate(300, null).netEstimate, null);
});

import { validateSearch as vs, agencyNet } from './halalbooking.mjs';
const base={hotelId:4,checkin:'2027-03-04',checkout:'2027-03-07',country:'FR'};
const NOW=new Date('2026-11-02');
test('chambres et enfants : validation sans conversion silencieuse', () => {
  assert.deepEqual(vs({...base,adults:2},NOW).rooms,[{adults:2,children:[]}]);
  assert.deepEqual(vs({...base,rooms:[{adults:2,children:[5,0]},{adults:1}]},NOW).rooms,[{adults:2,children:[5,0]},{adults:1,children:[]}]);
  const code = input => { try { vs({...base,...input},NOW); return 'ok'; } catch (e) { return e.message; } };
  assert.equal(code({rooms:[]}),'ROOMS_INVALID');
  assert.equal(code({rooms:Array(5).fill({adults:1})}),'ROOMS_INVALID');
  assert.equal(code({rooms:[{adults:0}]}),'ADULTS_INVALID');
  assert.equal(code({rooms:[{adults:2,children:[13]}]}),'CHILD_AGE_OVER_12');
  assert.equal(code({rooms:[{adults:2,children:[NaN]}]}),'CHILD_AGE_INVALID');
  assert.equal(code({rooms:[{adults:2,children:[1,2,3,4,5]}]}),'CHILDREN_INVALID');
});
test('requête : un groupe par chambre, âges inclus ; offres rattachées à leur chambre', async () => {
  const q2={...base,rooms:[{adults:2,children:[5,10]},{adults:2}]};
  const r=await searchHalalbooking(q2,{partner:'p',secret:'s'},async url=>{
    assert.deepEqual(url.searchParams.getAll('groups[]'),['2,5,10','2']);
    return Response.json({currency:'EUR',offers:[{place:{id:4,name:'H'},groups:[
      {group:'2,5,10',offers:[{room:{id:7,name:'Familiale'},rate_plans:[{price:864,affiliate_net_price:684.98,affiliate_commission_amount:179.02,affiliate_commission_percentage:'20.720',quantity:1,rate_plan:{meal_plan_name:'BB',inclusions:['Petit déjeuner pour 4']}}]}]},
      {group:'2',offers:[{room:{id:9,name:'Standard'},rate_plans:[{price:292.5,affiliate_commission_percentage:'14,000',quantity:1,rate_plan:{meal_plan_name:'BB'}}]}]}]}]});
  }, );
  assert.equal(r.offers.length,2);
  assert.deepEqual([r.offers[0].roomIndex,r.offers[0].group,r.offers[0].requestedGroup],[0,'2,5,10','2,5,10']);
  assert.deepEqual([r.offers[0].netPrice,r.offers[0].netSource,r.offers[0].commissionAmount],[684.98,'supplier',179.02]);
  assert.deepEqual(r.offers[0].inclusions,['Petit déjeuner pour 4']);
  assert.deepEqual([r.offers[1].roomIndex,r.offers[1].netPrice,r.offers[1].netSource],[1,251.55,'estimate']);
});
test('net : jamais calculé sans donnée exploitable', () => {
  assert.equal(agencyNet({price:300}).netPrice,null);
  assert.equal(agencyNet({price:300,affiliate_net_price:-1}).netSource,null);
  assert.equal(agencyNet({price:300,affiliate_net_price:250}).netSource,'supplier');
});
