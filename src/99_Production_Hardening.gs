/**
 * CF ServiceOps - Production Hardening / Latency Reduction
 * Version: 5.12.0 R1
 *
 * Goals
 * 1) Durable Sales Orders are monotonic and cannot be rematched/recreated.
 * 2) A post-write orchestration exception cannot requeue a verified Sales Order.
 * 3) Multiple queued requests can continue in the same execution after a verified Sales Order.
 * 4) Customer/contact reconciliation is reused for the same request for a short TTL.
 * 5) Operator Queue refresh is deferred to one refresh per worker execution.
 * 6) Operational data refresh is moved to an idle background maintenance trigger.
 * 7) Legacy scheduled MATCH_processAll triggers are removed.
 *
 * IMPORTANT: This layer does not invent a value for required Striven customer custom field 694.
 * If 694 is unresolved, customer enrichment remains safely skipped and non-blocking.
 */

var CFH_RUNTIME = typeof CFH_RUNTIME !== 'undefined' ? CFH_RUNTIME : {
  workerDepth: 0,
  deferQueueRefresh: false,
  queueRefreshPending: false,
  installedAtRuntime: false
};

var CFH_VERSION = '5.12.0-R1';
var CFH_QUEUE_PROP = 'CF_EVENT_DRIVEN_SERVICE_REQUEST_IDS';
var CFH_STANDARD_ITEM_PROP = 'STRIVEN_STANDARD_SERVICE_ITEM_ID';
var CFH_STANDARD_ITEM_ID = '41481';
var CFH_OPERATIONAL_HANDLER = 'CFH_refreshOperationalCacheIfIdle';
var CFH_QUEUE_REFRESH_HANDLER = 'CFH_refreshOperatorQueueDeferred';
var CFH_FAST_TRIGGER_DELAY_MS = 1000;
var CFH_SYNC_CACHE_MS = 15 * 60 * 1000;
var CFH_CHAIN_SOFT_BUDGET_MS = 210 * 1000;
var CFH_MAX_DURABLE_CONTINUATIONS = 4;
var CFH_OPERATIONAL_REFRESH_MIN_AGE_MS = 18 * 60 * 1000;

function CFH_clean_(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function CFH_upper_(v) {
  return CFH_clean_(v).toUpperCase();
}

function CFH_now_() {
  try {
    if (typeof CF !== 'undefined' && CF.Util && typeof CF.Util.nowString === 'function') {
      return CF.Util.nowString();
    }
  } catch (ignored) {}
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/Toronto', 'yyyy-MM-dd HH:mm:ss');
}

function CFH_parseJson_(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    var x = JSON.parse(String(raw));
    return x && typeof x === 'object' ? x : {};
  } catch (ignored) {
    return {};
  }
}

function CFH_serviceRows_() {
  if (typeof CF === 'undefined' || !CF.Util) return [];
  if (typeof CF.Util.readRecords === 'function') return CF.Util.readRecords('SERVICE_REQUESTS') || [];
  if (typeof CF.Util.rowsAsObjects === 'function') return CF.Util.rowsAsObjects('SERVICE_REQUESTS') || [];
  return [];
}

function CFH_request_(requestId) {
  var id = CFH_clean_(requestId);
  if (!id || typeof CF === 'undefined' || !CF.Util) return null;
  try {
    var ss = typeof CF.Util.getSpreadsheet === 'function' ? CF.Util.getSpreadsheet() : SpreadsheetApp.getActiveSpreadsheet();
    var sheetName = '02 Service Requests';
    try {
      if (CF.Config && typeof CF.Config.getSheetName === 'function') sheetName = CF.Config.getSheetName('SERVICE_REQUESTS') || sheetName;
    } catch (ignoredName) {}
    var sh = ss.getSheetByName(sheetName);
    if (!sh || sh.getLastRow() < 2) return null;
    var found = sh.getRange(2, 1, sh.getLastRow() - 1, 1).createTextFinder(id).matchEntireCell(true).findNext();
    if (!found) return null;
    var headers = typeof CF.Util.getActualHeaders === 'function' ? CF.Util.getActualHeaders(sh) : sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    var values = sh.getRange(found.getRow(), 1, 1, headers.length).getValues()[0];
    var row = { __rowNumber: found.getRow() };
    headers.forEach(function (h, i) { if (h) row[h] = values[i]; });
    return row;
  } catch (ignored) {
    var rows = CFH_serviceRows_();
    for (var i = 0; i < rows.length; i++) {
      if (CFH_clean_(rows[i]['Request ID']) === id) return rows[i];
    }
    return null;
  }
}

