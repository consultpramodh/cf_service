/**
 * CF ServiceOps — Production Guard / Cache Maintenance
 * Version: 5.14.4
 *
 * This file intentionally contains NO workflow monkey patches.
 * AUTO_FINAL_ServiceOps owns the request lifecycle.
 * AUTO_98_E2E_Recovery_Watchdog owns liveness/recovery.
 *
 * This module only:
 * - enforces the standard service item property;
 * - removes obsolete batch-matching triggers;
 * - maintains the shared Operational cache while the request queue is idle;
 * - reports guard health.
 */

var CFH_VERSION = '5.14.4';
var CFH_QUEUE_PROP = 'CF_EVENT_DRIVEN_SERVICE_REQUEST_IDS';
var CFH_STANDARD_ITEM_PROP = 'STRIVEN_STANDARD_SERVICE_ITEM_ID';
var CFH_STANDARD_ITEM_ID = '41481';
var CFH_OPERATIONAL_HANDLER = 'CFH_refreshOperationalCacheIfIdle';
var CFH_INTAKE_BACKSTOP_HANDLER = 'AUTO_00_GF_Intake_Backstop';
var CFH_OPERATIONAL_REFRESH_MIN_AGE_MS = 18 * 60 * 1000;

function CFH_clean_(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function CFH_queue_() {
  var raw = PropertiesService.getScriptProperties().getProperty(CFH_QUEUE_PROP);
  if (!raw) return [];
  try {
    var q = JSON.parse(raw);
    return Array.isArray(q) ? q.map(CFH_clean_).filter(Boolean) : [];
  } catch (ignored) {
    return [];
  }
}

function CFH_removeObsoleteBatchMatchingTriggers_() {
  var obsolete = {
    MATCH_processAll: true
  };
  var removed = [];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    try {
      var handler = CFH_clean_(t.getHandlerFunction && t.getHandlerFunction());
      if (!obsolete[handler]) return;
      removed.push({handler: handler, uid: CFH_clean_(t.getUniqueId && t.getUniqueId())});
      ScriptApp.deleteTrigger(t);
    } catch (ignored) {}
  });
  return removed;
}

function CFH_installOperationalMaintenanceTrigger_() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    try {
      if (CFH_clean_(t.getHandlerFunction && t.getHandlerFunction()) === CFH_OPERATIONAL_HANDLER) {
        ScriptApp.deleteTrigger(t);
        removed += 1;
      }
    } catch (ignored) {}
  });
  ScriptApp.newTrigger(CFH_OPERATIONAL_HANDLER).timeBased().everyMinutes(10).create();
  return {removedExisting: removed, installed: true, cadenceMinutes: 10};
}

function CFH_installIntakeBackstopTrigger_() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    try {
      if (CFH_clean_(t.getHandlerFunction && t.getHandlerFunction()) === CFH_INTAKE_BACKSTOP_HANDLER) {
        ScriptApp.deleteTrigger(t);
        removed += 1;
      }
    } catch (ignored) {}
  });
  ScriptApp.newTrigger(CFH_INTAKE_BACKSTOP_HANDLER).timeBased().everyMinutes(5).create();
  return {removedExisting: removed, installed: true, cadenceMinutes: 5};
}

function CFH_operationalCacheAgeMs_() {
  try {
    if (typeof CF === 'undefined' || !CF.Util) return Infinity;
    var ss = typeof CF.Util.getSpreadsheet === 'function'
      ? CF.Util.getSpreadsheet()
      : SpreadsheetApp.getActiveSpreadsheet();
    var name = '06 Striven Operational Data';
    try {
      if (CF.Config && typeof CF.Config.getSheetName === 'function') {
        name = CF.Config.getSheetName('STRIVEN_OPERATIONAL_DATA') || name;
      }
    } catch (ignoredName) {}
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return Infinity;
    var raw = sh.getRange(2, 1).getValue();
    var d = raw instanceof Date ? raw : new Date(raw);
    return isNaN(d.getTime()) ? Infinity : Date.now() - d.getTime();
  } catch (ignored) {
    return Infinity;
  }
}

