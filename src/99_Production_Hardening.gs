/**
 * CF ServiceOps — Production Guard / Cache Maintenance
 * Version: 5.14.2
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

var CFH_VERSION = '5.14.2';
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

function CFH_installAndVerifyProductionHardening() {
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
    selfTest: selfTest
  };
}
