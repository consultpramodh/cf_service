const fs=require('fs');
const vm=require('vm');
const assert=require('assert');

const props={CF_SERVICEOPS_V2_WRITE_ENABLED:'FALSE',CF_SERVICEOPS_V2_MODE:'SHADOW'};
global.PropertiesService={getScriptProperties:()=>({
  getProperty:k=>props[k]||'',
  setProperty:(k,v)=>{props[k]=String(v);}
})};

const row={
  'Request ID':'SR-TEST-1','First Name':'Test','Last Name':'Customer','Full Name':'Test Customer',
  'Phone':'289-555-1000','Normalized Phone':'2895551000','Alt Phone':'289-555-2000','Normalized Alt Phone':'2895552000','Email':'test@example.com','Normalized Email':'test@example.com',
  'Matched Customer ID':'100','Created Customer ID':'100','Matched Contact ID':'200','Created Contact ID':'200',
  'Matched Location ID':'300','Created Location ID':'300','Location Match Status':'MATCHED',
  'Duplicate Risk Status':'NONE','Current Stage':'CUSTOMER STRUCTURE COMPLETE','Final Outcome':'',
  'Customer Structure Status':'COMPLETE','Reconciliation Status':'','Work Order ID':'','Work Order Number':'','Work Order Status':'',
  '__rowNumber':2
};
const customer={
  Id:100,Name:'Test Customer',IsConsumerAccount:true,
  PrimaryContact:{Id:200,Name:'Test Customer'},
  Phones:[{Id:1,PhoneType:{Id:1,Name:'Mobile'},CountryDialCode:1,Number:'2895551000',IsPreferred:true,Active:true}],
  CustomFields:[{Id:694,IsRequired:true,Value:''}]
};
const contact={
  Id:200,FirstName:'Test',LastName:'Customer',
  Phones:[{Id:3,PhoneType:{Id:1,Name:'Mobile'},CountryDialCode:1,Number:'2895551000',IsPreferred:true,Active:true}],
  Emails:[{Id:4,Email:'test@example.com',IsPrimary:true,Active:true}],
  CustomerAssociations:[]
};
const calls=[];

global.CF={};
CF.Util={
  findRecord:(sheet,key,id)=>id===row['Request ID']?row:null,
  safeJson:JSON.stringify,nowString:()=>new Date(0).toISOString(),
  patchRow:()=>{},clearRowDataValidations:()=>{}
};
CF.StrivenHttp={requestJson:(path,opt)=>{
  calls.push({path,opt:JSON.parse(JSON.stringify(opt||{}))});
  if((opt.method||'get').toLowerCase()==='get'){
    if(path==='/v1/customers/100')return {status:200,json:JSON.parse(JSON.stringify(customer))};
    if(path==='/v1/contacts/200')return {status:200,json:JSON.parse(JSON.stringify(contact))};
    throw new Error('Unexpected GET '+path);
  }
  if(path==='/v1/customers'){
    Object.keys(customer).forEach(k=>delete customer[k]);Object.assign(customer,JSON.parse(JSON.stringify(opt.payload)));
    return {status:200,json:{Id:100}};
  }
  if(path==='/v1/contacts'){
    Object.keys(contact).forEach(k=>delete contact[k]);Object.assign(contact,JSON.parse(JSON.stringify(opt.payload)));
    return {status:200,json:{Id:200}};
  }
  if(path==='/v1/contacts/200/associate-customer'){
    const id=String(opt.payload.Customer&&opt.payload.Customer.Id||opt.payload.CustomerId||'');
    contact.CustomerAssociations=[{Id:Number(id)}];
    return {status:200,json:{}};
  }
  throw new Error('Unexpected POST '+path);
}};

