// JavaScript / Node.js: exercise durable invalidation and retry boundaries.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('src/50_Operator_Queue.gs','utf8');
const moduleSource=source.slice(source.indexOf('/* CF_FRONTEND_DURABLE_REFRESH_20261023_R1 */'));
function setup(){
  const data={},state={calls:0,writes:0,locked:false,triggerError:false,refreshError:false,parity:true,dashboard:true,concurrent:null},triggers=[];
  const p={getProperties:()=>({...data}),getProperty:k=>data[k]||null,setProperty:(k,v)=>{data[k]=v;return p;},deleteProperty:k=>delete data[k]};
  let generation=0;
  const api={refresh:()=>{state.calls++;if(state.concurrent){const fn=state.concurrent;state.concurrent=null;fn();}if(state.refreshError)throw Error('sheet unavailable');return{ok:state.parity&&state.dashboard,recentParity:{ok:state.parity},dashboardRefreshed:state.dashboard};}};
  const util={patchServiceRequestById:()=>{state.writes++;return 'original result';},patchRow:()=>{state.writes++;return 'row result';},requireSheet:()=>({getLastRow:()=>9,getRange:()=>({getDisplayValue:()=> 'request-row'})}),getActualHeaders:()=>['Request ID']};
  const ctx={CF:{OperatorQueue:api,Util:util},PropertiesService:{getScriptProperties:()=>p},Utilities:{getUuid:()=>String(++generation)},LockService:{getScriptLock:()=>({tryLock:()=>!state.locked,releaseLock:()=>{}})},SpreadsheetApp:{flush:()=>{}},ScriptApp:{getProjectTriggers:()=>triggers,newTrigger:()=>({timeBased(){return this;},after(){return this;},create(){if(state.triggerError)throw Error('quota');triggers.push({getHandlerFunction:()=> 'AUTO_CF_QUEUE_SYNC_AFTER_SERVICE_REQUEST_MUTATION'});}})},console};
  vm.runInNewContext(moduleSource,ctx);return{api,util,state,data};
}
let x=setup();assert.equal(x.util.patchServiceRequestById('r1',{}),'original result');assert.equal(x.state.writes,1);assert.equal(x.api.flushPendingMutationSync().ok,true);assert.equal(x.api.flushPendingMutationSync().status,'NO_DIRTY_ROWS');
x=setup();x.state.locked=true;x.util.patchServiceRequestById('r1',{});assert.equal(x.api.flushPendingMutationSync().retryPending,true);x.state.locked=false;assert.equal(x.api.flushPendingMutationSync().ok,true);
x=setup();x.state.triggerError=true;assert.equal(x.util.patchServiceRequestById('r1',{}),'original result');x.state.refreshError=true;assert.equal(x.api.flushPendingMutationSync().ok,false);assert.equal(x.data.CF_FRONTEND_ACK_r1,undefined);x.state.refreshError=false;assert.equal(x.api.syncFrontendIfDue().ok,true);
for(const failure of ['parity','dashboard']){x=setup();x.util.patchServiceRequestById('r1',{});x.state[failure]=false;assert.equal(x.api.flushPendingMutationSync().ok,false);assert.equal(x.data.CF_FRONTEND_ACK_r1,undefined);x.state[failure]=true;assert.equal(x.api.flushPendingMutationSync().ok,true);}
x=setup();x.util.patchServiceRequestById('r1',{});x.state.concurrent=()=>x.util.patchServiceRequestById('r1',{});assert.equal(x.api.flushPendingMutationSync().ok,true);assert.notEqual(x.data.CF_FRONTEND_ACK_r1,x.data.CF_FRONTEND_DIRTY_r1);assert.equal(x.api.flushPendingMutationSync().ok,true);assert.equal(x.data.CF_FRONTEND_ACK_r1,x.data.CF_FRONTEND_DIRTY_r1);
x=setup();assert.equal(x.util.patchRow('OTHER',2,{}),'row result');assert.equal(x.api.flushPendingMutationSync().status,'NO_DIRTY_ROWS');x.util.patchRow('SERVICE_REQUESTS',2,{});assert.equal(x.api.flushPendingMutationSync().acknowledged,1);
x=setup();assert.equal(x.api.syncFrontendIfDue().status,'FRONTEND_REFRESH_VERIFIED');assert.equal(x.api.syncFrontendIfDue().status,'NO_DIRTY_ROWS');assert.equal(x.state.writes,0);
assert(source.includes('out.ok=out.ok!==false&&parity.ok===true'));
assert(fs.readFileSync('src/70_Workflow_Automation.gs','utf8').includes('var frontend=CF.OperatorQueue&&CF.OperatorQueue.syncFrontendIfDue?CF.OperatorQueue.syncFrontendIfDue()'));
console.log('PASS: frontend hooks, lock/quota recovery, failed refresh/parity/dashboard retries, concurrent generations, periodic refresh; no business writes during refresh.');
