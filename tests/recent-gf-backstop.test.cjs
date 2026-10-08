const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/20_Intake_Processing.gs'), 'utf8');
const start = source.indexOf('  function reconcileRecentGravityForms(options) {');
const end = source.indexOf('\n  /*******************************************************', start);
assert(start >= 0 && end > start);
function run({pagePayload, detailPayload, detailError, localPayload, localDuplicates = false}) {
  const calls = {detail:0, received:[], kicked:[]};
  const entry = {id:'3543', date_created:'2026-10-07 12:00:00'};
  const score = p => ['first_name','email','phone'].filter(k => p && p[k]).length;
  const context = {
    Date, Math, Number, Array, VERSION:'test', MODULE_NAME:'Intake',
    clean_:x=>x == null ? '' : String(x).trim(),
    deps_:()=>({util:{safeJson:JSON.stringify,logEvent:()=>{}}}),
    gfConfig_:()=>({formId:'2'}),
    gfGetJson_:()=>({entries:[entry]}),
    localSubmissionIndex_:name=>name === 'WEBFORM_REQUESTS' && (localPayload || localDuplicates) ? {'3543':localDuplicates ? [{},{}] : [{}]} : {},
    localPairNeedsHydration_:()=>false,
    localWebformPayload_:()=>localPayload || null,
    gravityPayloadContentScore_:score,
    gravityEntryToPayload_:()=>pagePayload,
    payloadForRepair_:()=>{calls.detail++; if(detailError) throw new Error(detailError); return {payload:detailPayload,source:'GRAVITY_FORMS_ENTRY'};},
    gfUtcToLocalString_:x=>x,
    receivePayload:p=>{calls.received.push(p);return {requestId:'SR-test',status:'RECEIVED'};},
    CF:{EventDrivenServiceAutomation:{kick:id=>{calls.kicked.push(id); return {ok:true,status:'QUEUED'};}}}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start,end), context);
  return {out:context.reconcileRecentGravityForms({}),calls};
}
const good = {submission_id:'3543',first_name:'Test',email:'test@example.invalid'};
let r = run({pagePayload:good});
assert.equal(r.out.ok,true); assert.equal(r.calls.detail,0); assert.equal(r.calls.received.length,1);
r = run({pagePayload:{submission_id:'3543'},detailPayload:good});
assert.equal(r.out.ok,true); assert.equal(r.calls.detail,1); assert.equal(r.calls.received.length,1); assert.equal(r.out.results[0].mappingSource,'GRAVITY_FORMS_ENTRY'); assert.equal(r.calls.kicked.length,1);
r = run({pagePayload:{submission_id:'3543'},detailPayload:{submission_id:'3543'}});
assert.equal(r.out.ok,false); assert.equal(r.calls.received.length,0); assert.match(r.out.results[0].error,/MAPPING_INSUFFICIENT/);
r = run({pagePayload:{submission_id:'3543'},detailError:'GRAVITY_FORMS_ENTRY_FETCH_MISMATCH'});
assert.equal(r.out.ok,false); assert.equal(r.calls.received.length,0); assert.match(r.out.results[0].error,/FETCH_MISMATCH/);
r = run({pagePayload:{submission_id:'3543'},localPayload:good});
assert.equal(r.out.ok,true); assert.equal(r.calls.detail,0); assert.equal(r.out.results[0].mappingSource,'LOCAL_WEBFORM_PAYLOAD');
r = run({pagePayload:good,localDuplicates:true});
assert.equal(r.out.ok,false); assert.equal(r.calls.detail,0); assert.equal(r.calls.received.length,0);
console.log('PASS: 6 recent-intake recovery and safety cases (mocked external responses).');
