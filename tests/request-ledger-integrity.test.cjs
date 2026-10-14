'use strict';
// Google Apps Script core-utility regression tests. No credentials or Striven calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const intake = fs.readFileSync('src/20_Intake_Processing.gs', 'utf8');
const utilSrc = fs.readFileSync('src/01_Core_Utilities.gs', 'utf8');
for (const filename of [
  '01_Core_Utilities.gs', '20_Intake_Processing.gs', '40_Matching_Profile.gs',
  '50_Operator_Queue.gs', '60_Striven_Write.gs', '70_Workflow_Automation.gs',
  '95_Public_Runners.gs'
]) {
  const source = fs.readFileSync('src/' + filename, 'utf8');
  new vm.Script(source, {filename});
  if (filename !== '01_Core_Utilities.gs') {
    assert.doesNotMatch(source, /\\.patchRow\\(['"]SERVICE_REQUESTS['"]/, filename + ' has an unguarded Service Request patch');
    assert.doesNotMatch(source, /\\.clearRowDataValidations\\(['"]SERVICE_REQUESTS['"]/, filename + ' has an unguarded Service Request validation clear');
  }
}
function bodyOf(source, functionName) {
  const begin = source.indexOf('  function ' + functionName + '(');
  assert.ok(begin >= 0, functionName + ' missing');
  const end = source.indexOf('\n  }\n', begin);
  assert.ok(end > begin, functionName + ' incomplete');
  return source.slice(begin, end + 5);
}
for (const functionName of ['insertRecordAtTop_', 'sortDurableIntakeLedgersNewestFirst_', 'reorderWebformNewestFirst_', 'syncServiceRequestOrder_']) {
  const body = bodyOf(intake, functionName);
  assert.doesNotMatch(body, /\.insertRowBefore\s*\(|\.moveRows\s*\(|\.sort\s*\(\s*\{/);
}
assert.match(bodyOf(intake, 'insertRecordAtTop_'), /\.appendRecord\(/);

const headers = ['Request ID','Write Journal JSON','Current Stage','Updated At'];
const clearedRows = [];
const records = [
  ['SR-A', '{"requestId":"SR-A"}', 'OPEN',''],
  ['SR-B', '{"requestId":"SR-B"}', 'OPEN','']
];
const sheet = {
  getName: () => '02 Service Requests',
  getLastRow: () => records.length + 1,
  getMaxRows: () => 100,
  getLastColumn: () => headers.length,
  getRange(row, col, numRows=1, numCols=1) {
    const read = () => Array.from({length:numRows},(_,ri)=>Array.from({length:numCols},(_,ci)=>{
      const gridRow = row + ri;
      return gridRow === 1 ? headers[col+ci-1] : records[gridRow-2]?.[col+ci-1] ?? '';
    }));
    return {
      getValue(){return read()[0][0]},
      getValues: read,
      getDisplayValues: read,
      setValues(values) {
        assert.equal(values.length,numRows);
        values.forEach((arr,ri)=>arr.forEach((value,ci)=> {
          assert.ok(row+ri>1,'header overwrite');
          assert.ok(records[row+ri-2],'unexpected row');
          records[row+ri-2][col+ci-1]=value;
        }));
      },
      clearDataValidations() {clearedRows.push(row)}
    };
  }
};
const context = {
  CF:{ Config: {
    getSheetCandidates: ()=>['02 Service Requests'],
    resolveSheetName: ()=> '02 Service Requests',
    getHeaders: ()=>headers,
    getTimezone: ()=> 'America/Toronto',
    getTechnicalSheetNames: ()=>['02 Service Requests']
  }},
  SpreadsheetApp: {
    getActiveSpreadsheet: ()=>({getSheetByName:()=>sheet}),
    flush:()=>{}
  },
  UrlFetchApp: {fetch:()=>{throw Error('UNEXPECTED_EXTERNAL_CALL')}},
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},
  Utilities:{},
  console
};
vm.createContext(context);
vm.runInContext(utilSrc, context);
const u=context.CF.Util;
assert.ok(typeof u.patchServiceRequestById === 'function');

// Normal immutable Request ID write.
u.patchServiceRequestById('SR-A',{'Current Stage':'CUSTOMER RESOLVED'});
assert.equal(records[0][2],'CUSTOMER RESOLVED');

// Simulate a manual reordering between worker lookup and mutation.
records.reverse();
u.patchServiceRequestById('SR-A',{'Current Stage':'COMPLETED'});
assert.equal(records[1][0],'SR-A');
assert.equal(records[1][2],'COMPLETED');
assert.equal(records[0][0],'SR-B');
assert.equal(records[0][2],'OPEN');
u.clearServiceRequestRowValidationsById('SR-A');
assert.equal(clearedRows[clearedRows.length - 1],3, 'validation clearing must use the actual Request ID row');

// Reject stale physical-row address even with plausible patch data.
assert.throws(()=>u.patchRow('SERVICE_REQUESTS',2,{'Current Stage':'BAD'},'SR-A'),/CROSS_REQUEST_ROW/);
assert.equal(records[0][2],'OPEN');

// Fail closed on foreign root journal, foreign nested journal, and immutable ID rewrite.
assert.throws(()=>u.patchServiceRequestById('SR-A',{'Write Journal JSON':'{"requestId":"SR-B"}'}),/CROSS_REQUEST_JOURNAL/);
assert.throws(()=>u.patchServiceRequestById('SR-A',{'Write Journal JSON':JSON.stringify({requestId:'SR-A',contactCreate:{requestId:'SR-B'}})}),/CROSS_REQUEST_JOURNAL/);
assert.throws(()=>u.patchServiceRequestById('SR-A',{'Request ID':'SR-B'}),/SERVICE_REQUEST_ID_IMMUTABLE/);
assert.equal(JSON.parse(records[1][1]).requestId,'SR-A');

// A preexisting foreign journal is quarantined from ALL further writes.
records[1][1]='{"requestId":"SR-B"}';
assert.throws(()=>u.patchServiceRequestById('SR-A',{'Current Stage':'BAD'}),/CROSS_REQUEST_JOURNAL/);
assert.equal(records[1][2],'COMPLETED');
records[1][1]='{"requestId":"SR-A"}';

// Ambiguous Request ID must never choose the first row.
records.push(['SR-A','{"requestId":"SR-A"}','OPEN','']);
assert.throws(()=>u.patchServiceRequestById('SR-A',{'Current Stage':'BAD'}),/SERVICE_REQUEST_DUPLICATE_ID/);
records.pop();

// Fail closed on malformed preexisting journal and malformed incoming journal.
records[1][1]='{bad';
assert.throws(()=>u.patchServiceRequestById('SR-A',{'Current Stage':'BAD'}),/SERVICE_JOURNAL_INVALID_JSON/);
records[1][1]='{"requestId":"SR-A"}';
assert.throws(()=>u.patchServiceRequestById('SR-A',{'Write Journal JSON':'{bad'}),/SERVICE_JOURNAL_INVALID_JSON/);
console.log('P0_REQUEST_LEDGER_INTEGRITY_TEST_PASS');
