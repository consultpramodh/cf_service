const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(require('node:path').join(__dirname,'../src/60_Striven_Write.gs'),'utf8');
const begin=src.indexOf('CF.SalesOrderInternalNotesApi ='),end=src.indexOf('\n})();',begin)+6;
function run(options={}){
 let posts=0,gets=0;
 const row={'Request ID':'r','Source System':'WEBFORM','Work Order ID':'1','Work Order Number':'2','Matched Customer ID':'3','Write Journal JSON':JSON.stringify({salesOrderCreate:{certification:{result:{canProceed:options.blocked!==true,salesOrderId:'1',customerId:'3'}}},requestSourceRepair:options.prior?{postAttempts:1}:{}}),__rowNumber:2};
 let order={id:'1',orderNumber:'2',customer:{id:'3'},status:{id:25},lineItems:[{item:{id:41481},Taxable:true}],internalNotes:{id:8,notesText:'operator'},customFields:[{id:855,value:options.existing||'0',valueText:'0',fieldType:{name:'Custom List'},isRequired:false},{id:794,value:501,valueText:'Matt',isRequired:true}]};
 const cf={Util:{findRecord:()=>row,parseJson:JSON.parse,nowString:()=> 'today',patchRow:(tab,n,p)=>Object.assign(row,p),logEvent:()=>{}},SalesOrderDraft:{build:()=>({customFields:{855:{status:'READY',value:'570'}}})},StrivenHttp:{requestJson:(url,o)=>{if(o.method==='get'){gets++;if(options.lostGet&&gets===2)throw Error('timeout');return {json:JSON.parse(JSON.stringify(order))};}posts++;if(options.lostPost)throw Error('uncertain');const dto=o.payload.customFields.find(f=>f.Id===855);order.customFields[0].value=dto.Value;order.customFields[0].valueText='Webform';if(options.collateral)order.customFields[1].value=502;return {json:order};}}};
 const ctx={CF:cf,LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},SpreadsheetApp:{flush:()=>{}}};vm.runInNewContext(src.slice(begin,end),ctx);
 const first=cf.SalesOrderInternalNotesApi.fillMissingRequestSource('r');const second=options.repeat?cf.SalesOrderInternalNotesApi.fillMissingRequestSource('r'):null;
 return {first,second,posts,row,order};
}
let x=run();assert.equal(x.first.status,'VERIFIED');assert.equal(x.posts,1);assert.equal(x.order.customFields[1].value,501);
x=run({existing:'575'});assert.equal(x.posts,0);assert.equal(x.first.status,'EXISTING_REQUEST_SOURCE_PRESERVED');
x=run({blocked:true});assert.equal(x.posts,0);
x=run({prior:true});assert.equal(x.posts,0);
x=run({collateral:true});assert.equal(x.first.ok,false);assert.equal(x.first.otherFieldsPreserved,false);
x=run({lostPost:true,repeat:true});assert.equal(x.posts,1);assert.equal(x.second.status,'PRIOR_WRITE_REQUIRES_GET_RECONCILIATION_NO_RETRY');
x=run({lostGet:true});assert.equal(x.first.status,'POST_OUTCOME_UNCERTAIN_DO_NOT_RETRY');
console.log('PASS: blank source fills once; existing values, blocked identities, uncertain writes and collateral changes remain guarded.');