function CFH_patchRow_(row, patch) {
  if (!row || !row.__rowNumber || typeof CF === 'undefined' || !CF.Util || typeof CF.Util.patchRow !== 'function') {
    return false;
  }
  CF.Util.patchRow('SERVICE_REQUESTS', row.__rowNumber, patch);
  return true;
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

function CFH_mutateQueue_(mutator) {
  var lock = LockService.getScriptLock();
  var alreadyHeld = false;
  try {
    alreadyHeld = typeof lock.hasLock === 'function' && lock.hasLock();
  } catch (ignoredHasLock) {}

  if (!alreadyHeld) {
    if (!lock.tryLock(10000)) throw new Error('CFH_QUEUE_LOCK_BUSY');
  }

  try {
    var before = CFH_queue_();
    var after = mutator(before.slice()) || [];
    var seen = {};
    var clean = [];
    after.forEach(function (id) {
      id = CFH_clean_(id);
      if (id && !seen[id]) {
        seen[id] = true;
        clean.push(id);
      }
    });
    PropertiesService.getScriptProperties().setProperty(CFH_QUEUE_PROP, JSON.stringify(clean));
    return clean;
  } finally {
    if (!alreadyHeld) {
      try { lock.releaseLock(); } catch (ignoredRelease) {}
    }
  }
}

function CFH_dequeue_(requestId) {
  var id = CFH_clean_(requestId);
  return CFH_mutateQueue_(function (q) {
    return q.filter(function (x) { return CFH_clean_(x) !== id; });
  });
}

function CFH_isDurableSalesOrder_(row) {
  return !!(row && CFH_clean_(row['Work Order ID']));
}

function CFH_shouldNormalizeDurableSalesOrder_(row) {
  if (!CFH_isDurableSalesOrder_(row)) return false;

  var stage = CFH_upper_(row['Current Stage']);
  var requestStatus = CFH_upper_(row['Request Status']);
  var workOrderStatus = CFH_upper_(row['Work Order Status']);

  // Never move truly terminal or operationally advanced work backwards.
  if (stage === 'COMPLETED' || requestStatus === 'COMPLETED') return false;
  if (stage === 'CANCELLED' || stage === 'CANCELED' || requestStatus === 'CANCELLED' || requestStatus === 'CANCELED') return false;
  if (workOrderStatus && workOrderStatus !== 'QUOTED') return false;

  // Only quoted/non-advanced durable orders belong in the manual-review boundary.
  return true;
}

function CFH_salesOrderJournal_(row) {
  var j = CFH_parseJson_(row && row['Write Journal JSON']);
  return j && j.salesOrderCreate && typeof j.salesOrderCreate === 'object' ? j.salesOrderCreate : {};
}

function CFH_isAutomationCreatedQuoted_(row) {
  if (!CFH_isDurableSalesOrder_(row)) return false;
  var so = CFH_salesOrderJournal_(row);
  var s = CFH_upper_(so.status);
  return s === 'SALES_ORDER_CREATED_QUOTED_RECONCILED_MANUAL_REVIEW_REQUIRED' ||
         s === 'SALES_ORDER_CREATED_IDENTITY_REVIEW' ||
         s === 'SALES_ORDER_ALREADY_DURABLE';
}

function CFH_normalizeDurableSalesOrder_(row, reason) {
  if (!CFH_shouldNormalizeDurableSalesOrder_(row)) return false;

  // Avoid churn when the durable row is already at the correct boundary.
  if (CFH_upper_(row['Current Stage']) === 'NEEDS REVIEW' &&
      CFH_upper_(row['Manual Review?']) === 'YES' &&
      CFH_upper_(row['Next Action']) === 'MANUAL REVIEW SALES ORDER') {
    return false;
  }

  var currentReason = CFH_clean_(row['Manual Review Reason']);
  var currentRecon = CFH_upper_(row['Reconciliation Status']);
  var patch = {
    'Updated At': CFH_now_(),
    'Current Stage': 'NEEDS REVIEW',
    'Request Status': 'OPEN',
    'Manual Review?': 'YES',
    'Manual Review Reason': currentReason || 'Sales Order created and verified as Quoted. Manual operator review is required.',
    'Next Action': 'MANUAL REVIEW SALES ORDER',
    'Operator Action': CFH_clean_(row['Operator Action']) || 'REVIEW QUOTED SALES ORDER',
    'Striven Sync Error': ''
  };

  if (currentRecon.indexOf('SALES ORDER CREATED') !== 0) {
    patch['Reconciliation Status'] = 'SALES ORDER CREATED QUOTED — MANUAL REVIEW REQUIRED';
  }

  CFH_patchRow_(row, patch);
  return true;
}

function CFH_durableResult_(row, mode) {
  var manualReviewRequired = CFH_upper_(row && row['Manual Review?']) === 'YES' || CFH_shouldNormalizeDurableSalesOrder_(row);
  return {
    ok: true,
    version: CFH_VERSION,
    status: mode || (manualReviewRequired ? 'SALES_ORDER_ALREADY_DURABLE_MANUAL_REVIEW' : 'SALES_ORDER_ALREADY_DURABLE_TERMINAL'),
    requestId: CFH_clean_(row && row['Request ID']),
    salesOrderId: CFH_clean_(row && row['Work Order ID']),
    workOrderId: CFH_clean_(row && row['Work Order ID']),
    orderNumber: CFH_clean_(row && row['Work Order Number']),
    workOrderNumber: CFH_clean_(row && row['Work Order Number']),
    orderStatus: CFH_clean_(row && row['Work Order Status']),
    manualReviewRequired: manualReviewRequired,
    duplicateSafe: true,
    liveWriteExecuted: false,
    hardening: { durableBoundaryRecovered: true }
  };
}

function CFH_syncJournalState_(row) {
  var j = CFH_parseJson_(row && row['Write Journal JSON']);
  var sync = j.customerContactInfoSync || {};
  var customer = sync.customer || {};
  var contact = sync.contact || {};
  return { customer: customer, contact: contact };
}

function CFH_recentDateMs_(value) {
  if (!value) return 0;
  if (Object.prototype.toString.call(value) === '[object Date]') return value.getTime();
  var d = new Date(value);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function CFH_canReuseInfoSync_(row) {
  if (!row || CFH_isDurableSalesOrder_(row)) return false;
  if (!CFH_clean_(row['Matched Customer ID'] || row['Created Customer ID'])) return false;
  if (!CFH_clean_(row['Matched Contact ID'] || row['Created Contact ID'])) return false;

  var recon = CFH_upper_(row['Reconciliation Status']);
  if (recon !== 'CUSTOMER + CONTACT INFO CONFIRMED') return false;

  var last = CFH_recentDateMs_(row['Last Striven Sync']);
  if (!last || Date.now() - last > CFH_SYNC_CACHE_MS) return false;

  var state = CFH_syncJournalState_(row);
  var cs = CFH_upper_(state.customer.status);
  var cts = CFH_upper_(state.contact.status);
  var customerSafe = cs.indexOf('CONFIRMED') !== -1 ||
    cs.indexOf('RECONCILED') !== -1 ||
    cs === 'CUSTOMER_INFO_ENRICHMENT_SKIPPED_REQUIRED_CUSTOM_FIELDS_UNRESOLVED';
  var contactSafe = cts.indexOf('CONFIRMED') !== -1 || cts.indexOf('RECONCILED') !== -1;

  return customerSafe && contactSafe;
}

function CFH_cachedInfoSyncResult_(row) {
  var state = CFH_syncJournalState_(row);
  return {
    ok: true,
    version: CFH_VERSION,
    status: 'CUSTOMER_CONTACT_INFO_CONFIRMED_CACHED',
    requestId: CFH_clean_(row['Request ID']),
    customerId: CFH_clean_(row['Matched Customer ID'] || row['Created Customer ID']),
    contactId: CFH_clean_(row['Matched Contact ID'] || row['Created Contact ID']),
    customerEnrichmentSkipped: CFH_upper_(state.customer.status) === 'CUSTOMER_INFO_ENRICHMENT_SKIPPED_REQUIRED_CUSTOM_FIELDS_UNRESOLVED',
    unresolvedRequiredCustomerCustomFieldIds: state.customer.unresolvedRequiredCustomFieldIds || [],
    writeAttempted: false,
    automaticPostRetry: false,
    cacheReused: true,
    liveWriteExecuted: false
  };
}

function CFH_cancelFutureAutomationTriggers_(currentUid) {
  if (typeof CF === 'undefined' || !CF.EventDrivenServiceAutomation) return 0;
  var names = [];
  try {
    if (typeof CF.EventDrivenServiceAutomation.allHandlerNames === 'function') {
      names = CF.EventDrivenServiceAutomation.allHandlerNames() || [];
    }
  } catch (ignoredNames) {}

  if (!names.length) {
    names = [
      'AUTO_processCustomerStructure',
      'AUTO_00_E2E_Route_Request',
      'AUTO_01_E2E_Customer_Match_Create',
      'AUTO_02_E2E_Location_Reconcile',
      'AUTO_03_E2E_Contact_Create_Recover',
      'AUTO_04_E2E_Customer_Contact_Info_Sync',
      'AUTO_05_E2E_Sales_Order_Create_Verify',
      'AUTO_99_E2E_Safe_Stop_Review'
    ];
  }

  var current = CFH_clean_(currentUid);
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    try {
      var handler = CFH_clean_(t.getHandlerFunction && t.getHandlerFunction());
      var uid = CFH_clean_(t.getUniqueId && t.getUniqueId());
      if (names.indexOf(handler) !== -1 && (!current || uid !== current)) {
        ScriptApp.deleteTrigger(t);
        removed++;
      }
    } catch (ignoredTrigger) {}
  });
  return removed;
}

