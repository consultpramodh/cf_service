/* CF_SERVICEOPS_V5_10_10_RUNNER_R2 */
/* CF_SERVICEOPS_V5_10_9_RUNNER_R2 */
/* CF_SERVICEOPS_V5_10_8_RUNNER_R1 */
/************************************************************
 * APPS SCRIPT — 95_Public_Runners.gs
 * CF ServiceOps — Public Entry Points
 * Version: 5.8.0
 *
 * MENU DESIGN
 * Keep the daily operator menu intentionally small:
 * 1. Refresh Striven Data
 * 2. Process Matching
 * 3. Refresh Operator Queue
 * 4. Run Diagnostics
 *
 * Setup/migration and write-preview entry points remain available
 * for compatibility/admin use, but are no longer shown in the menu.
 ************************************************************/
var CF = CF || {};

CF.PublicRunners = (function () {
  'use strict';

  var VERSION = '5.8.0';

  function util_() {
    if (!CF.Util || !CF.Config) throw new Error('CF.Util and CF.Config are required.');
    return CF.Util;
  }

  function sensitiveKey_(key) {
    return /(url|token|secret|password|authorization|raw payload|payload preview)/i.test(String(key || ''));
  }

  function sanitize_(value, depth) {
    depth = depth || 0;
    if (depth > 5) return '[TRUNCATED_DEPTH]';
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value)) return '[REDACTED_URL]';
      return value.length > 2000 ? value.slice(0, 2000) + '…' : value;
    }

    if (typeof value !== 'object') return value;

    if (Array.isArray(value)) {
      var sample = value.slice(0, 25).map(function (item) {
        return sanitize_(item, depth + 1);
      });
      if (value.length > 25) sample.push('[+' + (value.length - 25) + ' more]');
      return sample;
    }

    var output = {};
    Object.keys(value).forEach(function (key) {
      if (sensitiveKey_(key)) {
        output[key] = '[REDACTED]';
      } else if (key === 'sourceSnapshot' || key === 'removedSheets') {
        output[key] = Array.isArray(value[key]) ? '[COUNT ' + value[key].length + ']' : '[OMITTED]';
      } else {
        output[key] = sanitize_(value[key], depth + 1);
      }
    });
    return output;
  }

  function log_(label, result) {
    var text = label + ': ' + util_().safeJson(sanitize_(result));
    var max = 16000;
    console.log(text.length > max ? text.slice(0, max) + '…[LOG TRUNCATED]' : text);
  }

  function toast_(message, title) {
    try {
      SpreadsheetApp.getActiveSpreadsheet().toast(message, title || 'CF ServiceOps', 8);
    } catch (ignored) {}
  }

  function run_(label, callback) {
    try {
      var result = callback();
      log_(label, result);
      toast_(result && result.ok === false ? 'Completed with issues' : 'Complete', label);
      return result;
    } catch (error) {
      var failure = {
        ok: false,
        error: error.message || String(error),
        stack: error.stack || ''
      };
      log_(label + ' FAILED', failure);
      toast_(failure.error, label + ' failed');
      throw error;
    }
  }

  function selectedRequestId_() {
    if (CF.OperatorQueue && typeof CF.OperatorQueue.selectedRequestId === 'function') {
      return CF.OperatorQueue.selectedRequestId();
    }

    var d = { config: CF.Config, util: CF.Util };
    var sheet = d.util.getSpreadsheet().getActiveSheet();
    var row = sheet.getActiveRange().getRow();
    if (row < 2) throw new Error('Select a request row first.');

    var headers = d.util.getActualHeaders(sheet);
    var requestColumn = headers.indexOf('Request ID') + 1;
    if (!requestColumn) throw new Error('The selected sheet does not contain Request ID.');

    return d.util.cleanText(sheet.getRange(row, requestColumn).getValue());
  }

  function buildMenu() {
    try {
      var ui = SpreadsheetApp.getUi();

      ui.createMenu('CF ServiceOps')
        .addItem('1. Refresh Striven Data', 'STRIVEN_refreshAllData')
        .addItem('2. Process Matching', 'MATCH_processAll')
        .addItem('3. Refresh Queue + Dashboard', 'QUEUE_refresh')
        .addSeparator()
        .addItem('Run Diagnostics', 'DIAGNOSTICS_run')
                .addSeparator()
        .addItem('Run PreviewSelected', 'WRITE_previewSelected')
        .addToUi();

      return { ok: true, version: VERSION };
    } catch (error) {
      return {
        ok: false,
        status: 'MENU_SKIPPED_NO_UI',
        error: error.message || String(error)
      };
    }
  }

  return {
    version: VERSION,
    buildMenu: buildMenu,
    selectedRequestId: selectedRequestId_,
    run: run_
  };
})();

/************************************************************
 * DAILY OPERATIONS
 ************************************************************/

function STRIVEN_refreshAllData() {
  return CF.PublicRunners.run(
    'Striven smart data refresh',
    function () {
      if (
        !CF.StrivenData ||
        typeof CF.StrivenData.refreshStaleData !== 'function'
      ) {
        throw new Error(
          'CF.StrivenData.refreshStaleData is required.'
        );
      }

      return CF.StrivenData.refreshStaleData();
    }
  );
}

function MATCH_processAll() {
  return CF.PublicRunners.run('Matching process all', function () {
    return CF.Matching.processAll();
  });
}

function QUEUE_refresh() {
  return CF.PublicRunners.run('Queue + Dashboard refresh', function () {
    return CF.OperatorQueue.refresh();
  });
}

function DASHBOARD_refresh() {
  return CF.PublicRunners.run('Dashboard snapshot refresh', function () {
    return CF.OperatorQueue.refreshDashboard();
  });
}

function DIAGNOSTICS_run() {
  return CF.PublicRunners.run('CF ServiceOps diagnostics', function () {
    return CF.Diagnostics.run();
  });
}

/************************************************************
 * COMPATIBILITY / ADMIN ENTRY POINTS
 * Kept out of the menu intentionally.
 ************************************************************/

function SETUP_previewLeanWorkbook() {
  return CF.PublicRunners.run('Lean workbook migration preview', function () {
    return CF.Setup.previewMigration();
  });
}

function SETUP_inspectLeanMigration() {
  return CF.PublicRunners.run('Lean migration state', function () {
    return CF.Setup.inspectMigrationState();
  });
}

function SETUP_createMigrationBackup() {
  return CF.PublicRunners.run('Lean migration backup', function () {
    return CF.Setup.createOrVerifyMigrationBackup();
  });
}

function SETUP_continueLeanMigration() {
  return CF.PublicRunners.run('Continue lean migration', function () {
    return CF.Setup.continueLeanMigration();
  });
}

function SETUP_applyLeanWorkbook() {
  return SETUP_continueLeanMigration();
}

function SETUP_resetLeanMigrationState() {
  return CF.PublicRunners.run('Reset lean migration state', function () {
    return CF.Setup.resetMigrationState();
  });
}

function STRIVEN_refreshCustomerData() {
  return CF.PublicRunners.run('Striven customer/contact refresh', function () {
    return CF.StrivenData.refreshCustomerData();
  });
}

function STRIVEN_refreshLocationData() {
  return CF.PublicRunners.run('Striven location refresh', function () {
    return CF.StrivenData.refreshLocationData();
  });
}

function STRIVEN_refreshOperationalData() {
  return CF.PublicRunners.run('Striven operational refresh', function () {
    return CF.StrivenData.refreshOperationalData();
  });
}

function MATCH_previewAll() {
  return CF.PublicRunners.run('Matching preview', function () {
    return CF.Matching.previewAll();
  });
}

function MATCH_inspectState() {
  return CF.PublicRunners.run('Matching state', function () {
    return CF.Matching.inspectState();
  });
}

function QUEUE_openSelected() {
  return CF.PublicRunners.run('Open request detail', function () {
    return CF.OperatorQueue.openSelectedRequest();
  });
}

function QUEUE_saveDashboardDecision() {
  return CF.PublicRunners.run('Save operator decision', function () {
    return CF.OperatorQueue.saveDashboardDecision();
  });
}

function QUEUE_repairServiceRequestValidations() {
  return CF.PublicRunners.run('Repair technical validations', function () {
    return CF.OperatorQueue.repairServiceRequestValidations();
  });
}

function WRITE_previewSelected() {
  return TESTING_07_previewSelectedSalesOrderDraft();
}

function WRITE_approveSelected() {
  return CF.PublicRunners.run('Approve selected guarded Sales Order create', function () {
    if (!CF.OperatorQueue || typeof CF.OperatorQueue.selectedRequestId !== 'function') throw new Error('Operator Queue selection helper is unavailable.');
    var requestId = CF.OperatorQueue.selectedRequestId();
    var draft = CF.SalesOrderDraft.build(requestId);
    if (!draft || draft.safeForPayloadOverlay !== true) {
      var reasons = (draft && draft.coreBlockers || []).map(function (x) { return x.code + ': ' + x.message; });
      throw new Error('Selected request is not safe for Sales Order approval. ' + (reasons.join(' | ') || 'Resolve operator-required draft fields first.'));
    }
    return CF.OrderPreflight.approveRequest(requestId);
  });
}

function WRITE_processApproved() {
  /* CF_SERVICEOPS_V5_10_6_SALES_ORDER_CONFIRMATION_R1 */
  return CF.PublicRunners.run('Manual create Sales Order for selected row', function () {
    if (!CF.OperatorQueue || typeof CF.OperatorQueue.selectedRequestId !== 'function') throw new Error('Select a request row in 03 Operator Queue.');
    var requestId = CF.OperatorQueue.selectedRequestId();
    if (!CF.SalesOrderDraft || typeof CF.SalesOrderDraft.build !== 'function') throw new Error('Sales Order draft layer is unavailable.');
    if (!CF.OrderPreflight || typeof CF.OrderPreflight.previewRequest !== 'function' || typeof CF.OrderPreflight.approveRequest !== 'function' || typeof CF.OrderPreflight.executeApproved !== 'function') throw new Error('Guarded Sales Order writer is unavailable.');
    var draft = CF.SalesOrderDraft.build(requestId);
    if (!draft || draft.safeForPayloadOverlay !== true) {
      var draftReasons = (draft && draft.coreBlockers || []).map(function (x) { return x.code + ': ' + x.message; });
      throw new Error('Selected request is not safe for Sales Order creation. ' + (draftReasons.join(' | ') || 'Resolve operator-required draft fields first.'));
    }
    var preview = CF.OrderPreflight.previewRequest(requestId);
    if (!preview.readyForApproval) throw new Error('Sales Order create blocked: ' + preview.blockers.map(function (x) { return x.code + ': ' + x.message; }).join(' | '));
    var line = preview.payload && preview.payload.LineItems && preview.payload.LineItems[0] || {};
    var cf = {}; (preview.payload.CustomFields || []).forEach(function (x) { cf[String(x.Id)] = x.Value; });
    var message = [
      'Request: ' + requestId,
      'Customer: ' + preview.state.customerId,
      'Contact: ' + preview.state.contactId,
      'Ship To: ' + preview.state.locationId,
      'Bill To: ' + preview.state.locationId,
      'Order: ' + (preview.payload.OrderName || ''),
      'Item: 41434',
      'Price: ' + (line.Price === undefined ? '' : line.Price),
      'Manufacturer / Model: ' + (cf['651'] || ''),
      'Serial: ' + (cf['650'] || '-'),
      'Preferred: ' + (cf['653'] || '-'),
      'Service Level: ' + (cf['797'] === '503' ? 'Service Level 1 (503)' : (cf['797'] || '-')),
      'Internal Notes: prepared from Webform; direct API field deferred pending datatype verification',
      '',
      'This will create ONE Sales Order as QUOTED in Striven.',
      'After verified creation the request will move to MANUAL REVIEW.',
      'There is NO automatic status transition and NO uncertain retry.',
      '',
      'Create this Sales Order now?'
    ].join('\n');
    var ui = SpreadsheetApp.getUi();
    var response = ui.alert('Manual Sales Order Create', message, ui.ButtonSet.YES_NO);
    if (response !== ui.Button.YES) return { ok: false, version: '5.10.6', status: 'CANCELLED_BY_OPERATOR', requestId: requestId, liveWriteExecuted: false };
    var approval = CF.OrderPreflight.approveRequest(requestId);
    var execution = CF.OrderPreflight.executeApproved(requestId, { executionToken: CF.OrderPreflight.executionToken });
    return { ok: execution && execution.ok === true, version: '5.10.6', mode: 'MANUAL_SELECTED_SALES_ORDER_CREATE', requestId: requestId, approval: approval, execution: execution, automaticStatusTransition: false, liveWriteExecuted: !!(execution && execution.liveWriteExecuted) };
  });
}

/************************************************************
 * TRIGGERS / WEB APP
 ************************************************************/



/* CF_SERVICEOPS_V5_10_9_ONOPEN_REFRESH_STATUS_R2
 * Workbook-open operator view.
 * This DOES NOT call Striven or rerun matching on open.
 * It reveals the four operator sheets, activates Dashboard, and shows the
 * timestamps/counts produced by the most recent event-driven refresh chain.
 */
CF.OpenStatus = (function () {
  'use strict';
  var VERSION = '5.10.9';
  function clean_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function sheetName_(key, fallback) {
    try { var n=CF.Config && CF.Config.getSheetName ? clean_(CF.Config.getSheetName(key)) : ''; if(n)return n; } catch(ignored) {}
    return fallback;
  }
  function sheet_(ss,key,fallback) { return ss.getSheetByName(sheetName_(key,fallback)); }
  function count_(sh) { return sh ? Math.max(0, sh.getLastRow()-1) : 0; }
  function stamp_(sh) {
    if(!sh || sh.getLastRow()<2 || sh.getLastColumn()<1) return '';
    var headers=sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0];
    var col=headers.indexOf('Cache Updated At')+1;
    if(!col)return '';
    var v=sh.getRange(2,col).getValue();
    if(!v)return '';
    var d=v instanceof Date?v:new Date(v);
    if(isNaN(d.getTime()))return clean_(v);
    try{return Utilities.formatDate(d,CF.Config.getTimezone(),'MMM d HH:mm');}catch(ignored){return d.toISOString();}
  }
  function show() {
    var ss=(CF.Util&&CF.Util.getSpreadsheet)?CF.Util.getSpreadsheet():SpreadsheetApp.getActiveSpreadsheet();
    var dashboard=sheet_(ss,'DASHBOARD','00 Dashboard');
    var webforms=sheet_(ss,'WEBFORM_REQUESTS','01 Webform Requests');
    var requests=sheet_(ss,'SERVICE_REQUESTS','02 Service Requests');
    var queue=sheet_(ss,'OPERATOR_QUEUE','03 Operator Queue');
    [dashboard,webforms,requests,queue].forEach(function(sh){if(sh){try{sh.showSheet();}catch(ignored){}}});
    if(dashboard){try{ss.setActiveSheet(dashboard);}catch(ignored){}}
    var customers=sheet_(ss,'STRIVEN_CUSTOMER_DATA','04 Striven Customer Data');
    var locations=sheet_(ss,'STRIVEN_LOCATION_DATA','05 Striven Location Data');
    var operational=sheet_(ss,'STRIVEN_OPERATIONAL_DATA','06 Striven Operational Data');
    var pending=[];
    try{pending=CF.EventDrivenServiceAutomation&&typeof CF.EventDrivenServiceAutomation.queuedRequestIds==='function'?CF.EventDrivenServiceAutomation.queuedRequestIds():[];}catch(ignored){pending=[];}
    var status={
      ok:true,version:VERSION,mode:'SHOW_LATEST_REFRESHED_OPERATOR_VIEW',
      visibleSheets:[dashboard&&dashboard.getName(),webforms&&webforms.getName(),requests&&requests.getName(),queue&&queue.getName()].filter(Boolean),
      counts:{webforms:count_(webforms),serviceRequests:count_(requests),operatorQueue:count_(queue)},
      cacheUpdatedAt:{customersContacts:stamp_(customers),locations:stamp_(locations),operationalAssets:stamp_(operational)},
      automation:{mode:'INCOMING_REQUEST_ONE_SHOT_TO_GUARDED_SALES_ORDER',queuedRequestCount:pending.length,queuedRequestIds:pending.slice(0,10)},
      liveWriteExecuted:false
    };
    var line1='Webforms '+status.counts.webforms+' | Requests '+status.counts.serviceRequests+' | Queue '+status.counts.operatorQueue;
    var line2='Caches - C/C '+(status.cacheUpdatedAt.customersContacts||'n/a')+' | Loc '+(status.cacheUpdatedAt.locations||'n/a')+' | Ops '+(status.cacheUpdatedAt.operationalAssets||'n/a');
    var line3='Incoming automation queue: '+status.automation.queuedRequestCount;
    try{ss.toast(line1+'\n'+line2+'\n'+line3,'CF ServiceOps - Refreshed View',12);}catch(ignored){}
    try{console.log('CF ServiceOps onOpen refreshed view: '+JSON.stringify(status));}catch(ignored){}
    return status;
  }
  return { version:VERSION, show:show };
})();

function onOpen() {
  var result = CF.PublicRunners.buildMenu();
  try { TESTING_buildMenu_(); } catch (ignoredTestingMenu) {}
  try { if (CF.OpenStatus && typeof CF.OpenStatus.show === 'function') CF.OpenStatus.show(); } catch (openStatusError) {
    try { SpreadsheetApp.getActiveSpreadsheet().toast(openStatusError.message || String(openStatusError), 'CF ServiceOps open status', 8); } catch (ignoredToast) {}
  }
  return result;
}

function onEdit(e) {
  if (CF.OperatorQueue && typeof CF.OperatorQueue.onEdit === 'function') {
    return CF.OperatorQueue.onEdit(e);
  }
}

function doPost(e) {
  return CF.Intake.handlePost(e);
}


/* CF_SERVICEOPS_V5_10_31_SELECTED_ROW_E2E_CONTROLS_R1 */
function TESTING_11_selectedSingleQueueRequestId_() {
  if (!CF.Util || !CF.Config) throw new Error('CF.Util and CF.Config are required.');
  var ss = typeof CF.Util.getSpreadsheet === 'function' ? CF.Util.getSpreadsheet() : SpreadsheetApp.getActive();
  var sheet = ss.getActiveSheet();
  var expectedName = CF.Config.getSheetName('OPERATOR_QUEUE');
  if (!sheet || sheet.getName() !== expectedName) throw new Error('Select exactly ONE request row in 03 Operator Queue.');
  var range = sheet.getActiveRange();
  if (!range || range.getNumRows() !== 1 || range.getRow() < 2) throw new Error('Select exactly ONE request row in 03 Operator Queue.');
  var headers = CF.Util.getActualHeaders(sheet);
  var requestCol = headers.indexOf('Request ID') + 1;
  if (!requestCol) throw new Error('Operator Queue does not contain Request ID.');
  var id = CF.Util.cleanText(sheet.getRange(range.getRow(), requestCol).getValue());
  if (!id) throw new Error('The selected row does not contain a Request ID.');
  return id;
}

function TESTING_11_e2eSnapshot_(requestId) {
  requestId = CF.Util.cleanText(requestId);
  var record = CF.Util.findRecord('SERVICE_REQUESTS', 'Request ID', requestId);
  if (!record) return {ok:false,version:'5.10.32',status:'SERVICE_REQUEST_NOT_FOUND',requestId:requestId,readOnly:true,liveWriteExecuted:false};

  var queued=[];
  try {
    queued = CF.EventDrivenServiceAutomation && typeof CF.EventDrivenServiceAutomation.queuedRequestIds === 'function'
      ? CF.EventDrivenServiceAutomation.queuedRequestIds() : [];
  } catch (ignoredQueue) { queued=[]; }

  /* CF_SERVICEOPS_V5_10_37_TEST11_MULTI_HANDLER_VISIBILITY_R1 */
  var triggerRows=[];
  try {
    var handlerNames=CF.EventDrivenServiceAutomation&&typeof CF.EventDrivenServiceAutomation.allHandlerNames==='function'
      ? CF.EventDrivenServiceAutomation.allHandlerNames()
      : ['AUTO_FINAL_ServiceOps','AUTO_98_E2E_Recovery_Watchdog'];
    triggerRows = ScriptApp.getProjectTriggers().filter(function(t){
      try { return t.getHandlerFunction && handlerNames.indexOf(String(t.getHandlerFunction()))!==-1; } catch(ignored){ return false; }
    }).map(function(t){
      var uid='',type='',handler='';
      try{uid=String(t.getUniqueId ? t.getUniqueId() : '');}catch(ignoredUid){}
      try{type=String(t.getEventType ? t.getEventType() : '');}catch(ignoredType){}
      try{handler=String(t.getHandlerFunction ? t.getHandlerFunction() : '');}catch(ignoredHandler){}
      return {handler:handler,uid:uid,eventType:type};
    });
  } catch (ignoredTriggers) { triggerRows=[]; }

  var stage=CF.Util.cleanText(record['Current Stage']);
  var requestStatus=CF.Util.cleanText(record['Request Status']);
  var structureStatus=CF.Util.cleanText(record['Customer Structure Status']);
  var workOrderId=CF.Util.cleanText(record['Work Order ID']);
  var workOrderNumber=CF.Util.cleanText(record['Work Order Number']);
  var manualReview=String(record['Manual Review?']||'').trim().toUpperCase()==='YES';
  var duplicateRisk=CF.Util.cleanText(record['Duplicate Risk Status']);
  var duplicateBlocked=duplicateRisk && duplicateRisk.toUpperCase()!=='NONE';
  var terminalError=['BLOCKED','DUPLICATE','CANCELLED','CANCELED','ERROR'].indexOf(String(requestStatus||'').toUpperCase())!==-1;
  var durable=!!workOrderId;
  var readiness=durable ? 'SALES_ORDER_DURABLE'
    : (String(stage||'').toUpperCase()==='NEEDS REVIEW'||manualReview||duplicateBlocked||terminalError) ? 'REVIEW_OR_RISK_BLOCKED'
    : (String(stage||'').toUpperCase()==='CUSTOMER STRUCTURE COMPLETE'&&String(structureStatus||'').toUpperCase()==='COMPLETE') ? 'READY_FOR_SALES_ORDER'
    : 'IN_PROGRESS_OR_READY_TO_RERUN';

  return {
    ok:true,version:'5.10.32',status:'RECHECK_COMPLETE',mode:'READ_ONLY_SELECTED_ROW_E2E_RECHECK',requestId:requestId,
    currentStage:stage,requestStatus:requestStatus,customerStructureStatus:structureStatus,
    manualReview:manualReview,duplicateRiskStatus:duplicateRisk,
    customerId:CF.Util.cleanText(record['Created Customer ID']||record['Matched Customer ID']),
    contactId:CF.Util.cleanText(record['Created Contact ID']||record['Matched Contact ID']),
    locationId:CF.Util.cleanText(record['Created Location ID']||record['Matched Location ID']),
    workOrderId:workOrderId,workOrderNumber:workOrderNumber,salesOrderDurable:durable,
    readiness:readiness,queuedRequestIds:queued.slice(),selectedRequestQueued:queued.indexOf(requestId)!==-1,
    otherQueuedRequestIds:queued.filter(function(id){return id!==requestId;}),
    activeAutomationTriggers:triggerRows.length,automationTriggers:triggerRows,
    readOnly:true,writeAttempted:false,liveWriteExecuted:false
  };
}

function TESTING_11_recheckSelectedEndToEnd() {
  return CF.PublicRunners.run('TEST 11 - Recheck End-to-End Status for Selected Row', function () {
    var requestId=TESTING_11_selectedSingleQueueRequestId_();
    var result=TESTING_11_e2eSnapshot_(requestId);
    var summary=result.salesOrderDurable ? 'Sales Order durable · '+(result.workOrderNumber||result.workOrderId)
      : (result.currentStage||result.readiness||'Status checked');
    try{SpreadsheetApp.getActive().toast(summary,'E2E Recheck',10);}catch(ignoredToast){}
    console.log('Selected Row E2E Recheck: '+JSON.stringify(result));
    return result;
  });
}