function CFH_refreshOperationalCacheIfIdle() {
  var capacity=CFH_reclaimUnusedCacheGrid_();
  var queue = CFH_queue_();
  if (queue.length) {
    return {
      ok: true,
      version: CFH_VERSION,
      status: 'SKIPPED_QUEUE_ACTIVE',
      queuedRequestIds: queue,
      liveWriteExecuted: false
    };
  }

  var ageMs = CFH_operationalCacheAgeMs_();
  if (ageMs < CFH_OPERATIONAL_REFRESH_MIN_AGE_MS) {
    return {
      ok: true,
      version: CFH_VERSION,
      status: 'SKIPPED_OPERATIONAL_CACHE_FRESH',
      ageMinutes: Math.round(ageMs / 60000),
      liveWriteExecuted: false
    };
  }

  if (typeof CF === 'undefined' || !CF.StrivenData || typeof CF.StrivenData.refreshOperationalData !== 'function') {
    return {
      ok: false,
      version: CFH_VERSION,
      status: 'STRIVEN_OPERATIONAL_REFRESH_UNAVAILABLE',
      liveWriteExecuted: false
    };
  }

  var started = Date.now();
  var result = CF.StrivenData.refreshOperationalData({});
  return {
    ok: !result || result.ok !== false,
    version: CFH_VERSION,
    status: 'OPERATIONAL_CACHE_REFRESHED_WHILE_IDLE',
    ageMinutesBefore: isFinite(ageMs) ? Math.round(ageMs / 60000) : null,
    durationMs: Date.now() - started,
    result: result,
    liveWriteExecuted: false
  };
}

function CFH_installProductionHardening() {
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another CF ServiceOps execution is already running.');
  try {
    var prior = CFH_clean_(props.getProperty(CFH_STANDARD_ITEM_PROP));
    if (prior && prior !== CFH_STANDARD_ITEM_ID) {
      throw new Error(CFH_STANDARD_ITEM_PROP + ' has unexpected value ' + prior + '; refusing to overwrite.');
    }
    props.setProperty(CFH_STANDARD_ITEM_PROP, CFH_STANDARD_ITEM_ID);
  } finally {
    try { lock.releaseLock(); } catch (ignoredRelease) {}
  }

  return {
    ok: true,
    version: CFH_VERSION,
    status: 'PRODUCTION_GUARDS_INSTALLED',
    standardServiceItemId: props.getProperty(CFH_STANDARD_ITEM_PROP),
    removedObsoleteBatchMatchingTriggers: CFH_removeObsoleteBatchMatchingTriggers_(),
    operationalMaintenance: CFH_installOperationalMaintenanceTrigger_(),
    intakeBackstop: CFH_installIntakeBackstopTrigger_(),
    workflowMonkeyPatches: false
  };
}

function CFH_selfTestProductionHardening() {
  var props = PropertiesService.getScriptProperties();
  var maintenance = 0;
  var intakeBackstop = 0;
  var legacyBatch = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    try {
      var h = CFH_clean_(t.getHandlerFunction && t.getHandlerFunction());
      if (h === CFH_OPERATIONAL_HANDLER) maintenance += 1;
      if (h === CFH_INTAKE_BACKSTOP_HANDLER) intakeBackstop += 1;
      if (h === 'MATCH_processAll') legacyBatch += 1;
    } catch (ignored) {}
  });
  return {
    ok:
      props.getProperty(CFH_STANDARD_ITEM_PROP) === CFH_STANDARD_ITEM_ID &&
      legacyBatch === 0 &&
      maintenance === 1 &&
      intakeBackstop === 1,
    version: CFH_VERSION,
    standardServiceItemId: props.getProperty(CFH_STANDARD_ITEM_PROP),
    operationalMaintenanceTriggers: maintenance,
    intakeBackstopTriggers: intakeBackstop,
    legacyBatchMatchingTriggers: legacyBatch,
    operationalCacheAgeMinutes: Math.round(CFH_operationalCacheAgeMs_() / 60000),
    queuedRequestIds: CFH_queue_(),
    workflowMonkeyPatches: false
  };
}

