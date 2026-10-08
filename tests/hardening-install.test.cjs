const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/99_Production_Hardening.gs'),'utf8');
const start=source.indexOf('function CFH_installAndVerifyProductionHardening() {');
const body=source.slice(start);
function run(states){let installs=0;const context={CFH_VERSION:'test',CFH_reclaimUnusedCacheGrid_:()=>({ok:true,cellsFreed:0}),CFH_selfTestProductionHardening:()=>({ok:states.shift()}),CFH_installProductionHardening:()=>{installs++;return{ok:true};},SpreadsheetApp:{flush:()=>{}}};vm.runInNewContext(body,context);return{call:()=>context.CFH_installAndVerifyProductionHardening(),installs:()=>installs};}
let r=run([true]);assert.equal(r.call().status,'PRODUCTION_GUARDS_INSTALLED_AND_VERIFIED');assert.equal(r.installs(),0);
r=run([false,true]);assert.equal(r.call().ok,true);assert.equal(r.installs(),1);
r=run([false,false]);assert.throws(()=>r.call(),/CFH_INSTALL_VERIFY_FAILED/);
console.log('PASS: healthy guards skip reinstall; missing guards install; failed verification rejects success.');