function TESTING_12_rerunSelectedEndToEnd() {
  /* CF_SERVICEOPS_V5_10_32_SELECTED_RERUN_ASYNC_NO_COMPETING_TRIGGER_R1 */
  return CF.PublicRunners.run('TEST 12 - RERUN End-to-End for Selected Row', function () {
    var requestId=TESTING_11_selectedSingleQueueRequestId_();
    if (!CF.EventDrivenServiceAutomation || typeof CF.EventDrivenServiceAutomation.kick !== 'function') {
      throw new Error('Request-driven E2E automation is unavailable.');
    }

    var before=TESTING_11_e2eSnapshot_(requestId);
    if (!before.ok) throw new Error(before.status||'Selected Service Request could not be loaded.');

    if (before.salesOrderDurable) {
      var durableRefresh=null;
      try{durableRefresh=CF.OperatorQueue&&typeof CF.OperatorQueue.refresh==='function'?CF.OperatorQueue.refresh():null;}catch(ignoredRefresh){}
      var durableOut={ok:true,version:'5.10.32',status:'ALREADY_DURABLE_NO_RERUN_NEEDED',mode:'SELECTED_ROW_E2E_RERUN',requestId:requestId,workOrderId:before.workOrderId,workOrderNumber:before.workOrderNumber,before:before,operatorQueueRefresh:durableRefresh,writeAttempted:false,liveWriteExecuted:false};
      try{SpreadsheetApp.getActive().toast('Already durable · no duplicate Sales Order attempted','E2E Rerun',10);}catch(ignoredDurableToast){}
      console.log('Selected Row E2E Rerun: '+JSON.stringify(durableOut));
      return durableOut;
    }

    if (before.otherQueuedRequestIds && before.otherQueuedRequestIds.length) {
      var busy={ok:false,version:'5.10.32',status:'BUSY_OTHER_REQUESTS_QUEUED_NO_RERUN',mode:'SELECTED_ROW_E2E_RERUN',requestId:requestId,otherQueuedRequestIds:before.otherQueuedRequestIds,before:before,writeAttempted:false,liveWriteExecuted:false};
      try{SpreadsheetApp.getActive().toast('Another incoming request is already queued. Rerun not started.','E2E Rerun',10);}catch(ignoredBusyToast){}
      console.log('Selected Row E2E Rerun: '+JSON.stringify(busy));
      return busy;
    }

    // kick() already creates the guarded one-shot worker trigger. Do NOT also invoke
    // worker() synchronously here; long cache refreshes can otherwise overlap that trigger.
    var kick=CF.EventDrivenServiceAutomation.kick(requestId);
    if (!kick || kick.ok===false) throw new Error('Could not enqueue selected request for E2E rerun: '+JSON.stringify(kick||{}));
    var after=TESTING_11_e2eSnapshot_(requestId);
    var out={
      ok:true,version:'5.10.32',status:'RERUN_QUEUED',mode:'SELECTED_ROW_E2E_RERUN',requestId:requestId,
      before:before,kick:kick,after:after,salesOrderDurableAfter:!!after.salesOrderDurable,
      workerStartedImmediately:false,continuationExpected:!!(kick&&kick.scheduled===true),
      writeAttempted:false,liveWriteExecuted:false
    };
    try{SpreadsheetApp.getActive().toast('Rerun queued · automation will continue this request','E2E Rerun',10);}catch(ignoredToast){}
    console.log('Selected Row E2E Rerun: '+JSON.stringify(out));
    return out;
  });
}



/* CF_SERVICEOPS_V5_10_34_SELECTED_INFO_SYNC_R2 */
function TESTING_13_syncCustomerContactInfoSelectedRow() {
  return CF.PublicRunners.run('TEST 13 - Sync Customer + Contact Info for Selected Row', function () {
    var requestId=TESTING_11_selectedSingleQueueRequestId_();
    if(!CF.CustomerContactInfoSync||typeof CF.CustomerContactInfoSync.reconcile!=='function') throw new Error('Customer/Contact info sync module is unavailable.');
    var result=CF.CustomerContactInfoSync.reconcile(requestId,{manualSelectedRow:true});
    var msg=result&&result.status==='CUSTOMER_CONTACT_INFO_CONFIRMED'?'Customer + Contact already confirmed':(result&&result.liveWriteExecuted?'Updated one Striven record · run again to verify the other':'Sync stopped · check execution log');
    try{SpreadsheetApp.getActive().toast(msg,'Customer + Contact Info',10);}catch(ignoredToast){}
    console.log('Selected Customer + Contact Info Sync: '+JSON.stringify(result));
    return result;
  });
}


/* CF_SERVICEOPS_V5_10_35_REALTIME_PERFORMANCE_PREVIEW_R1 */
function TESTING_14_previewRealtimePerformanceSelectedRow() {
  return CF.PublicRunners.run('TEST 14 - Preview Realtime Performance for Selected Row', function () {
    var requestId=TESTING_11_selectedSingleQueueRequestId_();
    var row=CF.Util.findRecord('SERVICE_REQUESTS','Request ID',requestId);
    if(!row) throw new Error('Selected Service Request was not found.');
    function clean(v){return CF.Util.cleanText(v);}
    function upper(v){return String(clean(v)).toUpperCase();}
    var customerId=clean(row['Matched Customer ID']||row['Created Customer ID']);
    var contactId=clean(row['Matched Contact ID']||row['Created Contact ID']);
    var locationId=clean(row['Matched Location ID']||row['Created Location ID']);
    var out={ok:true,version:'5.10.35',status:'REALTIME_PERFORMANCE_PREVIEW',mode:'READ_ONLY',requestId:requestId,timezone:'America/Toronto',createdAt:clean(row['Created At']),submittedAt:clean(row['Submitted At']),customerId:customerId,contactId:contactId,locationId:locationId,unitDetailsPresent:!!clean(row['Unit Details']),fastPathInternalQueueRebuilds:'SUPPRESSED',continuationOnlyFinalQueueRefresh:'DEFERRED',liveWriteAndTerminalQueueRefresh:'PRESERVED',operationalRefreshLogic:'PRESERVED_UNCHANGED',uncertainInfoWriteHandling:'AUTOMATIC_READ_ONLY_RECONCILIATION_ONLY',automaticPostRetry:false,writeAttempted:false,liveWriteExecuted:false};
    console.log('Realtime Performance Preview: '+JSON.stringify(out));
    try{SpreadsheetApp.getActive().toast('Read-only performance preview complete','Realtime Performance',8);}catch(ignoredToast){}
    return out;
  });
}


/* CF_SERVICEOPS_V5_10_36_SELF_HEALING_PREVIEW_R1 */
function TESTING_15_previewSelfHealingRecoverySelectedRow() {
  return CF.PublicRunners.run('TEST 15 - Preview Self-Healing Recovery for Selected Row', function () {
    var requestId=TESTING_11_selectedSingleQueueRequestId_();
    var row=CF.Util.findRecord('SERVICE_REQUESTS','Request ID',requestId);
    if(!row) throw new Error('Selected Service Request was not found.');
    function clean(v){return CF.Util.cleanText(v);}
    function parse(v,f){try{return CF.Util.parseJson?CF.Util.parseJson(v,f):JSON.parse(String(v||''));}catch(e){return f;}}
    function idsFromText(text){var out=[],seen={},re=/(?:Contact\s*ID|ContactID)\s*[:#]?\s*(\d+)/ig,m;while((m=re.exec(String(text||'')))){var id=clean(m[1]);if(id&&!seen[id]){seen[id]=true;out.push(id);}}return out;}
    var root=parse(row['Write Journal JSON'],{})||{};
    var cc=root.contactCreate||{};
    var sync=root.customerContactInfoSync||{};
    var customerJournal=sync.customer||{};
    var duplicateIds=[];
    (Array.isArray(cc.existingDuplicateContactIds)?cc.existingDuplicateContactIds:[]).forEach(function(x){x=clean(x);if(x&&duplicateIds.indexOf(x)===-1)duplicateIds.push(x);});
    [cc.existingDuplicateContactId,cc.postError,row['Blocking Issue'],row['Manual Review Reason']].forEach(function(x){idsFromText(x).forEach(function(id){if(duplicateIds.indexOf(id)===-1)duplicateIds.push(id);});});
    var cStatus=String(customerJournal.status||'').toUpperCase();
    var customerCfBypass=/CUSTOM_FIELD.*BYPASS|ENRICHMENT_SKIPPED|REJECTED_VALIDATION_CUSTOM_FIELDS/.test(cStatus)||/Invalid Custom Fields|Custom Field Id\s+\d+/i.test(String(customerJournal.error||row['Striven Sync Error']||''));
    var plan=duplicateIds.length===1?'AUTO_RECONCILE_EXISTING_CONTACT_ID':duplicateIds.length>1?'MANUAL_REVIEW_MULTIPLE_CONTACT_IDS':customerCfBypass?'AUTO_SKIP_UNSAFE_CUSTOMER_ENRICHMENT_CONTINUE_CONTACT':'NORMAL_E2E_GUARDS';
    var out={ok:true,version:'5.10.36',status:'SELF_HEALING_RECOVERY_PREVIEW',mode:'READ_ONLY',requestId:requestId,currentStage:clean(row['Current Stage']),requestStatus:clean(row['Request Status']),customerId:clean(row['Matched Customer ID']||row['Created Customer ID']),contactId:clean(row['Matched Contact ID']||row['Created Contact ID']),locationId:clean(row['Matched Location ID']||row['Created Location ID']),existingDuplicateContactIds:duplicateIds,existingDuplicateContactId:duplicateIds.length===1?duplicateIds[0]:'',customerCustomFieldEnrichmentBypass:customerCfBypass,recoveryPlan:plan,automaticPostRetry:false,duplicateCreatePostRetry:false,writeAttempted:false,liveWriteExecuted:false};
    console.log('Self-Healing Recovery Preview: '+JSON.stringify(out));
    try{SpreadsheetApp.getActive().toast('Read-only recovery preview complete','Self-Healing Recovery',8);}catch(ignoredToast){}
    return out;
  });
}


/* CF_SERVICEOPS_V5_10_38_LOCATION_RECOVERY_PREVIEW_R1 */
function TESTING_16_previewLocationSelfHealingSelectedRow() {
  return CF.PublicRunners.run('TEST 16 - Preview Location Self-Healing for Selected Row', function () {
    var requestId=TESTING_11_selectedSingleQueueRequestId_();
    var row=CF.Util.findRecord('SERVICE_REQUESTS','Request ID',requestId);
    if(!row)throw new Error('Selected Service Request was not found.');
    function clean(v){return CF.Util.cleanText(v);}
    function semAddr(v){var t=clean(v).toUpperCase();if(!t)return '';return t.replace(/\bONTARIO\b/g,'ON').replace(/\bCANADA\b/g,'CA').replace(/[^A-Z0-9]+/g,'');}
    function semStreet(v){return clean(v).toUpperCase().replace(/[^A-Z0-9]+/g,'');}
    function semPostal(v){return clean(v).toUpperCase().replace(/[^A-Z0-9]+/g,'');}
    var customerId=clean(row['Matched Customer ID']||row['Created Customer ID']);
    var sheet=CF.Util.requireSheet('STRIVEN_LOCATION_DATA');
    var headers=CF.Util.getActualHeaders(sheet),map=CF.Util.getHeaderMap(sheet),matches=[];
    if(customerId&&map['Customer ID']&&sheet.getLastRow()>1){
      var found=sheet.getRange(2,map['Customer ID'],sheet.getLastRow()-1,1).createTextFinder(customerId).matchEntireCell(true).findAll();
      found.forEach(function(cell){
        var vals=sheet.getRange(cell.getRow(),1,1,headers.length).getValues()[0];
        matches.push(CF.Util.rowToRecord(headers,vals,cell.getRow()));
      });
    }
    var normalized=clean(row['Normalized Address']);
    var exact=matches.filter(function(x){return clean(x['Normalized Address'])===normalized;});
    var reqSem=semAddr(row['Full Address']);
    var semantic=matches.filter(function(x){return reqSem&&semAddr(x['Full Address'])===reqSem;});
    var reqStreet=semStreet(row['Street']),reqPostal=semPostal(row['Normalized Postal']||row['Postal Code']);
    var streetPostal=matches.filter(function(x){var st=semStreet(x['Location Name']||String(clean(x['Full Address'])).split(',')[0]);var pc=semPostal(x['Normalized Postal']||x['Postal Code']);return reqStreet&&reqPostal&&st===reqStreet&&pc===reqPostal;});
    var selected=exact.length?exact:(semantic.length?semantic:streetPostal);
    var method=exact.length?'CUSTOMER_ID + EXACT_NORMALIZED_ADDRESS':semantic.length?'CUSTOMER_ID + SEMANTIC_FULL_ADDRESS':streetPostal.length?'CUSTOMER_ID + EXACT_STREET + POSTAL':'NO_MATCH';
    var out={ok:true,version:'5.10.38',status:'LOCATION_SELF_HEALING_PREVIEW',mode:'READ_ONLY',requestId:requestId,customerId:customerId,currentStage:clean(row['Current Stage']),requestNormalizedAddress:normalized,requestSemanticAddress:reqSem,exactLocationIds:exact.map(function(x){return clean(x['Location ID']);}),semanticLocationIds:semantic.map(function(x){return clean(x['Location ID']);}),streetPostalLocationIds:streetPostal.map(function(x){return clean(x['Location ID']);}),selectedCandidateIds:selected.map(function(x){return clean(x['Location ID']);}),selectedMatchMethod:method,safeAutoReconcile:selected.length===1,ambiguous:selected.length>1,automaticLocationCreate:false,automaticWriteRetry:false,writeAttempted:false,liveWriteExecuted:false};
    console.log('Location Self-Healing Preview: '+JSON.stringify(out));
    return out;
  });
}
function CF_20260930_queueTodayEndToEndOnce_() {
  var key='CF_20260930_END_TO_END_BATCH_QUEUED_V3';
  var props=PropertiesService.getScriptProperties();
  if(props.getProperty(key))return{status:'ALREADY_QUEUED',queued:false};
  var ids=[
    'SR-20260930103833-2221',
    'SR-20260930103408-5757',
    'SR-20260930094108-9940',
    'SR-20260930064224-4257'
  ];
  var results=[];
  // Recover only the exact false preflight park produced by the item.id/itemId
  // validation defect. No Sales Order write occurred, so restoring the last
  // verified customer/contact-info state is safe.
  var sheilaId='SR-20260930064224-4257';
  try {
    var sheila=CF.Util.findRecord('SERVICE_REQUESTS','Request ID',sheilaId);
    if (sheila &&
        !String(sheila['Work Order ID']||'').trim() &&
        String(sheila['Reconciliation Status']||'').toUpperCase()==='WORK_ORDER_PREFLIGHT_BLOCKED' &&
        String(sheila['Manual Review Reason']||'').indexOf('STANDARD_SERVICE_ITEM_ID_NOT_CONFIGURED')!==-1) {
      CF.Util.clearRowDataValidations('SERVICE_REQUESTS',sheila.__rowNumber);
      CF.Util.patchRow('SERVICE_REQUESTS',sheila.__rowNumber,{
        'Updated At':CF.Util.nowString(),
        'Current Stage':'CUSTOMER STRUCTURE COMPLETE',
        'Request Status':'OPEN',
        'Manual Review?':'NO',
        'Manual Review Reason':'',
        'Blocking Issue':'',
        'Next Action':'CONTINUE TO WORK ORDER',
        'Striven Sync Status':'PARTIAL',
        'Striven Sync Error':'',
        'Reconciliation Status':'CUSTOMER + CONTACT INFO CONFIRMED'
      });
      SpreadsheetApp.flush();
      CF.Util.logEvent({
        module:'95_Public_Runners',
        action:'TODAY_BATCH_FALSE_PREFLIGHT_RECOVERY',
        status:'RESTORED',
        requestId:sheilaId,
        message:'Recovered deterministic item.id/itemId preflight defect; no Sales Order write had occurred.',
        details:{workOrderWriteExecuted:false,restoredStage:'CUSTOMER STRUCTURE COMPLETE'},
        version:'5.14.2'
      });
    }
  } catch (recoverError) {
    results.push({ok:false,status:'SHEILA_FALSE_PREFLIGHT_RECOVERY_FAILED',error:String(recoverError&&recoverError.message||recoverError)});
  }
  // kick() moves each explicit request to the front. Iteration order leaves
  // Sheila (oldest request today) at the queue head.
  ids.forEach(function(id){
    if(CF.EventDrivenServiceAutomation&&typeof CF.EventDrivenServiceAutomation.kick==='function'){
      results.push(CF.EventDrivenServiceAutomation.kick(id));
    }
  });
  props.setProperty(key,new Date().toISOString());
  return{status:'QUEUED_TODAY_END_TO_END',queued:true,requestIds:ids,results:results};
}

function CF_20260930_probeCustomerScopedContactRead_() {
  var urls=[
    'https://classicfireplace.striven.com/api/accounts/62701/contacts/57321',
    'https://classicfireplace.striven.com/api/accounts/62701/contacts',
    'https://classicfireplace.striven.com/api/contacts/57321',
    '/v1/contacts/57321'
  ];
  return urls.map(function(url){
    try{
      var r=CF.StrivenHttp.requestJson(url,{method:'get'});
      return {url:url,ok:true,status:r&&r.status||200,body:r&&r.json!==undefined?r.json:r};
    }catch(err){
      return {url:url,ok:false,error:String(err&&err.message||err)};
    }
  });
}

function doGet(e) {
  /* CF_SERVICEOPS_V5_14_1_TEMP_TODAY_STEP_RUNNER_R1 */
  var probe=e&&e.parameter?String(e.parameter.ops||''):'';
  if(probe==='probe-customer-contact'){
    return ContentService.createTextOutput(JSON.stringify({
      ok:true,
      probe:'CUSTOMER_SCOPED_CONTACT_READ',
      results:CF_20260930_probeCustomerScopedContactRead_()
    })).setMimeType(ContentService.MimeType.JSON);
  }
  if(probe==='probe-karin-contact-56604'){
    var result={ok:false,contactId:'56604'};
    try{
      var response=CF.StrivenHttp.requestJson('/v1/contacts/56604',{method:'get',attempts:1,idempotent:true});
      var body=response&&response.json?response.json:{};
      result={
        ok:true,
        contactId:String(body.Id||body.id||body.ID||''),
        firstName:String(body.FirstName||body.firstName||''),
        lastName:String(body.LastName||body.lastName||''),
        customerId:String(body.CustomerId||body.customerId||body.CustomerID||''),
        customer:body.Customer||body.customer||null,
        customerAssociations:body.CustomerAssociations||body.customerAssociations||null,
        customers:body.Customers||body.customers||null,
        keys:Object.keys(body).sort()
      };
    }catch(err){result={ok:false,contactId:'56604',error:String(err&&err.message||err)};}
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  }
  var ops=e&&e.parameter?String(e.parameter.ops||''):'';
  if(ops==='refresh-service-striven-checklist'){
    var checklistKey='CF_SERVICE_STRIVEN_CHECKLIST_REFRESH_R2';
    var props=PropertiesService.getScriptProperties();
    if(props.getProperty(checklistKey)){
      return ContentService.createTextOutput(JSON.stringify({ok:true,status:'SERVICE_STRIVEN_CHECKLIST_ALREADY_REFRESHED'})).setMimeType(ContentService.MimeType.JSON);
    }
    var checklistRefresh=CF.OperatorQueue&&typeof CF.OperatorQueue.refresh==='function'?CF.OperatorQueue.refresh():{ok:false,status:'QUEUE_REFRESH_UNAVAILABLE'};
    if(checklistRefresh&&checklistRefresh.ok!==false)props.setProperty(checklistKey,new Date().toISOString());
    return ContentService.createTextOutput(JSON.stringify({
      ok:checklistRefresh&&checklistRefresh.ok!==false,
      status:'SERVICE_STRIVEN_CHECKLIST_REFRESHED',
      refresh:checklistRefresh
    })).setMimeType(ContentService.MimeType.JSON);
  }
  if(ops==='refresh-karin-contact-evidence'){
    var karinId='SR-20260930144914-6244';
    var refresh=CF.StrivenData.refreshCustomerData({});
    var matching=CF.Matching.recheckRequest(karinId,{persist:true});
    var karinRow=CF.Util.findRecord('SERVICE_REQUESTS','Request ID',karinId)||{};
    return ContentService.createTextOutput(JSON.stringify({
      ok:refresh&&refresh.ok!==false,
      status:'KARIN_CONTACT_EVIDENCE_REFRESHED',
      refresh:refresh,
      matchingStatus:matching&&matching.status||'',
      customerId:String(karinRow['Matched Customer ID']||karinRow['Created Customer ID']||''),
      contactId:String(karinRow['Matched Contact ID']||karinRow['Created Contact ID']||''),
      contactAction:String(karinRow['Contact Action']||''),
      currentStage:String(karinRow['Current Stage']||''),
      nextAction:String(karinRow['Next Action']||'')
    })).setMimeType(ContentService.MimeType.JSON);
  }
  if(ops==='today-step'||ops==='today-recheck-step'){
    var id=e&&e.parameter?String(e.parameter.id||''):'';
    var allowed={
      'SR-20260930144914-6244':true,
      'SR-20260930140806-2445':true,
      'SR-20260930103833-2221':true,
      'SR-20260930103408-5757':true,
      'SR-20260930094108-9940':true,
      'SR-20260930064224-4257':true
    };
    if(!allowed[id]){
      return ContentService.createTextOutput(JSON.stringify({ok:false,status:'TODAY_STEP_REQUEST_NOT_ALLOWED'})).setMimeType(ContentService.MimeType.JSON);
    }
    var matching=null;
    if(ops==='today-recheck-step'){
      matching=CF.Matching.recheckRequest(id,{persist:true});
      if(id==='SR-20260930140806-2445'){
        var les=CF.Util.findRecord('SERVICE_REQUESTS','Request ID',id)||{};
        if(String(les['Matched Customer ID']||'').trim()==='41471'&&
           String(les['Matched Contact ID']||'').trim()==='35697'&&
           String(les['Matched Location ID']||'').trim()==='37314'){
          var root={};try{root=JSON.parse(String(les['Write Journal JSON']||'{}'))||{};}catch(ignoredLesJournal){root={};}
          root.contactCreate=root.contactCreate||{};
          root.contactCreate.erroneousDuplicateContactId='56603';
          root.contactCreate.erroneousDuplicateReason='Created because Alt Phone was omitted from Contact duplicate guard and Contact matching incorrectly required all new primary identifiers to match.';
          root.contactCreate.canonicalExistingContactId='35697';
          root.contactCreate.correctionAppliedAt=CF.Util.nowString();
          CF.Util.clearRowDataValidations('SERVICE_REQUESTS',les.__rowNumber);
          CF.Util.patchRow('SERVICE_REQUESTS',les.__rowNumber,{
            'Updated At':CF.Util.nowString(),
            'Created Contact ID':'',
            'Contact Association Status':'RECONCILE',
            'Current Stage':'CUSTOMER RESOLVED',
            'Request Status':'OPEN',
            'Manual Review?':'NO',
            'Manual Review Reason':'',
            'Blocking Issue':'',
            'Next Action':'RECONCILE EXISTING CONTACT 35697, ENRICH SUBMITTED PHONES/EMAIL, THEN CREATE WORK ORDER',
            'Customer Structure Status':'RESOLVED — CONTACT RECONCILIATION REQUIRED',
            'Write Journal JSON':JSON.stringify(root),
            'Striven Sync Status':'PARTIAL',
            'Striven Sync Error':'',
            'Reconciliation Status':'CONTACT 35697 RESTORED AS CANONICAL; ERRONEOUS CONTACT 56603 RETAINED IN JOURNAL'
          });
          SpreadsheetApp.flush();
        }
      }
    }
    var kick=CF.EventDrivenServiceAutomation.kick(id);
    var run=CF.EventDrivenServiceAutomation.worker({});
    var row=CF.Util.findRecord('SERVICE_REQUESTS','Request ID',id)||{};
    return ContentService.createTextOutput(JSON.stringify({
      ok:run&&run.ok!==false,
      status:'TODAY_STEP_EXECUTED',
      requestId:id,
      matchingStatus:matching&&matching.status||'',
      contactAction:String(row['Contact Action']||''),
      matchedContactId:String(row['Matched Contact ID']||''),
      kickStatus:kick&&kick.status||'',
      workerStatus:run&&run.status||'',
      liveWriteExecuted:!!(run&&run.liveWriteExecuted===true),
      currentStage:String(row['Current Stage']||''),
      requestStatus:String(row['Request Status']||''),
      nextAction:String(row['Next Action']||''),
      workOrderId:String(row['Work Order ID']||''),
      workOrderNumber:String(row['Work Order Number']||''),
      finalOutcome:String(row['Final Outcome']||'')
    })).setMimeType(ContentService.MimeType.JSON);
  }
  /* CF_SERVICEOPS_RECENT10_ACCEPTANCE_RUNNER_20261006 — TEMPORARY */
  if(ops==='recent10-acceptance-step'||ops==='recent10-acceptance-snapshot'){
    var acceptanceId=e&&e.parameter?String(e.parameter.id||''):'';
    var acceptanceAllowed={
      'SR-20261006104413-7346':true,
      'SR-20261005182859-2159':true,
      'SR-20261005121227-9352':true,
      'SR-20261005084731-2148':true,
      'SR-20261004220141-5643':true,
      'SR-20261004203633-9340':true,
      'SR-20261004115129-2627':true,
      'SR-20261004104029-7927':true,
      'SR-20261003160054-7269':true,
      'SR-20261003120429-6643':true
    };
    if(!acceptanceAllowed[acceptanceId]){
      return ContentService.createTextOutput(JSON.stringify({ok:false,status:'RECENT10_REQUEST_NOT_ALLOWED'})).setMimeType(ContentService.MimeType.JSON);
    }
    var acceptanceKick=null,acceptanceRun=null;
    if(ops==='recent10-acceptance-step'){
      acceptanceKick=CF.EventDrivenServiceAutomation.kick(acceptanceId);
      acceptanceRun=CF.EventDrivenServiceAutomation.worker({});
    }
    var acceptanceRow=CF.Util.findRecord('SERVICE_REQUESTS','Request ID',acceptanceId)||{};
    return ContentService.createTextOutput(JSON.stringify({
      ok:!acceptanceRun||acceptanceRun.ok!==false,
      status:ops==='recent10-acceptance-step'?'RECENT10_STEP_EXECUTED':'RECENT10_SNAPSHOT',
      requestId:acceptanceId,
      kickStatus:acceptanceKick&&acceptanceKick.status||'',
      workerStatus:acceptanceRun&&acceptanceRun.status||'',
      liveWriteExecuted:!!(acceptanceRun&&acceptanceRun.liveWriteExecuted===true),
      currentStage:String(acceptanceRow['Current Stage']||''),
      requestStatus:String(acceptanceRow['Request Status']||''),
      manualReview:String(acceptanceRow['Manual Review?']||''),
      nextAction:String(acceptanceRow['Next Action']||''),
      customerId:String(acceptanceRow['Matched Customer ID']||acceptanceRow['Created Customer ID']||''),
      contactId:String(acceptanceRow['Matched Contact ID']||acceptanceRow['Created Contact ID']||''),
      locationId:String(acceptanceRow['Matched Location ID']||acceptanceRow['Created Location ID']||''),
      workOrderId:String(acceptanceRow['Work Order ID']||''),
      workOrderNumber:String(acceptanceRow['Work Order Number']||''),
      reconciliationStatus:String(acceptanceRow['Reconciliation Status']||''),
      finalOutcome:String(acceptanceRow['Final Outcome']||''),
      queuedRequestIds:CF.EventDrivenServiceAutomation&&typeof CF.EventDrivenServiceAutomation.queuedRequestIds==='function'?CF.EventDrivenServiceAutomation.queuedRequestIds().slice(0,20):[]
    })).setMimeType(ContentService.MimeType.JSON);
  }

  /* CF_SERVICEOPS_V5_14_1_PUBLIC_HEALTH_R1 */
  var todayBatch=null;
  try { todayBatch=CF_20260930_queueTodayEndToEndOnce_(); }
  catch (batchError) { todayBatch={status:'QUEUE_FAILED',error:String(batchError&&batchError.message||batchError)}; }
  var verification = {
    singleModel: false,
    enabled: false,
    finalWorkerTriggers: 0,
    watchdogTriggers: 0,
    legacyAutomationTriggerCount: -1
  };
  try {
    if (CF.EventDrivenServiceAutomation &&
        typeof CF.EventDrivenServiceAutomation.inspect === 'function') {
      var state = CF.EventDrivenServiceAutomation.inspect();
      verification.enabled = state.enabled === true;
      verification.finalWorkerTriggers = Number(state.finalWorkerTriggers || 0);
      verification.watchdogTriggers = Number(state.watchdogTriggers || 0);
      verification.legacyAutomationTriggerCount = Number(state.legacyAutomationTriggerCount || 0);
      verification.singleModel =
        state.singleModel === true &&
        verification.legacyAutomationTriggerCount === 0 &&
        verification.watchdogTriggers === 1 &&
        verification.finalWorkerTriggers <= 1;
    }
  } catch (ignoredHealthCheck) {
    verification.error = 'HEALTH_CHECK_UNAVAILABLE';
  }
  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    service: 'CF ServiceOps',
    version: '5.14.2',
    automationModel: 'SINGLE',
    singleModelVerified: verification.singleModel,
    automationEnabled: verification.enabled,
    finalWorkerTriggers: verification.finalWorkerTriggers,
    watchdogTriggers: verification.watchdogTriggers,
    legacyAutomationTriggerCount: verification.legacyAutomationTriggerCount,
    todayEndToEndBatch: todayBatch,
    status: verification.singleModel
      ? 'SINGLE_SERVICEOPS_MODEL_VERIFIED'
      : 'SINGLE_SERVICEOPS_MODEL_NOT_VERIFIED'
  })).setMimeType(ContentService.MimeType.JSON);
}

