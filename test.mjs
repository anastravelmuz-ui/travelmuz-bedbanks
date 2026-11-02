import assert from 'node:assert/strict';
import {nights,validateSearch,demoOffers,filterOffers,compareGroup,recordState,validateRecord,csv} from './public/core.mjs';
const s={hotel:'golden',checkin:'2027-03-04',checkout:'2027-03-06',rooms:[{adults:2,children:[]}]};
assert.equal(nights(s.checkin,s.checkout),2);assert.ok(Number.isNaN(nights('2027-02-30','2027-03-04')));assert.ok(validateSearch({...s,checkout:s.checkin}));assert.ok(validateSearch({...s,rooms:[{adults:0,children:[]}]}));assert.ok(validateSearch({...s,rooms:[{adults:2,children:[NaN]}]}));
const all=demoOffers(s),filtered=filterOffers(all,{meal:'BB',refund:'free',category:'standard',budget:'',sort:'asc'});assert.equal(filtered.length,4);assert.equal(filtered[0].provider,'tbo');assert.equal(compareGroup(filtered).comparable,true);assert.equal(compareGroup(all).comparable,false);assert.equal(filterOffers(all,{meal:'BB',refund:'free',category:'standard',budget:1,sort:'asc'}).length,0);assert.equal(compareGroup([]).lowest,null);
assert.equal(demoOffers({...s,rooms:[...s.rooms,...s.rooms]})[0].total,all[0].total*2);assert.equal(recordState({deadline:'2027-03-01T18:00:00+03:00'},Date.parse('2027-03-01T15:00:00Z')),'expired');assert.equal(recordState({deadline:''}),'incomplete');assert.ok(validateRecord({reference:'x',hotel:'x',checkin:s.checkin,checkout:s.checkout,price:1,currency:'EUR',deadline:'2027-03-01T18:00:00'}));assert.ok(csv([['=HYPERLINK("x")']]).includes("'=HYPERLINK"));console.log('15 assertions métier réussies.');

assert.ok(validateRecord(null));assert.ok(validateRecord({reference:123,hotel:"x"}));
