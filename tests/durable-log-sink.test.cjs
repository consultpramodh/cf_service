const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../src/99_Production_Hardening.gs'),'utf8');
const helper=src.slice(src.indexOf('function CFH_prepareSystemLogSink_()'),src.indexOf('function CFH_reclaimUnusedCacheGrid_()'));
let props={},created=0;const sheets={};
function sheet(id,rows){let count=rows;return {getParent:()=>({getId:()=>id}),getLastRow:()=>count,setRows:n=>count=n,setName:()=>{},getRange:()=>({setValues:v=>{assert.equal(v[0].length,14);count=1;}}),setFrozenRows:()=>{},getMaxColumns:()=>26,deleteColumns:(start,n)=>{assert.equal(start,15);assert.equal(n,12);}};}
const original=sheet('core',1139962);
const context={CF:{Util:{getSpreadsheet:()=>({getSheetByName:()=>original})},Config:{resolveSheetName:()=>'07 System Log',getHeaders:()=>Array(14).fill('header')}},PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||'',setProperty:(k,v)=>props[k]=v})},SpreadsheetApp:{openById:id=>({getSheetByName:()=>sheets[id]}),create:()=>{const id='sink'+(++created);sheets[id]=sheet(id,0);return {getSheets:()=>[sheets[id]],getId:()=>id,getUrl:()=>'https://example/'+id};}}};
vm.runInNewContext(helper,context);
assert.equal(context.CFH_prepareSystemLogSink_().status,'SYSTEM_LOG_SINK_ROTATED');
assert.equal(context.CFH_prepareSystemLogSink_().status,'SYSTEM_LOG_CAPACITY_HEALTHY');assert.equal(created,1);assert.equal(original.getLastRow(),1139962);
sheets.sink1.setRows(100001);assert.equal(context.CFH_prepareSystemLogSink_().status,'SYSTEM_LOG_SINK_ROTATED');assert.equal(created,2);assert.equal(sheets.sink1.getLastRow(),100001);
assert.ok(props.CF_SERVICEOPS_SYSTEM_LOG_HISTORY_core);assert.ok(props.CF_SERVICEOPS_SYSTEM_LOG_HISTORY_sink1);
sheets.sink2.setRows(100001);context.SpreadsheetApp.create=()=>{throw new Error('creation failed');};assert.throws(()=>context.CFH_prepareSystemLogSink_(),/creation failed/);assert.equal(props.CF_SERVICEOPS_SYSTEM_LOG_SINK_ID,'sink2');
console.log('PASS: log rollover retains all historical rows; bounded rotation; initialization failure preserves current sink.');