function TESTING_18_previewRecoveryController() {
  return CF.PublicRunners.run('TEST 18 - READ ONLY Recovery Controller Preview', function () {
    if(!CF.EventDrivenServiceAutomation||typeof CF.EventDrivenServiceAutomation.recoveryPreview!=='function')throw new Error('v5.11.2 recovery preview is unavailable.');
    var out=CF.EventDrivenServiceAutomation.recoveryPreview();
    out.writeAttempted=false;out.liveWriteExecuted=false;
    console.log('Recovery Controller Preview: '+JSON.stringify(out));
    return out;
  });
}

/* CF_SERVICEOPS_V5_13_5_TECHNICAL_RECOVERY_R1
 * These runners may update the Service Request ledger, but they never execute
 * a Striven mutation. The selected runner performs direct GET/cache
 * reconciliation only. The batch is bounded to 25 rows per run.
 */
function TESTING_19_reconcileSelectedContactAssociationReadOnly() {
  return CF.PublicRunners.run('TEST 19 - READ ONLY Contact Association Reconcile', function () {
    var requestId=TESTING_selectedRequestId_();
    if(!CF.StrivenControlledContactCreate||typeof CF.StrivenControlledContactCreate.reconcileContactAssociationReadOnly!=='function') {
      throw new Error('Read-only Contact association recovery is unavailable.');
    }
    var out=CF.StrivenControlledContactCreate.reconcileContactAssociationReadOnly(requestId);
    out.mode='READ_ONLY_STRIVEN_RECOVERY';
    out.liveWriteExecuted=false;
    out.automaticPostRetry=false;
    console.log('Selected Contact Association Read-Only Reconcile: '+JSON.stringify(out));
    return out;
  });
}

function TESTING_20_recoverTechnicalAssociationsReadOnly() {
  return CF.PublicRunners.run('TEST 20 - READ ONLY Technical Association Batch', function () {
    if(!CF.StrivenControlledContactCreate||typeof CF.StrivenControlledContactCreate.recoverTechnicalAssociationsReadOnly!=='function') {
      throw new Error('Read-only technical association batch recovery is unavailable.');
    }
    var out=CF.StrivenControlledContactCreate.recoverTechnicalAssociationsReadOnly(25);
    out.mode='READ_ONLY_STRIVEN_RECOVERY_BATCH';
    out.liveWriteExecuted=false;
    out.automaticPostRetry=false;
    console.log('Technical Association Read-Only Batch: '+JSON.stringify(out));
    return out;
  });
}

function TESTING_17_previewSalesOrderCertificationSelectedRow() {
  return CF.PublicRunners.run('TEST 17 - READ ONLY Sales Order Certification Preview', function () {
    var requestId=TESTING_selectedRequestId_();
    if(!CF.OrderPreflight||typeof CF.OrderPreflight.previewCertification!=='function')throw new Error('v5.11.0 Sales Order certification controller is unavailable.');
    var out=CF.OrderPreflight.previewCertification(requestId);
    out.mode='READ_ONLY';
    out.writeAttempted=false;
    out.liveWriteExecuted=false;
    console.log('Sales Order Certification Preview: '+JSON.stringify(out));
    return out;
  });
}

// WORK_ORDER_SOURCE_SCHEMA_PROBE_V2
// Temporary field-name-only diagnostic. Does not expose row values, URLs, tokens, or credentials.
function STRIVEN_probeWorkOrderSourceFields() {
  if (!CF || !CF.Util || !CF.Config || !CF.StrivenHttp) {
    throw new Error('CF.Util, CF.Config and CF.StrivenHttp are required.');
  }

  var resolved = CF.Util.resolveProperty('STRIVEN_WORK_ORDER_REPORT', { allowDefault: false });
  if (!resolved || !resolved.found || !resolved.value) {
    throw new Error('STRIVEN_WORK_ORDER_REPORT is not configured.');
  }

  var fetched = CF.StrivenHttp.fetchReport(resolved.value, { pageSize: 1, maxPages: 1 });
  var row = fetched && fetched.rows && fetched.rows.length ? fetched.rows[0] : {};
  var fields = Object.keys(row || {}).sort(function (a, b) {
    return String(a).localeCompare(String(b));
  });

  var dateLikeFields = fields.filter(function (field) {
    return /date|created|order|\bso\b/i.test(String(field));
  });

  var aliases = (CF.Config.getReportAliases('WORK_ORDER').SALES_ORDER_DATE || []).slice();
  var exactAliasMatches = aliases.filter(function (alias) {
    return Object.prototype.hasOwnProperty.call(row, alias);
  });

  var result = {
    ok: true,
    reportKey: 'SERVICE_WORK_ORDERS',
    propertyName: resolved.key || '',
    rowsFetched: fetched && fetched.rows ? fetched.rows.length : 0,
    pagesFetched: fetched && fetched.pagesFetched ? fetched.pagesFetched : 0,
    stopReason: fetched && fetched.stopReason ? fetched.stopReason : '',
    fieldCount: fields.length,
    fields: fields,
    dateLikeFields: dateLikeFields,
    configuredSalesOrderDateAliases: aliases,
    exactAliasMatches: exactAliasMatches,
    salesOrderDateFieldFound: exactAliasMatches.length > 0
  };

  console.log('Work Order source fields: ' + JSON.stringify(result, null, 2));
  return result;
}


// PHASE5B_CUSTOMER_CREATE_PREVIEW_V1
function PHASE5B_previewCustomerCreates() {
  return CF.PublicRunners.run('Phase 5B-A customer create payload preview', function () {
    if (!CF.StrivenWrite || typeof CF.StrivenWrite.previewCustomerCreates !== 'function') {
      throw new Error('CF.StrivenWrite.previewCustomerCreates is not available.');
    }
    var result = CF.StrivenWrite.previewCustomerCreates();
    console.log('Phase 5B-A Customer Create Preview: ' + JSON.stringify(result, null, 2));
    return result;
  });
}


// INTAKE_PREPEND_NEWEST_FIRST_V2
// One-time/manual repair utility. Real-time intake ordering is automatic.
function INTAKE_repairNewestFirst() {
  if (
    !CF.Intake ||
    typeof CF.Intake.repairNewestFirst !== 'function'
  ) {
    throw new Error(
      'CF.Intake.repairNewestFirst is not available.'
    );
  }

  var result =
    CF.Intake.repairNewestFirst();

  console.log(
    'Intake newest-first repair: ' +
    JSON.stringify(
      result,
      null,
2
    )
  );

  return result;
}


// PHASE5B_CONTROLLED_CUSTOMER_PREFLIGHT_V1
function PHASE5B_preflightTestCustomerCreate() {
  return CF.PublicRunners.run(
    'Phase 5B-B controlled customer create preflight',
    function () {
      if (
        !CF.StrivenWrite ||
        typeof CF.StrivenWrite.preflightControlledTestCustomerCreate !==
        'function'
      ) {
        throw new Error(
          'CF.StrivenWrite.preflightControlledTestCustomerCreate is not available.'
        );
      }

      var result =
        CF.StrivenWrite
          .preflightControlledTestCustomerCreate();

      console.log(
        'Phase 5B-B Controlled Customer Create Preflight: ' +
        JSON.stringify(
          result,
          null,
2
        )
      );

      return result;
    }
  );
}


// PHASE5B_ONE_CUSTOMER_LIVE_EXECUTOR_V1
// EXPLICIT LIVE ACTION: exact hard-coded Test Test request only.
// Re-running after any write journal exists is reconciliation-only.
function PHASE5B_executeTestCustomerCreate() {
  return CF.PublicRunners.run('Phase 5B-C one guarded live Customer create', function () {
    return CF.StrivenControlledCustomerCreate.executeControlledCustomerCreate(
      'SR-20260818160541-7844',
      {
        confirmLiveWrite: true,
        executionToken: 'PHASE5B-C-ONE-CUSTOMER'
      }
    );
  });
}

function PHASE5B_previewTestCustomerCreate() {
  return CF.PublicRunners.run('Phase 5B-C guarded Customer create preview', function () {
    return CF.StrivenControlledCustomerCreate.previewControlledCustomerCreate(
      'SR-20260818160541-7844'
    );
  });
}

function PHASE5D_previewTestContactCreate() {
  return CF.PublicRunners.run('Phase 5D guarded Contact create preview', function () {
    return CF.StrivenControlledContactCreate.previewControlledContactCreate(
      'SR-20260818160541-7844'
    );
  });
}

function PHASE5D_executeTestContactCreate() {
  return CF.PublicRunners.run('Phase 5D one guarded Contact create/associate step', function () {
    return CF.StrivenControlledContactCreate.executeControlledContactCreate(
      'SR-20260818160541-7844',
      { confirmLiveWrite: true, executionToken: 'PHASE5D-ONE-CONTACT' }
    );
  });
}

/* CF_SERVICEOPS_V5_14_1_SINGLE_PUBLIC_AUTOMATION_R1 */
function AUTO_previewCustomerStructure() {
  return CF.PublicRunners.run('Final ServiceOps status', function () {
    if(!CF.EventDrivenServiceAutomation||typeof CF.EventDrivenServiceAutomation.inspect!=='function') {
      throw new Error('Final ServiceOps v5.14.2 is not loaded.');
    }
    return CF.EventDrivenServiceAutomation.inspect();
  });
}

function AUTO_installCustomerStructureAutomation() {
  return FINALIZE_20260930_activateCanonicalServiceOps();
}

function AUTO_removeCustomerStructureAutomation() {
  return CF.PublicRunners.run('Disable final ServiceOps automation', function () {
    return CF.EventDrivenServiceAutomation.disable();
  });
}

function FINALIZE_20260930_activateCanonicalServiceOps() {
  return CF.PublicRunners.run('Activate final ServiceOps v5.14.2', function () {
    if(!CF.EventDrivenServiceAutomation||typeof CF.EventDrivenServiceAutomation.activate!=='function') {
      throw new Error('Final ServiceOps v5.14.2 is not loaded.');
    }
    return CF.EventDrivenServiceAutomation.activate();
  });
}

function FINALIZE_20260930_verifySingleServiceOpsModel() {
  return CF.PublicRunners.run('Verify single ServiceOps model', function () {
    if(!CF.EventDrivenServiceAutomation||typeof CF.EventDrivenServiceAutomation.inspect!=='function') {
      throw new Error('Final ServiceOps v5.14.2 is not loaded.');
    }
    var state=CF.EventDrivenServiceAutomation.inspect();
    var automationHandlers=[];
    ScriptApp.getProjectTriggers().forEach(function(t){
      try{
        var h=String(t.getHandlerFunction&&t.getHandlerFunction()||'');
        if(h==='AUTO_FINAL_ServiceOps'||h==='AUTO_98_E2E_Recovery_Watchdog'||h==='CFH_refreshOperationalCacheIfIdle'){
          automationHandlers.push(h);
        }
      }catch(ignored){}
    });
    var counts={};
    automationHandlers.forEach(function(h){counts[h]=(counts[h]||0)+1;});
    var ok=state.singleModel===true &&
      Number(state.legacyAutomationTriggerCount||0)===0 &&
      Number(counts.AUTO_98_E2E_Recovery_Watchdog||0)===1 &&
      Number(counts.AUTO_FINAL_ServiceOps||0)<=1;
    return{
      ok:ok,
      version:'5.14.2',
      status:ok?'SINGLE_SERVICEOPS_MODEL_VERIFIED':'SINGLE_SERVICEOPS_MODEL_NOT_VERIFIED',
      state:state,
      activeAutomationHandlers:automationHandlers,
      handlerCounts:counts,
      liveWriteExecuted:false
    };
  });
}

function AUTO_FINAL_ServiceOps(e) {
  console.log('SERVICEOPS FINAL START');
  try {
    var result=CF.EventDrivenServiceAutomation.worker(e||{});
    console.log('SERVICEOPS FINAL RESULT: '+JSON.stringify({
      requestId:result&&result.requestId||'',
      status:result&&result.status||'',
      liveWriteExecuted:!!(result&&result.liveWriteExecuted===true),
      queuedRequestIds:result&&result.queuedRequestIds||[]
    }));
    return result;
  } catch(error) {
    console.error('SERVICEOPS FINAL ERROR: '+JSON.stringify({
      error:error&&error.message?error.message:String(error)
    }));
    throw error;
  }
}

function AUTO_98_E2E_Recovery_Watchdog(e) {
  if(!CF.EventDrivenServiceAutomation||typeof CF.EventDrivenServiceAutomation.recoveryWatchdog!=='function') {
    return {ok:false,version:'5.14.2',status:'RECOVERY_WATCHDOG_MODULE_MISSING',liveWriteExecuted:false};
  }
  return CF.EventDrivenServiceAutomation.recoveryWatchdog(e||{});
}


/* CF_SERVICEOPS_V5_10_2_TESTING_MENU_DRAFT_PREVIEW_R5
 * Sheet-first testing harness.
 * - Gives the operator a numbered Testing Menu in execution order.
 * - Resolves Request ID from the active Queue/Service Request row or Dashboard B3.
 * - Sales Order draft preview does NOT call the legacy Striven transaction preview,
 *   so the known read-only item_ reference cannot block Webform/Asset mapping tests.
 * - No Striven mutation occurs in any Testing Menu step except whatever existing
 *   matching/customer-structure code would normally do; these menu steps themselves
 *   only call the existing read-refresh/match/queue and draft-builder functions.
 */
function TESTING_selectedRequestId_() {
  var ss = CF.Util.getSpreadsheet();
  var sheet = ss.getActiveSheet();
  if (!sheet) throw new Error('Open 03 Operator Queue or 00 Dashboard first.');

  var row = sheet.getActiveRange() ? sheet.getActiveRange().getRow() : 0;
  if (row >= 2) {
    try {
      var headers = CF.Util.getActualHeaders(sheet);
      var requestCol = headers.indexOf('Request ID') + 1;
      if (requestCol) {
        var rowId = CF.Util.cleanText(sheet.getRange(row, requestCol).getValue());
        if (rowId) return rowId;
      }
    } catch (ignored) {}
  }

  try {
    var dashboardName = CF.Config.getSheetName('DASHBOARD');
    var dashboard = ss.getSheetByName(dashboardName);
    if (dashboard) {
      var dashboardId = CF.Util.cleanText(dashboard.getRange('B3').getValue());
      if (dashboardId) return dashboardId;
    }
  } catch (ignoredDashboard) {}

  throw new Error('Select a request row in 03 Operator Queue, or open a request on 00 Dashboard (Request ID in B3).');
}

function TESTING_buildMenu_() {
  /* CF_SERVICEOPS_V5_10_4_MANUAL_SELECTED_SALES_ORDER_MENU_R1 */
  /* CF_SERVICEOPS_V5_10_3_AUTOMATION_CUSTOM_LIST_TESTING_R1 */
  SpreadsheetApp.getUi().createMenu('CF ServiceOps Testing')
    .addItem('CURRENT RELEASE - Run Recovery / Resume', 'TESTING_CURRENT_runRecoveryResume')
    .addItem('CURRENT RELEASE - Read-Only Status Check', 'TESTING_CURRENT_runReadOnlyStatusCheck')
    .addSeparator()
    .addItem('0. Enable Incoming Request -> Sales Order Automation', 'TESTING_00_installIntakeAutomationTrigger')
    .addSeparator()
    .addItem('1. Refresh Customers + Contacts', 'TESTING_01_refreshCustomersContacts')
    .addItem('2. Refresh Locations', 'TESTING_02_refreshLocations')
    .addItem('3. Refresh Operational Data / Assets', 'TESTING_03_refreshOperationalData')
    .addItem('4. Process Matching', 'TESTING_04_processMatching')
    .addItem('5. Refresh Queue + Dashboard', 'TESTING_05_refreshQueueDashboard')
    .addItem('6. Inspect Sales Order Custom Lists', 'TESTING_06_inspectSalesOrderCustomLists')
    .addSeparator()
    .addItem('7. Preview Selected Sales Order Draft + Lists', 'TESTING_07_previewSelectedSalesOrderDraft')
    .addSeparator()
    .addItem('8. MANUAL - Create Sales Order for Selected Row', 'WRITE_processApproved')
    .addSeparator()
    .addItem('9. READ ONLY - Verify Internal Notes for Selected Rows', 'TESTING_09_verifySelectedInternalNotes')
    .addSeparator()
    .addItem('10. Update Internal Notes for Selected Rows', 'TESTING_10_updateInternalNotesViaOfficialApiTest')
    .addSeparator()
    .addItem('11. Recheck End-to-End Status for Selected Row', 'TESTING_11_recheckSelectedEndToEnd')
    .addItem('12. RERUN End-to-End for Selected Row', 'TESTING_12_rerunSelectedEndToEnd')
    .addItem('13. Sync Customer + Contact Info for Selected Row', 'TESTING_13_syncCustomerContactInfoSelectedRow')
    .addItem('14. Preview Realtime Performance for Selected Row', 'TESTING_14_previewRealtimePerformanceSelectedRow')
    .addItem('15. Preview Self-Healing Recovery for Selected Row', 'TESTING_15_previewSelfHealingRecoverySelectedRow')
    .addItem('16. Preview Location Self-Healing for Selected Row', 'TESTING_16_previewLocationSelfHealingSelectedRow')
    .addItem('17. READ ONLY - Preview Sales Order Certification for Selected Row', 'TESTING_17_previewSalesOrderCertificationSelectedRow')
    .addItem('18. READ ONLY - Preview Recovery Controller', 'TESTING_18_previewRecoveryController')
    .addSeparator()
    .addItem('19. READ ONLY - Reconcile Selected Contact Association', 'TESTING_19_reconcileSelectedContactAssociationReadOnly')
    .addItem('20. READ ONLY - Recover Technical Association Batch', 'TESTING_20_recoverTechnicalAssociationsReadOnly')
    .addToUi();
}

function TESTING_01_refreshCustomersContacts() {
  return CF.PublicRunners.run('TEST 1/6 - Refresh Customers + Contacts', function () {
    return CF.StrivenData.refreshCustomerData({});
  });
}

function TESTING_02_refreshLocations() {
  return CF.PublicRunners.run('TEST 2/6 - Refresh Locations', function () {
    return CF.StrivenData.refreshLocationData({});
  });
}

function TESTING_03_refreshOperationalData() {
  return CF.PublicRunners.run('TEST 3/6 - Refresh Operational Data / Assets', function () {
    return CF.StrivenData.refreshOperationalData({});
  });
}

function TESTING_04_processMatching() {
  return CF.PublicRunners.run('TEST 4/6 - Process Matching', function () {
    return CF.Matching.processAll();
  });
}

function TESTING_05_refreshQueueDashboard() {
  return CF.PublicRunners.run('TEST 5/6 - Refresh Queue + Dashboard', function () {
    return CF.OperatorQueue.refresh();
  });
}

function TESTING_06_previewSelectedSalesOrderDraft() {
  return TESTING_07_previewSelectedSalesOrderDraft();
}


function TESTING_00_installIntakeAutomationTrigger() {
  return CF.PublicRunners.run('TEST 0 - Enable Incoming Request to Sales Order', function () {
    var result = CF.EventDrivenServiceAutomation.verifySetup();
    console.log('TEST 0 - Incoming Request to Sales Order: ' + JSON.stringify(result));
    return result;
  });
}

function TESTING_06_inspectSalesOrderCustomLists() {
  return CF.PublicRunners.run('TEST 6/7 - Inspect Sales Order Custom Lists', function () {
    if (!CF.StrivenCustomLists || typeof CF.StrivenCustomLists.inspect !== 'function') {
      throw new Error('CF.StrivenCustomLists.inspect is unavailable.');
    }
    return CF.StrivenCustomLists.inspect({ force: true });
  });
}

function TESTING_07_previewSelectedSalesOrderDraft() {
  return CF.PublicRunners.run('TEST 7/7 - Sales Order Draft + Lists', function () {
    var requestId = TESTING_selectedRequestId_();
    if (!CF.SalesOrderDraft || typeof CF.SalesOrderDraft.build !== 'function') {
      throw new Error('Sales Order draft layer is unavailable.');
    }
    var draft = CF.SalesOrderDraft.build(requestId);
    var text = typeof CF.SalesOrderDraft.format === 'function' ? CF.SalesOrderDraft.format(draft) : '';
    if (CF.OperatorQueue && typeof CF.OperatorQueue.openRequest === 'function') {
      CF.OperatorQueue.openRequest(requestId, { activate: false });
    }
    return {
      ok: draft && draft.customListInspection && draft.customListInspection.ok === true,
      version: '5.10.3',
      mode: 'READ_ONLY_SALES_ORDER_DRAFT_CUSTOM_LIST_TEST',
      requestId: requestId,
      salesOrderDraft: draft,
      salesOrderDraftText: text,
      customListResolution: draft.customListResolution || {},
      legacyTransactionPreviewCalled: false,
      liveWriteExecuted: false
    };
  });
}

/* CF_SERVICEOPS_V5_10_11_RUNNER_R1 */

/* CF_SERVICEOPS_V5_10_12_RUNNER_R1 */


/* CF_SERVICEOPS_V5_10_13_DEPLOYMENT_COMPLETION_R6 */
/* CONTROLLED SINGLE-REQUEST MATCHING RECHECK
 *
 * PURPOSE
 * - Recheck exactly one known Service Request.
 * - Does NOT depend on the active Sheet row.
 * - Does NOT call global processAll().
 * - Does NOT write anything to Striven.
 * - Persists only the matching result back to the Service Request.
 * - Refreshes Operator Queue afterward for visibility.
 */

