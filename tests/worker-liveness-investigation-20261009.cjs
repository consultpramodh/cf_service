// JavaScript / Node.js: executes the actual extracted scheduling helper with mocked Apps Script services.
const vm = require('node:vm');
const assert = require('node:assert/strict');
const original = "function ensureWorker_(delayMs,currentUid){\n    var current=clean_(currentUid);\n    var rows=triggersBy_(FINAL_HANDLER).filter(function(t){\n      var id='';\n      try{id=clean_(t.getUniqueId&&t.getUniqueId());}catch(e){}\n      return !current||!id||id!==current;\n    });\n    if(rows.length){\n      var queued=queue_();\n      var nextAt=clean_(props_().getProperty(NEXT_AT));\n      var nextAtMs=dateMs_(nextAt);\n      var stale=queued.length>0&&nextAtMs>0&&(Date.now()-nextAtMs)>WORKER_STALE_MS;\n      if(!stale)return{created:false,count:rows.length,stale:false,scheduledAt:nextAt};\n      rows.forEach(deleteTriggerSafe_);\n      log_('STALE_FINAL_WORKER_RECOVERY','RECOVERED',queued[0]||'',{\n        deletedStaleWorkerTriggers:rows.length,\n        staleScheduledAt:nextAt,\n        staleAgeMs:Date.now()-nextAtMs,\n        queuedRequestIds:queued.slice(0,10)\n      },'Stale AUTO_FINAL_ServiceOps trigger replaced so queued requests can continue.');\n    }\n    if(!queue_().length)return{created:false,count:0,reason:'QUEUE_EMPTY'};\n    var delay=Math.max(1000,Number(delayMs||WORKER_DELAY_MS));\n    ScriptApp.newTrigger(FINAL_HANDLER).timeBased().after(delay).create();\n    var at=new Date(Date.now()+delay).toISOString();\n    props_().setProperty(NEXT_AT,at);\n    return{created:true,count:1,scheduledAt:at,staleRecovered:rows.length>0};\n  }\n  ";
const candidate = "function ensureWorker_(delayMs,currentUid){\n    var current=clean_(currentUid);\n    var rows=triggersBy_(FINAL_HANDLER).filter(function(t){\n      var id='';\n      try{id=clean_(t.getUniqueId&&t.getUniqueId());}catch(e){}\n      return !current||!id||id!==current;\n    });\n    if(rows.length){\n      var queued=queue_();\n      var nextAt=clean_(props_().getProperty(NEXT_AT));\n      var nextAtMs=dateMs_(nextAt);\n      var stale=queued.length>0&&(!nextAtMs||(Date.now()-nextAtMs)>WORKER_STALE_MS);\n      if(!stale)return{created:false,count:rows.length,stale:false,scheduledAt:nextAt};\n      rows.forEach(deleteTriggerSafe_);\n      log_('STALE_FINAL_WORKER_RECOVERY','RECOVERED',queued[0]||'',{\n        deletedStaleWorkerTriggers:rows.length,\n        staleScheduledAt:nextAt,\n        staleAgeMs:Date.now()-nextAtMs,\n        queuedRequestIds:queued.slice(0,10)\n      },'Stale AUTO_FINAL_ServiceOps trigger replaced so queued requests can continue.');\n    }\n    if(!queue_().length)return{created:false,count:0,reason:'QUEUE_EMPTY'};\n    var delay=Math.max(1000,Number(delayMs||WORKER_DELAY_MS));\n    ScriptApp.newTrigger(FINAL_HANDLER).timeBased().after(delay).create();\n    var at=new Date(Date.now()+delay).toISOString();\n    props_().setProperty(NEXT_AT,at);\n    return{created:true,count:1,scheduledAt:at,staleRecovered:rows.length>0};\n  }\n  ";
function run(source, timestamp, queue=['REQ-1'], currentUid='', deletionFails=false) {
 let triggers=[{getUniqueId:()=> 'worker-1'}], created=0, deleted=0;
 const props={next:timestamp};
 const context={
 clean_:v=>v==null?'':String(v).trim(),
 triggersBy_:()=>triggers, FINAL_HANDLER:'AUTO_FINAL_ServiceOps',
 queue_:()=>queue, NEXT_AT:'next',
 props_:()=>({getProperty:k=>props[k],setProperty:(k,v)=>props[k]=v}),
 dateMs_:v=>{const n=new Date(v).getTime();return Number.isNaN(n)?0:n;},
 WORKER_STALE_MS:600000, WORKER_DELAY_MS:10000, Date,
 deleteTriggerSafe_:t=>{if(deletionFails)return false;deleted++;triggers=triggers.filter(x=>x!==t);return true;},
 log_:()=>{},
 ScriptApp:{newTrigger:()=>({timeBased:()=>({after:()=>({create:()=>{created++;}})})})}
 };
 vm.createContext(context);vm.runInContext(source,context);
 const result=context.ensureWorker_(10000,currentUid);
 return {result,created,deleted};
}
const fresh=new Date(Date.now()+10000).toISOString();
const overdue=new Date(Date.now()-660000).toISOString();
assert.equal(run(original,'').created,0);
assert.equal(run(original,'invalid').created,0);
console.log('REPRODUCED: original retains worker with missing or invalid timestamp');
for(const t of ['', 'invalid',overdue])assert.equal(run(candidate,t).created,1);
assert.equal(run(candidate,fresh).created,0);
assert.equal(run(candidate,'',[]).created,0);
assert.equal(run(candidate,'',['REQ-1'],'worker-1').created,1);
console.log('PASS: candidate recovers missing, invalid, overdue metadata; preserves fresh schedule and empty queue; schedules continuation excluding current trigger');
const failed=run(candidate,overdue,['REQ-1'],'',true);
assert.equal(failed.created,1);
console.log('UNRESOLVED: failed deletion can create a second worker; active execution/concurrent scheduling not modeled. CANDIDATE NOT DEPLOYABLE.');