function CFH_scheduleFallbackForQueue_() {
  var q = CFH_queue_();
  if (!q.length || typeof CF === 'undefined' || !CF.EventDrivenServiceAutomation || typeof CF.EventDrivenServiceAutomation.kick !== 'function') {
    return { ok: true, scheduled: false, reason: 'NO_QUEUE_OR_KICK_UNAVAILABLE' };
  }
  try {
    return CF.EventDrivenServiceAutomation.kick(q[0]);
  } catch (e) {
    return { ok: false, scheduled: false, error: String(e && e.message || e) };
  }
}

function CFH_patchCustomerContactInfoSync_() {
  if (typeof CF === 'undefined' || !CF.CustomerContactInfoSync || typeof CF.CustomerContactInfoSync.reconcile !== 'function') return false;
  if (CF.CustomerContactInfoSync.__CFH_512_PATCHED) return true;

  var base = CF.CustomerContactInfoSync.reconcile;
  CF.CustomerContactInfoSync.__CFH_BASE_RECONCILE = base;
  CF.CustomerContactInfoSync.reconcile = function (requestId, options) {
    var row = CFH_request_(requestId);
    if (CFH_isDurableSalesOrder_(row)) {
      CFH_normalizeDurableSalesOrder_(row, 'INFO_SYNC_DURABLE_GUARD');
      return CFH_durableResult_(row, 'CUSTOMER_CONTACT_INFO_SKIPPED_SALES_ORDER_DURABLE');
    }
    if (CFH_canReuseInfoSync_(row)) return CFH_cachedInfoSyncResult_(row);
    return base.apply(this, arguments);
  };
  CF.CustomerContactInfoSync.__CFH_512_PATCHED = true;
  return true;
}