function MATCH_recheckSelectedRequest() {
  return CF.PublicRunners.run(
    'Recheck Gordon Pon request only',
    function () {
      var REQUEST_ID = 'SR-20260825074134-9401';

      if (
        !CF.Matching ||
        typeof CF.Matching.recheckRequest !== 'function'
      ) {
        throw new Error(
          'CF.Matching.recheckRequest is unavailable.'
        );
      }

      var matchingResult = CF.Matching.recheckRequest(
        REQUEST_ID,
        {
          persist: true
        }
      );

      var queueRefresh = null;
      var queueRefreshError = '';

      try {
        if (
          CF.OperatorQueue &&
          typeof CF.OperatorQueue.refresh === 'function'
        ) {
          queueRefresh = CF.OperatorQueue.refresh();
        }
      } catch (error) {
        queueRefreshError =
          error && error.message
            ? error.message
            : String(error);
      }

      var result = {
        ok: matchingResult && matchingResult.ok !== false,

        version: '5.10.13',

        mode: 'CONTROLLED_SINGLE_REQUEST_RECHECK',

        requestId: REQUEST_ID,

        matching: matchingResult,

        queueRefresh: queueRefresh,

        queueRefreshError: queueRefreshError,

        requestSelectionRequired: false,

        globalProcessAllCalled: false,

        strivenMutationExecuted: false,

        liveWriteExecuted: false
      };

      console.log(
        'Controlled Request Recheck: ' +
        JSON.stringify(result)
      );

      return result;
    }
  );
}


/* CF_SERVICEOPS_V5_10_13_CONTROLLED_EXISTING_REQUEST_REPROCESS_R1
 *
 * Re-enqueues exactly one existing Service Request into the normal
 * production event-driven workflow.
 *
 * IMPORTANT:
 * - Does NOT create the Sales Order itself.
 * - Does NOT call the Sales Order writer directly.
 * - Does NOT call global matching.
 * - Uses the same CF.EventDrivenServiceAutomation.kick() path used
 *   for normal incoming Webform requests.
 * - If safety gates pass, the subsequent one-shot worker MAY CREATE
 *   one real Quoted Sales Order in Striven.
 */

function REPROCESS_GordonPonRequest() {
  return CF.PublicRunners.run(
    'Reprocess Gordon Pon through production automation',
    function () {
      var REQUEST_ID = 'SR-20260825074134-9401';

      if (
        !CF.EventDrivenServiceAutomation ||
        typeof CF.EventDrivenServiceAutomation.kick !== 'function'
      ) {
        throw new Error(
          'CF.EventDrivenServiceAutomation.kick is unavailable.'
        );
      }

      var request = CF.Util.findRecord(
        'SERVICE_REQUESTS',
        'Request ID',
        REQUEST_ID
      );

      if (!request) {
        throw new Error(
          'Service Request not found: ' + REQUEST_ID
        );
      }

      var clean = function (value) {
        return value === null || value === undefined
          ? ''
          : String(value).trim();
      };

      var upper = function (value) {
        return clean(value).toUpperCase();
      };

      /*
       * Absolute duplicate protection:
       * never re-enqueue if the request already has a durable
       * Sales Order / Work Order ID.
       */
      if (clean(request['Work Order ID'])) {
        return {
          ok: true,
          version: '5.10.13',
          status: 'ALREADY_HAS_DURABLE_SALES_ORDER',
          requestId: REQUEST_ID,
          workOrderId: clean(request['Work Order ID']),
          workOrderNumber: clean(request['Work Order Number']),
          queued: false,
          liveWriteExecuted: false
        };
      }

      /*
       * Require the corrected Gordon resolution to still be intact.
       */
      var customerId = clean(
        request['Matched Customer ID'] ||
        request['Created Customer ID']
      );

      var contactId = clean(
        request['Matched Contact ID'] ||
        request['Created Contact ID']
      );

      var locationId = clean(
        request['Matched Location ID'] ||
        request['Created Location ID']
      );

      if (
        customerId !== '45208' ||
        contactId !== '39433' ||
        locationId !== '40212'
      ) {
        throw new Error(
          'Safety stop: Gordon resolution is no longer the expected ' +
          'Customer 45208 / Contact 39433 / Location 40212.'
        );
      }

      if (upper(request['Manual Review?']) === 'YES') {
        throw new Error(
          'Safety stop: request is currently marked for manual review.'
        );
      }

      if (upper(request['Duplicate Risk Status']) !== 'NONE') {
        throw new Error(
          'Safety stop: duplicate risk is not NONE.'
        );
      }

      if (
        [
          'BLOCKED',
          'DUPLICATE',
          'CANCELLED',
          'CANCELED',
          'ERROR'
        ].indexOf(upper(request['Request Status'])) !== -1
      ) {
        throw new Error(
          'Safety stop: Request Status is ' +
          clean(request['Request Status']) +
          '.'
        );
      }

      /*
       * Do not insert Gordon ahead of another request that may
       * already be processing.
       */
      var existingQueue = [];

      try {
        if (
          typeof CF.EventDrivenServiceAutomation.queuedRequestIds ===
          'function'
        ) {
          existingQueue =
            CF.EventDrivenServiceAutomation.queuedRequestIds() || [];
        }
      } catch (ignoredQueueRead) {
        existingQueue = [];
      }

      var otherQueued = existingQueue.filter(function (id) {
        return clean(id) && clean(id) !== REQUEST_ID;
      });

      if (otherQueued.length) {
        throw new Error(
          'Safety stop: another incoming request is already queued: ' +
          otherQueued.join(', ')
        );
      }

      /*
       * This is the real production entry point.
       * kick() only queues/schedules the one-shot worker.
       */
      var kick =
        CF.EventDrivenServiceAutomation.kick(REQUEST_ID);

      var result = {
        ok: kick && kick.ok !== false,
        version: '5.10.13',
        mode: 'CONTROLLED_EXISTING_REQUEST_REPROCESS',
        requestId: REQUEST_ID,

        durableStateBefore: {
          stage: clean(request['Current Stage']),
          requestStatus: clean(request['Request Status']),
          customerId: customerId,
          contactId: contactId,
          locationId: locationId,
          workOrderId: '',
          workOrderNumber: ''
        },

        queueBefore: existingQueue,
        kick: kick,

        productionAutomationUsed: true,
        directSalesOrderWriterCalled: false,
        globalMatchingCalled: false,
        liveWriteExecuted: false,

        next:
          'ONE-SHOT PRODUCTION AUTOMATION SCHEDULED — ' +
          'DO NOT RUN MANUAL SALES ORDER FUNCTIONS'
      };

      console.log(
        'Controlled Gordon production reprocess: ' +
        JSON.stringify(result)
      );

      return result;
    }
  );
}


function DIAG_readGordonSalesOrderInternalNotes() {
  return CF.PublicRunners.run(
    'Read Gordon Sales Order Internal Notes shape',
    function () {
      var SALES_ORDER_ID = '26418';

      if (
        !CF.StrivenHttp ||
        typeof CF.StrivenHttp.requestJson !== 'function'
      ) {
        throw new Error(
          'CF.StrivenHttp.requestJson is unavailable.'
        );
      }

      var response = CF.StrivenHttp.requestJson(
        '/v1/sales-orders/' + SALES_ORDER_ID,
        {
          method: 'get',
          attempts: 1,
          idempotent: true
        }
      );

      var body =
        response && response.json
          ? response.json
          : {};

      var notes;

      if (
        Object.prototype.hasOwnProperty.call(
          body,
          'internalNotes'
        )
      ) {
        notes = body.internalNotes;
      } else {
        notes = body.InternalNotes;
      }

      var type =
        notes === null
          ? 'null'
          : Array.isArray(notes)
            ? 'array'
            : typeof notes;

      var keys =
        notes &&
        typeof notes === 'object' &&
        !Array.isArray(notes)
          ? Object.keys(notes)
          : [];

      var result = {
        ok: true,
        version: '5.10.13',
        mode: 'READ_ONLY_INTERNAL_NOTES_CONTRACT_DIAGNOSTIC',

        salesOrderId: SALES_ORDER_ID,
        orderNumber: body.orderNumber || '',

        internalNotesType: type,
        internalNotesKeys: keys,
        internalNotes: notes,

        httpStatus:
          response && response.status
            ? response.status
            : '',

        liveWriteExecuted: false
      };

      console.log(
        'Sales Order Internal Notes contract: ' +
        JSON.stringify(result)
      );

      return result;
    }
  );
}
/* CF_SERVICEOPS_V5_10_14_RUNTIME_INTERNAL_NOTES_QUEUE_R1 */


/* CF_SERVICEOPS_V5_10_15_LEAN_QUEUE_SNAPSHOT_R1 */
function AUTO_refreshDashboardSnapshot() {
  return CF.PublicRunners.run('Refresh Dashboard snapshot only', function () {
    if (!CF.OperatorQueue || typeof CF.OperatorQueue.refreshDashboard !== 'function') {
      throw new Error('CF.OperatorQueue.refreshDashboard is unavailable.');
    }
    var started = Date.now();
    var result = CF.OperatorQueue.refreshDashboard();
    var out = {
      ok: result && result.ok !== false,
      version: '5.10.15',
      mode: 'DASHBOARD_SNAPSHOT_ONLY',
      dashboard: result,
      durationMs: Date.now() - started,
      queueRefreshed: false,
      liveWriteExecuted: false
    };
    console.log('Dashboard Snapshot: ' + JSON.stringify(out));
    return out;
  });
}

/* CF_SERVICEOPS_V5_10_15_LEAN_QUEUE_SNAPSHOT_R2 */


/* CF_SERVICEOPS_V5_10_16_ALL_REQUEST_OPERATIONAL_RECONCILIATION_R1 */
function OPERATIONAL_previewAllRequestLinks() {
  return CF.PublicRunners.run('Preview all Request -> Sales Order/Task links', function () {
    if (
      typeof CF_SERVICEOPS_OPERATIONAL_LINK_RECONCILIATION_V51016_R1_ === 'undefined' ||
      !CF_SERVICEOPS_OPERATIONAL_LINK_RECONCILIATION_V51016_R1_
    ) {
      throw new Error('Operational Request Link reconciler is unavailable.');
    }
    var result = CF_SERVICEOPS_OPERATIONAL_LINK_RECONCILIATION_V51016_R1_.previewAll();
    result.liveWriteExecuted = false;
    console.log('Operational Request Link Preview: ' + JSON.stringify(result));
    return result;
  });
}

function OPERATIONAL_reconcileAllRequestLinks() {
  return CF.PublicRunners.run('Reconcile all Request -> Sales Order/Task links', function () {
    if (
      typeof CF_SERVICEOPS_OPERATIONAL_LINK_RECONCILIATION_V51016_R1_ === 'undefined' ||
      !CF_SERVICEOPS_OPERATIONAL_LINK_RECONCILIATION_V51016_R1_
    ) {
      throw new Error('Operational Request Link reconciler is unavailable.');
    }

    var started = Date.now();
    var reconciliation = CF_SERVICEOPS_OPERATIONAL_LINK_RECONCILIATION_V51016_R1_.reconcileAll({
      refreshIfStale: true
    });

    var queue = null;
    try {
      if (CF.OperatorQueue && typeof CF.OperatorQueue.refresh === 'function') {
        queue = CF.OperatorQueue.refresh();
      }
    } catch (queueError) {
      queue = {
        ok: false,
        error: queueError && queueError.message ? queueError.message : String(queueError)
      };
    }

    var out = {
      ok: reconciliation && reconciliation.ok !== false,
      version: '5.10.16',
      mode: 'ALL_REQUEST_OPERATIONAL_LINK_RECONCILIATION',
      reconciliation: reconciliation,
      queueRefresh: queue,
      durationMs: Date.now() - started,
      strivenMutationExecuted: false,
      liveWriteExecuted: false,
      googleSheetLinksPersisted: true
    };

    console.log('Operational Request Link Reconciliation: ' + JSON.stringify(out));
    return out;
  });
}



function DIAG_previewShelleyInternalNotesPayload() {
  return CF.PublicRunners.run(
    'Preview Shelley Internal Notes HTML payload only',
    function () {
      var REQUEST_ID = 'SR-20260825111136-2461';

      if (
        !CF.OrderPreflight ||
        typeof CF.OrderPreflight.previewRequest !== 'function'
      ) {
        throw new Error(
          'CF.OrderPreflight.previewRequest is unavailable.'
        );
      }

      var preview =
        CF.OrderPreflight.previewRequest(REQUEST_ID);

      var payload =
        preview && preview.payload
          ? preview.payload
          : {};

      var notes =
        payload.InternalNotes || null;

      var notesHtml =
        notes && typeof notes === 'object'
          ? String(
              notes.NotesHtml !== undefined
                ? notes.NotesHtml
                : notes.notesHtml || ''
            )
          : '';

      var notesText =
        notes && typeof notes === 'object'
          ? String(
              notes.NotesText !== undefined
                ? notes.NotesText
                : notes.notesText || ''
            )
          : '';

      function customField_(id) {
        var rows = payload.CustomFields || [];

        for (var i = 0; i < rows.length; i++) {
          if (
            String(rows[i].Id || rows[i].id) ===
            String(id)
          ) {
            return String(
              rows[i].Value !== undefined
                ? rows[i].Value
                : rows[i].value || ''
            );
          }
        }

        return '';
      }

      var htmlLooksCorrect =
        /<table\b/i.test(notesHtml) &&
        /<tr\b/i.test(notesHtml) &&
        /<td\b/i.test(notesHtml) &&
        notesHtml.indexOf('Request ID') !== -1 &&
        notesHtml.indexOf(REQUEST_ID) !== -1 &&
        notesHtml.indexOf('Make / Model / Age') !== -1 &&
        notesHtml.indexOf('Valor G3 739') !== -1 &&
        notesHtml.indexOf('| --- |') === -1;

      var textLooksCorrect =
        notesText.indexOf('WEBFORM SERVICE REQUEST') === 0 &&
        notesText.indexOf(
          'Request ID: ' + REQUEST_ID
        ) !== -1 &&
        notesText.indexOf(
          'Customer: Shelley Mascarin'
        ) !== -1 &&
        notesText.indexOf(
          'Make / Model / Age: Valor G3 739'
        ) !== -1 &&
        notesText.indexOf('| Field | Value |') === -1;

      var result = {
        ok:
          !!notes &&
          htmlLooksCorrect &&
          textLooksCorrect &&
          customField_(855) === '570',

        version: '5.10.17',
        mode:
          'READ_ONLY_INTERNAL_NOTES_HTML_PAYLOAD_PREVIEW',

        requestId: REQUEST_ID,

        readyForApproval:
          !!(
            preview &&
            preview.readyForApproval
          ),

        blockers:
          preview &&
          preview.blockers
            ? preview.blockers
            : [],

        requestSource855:
          customField_(855),

        manufacturerModel651:
          customField_(651),

        internalNotesPresent:
          !!notes,

        internalNotesKeys:
          notes &&
          typeof notes === 'object'
            ? Object.keys(notes)
            : [],

        notesHtmlContainsRealTable:
          htmlLooksCorrect,

        notesTextIsCleanPlainText:
          textLooksCorrect,

        notesHtmlPreview:
          notesHtml,

        notesTextPreview:
          notesText,

        salesOrderApproved: false,
        salesOrderCreated: false,
        strivenMutationExecuted: false,
        liveWriteExecuted: false
      };

      console.log(
        'Shelley Internal Notes HTML Payload Preview: ' +
        JSON.stringify(result)
      );

      return result;
    }
  );
}




function TEST_createShelleyAndVerifyInternalNotes() {
  return CF.PublicRunners.run(
    'Create Shelley SO and verify Internal Notes',
    function () {
      var REQUEST_ID = 'SR-20260825111136-2461';

      function clean_(v) {
        return v === null || v === undefined
          ? ''
          : String(v).trim();
      }

      function normalizeText_(v) {
        return String(v === null || v === undefined ? '' : v)
          .replace(/\r\n?/g, '\n')
          .trim();
      }

      function fieldValue_(rows, id) {
        rows = rows || [];

        for (var i = 0; i < rows.length; i++) {
          if (String(rows[i].Id || rows[i].id) === String(id)) {
            return String(
              rows[i].Value !== undefined
                ? rows[i].Value
                : rows[i].value || ''
            );
          }
        }

        return '';
      }

      if (
        !CF.OrderPreflight ||
        typeof CF.OrderPreflight.previewRequest !== 'function' ||
        typeof CF.OrderPreflight.approveRequest !== 'function' ||
        typeof CF.OrderPreflight.executeApproved !== 'function'
      ) {
        throw new Error(
          'CF.OrderPreflight guarded Sales Order functions are unavailable.'
        );
      }

      var request = CF.Util.findRecord(
        'SERVICE_REQUESTS',
        'Request ID',
        REQUEST_ID
      );

      if (!request) {
        throw new Error('Service Request not found.');
      }

      /*
       * ABSOLUTE DUPLICATE GUARD.
       */
      if (
        clean_(request['Work Order ID']) ||
        clean_(request['Work Order Number'])
      ) {
        return {
          ok: false,
          status: 'ALREADY_HAS_DURABLE_SALES_ORDER',
          requestId: REQUEST_ID,
          workOrderId: clean_(request['Work Order ID']),
          workOrderNumber: clean_(request['Work Order Number']),
          liveWriteExecuted: false
        };
      }

      if (clean_(request['Manual Review?']).toUpperCase() === 'YES') {
        throw new Error(
          'Safety stop: Shelley is marked for Manual Review.'
        );
      }

      if (
        clean_(request['Duplicate Risk Status']).toUpperCase() !==
        'NONE'
      ) {
        throw new Error(
          'Safety stop: Duplicate Risk Status is not NONE.'
        );
      }

      /*
       * FINAL PRE-WRITE PREVIEW.
       */
      var preview =
        CF.OrderPreflight.previewRequest(REQUEST_ID);

      if (!preview.readyForApproval) {
        throw new Error(
          'Final Sales Order preview is not safe: ' +
          JSON.stringify(preview.blockers || [])
        );
      }

      if (
        clean_(preview.state.customerId) !== '57392' ||
        clean_(preview.state.contactId) !== '51361' ||
        clean_(preview.state.locationId) !== '53378'
      ) {
        throw new Error(
          'Safety stop: resolved Striven identity changed.'
        );
      }

      var payload = preview.payload || {};
      var expectedNotes =
        payload.InternalNotes || {};

      var expectedText =
        normalizeText_(expectedNotes.NotesText);

      if (!expectedText) {
        throw new Error(
          'Safety stop: Internal Notes payload is blank.'
        );
      }

      if (
        normalizeText_(expectedNotes.NotesHtml) !== expectedText
      ) {
        throw new Error(
          'Safety stop: NotesHtml and NotesText differ.'
        );
      }

      if (
        fieldValue_(payload.CustomFields, 855) !== '570'
      ) {
        throw new Error(
          'Safety stop: Request Source 855 is not Webform/570.'
        );
      }

      if (!fieldValue_(payload.CustomFields, 651)) {
        throw new Error(
          'Safety stop: Manufacturer / Model 651 is blank.'
        );
      }

      /*
       * APPROVAL WRITES ONLY THE LOCAL GUARDED JOURNAL.
       * NO STRIVEN POST YET.
       */
      var approval =
        CF.OrderPreflight.approveRequest(REQUEST_ID);

      /*
       * Re-preview after approval so the write fingerprint and
       * readiness must still match before crossing the boundary.
       */
      var approvedPreview =
        CF.OrderPreflight.previewRequest(REQUEST_ID);

      if (!approvedPreview.readyForLivePost) {
        return {
          ok: false,
          status: 'APPROVED_BUT_NOT_READY_FOR_LIVE_POST',
          requestId: REQUEST_ID,
          approval: approval,
          blockers: approvedPreview.blockers || [],
          liveWriteExecuted: false
        };
      }

      if (
        approvedPreview.writeFingerprint !==
        preview.writeFingerprint
      ) {
        throw new Error(
          'Safety stop: payload changed after approval.'
        );
      }

      /*
       * EXACTLY ONE GUARDED LIVE POST.
       *
       * DO NOT retry this function if the result indicates that
       * the live write boundary was crossed.
       */
      var execution =
        CF.OrderPreflight.executeApproved(
          REQUEST_ID,
          {
            executionToken:
              CF.OrderPreflight.executionToken
          }
        );

      var salesOrderId =
        clean_(
          execution &&
          (
            execution.salesOrderId ||
            execution.workOrderId
          )
        );

      /*
       * If Striven may have been written but no ID is available,
       * stop for reconciliation. Never retry blindly.
       */
      if (!salesOrderId) {
        return {
          ok: false,
          status:
            'LIVE_WRITE_RESULT_REQUIRES_RECONCILIATION',
          requestId: REQUEST_ID,
          approval: approval,
          execution: execution,
          liveWriteExecuted:
            !!(
              execution &&
              execution.liveWriteExecuted
            ),
          next:
            'DO NOT CREATE ANOTHER SALES ORDER'
        };
      }

      /*
       * Independent GET verification of the actual saved order.
       */
      var response =
        CF.StrivenHttp.requestJson(
          '/v1/sales-orders/' +
            encodeURIComponent(salesOrderId),
          {
            method: 'get',
            attempts: 1,
            idempotent: true
          }
        );

      var body =
        response && response.json
          ? response.json
          : {};

      var savedNotes =
        body.internalNotes !== undefined
          ? body.internalNotes
          : body.InternalNotes;

      var savedNotesText =
        savedNotes && typeof savedNotes === 'object'
          ? normalizeText_(
              savedNotes.notesText !== undefined
                ? savedNotes.notesText
                : savedNotes.NotesText
            )
          : '';

      var savedNotesHtml =
        savedNotes && typeof savedNotes === 'object'
          ? normalizeText_(
              savedNotes.notesHtml !== undefined
                ? savedNotes.notesHtml
                : savedNotes.NotesHtml
            )
          : '';

      var customFields =
        body.customFields ||
        body.CustomFields ||
        [];

      var requestSource =
        fieldValue_(customFields, 855);

      var manufacturerModel =
        fieldValue_(customFields, 651);

      var notesTextConfirmed =
        savedNotesText === expectedText;

      var notesHtmlConfirmed =
        savedNotesHtml === expectedText;

      var requestSourceConfirmed =
        requestSource === '570';

      var result = {
        ok:
          notesTextConfirmed &&
          notesHtmlConfirmed &&
          requestSourceConfirmed,

        version: '5.10.16',

        mode:
          'CONTROLLED_LIVE_INTERNAL_NOTES_PERSISTENCE_TEST',

        requestId: REQUEST_ID,

        salesOrderId: salesOrderId,

        orderNumber:
          clean_(body.orderNumber),

        orderStatus:
          clean_(
            body.status &&
            body.status.name
          ),

        customerId:
          clean_(
            body.customer &&
            body.customer.id
          ),

        contactId:
          clean_(
            body.contact &&
            body.contact.id
          ),

        locationId:
          clean_(
            body.shipToLocation &&
            body.shipToLocation.id
          ),

        internalNotesPresent:
          !!savedNotes,

        internalNotesKeys:
          savedNotes &&
          typeof savedNotes === 'object'
            ? Object.keys(savedNotes)
            : [],

        notesTextConfirmed:
          notesTextConfirmed,

        notesHtmlConfirmed:
          notesHtmlConfirmed,

        expectedInternalNotes:
          expectedText,

        savedInternalNotes:
          savedNotes,

        requestSource855:
          requestSource,

        requestSourceConfirmed:
          requestSourceConfirmed,

        manufacturerModel651:
          manufacturerModel,

        approval: approval,

        execution: execution,

        liveWriteExecuted: true,

        next:
          notesTextConfirmed &&
          notesHtmlConfirmed
            ? 'INTERNAL NOTES PERSISTENCE PROVEN'
            : 'DO NOT CREATE ANOTHER SALES ORDER — RECONCILE THIS EXISTING ORDER'
      };

      console.log(
        'Shelley Internal Notes Live Persistence Test: ' +
        JSON.stringify(result)
      );

      return result;
    }
  );
}





/* CF_SERVICEOPS_V5_10_17_INTERNAL_NOTES_HTML_R1 */


