/************************************************************
 * CF ServiceOps — V2 Core Ensurers
 * Version: 0.2.0-candidate
 * Date: 2026-09-17
 *
 * PURPOSE
 * - Convert V2 business facts into one deterministic next action.
 * - Reuse proven production writers for create/location/contact/SO boundaries.
 * - Keep Customer/Contact core detail sync and relationship logic isolated.
 * - Never probe multiple mutating API contracts.
 *
 * DEFAULT SAFETY
 * - V2 live writes are disabled unless Script Property
 *   CF_SERVICEOPS_V2_WRITE_ENABLED=TRUE.
 * - Every write call also requires options.confirmLiveWrite === true.
 * - Customer-email writes require a certifiable GET shape.
 * - Relationship writes require explicit configured payload mode.
 ************************************************************/
var CF = CF || {};

CF.V2CoreEnsurers = (function () {
  'use strict';

  var VERSION = '0.2.0-candidate';
  var WRITE_FLAG = 'CF_SERVICEOPS_V2_WRITE_ENABLED';
  var REL_MODE_PROP = 'CF_SERVICEOPS_V2_RELATIONSHIP_PAYLOAD_MODE';
  var CUSTOMER_EMAIL_MODE_PROP = 'CF_SERVICEOPS_V2_CUSTOMER_EMAIL_MODE';
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

  function requiredAction_(shadow){
    if(!shadow||!shadow.ok)return {action:'STOP',reason:'SHADOW_RESOLUTION_FAILED'};
    var n=shadow.nextRequiredFact;
    var map={
      CUSTOMER_CONFIRMED:'ENSURE_CUSTOMER',
      CUSTOMER_PHONE_CONFIRMED:'ENSURE_CUSTOMER_CORE',
      CUSTOMER_EMAIL_CONFIRMED:'ENSURE_CUSTOMER_CORE',
      LOCATION_CONFIRMED:'ENSURE_LOCATION',
      CONTACT_CONFIRMED:'ENSURE_CONTACT',
      CONTACT_PHONE_CONFIRMED:'ENSURE_CONTACT_CORE',
      CONTACT_EMAIL_CONFIRMED:'ENSURE_CONTACT_CORE',
      RELATIONSHIP_CONFIRMED:'ENSURE_RELATIONSHIP',
      SALES_ORDER_CONFIRMED:'ENSURE_SALES_ORDER',
      COMPLETE:'COMPLETE'
    };
    return {action:map[n]||'STOP',reason:n||'UNKNOWN_NEXT_FACT'};
  }

  function preview(requestId){
    var shadow=deps_().r.inspectRequest(requestId,{});
    var next=requiredAction_(shadow);
    return {
      ok:shadow.ok===true,
      version:VERSION,
      mode:'PREVIEW_NO_WRITE',
      requestId:clean_(requestId),
      shadow:shadow,
      nextAction:next.action,
      nextRequiredFact:next.reason,
      writesEnabled:writesEnabled_(),
      relationshipPayloadMode:propValue_(REL_MODE_PROP)||'UNSET',
      customerEmailMode:propValue_(CUSTOMER_EMAIL_MODE_PROP)||'AUTO_FROM_GET',
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
      needsWrite:missingPhones.length>0||emailMissing,liveWriteExecuted:false
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

  function customerPayload_(remote,preview){
    var payload=clone_(remote);
    payload.Id=Number(id_(remote))||id_(remote);
    payload.Phones=mergePhones_(prop_(remote,['Phones','phones']),preview.wantedPhones);
    if(preview.emailMissing){
      var forced=upper_(propValue_(CUSTOMER_EMAIL_MODE_PROP));
      var mode=forced&&forced!=='AUTO_FROM_GET'?forced:preview.emailShape;
      if(mode==='EMAILS_ARRAY'){
        payload.Emails=mergeEmails_(prop_(remote,['Emails','emails']),preview.wantedEmail);
      }else if(mode.indexOf('SCALAR_EMAIL:')===0){
        payload[mode.split(':')[1]]=preview.wantedEmail;
      }else{
        throw new Error('V2_CUSTOMER_EMAIL_CONTRACT_UNRESOLVED | Customer GET does not expose a certified writable email shape.');
      }
    }
    delete payload.CustomFields;
    delete payload.customFields;
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
    var payload=customerPayload_(p.remote,p);
    var response=post_('/v1/customers',payload);
    var after=customerCorePreview_(r,customerId);
    if(!after.ok||after.needsWrite){
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
      return {ok:false,status:'CONTACT_CORE_POSTWRITE_VERIFICATION_FAILED_RECONCILIATION_REQUIRED',contactId:contactId,liveWriteExecuted:true,remoteWriteMayHaveSucceeded:true};
    }
    return {ok:true,status:'CONTACT_CORE_CONFIRMED_AFTER_WRITE',contactId:contactId,httpStatus:response&&response.status||200,liveWriteExecuted:true};
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
    var r=writeGate_(requestId,options),shadow=deps_().r.inspectRequest(requestId,{}),next=requiredAction_(shadow);
    if(next.action==='COMPLETE')return {ok:true,status:'V2_ALREADY_COMPLETE',requestId:requestId,liveWriteExecuted:false};
    if(next.action==='STOP')return {ok:false,status:'V2_NO_SAFE_NEXT_ACTION',requestId:requestId,reason:next.reason,liveWriteExecuted:false};

    if(next.action==='ENSURE_CUSTOMER')return callExistingCustomerEnsure_(requestId);
    if(next.action==='ENSURE_LOCATION')return callExistingLocationEnsure_(requestId);
    if(next.action==='ENSURE_CONTACT')return callExistingContactEnsure_(requestId);

    var customerId=clean_(shadow.facts&&shadow.facts.customer&&shadow.facts.customer.id);
    var contactId=clean_(shadow.facts&&shadow.facts.contact&&shadow.facts.contact.id);

    if(next.action==='ENSURE_CUSTOMER_CORE')return ensureCustomerCore_(r,customerId);
    if(next.action==='ENSURE_CONTACT_CORE')return ensureContactCore_(r,contactId);
    if(next.action==='ENSURE_RELATIONSHIP')return ensureRelationship_(customerId,contactId);
    if(next.action==='ENSURE_SALES_ORDER')return ensureSalesOrder_(requestId);
    return {ok:false,status:'V2_ACTION_NOT_IMPLEMENTED',requestId:requestId,nextAction:next.action,liveWriteExecuted:false};
  }

  function certifyContracts(requestId){
    var r=request_(requestId);
    if(!r)return {ok:false,status:'SERVICE_REQUEST_NOT_FOUND',requestId:requestId,liveWriteExecuted:false};
    var shadow=deps_().r.inspectRequest(requestId,{});
    var customerId=clean_(shadow.facts&&shadow.facts.customer&&shadow.facts.customer.id);
    var contactId=clean_(shadow.facts&&shadow.facts.contact&&shadow.facts.contact.id);
    var customer=customerId?customerCorePreview_(r,customerId):null;
    var relationship=customerId&&contactId?relationshipPreview_(customerId,contactId):null;
    return {
      ok:true,status:'V2_CONTRACT_EVIDENCE_READ_ONLY',requestId:requestId,
      customerEmailShape:customer&&customer.emailShape||'UNAVAILABLE',
      customerEmailCurrentlyPresent:customer?!customer.emailMissing:false,
      relationshipObservable:relationship&&relationship.observable===true,
      relationshipCurrentStatus:relationship&&relationship.status||'UNAVAILABLE',
      configuredRelationshipPayloadMode:propValue_(REL_MODE_PROP)||'UNSET',
      configuredCustomerEmailMode:propValue_(CUSTOMER_EMAIL_MODE_PROP)||'AUTO_FROM_GET',
      liveWriteExecuted:false
    };
  }

  return {
    version:VERSION,
    preview:preview,
    executeNext:executeNext,
    certifyContracts:certifyContracts,
    customerCorePreview:customerCorePreview_,
    contactCorePreview:contactCorePreview_,
    relationshipPreview:relationshipPreview_,
    writesEnabled:writesEnabled_
  };
})();