function CFH_scheduleOperatorQueueRefresh_() {
  try {
    var existing = ScriptApp.getProjectTriggers().filter(function (t) {
      try { return CFH_clean_(t.getHandlerFunction && t.getHandlerFunction()) === CFH_QUEUE_REFRESH_HANDLER; } catch (ignored) { return false; }
    });
    if (existing.length) return { ok: true, scheduled: false, reason: 'QUEUE_REFRESH_ALREADY_PENDING' };
    ScriptApp.newTrigger(CFH_QUEUE_REFRESH_HANDLER).timeBased().after(CFH_FAST_TRIGGER_DELAY_MS).create();
    return { ok: true, scheduled: true, delayMs: CFH_FAST_TRIGGER_DELAY_MS };
  } catch (e) {
    return { ok: false, scheduled: false, error: String(e && e.message || e) };
  }
}

function CFH_refreshOperatorQueueDeferred() {
  CFH_applyRuntimePatches_();
  if (typeof CF === 'undefined' || !CF.OperatorQueue) return { ok: false, status: 'OPERATOR_QUEUE_UNAVAILABLE' };
  try {
    if (typeof CF.OperatorQueue.__CFH_BASE_REFRESH === 'function') return CF.OperatorQueue.__CFH_BASE_REFRESH();
    if (typeof CF.OperatorQueue.refresh === 'function') return CF.OperatorQueue.refresh();
  } catch (e) {
    return { ok: false, status: 'QUEUE_REFRESH_FAILED', error: String(e && e.message || e) };
  }
  return { ok: false, status: 'OPERATOR_QUEUE_REFRESH_UNAVAILABLE' };
}

function CFH_patchOperatorQueue_() {
  if (typeof CF === 'undefined' || !CF.OperatorQueue || typeof CF.OperatorQueue.refresh !== 'function') return false;
  if (CF.OperatorQueue.__CFH_512_PATCHED) return true;

  var base = CF.OperatorQueue.refresh;
  CF.OperatorQueue.__CFH_BASE_REFRESH = base;
  CF.OperatorQueue.refresh = function () {
    if (CFH_RUNTIME.deferQueueRefresh) {
      CFH_RUNTIME.queueRefreshPending = true;
      return { ok: true, status: 'DEFERRED_TO_WORKER_END', liveWriteExecuted: false };
    }
    return base.apply(this, arguments);
  };
  CF.OperatorQueue.__CFH_512_PATCHED = true;
  return true;
}

function CFH_filterNonDurableRequestIds_(requestIds) {
  var seen = {};
  var out = [];
  (requestIds || []).forEach(function (rawId) {
    var id = CFH_clean_(rawId);
    if (!id || seen[id]) return;
    seen[id] = true;
    var row = CFH_request_(id);
    if (!row) return;
    if (CFH_isDurableSalesOrder_(row)) {
      CFH_normalizeDurableSalesOrder_(row, 'MATCHING_DURABLE_GUARD');
      return;
    }
    out.push(id);
  });
  return out;
}

