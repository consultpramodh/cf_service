var CF = CF || {};
CF.V2CoreEnsurers = (function () {
'use strict';
var VERSION = '0.2.1-candidate';
var WRITE_FLAG = 'CF_SERVICEOPS_V2_WRITE_ENABLED';
var REL_MODE_PROP = 'CF_SERVICEOPS_V2_RELATIONSHIP_PAYLOAD_MODE';
var REL_ENDPOINT = '/v1/contacts/{contactId}/associate-customer';
function clean_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function upper_(v) { return clean_(v).toUpperCase(); }
function arr_(v) { return Array.isArray(v) ? v : []; }
function prop_(o,names){o=o||{};for(var i=0;i<names.length;i++)if(Object.prototype.hasOwnProperty.call(o,names[i]))return o[names[i]];return undefined;}
function clone_(v){return JSON.parse(JSON.stringify(v));}
function normPhone_(v){var x=String(v||'').replace(/\D/g,'');if(x.length===11&&x.charAt(0)==='1')x=x.slice(1);return x;}
function normEmail_(v){return String(v||'').trim().toLowerCase();}
function unique_(a){var seen={};return (a||[]).filter(function(x){x=clean_(x);if(!x||seen[x])return false;seen[x]=true;return true;});}
function deps_(){
if(!CF.Util||!CF.StrivenHttp||!CF.V2ShadowResolver)throw new Error('CF.Util, CF.StrivenHttp and CF.V2ShadowResolver are required.');
return {u:CF.Util,h:CF.StrivenHttp,r:CF.V2ShadowResolver};
}
function props_(){try{return PropertiesService.getScriptProperties();}catch(e){return null;}}
function propValue_(name){var p=props_();return p?clean_(p.getProperty(name)):'';}
function writesEnabled_(){return upper_(propValue_(WRITE_FLAG))==='TRUE';}
function request_(id){return deps_().u.findRecord('SERVICE_REQUESTS','Request ID',clean_(id));}
function id_(o){return clean_(prop_(o,['Id','id','ID','CustomerId','customerId','ContactId','contactId']));}
function body_(response){return response&&response.json&&typeof response.json==='object'?response.json:(response&&typeof response==='object'?response:{});}
function get_(path){return body_(deps_().h.requestJson(path,{method:'get',attempts:1,idempotent:true}));}
function post_(path,payload){return deps_().h.requestJson(path,{method:'post',payload:payload,attempts:1,idempotent:false});}
function endpoint_(tpl,id){return tpl.replace('{contactId}',encodeURIComponent(String(id)));}
function desiredPhones_(r){
return unique_([
normPhone_(r&&r['Normalized Phone']||r&&r['Phone']),
normPhone_(r&&r['Normalized Alt Phone']||r&&r['Alt Phone'])
]);
}
function desiredEmail_(r){return normEmail_(r&&r['Normalized Email']||r&&r['Email']);}
function remotePhones_(o){
return unique_(arr_(prop_(o,['Phones','phones'])).map(function(p){return normPhone_(prop_(p||{},['Number','number']));}));
}
function remoteEmails_(o){
var out=[];
arr_(prop_(o,['Emails','emails'])).forEach(function(e){var v=normEmail_(prop_(e||{},['Email','email','EmailAddress','emailAddress']));if(v)out.push(v);});
var scalar=normEmail_(prop_(o,['Email','email','EmailAddress','emailAddress','PrimaryEmail','primaryEmail']));
if(scalar)out.push(scalar);
return unique_(out);
}
function emailShape_(o){
if(!o||typeof o!=='object')return 'UNAVAILABLE';
if(Object.prototype.hasOwnProperty.call(o,'Emails')||Object.prototype.hasOwnProperty.call(o,'emails'))return 'EMAILS_ARRAY';
var scalarKeys=['Email','email','EmailAddress','emailAddress','PrimaryEmail','primaryEmail'];
for(var i=0;i<scalarKeys.length;i++)if(Object.prototype.hasOwnProperty.call(o,scalarKeys[i]))return 'SCALAR_EMAIL:'+scalarKeys[i];
return 'NOT_EXPOSED_BY_GET';
}
function relationshipOwners_(contact){
if(!contact||typeof contact!=='object')return {observable:false,ids:[]};
var out=[];
function add(v){v=clean_(v);if(v)out.push(v);}
add(prop_(contact,['CustomerId','customerId','CustomerID']));
var direct=prop_(contact,['Customer','customer']);
if(direct&&typeof direct==='object')add(id_(direct));
var keys=['CustomerAssociations','customerAssociations','Customers','customers'];
var observable=!!direct||!!prop_(contact,['CustomerId','customerId','CustomerID']);
keys.forEach(function(k){
if(Object.prototype.hasOwnProperty.call(contact,k))observable=true;
arr_(contact[k]).forEach(function(x){add(id_(x));});
});
return {observable:observable,ids:unique_(out)};
}
function entityRefId_(v){
if(v===null||v===undefined)return '';
if(typeof v==='object')return id_(v);
return clean_(v);
}
function primaryContactFact_(customer,contactId){
contactId=clean_(contactId);
if(!customer||typeof customer!=='object')return {ok:false,status:'CUSTOMER_REMOTE_UNAVAILABLE',confirmed:false,observable:false,primaryContactId:'',contactId:contactId};
var hasField=Object.prototype.hasOwnProperty.call(customer,'PrimaryContact')||Object.prototype.hasOwnProperty.call(customer,'primaryContact');
if(!hasField)return {ok:true,status:'PRIMARY_CONTACT_API_FIELD_UNRESOLVED',confirmed:false,observable:false,primaryContactId:'',contactId:contactId};
var ref=prop_(customer,['PrimaryContact','primaryContact']);
var primaryId=entityRefId_(ref);
if(!primaryId)return {ok:true,status:'PRIMARY_CONTACT_MISSING',confirmed:false,observable:true,primaryContactId:'',contactId:contactId};
if(!contactId)return {ok:true,status:'CONTACT_ID_MISSING',confirmed:false,observable:true,primaryContactId:primaryId,contactId:''};
if(primaryId===contactId)return {ok:true,status:'PRIMARY_CONTACT_CONFIRMED',confirmed:true,observable:true,primaryContactId:primaryId,contactId:contactId};
return {ok:true,status:'PRIMARY_CONTACT_CONFLICT',confirmed:false,observable:true,primaryContactId:primaryId,contactId:contactId};
}
function requiredActionFromFact_(n){
var map={
CUSTOMER_CONFIRMED:'ENSURE_CUSTOMER',
CUSTOMER_PHONE_CONFIRMED:'ENSURE_CUSTOMER_CORE',
LOCATION_CONFIRMED:'ENSURE_LOCATION',
CONTACT_CONFIRMED:'ENSURE_CONTACT',
CONTACT_PHONE_CONFIRMED:'ENSURE_CONTACT_CORE',
CONTACT_EMAIL_CONFIRMED:'ENSURE_CONTACT_CORE',
PRIMARY_CONTACT_CONFIRMED:'ENSURE_PRIMARY_CONTACT',
RELATIONSHIP_CONFIRMED:'ENSURE_RELATIONSHIP',
SALES_ORDER_CONFIRMED:'ENSURE_SALES_ORDER',
COMPLETE:'COMPLETE'
};
return {action:map[n]||'STOP',reason:n||'UNKNOWN_NEXT_FACT'};
}
function workflowPlan_(requestId){
var shadow=deps_().r.inspectRequest(requestId,{includeRemoteBodies:true});
if(!shadow||shadow.ok!==true){
return {ok:false,status:'SHADOW_RESOLUTION_FAILED',requestId:clean_(requestId),shadow:shadow,nextRequiredFact:'CUSTOMER_CONFIRMED',nextAction:'STOP',complete:false,liveWriteExecuted:false};
}
var f=shadow.facts||{},customer=f.customer||{},contact=f.contact||{},location=f.location||{},rawRelationship=f.relationship||{},salesOrder=f.salesOrder||{};
var customerId=clean_(customer.id),contactId=clean_(contact.id);
var primary=primaryContactFact_(shadow.remote&&shadow.remote.customer,contactId);
var relationshipConfirmed=rawRelationship.confirmed===true||primary.confirmed===true;
var effectiveRelationship={
status:relationshipConfirmed?(rawRelationship.confirmed===true?'RELATIONSHIP_CONFIRMED':'RELATIONSHIP_CONFIRMED_VIA_PRIMARY_CONTACT'):clean_(rawRelationship.status||'RELATIONSHIP_UNRESOLVED'),
confirmed:relationshipConfirmed,
customerIds:rawRelationship.customerIds||[],
rawStatus:clean_(rawRelationship.status),
confirmedViaPrimaryContact:primary.confirmed===true
};
var ordered=[
['CUSTOMER_CONFIRMED',customer.remoteConfirmed===true&&customer.identity&&customer.identity.confirmed===true],
['CUSTOMER_PHONE_CONFIRMED',customer.phone&&customer.phone.confirmed===true],
['LOCATION_CONFIRMED',location.confirmed===true],
['CONTACT_CONFIRMED',contact.remoteConfirmed===true&&contact.identity&&contact.identity.confirmed===true],
['CONTACT_PHONE_CONFIRMED',contact.phone&&contact.phone.confirmed===true],
['CONTACT_EMAIL_CONFIRMED',contact.email&&contact.email.confirmed===true],
['PRIMARY_CONTACT_CONFIRMED',primary.confirmed===true],
['RELATIONSHIP_CONFIRMED',effectiveRelationship.confirmed===true],
['SALES_ORDER_CONFIRMED',salesOrder.confirmed===true]
];
var nextFact='COMPLETE';
for(var i=0;i<ordered.length;i++){if(!ordered[i][1]){nextFact=ordered[i][0];break;}}
var next=requiredActionFromFact_(nextFact);
return {
ok:true,status:'V2_WORKFLOW_PLAN',requestId:clean_(requestId),shadow:shadow,
customerId:customerId,contactId:contactId,primaryContact:primary,effectiveRelationship:effectiveRelationship,
nextRequiredFact:nextFact,nextAction:next.action,complete:nextFact==='COMPLETE',liveWriteExecuted:false
};
}
function preview(requestId){
var plan=workflowPlan_(requestId);
return {
ok:plan.ok===true,
version:VERSION,
mode:'PREVIEW_NO_WRITE',
requestId:clean_(requestId),
shadow:plan.shadow||{},
primaryContact:plan.primaryContact||{},
effectiveRelationship:plan.effectiveRelationship||{},
nextAction:plan.nextAction||'STOP',
nextRequiredFact:plan.nextRequiredFact||'',
complete:plan.complete===true,
writesEnabled:writesEnabled_(),
relationshipPayloadMode:propValue_(REL_MODE_PROP)||'UNSET',
directCustomerEmailRequired:false,
liveWriteExecuted:false
};
}
function writeGate_(requestId,options){
options=options||{};
if(options.confirmLiveWrite!==true)throw new Error('V2_WRITE_BLOCKED | confirmLiveWrite must be true.');
if(!writesEnabled_())throw new Error('V2_WRITE_BLOCKED | '+WRITE_FLAG+' is not TRUE.');
var r=request_(requestId);
if(!r)throw new Error('V2_WRITE_BLOCKED | Service Request not found.');
if(upper_(r['Final Outcome']).indexOf('COMPLETED')===0||upper_(r['Current Stage'])==='COMPLETED'){
throw new Error('V2_WRITE_BLOCKED | Completed request cannot be mutated.');
}
var risk=upper_(r['Duplicate Risk Status']);
if(risk&&risk!=='NONE')throw new Error('V2_WRITE_BLOCKED | Duplicate Risk Status is not NONE.');
return r;
}
function callExistingCustomerEnsure_(requestId){
if(!CF.StrivenControlledCustomerCreate||typeof CF.StrivenControlledCustomerCreate.executeAutoCustomerCreate!=='function'){
return {ok:false,status:'V2_CUSTOMER_WRITER_UNAVAILABLE',liveWriteExecuted:false};
}
return CF.StrivenControlledCustomerCreate.executeAutoCustomerCreate(requestId);
}
function callExistingLocationEnsure_(requestId){
if(!CF.StandaloneLocationCreateV5128||typeof CF.StandaloneLocationCreateV5128.process!=='function'){
return {ok:false,status:'V2_LOCATION_WRITER_UNAVAILABLE',liveWriteExecuted:false};
}
return CF.StandaloneLocationCreateV5128.process(requestId,{autoMode:true,confirmLiveWrite:true});
}
function callExistingContactEnsure_(requestId){
if(!CF.StrivenControlledContactCreate||typeof CF.StrivenControlledContactCreate.executeAutoContactCreate!=='function'){
return {ok:false,status:'V2_CONTACT_WRITER_UNAVAILABLE',liveWriteExecuted:false};
}
return CF.StrivenControlledContactCreate.executeAutoContactCreate(requestId);
}
function customerCorePreview_(r,customerId){
var remote=get_('/v1/customers/'+encodeURIComponent(customerId));
if(id_(remote)!==clean_(customerId))return {ok:false,status:'CUSTOMER_GET_ID_MISMATCH',customerId:customerId};
var wantedPhones=desiredPhones_(r),actualPhones=remotePhones_(remote),wantedEmail=desiredEmail_(r),actualEmails=remoteEmails_(remote);
var missingPhones=wantedPhones.filter(function(x){return actualPhones.indexOf(x)===-1;});
var shape=emailShape_(remote),emailMissing=!!wantedEmail&&actualEmails.indexOf(wantedEmail)===-1;
return {
ok:true,status:'CUSTOMER_CORE_PREVIEW',customerId:customerId,
remote:remote,wantedPhones:wantedPhones,actualPhones:actualPhones,missingPhones:missingPhones,
wantedEmail:wantedEmail,actualEmails:actualEmails,emailMissing:emailMissing,emailShape:shape,
directCustomerEmailRequired:false,
needsWrite:missingPhones.length>0,liveWriteExecuted:false
};
}
function contactCorePreview_(r,contactId){
var remote=get_('/v1/contacts/'+encodeURIComponent(contactId));
if(id_(remote)!==clean_(contactId))return {ok:false,status:'CONTACT_GET_ID_MISMATCH',contactId:contactId};
var wantedPhones=desiredPhones_(r),actualPhones=remotePhones_(remote),wantedEmail=desiredEmail_(r),actualEmails=remoteEmails_(remote);
return {
ok:true,status:'CONTACT_CORE_PREVIEW',contactId:contactId,remote:remote,
wantedPhones:wantedPhones,actualPhones:actualPhones,
missingPhones:wantedPhones.filter(function(x){return actualPhones.indexOf(x)===-1;}),
wantedEmail:wantedEmail,actualEmails:actualEmails,
emailMissing:!!wantedEmail&&actualEmails.indexOf(wantedEmail)===-1,
liveWriteExecuted:false
};
}
function mergePhones_(remotePhones,wanted,r){
var out=arr_(remotePhones).map(clone_),seen={};
out.forEach(function(p){var n=normPhone_(prop_(p||{},['Number','number']));if(n)seen[n]=true;});
wanted.forEach(function(n){
if(seen[n])return;
out.push({Id:0,PhoneType:{Id:1,Name:'Mobile'},CountryDialCode:1,Number:n,Extension:'',IsPreferred:out.length===0,Active:true});
seen[n]=true;
});
return out;
}
function mergeEmails_(remoteEmails,wanted){
var out=arr_(remoteEmails).map(clone_),n=normEmail_(wanted),found=false,hasPrimary=false;
out.forEach(function(e){
if(normEmail_(prop_(e||{},['Email','email','EmailAddress','emailAddress']))===n)found=true;
if(prop_(e||{},['IsPrimary','isPrimary'])===true)hasPrimary=true;
});
if(n&&!found)out.push({Id:0,Email:wanted,IsPrimary:!hasPrimary,Active:true});
return out;
}
function copyRemoteField_(out,remote,key,names){
var v=prop_(remote,names||[key,key.charAt(0).toLowerCase()+key.slice(1)]);
if(v!==undefined&&v!==null)out[key]=clone_(v);
}
function customerPayload_(remote,phones,primaryContactId){
var payload={Id:Number(id_(remote))||id_(remote)};
copyRemoteField_(payload,remote,'Name',['Name','name']);
copyRemoteField_(payload,remote,'Number',['Number','number']);
copyRemoteField_(payload,remote,'IsVendor',['IsVendor','isVendor']);
copyRemoteField_(payload,remote,'IsConsumerAccount',['IsConsumerAccount','isConsumerAccount']);
copyRemoteField_(payload,remote,'Status',['Status','status']);
copyRemoteField_(payload,remote,'Categories',['Categories','categories']);
copyRemoteField_(payload,remote,'ReferralSource',['ReferralSource','referralSource']);
copyRemoteField_(payload,remote,'Industry',['Industry','industry']);
copyRemoteField_(payload,remote,'CustomerSince',['CustomerSince','customerSince']);
copyRemoteField_(payload,remote,'CreditLimit',['CreditLimit','creditLimit']);
copyRemoteField_(payload,remote,'WebSite',['WebSite','webSite']);
copyRemoteField_(payload,remote,'IsTaxExempt',['IsTaxExempt','isTaxExempt']);
copyRemoteField_(payload,remote,'IsFinanceChargeExempt',['IsFinanceChargeExempt','isFinanceChargeExempt']);
copyRemoteField_(payload,remote,'PaymentTerm',['PaymentTerm','paymentTerm']);
copyRemoteField_(payload,remote,'BillToLocation',['BillToLocation','billToLocation']);
copyRemoteField_(payload,remote,'ShipToLocation',['ShipToLocation','shipToLocation']);
copyRemoteField_(payload,remote,'PrimaryAddress',['PrimaryAddress','primaryAddress']);
copyRemoteField_(payload,remote,'PriceList',['PriceList','priceList']);
copyRemoteField_(payload,remote,'Currency',['Currency','currency']);
var currentPrimary=prop_(remote,['PrimaryContact','primaryContact']);
if(primaryContactId){payload.PrimaryContact={Id:Number(primaryContactId)||primaryContactId};}
else if(currentPrimary!==undefined&&currentPrimary!==null)payload.PrimaryContact=clone_(currentPrimary);
payload.Phones=phones!==undefined?clone_(phones):clone_(arr_(prop_(remote,['Phones','phones'])));
return payload;
}
function contactPayload_(remote,preview){
var payload=clone_(remote);
payload.Id=Number(id_(remote))||id_(remote);
payload.Phones=mergePhones_(prop_(remote,['Phones','phones']),preview.wantedPhones);
if(preview.wantedEmail){
payload.Emails=mergeEmails_(prop_(remote,['Emails','emails']),preview.wantedEmail);
}
return payload;
}
function ensureCustomerCore_(r,customerId){
var p=customerCorePreview_(r,customerId);
if(!p.ok||!p.needsWrite)return p.ok?{ok:true,status:'CUSTOMER_CORE_CONFIRMED',customerId:customerId,liveWriteExecuted:false}:p;
var payload=customerPayload_(p.remote,mergePhones_(prop_(p.remote,['Phones','phones']),p.wantedPhones),'');
var response=post_('/v1/customers',payload);
var after=customerCorePreview_(r,customerId);
if(!after.ok||after.missingPhones.length){
return {ok:false,status:'CUSTOMER_CORE_POSTWRITE_VERIFICATION_FAILED_RECONCILE_REQUIRED',customerId:customerId,liveWriteExecuted:true,remoteWriteMayHaveSucceeded:true};
}
return {ok:true,status:'CUSTOMER_CORE_CONFIRMED_AFTER_WRITE',customerId:customerId,httpStatus:response&&response.status||200,liveWriteExecuted:true};
}
function ensureContactCore_(r,contactId){
var p=contactCorePreview_(r,contactId);
if(!p.ok)return p;
if(!p.missingPhones.length&&!p.emailMissing)return {ok:true,status:'CONTACT_CORE_CONFIRMED',contactId:contactId,liveWriteExecuted:false};
var payload=contactPayload_(p.remote,p),response=post_('/v1/contacts',payload),after=contactCorePreview_(r,contactId);
if(!after.ok||after.missingPhones.length||after.emailMissing){
return {ok:false,status:'CONTACT_CORE_POSTWRITE_VERIFICATION_FAILED_RECONCILE_REQUIRED',contactId:contactId,liveWriteExecuted:true,remoteWriteMayHaveSucceeded:true};
}
return {ok:true,status:'CONTACT_CORE_CONFIRMED_AFTER_WRITE',contactId:contactId,httpStatus:response&&response.status||200,liveWriteExecuted:true};
}
function primaryContactPreview_(customerId,contactId){
customerId=clean_(customerId);contactId=clean_(contactId);
if(!customerId)return {ok:false,status:'CUSTOMER_ID_MISSING',confirmed:false,observable:false,customerId:'',contactId:contactId,primaryContactId:'',liveWriteExecuted:false};
var remote=get_('/v1/customers/'+encodeURIComponent(customerId));
if(id_(remote)!==customerId)return {ok:false,status:'CUSTOMER_GET_ID_MISMATCH',confirmed:false,observable:false,customerId:customerId,contactId:contactId,primaryContactId:'',liveWriteExecuted:false};
var fact=primaryContactFact_(remote,contactId);
fact.customerId=customerId;fact.remote=remote;fact.liveWriteExecuted=false;
return fact;
}
function ensurePrimaryContact_(customerId,contactId){
var p=primaryContactPreview_(customerId,contactId);
if(!p.ok||p.confirmed)return p;
if(!p.observable)return {ok:false,status:'PRIMARY_CONTACT_CONTRACT_UNRESOLVED',customerId:customerId,contactId:contactId,liveWriteExecuted:false};
if(p.primaryContactId&&p.primaryContactId!==clean_(contactId)){
return {ok:false,status:'PRIMARY_CONTACT_CONFLICT_HUMAN_REVIEW',customerId:customerId,contactId:contactId,existingPrimaryContactId:p.primaryContactId,liveWriteExecuted:false};
}
var payload=customerPayload_(p.remote,arr_(prop_(p.remote,['Phones','phones'])),contactId);
var response=post_('/v1/customers',payload);
var after=primaryContactPreview_(customerId,contactId);
if(!after.ok||!after.confirmed){
return {ok:false,status:'PRIMARY_CONTACT_POSTWRITE_VERIFICATION_FAILED_RECONCILE_REQUIRED',customerId:customerId,contactId:contactId,liveWriteExecuted:true,remoteWriteMayHaveSucceeded:true};
}
return {ok:true,status:'PRIMARY_CONTACT_CONFIRMED_AFTER_WRITE',customerId:customerId,contactId:contactId,httpStatus:response&&response.status||200,liveWriteExecuted:true};
}
function relationshipPreview_(customerId,contactId){
var remote=get_('/v1/contacts/'+encodeURIComponent(contactId));
if(id_(remote)!==clean_(contactId))return {ok:false,status:'CONTACT_GET_ID_MISMATCH',contactId:contactId,liveWriteExecuted:false};
var owners=relationshipOwners_(remote);
return {
ok:true,status:owners.ids.indexOf(clean_(customerId))!==-1?'RELATIONSHIP_CONFIRMED':(owners.ids.length?'RELATIONSHIP_CONFLICT':'RELATIONSHIP_MISSING'),
customerId:clean_(customerId),contactId:clean_(contactId),observable:owners.observable,ownerCustomerIds:owners.ids,
confirmed:owners.ids.indexOf(clean_(customerId))!==-1,liveWriteExecuted:false
};
}
function relationshipPayload_(customerId){
var mode=upper_(propValue_(REL_MODE_PROP));
if(mode==='CUSTOMER_OBJECT')return {Customer:{Id:Number(customerId)||customerId}};
if(mode==='CUSTOMER_ID')return {CustomerId:Number(customerId)||customerId};
if(mode==='CUSTOMER_OBJECT_WITH_ID')return {Customer:{CustomerId:Number(customerId)||customerId}};
throw new Error('V2_RELATIONSHIP_CONTRACT_UNRESOLVED | Set '+REL_MODE_PROP+' to one certified payload mode. No mutating endpoint probes are allowed.');
}
function ensureRelationship_(customerId,contactId){
var p=relationshipPreview_(customerId,contactId);
if(!p.ok||p.confirmed)return p;
if(p.ownerCustomerIds.length){
return {ok:false,status:'RELATIONSHIP_CONFLICT_HUMAN_REVIEW',customerId:customerId,contactId:contactId,ownerCustomerIds:p.ownerCustomerIds,liveWriteExecuted:false};
}
var payload=relationshipPayload_(customerId);
post_(endpoint_(REL_ENDPOINT,contactId),payload);
var after=relationshipPreview_(customerId,contactId);
if(!after.confirmed){
return {ok:false,status:'RELATIONSHIP_POSTWRITE_VERIFICATION_FAILED_RECONCILE_REQUIRED',customerId:customerId,contactId:contactId,liveWriteExecuted:true,remoteWriteMayHaveSucceeded:true};
}
after.status='RELATIONSHIP_CONFIRMED_AFTER_WRITE';after.liveWriteExecuted=true;return after;
}
function ensureSalesOrder_(requestId){
if(!CF.OrderPreflight||typeof CF.OrderPreflight.previewRequest!=='function'||typeof CF.OrderPreflight.approveRequest!=='function'||typeof CF.OrderPreflight.executeApproved!=='function'){
return {ok:false,status:'V2_SALES_ORDER_WRITER_UNAVAILABLE',liveWriteExecuted:false};
}
var preview=CF.OrderPreflight.previewRequest(requestId);
if(preview&&preview.certifiedExisting===true)return {ok:true,status:'SALES_ORDER_ALREADY_CONFIRMED',preview:preview,liveWriteExecuted:false};
if(preview&&preview.ok===false)return {ok:false,status:'SALES_ORDER_PREFLIGHT_BLOCKED',preview:preview,liveWriteExecuted:false};
var approval=CF.OrderPreflight.approveRequest(requestId);
if(approval&&approval.ok===false)return {ok:false,status:'SALES_ORDER_APPROVAL_BLOCKED',approval:approval,liveWriteExecuted:false};
return CF.OrderPreflight.executeApproved(requestId,{executionToken:CF.OrderPreflight.executionToken});
}
function executeNext(requestId,options){
var r=writeGate_(requestId,options),plan=workflowPlan_(requestId),action=clean_(plan.nextAction);
if(action==='COMPLETE')return {ok:true,status:'V2_ALREADY_COMPLETE',requestId:requestId,liveWriteExecuted:false};
if(action==='STOP')return {ok:false,status:'V2_NO_SAFE_NEXT_ACTION',requestId:requestId,reason:plan.nextRequiredFact,liveWriteExecuted:false};
if(action==='ENSURE_CUSTOMER')return callExistingCustomerEnsure_(requestId);
if(action==='ENSURE_LOCATION')return callExistingLocationEnsure_(requestId);
if(action==='ENSURE_CONTACT')return callExistingContactEnsure_(requestId);
var customerId=clean_(plan.customerId),contactId=clean_(plan.contactId);
if(action==='ENSURE_CUSTOMER_CORE')return ensureCustomerCore_(r,customerId);
if(action==='ENSURE_CONTACT_CORE')return ensureContactCore_(r,contactId);
if(action==='ENSURE_PRIMARY_CONTACT')return ensurePrimaryContact_(customerId,contactId);
if(action==='ENSURE_RELATIONSHIP')return ensureRelationship_(customerId,contactId);
if(action==='ENSURE_SALES_ORDER')return ensureSalesOrder_(requestId);
return {ok:false,status:'V2_ACTION_NOT_IMPLEMENTED',requestId:requestId,nextAction:action,liveWriteExecuted:false};
}
function certifyContracts(requestId){
var r=request_(requestId);
if(!r)return {ok:false,status:'SERVICE_REQUEST_NOT_FOUND',requestId:requestId,liveWriteExecuted:false};
var plan=workflowPlan_(requestId),shadow=plan.shadow||{};
var customerId=clean_(plan.customerId),contactId=clean_(plan.contactId);
var customer=customerId?customerCorePreview_(r,customerId):null;
var relationship=customerId&&contactId?relationshipPreview_(customerId,contactId):null;
var primary=plan.primaryContact||{};
return {
ok:true,status:'V2_CONTRACT_EVIDENCE_READ_ONLY',requestId:requestId,
customerEmailShape:customer&&customer.emailShape||'UNAVAILABLE',
directCustomerEmailRequired:false,
customerFacingEmailSource:'PRIMARY_CONTACT',
primaryContactObservable:primary.observable===true,
primaryContactCurrentStatus:primary.status||'UNAVAILABLE',
primaryContactId:primary.primaryContactId||'',
primaryContactMatchesSelectedContact:primary.confirmed===true,
relationshipObservable:relationship&&relationship.observable===true,
relationshipCurrentStatus:relationship&&relationship.status||'UNAVAILABLE',
relationshipEffectiveStatus:plan.effectiveRelationship&&plan.effectiveRelationship.status||'UNAVAILABLE',
relationshipConfirmedViaPrimaryContact:plan.effectiveRelationship&&plan.effectiveRelationship.confirmedViaPrimaryContact===true,
configuredRelationshipPayloadMode:propValue_(REL_MODE_PROP)||'UNSET',
liveWriteExecuted:false
};
}
return {
version:VERSION,
preview:preview,
workflowPlan:workflowPlan_,
executeNext:executeNext,
certifyContracts:certifyContracts,
customerCorePreview:customerCorePreview_,
contactCorePreview:contactCorePreview_,
primaryContactPreview:primaryContactPreview_,
relationshipPreview:relationshipPreview_,
writesEnabled:writesEnabled_
};
})();
