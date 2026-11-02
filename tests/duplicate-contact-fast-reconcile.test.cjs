const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync('src/70_Workflow_Automation.gs','utf8');
const start=src.indexOf('  function canContinueRejectedDuplicateContact_('),end=src.indexOf('\n  function reconcileOperationalLinks_(',start);
assert.ok(start>=0&&end>start);
const ctx={clean_:v=>String(v||'').trim(),upper_:v=>String(v||'').trim().toUpperCase(),parse_:v=>{try{return JSON.parse(v||'{}')}catch{return {}}}};
vm.runInNewContext(src.slice(start,end),ctx);
const j={status:'DUPLICATE_CONTACT_FOUND_AUTO_RECONCILE',postOutcome:'REJECTED_VALIDATION',httpStatus:400,remoteWriteMayHaveSucceeded:false,noAutomaticWriteRetry:true,existingDuplicateContactId:'56951',existingDuplicateContactIds:['56951']};
const result={requestId:'r1',status:'DUPLICATE_CONTACT_FOUND_AUTO_RECONCILE_QUEUED',existingDuplicateContactId:'56951',remoteWriteMayHaveSucceeded:false,duplicateCreatePostRetried:false,liveWriteExecuted:true};
const row={'Current Stage':'READY FOR CONTACT CREATE','Request Status':'OPEN','Manual Review?':'NO','Write Journal JSON':JSON.stringify({contactCreate:j})};
const check=(r=result,record=row)=>ctx.canContinueRejectedDuplicateContact_('r1',r,record);
assert.equal(check(),true);
assert.equal(check({...result,requestId:'other'}),false);
assert.equal(check({...result,remoteWriteMayHaveSucceeded:true}),false);
assert.equal(check({...result,duplicateCreatePostRetried:true}),false);
assert.equal(check({...result,existingDuplicateContactId:'999'}),false);
assert.equal(check(result,{...row,'Manual Review?':'YES'}),false);
for(const change of [{httpStatus:500},{remoteWriteMayHaveSucceeded:true},{noAutomaticWriteRetry:false},{existingDuplicateContactIds:['56951','123']},{postOutcome:'UNCERTAIN'}])assert.equal(check(result,{...row,'Write Journal JSON':JSON.stringify({contactCreate:{...j,...change}})}),false);
assert.equal(check(result,{...row,'Write Journal JSON':'{invalid'}),false);
assert.ok(src.includes('result.liveWriteExecuted===true&&!canContinueRejectedDuplicateContact_(id,result,after)'));
const workerSource=src.slice(src.indexOf('  function worker(e)'),src.indexOf('  function recentRecoverable_'));
function workerCase(uncertain){
 let queue=['r1'],calls=0;const record={...row,'Current Stage':'START','Write Journal JSON':JSON.stringify({contactCreate:{...j,remoteWriteMayHaveSucceeded:uncertain}})};
 const c={...ctx,Date:{now:()=>1},WORKER_BUDGET_MS:220000,MAX_STEPS:12,WORKER_DELAY_MS:10000,VERSION:'test',props_:()=>({getProperty:()=> 'TRUE'}),ENABLED:'enabled',normalizeTopology_:()=>{},queue_:()=>queue.slice(),request_:()=>record,recoverDeterministicReview_:r=>r,terminal_:r=>r['Current Stage']==='COMPLETED',genuineReview_:()=>false,dequeue_:()=>queue=[],signature_:r=>r['Current Stage'],dateMs_:()=>0,stepLabel_:()=> 'CONTACT',step_:()=>{calls++;if(calls===1){record['Current Stage']='READY FOR CONTACT CREATE';return {...result,remoteWriteMayHaveSucceeded:uncertain};}record['Current Stage']='COMPLETED';return {requestId:'r1',ok:true,status:'RECONCILED',liveWriteExecuted:false};},assertRequestScoped_:(id,r)=>r,log_:()=>{},knownOrderId_:()=>'',refreshQueue_:()=>{},ensureWorker_:()=>{},rotateToBack_:()=>queue};
 vm.runInNewContext(src.slice(start,end)+'\n'+workerSource,c);c.worker({});return calls;
}
assert.equal(workerCase(false),2);assert.equal(workerCase(true),1);
console.log('PASS: fast duplicate reconciliation only after one durable rejected 400, with identity and retry guards.');
