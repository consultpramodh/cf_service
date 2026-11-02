/* CF ServiceOps Operations Web v1.1.0 — additive authenticated UI. */
function cfOpsActor_() {
  var email=String(Session.getActiveUser().getEmail()||'').toLowerCase();
  var owner=String(Session.getEffectiveUser().getEmail()||'').toLowerCase();
  if(!email || (email!=='marketing@classicfireplace.ca' && email!==owner)) throw new Error('ACCESS_DENIED: Sign in with the authorized Classic Fireplace Google account.');
  return email;
}
function cfOpsRender_() {
  cfOpsActor_();
  var token=Utilities.getUuid();
  CacheService.getUserCache().put('CF_OPS_CSRF',token,21600);
  var t=HtmlService.createTemplateFromFile('OperationsWeb'); t.csrf=token;
  return t.evaluate().setTitle('Classic Fireplace | Live Operations');
}
function cfOpsSerial_(v){return JSON.parse(JSON.stringify(v));}
function cfOpsRecords_(key){return CF.Util.readRecords(key).filter(function(r){return String(r['Request ID']||'').trim();});}
function cfOpsList() {
  cfOpsActor_();
  var records=cfOpsRecords_('SERVICE_REQUESTS');
  var webforms=CF.Util.readRecords('WEBFORM_REQUESTS').filter(function(r){return String(r['Submission ID']||r['Request ID']||'').trim();});
  var ids={}; records.forEach(function(r){ids[String(r['Request ID'])]=true;});
  return cfOpsSerial_({ok:true,fetchedAt:new Date(),records:records,webforms:webforms,unlinkedWebforms:webforms.filter(function(r){return !ids[String(r['Request ID'])];}),version:'1.1.0',source:'Google Sheets live read',strivenApiCalls:0});
}
function cfOpsDetail(id) {
  cfOpsActor_(); id=String(id||''); if(!/^SR-[A-Za-z0-9-]{1,100}$/.test(id))throw new Error('Invalid request ID.');
  var r=CF.Util.findRecord('SERVICE_REQUESTS','Request ID',id);if(!r)throw new Error('Request not found.');
  var cid=String(r['Matched Customer ID']||r['Created Customer ID']||'');
  var locations=cid?CF.Util.readRecords('STRIVEN_LOCATION_DATA').filter(function(x){return String(x['Customer ID'])===cid;}).map(function(x){return {id:String(x['Location ID']),customerId:cid,name:x['Location Name'],address:x['Full Address'],status:x['Status'],cachedAt:x['Cache Updated At']};}):[];
  var contacts=cid?CF.Util.readRecords('STRIVEN_CUSTOMER_DATA').filter(function(x){return String(x['Customer ID'])===cid&&String(x['Contact ID']||'');}).map(function(x){return {id:String(x['Contact ID']),name:x['Full Name']||x['Customer Name'],email:x['Email'],phone:x['Phone']};}):[];
  var seen={};contacts=contacts.filter(function(x){if(seen[x.id])return false;seen[x.id]=true;return true;});
  return cfOpsSerial_({ok:true,record:r,locations:locations,contacts:contacts,revision:CF.Util.canonicalHash(r),fetchedAt:new Date(),strivenApiCalls:0});
}
function cfOpsSaveSelection(input) {
  var actor=cfOpsActor_();input=input||{};
  if(!input.csrf || CacheService.getUserCache().get('CF_OPS_CSRF')!==input.csrf)throw new Error('Session expired. Reload the page.');
  if(['location','contact'].indexOf(input.step)<0 || !/^\d+$/.test(String(input.entityId||'')))throw new Error('Select a valid existing record.');
  return CF.Util.withScriptLock(function(){
    var r=CF.Util.findRecord('SERVICE_REQUESTS','Request ID',String(input.requestId||''));if(!r)throw new Error('Request not found.');
    if(CF.Util.canonicalHash(r)!==input.revision)throw new Error('This request changed. Reopen it before saving.');
    if(CF.Config.isTerminalState(r['Current Stage'])||CF.Config.isTerminalState(r['Final Outcome'])||r['Work Order ID'])throw new Error('Existing orders and terminal requests require reconciliation; their identity cannot be changed here.');
    var journal=CF.Util.parseJson(r['Write Journal JSON'],{})||{};
    function uncertain(x){if(!x||typeof x!=='object')return false;if(x.remoteWriteMayHaveSucceeded===true&&!/RECONCILED|VERIFIED|CERTIFIED/.test(String(x.status||'')))return true;return Object.keys(x).some(function(k){return typeof x[k]==='object'&&uncertain(x[k]);});}
    if(uncertain(journal))throw new Error('An earlier write has an uncertain outcome. Reconcile it before changing identity.');
    var cid=String(r['Matched Customer ID']||r['Created Customer ID']||'');if(!cid)throw new Error('Resolve the customer first.');
    var key=input.step==='location'?'STRIVEN_LOCATION_DATA':'STRIVEN_CUSTOMER_DATA';var idField=input.step==='location'?'Location ID':'Contact ID';
    var rows=CF.Util.readRecords(key).filter(function(x){return String(x[idField])===String(input.entityId)&&String(x['Customer ID'])===cid;});
    if(rows.length!==1)throw new Error('Record ownership is missing, conflicting or no longer matches this customer.');
    if(/INACTIVE|DELETED|CANCELLED/i.test(String(rows[0]['Status']||'')))throw new Error('Inactive records cannot be selected.');
    if(!CF.StrivenData.inspectReadiness().ok)throw new Error('Matching caches are not ready. Refresh the caches in the existing system before saving.');
    var evidence=CF.Util.parseJson(r['Match Evidence JSON'],{})||{};evidence.manualSelections=evidence.manualSelections||{};evidence.manualSelections.customerId=cid;evidence.manualSelections[input.step+'Id']=String(input.entityId);
    var patch={'Match Evidence JSON':evidence,'Approved By':'','Approved At':'','Approval Fingerprint':'','Updated At':CF.Util.nowString(),'Operator Notes':String(r['Operator Notes']||'')+'\n'+actor+' selected '+input.step+' '+input.entityId+' in Operations Web.'};
    CF.Util.patchServiceRequestById(r['Request ID'],patch);
    var result=CF.Matching.recheckRequest(r['Request ID'],{persist:true});
    if(!result || result.ok!==true)throw new Error('Selection recorded, but matching recheck did not complete. Reopen this request and inspect before retrying.');
    CF.Util.logEvent({module:'OperationsWeb',action:'SELECT_EXISTING_'+input.step.toUpperCase(),status:'COMPLETE',requestId:r['Request ID'],actor:actor,details:{entityId:String(input.entityId),customerId:cid,previousRevision:input.revision,strivenWrites:false},version:'1.1.0'});
    return cfOpsSerial_({ok:true,requestId:r['Request ID'],step:input.step,selectedId:String(input.entityId),result:result,strivenWrites:false});
  },5000);
}