function DIAG_previewSO26425InternalNotesReplacement() {
  return CF.PublicRunners.run(
    'Preview SO 26425 Internal Notes semantic verification',
    function () {
      var REQUEST_ID = 'SR-20260825111136-2461';
      var SALES_ORDER_ID = '26425';
      var ORDER_NUMBER = '584695';
      var CUSTOMER_ID = '57392';

      if (
        !CF.OrderPreflight ||
        typeof CF.OrderPreflight.previewRequest !== 'function'
      ) {
        throw new Error('CF.OrderPreflight.previewRequest is unavailable.');
      }

      if (
        !CF.StrivenHttp ||
        typeof CF.StrivenHttp.requestJson !== 'function'
      ) {
        throw new Error('CF.StrivenHttp.requestJson is unavailable.');
      }

      function body_(response) {
        var value = response && response.json !== undefined
          ? response.json
          : response;

        if (
          value &&
          typeof value === 'object' &&
          value.data &&
          typeof value.data === 'object' &&
          !Array.isArray(value.data)
        ) {
          return value.data;
        }

        return value || {};
      }

      function notePart_(notes, html) {
        if (!notes) return '';
        if (typeof notes === 'string' || typeof notes === 'number') {
          return String(notes);
        }
        if (typeof notes !== 'object') return '';

        var keys = html
          ? ['notesHtml', 'NotesHtml']
          : ['notesText', 'NotesText'];

        for (var i = 0; i < keys.length; i++) {
          if (notes[keys[i]] !== undefined) {
            return String(notes[keys[i]] || '');
          }
        }
        return '';
      }

      function decodeHtml_(value) {
        return String(value || '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;|&apos;/gi, "'")
          .replace(/&#x([0-9a-f]+);/gi, function (_, hex) {
            return String.fromCharCode(parseInt(hex, 16));
          })
          .replace(/&#(\d+);/g, function (_, dec) {
            return String.fromCharCode(parseInt(dec, 10));
          });
      }

      function cleanCell_(value) {
        return decodeHtml_(
          String(value || '')
            .replace(/<br\s*\/?\s*>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
        )
          .replace(/[\u00a0\s]+/g, ' ')
          .trim();
      }

      function key_(value) {
        return cleanCell_(value).toLowerCase();
      }

      function tableRows_(html) {
        var rows = [];
        var rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
        var rowMatch;

        while ((rowMatch = rowRe.exec(String(html || '')))) {
          var cells = [];
          var cellRe = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
          var cellMatch;
          while ((cellMatch = cellRe.exec(rowMatch[1]))) {
            cells.push(cleanCell_(cellMatch[1]));
          }
          if (cells.length >= 2 && cells[0]) {
            rows.push({ label: cells[0], value: cells[1] });
          }
        }
        return rows;
      }

      function compareRows_(expectedRows, actualRows) {
        var expectedMap = {};
        var actualMap = {};
        var differences = [];
        var i;

        for (i = 0; i < expectedRows.length; i++) {
          expectedMap[key_(expectedRows[i].label)] = cleanCell_(expectedRows[i].value);
        }
        for (i = 0; i < actualRows.length; i++) {
          actualMap[key_(actualRows[i].label)] = cleanCell_(actualRows[i].value);
        }

        Object.keys(expectedMap).forEach(function (k) {
          if (!Object.prototype.hasOwnProperty.call(actualMap, k)) {
            differences.push({ type: 'MISSING_FIELD', field: k, expected: expectedMap[k], actual: '' });
          } else if (actualMap[k] !== expectedMap[k]) {
            differences.push({ type: 'VALUE_MISMATCH', field: k, expected: expectedMap[k], actual: actualMap[k] });
          }
        });

        Object.keys(actualMap).forEach(function (k) {
          if (!Object.prototype.hasOwnProperty.call(expectedMap, k)) {
            differences.push({ type: 'UNEXPECTED_FIELD', field: k, expected: '', actual: actualMap[k] });
          }
        });

        return {
          matches: differences.length === 0,
          expectedFieldCount: Object.keys(expectedMap).length,
          actualFieldCount: Object.keys(actualMap).length,
          differences: differences,
          expected: expectedMap,
          actual: actualMap
        };
      }

      function textContainsRows_(text, expectedRows) {
        var haystack = cleanCell_(text).toLowerCase();
        var missing = [];
        for (var i = 0; i < expectedRows.length; i++) {
          var label = cleanCell_(expectedRows[i].label).toLowerCase();
          var value = cleanCell_(expectedRows[i].value).toLowerCase();
          if (label && haystack.indexOf(label) === -1) missing.push('label:' + expectedRows[i].label);
          if (value && haystack.indexOf(value) === -1) missing.push('value:' + expectedRows[i].value);
        }
        return { matches: missing.length === 0, missing: missing };
      }

      var preview = CF.OrderPreflight.previewRequest(REQUEST_ID);
      var payload = preview && preview.payload ? preview.payload : {};
      var replacement = payload.InternalNotes || null;

      if (!replacement || typeof replacement !== 'object') {
        throw new Error('The v5.10.17+ InternalNotes object was not generated.');
      }

      var current = body_(
        CF.StrivenHttp.requestJson(
          '/v1/sales-orders/' + SALES_ORDER_ID,
          { method: 'get' }
        )
      );

      var currentCustomerId =
        current.customer && current.customer.id !== undefined
          ? String(current.customer.id)
          : '';

      var identityConfirmed =
        String(current.id || '') === SALES_ORDER_ID &&
        String(current.orderNumber || '') === ORDER_NUMBER &&
        currentCustomerId === CUSTOMER_ID;

      if (!identityConfirmed) {
        throw new Error(
          'Hard guard failed. Expected Sales Order ' +
          SALES_ORDER_ID + ' / Order ' + ORDER_NUMBER +
          ' / Customer ' + CUSTOMER_ID + '.'
        );
      }

      var currentNotes = current.internalNotes || current.InternalNotes || null;
      var currentHtml = notePart_(currentNotes, true);
      var currentText = notePart_(currentNotes, false);
      var newHtml = notePart_(replacement, true);
      var newText = notePart_(replacement, false);

      var expectedRows = tableRows_(newHtml);
      var currentRows = tableRows_(currentHtml);
      var tableComparison = compareRows_(expectedRows, currentRows);
      var textComparison = textContainsRows_(currentText, expectedRows);

      var replacementFormatValid =
        /<table\b/i.test(newHtml) &&
        expectedRows.length > 0 &&
        newHtml.indexOf(REQUEST_ID) !== -1 &&
        newHtml.indexOf('| --- |') === -1 &&
        newText.indexOf('WEBFORM SERVICE REQUEST') === 0 &&
        newText.indexOf('| Field | Value |') === -1;

      var currentTitlePresent =
        cleanCell_(currentHtml).toLowerCase().indexOf('webform service request') !== -1;

      var semanticContentMatches =
        replacementFormatValid &&
        currentTitlePresent &&
        tableComparison.matches &&
        textComparison.matches;

      var result = {
        ok: identityConfirmed && replacementFormatValid,
        version: '5.10.19',
        mode: 'READ_ONLY_EXISTING_SALES_ORDER_INTERNAL_NOTES_SEMANTIC_VERIFICATION',
        requestId: REQUEST_ID,
        salesOrderId: SALES_ORDER_ID,
        orderNumber: ORDER_NUMBER,
        customerId: CUSTOMER_ID,
        identityConfirmed: identityConfirmed,
        currentInternalNotesId:
          currentNotes && typeof currentNotes === 'object'
            ? String(currentNotes.id || '')
            : '',
        currentUsesMarkdownTable:
          currentHtml.indexOf('| Field | Value |') !== -1 ||
          currentText.indexOf('| Field | Value |') !== -1,
        currentUsesRealHtmlTable: /<table\b/i.test(currentHtml),
        replacementUsesRealHtmlTable: /<table\b/i.test(newHtml),
        replacementTextIsCleanPlainText:
          newText.indexOf('| Field | Value |') === -1,
        semanticTableMatches: tableComparison.matches,
        semanticTextMatches: textComparison.matches,
        semanticContentMatches: semanticContentMatches,
        replacementRequired: !semanticContentMatches,
        expectedFieldCount: tableComparison.expectedFieldCount,
        currentFieldCount: tableComparison.actualFieldCount,
        semanticDifferences: tableComparison.differences,
        textSemanticMissing: textComparison.missing,
        currentSemanticFields: tableComparison.actual,
        expectedSemanticFields: tableComparison.expected,
        currentNotesHtml: currentHtml,
        currentNotesText: currentText,
        replacementNotesHtml: newHtml,
        replacementNotesText: newText,
        strivenMutationExecuted: false,
        liveWriteExecuted: false,
        next: semanticContentMatches
          ? 'PASS — saved Striven Internal Notes are semantically equivalent to the generated replacement. No replacement required.'
          : 'Review semanticDifferences/textSemanticMissing before any mutation.'
      };

      console.log(
        'SO 26425 Internal Notes Semantic Verification: ' +
        JSON.stringify(result)
      );

      return result;
    }
  );
}


