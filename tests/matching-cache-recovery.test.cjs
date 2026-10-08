const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const text=fs.readFileSync(path.join(__dirname,'../src/70_Workflow_Automation.gs'),'utf8');
const start=text.indexOf('CF.CustomerStructureEngine = (function () {');
const end=text.indexOf('\n})();',start)+6;
function run({customers=0,locations=10,missing=[],cooldown=false}){
 const calls={customer:0,location:0,matching:0,patches:[]};
 const row={'Request ID':'SR-test','Current Stage':'NEW INTAKE',__rowNumber:2};
 const util={cleanText:v=>v==null?'':String(v).trim(),findRecord:()=>row,patchRow:(key,num,p)=>{calls.patches.push(p);Object.assign(row,p);},nowString:()=>new Date(),logEvent:()=>{}};
 const CF={Config:{isTerminalState:()=>false},Util:util,Matching:{recheckRequest:()=>{calls.matching++;return{ok:true,requestId:'SR-test'};}},StrivenControlledCustomerCreate:{},StrivenControlledContactCreate:{},StrivenData:{inspectReadiness:()=>({ok:customers>0&&locations>0&&missing.length===0,counts:{customers,locations},requiredMissing:missing}),refreshCustomerData:options=>{calls.customer++;assert.equal(JSON.stringify(options),'{}');return cooldown?{ok:true,status:'BULK_REFRESH_SKIPPED_COOLDOWN'}:{ok:true,rowsPrepared:20};},refreshLocationData:()=>{calls.location++;return{ok:true,rowsPrepared:20};}}};
 vm.runInNewContext(text.slice(start,end),{CF,SpreadsheetApp:{flush:()=>{}},Date,Number});
 return{out:CF.CustomerStructureEngine.step('SR-test'),calls};
}
let r=run({});assert.equal(r.out.status,'MATCHING_CACHE_RESTORED');assert.equal(r.calls.customer,1);assert.equal(r.calls.location,0);assert.equal(r.calls.matching,0);assert.equal(r.out.liveWriteExecuted,false);
r=run({customers:20,locations:0});assert.equal(r.calls.location,1);assert.equal(r.calls.customer,0);
r=run({customers:20,locations:10});assert.equal(r.calls.matching,1);assert.equal(r.calls.customer,0);
r=run({missing:['CUSTOMERS']});assert.equal(r.calls.customer,0);assert.equal(r.calls.location,0);
r=run({cooldown:true});assert.equal(r.out.status,'MATCHING_CACHE_RECOVERY_PENDING');assert.equal(r.calls.patches.length,0);
console.log('PASS: 5 matching cache recovery cases; API cooldown preserved; no Striven record writes.');