function CFH_patchMatching_() {
  if (typeof CF === 'undefined' || !CF.Matching || typeof CF.Matching.processRequestIds !== 'function') return false;
  if (CF.Matching.__CFH_512_PATCHED) return true;

  var baseTargeted = CF.Matching.processRequestIds;
  var baseAll = typeof CF.Matching.processAll === 'function' ? CF.Matching.processAll : null;
  var baseReview = typeof CF.Matching.processReview === 'function' ? CF.Matching.processReview : null;

  CF.Matching.__CFH_BASE_PROCESS_REQUEST_IDS = baseTargeted;
  CF.Matching.__CFH_BASE_PROCESS_ALL = baseAll;
  CF.Matching.__CFH_BASE_PROCESS_REVIEW = baseReview;

  CF.Matching.processRequestIds = function (requestIds, options) {
    var filtered = CFH_filterNonDurableRequestIds_(requestIds || []);
    if (!filtered.length) {
      return { ok: true, version: CFH_VERSION, status: 'NO_NON_DURABLE_REQUESTS_TO_MATCH', selected: 0, liveWriteExecuted: false };
    }
    return baseTargeted.call(this, filtered, options || {});
  };

  if (baseAll) {
    CF.Matching.processAll = function () {
      var ids = CFH_serviceRows_().filter(function (row) {
        return !CFH_isDurableSalesOrder_(row);
      }).map(function (row) { return CFH_clean_(row['Request ID']); }).filter(Boolean);
      var result = baseTargeted.call(this, ids, { refreshQueue: false, source: 'CFH_NON_DURABLE_BATCH' });
      try {
        if (CF.OperatorQueue && typeof CF.OperatorQueue.refresh === 'function') CF.OperatorQueue.refresh();
      } catch (ignoredRefresh) {}
      return result;
    };
  }

  if (baseReview) {
    CF.Matching.processReview = function () {
      var ids = CFH_serviceRows_().filter(function (row) {
        return !CFH_isDurableSalesOrder_(row) && CFH_upper_(row['Current Stage']) === 'NEEDS REVIEW';
      }).map(function (row) { return CFH_clean_(row['Request ID']); }).filter(Boolean);
      return baseTargeted.call(this, ids, { refreshQueue: true, source: 'CFH_NON_DURABLE_REVIEW' });
    };
  }

  CF.Matching.__CFH_512_PATCHED = true;
  return true;
}

function CFH_patchEventDrivenWorker_() {
  if (typeof CF === 'undefined' || !CF.EventDrivenServiceAutomation || typeof CF.EventDrivenServiceAutomation.worker !== 'function') return false;
  if (CF.EventDrivenServiceAutomation.__CFH_512_PATCHED) return true;

  var baseWorker = CF.EventDrivenServiceAutomation.worker;
  var baseKick = typeof CF.EventDrivenServiceAutomation.kick === 'function' ? CF.EventDrivenServiceAutomation.kick : null;
  CF.EventDrivenServiceAutomation.__CFH_BASE_WORKER = baseWorker;
  CF.EventDrivenServiceAutomation.__CFH_BASE_KICK = baseKick;

  if (baseKick) {
    CF.EventDrivenServiceAutomation.kick = function (requestId) {
      var result = baseKick.apply(this, arguments);
      try {
        var work = typeof CF.EventDrivenServiceAutomation.describeQueuedWork === 'function' ? CF.EventDrivenServiceAutomation.describeQueuedWork() : {};
        var handler = CFH_clean_(work && work.recommendedHandler) || 'AUTO_00_E2E_Route_Request';
        CFH_cancelFutureAutomationTriggers_('');
        ScriptApp.newTrigger(handler).timeBased().after(CFH_FAST_TRIGGER_DELAY_MS).create();
        result = result && typeof result === 'object' ? result : { ok: true };
        result.hardeningFastKick = { handler: handler, minimumDelayMs: CFH_FAST_TRIGGER_DELAY_MS };
      } catch (ignoredFastKick) {}
      return result;
    };
  }

  CF.EventDrivenServiceAutomation.worker = function (e, invocation) {
    e = e || {};
    var started = Date.now();
    var durableContinuations = 0;
    var lastResult = null;
    var outermost = CFH_RUNTIME.workerDepth === 0;

    CFH_RUNTIME.workerDepth++;
    if (outermost) {
      CFH_RUNTIME.deferQueueRefresh = true;
      CFH_RUNTIME.queueRefreshPending = false;
    }

    try {
      while (Date.now() - started < CFH_CHAIN_SOFT_BUDGET_MS) {
        var q = CFH_queue_();
        if (!q.length) {
          return lastResult || { ok: true, version: CFH_VERSION, status: 'IDLE_NO_QUEUED_INCOMING_REQUESTS', liveWriteExecuted: false };
        }

        var requestId = q[0];
        var before = CFH_request_(requestId);
        if (!before) {
          CFH_dequeue_(requestId);
          continue;
        }

        if (CFH_isDurableSalesOrder_(before)) {
          CFH_normalizeDurableSalesOrder_(before, 'PRE_WORKER_DURABLE_GUARD');
          CFH_dequeue_(requestId);
          CFH_cancelFutureAutomationTriggers_(e.triggerUid);
          lastResult = CFH_durableResult_(before, 'SALES_ORDER_ALREADY_DURABLE_MANUAL_REVIEW');
          durableContinuations++;
          if (durableContinuations >= CFH_MAX_DURABLE_CONTINUATIONS) break;
          continue;
        }

        var result;
        try {
          result = baseWorker.call(this, e, invocation);
        } catch (error) {
          var afterError = CFH_request_(requestId);
          if (CFH_isDurableSalesOrder_(afterError)) {
            CFH_normalizeDurableSalesOrder_(afterError, 'POSTWRITE_EXCEPTION_RECOVERED');
            CFH_dequeue_(requestId);
            CFH_cancelFutureAutomationTriggers_(e.triggerUid);
            lastResult = CFH_durableResult_(afterError, 'SALES_ORDER_DURABLE_POSTWRITE_EXCEPTION_RECOVERED');
            lastResult.hardening.originalError = String(error && error.message || error);
            durableContinuations++;
            if (durableContinuations >= CFH_MAX_DURABLE_CONTINUATIONS) break;
            continue;
          }
          throw error;
        }

        var after = CFH_request_(requestId);
        if (CFH_isDurableSalesOrder_(after)) {
          CFH_normalizeDurableSalesOrder_(after, 'POST_WORKER_DURABLE_GUARD');
          CFH_dequeue_(requestId);
          CFH_cancelFutureAutomationTriggers_(e.triggerUid);

          if (!result || typeof result !== 'object' || !CFH_clean_(result.status)) {
            result = CFH_durableResult_(after, 'SALES_ORDER_CREATED_VERIFIED_MANUAL_REVIEW');
          } else {
            result.hardening = result.hardening || {};
            result.hardening.durableBoundaryConfirmed = true;
          }

          lastResult = result;
          durableContinuations++;
          if (durableContinuations >= CFH_MAX_DURABLE_CONTINUATIONS) break;
          continue;
        }

        var resultStatus = CFH_upper_(result && result.status);
        if ((resultStatus === 'SALES_ORDER_OPERATIONAL_REFRESH_RERUN' || resultStatus === 'OPERATIONAL_CACHE_REFRESHED_RERUN_REQUIRED') &&
            !(result && result.liveWriteExecuted === true)) {
          // Operational refresh is read-only. Continue immediately instead of paying
          // another Apps Script one-shot trigger delay.
          CFH_cancelFutureAutomationTriggers_(e.triggerUid);
          lastResult = result;
          continue;
        }

        // Do not cross uncertain or non-durable write boundaries inline.
        return result;
      }

      var remaining = CFH_queue_();
      if (remaining.length) {
        var fallback = CFH_scheduleFallbackForQueue_();
        if (lastResult && typeof lastResult === 'object') lastResult.nextTrigger = fallback;
      }
      return lastResult || { ok: true, version: CFH_VERSION, status: 'HARDENING_SOFT_BUDGET_REACHED', liveWriteExecuted: false };
    } finally {
      CFH_RUNTIME.workerDepth--;
      if (outermost) {
        CFH_RUNTIME.deferQueueRefresh = false;
        if (CFH_RUNTIME.queueRefreshPending) CFH_scheduleOperatorQueueRefresh_();
        CFH_RUNTIME.queueRefreshPending = false;
      }
    }
  };

  CF.EventDrivenServiceAutomation.__CFH_512_PATCHED = true;
  return true;
}

