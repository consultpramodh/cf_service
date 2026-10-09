// JavaScript / Node.js: timing helper regression tests; no network access.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const full=fs.readFileSync(__dirname+'/../src/50_Operator_Queue.gs','utf8');
new vm.Script(full);
const parser="  function parseDate_(v){\n    if(!v)return null;\n    if(Object.prototype.toString.call(v)==='[object Date]')return isNaN(v.getTime())?null:v;\n    var s=clean_(v),m,d;\n    if(/^\\d{4}-\\d{2}-\\d{2}T.*(?:Z|[+-]\\d{2}:?\\d{2})$/i.test(s)){\n      d=new Date(s);return isNaN(d.getTime())?null:d;\n    }\n    m=s.match(/^(\\d{4})-(\\d{1,2})-(\\d{1,2})[ T](\\d{1,2}):(\\d{2})(?::(\\d{2}))?$/);\n    if(m){\n      var canonical=[m[1],('0'+m[2]).slice(-2),('0'+m[3]).slice(-2)].join('-')+' '+('0'+m[4]).slice(-2)+':'+m[5]+':'+(m[6]||'00');\n      try{\n        d=Utilities.parseDate(canonical,tz_(),'yyyy-MM-dd HH:mm:ss');\n        return Utilities.formatDate(d,tz_(),'yyyy-MM-dd HH:mm:ss')===canonical?d:null;\n      }catch(e){return null;}\n    }\n    m=s.match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})[ T](\\d{1,2}):(\\d{2})(?::(\\d{2}))?$/);\n    if(m)return parseDate_(m[3]+'-'+m[1]+'-'+m[2]+' '+m[4]+':'+m[5]+':'+(m[6]||'00'));\n    // Reject unzoned ambiguous strings rather than silently applying runtime timezone.\n    return null;\n  }\n";
const status="  function orderCreationTime_(r){\n    var root=parseJournal_(r['Write Journal JSON']),so=root.salesOrderCreate||{};\n    var id=clean_(r['Work Order ID']),responseId=clean_(so.responseIdentifier);\n    var canonical=clean_(so.canonicalSalesOrderId),http=Number(so.httpStatus);\n    // POST acknowledgement time is local evidence, not server-created-at.\n    if(!id||!responseId||responseId!==id||(canonical&&canonical!==id)||\n       Number(so.postAttempts)<1||!(http>=200&&http<300))return '';\n    return so.postFinishedAt||'';\n  }\n  function statusText_(r){\n    var lines=[clean_(r['Current Stage']||r['Request Status'])];\n    var receivedRaw=r['Created At'],submitted=formatDateTime_(r['Submitted At']);\n    var received=formatDateTime_(receivedRaw),createdRaw=orderCreationTime_(r);\n    if(submitted)lines.push('Submitted: '+submitted);\n    if(received)lines.push('Received: '+received);\n    var hasOrder=!!clean_(r['Work Order ID']);\n    if(hasOrder){\n      var created=formatDateTime_(createdRaw);\n      lines.push(created?'Sales Order created (acknowledged): '+created:'Sales Order creation time: Unavailable');\n    }else lines.push('Sales Order: Pending');\n    var start=parseDate_(receivedRaw),end=hasOrder?parseDate_(createdRaw):new Date(nowMs_());\n    if(!start||!end)lines.push('Processing time: Unavailable');\n    else if(end.getTime()<start.getTime())lines.push('Processing time: Timestamp conflict');\n    else lines.push((hasOrder?'Processing time: ':'Processing time so far: ')+duration_(start,end));\n    lines=lines.concat(reviewLines_(r));\n    return lines.filter(Boolean).join('\\n');\n  }\n";
let clock=Date.parse('2026-10-09T10:05:00Z'),calls=0;
const c={Date,clean_:v=>v==null?'':String(v).trim(),nowMs_:()=>clock,
parseJournal_:v=>JSON.parse(v||'{}'),reviewLines_:()=>[],tz_:()=> 'UTC',
Utilities:{parseDate:s=>new Date(s.replace(' ','T')+'Z'),formatDate:d=>d.toISOString().slice(0,19).replace('T',' ')},
UrlFetchApp:{fetch:()=>{calls++;throw Error('No network allowed');}},
duration_:(a,b)=>Math.floor((b-a)/60000)+'m',
formatDateTime_:v=>{const d=c.parseDate_(v);return d?d.toISOString():''}};
vm.createContext(c);vm.runInContext(parser+status,c);
const r={'Created At':'2026-10-09T10:00:00Z','Submitted At':'2026-10-09T09:58:00Z','Current Stage':'NEW INTAKE'};
assert.match(c.statusText_(r),/so far: 5m/);
clock=Date.parse('2026-10-09T10:09:00Z');assert.match(c.statusText_(r),/so far: 9m/);
r['Work Order ID']='123';r['Current Stage']='COMPLETED';
r['Write Journal JSON']=JSON.stringify({salesOrderCreate:{postAttempts:1,httpStatus:200,responseIdentifier:'123',canonicalSalesOrderId:'123',postFinishedAt:'2026-10-09T10:19:00Z'}});
assert.match(c.statusText_(r),/Processing time: 19m/);
clock=Date.parse('2026-10-10T10:09:00Z');r['Last Striven Sync']='2026-10-10T10:09:00Z';
assert.match(c.statusText_(r),/Processing time: 19m/);
const legacy={...r,'Write Journal JSON':''};assert.match(c.statusText_(legacy),/Processing time: Unavailable/);
const bad={...r,'Work Order ID':'456'};assert.match(c.statusText_(bad),/Processing time: Unavailable/);
assert.equal(c.parseDate_('2026-10-09T06:00:00-04:00').getTime(),Date.parse('2026-10-09T10:00:00Z'));
assert.equal(c.parseDate_('2026-11-01T01:30:00-04:00').getTime()+3600000,c.parseDate_('2026-11-01T01:30:00-05:00').getTime());
assert.equal(c.parseDate_('2026-02-30 10:00:00'),null);
assert.equal(c.parseDate_('nonsense'),null);
assert.match(c.statusText_({...legacy,'Work Order ID':'','Created At':'2026-10-11T10:00:00Z'}),/Timestamp conflict/);
assert.equal(calls,0);
console.log('PASS: full source syntax; pending refresh; receipt vs submission; fixed creation duration; sync independence; legacy/mismatched order; ISO timezone and DST offsets; invalid local date; future receipt; zero HTTP calls.');
console.log('LIMIT: Utilities Toronto timezone parsing is mocked; Google runtime and live-source parity remain unverified.');
