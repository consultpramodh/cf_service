// JavaScript / Node.js — security and step correction behavior.
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const code=fs.readFileSync('operations-web/96_Operations_Web.gs','utf8');new vm.Script(code);let actor='marketing@classicfireplace.ca',patches=[],rechecked=0;
let record={'Request ID':'SR-TEST-1','Matched Customer ID':'42','Current Stage':'NEEDS REVIEW','Location Match Status':'NOT FOUND','Match Evidence JSON':'{}'};
const ctx={Session:{getActiveUser:()=>({getEmail:()=>actor}),getEffectiveUser:()=>({getEmail:()=> 'owner@classicfireplace.ca'})},CacheService:{getUserCache:()=>({get:()=> 'csrf'})},CF:{Config:{isTerminalState:s=>s==='COMPLETED'},StrivenData:{inspectReadiness:()=>({ok:true})},Util:{canonicalHash:r=>JSON.stringify(r),findRecord:()=>record,readRecords:k=>k==='STRIVEN_LOCATION_DATA'?[{'Location ID':'9','Customer ID':'42','Full Address':'Address'}]:[],parseJson:(s,d)=>s?JSON.parse(s):d,withScriptLock:cb=>cb(),nowString:()=> 'now',patchServiceRequestById:(id,p)=>patches.push(p),logEvent:()=>{}},Matching:{recheckRequest:()=>{rechecked++;return {ok:true};}}}};
vm.createContext(ctx);vm.runInContext(code,ctx);
const input=()=>({csrf:'csrf',requestId:'SR-TEST-1',revision:JSON.stringify(record),step:'location',entityId:'9'});
actor='';assert.throws(()=>ctx.cfOpsList(),/ACCESS_DENIED/);actor='outside@example.com';assert.throws(()=>ctx.cfOpsDetail('SR-TEST-1'),/ACCESS_DENIED/);actor='marketing@classicfireplace.ca';
assert.throws(()=>ctx.cfOpsSaveSelection({...input(),csrf:'wrong'}),/Session expired/);
assert.throws(()=>ctx.cfOpsSaveSelection({...input(),revision:'old'}),/changed/);
assert.throws(()=>ctx.cfOpsSaveSelection({...input(),entityId:'8'}),/ownership/);
record['Work Order ID']='123';assert.throws(()=>ctx.cfOpsSaveSelection(input()),/Existing orders/);delete record['Work Order ID'];
record['Write Journal JSON']=JSON.stringify({salesOrderCreate:{remoteWriteMayHaveSucceeded:true,status:'POST_STARTED'}});assert.throws(()=>ctx.cfOpsSaveSelection(input()),/uncertain/);delete record['Write Journal JSON'];
assert.equal(patches.length,0);const result=ctx.cfOpsSaveSelection(input());assert.equal(result.ok,true);assert.equal(result.strivenWrites,false);assert.equal(rechecked,1);assert.equal(patches[0]['Match Evidence JSON'].manualSelections.locationId,'9');assert.equal(patches[0]['Match Evidence JSON'].manualSelections.customerId,'42');assert.equal(patches[0]['Approved By'],'');
const html=fs.readFileSync('operations-web/OperationsWeb.html','utf8');new vm.Script(html.match(/<script>([\s\S]*)<\/script>/)[1].replace(/<\?!= JSON.stringify\(csrf\) \?>/,'"test"'));
console.log('PASS: denied anonymous/outside user, CSRF, stale revision, wrong-customer location, existing order, uncertain write; successful selection pins customer and clears approval; UI syntax.');
