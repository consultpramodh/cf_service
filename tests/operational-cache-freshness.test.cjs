const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync('src/60_Striven_Write.gs','utf8'),a=src.indexOf('  function readiness_(){',src.indexOf('  function operationalCacheTimestampFast_()')),b=src.indexOf('  function operationalFresh_(){',a);assert(a>=0&&b>a);
let raw;const context={operationalCacheTimestampFast_:()=>raw,Date,Math,isNaN};vm.runInNewContext(src.slice(a,b),context);
for(const [minutes,expected] of [[0,true],[30,true],[45,true],[59,true],[61,false]]){raw=new Date(Date.now()-minutes*60000);assert.equal(context.readiness_().fresh.operational,expected,'age '+minutes);}
for(const value of ['',null,'not a date']){raw=value;assert.equal(context.readiness_().fresh.operational,false);}
assert(src.includes("if(!operationalFresh_()){var refresh=deps_().data.refreshOperationalData({})"));
console.log('PASS: cached operational evidence is accepted through 60 minutes, missing/invalid/stale cache still fails closed.');
