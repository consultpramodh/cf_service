const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const src=fs.readFileSync('src/50_Operator_Queue.gs','utf8');const marker=src.indexOf('(function CF_SERVICEOPS_INSTALL_QUEUE_TIMING_HARDENING');const a=src.indexOf('  function clean_',marker),b=src.indexOf('  function ids_',a);
let clock=Date.parse('2026-10-15T17:22:00Z');class Clock extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
const ctx={Date:Clock,CF:{Util:{parseJson:(s,f)=>{try{return JSON.parse(s);}catch{return f;}}}},parseJournal_:v=>{try{return JSON.parse(v);}catch{return{};}},SpreadsheetApp:{getActive:()=>({getSpreadsheetTimeZone:()=> 'America/Toronto'})},Utilities:{formatDate:d=>d.toISOString()}};vm.runInNewContext(src.slice(a,b),ctx);
const r={'Request ID':'r','Current Stage':'NEEDS REVIEW','Submitted At':'2026-10-15T13:31:00Z','Last Striven Sync':'2026-10-15T14:05:00Z'};
assert.match(ctx.statusText_(r),/Elapsed since submission: 3h 51m/);clock+=60000;assert.match(ctx.statusText_(r),/Elapsed since submission: 3h 52m/);
const complete={...r,'Current Stage':'COMPLETED','Work Order ID':'1','Write Journal JSON':JSON.stringify({requestId:'r',salesOrderCreate:{certification:{result:{salesOrderId:'1',orderCreatedAt:'2026-10-15T14:00:00Z'}}}})};
assert.match(ctx.statusText_(complete),/Request to order: 29m/);complete['Last Striven Sync']='2026-10-16T17:00:00Z';assert.match(ctx.statusText_(complete),/Request to order: 29m/);
complete['Write Journal JSON']=JSON.stringify({requestId:'other',salesOrderCreate:{certification:{result:{salesOrderId:'1',orderCreatedAt:'2026-10-15T14:00:00Z'}}}});assert.match(ctx.statusText_(complete),/creation time: unavailable/);assert.doesNotMatch(ctx.statusText_(complete),/Request to order:/);
assert.equal(ctx.parseDate_('2026-10-15T09:31:00-04:00').getTime(),Date.parse('2026-10-15T13:31:00Z'));
const start=src.indexOf('reconcileRequest:function(requestId)'),end=src.indexOf('\n    }',start)+6;let selected,called=0;
const scope={CF:{Util:{findRecord:()=>({'Request ID':'target'}),readRecords:k=>{assert.equal(k,'STRIVEN_OPERATIONAL_DATA');return[];}}},clean_:String,run_:(rows,ops,o)=>{selected=rows;called++;return{ok:true};}};vm.runInNewContext('var reconcile='+src.slice(start,end).replace('reconcileRequest:','')+';',scope);scope.reconcile('target');assert.equal(called,1);assert.equal(selected.length,1);assert.equal(selected[0]['Request ID'],'target');
console.log('PASS: live elapsed timer, immutable creation endpoint, foreign journal exclusion, ISO offsets and single-request reconciliation.');