function CFH_applyRuntimePatches_() {
  if (typeof CF === 'undefined') return { ok: false, status: 'CF_NOT_READY' };

  var out = {
    customerContactInfoSync: CFH_patchCustomerContactInfoSync_(),
    operatorQueue: CFH_patchOperatorQueue_(),
    matching: CFH_patchMatching_(),
    eventDrivenWorker: CFH_patchEventDrivenWorker_()
  };
  CFH_RUNTIME.installedAtRuntime = true;
  return { ok: true, version: CFH_VERSION, patches: out };
}

function CFH_removeLegacyBatchMatchingTriggers_() {
  var removed = [];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    try {
      var handler = CFH_clean_(t.getHandlerFunction && t.getHandlerFunction());
      if (handler === 'MATCH_processAll') {
        removed.push({ handler: handler, uid: CFH_clean_(t.getUniqueId && t.getUniqueId()) });
        ScriptApp.deleteTrigger(t);
      }
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
        removed++;
      }
    } catch (ignored) {}
  });

  ScriptApp.newTrigger(CFH_OPERATIONAL_HANDLER).timeBased().everyMinutes(10).create();
  return { removedExisting: removed, installed: true, cadenceMinutes: 10 };
}

function CFH_operationalCacheAgeMs_() {
  try {
    if (typeof CF === 'undefined' || !CF.Util) return Infinity;
    var ss = typeof CF.Util.getSpreadsheet === 'function' ? CF.Util.getSpreadsheet() : SpreadsheetApp.getActiveSpreadsheet();
    var name = '06 Striven Operational Data';
    try {
      if (CF.Config && typeof CF.Config.getSheetName === 'function') name = CF.Config.getSheetName('STRIVEN_OPERATIONAL_DATA') || name;
    } catch (ignoredName) {}
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return Infinity;
    var value = sh.getRange(2, 1).getValue();
    var ms = CFH_recentDateMs_(value);
    return ms ? Date.now() - ms : Infinity;
  } catch (ignored) {
    return Infinity;
  }
}

