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
  'Phone':'289-555-1000','Normalized Phone':'2895551000','Email':'test@example.com','Normalized Email':'test@example.com',
  'Matched Customer ID':'100','Created Customer ID':'100','Matched Contact ID':'200','Created Contact ID':'200',
  'Matched Location ID':'300','Created Location ID':'300','Location Match Status':'MATCHED',
  'Duplicate Risk Status':'NONE','Current Stage':'CUSTOMER STRUCTURE COMPLETE','Final Outcome':'',
  'Customer Structure Status':'COMPLETE','Reconciliation Status':'','Work Order ID':'','Work Order Number':'','Work Order Status':'',
  '__rowNumber':2
};
const customer={Id:100,Name:'Test Customer',Phones:[{Id:1,PhoneType:{Id:1,Name:'Mobile'},CountryDialCode:1,Number:'2895551000',IsPreferred:true,Active:true}],Emails:[{Id:2,Email:'test@example.com',IsPrimary:true,Active:true}],CustomFields:[{Id:694,IsRequired:true,Value:''}]};
const contact={Id:200,FirstName:'Test',LastName:'Customer',Phones:[{Id:3,PhoneType:{Id:1,Name:'Mobile'},CountryDialCode:1,Number:'2895551000',IsPreferred:true,Active:true}],Emails:[{Id:4,Email:'test@example.com',IsPrimary:true,Active:true}],CustomerAssociations:[{Id:100}]};
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

function makeShadow(next){
  return {
    ok:true,version:'test',requestId:row['Request ID'],nextRequiredFact:next,complete:next==='COMPLETE',
    facts:{
      customer:{id:'100',remoteConfirmed:true,remoteReadStatus:'GET_CONFIRMED',identity:{status:'CONFIRMED',confirmed:true},phone:{status:next==='CUSTOMER_PHONE_CONFIRMED'?'MISSING':'CONFIRMED',confirmed:next!=='CUSTOMER_PHONE_CONFIRMED'},email:{status:'CONFIRMED',confirmed:true},emailApiShape:'EMAILS_ARRAY'},
      contact:{id:'200',remoteConfirmed:true,remoteReadStatus:'GET_CONFIRMED',identity:{status:'CONFIRMED',confirmed:true},phone:{status:'CONFIRMED',confirmed:true},email:{status:'CONFIRMED',confirmed:true}},
      location:{id:'300',status:'CONFIRMED',confirmed:true},
      relationship:{status:'CONFIRMED',confirmed:true,customerIds:['100']},
      salesOrder:{status:next==='SALES_ORDER_CONFIRMED'?'MISSING':'CONFIRMED',confirmed:next!=='SALES_ORDER_CONFIRMED',id:next==='SALES_ORDER_CONFIRMED'?'':'400',number:next==='SALES_ORDER_CONFIRMED'?'':'500'}
    }
  };
}
let shadowNext='COMPLETE';
CF.V2ShadowResolver={inspectRequest:()=>makeShadow(shadowNext)};

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

let blocked=false;
try{CF.V2CoreEnsurers.executeNext(row['Request ID'],{confirmLiveWrite:true});}catch(e){blocked=/WRITE_BLOCKED/.test(e.message);}
assert.equal(blocked,true);

let cert=CF.V2CoreEnsurers.certifyContracts(row['Request ID']);
assert.equal(cert.customerEmailShape,'EMAILS_ARRAY');
assert.equal(cert.relationshipCurrentStatus,'RELATIONSHIP_CONFIRMED');

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
assert(customerPost.opt.payload.Phones.some(x=>String(x.Number).replace(/\D/g,'')==='2895551000'));

customer.Emails=[];
shadowNext='CUSTOMER_EMAIL_CONFIRMED';
calls.length=0;
cr=CF.V2CoreEnsurers.executeNext(row['Request ID'],{confirmLiveWrite:true});
assert.equal(cr.ok,true);
assert(customer.Emails.some(x=>String(x.Email).toLowerCase()==='test@example.com'));

contact.CustomerAssociations=[];
shadowNext='RELATIONSHIP_CONFIRMED';
delete props.CF_SERVICEOPS_V2_RELATIONSHIP_PAYLOAD_MODE;
let relBlocked=false;
try{CF.V2CoreEnsurers.executeNext(row['Request ID'],{confirmLiveWrite:true});}catch(e){relBlocked=/RELATIONSHIP_CONTRACT_UNRESOLVED/.test(e.message);}
assert.equal(relBlocked,true);

props.CF_SERVICEOPS_V2_RELATIONSHIP_PAYLOAD_MODE='CUSTOMER_OBJECT';
calls.length=0;
let rr=CF.V2CoreEnsurers.executeNext(row['Request ID'],{confirmLiveWrite:true});
assert.equal(rr.ok,true);
assert.equal(rr.status,'RELATIONSHIP_CONFIRMED_AFTER_WRITE');
assert.equal(calls.filter(x=>x.path==='/v1/contacts/200/associate-customer'&&x.opt.method==='post').length,1);

shadowNext='CONTACT_PHONE_CONFIRMED';
let op=CF.V2Orchestrator.preview(row['Request ID']);
assert.equal(op.canonicalState,'SYNCING_CONTACT_CORE');
assert.equal(op.nextAction,'ENSURE_CONTACT_CORE');

props.CF_SERVICEOPS_V2_MODE='SHADOW';
let mr=CF.V2Migration.process(row['Request ID'],{confirmLiveWrite:true});
assert.equal(mr.status,'V2_NOT_CONTROLLING_REQUEST');
assert.equal(mr.liveWriteExecuted,false);

let sm=CF.V2Migration.setShadowMode();
assert.equal(props.CF_SERVICEOPS_V2_WRITE_ENABLED,'FALSE');
assert.equal(sm.mode,'SHADOW');

console.log('V2_CONTROLLER_TEST_PASS');
console.log(JSON.stringify({tests:9,posts:calls.filter(x=>x.opt.method==='post').length,relationshipPosts:calls.filter(x=>x.path.includes('associate-customer')&&x.opt.method==='post').length}));