function CFH_prepareSystemLogSink_() {
  var props=PropertiesService.getScriptProperties();
  var key='CF_SERVICEOPS_SYSTEM_LOG_SINK_ID',currentId=props.getProperty(key);
  var core=CF.Util.getSpreadsheet();
  var name=CF.Config.resolveSheetName('SYSTEM_LOG');
  var current=currentId?SpreadsheetApp.openById(currentId).getSheetByName(name):core.getSheetByName(name);
  if(!current)throw new Error('SYSTEM_LOG_SOURCE_MISSING');
  if(current.getLastRow()<=100000)return {ok:true,status:'SYSTEM_LOG_CAPACITY_HEALTHY',sinkId:currentId||'',rows:current.getLastRow()};
  var created=SpreadsheetApp.create('CF ServiceOps System Log '+new Date().toISOString());
  var sheet=created.getSheets()[0];
  sheet.setName(name);
  var headers=CF.Config.getHeaders('SYSTEM_LOG');
  sheet.getRange(1,1,1,headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  if(sheet.getMaxColumns()>headers.length)sheet.deleteColumns(headers.length+1,sheet.getMaxColumns()-headers.length);
  if(sheet.getLastRow()!==1)throw new Error('SYSTEM_LOG_SINK_INITIALIZATION_FAILED');
  // Preserve every prior workbook and row; switch only future log writes.
  props.setProperty('CF_SERVICEOPS_SYSTEM_LOG_HISTORY_'+current.getParent().getId(),JSON.stringify({spreadsheetId:current.getParent().getId(),sheetName:name,rows:current.getLastRow(),retainedAt:new Date().toISOString()}));
  props.setProperty(key,created.getId());
  return {ok:true,status:'SYSTEM_LOG_SINK_ROTATED',sinkId:created.getId(),url:created.getUrl(),previousRows:current.getLastRow(),historicalRowsPreserved:true};
}

function CFH_reclaimUnusedCacheGrid_() {
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(5000))return {ok:true,status:'CACHE_GRID_MAINTENANCE_DEFERRED',cellsFreed:0};
  try {
    var logSink=CFH_prepareSystemLogSink_();
    var freed=0,changes=[];
    ['STRIVEN_CUSTOMER_DATA','STRIVEN_LOCATION_DATA'].forEach(function(key){
      var sh=CF.Util.requireSheet(key),required=CF.Config.getHeaders(key).length;
      var columns=sh.getMaxColumns();
      if(required>0&&columns>required&&sh.getLastColumn()<=required){
        var removed=columns-required;
        sh.deleteColumns(required+1,removed);
        freed+=sh.getMaxRows()*removed;
        changes.push({sheet:key,columnsRemoved:removed});
      }
    });
    var retryReset=false;
    if(freed>0&&CF.Util.requireSheet('STRIVEN_CUSTOMER_DATA').getLastRow()<2){
      PropertiesService.getScriptProperties().deleteProperty('CF_SERVICEOPS_API_BRAKE_LAST_ATTEMPT_CUSTOMER_MS');
      retryReset=true;
    }
    return {ok:true,status:'UNUSED_CACHE_COLUMNS_RECLAIMED',cellsFreed:freed,changes:changes,emptyCustomerRetryReset:retryReset,systemLog:logSink};
  } finally {lock.releaseLock();}
}

function CFH_installAndVerifyProductionHardening() {
  var gridMaintenance=CFH_reclaimUnusedCacheGrid_();
  var existing = CFH_selfTestProductionHardening();
  if (existing.ok === true) {
    return {ok:true,version:CFH_VERSION,status:'PRODUCTION_GUARDS_INSTALLED_AND_VERIFIED',install:{ok:true,status:'PRODUCTION_GUARDS_ALREADY_INSTALLED',changed:false},gridMaintenance:gridMaintenance,selfTest:existing,liveWriteExecuted:false,liveStrivenWriteExecuted:false};
  }
  var install = CFH_installProductionHardening();
  try { SpreadsheetApp.flush(); } catch (ignoredFlush) {}
  var selfTest = CFH_selfTestProductionHardening();
  if (!selfTest.ok) {
    throw new Error('CFH_INSTALL_VERIFY_FAILED: ' + JSON.stringify(selfTest));
  }
  return {
    ok: true,
    version: CFH_VERSION,
    status: 'PRODUCTION_GUARDS_INSTALLED_AND_VERIFIED',
    install: install,
    gridMaintenance: gridMaintenance,
    selfTest: selfTest
  };
}