function CFH_refreshOperationalCacheIfIdle() {
  CFH_applyRuntimePatches_();

  var q = CFH_queue_();
  if (q.length) {
    return { ok: true, version: CFH_VERSION, status: 'SKIPPED_QUEUE_ACTIVE', queuedRequestIds: q, liveWriteExecuted: false };
  }

  var ageMs = CFH_operationalCacheAgeMs_();
  if (ageMs < CFH_OPERATIONAL_REFRESH_MIN_AGE_MS) {
    return { ok: true, version: CFH_VERSION, status: 'SKIPPED_OPERATIONAL_CACHE_FRESH', ageMinutes: Math.round(ageMs / 60000), liveWriteExecuted: false };
  }

  if (typeof CF === 'undefined' || !CF.StrivenData || typeof CF.StrivenData.refreshOperationalData !== 'function') {
    return { ok: false, version: CFH_VERSION, status: 'STRIVEN_OPERATIONAL_REFRESH_UNAVAILABLE', liveWriteExecuted: false };
  }

  var started = Date.now();
  var result = CF.StrivenData.refreshOperationalData({});
  return {
    ok: !result || result.ok !== false,
    version: CFH_VERSION,
    status: 'OPERATIONAL_CACHE_REFRESHED_WHILE_IDLE',
    durationMs: Date.now() - started,
    result: result,
    liveWriteExecuted: false
  };
}

function CFH_repairAutomationDurableRows_() {
  var repaired = [];
  CFH_serviceRows_().forEach(function (row) {
    if (!CFH_isAutomationCreatedQuoted_(row)) return;
    var needsRepair = CFH_shouldNormalizeDurableSalesOrder_(row) && (
      CFH_upper_(row['Current Stage']) !== 'NEEDS REVIEW' ||
      CFH_upper_(row['Manual Review?']) !== 'YES' ||
      CFH_upper_(row['Next Action']) !== 'MANUAL REVIEW SALES ORDER'
    );
    var changed = needsRepair ? CFH_normalizeDurableSalesOrder_(row, 'INSTALLER_DURABLE_REPAIR') : false;
    try { CFH_dequeue_(row['Request ID']); } catch (ignoredDequeue) {}
    if (changed) {
      repaired.push({
        requestId: CFH_clean_(row['Request ID']),
        workOrderId: CFH_clean_(row['Work Order ID']),
        workOrderNumber: CFH_clean_(row['Work Order Number'])
      });
    }
  });
  return repaired;
}

function CFH_purgeDurableQueue_() {
  var before = CFH_queue_();
  var removed = [];
  var kept = [];

  before.forEach(function (requestId) {
    var row = CFH_request_(requestId);
    if (CFH_isDurableSalesOrder_(row)) {
      CFH_normalizeDurableSalesOrder_(row, 'INSTALLER_QUEUE_DURABLE_GUARD');
      removed.push({
        requestId: CFH_clean_(requestId),
        workOrderId: CFH_clean_(row && row['Work Order ID']),
        workOrderNumber: CFH_clean_(row && row['Work Order Number']),
        workOrderStatus: CFH_clean_(row && row['Work Order Status'])
      });
    } else {
      kept.push(requestId);
    }
  });

  CFH_mutateQueue_(function () { return kept; });
  return { before: before, removedDurable: removed, remaining: kept };
}

function CFH_installProductionHardening() {
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Another CF ServiceOps execution is already running.');
  try {
    var priorItem = CFH_clean_(props.getProperty(CFH_STANDARD_ITEM_PROP));
    if (priorItem && priorItem !== CFH_STANDARD_ITEM_ID) {
      throw new Error(CFH_STANDARD_ITEM_PROP + ' has unexpected value ' + priorItem + '; refusing to overwrite.');
    }
    props.setProperty(CFH_STANDARD_ITEM_PROP, CFH_STANDARD_ITEM_ID);
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }

  var patches = CFH_applyRuntimePatches_();
  var legacyRemoved = CFH_removeLegacyBatchMatchingTriggers_();
  var maintenance = CFH_installOperationalMaintenanceTrigger_();
  var durableRepaired = CFH_repairAutomationDurableRows_();
  var durableQueuePurge = CFH_purgeDurableQueue_();

  // Remove stale phase/recovery triggers created before this hardening layer.
  var staleAutomationTriggersRemoved = CFH_cancelFutureAutomationTriggers_('');
  var resumedQueue = durableQueuePurge.remaining.length ? CFH_scheduleFallbackForQueue_() : { ok: true, scheduled: false, reason: 'NO_NON_DURABLE_QUEUE' };
  var deferredQueueRefresh = CFH_scheduleOperatorQueueRefresh_();

  return {
    ok: true,
    version: CFH_VERSION,
    status: 'PRODUCTION_HARDENING_INSTALLED',
    standardServiceItemId: props.getProperty(CFH_STANDARD_ITEM_PROP),
    earlyBirdServiceItemIdPreserved: CFH_clean_(props.getProperty('STRIVEN_SERVICE_ITEM_ID')),
    patches: patches,
    removedLegacyMatchingTriggers: legacyRemoved,
    operationalMaintenance: maintenance,
    durableRowsRepaired: durableRepaired,
    durableQueuePurge: durableQueuePurge,
    staleAutomationTriggersRemoved: staleAutomationTriggersRemoved,
    resumedNonDurableQueue: resumedQueue,
    deferredQueueRefresh: deferredQueueRefresh,
    infoSyncCacheMinutes: CFH_SYNC_CACHE_MS / 60000,
    fastOneShotMinimumDelayMs: CFH_FAST_TRIGGER_DELAY_MS,
    sameExecutionDurableContinuationLimit: CFH_MAX_DURABLE_CONTINUATIONS,
    workerSoftBudgetSeconds: CFH_CHAIN_SOFT_BUDGET_MS / 1000,
    field694Policy: 'SAFE_NON_BLOCKING_SKIP_AND_REQUEST_SCOPED_CACHE; NO VALUE INVENTED'
  };
}