function TEST_replaceSO26425InternalNotes() {
  return CF.PublicRunners.run(
    'Guarded replace SO 26425 Internal Notes',
    function () {
      var REQUEST_ID = 'SR-20260825111136-2461';
      var SALES_ORDER_ID = '26425';
      var ORDER_NUMBER = '584695';
      var CUSTOMER_ID = '57392';
      var props = PropertiesService.getScriptProperties();

      var verified = String(
        props.getProperty('STRIVEN_SALES_ORDER_INTERNAL_NOTES_UPDATE_CONTRACT_VERIFIED') || ''
      ).trim().toUpperCase();
      var method = String(
        props.getProperty('STRIVEN_SALES_ORDER_INTERNAL_NOTES_UPDATE_METHOD') || ''
      ).trim().toUpperCase();
      var template = String(
        props.getProperty('STRIVEN_SALES_ORDER_INTERNAL_NOTES_UPDATE_ENDPOINT_TEMPLATE') || ''
      ).trim();
      var payloadMode = String(
        props.getProperty('STRIVEN_SALES_ORDER_INTERNAL_NOTES_UPDATE_PAYLOAD_MODE') || ''
      ).trim().toUpperCase();

      if (verified !== 'TRUE' || !method || !template || !payloadMode) {
        return {
          ok: false,
          version: '5.10.19',
          status: 'BLOCKED_NO_VERIFIED_STRIVEN_UPDATE_CONTRACT',
          requestId: REQUEST_ID,
          salesOrderId: SALES_ORDER_ID,
          requiredScriptProperties: [
            'STRIVEN_SALES_ORDER_INTERNAL_NOTES_UPDATE_CONTRACT_VERIFIED=TRUE',
            'STRIVEN_SALES_ORDER_INTERNAL_NOTES_UPDATE_METHOD=POST|PUT|PATCH',
            'STRIVEN_SALES_ORDER_INTERNAL_NOTES_UPDATE_ENDPOINT_TEMPLATE=<verified endpoint containing {id}>',
            'STRIVEN_SALES_ORDER_INTERNAL_NOTES_UPDATE_PAYLOAD_MODE=WRAPPED_INTERNAL_NOTES|NOTES_OBJECT_ONLY'
          ],
          liveWriteExecuted: false,
          reason: 'No verified existing-Sales-Order Internal Notes update contract is configured. The test refuses to guess.'
        };
      }

      if (['POST', 'PUT', 'PATCH'].indexOf(method) === -1) {
        throw new Error('Unsupported configured update method: ' + method);
      }
      if (template.indexOf('{id}') === -1) {
        throw new Error('Configured endpoint template must contain {id}.');
      }

      var endpoint = template.replace(/\{id\}/g, SALES_ORDER_ID);
      if (
        endpoint === '/v1/sales-orders' ||
        endpoint === 'https://api.striven.com/v1/sales-orders'
      ) {
        throw new Error('Create endpoint is forbidden for the existing-order test.');
      }
      if (
        endpoint.indexOf(SALES_ORDER_ID) === -1 ||
        endpoint.toLowerCase().indexOf('sales-orders') === -1
      ) {
        throw new Error('Configured endpoint failed the Sales Order 26425 hard guard.');
      }

      if (
        !CF.OrderPreflight ||
        typeof CF.OrderPreflight.previewRequest !== 'function' ||
        !CF.StrivenHttp ||
        typeof CF.StrivenHttp.requestJson !== 'function'
      ) {
        throw new Error('Required OrderPreflight/StrivenHttp dependencies are unavailable.');
      }

      function body_(response) {
        var value = response && response.json !== undefined ? response.json : response;
        if (
          value && typeof value === 'object' &&
          value.data && typeof value.data === 'object' &&
          !Array.isArray(value.data)
        ) return value.data;
        return value || {};
      }

      function notePart_(notes, html) {
        if (!notes) return '';
        if (typeof notes === 'string' || typeof notes === 'number') return String(notes);
        if (typeof notes !== 'object') return '';
        var keys = html ? ['notesHtml','NotesHtml'] : ['notesText','NotesText'];
        for (var i = 0; i < keys.length; i++) {
          if (notes[keys[i]] !== undefined) return String(notes[keys[i]] || '');
        }
        return '';
      }

      function decodeHtml_(value) {
        return String(value || '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;|&apos;/gi, "'")
          .replace(/&#x([0-9a-f]+);/gi, function (_, hex) { return String.fromCharCode(parseInt(hex, 16)); })
          .replace(/&#(\d+);/g, function (_, dec) { return String.fromCharCode(parseInt(dec, 10)); });
      }

      function cleanCell_(value) {
        return decodeHtml_(String(value || '').replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]+>/g, ' '))
          .replace(/[\u00a0\s]+/g, ' ').trim();
      }

      function key_(value) { return cleanCell_(value).toLowerCase(); }

      function tableRows_(html) {
        var rows = [], rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, rowMatch;
        while ((rowMatch = rowRe.exec(String(html || '')))) {
          var cells = [], cellRe = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi, cellMatch;
          while ((cellMatch = cellRe.exec(rowMatch[1]))) cells.push(cleanCell_(cellMatch[1]));
          if (cells.length >= 2 && cells[0]) rows.push({ label: cells[0], value: cells[1] });
        }
        return rows;
      }

      function semanticMatch_(expectedHtml, actualHtml, actualText) {
        var expectedRows = tableRows_(expectedHtml), actualRows = tableRows_(actualHtml);
        var expectedMap = {}, actualMap = {}, differences = [], i;
        for (i = 0; i < expectedRows.length; i++) expectedMap[key_(expectedRows[i].label)] = cleanCell_(expectedRows[i].value);
        for (i = 0; i < actualRows.length; i++) actualMap[key_(actualRows[i].label)] = cleanCell_(actualRows[i].value);
        Object.keys(expectedMap).forEach(function (k) {
          if (!Object.prototype.hasOwnProperty.call(actualMap, k)) differences.push('missing:' + k);
          else if (actualMap[k] !== expectedMap[k]) differences.push('value:' + k);
        });
        Object.keys(actualMap).forEach(function (k) {
          if (!Object.prototype.hasOwnProperty.call(expectedMap, k)) differences.push('unexpected:' + k);
        });
        var haystack = cleanCell_(actualText).toLowerCase(), textMissing = [];
        for (i = 0; i < expectedRows.length; i++) {
          var l = cleanCell_(expectedRows[i].label).toLowerCase();
          var v = cleanCell_(expectedRows[i].value).toLowerCase();
          if (l && haystack.indexOf(l) === -1) textMissing.push('label:' + expectedRows[i].label);
          if (v && haystack.indexOf(v) === -1) textMissing.push('value:' + expectedRows[i].value);
        }
        return {
          matches: differences.length === 0 && textMissing.length === 0,
          differences: differences,
          textMissing: textMissing
        };
      }

      function assertIdentity_(order) {
        var customerId = order.customer && order.customer.id !== undefined ? String(order.customer.id) : '';
        if (
          String(order.id || '') !== SALES_ORDER_ID ||
          String(order.orderNumber || '') !== ORDER_NUMBER ||
          customerId !== CUSTOMER_ID
        ) {
          throw new Error('Hard identity guard failed for Sales Order 26425.');
        }
      }

      var before = body_(CF.StrivenHttp.requestJson('/v1/sales-orders/' + SALES_ORDER_ID, { method: 'get' }));
      assertIdentity_(before);

      var preview = CF.OrderPreflight.previewRequest(REQUEST_ID);
      var replacement = preview && preview.payload ? preview.payload.InternalNotes : null;
      if (!replacement || typeof replacement !== 'object') {
        throw new Error('Replacement InternalNotes object is unavailable.');
      }

      var replacementHtml = notePart_(replacement, true);
      var replacementText = notePart_(replacement, false);
      if (
        !/<table\b/i.test(replacementHtml) ||
        replacementHtml.indexOf(REQUEST_ID) === -1 ||
        replacementText.indexOf('WEBFORM SERVICE REQUEST') !== 0
      ) {
        throw new Error('Replacement note failed the v5.10.17+ format guard.');
      }

      var beforeNotes = before.internalNotes || before.InternalNotes || null;
      var already = semanticMatch_(replacementHtml, notePart_(beforeNotes, true), notePart_(beforeNotes, false));
      if (already.matches) {
        return {
          ok: true,
          version: '5.10.19',
          status: 'NO_WRITE_REQUIRED_INTERNAL_NOTES_ALREADY_SEMANTICALLY_MATCH',
          requestId: REQUEST_ID,
          salesOrderId: SALES_ORDER_ID,
          orderNumber: ORDER_NUMBER,
          customerId: CUSTOMER_ID,
          liveWriteExecuted: false,
          semanticContentMatches: true
        };
      }

      var writePayload;
      if (payloadMode === 'WRAPPED_INTERNAL_NOTES') writePayload = { InternalNotes: replacement };
      else if (payloadMode === 'NOTES_OBJECT_ONLY') writePayload = replacement;
      else throw new Error('Unsupported payload mode: ' + payloadMode);

      var response = CF.StrivenHttp.requestJson(endpoint, {
        method: method.toLowerCase(),
        payload: writePayload,
        idempotent: false,
        attempts: 1
      });

      var after = body_(CF.StrivenHttp.requestJson('/v1/sales-orders/' + SALES_ORDER_ID, { method: 'get' }));
      assertIdentity_(after);
      var afterNotes = after.internalNotes || after.InternalNotes || null;
      var semantic = semanticMatch_(replacementHtml, notePart_(afterNotes, true), notePart_(afterNotes, false));

      return {
        ok: semantic.matches,
        version: '5.10.19',
        status: semantic.matches
          ? 'EXISTING_SALES_ORDER_INTERNAL_NOTES_REPLACED_AND_SEMANTICALLY_VERIFIED'
          : 'WRITE_RETURNED_BUT_INTERNAL_NOTES_SEMANTIC_VERIFICATION_FAILED',
        requestId: REQUEST_ID,
        salesOrderId: SALES_ORDER_ID,
        orderNumber: ORDER_NUMBER,
        customerId: CUSTOMER_ID,
        endpoint: endpoint,
        method: method,
        payloadMode: payloadMode,
        writeHttpStatus: response && response.status !== undefined ? response.status : '',
        internalNotesId: afterNotes && typeof afterNotes === 'object' ? String(afterNotes.id || '') : '',
        semanticContentMatches: semantic.matches,
        semanticDifferences: semantic.differences,
        textSemanticMissing: semantic.textMissing,
        liveWriteExecuted: true,
        requiresManualReview: !semantic.matches
      };
    }
  );
}

/* CF_SERVICEOPS_V5_10_18_EXISTING_INTERNAL_NOTES_GUARDED_R2 */

/* CF_SERVICEOPS_V5_10_19_SEMANTIC_INTERNAL_NOTES_VERIFICATION_R1 */


function DIAG_verifyProductionInternalNotesSemanticReconciliation() {
  return CF.PublicRunners.run(
    'Verify production Internal Notes semantic reconciliation',
    function () {
      var REQUEST_ID = 'SR-20260825111136-2461';
      var SALES_ORDER_ID = '26425';
      var ORDER_NUMBER = '584695';
      var CUSTOMER_ID = '57392';

      if (!CF.InternalNotesSemantic || typeof CF.InternalNotesSemantic.compare !== 'function') {
        throw new Error('CF.InternalNotesSemantic.compare is unavailable.');
      }
      if (!CF.OrderPreflight || typeof CF.OrderPreflight.previewRequest !== 'function') {
        throw new Error('CF.OrderPreflight.previewRequest is unavailable.');
      }
      if (!CF.StrivenHttp || typeof CF.StrivenHttp.requestJson !== 'function') {
        throw new Error('CF.StrivenHttp.requestJson is unavailable.');
      }

      function body_(response) {
        var value = response && response.json !== undefined ? response.json : response;
        if (value && typeof value === 'object' && value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
          return value.data;
        }
        return value || {};
      }

      var preview = CF.OrderPreflight.previewRequest(REQUEST_ID);
      var payload = preview && preview.payload ? preview.payload : {};
      var expectedNotes = payload.InternalNotes || null;
      if (!expectedNotes || typeof expectedNotes !== 'object') {
        throw new Error('Expected InternalNotes payload is unavailable for ' + REQUEST_ID + '.');
      }

      var current = body_(CF.StrivenHttp.requestJson('/v1/sales-orders/' + SALES_ORDER_ID, { method: 'get' }));
      var customerId = current.customer && current.customer.id !== undefined ? String(current.customer.id) : '';
      var identityConfirmed =
        String(current.id || '') === SALES_ORDER_ID &&
        String(current.orderNumber || '') === ORDER_NUMBER &&
        customerId === CUSTOMER_ID;

      if (!identityConfirmed) {
        throw new Error('Hard identity guard failed for Sales Order 26425.');
      }

      var actualNotes = current.internalNotes || current.InternalNotes || null;
      var semantic = CF.InternalNotesSemantic.compare(expectedNotes, actualNotes);

      var simulatedArguments = [payload, current];
      var argumentPathResult = CF.InternalNotesSemantic.confirmFromArguments(simulatedArguments);

      var result = {
        ok: identityConfirmed && semantic.matches && argumentPathResult === true,
        version: '5.10.20',
        mode: 'READ_ONLY_PRODUCTION_INTERNAL_NOTES_SEMANTIC_RECONCILIATION_VERIFICATION',
        requestId: REQUEST_ID,
        salesOrderId: SALES_ORDER_ID,
        orderNumber: ORDER_NUMBER,
        customerId: CUSTOMER_ID,
        identityConfirmed: identityConfirmed,
        semanticTableMatches: semantic.semanticTableMatches,
        semanticTextMatches: semantic.semanticTextMatches,
        semanticContentMatches: semantic.matches,
        productionArgumentPathMatches: argumentPathResult === true,
        productionBinding: CF.InternalNotesSemantic.productionBinding,
        expectedFieldCount: semantic.expectedFieldCount,
        currentFieldCount: semantic.actualFieldCount,
        semanticDifferences: semantic.differences,
        textSemanticMissing: semantic.textMissing,
        productionReconciliationReady:
          identityConfirmed &&
          semantic.matches &&
          argumentPathResult === true,
        strivenMutationExecuted: false,
        liveWriteExecuted: false,
        next:
          identityConfirmed && semantic.matches && argumentPathResult === true
            ? 'PASS — production semantic Internal Notes reconciliation is ready. Priority 1 can be declared DONE after deployment verification.'
            : 'FAIL — do not run a fresh Sales Order create until the reported semantic fields are corrected.'
      };

      console.log('Production Internal Notes Semantic Reconciliation: ' + JSON.stringify(result));
      return result;
    }
  );
}

/* CF_SERVICEOPS_V5_10_20_PRODUCTION_SEMANTIC_INTERNAL_NOTES_R3 */



/* CF_SERVICEOPS_V5_10_21_SELECTED_QUEUE_INTERNAL_NOTES_TEST_R1 — read-only selected Operator Queue Internal Notes semantic verifier. */
function TESTING_selectedQueueRequestIds_() {
  var ss = CF.Util.getSpreadsheet();
  var sheet = ss.getActiveSheet();
  if (!sheet || sheet.getName() !== '03 Operator Queue') {
    throw new Error('Open 03 Operator Queue and select the rows you want to test.');
  }

  var headers = CF.Util.getActualHeaders(sheet);
  var requestCol = headers.indexOf('Request ID') + 1;
  if (!requestCol) throw new Error('03 Operator Queue is missing the Request ID column.');

  var ranges = [];
  try {
    var rangeList = sheet.getActiveRangeList ? sheet.getActiveRangeList() : null;
    ranges = rangeList ? rangeList.getRanges() : [];
  } catch (ignoredRangeList) {}
  if (!ranges || !ranges.length) {
    var active = sheet.getActiveRange();
    if (active) ranges = [active];
  }
  if (!ranges.length) throw new Error('Select at least one Operator Queue row first.');

  var rowMap = {};
  for (var i = 0; i < ranges.length; i++) {
    var firstRow = Math.max(2, ranges[i].getRow());
    var lastRow = ranges[i].getRow() + ranges[i].getNumRows() - 1;
    for (var row = firstRow; row <= lastRow; row++) rowMap[row] = true;
  }

  var rows = Object.keys(rowMap).map(function (v) { return Number(v); }).sort(function (a, b) { return a - b; });
  if (!rows.length) throw new Error('Select one or more data rows below the header.');
  if (rows.length > 8) throw new Error('Select no more than 8 rows per Internal Notes test run.');

  var ids = [];
  for (var j = 0; j < rows.length; j++) {
    var id = CF.Util.cleanText(sheet.getRange(rows[j], requestCol).getValue());
    if (id && ids.indexOf(id) === -1) ids.push(id);
  }
  if (!ids.length) throw new Error('No Request IDs were found in the selected rows.');
  return ids;
}

function TESTING_verifyInternalNotesForRequest_(requestId) {
  if (!CF.InternalNotesSemantic || typeof CF.InternalNotesSemantic.compare !== 'function') {
    throw new Error('CF.InternalNotesSemantic.compare is unavailable.');
  }
  if (!CF.OrderPreflight || typeof CF.OrderPreflight.previewRequest !== 'function') {
    throw new Error('CF.OrderPreflight.previewRequest is unavailable.');
  }
  if (!CF.StrivenHttp || typeof CF.StrivenHttp.requestJson !== 'function') {
    throw new Error('CF.StrivenHttp.requestJson is unavailable.');
  }

  var record = CF.Util.findRecord('SERVICE_REQUESTS', 'Request ID', requestId);
  if (!record) {
    return { ok: false, requestId: requestId, status: 'SERVICE_REQUEST_NOT_FOUND', liveWriteExecuted: false };
  }

  var salesOrderId = CF.Util.cleanText(record['Work Order ID']);
  var expectedOrderNumber = CF.Util.cleanText(record['Work Order Number']);
  if (!salesOrderId) {
    return { ok: false, requestId: requestId, status: 'NO_SALES_ORDER_ID', liveWriteExecuted: false };
  }

  var preview;
  try {
    preview = CF.OrderPreflight.previewRequest(requestId);
  } catch (previewError) {
    return {
      ok: false,
      requestId: requestId,
      salesOrderId: salesOrderId,
      orderNumber: expectedOrderNumber,
      status: 'EXPECTED_INTERNAL_NOTES_PREVIEW_FAILED',
      error: String(previewError && previewError.message || previewError),
      liveWriteExecuted: false
    };
  }

  var payload = preview && preview.payload ? preview.payload : {};
  var expectedNotes = payload.InternalNotes || null;
  if (!expectedNotes || typeof expectedNotes !== 'object') {
    return {
      ok: false,
      requestId: requestId,
      salesOrderId: salesOrderId,
      orderNumber: expectedOrderNumber,
      status: 'EXPECTED_INTERNAL_NOTES_UNAVAILABLE',
      liveWriteExecuted: false
    };
  }

  function body_(response) {
    var value = response && response.json !== undefined ? response.json : response;
    if (value && typeof value === 'object' && value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
      return value.data;
    }
    return value || {};
  }

  var current;
  try {
    current = body_(CF.StrivenHttp.requestJson('/v1/sales-orders/' + encodeURIComponent(salesOrderId), { method: 'get' }));
  } catch (getError) {
    return {
      ok: false,
      requestId: requestId,
      salesOrderId: salesOrderId,
      orderNumber: expectedOrderNumber,
      status: 'STRIVEN_SALES_ORDER_GET_FAILED',
      error: String(getError && getError.message || getError),
      liveWriteExecuted: false
    };
  }

  var actualNotes = current.internalNotes || null;
  var actualOrderNumber = current.orderNumber !== undefined ? String(current.orderNumber) : '';
  var identityConfirmed = String(current.id || '') === String(salesOrderId) &&
    (!expectedOrderNumber || !actualOrderNumber || actualOrderNumber === expectedOrderNumber);

  var semantic = CF.InternalNotesSemantic.compare(expectedNotes, actualNotes);
  return {
    ok: identityConfirmed && semantic.matches === true,
    version: '5.10.21',
    mode: 'READ_ONLY_SELECTED_QUEUE_INTERNAL_NOTES_SEMANTIC_VERIFICATION',
    requestId: requestId,
    salesOrderId: String(salesOrderId),
    orderNumber: actualOrderNumber || expectedOrderNumber,
    identityConfirmed: identityConfirmed,
    semanticTableMatches: semantic.semanticTableMatches === true,
    semanticTextMatches: semantic.semanticTextMatches === true,
    semanticContentMatches: semantic.matches === true,
    expectedFieldCount: semantic.expectedFieldCount || 0,
    currentFieldCount: semantic.actualFieldCount || 0,
    semanticDifferences: semantic.differences || [],
    textSemanticMissing: semantic.textMissing || [],
    internalNotesId: actualNotes && actualNotes.id !== undefined ? String(actualNotes.id) : '',
    status: identityConfirmed && semantic.matches === true ? 'PASS' : 'FAIL',
    strivenMutationExecuted: false,
    liveWriteExecuted: false
  };
}

function TESTING_09_verifySelectedInternalNotes() {
  return CF.PublicRunners.run('TEST 9 - Verify Internal Notes for Selected Queue Rows', function () {
    var requestIds = TESTING_selectedQueueRequestIds_();
    var results = [];
    for (var i = 0; i < requestIds.length; i++) {
      results.push(TESTING_verifyInternalNotesForRequest_(requestIds[i]));
    }

    var passCount = results.filter(function (r) { return r.ok === true; }).length;
    var failCount = results.length - passCount;
    var lines = results.map(function (r) {
      var details = r.ok === true
        ? 'PASS · ' + r.expectedFieldCount + '/' + r.currentFieldCount + ' fields'
        : 'FAIL · ' + (r.status || 'CHECK LOGS');
      if (r.semanticDifferences && r.semanticDifferences.length) details += ' · ' + r.semanticDifferences.join(', ');
      if (r.textSemanticMissing && r.textSemanticMissing.length) details += ' · text: ' + r.textSemanticMissing.join(', ');
      return details + '\n' + r.requestId + (r.orderNumber ? ' · SO ' + r.orderNumber : '');
    });

    var summary = passCount + ' PASS · ' + failCount + ' FAIL · ' + results.length + ' tested';
    try { SpreadsheetApp.getActive().toast(summary, 'Internal Notes Verification', 8); } catch (ignoredToast) {}
    try { SpreadsheetApp.getUi().alert('Internal Notes Verification', summary + '\n\n' + lines.join('\n\n'), SpreadsheetApp.getUi().ButtonSet.OK); } catch (ignoredUi) {}

    var output = {
      ok: failCount === 0,
      version: '5.10.21',
      mode: 'READ_ONLY_SELECTED_QUEUE_INTERNAL_NOTES_SEMANTIC_VERIFICATION_BATCH',
      selectedCount: requestIds.length,
      passCount: passCount,
      failCount: failCount,
      results: results,
      strivenMutationExecuted: false,
      liveWriteExecuted: false
    };
    console.log('Selected Queue Internal Notes Verification: ' + JSON.stringify(output));
    return output;
  });
}



/* CF_SERVICEOPS_V5_10_22_SELECTED_QUEUE_INTERNAL_NOTES_WRITE_R1
 * Guarded selected-row retrofit for EXISTING Striven Sales Orders.
 * Verified browser save contract supplied from Striven UI:
 *   POST https://classicfireplace.striven.com/api/sales-orders/{id}
 * with the full existing Sales Order object and internalNotes:{id,content}.
 *
 * Safety invariants:
 * - NEVER calls POST /v1/sales-orders (the create endpoint).
 * - GETs and identity-checks the durable Sales Order before write.
 * - Reuses the full existing web Sales Order object and changes ONLY internalNotes.content.
 * - Preserves internalNotes.id.
 * - One POST attempt only; uncertain outcomes are reconciled by GET, never retried.
 * - GET-after-write + semantic verification is mandatory.
 * - Rows already semantically correct are skipped without mutation.
 */
function TESTING_10_expectedInternalNotes_(requestId) {
  if (!CF.OrderPreflight || typeof CF.OrderPreflight.previewRequest !== 'function') {
    throw new Error('CF.OrderPreflight.previewRequest is unavailable.');
  }
  var preview = CF.OrderPreflight.previewRequest(requestId);
  var payload = preview && preview.payload ? preview.payload : {};
  var notes = payload.InternalNotes || null;
  if (!notes || typeof notes !== 'object') throw new Error('Expected InternalNotes payload is unavailable for ' + requestId + '.');
  var html = String(notes.NotesHtml || notes.notesHtml || '').trim();
  var text = String(notes.NotesText || notes.notesText || '').trim();
  if (!html || html.indexOf('<table') < 0 || html.indexOf('WEBFORM SERVICE REQUEST') < 0) {
    throw new Error('Expected Internal Notes HTML table is unavailable for ' + requestId + '.');
  }
  return { object: notes, html: html, text: text };
}

function TESTING_10_body_(response) {
  var value = response && response.json !== undefined ? response.json : response;
  if (value && typeof value === 'object' && value.data && typeof value.data === 'object' && !Array.isArray(value.data)) return value.data;
  return value || {};
}

function TESTING_10_customerId_(record) {
  return CF.Util.cleanText(record['Matched Customer ID'] || record['Created Customer ID']);
}

function TESTING_10_publicGet_(salesOrderId) {
  return TESTING_10_body_(CF.StrivenHttp.requestJson('/v1/sales-orders/' + encodeURIComponent(salesOrderId), { method: 'get' }));
}

function TESTING_10_webUrl_(salesOrderId) {
  return 'https://classicfireplace.striven.com/api/sales-orders/' + encodeURIComponent(salesOrderId);
}

function TESTING_10_identity_(order, salesOrderId, orderNumber, customerId) {
  var actualId = CF.Util.cleanText(order && order.id);
  var actualNumber = CF.Util.cleanText(order && order.orderNumber);
  var actualCustomer = CF.Util.cleanText(order && order.customer && (order.customer.accountID !== undefined ? order.customer.accountID : order.customer.id));
  return {
    id: actualId,
    orderNumber: actualNumber,
    customerId: actualCustomer,
    idConfirmed: actualId === String(salesOrderId),
    orderNumberConfirmed: !orderNumber || !actualNumber || actualNumber === String(orderNumber),
    customerConfirmed: !customerId || !actualCustomer || actualCustomer === String(customerId)
  };
}

function TESTING_10_replaceInternalNotesForRequest_(requestId) {
  if (!CF.InternalNotesSemantic || typeof CF.InternalNotesSemantic.compare !== 'function') {
    throw new Error('CF.InternalNotesSemantic.compare is unavailable.');
  }
  if (!CF.StrivenHttp || typeof CF.StrivenHttp.requestJson !== 'function') {
    throw new Error('CF.StrivenHttp.requestJson is unavailable.');
  }

  var record = CF.Util.findRecord('SERVICE_REQUESTS', 'Request ID', requestId);
  if (!record) return { ok:false, requestId:requestId, status:'SERVICE_REQUEST_NOT_FOUND', strivenMutationExecuted:false, liveWriteExecuted:false };

  var salesOrderId = CF.Util.cleanText(record['Work Order ID']);
  var orderNumber = CF.Util.cleanText(record['Work Order Number']);
  var customerId = TESTING_10_customerId_(record);
  if (!salesOrderId) return { ok:false, requestId:requestId, status:'NO_SALES_ORDER_ID', strivenMutationExecuted:false, liveWriteExecuted:false };

  var expected;
  try {
    expected = TESTING_10_expectedInternalNotes_(requestId);
  } catch (eExpected) {
    return { ok:false, requestId:requestId, salesOrderId:salesOrderId, orderNumber:orderNumber, status:'EXPECTED_INTERNAL_NOTES_UNAVAILABLE', error:String(eExpected && eExpected.message || eExpected), strivenMutationExecuted:false, liveWriteExecuted:false };
  }

  // Public API GET: durable identity + skip rows that already pass.
  var beforePublic;
  try {
    beforePublic = TESTING_10_publicGet_(salesOrderId);
  } catch (eBeforePublic) {
    return { ok:false, requestId:requestId, salesOrderId:salesOrderId, orderNumber:orderNumber, status:'PREWRITE_PUBLIC_GET_FAILED', error:String(eBeforePublic && eBeforePublic.message || eBeforePublic), strivenMutationExecuted:false, liveWriteExecuted:false };
  }
  var beforeIdentity = TESTING_10_identity_(beforePublic, salesOrderId, orderNumber, customerId);
  if (!beforeIdentity.idConfirmed || !beforeIdentity.orderNumberConfirmed || !beforeIdentity.customerConfirmed) {
    return { ok:false, requestId:requestId, salesOrderId:salesOrderId, orderNumber:orderNumber, status:'PREWRITE_IDENTITY_MISMATCH', identity:beforeIdentity, strivenMutationExecuted:false, liveWriteExecuted:false };
  }

  var beforeSemantic = CF.InternalNotesSemantic.compare(expected.object, beforePublic.internalNotes || null);
  if (beforeSemantic.matches === true) {
    return {
      ok:true, requestId:requestId, salesOrderId:String(salesOrderId), orderNumber:beforeIdentity.orderNumber || orderNumber,
      status:'SKIPPED_ALREADY_PASS', identityConfirmed:true,
      semanticContentMatches:true, expectedFieldCount:beforeSemantic.expectedFieldCount || 0, currentFieldCount:beforeSemantic.actualFieldCount || 0,
      semanticDifferences:[], textSemanticMissing:[], strivenMutationExecuted:false, liveWriteExecuted:false
    };
  }

  // Exact Striven UI web save contract: GET the full object first.
  var webUrl = TESTING_10_webUrl_(salesOrderId);
  var webOrder;
  try {
    webOrder = TESTING_10_body_(CF.StrivenHttp.requestJson(webUrl, { method:'get' }));
  } catch (eWebGet) {
    return {
      ok:false, requestId:requestId, salesOrderId:String(salesOrderId), orderNumber:orderNumber,
      status:'WEB_SAVE_ENDPOINT_GET_FAILED_NO_WRITE',
      error:String(eWebGet && eWebGet.message || eWebGet),
      note:'Apps Script could not authenticate/read the Striven web save endpoint. No POST was attempted.',
      strivenMutationExecuted:false, liveWriteExecuted:false
    };
  }

  var webIdentity = TESTING_10_identity_(webOrder, salesOrderId, orderNumber, customerId);
  if (!webIdentity.idConfirmed || !webIdentity.orderNumberConfirmed || !webIdentity.customerConfirmed) {
    return { ok:false, requestId:requestId, salesOrderId:String(salesOrderId), orderNumber:orderNumber, status:'WEB_SAVE_ENDPOINT_IDENTITY_MISMATCH_NO_WRITE', identity:webIdentity, strivenMutationExecuted:false, liveWriteExecuted:false };
  }

  if (!webOrder || typeof webOrder !== 'object' || Array.isArray(webOrder)) {
    return { ok:false, requestId:requestId, salesOrderId:String(salesOrderId), orderNumber:orderNumber, status:'WEB_SAVE_OBJECT_INVALID_NO_WRITE', strivenMutationExecuted:false, liveWriteExecuted:false };
  }

  var updatePayload = CF.Util.clone(webOrder);
  var priorInternal = updatePayload.internalNotes && typeof updatePayload.internalNotes === 'object' ? updatePayload.internalNotes : { id:0, content:'' };
  updatePayload.internalNotes = CF.Util.clone(priorInternal);
  if (updatePayload.internalNotes.id === undefined || updatePayload.internalNotes.id === null) updatePayload.internalNotes.id = 0;
  updatePayload.internalNotes.content = expected.html;

  // Guard that our own code changed only internalNotes.content.
  var guardBefore = CF.Util.clone(webOrder);
  var guardAfter = CF.Util.clone(updatePayload);
  if (!guardBefore.internalNotes || typeof guardBefore.internalNotes !== 'object') guardBefore.internalNotes = { id:guardAfter.internalNotes.id, content:'' };
  if (!guardAfter.internalNotes || typeof guardAfter.internalNotes !== 'object') guardAfter.internalNotes = { id:guardBefore.internalNotes.id, content:'' };
  guardBefore.internalNotes.content = '__CF_INTERNAL_NOTES_CONTENT__';
  guardAfter.internalNotes.content = '__CF_INTERNAL_NOTES_CONTENT__';
  if (JSON.stringify(guardBefore) !== JSON.stringify(guardAfter)) {
    return { ok:false, requestId:requestId, salesOrderId:String(salesOrderId), orderNumber:orderNumber, status:'PAYLOAD_MUTATION_GUARD_FAILED_NO_WRITE', strivenMutationExecuted:false, liveWriteExecuted:false };
  }

  var postError = '';
  var postResponse = null;
  try {
    postResponse = CF.StrivenHttp.requestJson(webUrl, { method:'post', payload:updatePayload, attempts:1, idempotent:false });
  } catch (ePost) {
    // Do not retry. Reconcile the possibly-successful POST with a fresh public GET.
    postError = String(ePost && ePost.message || ePost);
  }

  var afterPublic;
  try {
    afterPublic = TESTING_10_publicGet_(salesOrderId);
  } catch (eAfterGet) {
    return {
      ok:false, requestId:requestId, salesOrderId:String(salesOrderId), orderNumber:orderNumber,
      status:postError ? 'POST_OUTCOME_UNCERTAIN_GET_FAILED_DO_NOT_RETRY' : 'POST_ACCEPTED_GET_FAILED_DO_NOT_RETRY',
      error:postError || String(eAfterGet && eAfterGet.message || eAfterGet),
      strivenMutationExecuted:true, liveWriteExecuted:true, automaticRetry:false
    };
  }

  var afterIdentity = TESTING_10_identity_(afterPublic, salesOrderId, orderNumber, customerId);
  var semantic = CF.InternalNotesSemantic.compare(expected.object, afterPublic.internalNotes || null);
  var verified = afterIdentity.idConfirmed && afterIdentity.orderNumberConfirmed && afterIdentity.customerConfirmed && semantic.matches === true;

  return {
    ok:verified,
    version:'5.10.22',
    mode:'GUARDED_EXISTING_SALES_ORDER_INTERNAL_NOTES_REPLACEMENT',
    requestId:requestId,
    salesOrderId:String(salesOrderId),
    orderNumber:afterIdentity.orderNumber || orderNumber,
    customerId:afterIdentity.customerId || customerId,
    status:verified ? (postError ? 'PASS_POST_OUTCOME_RECONCILED' : 'PASS_INTERNAL_NOTES_REPLACED') : (postError ? 'FAIL_POST_OUTCOME_NOT_VERIFIED_DO_NOT_RETRY' : 'FAIL_POST_WRITE_SEMANTIC_VERIFICATION'),
    identityConfirmed:afterIdentity.idConfirmed && afterIdentity.orderNumberConfirmed && afterIdentity.customerConfirmed,
    semanticTableMatches:semantic.semanticTableMatches === true,
    semanticTextMatches:semantic.semanticTextMatches === true,
    semanticContentMatches:semantic.matches === true,
    expectedFieldCount:semantic.expectedFieldCount || 0,
    currentFieldCount:semantic.actualFieldCount || 0,
    semanticDifferences:semantic.differences || [],
    textSemanticMissing:semantic.textMissing || [],
    internalNotesId:afterPublic.internalNotes && afterPublic.internalNotes.id !== undefined ? String(afterPublic.internalNotes.id) : '',
    webSaveEndpoint:webUrl,
    postError:postError,
    postResponseReceived:postResponse !== null,
    onlyInternalNotesContentChangedByClient:true,
    salesOrderCreateEndpointCalled:false,
    automaticRetry:false,
    strivenMutationExecuted:true,
    liveWriteExecuted:true
  };
}

function TESTING_10_replaceSelectedInternalNotes() {
  return CF.PublicRunners.run('TEST 10 - WRITE Existing Sales Order Internal Notes for Selected Queue Rows', function () {
    var requestIds = TESTING_selectedQueueRequestIds_();
    var ui = SpreadsheetApp.getUi();
    var answer = ui.alert(
      'Replace Internal Notes?',
      'This will update Internal Notes on ' + requestIds.length + ' EXISTING Striven Sales Order(s).\n\n' +
      'Only Internal Notes content will be replaced with the WEBFORM SERVICE REQUEST HTML table.\n' +
      'No new Sales Order will be created.\n\nContinue?',
      ui.ButtonSet.YES_NO
    );
    if (answer !== ui.Button.YES) {
      return { ok:false, version:'5.10.22', status:'CANCELLED_BY_OPERATOR', selectedCount:requestIds.length, strivenMutationExecuted:false, liveWriteExecuted:false };
    }

    var results = [];
    for (var i = 0; i < requestIds.length; i++) {
      var result = TESTING_10_replaceInternalNotesForRequest_(requestIds[i]);
      results.push(result);
      // If a POST crossed the boundary and cannot be verified, stop the batch. Never retry or continue blindly.
      if (result && result.liveWriteExecuted === true && result.ok !== true) break;
      // If Apps Script cannot authenticate the web save endpoint, subsequent rows will fail identically; stop cleanly.
      if (result && result.status === 'WEB_SAVE_ENDPOINT_GET_FAILED_NO_WRITE') break;
    }

    var passCount = results.filter(function (r) { return r.ok === true; }).length;
    var writeCount = results.filter(function (r) { return r.liveWriteExecuted === true; }).length;
    var skippedCount = results.filter(function (r) { return r.status === 'SKIPPED_ALREADY_PASS'; }).length;
    var failCount = results.length - passCount;
    var lines = results.map(function (r) {
      var line = (r.ok ? 'PASS' : 'FAIL') + ' · ' + (r.status || 'CHECK LOGS');
      if (r.expectedFieldCount !== undefined || r.currentFieldCount !== undefined) line += ' · ' + (r.expectedFieldCount || 0) + '/' + (r.currentFieldCount || 0) + ' fields';
      if (r.semanticDifferences && r.semanticDifferences.length) line += ' · ' + r.semanticDifferences.join(', ');
      return line + '\n' + r.requestId + (r.orderNumber ? ' · SO ' + r.orderNumber : '');
    });
    var summary = passCount + ' PASS · ' + failCount + ' FAIL · ' + writeCount + ' written · ' + skippedCount + ' already correct';
    try { SpreadsheetApp.getActive().toast(summary, 'Internal Notes Write', 10); } catch (ignoredToast) {}
    try { ui.alert('Internal Notes Write', summary + '\n\n' + lines.join('\n\n'), ui.ButtonSet.OK); } catch (ignoredUi) {}

    var output = {
      ok:failCount === 0,
      version:'5.10.22',
      mode:'GUARDED_SELECTED_QUEUE_EXISTING_SALES_ORDER_INTERNAL_NOTES_REPLACEMENT_BATCH',
      selectedCount:requestIds.length,
      processedCount:results.length,
      passCount:passCount,
      failCount:failCount,
      writeCount:writeCount,
      skippedAlreadyCorrect:skippedCount,
      results:results,
      salesOrderCreateEndpointCalled:false
    };
    console.log('Selected Queue Internal Notes Write: ' + JSON.stringify(output));
    return output;
  });
}



/* CF_SERVICEOPS_V5_10_23_PREPARE_INTERNAL_NOTES_MENU_R1
 * Manual retrofit helper for historical Sales Orders.
 * READ ONLY with respect to Striven and workbook data.
 * Generates the canonical v5.10.20+ WEBFORM SERVICE REQUEST HTML table,
 * lets the operator copy it as rich HTML, and opens the existing Sales Order.
 */
function TESTING_10_b64_(value) {
  return Utilities.base64Encode(String(value || ''), Utilities.Charset.UTF_8);
}

function TESTING_10_prepareSelectedInternalNotes() {
  return CF.PublicRunners.run('TEST 10 - Prepare Internal Notes for Selected Queue Rows', function () {
    var requestIds = TESTING_selectedQueueRequestIds_();
    var items = [];

    for (var i = 0; i < requestIds.length; i++) {
      var requestId = requestIds[i];
      var record = CF.Util.findRecord('SERVICE_REQUESTS', 'Request ID', requestId);
      if (!record) {
        items.push({ ok:false, requestId:requestId, error:'Service Request not found.' });
        continue;
      }

      var salesOrderId = CF.Util.cleanText(record['Work Order ID']);
      var orderNumber = CF.Util.cleanText(record['Work Order Number']);
      if (!salesOrderId) {
        items.push({ ok:false, requestId:requestId, orderNumber:orderNumber, error:'No existing Sales Order ID is recorded.' });
        continue;
      }

      try {
        var expected = TESTING_10_expectedInternalNotes_(requestId);
        items.push({
          ok:true,
          requestId:requestId,
          salesOrderId:String(salesOrderId),
          orderNumber:orderNumber,
          salesOrderUrl:'https://classicfireplace.striven.com/next/crm#/sales-orders/' + encodeURIComponent(salesOrderId),
          htmlB64:TESTING_10_b64_(expected.html),
          textB64:TESTING_10_b64_(expected.text || '')
        });
      } catch (e) {
        items.push({ ok:false, requestId:requestId, salesOrderId:String(salesOrderId), orderNumber:orderNumber, error:String(e && e.message || e) });
      }
    }

    var good = items.filter(function (x) { return x.ok === true; }).length;
    if (!good) throw new Error('No selected rows have prepared Internal Notes available. Check the execution log.');

    var safeJson = JSON.stringify(items).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    var page = [
      '<div id="cfPrep" style="font-family:Arial,Helvetica,sans-serif;color:#222;padding:16px;box-sizing:border-box">',
      '<div style="font-size:16px;font-weight:700;margin-bottom:4px">Prepared Internal Notes</div>',
      '<div style="font-size:12px;color:#666;margin-bottom:14px">Click <b>Copy + Open</b>, paste into Striven Internal Notes, then Save. This tool does not write to Striven.</div>',
      '<div id="cards"></div>',
      '<div id="status" style="position:sticky;bottom:0;background:#fff;border-top:1px solid #ddd;padding:8px 0 0;margin-top:12px;font-size:12px;color:#555"></div>',
      '<script>',
      'const items=', safeJson, ';',
      'const root=document.getElementById("cards"),status=document.getElementById("status");',
      'function dec(b64){const bytes=Uint8Array.from(atob(b64||""),c=>c.charCodeAt(0));return new TextDecoder("utf-8").decode(bytes);}',
      'function esc(s){return String(s||"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;"}[c]));}',
      'function copyRich(html,text){',
      ' const box=document.createElement("div");box.contentEditable="true";box.style.position="fixed";box.style.left="-99999px";box.style.top="0";box.innerHTML=html;document.body.appendChild(box);',
      ' const range=document.createRange();range.selectNodeContents(box);const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);',
      ' let ok=false;try{ok=document.execCommand("copy");}catch(e){}sel.removeAllRanges();box.remove();',
      ' if(ok)return Promise.resolve(true);',
      ' if(navigator.clipboard&&window.ClipboardItem){const data={"text/html":new Blob([html],{type:"text/html"}),"text/plain":new Blob([text||""],{type:"text/plain"})};return navigator.clipboard.write([new ClipboardItem(data)]).then(()=>true);}',
      ' return Promise.reject(new Error("Clipboard access was blocked."));',
      '}',
      'items.forEach((it,idx)=>{',
      ' const card=document.createElement("div");card.style.cssText="border:1px solid #d9d9d9;border-radius:8px;padding:12px;margin:0 0 12px;background:#fff";',
      " if(!it.ok){card.innerHTML='<div style=\"font-weight:700;color:#a61b1b\">'+esc(it.requestId)+' — unavailable</div><div style=\"font-size:12px;color:#666;margin-top:4px\">'+esc(it.error)+'</div>';root.appendChild(card);return;}",
      ' const html=dec(it.htmlB64), text=dec(it.textB64);',
      ' const head=document.createElement("div");head.style.cssText="display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:10px";',
      " head.innerHTML='<div><div style=\"font-weight:700\">'+esc(it.requestId)+'</div><div style=\"font-size:12px;color:#666\">SO '+esc(it.orderNumber||it.salesOrderId)+'</div></div><div class=\"actions\" style=\"display:flex;gap:6px;flex-wrap:wrap\"></div>';",
      ' card.appendChild(head);const actions=head.querySelector(".actions");',
      ' const copy=document.createElement("button");copy.type="button";copy.textContent="Copy Table";copy.style.cssText="padding:7px 10px;border:1px solid #999;border-radius:6px;background:#fff;cursor:pointer";',
      ' copy.addEventListener("click",()=>copyRich(html,text).then(()=>status.textContent="Copied Internal Notes for "+it.requestId).catch(e=>status.textContent=e.message));actions.appendChild(copy);',
      ' const open=document.createElement("a");open.href=it.salesOrderUrl;open.target="_blank";open.rel="noopener";open.textContent="Open Sales Order";open.style.cssText="padding:7px 10px;border:1px solid #999;border-radius:6px;background:#fff;color:#222;text-decoration:none";actions.appendChild(open);',
      ' const both=document.createElement("button");both.type="button";both.textContent="Copy + Open";both.style.cssText="padding:7px 10px;border:1px solid #2f5597;border-radius:6px;background:#2f5597;color:#fff;cursor:pointer;font-weight:700";',
      ' both.addEventListener("click",()=>{const w=window.open(it.salesOrderUrl,"_blank");copyRich(html,text).then(()=>status.textContent="Copied + opened SO "+(it.orderNumber||it.salesOrderId)).catch(e=>status.textContent=e.message+(w?" Sales Order opened.":""));});actions.appendChild(both);',
      ' const preview=document.createElement("details");preview.innerHTML="<summary style=\\"cursor:pointer;font-size:12px;color:#555;margin-bottom:8px\\">Preview table</summary>";const p=document.createElement("div");p.innerHTML=html;p.style.cssText="border-top:1px solid #eee;padding-top:8px;max-height:260px;overflow:auto";preview.appendChild(p);card.appendChild(preview);root.appendChild(card);',
      '});',
      '</script></div>'
    ].join('');

    var output = HtmlService.createHtmlOutput(page).setWidth(820).setHeight(650);
    SpreadsheetApp.getUi().showModalDialog(output, 'Prepare Internal Notes');

    var result = {
      ok:true,
      version:'5.10.23',
      mode:'READ_ONLY_PREPARE_SELECTED_QUEUE_INTERNAL_NOTES',
      selectedCount:requestIds.length,
      preparedCount:good,
      unavailableCount:items.length-good,
      strivenMutationExecuted:false,
      liveWriteExecuted:false
    };
    console.log('Prepare Selected Queue Internal Notes: ' + JSON.stringify(result));
    return result;
  });
}



/* CF_SERVICEOPS_V5_10_24_OFFICIAL_API_INTERNAL_NOTES_TEST_R1
 * Guarded proof of the official Striven Sales Order API update contract.
 * Hard-guarded to the known Pramodh Test2 request / SO 584678.
 * Uses OAuth Bearer auth through CF.StrivenHttp only.
 */
function TESTING_10_apiOrderObject_(value) {
  value = value || {};
  return value.Data || value.data || value.Result || value.result || value;
}

function TESTING_10_orderId_(order) {
  order = order || {};
  return String(order.Id !== undefined ? order.Id : (order.id !== undefined ? order.id : '')).trim();
}

function TESTING_10_orderNumber_(order) {
  order = order || {};
  return String(order.OrderNumber !== undefined ? order.OrderNumber : (order.orderNumber !== undefined ? order.orderNumber : '')).trim();
}

function TESTING_10_customerId_(order) {
  order = order || {};
  var customer = order.Customer || order.customer || {};
  return String(customer.Id !== undefined ? customer.Id : (customer.id !== undefined ? customer.id : (customer.accountID !== undefined ? customer.accountID : ''))).trim();
}

function TESTING_10_internalNotes_(order) {
  order = order || {};
  return order.InternalNotes || order.internalNotes || null;
}

function TESTING_10_semanticMatch_(expected, actual) {
  if (!CF.InternalNotesSemantic || typeof CF.InternalNotesSemantic.compare !== 'function') {
    throw new Error('CF.InternalNotesSemantic.compare is unavailable.');
  }
  var result = CF.InternalNotesSemantic.compare(expected, actual);
  return { ok: !!(result && result.matches), result: result || {} };
}

function TESTING_10_cloneJson_(value) {
  return JSON.parse(JSON.stringify(value));
}

function TESTING_10_internalNotesPayload_(current, html, text, lowerCase) {
  current = current || {};
  var id = Number(current.Id !== undefined ? current.Id : (current.id || 0)) || 0;
  if (lowerCase) {
    return { id:id, notesHtml:String(html || ''), notesText:String(text || '') };
  }
  return { Id:id, NotesHtml:String(html || ''), NotesText:String(text || '') };
}

function TESTING_10_setInternalNotesOnly_(payload, before, notes) {
  if (Object.prototype.hasOwnProperty.call(before || {}, 'internalNotes')) {
    payload.internalNotes = notes;
    if (Object.prototype.hasOwnProperty.call(payload, 'InternalNotes')) delete payload.InternalNotes;
  } else {
    payload.InternalNotes = notes;
    if (Object.prototype.hasOwnProperty.call(payload, 'internalNotes')) delete payload.internalNotes;
  }
  return payload;
}

function TESTING_10_withoutInternalNotes_(value) {
  var copy = TESTING_10_cloneJson_(value || {});
  delete copy.InternalNotes;
  delete copy.internalNotes;
  return copy;
}

function TESTING_10_updateInternalNotesViaOfficialApiTest() {
  /* CF_SERVICEOPS_V5_10_28_SELECTED_ROWS_NO_POPUPS_R1 */
  return CF.PublicRunners.run('TEST 10 - Update Internal Notes for Selected Queue Rows via Official API', function () {
    if (!CF.SalesOrderInternalNotesApi || typeof CF.SalesOrderInternalNotesApi.reconcile !== 'function') throw new Error('CF.SalesOrderInternalNotesApi.reconcile is unavailable.');
    var requestIds=TESTING_selectedQueueRequestIds_();
    var results=[];
    for (var i=0;i<requestIds.length;i++) {
      var requestId=String(requestIds[i]||'').trim();
      var record=CF.Util.findRecord('SERVICE_REQUESTS','Request ID',requestId);
      var result;
      if (!record) {
        result={ok:false,status:'SERVICE_REQUEST_NOT_FOUND',requestId:requestId,writeAttempted:false,liveWriteExecuted:false};
      } else {
        var salesOrderId=String(record['Work Order ID']||'').trim();
        var orderNumber=String(record['Work Order Number']||'').trim();
        var customerId=String(record['Created Customer ID']||record['Matched Customer ID']||'').trim();
        try {
          var expected=TESTING_10_expectedInternalNotes_(requestId);
          result=CF.SalesOrderInternalNotesApi.reconcile({requestId:requestId,salesOrderId:salesOrderId,orderNumber:orderNumber,customerId:customerId,expectedInternalNotes:expected.object});
        } catch (e) {
          result={ok:false,status:'PREPARATION_FAILED',requestId:requestId,salesOrderId:salesOrderId,orderNumber:orderNumber,error:String(e&&e.message||e),writeAttempted:false,liveWriteExecuted:false};
        }
      }
      results.push(result);
      // Any unverified POST attempt stops the batch. Never continue blind.
      if (result && result.writeAttempted===true && result.ok!==true) break;
    }

    var updated=results.filter(function(r){return r&&r.ok===true&&r.written===1;}).length;
    var already=results.filter(function(r){return r&&r.ok===true&&r.status==='ALREADY_CORRECT';}).length;
    var failed=results.filter(function(r){return !r||r.ok!==true;}).length;
    var summary=updated+' UPDATED · '+already+' ALREADY CORRECT · '+failed+' FAILED';
    try { SpreadsheetApp.getActive().toast(summary,'Internal Notes',10); } catch (ignoredToast) {}
    var anyWriteAttempted=results.some(function(r){return r&&r.writeAttempted===true;});
    var anyLiveWrite=results.some(function(r){return r&&r.liveWriteExecuted===true;});
    var output={ok:failed===0,version:'5.10.28',mode:'OFFICIAL_API_SELECTED_QUEUE_INTERNAL_NOTES_RECONCILIATION',selectedCount:requestIds.length,processedCount:results.length,updated:updated,alreadyCorrect:already,failed:failed,results:results,officialApi:true,apiGetEndpoint:'/v1/sales-orders/{id}',apiPostEndpoint:'/v1/sales-orders',customFieldsPolicy:'SEND_REQUIRED_NON_ATTACHMENT_WRITE_DTO_VERIFY_ALL_UNCHANGED_AFTER_GET',operatorConfirmationRequired:false,blockingResultDialog:false,writeAttempted:anyWriteAttempted,automaticPostRetry:false,liveWriteExecuted:anyLiveWrite};
    console.log('Selected Queue Internal Notes Official API Reconciliation: '+JSON.stringify(output));
    return output;
  });
}



/* CF_SERVICEOPS_V5_10_25_OFFICIAL_API_INTERNAL_NOTES_TEST_R2
 * Corrected official API update proof after Striven returned:
 *   HTTP 400 Cannot update Custom Field Id 96 (Photo Of Fireplace/Part)
 *   because attachment types are not currently supported.
 *
 * This revision omits unsupported attachment CustomFields from the POST model,
 * but captures and verifies them before/after so they are not silently changed.
 */
function TESTING_10_cfId_(field) {
  field = field || {};
  return String(field.Id !== undefined ? field.Id : (field.id !== undefined ? field.id : '')).trim();
}

function TESTING_10_cfName_(field) {
  field = field || {};
  return String(field.Name !== undefined ? field.Name : (field.name !== undefined ? field.name : '')).trim();
}

function TESTING_10_cfTypeName_(field) {
  field = field || {};
  var type = field.FieldType || field.fieldType || {};
  return String(type.Name !== undefined ? type.Name : (type.name !== undefined ? type.name : '')).trim();
}

function TESTING_10_customFieldsKey_(order) {
  order = order || {};
  if (Object.prototype.hasOwnProperty.call(order, 'CustomFields')) return 'CustomFields';
  if (Object.prototype.hasOwnProperty.call(order, 'customFields')) return 'customFields';
  return '';
}

function TESTING_10_isUnsupportedAttachmentField_(field) {
  var id = TESTING_10_cfId_(field);
  var name = TESTING_10_cfName_(field);
  var type = TESTING_10_cfTypeName_(field);
  if (id === '96') return true;
  return /attachment|photo|image|file/i.test(type) || /attachment|photo of fireplace\/part/i.test(name);
}

function TESTING_10_collectUnsupportedAttachmentFields_(order) {
  var key = TESTING_10_customFieldsKey_(order);
  var fields = key && Array.isArray(order[key]) ? order[key] : [];
  return fields.filter(TESTING_10_isUnsupportedAttachmentField_).map(function (field) {
    return {
      id:TESTING_10_cfId_(field),
      name:TESTING_10_cfName_(field),
      type:TESTING_10_cfTypeName_(field),
      value:field.Value !== undefined ? field.Value : field.value,
      valueText:field.ValueText !== undefined ? field.ValueText : field.valueText
    };
  });
}

function TESTING_10_removeUnsupportedAttachmentFields_(order) {
  var key = TESTING_10_customFieldsKey_(order);
  if (!key || !Array.isArray(order[key])) return [];
  var removed = [];
  order[key] = order[key].filter(function (field) {
    if (!TESTING_10_isUnsupportedAttachmentField_(field)) return true;
    removed.push({
      id:TESTING_10_cfId_(field),
      name:TESTING_10_cfName_(field),
      type:TESTING_10_cfTypeName_(field)
    });
    return false;
  });
  return removed;
}

function TESTING_10_unsupportedSnapshotEqual_(beforeList, afterList) {
  function normalized_(list) {
    return (list || []).map(function (item) {
      return {
        id:String(item.id || ''),
        name:String(item.name || ''),
        type:String(item.type || ''),
        value:item.value === undefined ? null : item.value,
        valueText:item.valueText === undefined ? null : item.valueText
      };
    }).sort(function (a,b) { return a.id.localeCompare(b.id); });
  }
  return JSON.stringify(normalized_(beforeList)) === JSON.stringify(normalized_(afterList));
}


/* CF_SERVICEOPS_V5_12_6_WORKFLOW_STABILITY_REPROCESS_RUNNER_R1 */
function FIX_20260905_applyWorkflowStabilityAndResumeRecentIncomplete() {
  return CF.PublicRunners.run('FIX 20260905 - Workflow stability + resume recent incomplete', function () {
    var VERSION = '5.12.6';
    var targets = [
      {
        requestId: 'SR-20260905061831-2571',
        label: 'Derek Cooper',
        mode: 'RESUME_DURABLE_STAGE',
        expectedCustomerId: '62417',
        expectedContactId: '56312',
        expectedLocationId: '58072'
      },
      {
        requestId: 'SR-20260904144057-8217',
        label: 'Lynne Stephens',
        mode: 'RECHECK_THEN_RESUME',
        expectedCustomerId: '54283',
        expectedContactId: '48297',
        expectedLocationId: '50249',
        expectedContactAction: 'LINK EXISTING'
      },
      {
        requestId: 'SR-20260904102654-3390',
        label: 'Michael Gervais',
        mode: 'RECHECK_THEN_RESUME',
        expectedCustomerId: '35659',
        expectedContactId: '',
        expectedLocationId: '32606',
        expectedContactAction: 'CREATE'
      },
      {
        requestId: 'SR-20260904165840-6253',
        label: 'Chris Davis',
        mode: 'REVIEW_ONLY'
      }
    ];

    function clean_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
    function upper_(v) { return clean_(v).toUpperCase(); }
    function row_(id) { return CF.Util.findRecord('SERVICE_REQUESTS', 'Request ID', id); }
    function isSloOnlyReview_(record) {
      var reason = upper_(record && record['Manual Review Reason']);
      var issue = upper_(record && record['Blocking Issue']);
      var next = upper_(record && record['Next Action']);
      return reason.indexOf('PROCESSING EXCEEDED 15 MINUTES') !== -1 ||
        issue.indexOf('PROCESSING EXCEEDED 15 MINUTES') !== -1 ||
        next.indexOf('REVIEW PROCESSING SLA BREACH') !== -1;
    }
    function restoreDurableStageAfterSloPark_(record) {
      if (!record || !record.__rowNumber || !isSloOnlyReview_(record)) return false;
      var customerId = clean_(record['Matched Customer ID'] || record['Created Customer ID']);
      var contactId = clean_(record['Matched Contact ID'] || record['Created Contact ID']);
      var locationId = clean_(record['Matched Location ID'] || record['Created Location ID']);
      if (!customerId || !locationId) return false;
      var patch = {
        'Updated At': CF.Util.nowString(),
        'Request Status': 'OPEN',
        'Manual Review?': 'NO',
        'Manual Review Reason': '',
        'Blocking Issue': '',
        'Striven Sync Status': 'PARTIAL',
        'Striven Sync Error': ''
      };
      if (contactId) {
        patch['Current Stage'] = 'CUSTOMER STRUCTURE COMPLETE';
        patch['Customer Structure Status'] = 'COMPLETE';
        patch['Next Action'] = 'CONTINUE TO WORK ORDER';
      } else {
        patch['Current Stage'] = 'READY FOR CONTACT CREATE';
        patch['Next Action'] = 'CREATE CONTACT';
      }
      CF.Util.patchRow('SERVICE_REQUESTS', record.__rowNumber, patch);
      try { SpreadsheetApp.flush(); } catch (ignoredFlush) {}
      return true;
    }
    function assertIdentity_(target, record) {
      if (!record) throw new Error('Service Request not found: ' + target.requestId);
      if (clean_(record['Work Order ID'])) return { alreadyDurable: true };
      if (target.expectedCustomerId && clean_(record['Matched Customer ID'] || record['Created Customer ID']) !== target.expectedCustomerId) {
        throw new Error(target.label + ': expected Customer ' + target.expectedCustomerId + ', got ' + clean_(record['Matched Customer ID'] || record['Created Customer ID']) + '.');
      }
      if (target.expectedLocationId && clean_(record['Matched Location ID'] || record['Created Location ID']) !== target.expectedLocationId) {
        throw new Error(target.label + ': expected Location ' + target.expectedLocationId + ', got ' + clean_(record['Matched Location ID'] || record['Created Location ID']) + '.');
      }
      if (target.expectedContactId && clean_(record['Matched Contact ID'] || record['Created Contact ID']) !== target.expectedContactId) {
        throw new Error(target.label + ': expected Contact ' + target.expectedContactId + ', got ' + clean_(record['Matched Contact ID'] || record['Created Contact ID']) + '.');
      }
      if (target.expectedContactId === '' && target.expectedContactAction === 'CREATE' && clean_(record['Matched Contact ID'])) {
        throw new Error(target.label + ': expected a NEW Contact under the household Customer, but an existing Contact was linked: ' + clean_(record['Matched Contact ID']) + '.');
      }
      if (target.expectedContactAction && upper_(record['Contact Action']) !== target.expectedContactAction) {
        throw new Error(target.label + ': expected Contact Action ' + target.expectedContactAction + ', got ' + clean_(record['Contact Action']) + '.');
      }
      if (upper_(record['Duplicate Risk Status']) && upper_(record['Duplicate Risk Status']) !== 'NONE') {
        throw new Error(target.label + ': duplicate risk is not NONE: ' + clean_(record['Duplicate Risk Status']) + '.');
      }
      return { alreadyDurable: false };
    }

    if (!CF.EventDrivenServiceAutomation || typeof CF.EventDrivenServiceAutomation.kick !== 'function') {
      throw new Error('CF.EventDrivenServiceAutomation.kick is unavailable.');
    }
    if (!CF.Matching || typeof CF.Matching.recheckRequest !== 'function') {
      throw new Error('CF.Matching.recheckRequest is unavailable.');
    }

    var results = [];
    targets.forEach(function (target) {
      var before = row_(target.requestId);
      if (!before) throw new Error('Service Request not found: ' + target.requestId);

      if (target.mode === 'REVIEW_ONLY') {
        results.push({
          requestId: target.requestId,
          label: target.label,
          status: 'REVIEW_REQUIRED_NO_AUTO_RESUME',
          currentStage: clean_(before['Current Stage']),
          reason: clean_(before['Manual Review Reason'] || before['Blocking Issue']),
          liveWriteExecuted: false
        });
        return;
      }

      if (clean_(before['Work Order ID'])) {
        results.push({
          requestId: target.requestId,
          label: target.label,
          status: 'ALREADY_DURABLE_NO_RESUME',
          workOrderId: clean_(before['Work Order ID']),
          workOrderNumber: clean_(before['Work Order Number']),
          liveWriteExecuted: false
        });
        return;
      }

      var matching = null;
      if (target.mode === 'RECHECK_THEN_RESUME') {
        matching = CF.Matching.recheckRequest(target.requestId, { persist: true });
      }

      var after = row_(target.requestId);
      assertIdentity_(target, after);
      var sloReviewCleared = restoreDurableStageAfterSloPark_(after);
      after = row_(target.requestId);
      assertIdentity_(target, after);

      if (upper_(after['Manual Review?']) === 'YES') {
        throw new Error(target.label + ': a non-SLO review remains and must not be auto-cleared: ' + clean_(after['Manual Review Reason']));
      }

      var kick = CF.EventDrivenServiceAutomation.kick(target.requestId);
      if (!kick || kick.ok === false) {
        throw new Error(target.label + ': production workflow could not be queued: ' + JSON.stringify(kick || {}));
      }
      results.push({
        requestId: target.requestId,
        label: target.label,
        status: 'VALIDATED_AND_QUEUED',
        customerId: clean_(after['Matched Customer ID'] || after['Created Customer ID']),
        contactId: clean_(after['Matched Contact ID'] || after['Created Contact ID']),
        locationId: clean_(after['Matched Location ID'] || after['Created Location ID']),
        contactAction: clean_(after['Contact Action']),
        matching: matching,
        sloOnlyReviewCleared: sloReviewCleared,
        kick: kick,
        runnerDirectStrivenWriteExecuted: false,
        downstreamNormalWorkflowMayWriteStriven: true
      });
    });

    var queueRefresh = null;
    try {
      if (CF.OperatorQueue && typeof CF.OperatorQueue.refresh === 'function') queueRefresh = CF.OperatorQueue.refresh();
    } catch (ignoredRefresh) {}

    var out = {
      ok: true,
      version: VERSION,
      mode: 'WORKFLOW_STABILITY_RECENT_INCOMPLETE_CONTROLLED_RESUME',
      fixes: {
        businessVsAttemptClockSeparated: true,
        sloHardParkUsesActiveAttempt: true,
        completedStructureSkipsDuplicateStructureLoop: true,
        contactRefreshMayContinueSameRun: true,
        initialTriggerFastPath: true,
        householdIdentityPolicy: true
      },
      results: results,
      operatorQueueRefresh: queueRefresh,
      runnerDirectStrivenWriteExecuted: false,
      downstreamNormalWorkflowMayWriteStriven: true
    };
    console.log('Workflow Stability + Recent Resume: ' + JSON.stringify(out));
    return out;
  });
}

/* Read-only post-deployment status / regression runner. */
function TESTING_20260905_workflowStabilityStatus() {
  return CF.PublicRunners.run('TESTING 20260905 - Workflow stability status', function () {
    var a = CF.EventDrivenServiceAutomation || {};
    var cfg = typeof a.workflowStabilityConfig === 'function' ? a.workflowStabilityConfig() : null;
    var targets = ['SR-20260905061831-2571','SR-20260904144057-8217','SR-20260904102654-3390','SR-20260904165840-6253'];
    var rows = targets.map(function (id) {
      var r = CF.Util.findRecord('SERVICE_REQUESTS', 'Request ID', id) || {};
      return {
        requestId: id,
        name: String(r['Full Name'] || ''),
        stage: String(r['Current Stage'] || ''),
        requestStatus: String(r['Request Status'] || ''),
        manualReview: String(r['Manual Review?'] || ''),
        nextAction: String(r['Next Action'] || ''),
        customerId: String(r['Matched Customer ID'] || r['Created Customer ID'] || ''),
        contactId: String(r['Matched Contact ID'] || r['Created Contact ID'] || ''),
        locationId: String(r['Matched Location ID'] || r['Created Location ID'] || ''),
        workOrderId: String(r['Work Order ID'] || ''),
        workOrderNumber: String(r['Work Order Number'] || '')
      };
    });
    return {
      ok: !!a.__workflowStabilityV5126R1,
      version: '5.12.6',
      config: cfg,
      queuedWork: typeof a.describeQueuedWork === 'function' ? a.describeQueuedWork() : null,
      recentRequests: rows,
      liveWriteExecuted: false
    };
  });
}

/* CF_SERVICEOPS_V5_12_7_AUTONOMY_REPROCESS_RUNNER_R1 */
var CF = CF || {};

/**
 * One-time controlled post-deployment recovery for the autonomy policy.
 *
 * IMPORTANT:
 * - This runner does NOT call a Striven mutation directly.
 * - Chris Davis is re-matched under the new "tertiary-only is informational" rule.
 * - Michael Gervais is only re-kicked from his durable reconcile-only state; no Contact POST retry is issued here.
 * - Legacy successful-Quoted manual-review rows are cleared only when the review reason is exactly the old
 *   "successful Sales Order needs review" reason and a durable Work Order ID already exists.
 */
function FIX_20260905_applyAutonomousResolutionPolicyAndResume() {
  return CF.PublicRunners.run('FIX 20260905 - Autonomous resolution + minimal review', function () {
    var VERSION = '5.12.7';
    var OLD_SO_REVIEW_REASON = 'Sales Order created and reconciled as Quoted. Manual operator review is required.';
    var successReviewIds = [
      'SR-20260905134007-9457', // Stephanie Kerr
      'SR-20260905061831-2571', // Derek Cooper
      'SR-20260904144057-8217', // Lynne Stephens
      'SR-20260904110719-1517', // Paul Brogren
      'SR-20260904101334-2423', // Neil Randall
      'SR-20260903104438-4649', // Sandra Collins
      'SR-20260902200401-7104', // Eleanore Lindo
      'SR-20260902141508-9489', // Andrew Ross
      'SR-20260902123725-2841', // Karen Stewart
      'SR-20260901142349-9492', // Anne Rhodes
      'SR-20260901134605-8237'  // Kelly Pettitt
    ];

    function clean_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
    function upper_(v) { return clean_(v).toUpperCase(); }
    function row_(id) { return CF.Util.findRecord('SERVICE_REQUESTS', 'Request ID', id); }
    function patch_(record, patch) {
      if (!record || !record.__rowNumber) throw new Error('Service Request row unavailable for patch.');
      if (typeof CF.Util.clearRowDataValidations === 'function') CF.Util.clearRowDataValidations('SERVICE_REQUESTS', record.__rowNumber);
      CF.Util.patchRow('SERVICE_REQUESTS', record.__rowNumber, patch);
      try { SpreadsheetApp.flush(); } catch (ignoredFlush) {}
    }
    function clearLegacyVerifiedSoReview_(id) {
      var r = row_(id);
      if (!r) return { requestId: id, status: 'NOT_FOUND' };
      var durable = clean_(r['Work Order ID']);
      var reason = clean_(r['Manual Review Reason']);
      var issue = clean_(r['Blocking Issue']);
      var risk = upper_(r['Duplicate Risk Status']);
      if (!durable) return { requestId: id, status: 'NO_DURABLE_SALES_ORDER' };
      if (reason !== OLD_SO_REVIEW_REASON) return { requestId: id, status: 'REVIEW_REASON_NOT_LEGACY_SUCCESS_ONLY', reason: reason };
      if (issue) return { requestId: id, status: 'BLOCKING_ISSUE_PRESENT_NOT_CLEARED', blockingIssue: issue };
      if (risk && risk !== 'NONE') return { requestId: id, status: 'DUPLICATE_RISK_PRESENT_NOT_CLEARED', duplicateRisk: risk };
      patch_(r, {
        'Updated At': CF.Util.nowString(),
        'Current Stage': 'SALES ORDER CREATED',
        'Request Status': 'OPEN',
        'Manual Review?': 'NO',
        'Manual Review Reason': '',
        'Blocking Issue': '',
        'Next Action': 'SCHEDULE SERVICE',
        'Striven Sync Status': 'SYNCED',
        'Striven Sync Error': '',
        'Reconciliation Status': 'SALES ORDER CREATED QUOTED — VERIFIED'
      });
      return {
        requestId: id,
        status: 'LEGACY_SUCCESS_REVIEW_CLEARED',
        workOrderId: durable,
        workOrderNumber: clean_(r['Work Order Number']),
        liveWriteExecuted: false
      };
    }

    if (!CF.Matching || typeof CF.Matching.recheckRequest !== 'function') throw new Error('CF.Matching.recheckRequest is unavailable.');
    if (!CF.EventDrivenServiceAutomation || typeof CF.EventDrivenServiceAutomation.kick !== 'function') throw new Error('CF.EventDrivenServiceAutomation.kick is unavailable.');

    var successReviewCleanup = successReviewIds.map(clearLegacyVerifiedSoReview_);

    var chrisId = 'SR-20260904165840-6253';
    var chrisBefore = row_(chrisId);
    if (!chrisBefore) throw new Error('Chris Davis Service Request not found.');
    var chrisMatch = CF.Matching.recheckRequest(chrisId, { persist: true });
    var chris = row_(chrisId);
    if (!chris) throw new Error('Chris Davis Service Request disappeared after recheck.');
    if (clean_(chris['Work Order ID'])) {
      // Already durable: do not restart.
    } else {
      if (upper_(chris['Customer Match Status']) !== 'NOT FOUND') throw new Error('Chris Davis expected Customer Match Status NOT FOUND; got ' + clean_(chris['Customer Match Status']) + '.');
      if (upper_(chris['Customer Action']) !== 'CREATE') throw new Error('Chris Davis expected Customer Action CREATE; got ' + clean_(chris['Customer Action']) + '.');
      if (upper_(chris['Contact Action']) !== 'CREATE') throw new Error('Chris Davis expected Contact Action CREATE; got ' + clean_(chris['Contact Action']) + '.');
      if (upper_(chris['Location Action']) !== 'CREATE') throw new Error('Chris Davis expected Location Action CREATE; got ' + clean_(chris['Location Action']) + '.');
      if (upper_(chris['Work Order Action']) !== 'CREATE') throw new Error('Chris Davis expected Work Order Action CREATE; got ' + clean_(chris['Work Order Action']) + '.');
      if (upper_(chris['Manual Review?']) === 'YES') throw new Error('Chris Davis still has Manual Review active after tertiary-only safe-create recheck: ' + clean_(chris['Manual Review Reason']));
      if (upper_(chris['Duplicate Risk Status']) && upper_(chris['Duplicate Risk Status']) !== 'NONE') throw new Error('Chris Davis duplicate risk is not NONE.');
    }
    var chrisKick = clean_(chris['Work Order ID']) ? null : CF.EventDrivenServiceAutomation.kick(chrisId);
    if (chrisKick && chrisKick.ok === false) throw new Error('Chris Davis could not be queued: ' + JSON.stringify(chrisKick));

    var michaelId = 'SR-20260904102654-3390';
    var michael = row_(michaelId);
    var michaelKick = null;
    if (michael && !clean_(michael['Work Order ID'])) {
      if (upper_(michael['Manual Review?']) === 'YES') throw new Error('Michael Gervais has a manual review; autonomy runner will not clear a genuine review.');
      michaelKick = CF.EventDrivenServiceAutomation.kick(michaelId);
      if (!michaelKick || michaelKick.ok === false) throw new Error('Michael Gervais reconcile-only continuation could not be queued: ' + JSON.stringify(michaelKick || {}));
    }

    var queueRefresh = null;
    try { if (CF.OperatorQueue && typeof CF.OperatorQueue.refresh === 'function') queueRefresh = CF.OperatorQueue.refresh(); } catch (ignoredQueueRefresh) {}

    var out = {
      ok: true,
      version: VERSION,
      mode: 'AUTONOMOUS_RESOLUTION_MINIMAL_REVIEW_CONTROLLED_RESUME',
      policy: {
        reviewOnlyOnGenuineCompetingEvidence: true,
        tertiaryNameOnlySafeCreate: true,
        tertiaryAddressOnlySafeCreate: true,
        householdAddressSurnameReusePreserved: true,
        verifiedQuotedSalesOrderNoManualReview: true,
        uncertainContactWriteNeverAutoRetryPost: true,
        genericContactResponseIdRequiresGetVerification: true
      },
      successfulSalesOrderReviewCleanup: successReviewCleanup,
      chris: {
        recheck: chrisMatch,
        currentStage: clean_(chris['Current Stage']),
        customerMatchStatus: clean_(chris['Customer Match Status']),
        customerAction: clean_(chris['Customer Action']),
        contactAction: clean_(chris['Contact Action']),
        locationAction: clean_(chris['Location Action']),
        workOrderAction: clean_(chris['Work Order Action']),
        kick: chrisKick
      },
      michael: {
        currentStage: clean_(michael && michael['Current Stage']),
        nextAction: clean_(michael && michael['Next Action']),
        kick: michaelKick
      },
      operatorQueueRefresh: queueRefresh,
      runnerDirectStrivenWriteExecuted: false,
      downstreamNormalWorkflowMayWriteStriven: true
    };
    console.log('Autonomous Resolution + Minimal Review: ' + JSON.stringify(out));
    return out;
  });
}

/** Read-only acceptance/status check after the one-time recovery runner. */
function TESTING_20260905_autonomousResolutionStatus() {
  return CF.PublicRunners.run('TESTING 20260905 - Autonomous resolution status', function () {
    var ids = [
      'SR-20260904165840-6253',
      'SR-20260904102654-3390',
      'SR-20260905061831-2571',
      'SR-20260904144057-8217'
    ];
    var rows = ids.map(function (id) {
      var r = CF.Util.findRecord('SERVICE_REQUESTS', 'Request ID', id) || {};
      return {
        requestId: id,
        name: String(r['Full Name'] || ''),
        stage: String(r['Current Stage'] || ''),
        requestStatus: String(r['Request Status'] || ''),
        manualReview: String(r['Manual Review?'] || ''),
        manualReviewReason: String(r['Manual Review Reason'] || ''),
        nextAction: String(r['Next Action'] || ''),
        customerMatchStatus: String(r['Customer Match Status'] || ''),
        customerAction: String(r['Customer Action'] || ''),
        contactAction: String(r['Contact Action'] || ''),
        locationAction: String(r['Location Action'] || ''),
        customerId: String(r['Matched Customer ID'] || r['Created Customer ID'] || ''),
        contactId: String(r['Matched Contact ID'] || r['Created Contact ID'] || ''),
        locationId: String(r['Matched Location ID'] || r['Created Location ID'] || ''),
        workOrderId: String(r['Work Order ID'] || ''),
        workOrderNumber: String(r['Work Order Number'] || '')
      };
    });
    var a = CF.EventDrivenServiceAutomation || {};
    return {
      ok: true,
      version: '5.12.7',
      policy: {
        tertiaryOnlySafeCreate: true,
        verifiedQuotedSalesOrderNoManualReview: true,
        uncertainContactNoWriteRetry: true
      },
      queuedWork: typeof a.describeQueuedWork === 'function' ? a.describeQueuedWork() : null,
      recentRequests: rows,
      liveWriteExecuted: false
    };
  });
}

/* CF_SERVICEOPS_V5_12_8_RECENT15_RECOVERY_RUNNER_R1 */
(function(){
  'use strict';
  var IDS=[
    'SR-20260908093907-7652','SR-20260908093552-3155','SR-20260908084036-1273',
    'SR-20260907181847-9140','SR-20260907150227-9928','SR-20260906133344-7582',
    'SR-20260906082554-5958','SR-20260905134007-9457','SR-20260905061831-2571',
    'SR-20260904165840-6253','SR-20260904144057-8217','SR-20260904110719-1517',
    'SR-20260904102654-3390','SR-20260904101334-2423','SR-20260903104438-4649'
  ];
  function clean_(v){return v===null||v===undefined?'':String(v).trim();}
  function upper_(v){return clean_(v).toUpperCase();}
  function row_(id){return CF.Util.findRecord('SERVICE_REQUESTS','Request ID',id);}
  function durable_(r,a,b){return clean_(r&&r[a]||r&&r[b]);}
  function technicalReview_(r){var x=clean_(r&&r['Manual Review Reason'])+' '+clean_(r&&r['Blocking Issue']);return /Processing exceeded 15 minutes|SLA BREACH|LOCATION_RECONCILIATION_STALLED_PARKED/i.test(x);}
  function genuineRisk_(r){var risk=upper_(r&&r['Duplicate Risk Status']);if(risk&&risk!=='NONE')return true;var next=upper_(r&&r['Next Action']);return /REVIEW (CUSTOMER|CONTACT|LOCATION) (OWNERSHIP|CANDIDATES)|IDENTITY OWNERSHIP CONFLICT|DUPLICATE CONTACT IDS AMBIGUOUS/.test(next+' '+upper_(r&&r['Reconciliation Status']));}
  function canonicalStage_(r){
    if(clean_(r['Work Order ID']))return{stage:'SALES ORDER CREATED',status:'OPEN',next:'SCHEDULE SERVICE',structure:clean_(r['Customer Structure Status'])||'COMPLETE'};
    var cid=durable_(r,'Matched Customer ID','Created Customer ID'),kid=durable_(r,'Matched Contact ID','Created Contact ID'),lid=durable_(r,'Matched Location ID','Created Location ID');
    var ca=upper_(r['Customer Action']),ka=upper_(r['Contact Action']),la=upper_(r['Location Action']);
    if(!cid&&ca==='CREATE')return{stage:'READY FOR CUSTOMER CREATE',status:'OPEN',next:'APPROVE PROPOSED ACTION — CREATE CUSTOMER',structure:'NOT STARTED'};
    if(cid&&!lid&&la==='CREATE')return{stage:'READY FOR LOCATION CREATE',status:'OPEN',next:'CREATE LOCATION — GUARDED',structure:'IN PROGRESS'};
    if(cid&&lid&&!kid&&ka==='CREATE')return{stage:'READY FOR CONTACT CREATE',status:'OPEN',next:'CREATE CONTACT',structure:'IN PROGRESS'};
    if(cid&&lid&&kid)return{stage:'CUSTOMER STRUCTURE COMPLETE',status:'OPEN',next:'CONTINUE TO WORK ORDER',structure:'COMPLETE'};
    return{stage:clean_(r['Current Stage'])||'NEW INTAKE',status:clean_(r['Request Status'])||'OPEN',next:clean_(r['Next Action'])||'RUN MATCHING',structure:clean_(r['Customer Structure Status'])||'NOT STARTED'};
  }
  function repairLocal_(r){
    if(!r||!r.__rowNumber)return{changed:false,reason:'ROW_MISSING'};
    var patch={'Updated At':CF.Util.nowString()},changed=false;
    if(clean_(r['Work Order ID'])&&!genuineRisk_(r)){
      Object.assign(patch,{'Current Stage':'SALES ORDER CREATED','Request Status':'OPEN','Manual Review?':'NO','Manual Review Reason':'','Blocking Issue':'','Next Action':'SCHEDULE SERVICE','Work Order Action':'LINK EXISTING','Striven Sync Status':'SYNCED','Striven Sync Error':'','Reconciliation Status':'SALES ORDER CREATED QUOTED — VERIFIED'});changed=true;
    } else if(technicalReview_(r)&&!genuineRisk_(r)){
      var s=canonicalStage_(r);Object.assign(patch,{'Current Stage':s.stage,'Request Status':s.status,'Manual Review?':'NO','Manual Review Reason':'','Blocking Issue':'','Next Action':s.next,'Customer Structure Status':s.structure,'Striven Sync Error':''});changed=true;
    }
    if(changed)CF.Util.patchRow('SERVICE_REQUESTS',r.__rowNumber,patch);
    return{changed:changed};
  }
  function snapshot_(r){return{requestId:clean_(r&&r['Request ID']),name:clean_(r&&r['Full Name']),stage:clean_(r&&r['Current Stage']),requestStatus:clean_(r&&r['Request Status']),manualReview:clean_(r&&r['Manual Review?']),manualReviewReason:clean_(r&&r['Manual Review Reason']),nextAction:clean_(r&&r['Next Action']),customerId:durable_(r||{},'Matched Customer ID','Created Customer ID'),contactId:durable_(r||{},'Matched Contact ID','Created Contact ID'),locationId:durable_(r||{},'Matched Location ID','Created Location ID'),workOrderId:clean_(r&&r['Work Order ID']),workOrderNumber:clean_(r&&r['Work Order Number'])};}
  
  function FIX_20260908_repairRecent15AndResume(){
    var results=[];
    IDS.forEach(function(id){
      var before=row_(id);if(!before){results.push({requestId:id,status:'NOT_FOUND'});return;}
      var local=repairLocal_(before),after=row_(id);
      if(!clean_(after['Work Order ID'])&&upper_(after['Manual Review?'])!=='YES'&&!genuineRisk_(after)&&CF.Matching&&typeof CF.Matching.recheckRequest==='function'){
        try{CF.Matching.recheckRequest(id,{persist:true});}catch(e){results.push({requestId:id,status:'MATCH_RECHECK_FAILED',error:String(e&&e.message||e)});return;}
        after=row_(id);
      }
      var kick=null;
      if(!clean_(after['Work Order ID'])&&upper_(after['Manual Review?'])!=='YES'&&!genuineRisk_(after)&&CF.EventDrivenServiceAutomation&&typeof CF.EventDrivenServiceAutomation.kick==='function'){
        kick=CF.EventDrivenServiceAutomation.kick(id);
      }
      results.push({requestId:id,localRepair:local,after:snapshot_(row_(id)),kick:kick});
    });
    return{ok:true,version:'5.12.8',mode:'RECENT_15_LOCAL_REPAIR_RECHECK_AND_QUEUE',results:results,runnerDirectStrivenWriteExecuted:false,downstreamNormalWorkflowMayWrite:true};
  }
  
  function TESTING_20260908_recent15EndToEndStatus(){
    var queued={};try{queued=CF.EventDrivenServiceAutomation&&typeof CF.EventDrivenServiceAutomation.describeQueuedWork==='function'?CF.EventDrivenServiceAutomation.describeQueuedWork():{};}catch(e){queued={error:String(e&&e.message||e)};}
    return{ok:true,version:'5.12.8',policy:{technicalSloCreatesManualReview:false,newKickPreservesPendingWorker:true,verifiedSalesOrderMonotonic:true,standaloneLocationGuarded:true,dualExactContactIdentityAutoLink:true,noProgressQueueFairness:true},queuedWork:queued,recent15:IDS.map(function(id){return snapshot_(row_(id));}),liveWriteExecuted:false};
  }
  this.FIX_20260908_repairRecent15AndResume=FIX_20260908_repairRecent15AndResume;
  this.TESTING_20260908_recent15EndToEndStatus=TESTING_20260908_recent15EndToEndStatus;
}).call(this);


/* CF_SERVICEOPS_V5_12_8_TESTING_MENU_CURRENT_RELEASE_R2 */

function TESTING_CURRENT_runRecoveryResume() {
  return CF.PublicRunners.run('CURRENT RELEASE - Recovery / Resume', function () {
    return FIX_20260908_associationIdentityRecoveryV5129();
  });
}

function TESTING_CURRENT_runReadOnlyStatusCheck() {
  return CF.PublicRunners.run('CURRENT RELEASE - Read-Only Status Check', function () {
    return TESTING_20260908_associationIdentityStatusV5129();
  });
}

/* CF_SERVICEOPS_V5_12_9_ASSOCIATION_IDENTITY_RECOVERY_R1 */
(function(){
  'use strict';
  var VERSION='5.12.9';
  var IDS=[
    'SR-20260908093552-3155', /* Hossein Masooly */
    'SR-20260907150227-9928', /* Philipp Klaussner */
    'SR-20260906133344-7582', /* Heather Rendulich */
    'SR-20260906082554-5958', /* Jeffrey Gilmour */
    'SR-20260904165840-6253', /* Chris Davis */
    'SR-20260904102654-3390', /* Michael Gervais */
    'SR-20260908101020-1475', /* Raymond Dimech */
    'SR-20260908111113-7167'  /* Sandra Tenus */
  ];
  function clean_(v){return v===null||v===undefined?'':String(v).trim();}
  function upper_(v){return clean_(v).toUpperCase();}
  function row_(id){return CF.Util.findRecord('SERVICE_REQUESTS','Request ID',clean_(id));}
  function durable_(r,a,b){return clean_(r&&r[a]||r&&r[b]);}
  function journal_(r){try{return JSON.parse(clean_(r&&r['Write Journal JSON'])||'{}')||{};}catch(e){return{};}}
  function householdReview_(r){var t=clean_(r&&r['Manual Review Reason'])+' '+clean_(r&&r['Blocking Issue']);return /Possible household Contact/i.test(t)&&upper_(r&&r['Duplicate Risk Status'])==='NONE';}
  function verifiedSo_(r){return !!clean_(r&&r['Work Order ID']);}
  function uncertainContact_(r){var j=journal_(r),c=j.contactCreate||{};return !durable_(r||{},'Matched Contact ID','Created Contact ID')&&Number(c.postAttempts||0)>0&&c.remoteWriteMayHaveSucceeded===true;}
  function patch_(r,p){if(r&&r.__rowNumber)CF.Util.patchRow('SERVICE_REQUESTS',r.__rowNumber,p);}
  function snapshot_(r){return{requestId:clean_(r&&r['Request ID']),name:clean_(r&&r['Full Name']),stage:clean_(r&&r['Current Stage']),requestStatus:clean_(r&&r['Request Status']),manualReview:clean_(r&&r['Manual Review?']),manualReviewReason:clean_(r&&r['Manual Review Reason']),nextAction:clean_(r&&r['Next Action']),customerId:durable_(r||{},'Matched Customer ID','Created Customer ID'),contactId:durable_(r||{},'Matched Contact ID','Created Contact ID'),locationId:durable_(r||{},'Matched Location ID','Created Location ID'),workOrderId:clean_(r&&r['Work Order ID']),workOrderNumber:clean_(r&&r['Work Order Number']),reconciliationStatus:clean_(r&&r['Reconciliation Status'])};}
  function repairOne_(id){
    var r=row_(id),steps=[];if(!r)return{requestId:id,status:'NOT_FOUND'};
    if(verifiedSo_(r)){
      patch_(r,{'Updated At':CF.Util.nowString(),'Current Stage':'SALES ORDER CREATED','Request Status':'OPEN','Manual Review?':'NO','Manual Review Reason':'','Blocking Issue':'','Next Action':'SCHEDULE SERVICE','Work Order Action':'LINK EXISTING','Striven Sync Status':'SYNCED','Striven Sync Error':'','Reconciliation Status':'SALES ORDER CREATED QUOTED — VERIFIED'});
      return{requestId:id,status:'VERIFIED_SO_NORMALIZED',steps:['MONOTONIC_SO'],after:snapshot_(row_(id)),kick:null};
    }
    if(householdReview_(r)){
      patch_(r,{'Updated At':CF.Util.nowString(),'Current Stage':'NEW INTAKE','Request Status':'OPEN','Manual Review?':'NO','Manual Review Reason':'','Blocking Issue':'','Next Action':'RUN MATCHING','Contact Match Status':'NOT STARTED','Contact Action':'','Work Order Action':'CREATE','Striven Sync Error':'','Reconciliation Status':'HOUSEHOLD REVIEW CLEARED FOR V5.12.9 RECHECK'});
      steps.push('CLEAR_OBSOLETE_HOUSEHOLD_REVIEW');
      if(CF.Matching&&typeof CF.Matching.recheckRequest==='function'){CF.Matching.recheckRequest(id,{persist:true});steps.push('MATCH_RECHECK');}
      r=row_(id);
    }
    if(uncertainContact_(r)){
      patch_(r,{'Updated At':CF.Util.nowString(),'Current Stage':'CREATING CUSTOMER STRUCTURE','Request Status':'IN PROGRESS','Manual Review?':'NO','Manual Review Reason':'','Blocking Issue':'Previous Contact create may have succeeded; reconcile journal before any Contact write.','Next Action':'RECONCILE CONTACT CREATE — PRIOR WRITE MAY HAVE SUCCEEDED','Customer Structure Status':'CONTACT CREATE RESPONSE ID MISSING — RECONCILE','Striven Sync Status':'RECONCILE REQUIRED','Reconciliation Status':'CONTACT UNCERTAIN WRITE — READ/BOUNDED RECOVERY ONLY'});
      steps.push('PRESERVE_UNCERTAIN_CONTACT_WRITE');
      r=row_(id);
    }
    var kick=null;
    if(upper_(r['Manual Review?'])!=='YES'&&!clean_(r['Work Order ID'])&&CF.EventDrivenServiceAutomation&&typeof CF.EventDrivenServiceAutomation.kick==='function'){
      kick=CF.EventDrivenServiceAutomation.kick(id);steps.push('QUEUE');
    }
    return{requestId:id,status:'REPAIRED_AND_QUEUED',steps:steps,after:snapshot_(row_(id)),kick:kick};
  }
  function FIX_20260908_associationIdentityRecoveryV5129(){
    var results=IDS.map(repairOne_);
    return{ok:true,version:VERSION,mode:'ASSOCIATION_IDENTITY_LOCATION_RECOVERY',results:results,runnerDirectStrivenWriteExecuted:false,downstreamNormalWorkflowMayWrite:true};
  }
  function TESTING_20260908_associationIdentityStatusV5129(){
    var queued={};try{queued=CF.EventDrivenServiceAutomation&&typeof CF.EventDrivenServiceAutomation.describeQueuedWork==='function'?CF.EventDrivenServiceAutomation.describeQueuedWork():{};}catch(e){queued={error:String(e&&e.message||e)};}
    return{ok:true,version:VERSION,policy:{associationPayloadCustomerObject:true,sameAssociationFingerprintNoThrow:true,customerScopedLocationCanonicalization:true,householdExactSignalCompatibleNameAutoLink:true,uncertainContactWritePreserved:true,technicalSloCreatesManualReview:false,verifiedSalesOrderMonotonic:true},queuedWork:queued,focusRequests:IDS.map(function(id){return snapshot_(row_(id));}),liveWriteExecuted:false};
  }
  this.FIX_20260908_associationIdentityRecoveryV5129=FIX_20260908_associationIdentityRecoveryV5129;
  this.TESTING_20260908_associationIdentityStatusV5129=TESTING_20260908_associationIdentityStatusV5129;
}).call(this);

/* CF_SERVICEOPS_V5_14_3_DEPLOY_KICK_R1 */


/* CF_SERVICEOPS_V5_14_2_SCOPED_CONTACT_AND_MANUAL_NOTES_ADMIN_R1
 * Admin/test entry points only. Production automation uses the existing
 * AUTO_FINAL_ServiceOps + AUTO_98_E2E_Recovery_Watchdog model.
 */
function FIX_20261001_refreshCustomerScopedContactIdsAndQueue() {
  if (!CF.CustomerScopedContactIdentity || typeof CF.CustomerScopedContactIdentity.maintenance !== 'function') {
    throw new Error('CF.CustomerScopedContactIdentity.maintenance is unavailable.');
  }
  var result=CF.CustomerScopedContactIdentity.maintenance({forceRefresh:true,refreshQueue:true,maxRequests:500});
  result.liveWriteExecuted=false;
  result.strivenMutationExecuted=false;
  return result;
}

function TESTING_20261001_manualWorkOrderInternalNotesBacklogStep() {
  if (!CF.ManualWorkOrderInternalNotes || typeof CF.ManualWorkOrderInternalNotes.backlogStep !== 'function') {
    throw new Error('CF.ManualWorkOrderInternalNotes.backlogStep is unavailable.');
  }
  return CF.ManualWorkOrderInternalNotes.backlogStep({maxChecks:12});
}
