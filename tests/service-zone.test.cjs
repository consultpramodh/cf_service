const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const s=fs.readFileSync('src/70_Workflow_Automation.gs','utf8');
const start=s.indexOf('CF.ServiceZone ='),end=s.indexOf('\n})();',start)+6;
const ctx={CF:{}};vm.runInNewContext(s.slice(start,end),ctx);const z=ctx.CF.ServiceZone;
function req(city){return {'City':city,'Province':'ONTARIO','Country':'Ca','Matched Customer ID':'1','Matched Location ID':'2'};}
for(const city of ['Whitby','  wHiTbY  ','Ajax','Pickering','Oshawa'])assert.equal(z.resolve(req(city)).id,'506');
assert.equal(z.resolve(req('Toronto')).id,'508');
for(const city of ['',null])assert.equal(z.resolve(req(city)).status,'REVIEW');
for(const city of ['Scarborough','North York','East York','Etobicoke','West Rouge'])assert.equal(z.resolve(req(city)).id,'508');
for(const city of ['Newmarket','Richmond Hill','Whitby North']) {
 const r=z.resolve(req(city));assert.equal(r.status,'READY');assert.equal(r.id,'510');
 assert.equal(r.reason,'SERVICE_CITY_DEFAULT_OTHER_USER_APPROVED');
 assert.equal(r.serviceEligibility,'NOT_ESTABLISHED_BY_ZONE_MAPPING');
}
assert.equal(z.resolve({...req('Newmarket'),Province:'QUEBEC'}).reason,'SERVICE_PROVINCE_UNMAPPED');
assert.equal(z.resolve({...req('Newmarket'),Province:''}).reason,'SERVICE_PROVINCE_REQUIRED');
assert.equal(z.resolve({...req('Newmarket'),Country:''}).reason,'SERVICE_COUNTRY_REQUIRED');
assert.equal(z.resolve({...req('Whitby'),Province:'BC'}).status,'REVIEW');
assert.equal(z.resolve({...req('Whitby'),Country:'USA'}).status,'REVIEW');
assert.equal(z.resolve({...req('Whitby'),'Matched Location ID':''}).status,'REVIEW');
assert.equal(z.resolve(req('Whitby'),{'Location ID':'2','Customer ID':'999',City:'Toronto'}).status,'REVIEW');
assert.equal(z.resolve(req('Whitby'),{'Location ID':'2','Customer ID':'1',City:'Toronto'}).id,'508');
function draft(){return {ok:true,safeForPayloadOverlay:true,customFields:{798:{}},readyFieldIds:['855'],lookupRequiredFieldIds:['798'],coreBlockers:[]};}
let d=draft();z.apply(d,req('Whitby'));assert.equal(d.customFields[798].value,'506');assert.equal(d.customFields[798].required,true);assert.equal(d.safeForPayloadOverlay,true);assert.equal(d.lookupRequiredFieldIds.length,0);
d=draft();z.apply(d,req('Newmarket'));assert.equal(d.safeForPayloadOverlay,true);assert.equal(d.ok,true);assert.equal(d.customFields[798].value,'510');
d=draft();z.apply(d,{...req('Newmarket'),Province:'QUEBEC'});assert.equal(d.safeForPayloadOverlay,false);assert.equal(d.ok,false);assert.equal(d.customFields[798].value,'');assert.equal(d.coreBlockers[0].code,'SERVICE_PROVINCE_UNMAPPED');
console.log('PASS: service-city zones; scoped location precedence; blank, unknown, invalid scope and province guards.');

