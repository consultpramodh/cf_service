var CF = CF || {};
CF.V2Orchestrator = (function () {
'use strict';
var VERSION='0.3.1-candidate';
var JOURNAL_KEY='v2Workflow';
function clean_(v){return v===null||v===undefined?'':String(v).trim();}
function upper_(v){return clean_(v).toUpperCase();}
function deps_(){
if(!CF.Util||!CF.V2ShadowResolver||!CF.V2CoreEnsurers)throw new Error('CF.Util, CF.V2ShadowResolver and CF.V2CoreEnsurers are required.');
return {u:CF.Util,r:CF.V2ShadowResolver,e:CF.V2CoreEnsurers};
}
function request_(id){return deps_().u.findRecord('SERVICE_REQUESTS','Request ID',clean_(id));}
function parse_(v){try{return v?JSON.parse(String(v)):{};}catch(e){return {};}}
function safeJson_(v){try{return deps_().u.safeJson?deps_().u.safeJson(v):JSON.stringify(v);}catch(e){return JSON.stringify(v);}}
function now_(){return deps_().u.nowString?deps_().u.nowString():new Date().toISOString();}
function stateFromNext_(next){
var map={
CUSTOMER_CONFIRMED:'RESOLVING_CUSTOMER',
CUSTOMER_PHONE_CONFIRMED:'SYNCING_CUSTOMER_CORE',
LOCATION_CONFIRMED:'RESOLVING_LOCATION',
CONTACT_CONFIRMED:'RESOLVING_CONTACT',
CONTACT_PHONE_CONFIRMED:'SYNCING_CONTACT_CORE',
CONTACT_EMAIL_CONFIRMED:'SYNCING_CONTACT_CORE',
PRIMARY_CONTACT_CONFIRMED:'SYNCING_PRIMARY_CONTACT',
RELATIONSHIP_CONFIRMED:'RESOLVING_RELATIONSHIP',
SALES_ORDER_CONFIRMED:'RESOLVING_SALES_ORDER',
COMPLETE:'COMPLETE'
};
return map[next]||'TECHNICAL_RECOVERY';
}
function statusCategory_(result){
var s=upper_(result&&result.status);
if(!result)return 'TECHNICAL_RECOVERY';
if(result.ok===true)return 'PROGRESS';
if(/AMBIGUOUS|CONFLICT|HUMAN_REVIEW|DUPLICATE_RISK/.test(s))return 'BUSINESS_REVIEW';
if(/UNAVAILABLE|UNRESOLVED|GET_FAILED|RECONCILE|UNCERTAIN|RATE_LIMIT|TIMEOUT/.test(s))return 'TECHNICAL_RECOVERY';
if(/REJECTED_VALIDATION|AUTHORIZATION|CONTRACT/.test(s))return 'PERMANENT_FAILURE';
return 'TECHNICAL_RECOVERY';
}
function preview(requestId){
var core=deps_().e.preview(requestId);
var shadow=core.shadow||{};
var facts=shadow.facts||{};
facts.primaryContact=core.primaryContact||{};
facts.relationship=core.effectiveRelationship||facts.relationship||{};
return {
ok:core.ok===true,
version:VERSION,
mode:'READ_ONLY',
requestId:clean_(requestId),
canonicalState:stateFromNext_(core.nextRequiredFact),
nextRequiredFact:core.nextRequiredFact||'',
nextAction:core.nextAction||'',
facts:facts,
complete:core.complete===true,
writesEnabled:core.writesEnabled===true,
liveWriteExecuted:false
};
}
function legacyPatch_(preview,result){
var p={'Updated At':now_()};
if(preview.complete){
p['Current Stage']='COMPLETED';
p['Request Status']='COMPLETED';
p['Manual Review?']='NO';
p['Manual Review Reason']='';
p['Blocking Issue']='';
p['Next Action']='NONE';
p['Customer Structure Status']='COMPLETE';
p['Striven Sync Status']='SYNCED';
p['Reconciliation Status']='V2 COMPLETE — VERIFIED BUSINESS FACTS';
p['Final Outcome']='COMPLETED - SALES ORDER VERIFIED';
p['Completed At']=now_();
return p;
}
var category=statusCategory_(result);
if(category==='BUSINESS_REVIEW'){
p['Current Stage']='NEEDS REVIEW';
p['Request Status']='BLOCKED';
p['Manual Review?']='YES';
p['Manual Review Reason']=clean_(result&&result.status)||'V2 BUSINESS REVIEW REQUIRED';
p['Blocking Issue']=clean_(result&&result.error||result&&result.status);
p['Next Action']='REVIEW V2 BUSINESS CONFLICT';
return p;
}
if(category==='TECHNICAL_RECOVERY'||category==='PERMANENT_FAILURE'){
p['Request Status']='IN PROGRESS';
p['Manual Review?']='NO';
p['Manual Review Reason']='';
p['Blocking Issue']=clean_(result&&result.error||result&&result.status);
p['Next Action']='V2 '+clean_(preview.nextRequiredFact);
p['Reconciliation Status']='V2 '+category+' — '+clean_(result&&result.status);
return p;
}
p['Request Status']='IN PROGRESS';
p['Manual Review?']='NO';
p['Manual Review Reason']='';
p['Blocking Issue']='';
p['Next Action']='V2 '+clean_(preview.nextRequiredFact);
p['Reconciliation Status']='V2 PROGRESS — '+clean_(result&&result.status);
return p;
}
function journal_(row,pre,result,post){
var root=parse_(row&&row['Write Journal JSON']);
if(!root||typeof root!=='object'||Array.isArray(root))root={};
var prior=root[JOURNAL_KEY]||{};
root[JOURNAL_KEY]={
version:VERSION,
canonicalState:post.canonicalState,
nextRequiredFact:post.nextRequiredFact,
nextAction:post.nextAction,
lastStartedAt:now_(),
priorCanonicalState:pre.canonicalState,
priorNextRequiredFact:pre.nextRequiredFact,
actionResultStatus:clean_(result&&result.status),
actionResultCategory:statusCategory_(result),
actionRemoteWriteExecuted:result&&result.liveWriteExecuted===true,
totalRuns:Number(prior.totalRuns||0)+1,
updatedAt:now_()
};
return root;
}
function patchView_(row,pre,result,post){
if(!row||!row.__rowNumber)return;
var p=legacyPatch_(post,result);
p['Write Journal JSON']=safeJson_(journal_(row,pre,result,post));
if(typeof deps_().u.clearRowDataValidations==='function')deps_().u.clearRowDataValidations('SERVICE_REQUESTS',row.__rowNumber);
deps_().u.patchRow('SERVICE_REQUESTS',row.__rowNumber,p);
}
function processRequest(requestId,options){
options=options||{};
var id=clean_(requestId),row=request_(id);
if(!row)return{ok:false,version:VERSION,status:'SERVICE_REQUEST_NOT_FOUND',requestId:id,liveWriteExecuted:false};
var pre=preview(id);
if(pre.complete)return{ok:true,version:VERSION,status:'V2_ALREADY_COMPLETE',requestId:id,preview:pre,liveWriteExecuted:false};
var actionResult;
try{
actionResult=deps_().e.executeNext(id,{confirmLiveWrite:options.confirmLiveWrite===true});
}catch(e){
actionResult={ok:false,status:'V2_EXECUTION_EXCEPTION',error:String(e&&e.message||e),liveWriteExecuted:false};
}
var post=preview(id);
if(options.updateOperatorView!==false){
try{patchView_(request_(id)||row,pre,actionResult,post);}catch(viewError){
return {ok:false,version:VERSION,status:'V2_OPERATOR_VIEW_UPDATE_FAILED',requestId:id,error:String(viewError&&viewError.message||viewError),actionResult:actionResult,post:post,liveWriteExecuted:actionResult.liveWriteExecuted===true};
}
}
return {
ok:actionResult.ok===true,
version:VERSION,
status:post.complete?'V2_COMPLETE':clean_(actionResult.status),
category:statusCategory_(actionResult),
requestId:id,
before:pre,
actionResult:actionResult,
after:post,
progressed:pre.nextRequiredFact!==post.nextRequiredFact||post.complete===true,
liveWriteExecuted:actionResult.liveWriteExecuted===true
};
}
function shadowRegression(requestIds){
var ids=requestIds||[
'SR-20260914115146-4379',
'SR-20260916091328-7075',
'SR-20260915113954-1418',
'SR-20260917102650-2098',
'SR-20260916162619-7013',
'SR-20260916120406-8654',
'SR-20260916103156-1138',
'SR-20260915185727-2152',
'SR-20260908093552-3155'
];
return ids.map(function(id){
var p=preview(id);
return {requestId:id,ok:p.ok,canonicalState:p.canonicalState,nextRequiredFact:p.nextRequiredFact,nextAction:p.nextAction,complete:p.complete,liveWriteExecuted:false};
});
}
return {
version:VERSION,
preview:preview,
processRequest:processRequest,
shadowRegression:shadowRegression,
stateFromNext:stateFromNext_
};
})();
