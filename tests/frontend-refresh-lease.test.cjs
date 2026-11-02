const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync('src/50_Operator_Queue.gs','utf8');
const moduleSource=src.slice(src.indexOf('/* CF_FRONTEND_DURABLE_REFRESH_20261023_R1 */'));
function setup(){
 const data={},state={held:false,refreshCount:0,nested:null,now:1000000,seq:0};
 const p={getProperties:()=>({...data}),getProperty:k=>data[k]||null,setProperty:(k,v)=>{data[k]=v;return p;},deleteProperty:k=>delete data[k]};
 const api={refresh:()=>{assert.equal(state.held,false,'frontend refresh must not hold the business lock');state.refreshCount++;if(state.nested)state.nested();return{ok:true,recentParity:{ok:true},dashboardRefreshed:true};}};
 const util={patchServiceRequestById:()=>true,patchRow:()=>true,requireSheet:()=>({getLastRow:()=>0}),getActualHeaders:()=>[]};
 const ctx={CF:{OperatorQueue:api,Util:util},PropertiesService:{getScriptProperties:()=>p},Utilities:{getUuid:()=>String(++state.seq)},LockService:{getScriptLock:()=>({tryLock:()=>{if(state.held)return false;state.held=true;return true;},releaseLock:()=>{assert.equal(state.held,true);state.held=false;}})},SpreadsheetApp:{flush:()=>{}},ScriptApp:{getProjectTriggers:()=>[{getHandlerFunction:()=> 'AUTO_CF_QUEUE_SYNC_AFTER_SERVICE_REQUEST_MUTATION'}]},Date:{now:()=>state.now},console};
 vm.runInNewContext(moduleSource,ctx);return {api,util,state,data};
}
let x=setup(),nested;x.util.patchServiceRequestById('r1',{});x.state.nested=()=>{x.state.nested=null;nested=x.api.flushPendingMutationSync();x.util.patchServiceRequestById('r1',{});};assert.equal(x.api.flushPendingMutationSync().ok,true);assert.equal(nested.status,'FRONTEND_REFRESH_DEFERRED_BUSY');assert.notEqual(x.data.CF_FRONTEND_ACK_r1,x.data.CF_FRONTEND_DIRTY_r1);assert.equal(x.api.flushPendingMutationSync().ok,true);assert.equal(x.data.CF_FRONTEND_REFRESH_LEASE_V1,undefined);
x=setup();x.util.patchServiceRequestById('r1',{});x.data.CF_FRONTEND_REFRESH_LEASE_V1='broken';assert.equal(x.api.flushPendingMutationSync().status,'FRONTEND_REFRESH_LEASE_INVALID');assert.equal(x.state.refreshCount,0);
x=setup();x.util.patchServiceRequestById('r1',{});x.data.CF_FRONTEND_REFRESH_LEASE_V1=JSON.stringify({token:'old',expiresAt:x.state.now-1});assert.equal(x.api.flushPendingMutationSync().ok,true);assert.equal(x.state.refreshCount,1);
x=setup();x.util.patchServiceRequestById('r1',{});x.state.held=true;assert.equal(x.api.flushPendingMutationSync().status,'FRONTEND_REFRESH_DEFERRED_LOCK');assert.equal(x.state.refreshCount,0);
console.log('PASS: short business lock, frontend lease serialization, dirty generations, expiry and invalid lease safety.');
