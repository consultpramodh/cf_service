const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const text=fs.readFileSync('src/70_Workflow_Automation.gs','utf8');
const start=text.indexOf('CF.CustomerStructureEngine = (function () {');
const end=text.indexOf('\n})();',start)+6;
function setup(overrides={}){
 const row={'Request ID':'SR-test','Current Stage':'READY FOR LOCATION CREATE','Request Status':'OPEN','Manual Review?':'NO','Duplicate Risk Status':'NONE','Matched Customer ID':'63122','Created Location ID':'58742',...overrides};
 let locationCalls=0,contactCalls=0;
 const CF={Config:{isTerminalState:()=>false},Util:{cleanText:v=>v==null?'':String(v).trim(),findRecord:()=>row,patchServiceRequestById:(id,p)=>{assert.equal(id,'SR-test');Object.assign(row,p);},nowString:()=> 'now'},Matching:{},StrivenControlledCustomerCreate:{},StrivenControlledContactCreate:{executeAutoContactCreate:()=>{contactCalls++;return {ok:true,requestId:'SR-test'};}},StandaloneLocationCreateV5128:{process:()=>{locationCalls++;return {ok:true,requestId:'SR-test'};}}};
 vm.runInNewContext(text.slice(start,end),{CF,SpreadsheetApp:{flush(){}}});
 return {row,step:()=>CF.CustomerStructureEngine.step('SR-test'),calls:()=>({locationCalls,contactCalls})};
}
let t=setup();assert.equal(t.step().status,'DURABLE_LOCATION_STAGE_RECOVERED');assert.equal(t.row['Current Stage'],'CUSTOMER RESOLVED');assert.equal(t.row['Contact Association Status'],undefined);assert.equal(t.calls().locationCalls,0);t.step();assert.equal(t.calls().contactCalls,1);
t=setup({'Manual Review?':'YES'});assert.equal(t.step().status,'CUSTOMER_STRUCTURE_REVIEW_REQUIRED');assert.equal(t.row['Current Stage'],'READY FOR LOCATION CREATE');assert.equal(t.calls().locationCalls,0);
t=setup({'Created Location ID':''});t.step();assert.equal(t.calls().locationCalls,1);
t=setup({'Matched Customer ID':''});t.step();assert.equal(t.calls().locationCalls,1);
console.log('PASS: durable location advances without duplicate POST, preserves contact verification and review gates.');