function relationshipFromContact(){
  const ids=(contact.CustomerAssociations||[]).map(x=>String(x.Id||x.CustomerId||''));
  return {status:ids.includes('100')?'CONFIRMED':(ids.length?'CONFLICT':'MISSING'),confirmed:ids.includes('100'),customerIds:ids};
}
let forceVerifiedSalesOrder=false;
function makeShadow(next){
  return {
    ok:true,version:'test',requestId:row['Request ID'],nextRequiredFact:next,complete:next==='COMPLETE',
    facts:{
      customer:{id:'100',remoteConfirmed:true,remoteReadStatus:'GET_CONFIRMED',identity:{status:'CONFIRMED',confirmed:true},phone:{status:next==='CUSTOMER_PHONE_CONFIRMED'?'MISSING':'CONFIRMED',confirmed:next!=='CUSTOMER_PHONE_CONFIRMED'},email:{status:'API_FIELD_UNRESOLVED',confirmed:false},emailApiShape:'NOT_EXPOSED_BY_GET'},
      contact:{id:'200',remoteConfirmed:true,remoteReadStatus:'GET_CONFIRMED',identity:{status:'CONFIRMED',confirmed:true},phone:{status:next==='CONTACT_PHONE_CONFIRMED'?'MISSING':'CONFIRMED',confirmed:next!=='CONTACT_PHONE_CONFIRMED'},email:{status:next==='CONTACT_EMAIL_CONFIRMED'?'MISSING':'CONFIRMED',confirmed:next!=='CONTACT_EMAIL_CONFIRMED'}},
      location:{id:'300',status:'CONFIRMED',confirmed:true},
      relationship:relationshipFromContact(),
      salesOrder:{status:(next==='COMPLETE'||forceVerifiedSalesOrder)?'CONFIRMED':'MISSING',confirmed:(next==='COMPLETE'||forceVerifiedSalesOrder),id:(next==='COMPLETE'||forceVerifiedSalesOrder)?'400':'',number:(next==='COMPLETE'||forceVerifiedSalesOrder)?'500':''}
    }
  };
}
let shadowNext='COMPLETE';
CF.V2ShadowResolver={inspectRequest:(id,opt)=>{
  const s=makeShadow(shadowNext);
  if(opt&&opt.includeRemoteBodies===true)s.remote={customer:JSON.parse(JSON.stringify(customer)),contact:JSON.parse(JSON.stringify(contact))};
  return s;
}};

CF.StrivenControlledCustomerCreate={executeAutoCustomerCreate:()=>({ok:true,status:'CUSTOMER_CONFIRMED',liveWriteExecuted:true})};
CF.StandaloneLocationCreateV5128={process:()=>({ok:true,status:'LOCATION_CONFIRMED',liveWriteExecuted:true})};
CF.StrivenControlledContactCreate={executeAutoContactCreate:()=>({ok:true,status:'CONTACT_CONFIRMED',liveWriteExecuted:true})};
CF.OrderPreflight={
  executionToken:'TOKEN',
  previewRequest:()=>({ok:true}),
  approveRequest:()=>({ok:true}),
  executeApproved:()=>({ok:true,status:'SALES_ORDER_CREATED_VERIFIED',liveWriteExecuted:true})
};

for(const f of ['CF_ServiceOps_V2_Core_Ensurers.gs','CF_ServiceOps_V2_Orchestrator.gs','CF_ServiceOps_V2_Migration.gs']){
  vm.runInThisContext(fs.readFileSync(__dirname+'/../'+f,'utf8'),{filename:f});
}

shadowNext='CUSTOMER_PHONE_CONFIRMED';
let p=CF.V2CoreEnsurers.preview(row['Request ID']);
assert.equal(p.nextAction,'ENSURE_CUSTOMER_CORE');
assert.equal(p.nextRequiredFact,'CUSTOMER_PHONE_CONFIRMED');

let blocked=false;
try{CF.V2CoreEnsurers.executeNext(row['Request ID'],{confirmLiveWrite:true});}catch(e){blocked=/WRITE_BLOCKED/.test(e.message);}
assert.equal(blocked,true);

let cert=CF.V2CoreEnsurers.certifyContracts(row['Request ID']);
assert.equal(cert.customerEmailShape,'NOT_EXPOSED_BY_GET');
assert.equal(cert.directCustomerEmailRequired,false);
assert.equal(cert.primaryContactCurrentStatus,'PRIMARY_CONTACT_CONFIRMED');
assert.equal(cert.primaryContactId,'200');
assert.equal(cert.relationshipEffectiveStatus,'RELATIONSHIP_CONFIRMED_VIA_PRIMARY_CONTACT');

customer.Phones=[];
props.CF_SERVICEOPS_V2_WRITE_ENABLED='TRUE';
shadowNext='CUSTOMER_PHONE_CONFIRMED';
calls.length=0;
let cr=CF.V2CoreEnsurers.executeNext(row['Request ID'],{confirmLiveWrite:true});
assert.equal(cr.ok,true);
assert.equal(cr.status,'CUSTOMER_CORE_CONFIRMED_AFTER_WRITE');
const customerPost=calls.find(x=>x.path==='/v1/customers'&&x.opt.method==='post');
assert(customerPost);
assert.equal(Object.prototype.hasOwnProperty.call(customerPost.opt.payload,'CustomFields'),false);
assert.equal(Object.prototype.hasOwnProperty.call(customerPost.opt.payload,'Emails'),false);
assert(customerPost.opt.payload.Phones.some(x=>String(x.Number).replace(/\D/g,'')==='2895551000'));
assert(!customerPost.opt.payload.Phones.some(x=>String(x.Number).replace(/\D/g,'')==='2895552000'));

let cp=CF.V2CoreEnsurers.customerCorePreview(row,'100');
assert.deepStrictEqual(cp.wantedPhones,['2895551000']);
assert.equal(cp.emailShape,'NOT_EXPOSED_BY_GET');
assert.equal(cp.emailMissing,true);
assert.equal(cp.directCustomerEmailRequired,false);
assert.equal(cp.needsWrite,false);

