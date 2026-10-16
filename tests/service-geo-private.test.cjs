// Mock-only contract tests. NEVER contact public OSM or process a real customer address.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const src=fs.readFileSync('src/70_Workflow_Automation.gs','utf8');
function block(name){const begin=src.indexOf(name+' ='),end=src.indexOf('\n})();',begin)+6;assert.ok(begin>=0&&end>begin);return src.slice(begin,end);}
const csv=fs.readFileSync('data/service-area-municipalities-provisional-2026-10-16.csv','utf8').trim().split(/\r?\n/);
function parse(line){return [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(m=>m[1].replace(/""/g,'"'));}
const areas=csv.slice(0,27).map(parse),props=new Map(),cache=new Map();
const storeRows=[
 ['Scarborough','65 Rylander Blvd','Scarborough','ON','M1B 5M5','Canada','','','NOT GEOCODED','',''],
 ['Whitby','10 Sunray St','Whitby','ON','L1N 9B5','Canada','','','NOT GEOCODED','',''],
 ['Toronto','1828 Queen St E','Toronto','ON','M4L 1G9','Canada','','','NOT GEOCODED','',''],
 ['Ajax','2 Old Kingston Rd','Ajax','ON','L1T 2Z7','Canada','','','NOT GEOCODED','',''],
 ['Newmarket','93 Main St S','Newmarket','ON','L3Y 3Y8','Canada','','','NOT GEOCODED','','']
];
const headers=['Address SHA256','Latitude','Longitude','Municipality','OSM Type','OSM ID','Geocoded At','Provider','Match Status'];
const cacheRows=[headers];
let failPersist=false;
let httpCalls=0,lookups=0;
const geoSheet={
 getLastRow(){return cacheRows.length;},
 getRange(row,col,count,width){
   return {getDisplayValues(){
      if(row===1&&col===1&&width===headers.length)return [headers];
      return cacheRows.slice(row-1,row-1+count).map(x=>x.slice(col-1,col-1+width));
    },
    createTextFinder(query){return {matchEntireCell(){return this;},findNext(){
      lookups++;
      const i=cacheRows.findIndex((r,j)=>j>0&&r[0]===query);
      return i<0?null:{getRow:()=>i+1};
    }};},
    setValues(values){if(failPersist)throw new Error("synthetic write failure");assert.equal(width,headers.length);cacheRows[row-1]=values[0];}
   };
 }
};
const sheets={
 '08 Service Area — Provisional':{getRange:()=>({getDisplayValues:()=>areas})},
 '09 Store Locations — Geo Pending':{getRange:()=>({getDisplayValues:()=>storeRows})},
 '10 Service Geocodes — Private':geoSheet
};
const fixture={
 lat:'43.79764',lon:'-79.13923',osm_type:'node',osm_id:356616702,
 address:{house_number:'87',road:'Island Road',postcode:'M1C 2P6',country_code:'ca',city:'Toronto'}
};
const fakeProvider={
 getResponseCode:()=>200,
 getContentText:()=>JSON.stringify([fixture])
};
const ctx={
 Utilities:{computeHmacSha256Signature:(value,key)=>Array.from(crypto.createHmac("sha256",key).update(value).digest())},
 CF:{Util:{
  getSpreadsheet:()=>({getSheetByName:n=>sheets[n]||null}),
  findRecord:(t,h,id)=>t==='SERVICE_REQUESTS'&&id==='SYNTHETIC'?request:null,
  sha256:s=>crypto.createHash('sha256').update(s).digest('hex')
 }},
 CacheService:{getScriptCache:()=>({get:k=>cache.get(k)||null,put:(k,v)=>cache.set(k,v)})},
 PropertiesService:{getScriptProperties:()=>({
  getProperty:k=>props.get(k)||'',setProperty:(k,v)=>props.set(k,String(v))
 })},
 LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
 UrlFetchApp:{fetch:(url,options)=>{httpCalls++;assert.ok(!url.includes('nominatim.openstreetmap.org'));assert.ok(url.includes('format=jsonv2'));assert.equal(options.followRedirects,false);return fakeProvider;}}
};
vm.runInNewContext(block('CF.ServiceZone'),ctx);
vm.runInNewContext(block('CF.ServiceGeo'),ctx);
const geo=ctx.CF.ServiceGeo;
const request={'Request ID':'SYNTHETIC',Street:'87 Island Road',City:'West Rouge',
 'Postal Code':'M1C 2P6',Province:'Ontario',Country:'Canada'};
assert.equal(geo.evaluateRequest(request).reason,'GEO_CACHE_KEY_NOT_CONFIGURED');
props.set('CF_SERVICE_GEO_CACHE_HMAC_KEY','synthetic-test-key-never-use-in-production-1234567890');
const unconfigured=geo.evaluateRequest(request);
assert.equal(unconfigured.status,'REVIEW');
assert.equal(unconfigured.reason,'PRIVATE_GEO_PROVIDER_NOT_APPROVED');
assert.equal(httpCalls,0,'default-off feature must perform no HTTP');
props.set('CF_SERVICE_GEO_PRIVATE_ENABLED','true');
props.set('CF_SERVICE_GEO_PRIVATE_ADDRESS_APPROVED','true');
props.set('CF_SERVICE_GEO_PRIVATE_ENDPOINT','https://nominatim.openstreetmap.org/search');
assert.equal(geo.evaluateRequest(request).reason,'PRIVATE_GEO_ENDPOINT_INVALID_OR_PUBLIC');
assert.equal(httpCalls,0,'no private residential address to public Nominatim');
props.set('CF_SERVICE_GEO_PRIVATE_ENDPOINT','https://private-geocode.example.test/search');
assert.equal(geo.evaluateRequest(request).reason,'PRIVATE_GEO_HOST_NOT_ALLOWLISTED');
props.set('CF_SERVICE_GEO_PRIVATE_ALLOWED_HOSTS','private-geocode.example.test');
const first=geo.evaluateRequest(request);
assert.equal(first.status,'PREVIEW_ONLY');
assert.equal(first.municipality,'Toronto');
assert.equal(first.distanceStatus,'REVIEW');
assert.equal(first.reason,'STORE_COORDINATES_NOT_VERIFIED');
assert.equal(first.administrativeZoneOption,'');
assert.equal(first.serviceEligibility,'NOT_AUTOMATICALLY_APPROVED');
assert.equal(first.networkCalls,1);
assert.equal(cacheRows.length,2);
assert.equal(cacheRows[1][0].length,64);
assert.equal(cacheRows[1][0],crypto.createHmac('sha256',props.get('CF_SERVICE_GEO_CACHE_HMAC_KEY')).update('87|ISLANDRD|WESTROUGE|M1C2P6|CA').digest('hex'));
assert.equal(JSON.stringify(cacheRows).includes('87 Island Road'),false);
assert.equal(httpCalls,1);
const again=geo.evaluateRequest(request);
assert.equal(again.fromCache,true);
assert.equal(again.networkCalls,0);
assert.equal(again.status,'PREVIEW_ONLY');
assert.equal(httpCalls,1,'cache hit must avoid another HTTP');
const rejectedPostal=geo.previewProviderResult({...request,'Postal Code':'M1C 2P7'},[fixture]);
assert.equal(rejectedPostal.reason,'OSM_NO_EXACT_ADDRESS_MATCH');
const rejectedStreet=geo.previewProviderResult({...request,Street:'88 Island Road'},[fixture]);
assert.equal(rejectedStreet.reason,'OSM_NO_EXACT_ADDRESS_MATCH');
const conflicting=geo.previewProviderResult(request,[{...fixture,address:{...fixture.address,city:'Pickering'}}]);
assert.equal(conflicting.reason,'OSM_MUNICIPALITY_CONFLICT');
assert.equal(geo.evaluateRequest({...request,'Postal Code':'garbage'}).reason,'SERVICE_ADDRESS_INCOMPLETE_OR_INVALID');
assert.equal(geo.evaluateRequestId('SYNTHETIC').fromCache,true);
assert.equal(geo.evaluateRequestId('MISSING').reason,'GEO_REQUEST_NOT_FOUND');
storeRows.forEach((r,i)=>{r[6]=String(43.79764+i*.1);r[7]=String(-79.13923-i*.1);r[8]='VERIFIED — TEST FIXTURE ONLY';});
const distance=geo.previewProviderResult(request,[fixture]);
assert.equal(distance.classification,'CORE');
assert.equal(distance.nearestShowroom,'Scarborough');
assert.equal(distance.distanceKm,0);
assert.equal(distance.administrativeZoneOption,'');
assert.equal(httpCalls,1);
console.log('PASS: private-provider default-off privacy gate, exact OSM address guard, hashed durable geocache and one network call; distance is preview-only.');


// Durable cache timestamps and coordinates are evidence, not trusted on label alone.
const goodRow=cacheRows[1].slice();
for (const [column,value] of [[1,'91'],[2,'181'],[6,new Date(Date.now()+86400000).toISOString()]]) {
 cache.clear();cacheRows[1]=goodRow.slice();cacheRows[1][column]=value;
 const before=httpCalls;
 assert.equal(geo.evaluateRequest(request).reason,'GEO_RATE_LIMITED');
 assert.equal(httpCalls,before,'invalid cached evidence cannot bypass provider rate gate');
}
cacheRows[1]=goodRow;cache.clear();
// Adversarial regressions: unknown feature IDs must not collapse as one match.
assert.equal(geo.previewProviderResult(request,[{...fixture,osm_type:'',osm_id:''}]).reason,'OSM_NO_EXACT_ADDRESS_MATCH');
for (const host of ['127.0.0.1','localhost','10.0.0.1','nominatim.openstreetmap.org']) {
 cache.clear();cacheRows.splice(1);props.set('CF_SERVICE_GEO_LAST_REQUEST_MS','0');
 props.set('CF_SERVICE_GEO_PRIVATE_ENDPOINT','https://'+host+'/search');
 props.set('CF_SERVICE_GEO_PRIVATE_ALLOWED_HOSTS',host);
 const before=httpCalls;assert.equal(geo.evaluateRequest(request).status,'REVIEW');assert.equal(httpCalls,before);
}
props.set('CF_SERVICE_GEO_PRIVATE_ENDPOINT','https://private-geocode.example.test/search');
props.set('CF_SERVICE_GEO_PRIVATE_ALLOWED_HOSTS','private-geocode.example.test');
props.set('CF_SERVICE_GEO_LAST_REQUEST_MS','0');failPersist=true;
const writeFailure=geo.evaluateRequest(request);
assert.equal(writeFailure.networkCalls,1,'provider attempt remains counted when durable cache write fails');
failPersist=false;
console.log('PASS: HMAC key gate, exact host allowlist, explicit cached-call count, feature identity and post-fetch failure accounting.');
