const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../src/99_Production_Hardening.gs'),'utf8');
const fn=src.slice(src.indexOf('function CFH_reclaimUnusedCacheGrid_()'),src.indexOf('function CFH_installAndVerifyProductionHardening()'));
function setup({rows=1,extraData=false,busy=false}={}){
 let reset=0,deletions=0,releases=0;
 const sheets={};for(const [key,needed,maxRows] of [['STRIVEN_CUSTOMER_DATA',23,68677],['STRIVEN_LOCATION_DATA',16,30378]]){let columns=26;sheets[key]={getMaxColumns:()=>columns,getLastColumn:()=>extraData?26:needed,getMaxRows:()=>maxRows,getLastRow:()=>key==='STRIVEN_CUSTOMER_DATA'?rows:30378,deleteColumns:(start,count)=>{assert.equal(start,needed+1);assert.equal(count,columns-needed);columns-=count;deletions++;}};}
 const context={CFH_prepareSystemLogSink_:()=>({ok:true}),CF:{Util:{requireSheet:k=>sheets[k]},Config:{getHeaders:k=>Array(k==='STRIVEN_CUSTOMER_DATA'?23:16)}},LockService:{getScriptLock:()=>({tryLock:()=>!busy,releaseLock:()=>releases++})},PropertiesService:{getScriptProperties:()=>({deleteProperty:k=>{assert.equal(k,'CF_SERVICEOPS_API_BRAKE_LAST_ATTEMPT_CUSTOMER_MS');reset++;}})}};
 vm.runInNewContext(fn,context);return {call:()=>context.CFH_reclaimUnusedCacheGrid_(),counts:()=>({reset,deletions,releases})};
}
let r=setup();assert.equal(r.call().cellsFreed,509811);assert.equal(r.counts().reset,1);assert.equal(r.call().cellsFreed,0);assert.equal(r.counts().reset,1);
r=setup({rows:100});assert.equal(r.call().cellsFreed,509811);assert.equal(r.counts().reset,0);
r=setup({extraData:true});assert.equal(r.call().cellsFreed,0);assert.equal(r.counts().deletions,0);
r=setup({busy:true});assert.equal(r.call().status,'CACHE_GRID_MAINTENANCE_DEFERRED');assert.equal(r.counts().deletions,0);
console.log('PASS: only unused cache columns removed; data-bearing columns preserved; retry reset bounded; lock contention deferred.');