forceVerifiedSalesOrder=true;
shadowNext='CUSTOMER_PHONE_CONFIRMED';
let legacyTerminal=CF.V2CoreEnsurers.preview(row['Request ID']);
assert.equal(legacyTerminal.nextRequiredFact,'COMPLETE');
assert.equal(legacyTerminal.terminalReason,'EXISTING_VERIFIED_SALES_ORDER');
forceVerifiedSalesOrder=false;

customer.PrimaryContact=null;
shadowNext='PRIMARY_CONTACT_CONFIRMED';
calls.length=0;
p=CF.V2CoreEnsurers.preview(row['Request ID']);
assert.equal(p.nextRequiredFact,'PRIMARY_CONTACT_CONFIRMED');
assert.equal(p.nextAction,'ENSURE_PRIMARY_CONTACT');

let pr=CF.V2CoreEnsurers.executeNext(row['Request ID'],{confirmLiveWrite:true});
assert.equal(pr.ok,true);
assert.equal(pr.status,'PRIMARY_CONTACT_CONFIRMED_AFTER_WRITE');
assert.equal(String(customer.PrimaryContact.Id),'200');
assert.equal(calls.filter(x=>x.path==='/v1/customers'&&x.opt.method==='post').length,1);

contact.CustomerAssociations=[];
calls.length=0;
p=CF.V2CoreEnsurers.preview(row['Request ID']);
assert.equal(p.effectiveRelationship.confirmed,true);
assert.equal(p.effectiveRelationship.confirmedViaPrimaryContact,true);
assert.equal(calls.filter(x=>x.path.includes('associate-customer')&&x.opt.method==='post').length,0);

customer.PrimaryContact={Id:999,Name:'Other Person'};
shadowNext='PRIMARY_CONTACT_CONFIRMED';
calls.length=0;
p=CF.V2CoreEnsurers.preview(row['Request ID']);
assert.equal(p.nextRequiredFact,'PRIMARY_CONTACT_CONFIRMED');
let conflict=CF.V2CoreEnsurers.executeNext(row['Request ID'],{confirmLiveWrite:true});
assert.equal(conflict.ok,false);
assert.equal(conflict.status,'PRIMARY_CONTACT_CONFLICT_HUMAN_REVIEW');
assert.equal(calls.filter(x=>x.opt.method==='post').length,0);

customer.PrimaryContact={Id:200,Name:'Test Customer'};
shadowNext='CONTACT_PHONE_CONFIRMED';
let op=CF.V2Orchestrator.preview(row['Request ID']);
assert.equal(op.canonicalState,'SYNCING_CONTACT_CORE');
assert.equal(op.nextAction,'ENSURE_CONTACT_CORE');

shadowNext='COMPLETE';
op=CF.V2Orchestrator.preview(row['Request ID']);
assert.equal(op.facts.primaryContact.status,'PRIMARY_CONTACT_CONFIRMED');
assert.equal(op.nextRequiredFact,'COMPLETE');

props.CF_SERVICEOPS_V2_MODE='SHADOW';
let mr=CF.V2Migration.process(row['Request ID'],{confirmLiveWrite:true});
assert.equal(mr.status,'V2_NOT_CONTROLLING_REQUEST');
assert.equal(mr.liveWriteExecuted,false);
let sm=CF.V2Migration.setShadowMode();
assert.equal(props.CF_SERVICEOPS_V2_WRITE_ENABLED,'FALSE');
assert.equal(sm.mode,'SHADOW');

let readiness=CF.V2Migration.readiness();
assert.equal(readiness.ok,true);
assert.equal(readiness.relationshipPayloadModeReady,false);

let selected=CF.V2Migration.setSelectedMode([row['Request ID']]);
assert.equal(selected.mode,'SELECTED');
assert.equal(props.CF_SERVICEOPS_V2_WRITE_ENABLED,'TRUE');
assert.equal(CF.V2Migration.isV2Request(row['Request ID']),true);

props.CF_SERVICEOPS_V2_SELECTED_REQUEST_IDS='SR-OTHER';
calls.length=0;
let notSelected=CF.V2Migration.process(row['Request ID'],{confirmLiveWrite:true});
assert.equal(notSelected.status,'V2_REQUEST_NOT_SELECTED');
assert.equal(notSelected.liveWriteExecuted,false);
assert.equal(calls.filter(x=>x.opt.method==='post').length,0);

CF.V2Migration.setShadowMode();

console.log('V2_CONTROLLER_TEST_PASS');
console.log(JSON.stringify({tests:15,posts:calls.filter(x=>x.opt.method==='post').length,relationshipPosts:calls.filter(x=>x.path.includes('associate-customer')&&x.opt.method==='post').length}));
