function V2_selectedRequestId_() {
var ss=SpreadsheetApp.getActive();
var sh=ss.getActiveSheet();
if(sh.getName()==='02 Service Requests'){
var row=sh.getActiveRange().getRow();
if(row<2)throw new Error('Select a Service Request data row.');
return String(sh.getRange(row,1).getDisplayValue()||'').trim();
}
var test=ss.getSheetByName('V2 Shadow Test');
if(test){
var id=String(test.getRange('B2').getDisplayValue()||'').trim();
if(id)return id;
}
throw new Error('Select a row in 02 Service Requests or choose a Request ID in V2 Shadow Test!B2.');
}
function V2_writeShadowResult_(result,contract) {
var ss=SpreadsheetApp.getActive();
var sh=ss.getSheetByName('V2 Shadow Test');
if(!sh)throw new Error('V2 Shadow Test sheet is missing.');
var p=result||{};
var f=p.facts||{};
var c=f.customer||{},t=f.contact||{},l=f.location||{},pc=f.primaryContact||{},rel=f.relationship||{},so=f.salesOrder||{};
var rows=[
['LIVE V2 APPS SCRIPT RESULT','Value','Evidence / Status'],
['Module Version',String(p.version||''),'Installed bound Apps Script'],
['Request ID',String(p.requestId||''),'Selected request'],
['Canonical State',String(p.canonicalState||''),'Derived from verified business facts'],
['Next Required Fact',String(p.nextRequiredFact||''),'First fact not yet proven'],
['Next Action',String(p.nextAction||''),'Derived; not stored as truth'],
['Customer ID',String(c.id||''),String(c.remoteReadStatus||'')],
['Customer Identity',String(c.identity&&c.identity.status||''),'Direct GET'],
['Customer Phone',String(c.phone&&c.phone.status||''),'Direct GET'],
['Customer Email (diagnostic)',String(c.email&&c.email.status||''),String(c.emailApiShape||'')+' — not a V2 completion gate'],
['Location ID',String(l.id||''),String(l.status||'')],
['Contact ID',String(t.id||''),String(t.remoteReadStatus||'')],
['Contact Identity',String(t.identity&&t.identity.status||''),'Direct GET'],
['Contact Phone',String(t.phone&&t.phone.status||''),'Direct GET'],
['Contact Email',String(t.email&&t.email.status||''),'Direct GET — customer-facing email source'],
['Primary Contact',String(pc.status||''),String(pc.primaryContactId||'')],
['Relationship',String(rel.status||''),String(rel.rawStatus||'')+(rel.confirmedViaPrimaryContact===true?' — confirmed via PrimaryContact':'')],
['Sales Order',String(so.status||''),[so.id||'',so.number||''].filter(String).join(' / ')],
['Complete',p.complete===true?'YES':'NO','No Striven mutation performed']
];
if(contract){
rows.push(['Customer Email API Shape',String(contract.customerEmailShape||''),'Diagnostic only; direct Customer email is not required']);
rows.push(['Customer-facing Email Source',String(contract.customerFacingEmailSource||''),'Contact email surfaced through Primary Contact']);
rows.push(['Primary Contact Observable',contract.primaryContactObservable===true?'YES':'NO',String(contract.primaryContactCurrentStatus||'')+' / '+String(contract.primaryContactId||'')]);
rows.push(['Relationship Raw',contract.relationshipObservable===true?'OBSERVABLE':'UNRESOLVED',String(contract.relationshipCurrentStatus||'')]);
rows.push(['Relationship Effective',String(contract.relationshipEffectiveStatus||''),contract.relationshipConfirmedViaPrimaryContact===true?'Confirmed via Customer PrimaryContact':'']);
rows.push(['Relationship Payload Mode',String(contract.configuredRelationshipPayloadMode||''),'Fallback only; no association POST when PrimaryContact proves linkage']);
}
sh.getRange('E16:G40').clearContent();
sh.getRange(16,5,rows.length,3).setValues(rows);
sh.getRange('E16:G16').setFontWeight('bold').setBackground('#f2f2f2');
sh.getRange('E16:G40').setWrap(true).setVerticalAlignment('top');
sh.getRange('A2').setNote('V2 live resolver last run: '+new Date().toISOString());
SpreadsheetApp.flush();
}
function V2_TEST_selectedRow() {
var requestId=V2_selectedRequestId_();
if(!CF.V2Orchestrator||typeof CF.V2Orchestrator.preview!=='function')throw new Error('CF.V2Orchestrator is not installed.');
var result=CF.V2Orchestrator.preview(requestId);
var contract=CF.V2CoreEnsurers&&typeof CF.V2CoreEnsurers.certifyContracts==='function'
? CF.V2CoreEnsurers.certifyContracts(requestId)
: null;
V2_writeShadowResult_(result,contract);
console.log('V2 SELECTED ROW SHADOW: '+JSON.stringify(result));
SpreadsheetApp.getActive().toast('V2 shadow complete: '+result.nextRequiredFact,'CF ServiceOps V2',6);
return result;
}
function V2_TEST_regressionSet() {
if(!CF.V2Orchestrator||typeof CF.V2Orchestrator.shadowRegression!=='function')throw new Error('CF.V2Orchestrator is not installed.');
var out=CF.V2Orchestrator.shadowRegression();
console.log('V2 REGRESSION: '+JSON.stringify(out));
SpreadsheetApp.getActive().toast('V2 regression evaluated '+out.length+' known requests.','CF ServiceOps V2',6);
return out;
}
function V2_CERTIFY_selectedRowContracts() {
var requestId=V2_selectedRequestId_();
if(!CF.V2CoreEnsurers||typeof CF.V2CoreEnsurers.certifyContracts!=='function')throw new Error('CF.V2CoreEnsurers is not installed.');
var out=CF.V2CoreEnsurers.certifyContracts(requestId);
var preview=CF.V2Orchestrator.preview(requestId);
V2_writeShadowResult_(preview,out);
console.log('V2 CONTRACT CERTIFICATION READ ONLY: '+JSON.stringify(out));
SpreadsheetApp.getActive().toast('Read-only contract evidence captured.','CF ServiceOps V2',6);
return out;
}
function V2_PROCESS_selectedRowGuarded() {
var requestId=V2_selectedRequestId_();
var ui=SpreadsheetApp.getUi();
var answer=ui.alert(
'CF ServiceOps V2 — Guarded Execution',
'Run exactly one V2 action for '+requestId+'? This may write to Striven only when the V2 write feature flag is enabled.',
ui.ButtonSet.YES_NO
);
if(answer!==ui.Button.YES)return {ok:false,status:'USER_CANCELLED',requestId:requestId,liveWriteExecuted:false};
if(!CF.V2Migration||typeof CF.V2Migration.process!=='function')throw new Error('CF.V2Migration is not installed.');
var out=CF.V2Migration.process(requestId,{confirmLiveWrite:true});
V2_writeShadowResult_(CF.V2Orchestrator.preview(requestId),CF.V2CoreEnsurers.certifyContracts(requestId));
console.log('V2 GUARDED SELECTED ROW: '+JSON.stringify(out));
return out;
}
function V2_ENABLE_SELECTED_currentRequest() {
var requestId=V2_selectedRequestId_();
if(!CF.V2Migration||typeof CF.V2Migration.setSelectedMode!=='function')throw new Error('CF.V2Migration is not installed.');
var ui=SpreadsheetApp.getUi();
var answer=ui.alert(
'CF ServiceOps V2 — Enable One Selected Request',
'Enable V2 writes for ONLY '+requestId+'? All other requests remain on the legacy workflow.',
ui.ButtonSet.YES_NO
);
if(answer!==ui.Button.YES)return {ok:false,status:'USER_CANCELLED',requestId:requestId};
var out=CF.V2Migration.setSelectedMode([requestId]);
SpreadsheetApp.getActive().toast('V2 SELECTED mode enabled for '+requestId,'CF ServiceOps V2',8);
console.log('V2 SELECTED MODE ENABLED: '+JSON.stringify(out));
return out;
}
function V2_RETURN_TO_SHADOW() {
if(!CF.V2Migration||typeof CF.V2Migration.setShadowMode!=='function')throw new Error('CF.V2Migration is not installed.');
var out=CF.V2Migration.setShadowMode();
SpreadsheetApp.getActive().toast('V2 returned to SHADOW. Writes are OFF.','CF ServiceOps V2',8);
console.log('V2 RETURNED TO SHADOW: '+JSON.stringify(out));
return out;
}
function V2_addMenu() {
SpreadsheetApp.getUi().createMenu('ServiceOps V2')
.addItem('Shadow Test Selected Request','V2_TEST_selectedRow')
.addItem('Run Known Regression Set','V2_TEST_regressionSet')
.addItem('Certify API Contracts (Read Only)','V2_CERTIFY_selectedRowContracts')
.addSeparator()
.addItem('Enable V2 for CURRENT Request Only','V2_ENABLE_SELECTED_currentRequest')
.addItem('Run ONE Guarded V2 Action','V2_PROCESS_selectedRowGuarded')
.addItem('Return V2 to SHADOW / Writes OFF','V2_RETURN_TO_SHADOW')
.addToUi();
}
