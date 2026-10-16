// Node.js — service zone sheet-reference contract tests (synthetic coordinates only).
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const src = fs.readFileSync('src/70_Workflow_Automation.gs', 'utf8');
const begin = src.indexOf('CF.ServiceZone =');
const end = src.indexOf('\n})();', begin) + 6;
assert.ok(begin >= 0 && end > begin, 'zone module found');
const csv = fs.readFileSync('data/service-area-municipalities-provisional-2026-10-16.csv', 'utf8').trim().split(/\r?\n/);
function parseCsv(line) {
  const fields = [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(m => m[1].replace(/""/g, '"'));
  assert.equal(fields.length, 8, 'CSV row must have 8 columns');
  return fields;
}
const area = csv.slice(0,27).map(parseCsv);
assert.equal(area.length, 27);
const storeRows = [
  ['Scarborough','65 Rylander Blvd','Scarborough','ON','M1B 5M5','Canada','','','NOT GEOCODED'],
  ['Whitby','10 Sunray Street','Whitby','ON','L1N 9B5','Canada','','','NOT GEOCODED'],
  ['Toronto','1828 Queen St E','Toronto','ON','M4L 1G9','Canada','','','NOT GEOCODED'],
  ['Ajax','2 Old Kingston Road','Ajax','ON','L1T 2Z7','Canada','','','NOT GEOCODED'],
  ['Newmarket','93 Main St S','Newmarket','ON','L3Y 3Y8','Canada','','','NOT GEOCODED']
].map(row=>row.concat(['','']));
let areaReads = 0, storeReads = 0;
const sheets = {
  '08 Service Area — Provisional': {getRange(r,c,h,w) {
    assert.deepEqual([r,c,h,w],[1,1,27,8]); areaReads++;
    return {getDisplayValues:()=>area};
  }},
  '09 Store Locations — Geo Pending': {getRange(r,c,h,w) {
    assert.deepEqual([r,c,h,w],[2,1,5,11]); storeReads++;
    return {getDisplayValues:()=>storeRows};
  }}
};
const cache = new Map();
const ctx = {
  CF:{Util:{getSpreadsheet:()=>({getSheetByName:name=>sheets[name]||null})}},
  CacheService:{getScriptCache:()=>({get:k=>cache.get(k)||null,put:(k,v)=>cache.set(k,v)})}
};
vm.runInNewContext(src.slice(begin,end),ctx);
const zone = ctx.CF.ServiceZone;
const req = city => ({City:city,Province:'ONTARIO',Country:'Ca','Matched Customer ID':'10','Matched Location ID':'20'});
for (const city of ['Whitby','Ajax','Pickering','Oshawa']) {
  assert.equal(zone.resolve(req(city)).id,'506');
}
assert.equal(zone.resolve(req('Toronto')).id,'508');
assert.equal(areaReads,0,'historically auto-ready cities must not incur new sheet reads');
assert.deepEqual(zone.getCoverageReferenceStatus(),{ok:true,count:26,source:'08 Service Area — Provisional'});
const sample = [['Newmarket','Newmarket','ENTIRELY_WITHIN_CORE'],['Scarborough','Toronto','PARTLY_WITHIN_CORE'],
  ['Courtice','Clarington','PARTLY_WITHIN_CORE'],['King City','King','PARTLY_WITHIN_CORE'],
  ['Port Perry','Scugog','PARTLY_WITHIN_CORE'],['Brampton','Brampton','BUFFER_ONLY']];
for (const [input,municipality,coverageClass] of sample) {
  const r=zone.resolve(req(input));
  assert.equal(r.status,'REVIEW',input+' cannot be automatically approved');
  assert.equal(r.municipality,municipality);
  assert.equal(r.coverageClass,coverageClass);
  assert.equal(r.id,'');
}
assert.equal(areaReads,1,'one read with cache for all new names');
assert.equal(zone.resolve(req('Brampton')).reason,'SERVICE_BUFFER_ADDRESS_REVIEW_REQUIRED');
assert.equal(zone.resolve(req('Unknown City')).reason,'SERVICE_CITY_UNMAPPED');
assert.equal(zone.resolve({...req('Newmarket'),Province:'BC'}).reason,'SERVICE_PROVINCE_UNMAPPED');
assert.equal(zone.resolve(req('Newmarket'),{'Location ID':'20','Customer ID':'90',City:'Ajax'}).reason,'SERVICE_LOCATION_SCOPE_CONFLICT');
const draft = {ok:true,safeForPayloadOverlay:true,customFields:{798:{}},
  readyFieldIds:[],lookupRequiredFieldIds:['798'],operatorRequiredFieldIds:[],coreBlockers:[]};
zone.apply(draft,req('Scarborough'));
assert.equal(draft.customFields[798].value,'');
assert.equal(draft.ok,false);
assert.equal(draft.coreBlockers[0].code,'SERVICE_ADDRESS_BOUNDARY_NOT_VERIFIED');
assert.equal(zone.previewAddressDistance(43.8,-79.2).reason,'STORE_COORDINATES_NOT_VERIFIED');
assert.equal(zone.previewAddressDistance(null,-79.2).reason,'SERVICE_ADDRESS_COORDINATES_REQUIRED');
// Synthetic coordinates exercise math only; they are not verified showroom positions.
storeRows.forEach((r,i)=>{r[6]=String(43.8+i*.1);r[7]=String(-79.2-i*.1);r[8]='VERIFIED — TEST FIXTURE ONLY';});
const near=zone.previewAddressDistance(43.8,-79.2);
assert.equal(near.status,'PREVIEW_ONLY');
assert.equal(near.classification,'CORE');
assert.equal(near.nearestShowroom,'Scarborough');
assert.equal(near.distanceKm,0);
assert.equal(near.zoneOptionId,'');
assert.equal(near.requiresZoneApproval,true);
assert.ok(storeReads>=2);
console.log('PASS: live-sheet schema mirror, alias coverage, legacy zero-read fast path, fail-closed boundaries and distance preview.');