function CFH_selfTestProductionHardening() {
  var props = PropertiesService.getScriptProperties();
  var matchTriggers = 0;
  var maintenanceTriggers = 0;
  var deferredQueueRefreshTriggers = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    try {
      var h = CFH_clean_(t.getHandlerFunction && t.getHandlerFunction());
      if (h === 'MATCH_processAll') matchTriggers++;
      if (h === CFH_OPERATIONAL_HANDLER) maintenanceTriggers++;
      if (h === CFH_QUEUE_REFRESH_HANDLER) deferredQueueRefreshTriggers++;
    } catch (ignored) {}
  });

  var durableRegressions = [];
  CFH_serviceRows_().forEach(function (row) {
    if (!CFH_isAutomationCreatedQuoted_(row) || !CFH_shouldNormalizeDurableSalesOrder_(row)) return;
    if (CFH_upper_(row['Current Stage']) !== 'NEEDS REVIEW' || CFH_upper_(row['Manual Review?']) !== 'YES') {
      durableRegressions.push({
        requestId: CFH_clean_(row['Request ID']),
        workOrderId: CFH_clean_(row['Work Order ID']),
        stage: CFH_clean_(row['Current Stage']),
        manualReview: CFH_clean_(row['Manual Review?'])
      });
    }
  });

  return {
    ok: props.getProperty(CFH_STANDARD_ITEM_PROP) === CFH_STANDARD_ITEM_ID && matchTriggers === 0 && maintenanceTriggers === 1 && durableRegressions.length === 0,
    version: CFH_VERSION,
    standardServiceItemId: props.getProperty(CFH_STANDARD_ITEM_PROP),
    earlyBirdServiceItemId: props.getProperty('STRIVEN_SERVICE_ITEM_ID'),
    runtimePatched: !!CFH_RUNTIME.installedAtRuntime,
    customerContactInfoSyncPatched: !!(typeof CF !== 'undefined' && CF.CustomerContactInfoSync && CF.CustomerContactInfoSync.__CFH_512_PATCHED),
    operatorQueuePatched: !!(typeof CF !== 'undefined' && CF.OperatorQueue && CF.OperatorQueue.__CFH_512_PATCHED),
    matchingPatched: !!(typeof CF !== 'undefined' && CF.Matching && CF.Matching.__CFH_512_PATCHED),
    eventDrivenWorkerPatched: !!(typeof CF !== 'undefined' && CF.EventDrivenServiceAutomation && CF.EventDrivenServiceAutomation.__CFH_512_PATCHED),
    fastKickPatched: !!(typeof CF !== 'undefined' && CF.EventDrivenServiceAutomation && CF.EventDrivenServiceAutomation.__CFH_BASE_KICK),
    legacyMatchProcessAllTriggers: matchTriggers,
    operationalMaintenanceTriggers: maintenanceTriggers,
    deferredQueueRefreshTriggers: deferredQueueRefreshTriggers,
    operationalCacheAgeMinutes: Math.round(CFH_operationalCacheAgeMs_() / 60000),
    queuedRequestIds: CFH_queue_(),
    durableRegressions: durableRegressions,
    field694Policy: 'NON_BLOCKING; NO UNSUPPORTED CUSTOMER VALUE WRITTEN'
  };
}

function CFH_installAndVerifyProductionHardening() {
  var install = CFH_installProductionHardening();
  try { SpreadsheetApp.flush(); } catch (ignoredFlush) {}
  var selfTest = CFH_selfTestProductionHardening();
  if (!selfTest.ok) {
    throw new Error('CFH_INSTALL_VERIFY_FAILED: ' + JSON.stringify({
      legacyMatchProcessAllTriggers: selfTest.legacyMatchProcessAllTriggers,
      operationalMaintenanceTriggers: selfTest.operationalMaintenanceTriggers,
      durableRegressions: selfTest.durableRegressions,
      standardServiceItemId: selfTest.standardServiceItemId
    }));
  }
  return {
    ok: true,
    version: CFH_VERSION,
    status: 'PRODUCTION_HARDENING_INSTALLED_AND_VERIFIED',
    install: install,
    selfTest: selfTest
  };
}

// Numbered 99_ file is intentionally last in the project. Apply lightweight runtime
// wrappers on every Apps Script execution so existing public runners benefit without
// changing their names or deployment URLs.
try {
  CFH_applyRuntimePatches_();
} catch (CFH_bootError) {
  try { console.error('CFH bootstrap: ' + String(CFH_bootError && CFH_bootError.message || CFH_bootError)); } catch (ignoredConsole) {}
}
