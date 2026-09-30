/* CF_SERVICEOPS_V5_13_9_REQUEST_ID_INTEGRITY_FALSE_PARK_RECOVERY_R1 */
/* CF_SERVICEOPS_V5_13_6_EXECUTABLE_LOCATION_STAGE_R1 */
/* CF_SERVICEOPS_V5_13_3_WORKFLOW_API_BRAKE_R1 */
/* CF_SERVICEOPS_V5_13_2_STABILIZATION_R1_WORKFLOW */
/************************************************************
 * APPS SCRIPT — 70_Workflow_Automation.gs
 * CF ServiceOps — Workflow Automation
 * Layout consolidation: v5.8.6
 *
 * This categorical file contains workflow orchestration.
 ************************************************************/

/************************************************************
 * ===== CONSOLIDATED SOURCE: 64_Auto_Customer_Structure.gs =====
 * Layout consolidation only. Original module body follows unchanged.
 ************************************************************/
/************************************************************
 * APPS SCRIPT — 64_Auto_Customer_Structure.gs
 * CF ServiceOps — Automatic Customer Structure Orchestrator
 * Version: 5.8.5
 *
 * PURPOSE
 * - Automatically advances NEW requests through fresh-cache matching.
 * - Automatically executes only green Customer/Contact structure steps.
 * - Stops before Sales Order / Work Order creation.
 * - Stops on review, duplicate risk, ambiguity, uncertain writes, or
 *   standalone Location creation for an existing Customer.
 * - Processes at most one Striven mutation per trigger execution.
 * - Applies only to requests created after automation installation.
 ************************************************************/
var CF = CF || {};

CF.AutoCustomerStructure = (function () {
  'use strict';

  var MODULE_NAME = '64_Auto_Customer_Structure';
  var VERSION = '5.8.5';
  var TRIGGER_HANDLER = 'AUTO_processCustomerStructure';
  var REQUIRED_TRIGGER_SCOPE = 'https://www.googleapis.com/auth/script.scriptapp';
  var CUTOFF_PROPERTY = 'CF_AUTO_CUSTOMER_STRUCTURE_CUTOFF_MS';
  var CACHE_MAX_AGE_MINUTES = 240; // v5.11.0 initial matching freshness only; pre-write Customer duplicate guard remains 15 minutes in 60_Striven_Write.gs
  var LEASE_CACHE_KEY = 'CF_AUTO_CUSTOMER_STRUCTURE_LEASE';
  var LEASE_SECONDS = 360;

  function deps_() {
    if (!CF.Config || !CF.Util || !CF.StrivenData || !CF.Matching ||
        !CF.StrivenControlledCustomerCreate || !CF.StrivenControlledContactCreate) {
      throw new Error('AUTO_SETUP_REQUIRED | Config, Util, StrivenData, Matching, Customer Create and Contact Create modules are required.');
    }
    return {
      config: CF.Config,
      util: CF.Util,
      data: CF.StrivenData,
      matching: CF.Matching,
      customer: CF.StrivenControlledCustomerCreate,
      contact: CF.StrivenControlledContactCreate
    };
  }

  function clean_(value) { return deps_().util.cleanText(value); }
  function upper_(value) { return clean_(value).toUpperCase(); }

  function cutoffMs_() {
    var raw = PropertiesService.getScriptProperties().getProperty(CUTOFF_PROPERTY);
    var value = Number(raw || 0);
    return isNaN(value) ? 0 : value;
  }

  function dateMs_(value) {
    if (!value) return 0;
    if (value instanceof Date) return isNaN(value.getTime()) ? 0 : value.getTime();
    var text = clean_(value);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
      try {
        return Utilities.parseDate(text, deps_().config.getTimezone(), 'yyyy-MM-dd HH:mm:ss').getTime();
      } catch (ignored) {}
    }
    var date = new Date(text);
    return isNaN(date.getTime()) ? 0 : date.getTime();
  }

  function isAfterCutoff_(row, cutoff) {
    if (!cutoff) return false;
    var created = dateMs_(row['Created At'] || row['Submitted At']);
    return created >= cutoff;
  }

  function active_(row) {
    var d = deps_();
    return !d.config.isTerminalState(row['Current Stage']) && !d.config.isTerminalState(row['Final Outcome']);
  }

  function green_(row) {
    if (!active_(row)) return false;
    if (upper_(row['Manual Review?']) === 'YES') return false;
    if (upper_(row['Duplicate Risk Status']) !== 'NONE') return false;
    if (['BLOCKED','DUPLICATE','CANCELLED','ERROR'].indexOf(upper_(row['Request Status'])) !== -1) return false;
    return true;
  }

  function cacheTimestamp_(sheetKey) {
    var d = deps_();
    var sheet = d.util.requireSheet(sheetKey);
    if (sheet.getLastRow() < 2) return null;
    var map = d.util.getHeaderMap(sheet);
    var column = map['Cache Updated At'];
    if (!column) return null;
    var value = sheet.getRange(2, column).getValue();
    if (!value) return null;
    var date = value instanceof Date ? value : new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  function ttlMinutes_(propertyName,defaultValue){try{var raw=PropertiesService.getScriptProperties().getProperty(propertyName),n=Number(raw),floor=Number(defaultValue);if(!isFinite(floor)||floor<1)floor=1;return isFinite(n)&&n>floor?n:floor;}catch(e){return Number(defaultValue)||1;}}
  function cacheFresh_(sheetKey,maxAgeMinutes) {
    var timestamp=cacheTimestamp_(sheetKey);
    return !!timestamp&&(Date.now()-timestamp.getTime())<=Number(maxAgeMinutes||120)*60000;
  }

  function freshness_() {
    var customerTtl=ttlMinutes_('CF_SERVICEOPS_TTL_CUSTOMER_MINUTES',120);
    var locationTtl=ttlMinutes_('CF_SERVICEOPS_TTL_LOCATION_MINUTES',120);
    var operationalTtl=ttlMinutes_('CF_SERVICEOPS_TTL_OPERATIONAL_MINUTES',60);
    return {
      maxAgeMinutes:customerTtl,ttlMinutes:{customer:customerTtl,location:locationTtl,operational:operationalTtl},
      customer:{fresh:cacheFresh_('STRIVEN_CUSTOMER_DATA',customerTtl),timestamp:cacheTimestamp_('STRIVEN_CUSTOMER_DATA'),maxAgeMinutes:customerTtl},
      location:{fresh:cacheFresh_('STRIVEN_LOCATION_DATA',locationTtl),timestamp:cacheTimestamp_('STRIVEN_LOCATION_DATA'),maxAgeMinutes:locationTtl},
      operational:{fresh:cacheFresh_('STRIVEN_OPERATIONAL_DATA',operationalTtl),timestamp:cacheTimestamp_('STRIVEN_OPERATIONAL_DATA'),maxAgeMinutes:operationalTtl}
    };
  }

  function triggers_() {
    return ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === TRIGGER_HANDLER;
    });
  }

  function triggerInspection_() {
    try {
      var existing = triggers_();
      return { authorized: true, count: existing.length, error: '' };
    } catch (error) {
      var message = error && error.message ? error.message : String(error);
      if (message.indexOf('script.scriptapp') !== -1 || /permissions are not sufficient/i.test(message)) {
        return { authorized: false, count: null, error: message };
      }
      throw error;
    }
  }

  function install() {
    var d=deps_(),props=PropertiesService.getScriptProperties(),cutoff=cutoffMs_();
    if(!cutoff){cutoff=Date.now();props.setProperty(CUTOFF_PROPERTY,String(cutoff));}
    var existing=triggers_(),removed=0; existing.forEach(function(t){try{ScriptApp.deleteTrigger(t);removed++;}catch(e){}});
    var result={ok:true,version:VERSION,status:'LEGACY_PERMANENT_CADENCE_DISABLED',handler:TRIGGER_HANDLER,cadence:'NO_PERMANENT_CADENCE',removedLegacyHandlerTriggers:removed,cutoffMs:cutoff,scope:'REQUEST_DRIVEN_ONE_SHOT_ONLY',stopsBeforeSalesOrder:true};
    d.util.logEvent({module:MODULE_NAME,action:'INSTALL',status:result.status,details:result,version:VERSION});
    return result;
  }

  function uninstall() {
    var d = deps_();
    var existing = triggers_();
    existing.forEach(function (trigger) { ScriptApp.deleteTrigger(trigger); });
    PropertiesService.getScriptProperties().deleteProperty(CUTOFF_PROPERTY);
    var result = { ok: true, version: VERSION, status: 'AUTOMATION_REMOVED', removedTriggers: existing.length };
    d.util.logEvent({ module: MODULE_NAME, action: 'UNINSTALL', status: result.status, details: result, version: VERSION });
    return result;
  }

  function acquireLease_() {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return '';
    try {
      var cache = CacheService.getScriptCache();
      if (cache.get(LEASE_CACHE_KEY)) return '';
      var token = Utilities.getUuid();
      cache.put(LEASE_CACHE_KEY, token, LEASE_SECONDS);
      return token;
    } finally {
      lock.releaseLock();
    }
  }

  function releaseLease_(token) {
    if (!token) return;
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return;
    try {
      var cache = CacheService.getScriptCache();
      if (cache.get(LEASE_CACHE_KEY) === token) cache.remove(LEASE_CACHE_KEY);
    } finally {
      lock.releaseLock();
    }
  }

  // CF_SERVICEOPS_V5_10_13_RUNTIME_MATCHING_SO_NOTES_QUEUE_R1
  // Queue/Dashboard rendering is intentionally moved out of the transaction
  // execution. It is useful presentation work but not allowed to consume the
  // mutation execution budget.
  function refreshQueue_(){
    return{ok:true,deferred:true,scheduled:false,reason:'QUEUE_SNAPSHOT_WAITING_FOR_TRANSACTION_BOUNDARY'};
  }

  function stageCounts_(rows) {
    var counts = {};
    rows.forEach(function (row) {
      var stage = clean_(row['Current Stage']) || 'BLANK';
      counts[stage] = (counts[stage] || 0) + 1;
    });
    return counts;
  }

  function eligibleRows_(requestIds) {
    var d = deps_();
    var cutoff = cutoffMs_();
    if (!cutoff) return [];
    var targetedProvided = Array.isArray(requestIds);
    var targeted = {};
    (requestIds || []).forEach(function (requestId) {
      var id = clean_(requestId);
      if (id) targeted[id] = true;
    });
    return d.util.readRecords('SERVICE_REQUESTS').filter(function (row) {
      if (targetedProvided && !targeted[clean_(row['Request ID'])]) return false;
      return isAfterCutoff_(row, cutoff) && active_(row);
    });
  }

  
  /* CF_SERVICEOPS_V5_10_36_RECOVER_BLOCKED_DUPLICATE_CONTACT_R1 */
  function recoverableBlockedDuplicateContact_(row) {
    if(String(clean_(row&&row['Current Stage'])).toUpperCase()!=='READY FOR CONTACT CREATE') return false;
    if(String(clean_(row&&row['Request Status'])).toUpperCase()!=='BLOCKED') return false;
    if(String(clean_(row&&row['Manual Review?'])).toUpperCase()==='YES') return false;
    if(String(clean_(row&&row['Duplicate Risk Status'])).toUpperCase()!=='NONE') return false;
    var root={};
    try{root=deps_().util.parseJson?deps_().util.parseJson(row['Write Journal JSON'],{}):JSON.parse(String(row['Write Journal JSON']||'{}'));}catch(e){root={};}
    var cj=root&&root.contactCreate||{};
    var text=[cj.status,cj.postError,row['Blocking Issue'],row['Striven Sync Error']].join(' ');
    return /Duplicate contact has been found/i.test(text)&&/(?:Contact\s*ID|ContactID)\s*[:#]?\s*\d+/i.test(text);
  }

function nextCandidate_(rows) {
    var priorities = {
      'CREATING CUSTOMER STRUCTURE': 1,
      'READY FOR CUSTOMER CREATE': 2,
      'READY FOR LOCATION CREATE': 3,
      'READY FOR CONTACT CREATE': 4,
      'CUSTOMER RESOLVED': 5
    };
    var candidates = rows.filter(function (row) {
      return (green_(row) || recoverableBlockedDuplicateContact_(row)) && priorities[upper_(row['Current Stage'])];
    });
    candidates.sort(function (a, b) {
      var pa = priorities[upper_(a['Current Stage'])] || 99;
      var pb = priorities[upper_(b['Current Stage'])] || 99;
      if (pa !== pb) return pa - pb;
      return dateMs_(a['Created At'] || a['Submitted At']) - dateMs_(b['Created At'] || b['Submitted At']);
    });
    return candidates.length ? candidates[0] : null;
  }

  function finalizeResolved_(record, reason) {
    var d = deps_();
    var customerId = clean_(record['Matched Customer ID'] || record['Created Customer ID']);
    var contactId = clean_(record['Matched Contact ID'] || record['Created Contact ID']);
    var locationId = clean_(record['Matched Location ID'] || record['Created Location ID']);
    if (!customerId || !contactId || !locationId) {
      return { ok: false, status: 'RESOLVED_STRUCTURE_IDS_INCOMPLETE', requestId: clean_(record['Request ID']), liveWriteExecuted: false };
    }
    d.util.patchRow('SERVICE_REQUESTS', record.__rowNumber, {
      'Updated At': d.util.nowString(),
      'Current Stage': 'CUSTOMER STRUCTURE COMPLETE',
      'Request Status': 'OPEN',
      'Manual Review?': 'NO',
      'Manual Review Reason': '',
      'Blocking Issue': '',
      'Next Action': 'CONTINUE TO WORK ORDER',
      'Customer Structure Status': 'COMPLETE',
      'Contact Association Status': clean_(record['Contact Association Status']) || 'ASSOCIATED',
      'Striven Sync Status': 'PARTIAL',
      'Striven Sync Error': '',
      'Reconciliation Status': reason || 'CUSTOMER STRUCTURE RESOLVED FROM EXISTING STRIVEN DATA'
    });
    return {
      ok: true,
      status: 'CUSTOMER_STRUCTURE_COMPLETE_NO_WRITE',
      requestId: clean_(record['Request ID']),
      matchedCustomerId: customerId,
      matchedContactId: contactId,
      matchedLocationId: locationId,
      liveWriteExecuted: false
    };
  }

  function refreshOneMatchingCacheIfNeeded_() {
    var d = deps_();
    var before = freshness_();
    if (!before.customer.fresh) {
      var customer = d.data.refreshCustomerData({});
      return { refreshed: true, group: 'CUSTOMER', result: customer, freshness: freshness_() };
    }
    if (!before.location.fresh) {
      var location = d.data.refreshLocationData({});
      return { refreshed: true, group: 'LOCATION', result: location, freshness: freshness_() };
    }
    // v5.11.0: Operational data is intentionally NOT refreshed during initial matching.
    // The guarded Sales Order preflight remains the authoritative fresh active-work safety boundary.
    return { refreshed: false, group: '', result: null, freshness: before };
  }

  function inspect() {
    var cutoff = cutoffMs_();
    var rows = eligibleRows_();
    var counts = stageCounts_(rows);
    var review = rows.filter(function (row) { return upper_(row['Manual Review?']) === 'YES' || upper_(row['Duplicate Risk Status']) !== 'NONE'; }).length;
    var unsupportedLocation = rows.filter(function (row) { return upper_(row['Current Stage']) === 'READY FOR LOCATION CREATE' && green_(row); }).length;
    var candidate = nextCandidate_(rows);
    var triggerState = triggerInspection_();
    return {
      ok: true,
      version: VERSION,
      installed: triggerState.authorized && triggerState.count === 1 && !!cutoff,
      triggerAccessAuthorized: triggerState.authorized,
      triggerCount: triggerState.count,
      requiredOAuthScope: REQUIRED_TRIGGER_SCOPE,
      triggerInspectionError: triggerState.error,
      cadenceMinutes: 5,
      cutoffMs: cutoff,
      cutoff: cutoff ? new Date(cutoff) : null,
      eligibleRequestCount: rows.length,
      stageCounts: counts,
      reviewOrRiskCount: review,
      unsupportedLocationCreateCount: unsupportedLocation,
      freshness: freshness_(),
      nextCandidate: candidate ? { requestId: clean_(candidate['Request ID']), stage: clean_(candidate['Current Stage']) } : null,
      stopsBeforeSalesOrder: true
    };
  }



  /* CF_SERVICEOPS_V5_10_12_ATOMIC_REQUEST_SCOPED_END_TO_END_R1 */
  function processRequest(requestId) {
    var d = deps_();
    requestId = clean_(requestId);
    if (!requestId) return { ok:false, version:VERSION, status:'REQUEST_ID_REQUIRED', requestScoped:true, liveWriteExecuted:false };
    var lease = acquireLease_();
    if (!lease) return { ok:true, version:VERSION, status:'SKIPPED_ALREADY_RUNNING', requestId:requestId, requestScoped:true, liveWriteExecuted:false };
    var started = Date.now();
    try {
      var record = d.util.findRecord('SERVICE_REQUESTS','Request ID',requestId);
      if (!record) return { ok:false, version:VERSION, status:'REQUEST_NOT_FOUND', requestId:requestId, requestScoped:true, liveWriteExecuted:false };
      if (!active_(record)) return { ok:true, version:VERSION, status:'REQUEST_NOT_ACTIVE', requestId:requestId, requestScoped:true, stage:clean_(record['Current Stage']), liveWriteExecuted:false };
      var stage = upper_(record['Current Stage']);
      if (stage === 'NEW INTAKE') {
        var refresh = refreshOneMatchingCacheIfNeeded_();
        if (refresh.refreshed) { refreshQueue_(); return { ok:true, version:VERSION, status:'MATCHING_CACHE_REFRESHED', requestId:requestId, requestScoped:true, refreshedGroup:refresh.group, liveWriteExecuted:false, durationMs:Date.now()-started }; }
        var matching = d.matching.recheckRequest(requestId,{persist:true});
        refreshQueue_();
        return { ok:matching&&matching.ok!==false, version:VERSION, status:'MATCHING_PROCESSED', requestId:requestId, requestScoped:true, matching:matching, liveWriteExecuted:false, durationMs:Date.now()-started };
      }
      if (stage === 'CUSTOMER STRUCTURE COMPLETE') return { ok:true, version:VERSION, status:'CUSTOMER_STRUCTURE_ALREADY_COMPLETE', requestId:requestId, requestScoped:true, liveWriteExecuted:false, durationMs:Date.now()-started };
      if (stage === 'READY FOR LOCATION CREATE') {
        if(!CF.StandaloneLocationCreateV5128||typeof CF.StandaloneLocationCreateV5128.process!=='function')return{ok:false,version:VERSION,status:'STANDALONE_LOCATION_MODULE_MISSING',requestId:requestId,requestScoped:true,liveWriteExecuted:false,durationMs:Date.now()-started};
        var locationStep=CF.StandaloneLocationCreateV5128.process(requestId,{autoMode:true});
        refreshQueue_();
        return{ok:locationStep&&locationStep.ok!==false,version:VERSION,status:'AUTO_STEP_COMPLETE',requestId:requestId,requestScoped:true,stageBefore:stage,stepResult:locationStep,liveWriteExecuted:!!(locationStep&&locationStep.liveWriteExecuted===true),durationMs:Date.now()-started,stopsBeforeSalesOrder:true};
      }
      if (!green_(record)) return { ok:true, version:VERSION, status:'WAITING_FOR_OPERATOR_REVIEW', requestId:requestId, requestScoped:true, stage:clean_(record['Current Stage']), liveWriteExecuted:false, durationMs:Date.now()-started };
      var customerId=clean_(record['Matched Customer ID']||record['Created Customer ID']),contactId=clean_(record['Matched Contact ID']||record['Created Contact ID']),locationId=clean_(record['Matched Location ID']||record['Created Location ID']),associationStatus=upper_(record['Contact Association Status']),result;
      if(stage==='CUSTOMER RESOLVED') result=finalizeResolved_(record,'REQUEST-SCOPED CUSTOMER STRUCTURE RESOLVED FROM EXISTING STRIVEN DATA');
      else if(stage==='READY FOR CUSTOMER CREATE') result=d.customer.executeAutoCustomerCreate(requestId);
      else if(stage==='READY FOR CONTACT CREATE') result=d.contact.executeAutoContactCreate(requestId);
      else if(stage==='CREATING CUSTOMER STRUCTURE') {
        if(!customerId||!locationId) result=d.customer.executeAutoCustomerCreate(requestId);
        else if(!contactId||associationStatus!=='ASSOCIATED') result=d.contact.executeAutoContactCreate(requestId);
        else result=finalizeResolved_(record,'REQUEST-SCOPED CUSTOMER STRUCTURE RECONCILED');
      } else result={ok:true,status:'NO_AUTOMATIC_ACTION_FOR_STAGE',requestId:requestId,stage:stage,liveWriteExecuted:false};
      refreshQueue_();
      d.util.logEvent({module:MODULE_NAME,action:'AUTO_PROCESS_REQUEST_SCOPED',status:result&&result.status?result.status:'COMPLETE',requestId:requestId,details:{requestScoped:true,stageBefore:stage,result:result},durationMs:Date.now()-started,version:VERSION});
      return {ok:result&&result.ok!==false,version:VERSION,status:'AUTO_STEP_COMPLETE',requestId:requestId,requestScoped:true,stageBefore:stage,stepResult:result,liveWriteExecuted:!!(result&&result.liveWriteExecuted),durationMs:Date.now()-started,stopsBeforeSalesOrder:true};
    } catch(error) {
      d.util.logEvent({severity:'ERROR',module:MODULE_NAME,action:'AUTO_PROCESS_REQUEST_SCOPED',status:'ERROR',requestId:requestId,message:error.message||String(error),durationMs:Date.now()-started,version:VERSION});
      throw error;
    } finally { releaseLease_(lease); }
  }

  function process(options) {
    /* CF_SERVICEOPS_V5_10_30_REQUEST_DRIVEN_ORCHESTRATION_R1 — existing targeted process retained */
    /* CF_SERVICEOPS_V5_10_29_EVENT_QUEUE_REQUEST_DRIVEN_FAST_PATH_R4 */
    options = options || {};
    /* CF_SERVICEOPS_V5_10_35_FAST_PATH_SKIP_INTERNAL_QUEUE_REBUILDS_R1 */
    var targetedRequestIds = Array.isArray(options.requestIds) ? options.requestIds.map(clean_).filter(Boolean) : null;
    var eventQueueHead = '';
    if (targetedRequestIds === null && options.disableEventQueueFastPath !== true) {
      try {
        var fastProps = PropertiesService.getScriptProperties();
        var fastEnabled = upper_(fastProps.getProperty('CF_EVENT_DRIVEN_SERVICE_AUTOMATION_ENABLED')) === 'TRUE';
        var fastRaw = fastProps.getProperty('CF_EVENT_DRIVEN_SERVICE_REQUEST_IDS');
        var fastQueue = fastRaw ? JSON.parse(fastRaw) : [];
        if (fastEnabled && Array.isArray(fastQueue) && fastQueue.length) {
          eventQueueHead = clean_(fastQueue[0]);
          if (eventQueueHead) targetedRequestIds = [eventQueueHead];
        }
      } catch (ignoredFastQueue) {}
    }
    var d = deps_();
    /* CF_SERVICEOPS_V5_10_32_FAST_PATH_TRIGGER_GATE_R1 */
    var requestDrivenFastPath = options.fastPath === true && targetedRequestIds !== null && targetedRequestIds.length > 0;
    var legacyTriggerCount = requestDrivenFastPath ? null : triggers_().length;
    if (!cutoffMs_() || (!requestDrivenFastPath && legacyTriggerCount !== 1)) {
      return { ok: false, version: VERSION, status: 'AUTOMATION_NOT_INSTALLED', requestDrivenFastPath: requestDrivenFastPath, triggerCount: legacyTriggerCount, liveWriteExecuted: false };
    }

    var lease = acquireLease_();
    if (!lease) return { ok: true, version: VERSION, status: 'SKIPPED_ALREADY_RUNNING', liveWriteExecuted: false };

    var started = Date.now();
    try {
      var rows = eligibleRows_(targetedRequestIds);
      var newIntake = rows.filter(function (row) { return upper_(row['Current Stage']) === 'NEW INTAKE'; });

      if (newIntake.length) {
        var refresh = refreshOneMatchingCacheIfNeeded_();
        if (refresh.refreshed) {
          if (!options.fastPath) refreshQueue_();
          return {
            ok: true, version: VERSION, status: 'MATCHING_CACHE_REFRESHED', refreshedGroup: refresh.group,
            newIntakeCount: newIntake.length, liveWriteExecuted: false, durationMs: Date.now() - started
          };
        }

        var targetedMatching = targetedRequestIds !== null && typeof d.matching.processRequestIds === 'function';
        var matching = targetedMatching
          ? d.matching.processRequestIds(targetedRequestIds, { refreshQueue: false, fastPath: true })
          : d.matching.processAll();

        // Preserve old manual/batch behavior. In the event-driven targeted path,
        // successful matching continues immediately into this same request's structure step.
        if (!targetedMatching || !matching || matching.ok === false) {
          if (!options.fastPath) refreshQueue_();
          return {
            ok: matching && matching.ok !== false,
            version: VERSION,
            status: 'MATCHING_PROCESSED',
            matching: matching,
            targetedFastPath: targetedMatching,
            liveWriteExecuted: false,
            durationMs: Date.now() - started
          };
        }
      }

      rows = eligibleRows_(targetedRequestIds);
      var candidate = nextCandidate_(rows);
      if (!candidate) {
        var unsupported = rows.filter(function (row) { return upper_(row['Current Stage']) === 'READY FOR LOCATION CREATE' && green_(row); });
        var blocked = rows.filter(function (row) { return !green_(row); });
        if (!options.fastPath) refreshQueue_();
        return {
          ok: true,
          version: VERSION,
          status: unsupported.length ? 'WAITING_FOR_STANDALONE_LOCATION_CONTRACT' : (blocked.length ? 'WAITING_FOR_OPERATOR_REVIEW' : 'IDLE'),
          unsupportedLocationRequestIds: unsupported.map(function (row) { return clean_(row['Request ID']); }),
          reviewRequestIds: blocked.map(function (row) { return clean_(row['Request ID']); }).slice(0, 20),
          liveWriteExecuted: false,
          durationMs: Date.now() - started
        };
      }

      var requestId = clean_(candidate['Request ID']);
      var stage = upper_(candidate['Current Stage']);
      var customerId = clean_(candidate['Matched Customer ID'] || candidate['Created Customer ID']);
      var contactId = clean_(candidate['Matched Contact ID'] || candidate['Created Contact ID']);
      var locationId = clean_(candidate['Matched Location ID'] || candidate['Created Location ID']);
      var associationStatus = upper_(candidate['Contact Association Status']);
      var result;

      if (stage === 'CUSTOMER RESOLVED') {
        result = finalizeResolved_(candidate, 'CUSTOMER STRUCTURE RESOLVED FROM EXISTING STRIVEN DATA');
      } else if (stage === 'READY FOR CUSTOMER CREATE') {
        result = d.customer.executeAutoCustomerCreate(requestId);
      } else if (stage === 'READY FOR LOCATION CREATE') {
        result = CF.StandaloneLocationCreateV5128&&typeof CF.StandaloneLocationCreateV5128.process==='function'
          ? CF.StandaloneLocationCreateV5128.process(requestId,{autoMode:true})
          : {ok:false,status:'STANDALONE_LOCATION_MODULE_MISSING',requestId:requestId,liveWriteExecuted:false};
      } else if (stage === 'READY FOR CONTACT CREATE') {
        result = d.contact.executeAutoContactCreate(requestId);
      } else if (stage === 'CREATING CUSTOMER STRUCTURE') {
        if (!customerId || !locationId) {
          result = d.customer.executeAutoCustomerCreate(requestId);
        } else if (!contactId || associationStatus !== 'ASSOCIATED') {
          result = d.contact.executeAutoContactCreate(requestId);
        } else {
          result = finalizeResolved_(candidate, 'CUSTOMER STRUCTURE RECONCILED');
        }
      } else {
        result = { ok: true, status: 'NO_AUTOMATIC_ACTION_FOR_STAGE', requestId: requestId, stage: stage, liveWriteExecuted: false };
      }

      if (!options.fastPath) refreshQueue_();
      d.util.logEvent({
        module: MODULE_NAME,
        action: 'AUTO_PROCESS',
        status: result && result.status ? result.status : 'COMPLETE',
        requestId: requestId,
        details: { stageBefore: stage, result: result },
        durationMs: Date.now() - started,
        version: VERSION
      });
      return {
        ok: result && result.ok !== false,
        version: VERSION,
        status: (targetedRequestIds !== null && result && result.liveWriteExecuted !== true && clean_(result.status) === 'CUSTOMER_STRUCTURE_COMPLETE_NO_WRITE')
          ? 'FAST_PATH_STRUCTURE_READY_FOR_SALES_ORDER'
          : 'AUTO_STEP_COMPLETE',
        targetedFastPath: targetedRequestIds !== null,
        eventQueueHead: eventQueueHead,
        requestId: requestId,
        stageBefore: stage,
        stepResult: result,
        liveWriteExecuted: !!(result && result.liveWriteExecuted),
        durationMs: Date.now() - started,
        stopsBeforeSalesOrder: true
      };
    } catch (error) {
      d.util.logEvent({ severity: 'ERROR', module: MODULE_NAME, action: 'AUTO_PROCESS', status: 'ERROR', message: error.message || String(error), durationMs: Date.now() - started, version: VERSION });
      throw error;
    } finally {
      releaseLease_(lease);
    }
  }

  return {
    version: VERSION,
    install: install,
    uninstall: uninstall,
    inspect: inspect,
    processRequest: processRequest,
    process: process
  };
})();


/* CF_SERVICEOPS_V5_10_2_SALES_ORDER_DRAFT_R1
 * Read-only Sales Order preparation layer.
 * Sources: Service/Webform Request + resolved Striven Asset at resolved Location.
 * This module never POSTs, PUTs, PATCHes or DELETEs Striven data.
 */
var CF = CF || {};
CF.SalesOrderDraft = (function () {
  'use strict';

  var VERSION = '5.10.2';
  var CUSTOM_FIELD = {
    CUSTOMER_NOTES_PRINTABLE: '598',
    MANUFACTURER_MODEL: '651',
    SERIAL_NUMBER: '650',
    PHOTO: '96',
    SCHEDULED: '164',
    SCHEDULED_DATE: '661',
    SCHEDULED_TIME: '662',
    PREFERRED_TIME: '653',
    ORDER_FULFILLMENT: '817',
    ENTER_NEW_PART_UPDATED: '820',
    REQUEST_SOURCE: '855',
    SERVICE_LEVEL: '797',
    SERVICE_TECH: '794',
    ZONE: '798',
    PARTS_FULFILLMENT: '364',
    NEEDS_PO: '815'
  };

  function clean_(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  function upper_(value) {
    return clean_(value).toUpperCase();
  }

  function normalize_(value) {
    return upper_(value).replace(/[^A-Z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();
  }

  function tokens_(value) {
    var stop = {THE:1,AND:1,WITH:1,YEAR:1,YEARS:1,OLD:1,NEW:1,ABOUT:1,APPROX:1,APPROXIMATELY:1,FIREPLACE:1,UNIT:1,GAS:1};
    return normalize_(value).split(' ').filter(function (x) { return x && x.length > 1 && !stop[x]; });
  }

  function request_(requestId) {
    return CF.Util.findRecord('SERVICE_REQUESTS', 'Request ID', requestId);
  }

  function webform_(request) {
    var requestId = clean_(request['Request ID']);
    var submissionId = clean_(request['Submission ID']);
    var row = requestId ? CF.Util.findRecord('WEBFORM_REQUESTS', 'Request ID', requestId) : null;
    if (!row && submissionId) row = CF.Util.findRecord('WEBFORM_REQUESTS', 'Submission ID', submissionId);
    return row || {};
  }

  function parseRaw_(row) {
    var raw = clean_(row['Raw Payload']);
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (ignored) { return {}; }
  }

  function resolvedCustomerId_(request) {
    return clean_(request['Matched Customer ID'] || request['Created Customer ID']);
  }

  function resolvedContactId_(request) {
    return clean_(request['Matched Contact ID'] || request['Created Contact ID']);
  }

  function resolvedLocationId_(request) {
    return clean_(request['Matched Location ID'] || request['Created Location ID']);
  }

  function assets_(customerId, locationId) {
    if (!customerId || !locationId) return [];
    return CF.Util.readRecords('STRIVEN_OPERATIONAL_DATA').filter(function (row) {
      return upper_(row['Entity Type']) === 'ASSET' &&
        clean_(row['Customer ID']) === customerId &&
        clean_(row['Location ID']) === locationId;
    });
  }

  function assetLabel_(asset) {
    return [clean_(asset['Asset Make']), clean_(asset['Asset Model'])].filter(Boolean).join(' ').trim();
  }

  function scoreAsset_(unitDetails, asset) {
    var source = tokens_(unitDetails);
    var makeModel = tokens_(assetLabel_(asset));
    if (!source.length || !makeModel.length) return 0;
    var score = 0;
    makeModel.forEach(function (token) {
      if (source.indexOf(token) !== -1) score += token.length >= 5 ? 3 : 2;
    });
    var model = normalize_(asset['Asset Model']);
    if (model && normalize_(unitDetails).indexOf(model) !== -1) score += 6;
    var make = normalize_(asset['Asset Make']);
    if (make && normalize_(unitDetails).indexOf(make) !== -1) score += 3;
    return score;
  }

  function chooseAsset_(unitDetails, assets) {
    if (!assets.length) return { status: 'NO_ASSET', selected: null, candidates: [] };
    var scored = assets.map(function (asset) {
      return { asset: asset, score: scoreAsset_(unitDetails, asset) };
    }).sort(function (a, b) { return b.score - a.score; });

    if (assets.length === 1) {
      if (!clean_(unitDetails) || scored[0].score > 0) return { status: 'SELECTED', selected: assets[0], candidates: scored };
      return { status: 'CONFLICT', selected: null, candidates: scored };
    }

    if (scored[0].score > 0 && (!scored[1] || scored[0].score > scored[1].score)) {
      return { status: 'SELECTED', selected: scored[0].asset, candidates: scored };
    }
    return { status: 'OPERATOR_REQUIRED', selected: null, candidates: scored };
  }

  function field_(id, name, value, source, status, required) {
    return {
      id: String(id),
      name: name,
      value: value === null || value === undefined ? '' : value,
      source: source || '',
      status: status || 'READY',
      required: required === true
    };
  }

  function notes_(request, raw) {
    var details = clean_(request['Service Details'] || raw.details);
    var extra = clean_(request['Additional Notes'] || raw.anything_else);
    if (!details) return extra;
    if (!extra) return details;
    return details + '\\n\\nAdditional Notes:\\n' + extra;
  }

  /* CF_SERVICEOPS_V5_10_6_SALES_ORDER_ENRICHMENT_R1
   * Bill To defaults to the resolved service Location. Service Level 1 is the
   * verified Custom List 103 item 503. Internal Notes are prepared here but
   * intentionally not sent through the direct create payload until Striven's
   * required InternalNotes API datatype/mechanism is verified.
   */
  function internalNotesDraft_(request, raw) {
    request = request || {};
    raw = raw || {};

    function plain_(value) {
      if (value === null || value === undefined) return '';

      return String(value)
        .replace(/\r\n?/g, '\n')
        .replace(/\t/g, ' ')
        .trim();
    }

    function oneLine_(value) {
      return plain_(value)
        .replace(/\n+/g, ' / ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function val_(key) {
      return oneLine_(raw[key]);
    }

    function add_(rows, label, value) {
      value = oneLine_(value);

      if (value) {
        rows.push(
          label + ': ' + value
        );
      }
    }

    var rows = [];

    var customerName = [
      val_('first_name'),
      val_('last_name')
    ]
      .filter(Boolean)
      .join(' ');

    var address = [
      val_('street'),
      val_('city'),
      val_('province'),
      val_('postal_code'),
      val_('country')
    ]
      .filter(Boolean)
      .join(', ');

    var campaign = [
      val_('campaign_code'),
      val_('campaign_name'),
      val_('campaign_year')
    ]
      .filter(Boolean)
      .join(' — ');

    add_(rows, 'Request ID', request['Request ID']);
    add_(rows, 'Submission ID', request['Submission ID']);
    add_(rows, 'Submitted', raw.submitted_at);
    add_(rows, 'Customer', customerName);
    add_(rows, 'Phone', raw.phone);
    add_(rows, 'Alt Phone', raw.alt_phone);
    add_(rows, 'Email', raw.email);
    add_(rows, 'Service Address', address);
    add_(rows, 'Preferred Days', raw.preferred_days);
    add_(rows, 'Make / Model / Age', raw.make_model_age);
    add_(rows, 'Service Details', raw.details);
    add_(rows, 'Additional Notes', raw.anything_else);
    add_(rows, 'Campaign', campaign);

    return rows.length
      ? (
          'WEBFORM SERVICE REQUEST\n\n' +
          rows.join('\n')
        )
      : '';
  }

  function attribution_(webform, raw) {
    var parsed = {};
    try { parsed = JSON.parse(clean_(webform['Attribution JSON']) || '{}'); } catch (ignored) {}
    return {
      campaignCode: clean_(webform['Campaign Code'] || raw.campaign_code),
      campaignName: clean_(parsed.campaign_name || raw.campaign_name),
      utmSource: clean_(parsed.utm_source || raw.utm_source),
      utmMedium: clean_(parsed.utm_medium || raw.utm_medium),
      referralSource: clean_(parsed.referral_source || raw.referral_source),
      trafficChannel: clean_(parsed.traffic_channel || raw.traffic_channel),
      sourceUrl: clean_(parsed.source_url || raw.source_url)
    };
  }

  function build(requestId) {
    if (!CF.Util) throw new Error('CF.Util is required.');
    var request = request_(requestId);
    if (!request) throw new Error('Service Request not found: ' + requestId);
    var webform = webform_(request);
    var raw = parseRaw_(webform);
    var customerId = resolvedCustomerId_(request);
    var contactId = resolvedContactId_(request);
    var locationId = resolvedLocationId_(request);
    var unitDetails = clean_(request['Unit Details'] || raw.make_model_age);
    var preferred = clean_(request['Preferred Days'] || raw.preferred_days);
    var assetRows = assets_(customerId, locationId);
    var assetChoice = chooseAsset_(unitDetails, assetRows);
    var selectedAsset = assetChoice.selected || {};
var assetMakeModel = assetLabel_(selectedAsset);

/*
 * Manufacturer / Model hierarchy:
 *
 * 1. A uniquely resolved Striven Asset may supply the value.
 * 2. Otherwise, the explicit Webform make/model/age is valid.
 * 3. Ambiguous asset selection must NOT invalidate a Webform value.
 * 4. Only block when neither source supplies Manufacturer / Model.
 */
/* CF_SERVICEOPS_V5_10_34_MANUFACTURER_MODEL_FALLBACK_R2 */
    var manufacturerFallbackApplied = !assetMakeModel && !unitDetails && assetChoice.status === 'NO_ASSET';
    var manufacturerModel = assetMakeModel || unitDetails || (manufacturerFallbackApplied ? 'Unknown / Not Provided' : '');
    var manufacturerSource = assetMakeModel ? 'STRIVEN_ASSET' : (unitDetails ? 'WEBFORM.make_model_age' : (manufacturerFallbackApplied ? 'SYSTEM_FALLBACK_WEBFORM_BLANK_NO_ASSET' : ''));
    var manufacturerStatus = manufacturerModel ? 'READY' : 'OPERATOR_REQUIRED';

/*
 * Asset ambiguity matters only if we actually need the asset
 * to supply Manufacturer / Model.
 *
 * If the Webform already supplied the value, keep field 651 READY.
 * The specific Asset / Serial can remain unresolved separately.
 */
if (
  !unitDetails &&
  (
    assetChoice.status === 'CONFLICT' ||
    assetChoice.status === 'OPERATOR_REQUIRED'
  )
) {
  manufacturerStatus = 'REVIEW';
}
    var serial = clean_(selectedAsset['Serial Number']);
    var att = attribution_(webform, raw);
    var internalNotesDraft = internalNotesDraft_(request, raw);

    var fields = {};
    function put(f) { fields[f.id] = f; }
    put(field_(CUSTOM_FIELD.CUSTOMER_NOTES_PRINTABLE, 'Customer Notes Printable', notes_(request, raw), 'WEBFORM.details + WEBFORM.anything_else', 'READY', false));
    put(field_(CUSTOM_FIELD.MANUFACTURER_MODEL, 'Manufacturer and Model', manufacturerModel, manufacturerSource, manufacturerStatus, true));
    put(field_(CUSTOM_FIELD.SERIAL_NUMBER, 'Serial Number', serial, serial ? 'STRIVEN_ASSET.Serial Number' : '', serial ? 'READY' : 'OPTIONAL_BLANK', false));
    put(field_(CUSTOM_FIELD.PHOTO, 'Photo Of Fireplace/Part', '', '', 'OPTIONAL_BLANK', false));
    put(field_(CUSTOM_FIELD.SCHEDULED, 'Scheduled?', 'False', 'SYSTEM_DEFAULT', 'READY', true));
    put(field_(CUSTOM_FIELD.SCHEDULED_DATE, 'Scheduled Date', '', 'SCHEDULING', 'OPTIONAL_BLANK', false));
    put(field_(CUSTOM_FIELD.SCHEDULED_TIME, 'Scheduled Time', '', 'SCHEDULING', 'OPTIONAL_BLANK', false));
    put(field_(CUSTOM_FIELD.PREFERRED_TIME, 'Preferred Time Slots', preferred, preferred ? 'WEBFORM.preferred_days' : '', preferred ? 'READY' : 'OPTIONAL_BLANK', false));
    put(field_(CUSTOM_FIELD.ORDER_FULFILLMENT, 'Order Fulfillment Status', '0', 'SAFE_DEFAULT_FROM_PROVEN_ORDER_26353', 'DEFAULT', false));
    put(field_(CUSTOM_FIELD.ENTER_NEW_PART_UPDATED, 'ENTERNEWPART - Updated?', '0', 'SAFE_DEFAULT_FROM_PROVEN_ORDER_26353', 'DEFAULT', false));
    put(field_(CUSTOM_FIELD.REQUEST_SOURCE, 'Request Source', '0', 'WEBFORM.attribution', 'LOOKUP_REQUIRED', false));
    put(field_(CUSTOM_FIELD.SERVICE_LEVEL, 'Service Level', '503', 'VERIFIED_CUSTOM_LIST_103_SERVICE_LEVEL_1', 'READY', false));
    put(field_(CUSTOM_FIELD.SERVICE_TECH, 'Service Tech', '502', 'SYSTEM_DEFAULT_TO_BE_ASSIGNED', 'READY', true));
    put(field_(CUSTOM_FIELD.ZONE, 'Zones', '0', 'RESOLVED_LOCATION', 'LOOKUP_REQUIRED', false));
    put(field_(CUSTOM_FIELD.PARTS_FULFILLMENT, 'Parts Fulfillment Status', '0', 'SAFE_DEFAULT_FROM_PROVEN_ORDER_26353', 'DEFAULT', false));
    put(field_(CUSTOM_FIELD.NEEDS_PO, 'Needs PO?', '', 'OPERATOR', 'OPTIONAL_BLANK', false));

    var operatorRequired = Object.keys(fields).filter(function (id) {
      return fields[id].status === 'OPERATOR_REQUIRED' || fields[id].status === 'REVIEW';
    });
    var lookupRequired = Object.keys(fields).filter(function (id) { return fields[id].status === 'LOOKUP_REQUIRED'; });
    var ready = Object.keys(fields).filter(function (id) { return ['READY','DEFAULT'].indexOf(fields[id].status) !== -1; });

    /* CF_SERVICEOPS_V5_10_4_DRAFT_SAFETY_GATE_R1 */
    var coreBlockers = [];
    var stage = upper_(request['Current Stage']);
    if (!customerId) coreBlockers.push({ code: 'CUSTOMER_REQUIRED', message: 'Resolved Customer ID is required.' });
    if (!contactId) coreBlockers.push({ code: 'CONTACT_REQUIRED', message: 'Resolved Contact ID is required.' });
    if (!locationId) coreBlockers.push({ code: 'LOCATION_REQUIRED', message: 'Resolved Location ID is required.' });
    if (stage === 'NEEDS REVIEW') coreBlockers.push({ code: 'REQUEST_NEEDS_REVIEW', message: 'Request is currently in NEEDS REVIEW.' });
    if (upper_(request['Manual Review?']) === 'YES') coreBlockers.push({ code: 'MANUAL_REVIEW_REQUIRED', message: clean_(request['Manual Review Reason']) || 'Manual review is required.' });
    if (upper_(request['Duplicate Risk Status']) !== 'NONE') coreBlockers.push({ code: 'DUPLICATE_RISK_NOT_CLEAR', message: 'Duplicate Risk Status must be NONE.' });
    if (clean_(request['Work Order ID'])) coreBlockers.push({ code: 'SALES_ORDER_ALREADY_DURABLE', message: 'A durable Sales Order / Work Order ID already exists.' });
    if (/COMPLETED|CANCELLED|CANCELED/.test(stage)) coreBlockers.push({ code: 'TERMINAL_REQUEST', message: 'Terminal requests cannot create a Sales Order.' });
    var safeForPayloadOverlay = operatorRequired.length === 0 && coreBlockers.length === 0;

    return {
      ok: safeForPayloadOverlay,
      version: VERSION,
      mode: 'SALES_ORDER_DRAFT_R1',
      requestId: clean_(request['Request ID']),
      source: {
        submissionId: clean_(request['Submission ID'] || webform['Submission ID']),
        campaign: att,
        customerId: customerId,
        contactId: contactId,
        locationId: locationId
      },
      coreFields: {
        typeId: { value: '44938', source: 'PROVEN_SERVICE_WORK_ORDER_TYPE', status: 'READY' },
        customerId: { value: customerId, source: 'MATCHING', status: customerId ? 'READY' : 'OPERATOR_REQUIRED' },
        contactId: { value: contactId, source: 'MATCHING', status: contactId ? 'READY' : 'OPERATOR_REQUIRED' },
        shipToLocationId: { value: locationId, source: 'MATCHING', status: locationId ? 'READY' : 'OPERATOR_REQUIRED' },
        billToLocationId: { value: locationId, source: 'RESOLVED_LOCATION_DEFAULT_BILL_TO', status: locationId ? 'READY' : 'OPERATOR_REQUIRED' },
        statusId: { value: '19', source: 'GUARDED_WRITER', status: 'READY' },
        paymentTermId: { value: '13', source: 'GUARDED_WRITER', status: 'READY' },
        serviceTechId: { value: '502', source: 'SYSTEM_DEFAULT_TO_BE_ASSIGNED', status: 'READY' }
      },
      assetResolution: {
        status: assetChoice.status,
        selectedAssetId: clean_(selectedAsset['Asset ID'] || selectedAsset['Entity ID']),
        selectedAsset: selectedAsset,
        candidateCount: assetRows.length,
        candidates: assetChoice.candidates.map(function (x) {
          return { assetId: clean_(x.asset['Asset ID'] || x.asset['Entity ID']), make: clean_(x.asset['Asset Make']), model: clean_(x.asset['Asset Model']), serial: clean_(x.asset['Serial Number']), score: x.score };
        })
      },
      webform: {
        unitDetails: unitDetails,
        serviceDetails: clean_(request['Service Details'] || raw.details),
        additionalNotes: clean_(request['Additional Notes'] || raw.anything_else),
        preferredDays: preferred
      },
      internalNotesDraft: { value: internalNotesDraft, source: 'WEBFORM_OPERATIONAL_DETAILS', status: internalNotesDraft ? 'READY' : 'OPTIONAL_BLANK' },
      internalNotesPayloadDeferred: true,
      customFields: fields,
      readyFieldIds: ready,
      lookupRequiredFieldIds: lookupRequired,
      operatorRequiredFieldIds: operatorRequired,
      coreBlockers: coreBlockers,
      safeForPayloadOverlay: safeForPayloadOverlay,
      payloadOverlayDeferred: true,
      note: 'Draft safety includes resolved Customer/Contact/Location, review state, duplicate risk, and durable-order checks.'
    };
  }

  function format(draft) {
    if (!draft) return '';
    var f = draft.customFields || {};
    var lines = [
      'SALES ORDER DRAFT - READ ONLY',
      'Customer: ' + clean_(draft.coreFields && draft.coreFields.customerId && draft.coreFields.customerId.value),
      'Contact: ' + clean_(draft.coreFields && draft.coreFields.contactId && draft.coreFields.contactId.value),
      'Ship To: ' + clean_(draft.coreFields && draft.coreFields.shipToLocationId && draft.coreFields.shipToLocationId.value),
      'Bill To: ' + clean_(draft.coreFields && draft.coreFields.billToLocationId && draft.coreFields.billToLocationId.value),
      'Unit: ' + clean_(f['651'] && f['651'].value) + ' [' + clean_(f['651'] && f['651'].source) + ']',
      'Serial: ' + (clean_(f['650'] && f['650'].value) || '-'),
      'Preferred: ' + (clean_(f['653'] && f['653'].value) || '-'),
      'Service Level: ' + (clean_(f['797'] && f['797'].value) === '503' ? 'Service Level 1 (503)' : (clean_(f['797'] && f['797'].value) || '-')),
      'Internal Notes draft: ' + (clean_(draft.internalNotesDraft && draft.internalNotesDraft.value) || '-'),
      'Internal Notes payload: DEFERRED - direct API datatype/mechanism must be verified',
      'Service Tech: To be Assigned (502)',
      'Asset resolution: ' + clean_(draft.assetResolution && draft.assetResolution.status),
      'Operator-required fields: ' + (draft.operatorRequiredFieldIds.length ? draft.operatorRequiredFieldIds.join(', ') : 'none'),
      'Core blockers: ' + ((draft.coreBlockers || []).length ? draft.coreBlockers.map(function (x) { return x.code; }).join(', ') : 'none'),
      'Payload safe: ' + (draft.safeForPayloadOverlay === true ? 'YES' : 'NO'),
      'Lookup mapping pending: ' + (draft.lookupRequiredFieldIds.length ? draft.lookupRequiredFieldIds.join(', ') : 'none')
    ];
    return lines.join('\\n');
  }

  return { version: VERSION, build: build, format: format, customFieldIds: CUSTOM_FIELD };
})();


/* CF_SERVICEOPS_V5_10_3_STRIVEN_CUSTOM_LISTS_R1
 * Read-only lookup/inspection support for Sales Order preparation.
 * Authoritative lists:
 *   103 -> Service Level (field 797)
 *   104 -> Zones (field 798)
 *   105 -> Preferred Days vocabulary (field 653 remains multiline text)
 *   116 -> Request Source (field 855)
 * No Striven mutation occurs in this module.
 */
CF.StrivenCustomLists = (function () {
  'use strict';

  var VERSION = '5.10.3';
  var CACHE_KEY = 'CF_V5103_STRIVEN_CUSTOM_LISTS';
  var CACHE_SECONDS = 1800;
  var DEFINITIONS = [
    { listId: 103, label: 'Service Level', fieldId: '797', role: 'SELECT_LIST_ITEM_ID' },
    { listId: 104, label: 'Zones', fieldId: '798', role: 'SELECT_LIST_ITEM_ID' },
    { listId: 105, label: 'Preferred Days', fieldId: '653', role: 'CANONICAL_TEXT_ONLY' },
    { listId: 116, label: 'Request Source', fieldId: '855', role: 'SELECT_LIST_ITEM_ID' }
  ];

  function clean_(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  function normalize_(value) {
    return clean_(value).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function first_(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (obj && obj[keys[i]] !== undefined && obj[keys[i]] !== null && clean_(obj[keys[i]]) !== '') return obj[keys[i]];
    }
    return '';
  }

  function rows_(response) {
    var body = response && response.json !== undefined ? response.json : response;
    if (Array.isArray(body)) return body;
    if (!body || typeof body !== 'object') return [];
    var keys = ['data','Data','items','Items','results','Results','rows','Rows','value','Value'];
    for (var i = 0; i < keys.length; i++) if (Array.isArray(body[keys[i]])) return body[keys[i]];
    return [];
  }

  function normalizeItem_(row, index) {
    row = row || {};
    var activeRaw = first_(row, ['active','Active','isActive','IsActive','status','Status']);
    var active = true;
    if (typeof activeRaw === 'boolean') active = activeRaw;
    else if (clean_(activeRaw)) active = ['FALSE','0','INACTIVE','DEACTIVATED'].indexOf(clean_(activeRaw).toUpperCase()) === -1;
    return {
      id: clean_(first_(row, ['id','ID','listItemId','ListItemId','customListItemId','CustomListItemId','itemId','ItemId','value','Value'])),
      name: clean_(first_(row, ['name','Name','itemName','ItemName','valueText','ValueText','description','Description'])),
      active: active,
      sourceIndex: index
    };
  }

  function fetchOne_(definition) {
    if (!CF.StrivenHttp || typeof CF.StrivenHttp.requestJson !== 'function') {
      throw new Error('CF.StrivenHttp.requestJson is required.');
    }
    var response = CF.StrivenHttp.requestJson('/v1/custom-lists/' + definition.listId + '/list-items', { method: 'get' });
    var rawRows = rows_(response);
    var items = rawRows.map(normalizeItem_).filter(function (item) { return item.id || item.name; });
    return {
      ok: true,
      listId: definition.listId,
      label: definition.label,
      fieldId: definition.fieldId,
      role: definition.role,
      totalCount: items.length,
      responseKeys: rawRows.length && rawRows[0] && typeof rawRows[0] === 'object' ? Object.keys(rawRows[0]).sort() : [],
      items: items
    };
  }

  function inspect(options) {
    options = options || {};
    var cache = CacheService.getScriptCache();
    if (!options.force) {
      var cached = cache.get(CACHE_KEY);
      if (cached) {
        try {
          var parsed = JSON.parse(cached);
          parsed.cached = true;
          return parsed;
        } catch (ignored) {}
      }
    }

    var lists = [];
    var errors = [];
    DEFINITIONS.forEach(function (definition) {
      try {
        lists.push(fetchOne_(definition));
      } catch (error) {
        lists.push({ ok: false, listId: definition.listId, label: definition.label, fieldId: definition.fieldId, role: definition.role, totalCount: 0, items: [], error: error.message || String(error) });
        errors.push({ listId: definition.listId, label: definition.label, error: error.message || String(error) });
      }
    });

    var result = {
      ok: errors.length === 0,
      version: VERSION,
      mode: 'READ_ONLY_STRIVEN_CUSTOM_LIST_INSPECTION',
      fetchedAt: new Date().toISOString(),
      cached: false,
      listCount: lists.length,
      lists: lists,
      errors: errors,
      liveWriteExecuted: false
    };
    if (result.ok) {
      try { cache.put(CACHE_KEY, JSON.stringify(result), CACHE_SECONDS); } catch (ignoredCache) {}
    }
    return result;
  }

  function listById_(inspection, listId) {
    var lists = inspection && inspection.lists ? inspection.lists : [];
    for (var i = 0; i < lists.length; i++) if (Number(lists[i].listId) === Number(listId)) return lists[i];
    return { items: [] };
  }

  function exact_(list, text) {
    var key = normalize_(text);
    if (!key) return [];
    return (list.items || []).filter(function (item) { return item.active !== false && normalize_(item.name) === key; });
  }

  function scoreCandidates_(list, signals) {
    signals = (signals || []).map(clean_).filter(Boolean);
    var normalizedSignals = signals.map(normalize_).filter(Boolean);
    return (list.items || []).filter(function (item) { return item.active !== false && clean_(item.name); }).map(function (item) {
      var itemKey = normalize_(item.name);
      var score = 0;
      var reasons = [];
      normalizedSignals.forEach(function (signal) {
        if (!signal || !itemKey) return;
        if (signal === itemKey) { score = Math.max(score, 100); reasons.push('EXACT'); return; }
        if (itemKey.indexOf(signal) !== -1 || signal.indexOf(itemKey) !== -1) { score = Math.max(score, 70); reasons.push('CONTAINS'); }
        var tokens = signal.split(' ').filter(function (x) { return x.length >= 3; });
        var hits = tokens.filter(function (x) { return itemKey.indexOf(x) !== -1; }).length;
        if (hits) { score = Math.max(score, Math.min(60, hits * 15)); reasons.push('TOKEN ' + hits); }
      });
      return { id: item.id, name: item.name, score: score, reasons: reasons };
    }).filter(function (x) { return x.score > 0; }).sort(function (a, b) { return b.score - a.score || a.name.localeCompare(b.name); }).slice(0, 5);
  }

  function resolvePreferredDays(value, inspection) {
    var list = listById_(inspection, 105);
    var raw = clean_(value);
    if (!raw) return { status: 'BLANK', raw: '', canonicalValue: '', matches: [] };
    var direct = exact_(list, raw);
    if (direct.length === 1) return { status: 'EXACT', raw: raw, canonicalValue: direct[0].name, matches: direct };
    var parts = raw.split(/[,;|\n]+/).map(clean_).filter(Boolean);
    if (parts.length > 1) {
      var resolved = [], misses = [];
      parts.forEach(function (part) {
        var m = exact_(list, part);
        if (m.length === 1) resolved.push(m[0]); else misses.push(part);
      });
      if (!misses.length) return { status: 'EXACT_MULTI', raw: raw, canonicalValue: resolved.map(function (x) { return x.name; }).join(', '), matches: resolved };
      return { status: 'PARTIAL', raw: raw, canonicalValue: raw, matches: resolved, misses: misses };
    }
    return { status: 'NO_EXACT_MATCH', raw: raw, canonicalValue: raw, matches: [], candidates: scoreCandidates_(list, [raw]) };
  }

  function previewDraft(requestId, draft, inspection) {
    inspection = inspection || inspect({ force: false });
    var request = CF.Util.findRecord('SERVICE_REQUESTS', 'Request ID', requestId) || {};
    var campaign = draft && draft.source && draft.source.campaign ? draft.source.campaign : {};
    var requestSourceSignals = [campaign.trafficChannel, campaign.utmMedium, campaign.utmSource, campaign.referralSource, request['Request Source'], request['Original Request Source'], request['Source Detail']];
    var serviceSignals = [request['Service Classification'], request['Service Complexity'], request['Estimated Duration Minutes'], request['Recommended Technician Type']];
    var zoneSignals = [request['City'], request['Province'], request['Postal Code'], request['Full Address']];
    return {
      requestSource: { listId: 116, fieldId: '855', candidates: scoreCandidates_(listById_(inspection,116), requestSourceSignals), autoAssigned: false },
      serviceLevel: { listId: 103, fieldId: '797', candidates: scoreCandidates_(listById_(inspection,103), serviceSignals), autoAssigned: false },
      zone: { listId: 104, fieldId: '798', candidates: scoreCandidates_(listById_(inspection,104), zoneSignals), autoAssigned: false },
      preferredDays: resolvePreferredDays(draft && draft.webform ? draft.webform.preferredDays : '', inspection),
      note: 'Candidate evidence only. Fields 855, 797 and 798 are not assigned until mappings are explicitly verified.'
    };
  }

  return {
    version: VERSION,
    definitions: DEFINITIONS,
    inspect: inspect,
    resolvePreferredDays: resolvePreferredDays,
    previewDraft: previewDraft
  };
})();

(function () {
  'use strict';
  if (!CF.SalesOrderDraft || typeof CF.SalesOrderDraft.build !== 'function') return;
  if (CF.SalesOrderDraft.__customListInspectionV5103R1) return;
  var originalBuild = CF.SalesOrderDraft.build;
  var originalFormat = typeof CF.SalesOrderDraft.format === 'function' ? CF.SalesOrderDraft.format : null;
  function text_(value) { return value === null || value === undefined ? '' : String(value).trim(); }

  CF.SalesOrderDraft.build = function (requestId) {
    var draft = originalBuild.apply(CF.SalesOrderDraft, arguments);
    var inspection = CF.StrivenCustomLists.inspect({ force: false });
    draft.customListInspection = inspection;
    draft.customListResolution = CF.StrivenCustomLists.previewDraft(requestId, draft, inspection);

    // Request Source is deterministic for this workflow: every request entering
    // this pipeline is a Gravity Forms Webform request. Resolve the actual list
    // item ID from Custom List 116 instead of hard-coding an environment ID.
    var sourceList = (inspection.lists || []).filter(function (list) { return Number(list.listId) === 116; })[0] || { items: [] };
    var webformItems = (sourceList.items || []).filter(function (item) {
      return item.active !== false && text_(item.name).toUpperCase() === 'WEBFORM';
    });
    if (draft.customFields && draft.customFields['855']) {
      var f855 = draft.customFields['855'];
      draft.lookupRequiredFieldIds = (draft.lookupRequiredFieldIds || []).filter(function (id) { return String(id) !== '855'; });
      draft.readyFieldIds = draft.readyFieldIds || [];
      draft.operatorRequiredFieldIds = draft.operatorRequiredFieldIds || [];
      if (webformItems.length === 1 && text_(webformItems[0].id) && text_(webformItems[0].id) !== '0') {
        f855.value = text_(webformItems[0].id);
        f855.source = 'VERIFIED_CUSTOM_LIST_116_WEBFORM';
        f855.status = 'READY';
        if (draft.readyFieldIds.indexOf('855') === -1) draft.readyFieldIds.push('855');
        draft.operatorRequiredFieldIds = draft.operatorRequiredFieldIds.filter(function (id) { return String(id) !== '855'; });
        if (draft.customListResolution && draft.customListResolution.requestSource) {
          draft.customListResolution.requestSource.autoAssigned = true;
          draft.customListResolution.requestSource.selected = { id: text_(webformItems[0].id), name: text_(webformItems[0].name) };
        }
      } else {
        f855.value = '0';
        f855.status = 'REVIEW';
        f855.source = 'CUSTOM_LIST_116_WEBFORM_NOT_UNIQUE';
        if (draft.operatorRequiredFieldIds.indexOf('855') === -1) draft.operatorRequiredFieldIds.push('855');
        draft.safeForPayloadOverlay = false;
        draft.coreBlockers = draft.coreBlockers || [];
        draft.coreBlockers.push({
          code: 'REQUEST_SOURCE_WEBFORM_UNRESOLVED',
          message: 'Custom List 116 must contain exactly one active item named Webform. Correct the list item, then rerun.'
        });
      }
    }

    if (draft.customFields && draft.customFields['653'] && draft.customListResolution && draft.customListResolution.preferredDays) {
      draft.customFields['653'].canonicalValue = draft.customListResolution.preferredDays.canonicalValue;
      draft.customFields['653'].canonicalStatus = draft.customListResolution.preferredDays.status;
      draft.customFields['653'].canonicalListId = '105';
    }
    return draft;
  };

  CF.SalesOrderDraft.format = function (draft) {
    var text = originalFormat ? originalFormat(draft) : '';
    var inspection = draft && draft.customListInspection ? draft.customListInspection : {};
    var resolution = draft && draft.customListResolution ? draft.customListResolution : {};
    var counts = (inspection.lists || []).map(function (list) { return String(list.listId) + ':' + String(list.totalCount || 0); }).join(', ');
    var extra = [
      'Custom Lists: ' + (inspection.ok === true ? 'READY' : 'ERROR') + (counts ? ' [' + counts + ']' : ''),
      'Preferred Days canonical: ' + text_(resolution.preferredDays && resolution.preferredDays.canonicalValue),
      'Request Source candidates: ' + ((resolution.requestSource && resolution.requestSource.candidates || []).map(function (x) { return x.id + ' ' + x.name; }).join(' | ') || 'none'),
      'Service Level candidates: ' + ((resolution.serviceLevel && resolution.serviceLevel.candidates || []).map(function (x) { return x.id + ' ' + x.name; }).join(' | ') || 'none'),
      'Zone candidates: ' + ((resolution.zone && resolution.zone.candidates || []).map(function (x) { return x.id + ' ' + x.name; }).join(' | ') || 'none')
    ].join('\n');
    return text ? text + '\n' + extra : extra;
  };

  CF.SalesOrderDraft.__customListInspectionV5103R1 = true;
})();


/* CF_SERVICEOPS_V5_10_8_INCOMING_TO_SALES_ORDER_R1
 * Incoming-request-driven full service preparation through guarded Sales Order creation.
 * - No permanent cadence: a Webform request creates a one-shot worker chain.
 * - Only request IDs explicitly enqueued by the webhook are eligible for automatic Sales Order creation.
 * - Customer/Contact structure reuses the existing guarded automation and executes at most one mutation per cycle.
 * - Standalone Location creation for an existing Customer is NOT guessed; READY FOR LOCATION CREATE stops for review.
 * - Sales Order creation reuses CF.OrderPreflight as the sole POST boundary, including immutable fingerprint approval,
 *   POST intent journaling, one attempt, GET reconciliation, and no uncertain retry.
 */
CF.EventDrivenServiceAutomation = (function () {
  'use strict';
  var VERSION = '5.10.8';
  var HANDLER = 'AUTO_processCustomerStructure';
  /* CF_SERVICEOPS_V5_10_37_PHASE_NAMED_TRIGGER_HANDLERS_R1 */
  var PHASE_HANDLERS = {
    route: 'AUTO_00_E2E_Route_Request',
    customer: 'AUTO_01_E2E_Customer_Match_Create',
    location: 'AUTO_02_E2E_Location_Reconcile',
    contact: 'AUTO_03_E2E_Contact_Create_Recover',
    info: 'AUTO_04_E2E_Customer_Contact_Info_Sync',
    salesOrder: 'AUTO_05_E2E_Sales_Order_Create_Verify',
    review: 'AUTO_99_E2E_Safe_Stop_Review'
  };
  function allHandlerNames_() {
    var out=[HANDLER];
    Object.keys(PHASE_HANDLERS).forEach(function(k){if(out.indexOf(PHASE_HANDLERS[k])===-1)out.push(PHASE_HANDLERS[k]);});
    return out;
  }
  function phaseNameForHandler_(handler) {
    var h=clean_(handler);
    if(h===PHASE_HANDLERS.customer)return 'CUSTOMER MATCH / CREATE';
    if(h===PHASE_HANDLERS.location)return 'LOCATION RECONCILIATION';
    if(h===PHASE_HANDLERS.contact)return 'CONTACT CREATE / DUPLICATE RECOVERY';
    if(h===PHASE_HANDLERS.info)return 'CUSTOMER + CONTACT INFO SYNC';
    if(h===PHASE_HANDLERS.salesOrder)return 'SALES ORDER CREATE + VERIFY';
    if(h===PHASE_HANDLERS.review)return 'SAFE STOP / REVIEW';
    if(h===PHASE_HANDLERS.route)return 'REQUEST ROUTING / MATCHING';
    return 'LEGACY DISPATCH';
  }
  function handlerForRow_(row,reason) {
    var r=row||{},stage=upper_(r['Current Stage']),status=upper_(r['Request Status']);
    var structure=upper_(r['Customer Structure Status']),next=upper_(r['Next Action']),recon=upper_(r['Reconciliation Status']);
    var manual=upper_(r['Manual Review?'])==='YES',risk=upper_(r['Duplicate Risk Status']);
    var why=upper_(reason);
    var knownOrderId=clean_(r['Work Order ID']);
    if(!knownOrderId){try{var knownRoot=CF.Util&&typeof CF.Util.parseJson==='function'?CF.Util.parseJson(r['Write Journal JSON'],{}):JSON.parse(String(r['Write Journal JSON']||'{}'));var knownOrder=knownRoot&&knownRoot.salesOrderCreate||{};knownOrderId=clean_(knownOrder.canonicalSalesOrderId||knownOrder.responseIdentifier);}catch(ignoredKnownOrder){}}
    if(knownOrderId)return PHASE_HANDLERS.salesOrder; // v5.11.0 R2 known order => certification phase
    if(why.indexOf('READ_ONLY_RECONCILE_')===0||why.indexOf('CUSTOMER_CONTACT_INFO')!==-1)return PHASE_HANDLERS.info;
    if(why.indexOf('SALES_ORDER_OPERATIONAL_REFRESH')!==-1)return PHASE_HANDLERS.salesOrder;
    if(stage==='READY FOR CONTACT CREATE'&&!manual&&(risk===''||risk==='NONE'))return PHASE_HANDLERS.contact;
    if(stage==='READY FOR LOCATION CREATE')return PHASE_HANDLERS.location;
    if(stage==='CREATING CUSTOMER STRUCTURE'){
      var combined=structure+' '+next;
      if(combined.indexOf('CONTACT')!==-1)return PHASE_HANDLERS.contact;
      if(combined.indexOf('LOCATION')!==-1)return PHASE_HANDLERS.location;
      return PHASE_HANDLERS.customer;
    }
    if(stage==='CUSTOMER RESOLVED'||stage==='READY FOR CUSTOMER CREATE')return PHASE_HANDLERS.customer;
    if(stage==='CUSTOMER STRUCTURE COMPLETE'){
      if(recon.indexOf('CUSTOMER + CONTACT INFO CONFIRMED')!==-1)return PHASE_HANDLERS.salesOrder;
      return PHASE_HANDLERS.info;
    }
    if(stage==='NEEDS REVIEW'||manual||(risk&&risk!=='NONE')||['BLOCKED','DUPLICATE','CANCELLED','CANCELED','ERROR'].indexOf(status)!==-1)return PHASE_HANDLERS.review;
    return PHASE_HANDLERS.route;
  }
  function describeQueuedWork_(reason) {
    var queued=firstQueuedAction_();
    if(!queued)return{requestId:'',customerName:'',currentStage:'',requestStatus:'',nextAction:'',customerStructureStatus:'',recommendedHandler:PHASE_HANDLERS.route,recommendedPhase:phaseNameForHandler_(PHASE_HANDLERS.route)};
    var row=queued.row||{},handler=handlerForRow_(row,reason);
    return{requestId:clean_(queued.id),customerName:clean_(row['Full Name']),currentStage:clean_(row['Current Stage']),requestStatus:clean_(row['Request Status']),nextAction:clean_(row['Next Action']),customerStructureStatus:clean_(row['Customer Structure Status']),customerId:clean_(row['Matched Customer ID']||row['Created Customer ID']),contactId:clean_(row['Matched Contact ID']||row['Created Contact ID']),locationId:clean_(row['Matched Location ID']||row['Created Location ID']),recommendedHandler:handler,recommendedPhase:phaseNameForHandler_(handler)};
  }

  var ENABLED = 'CF_EVENT_DRIVEN_SERVICE_AUTOMATION_ENABLED';
  var AUTO_SALES_ORDER = 'CF_EVENT_DRIVEN_AUTO_SALES_ORDER';
  var REQUEST_QUEUE = 'CF_EVENT_DRIVEN_SERVICE_REQUEST_IDS';
  var LAST_KICK = 'CF_EVENT_DRIVEN_SERVICE_LAST_KICK';
  var LAST_REQUEST = 'CF_EVENT_DRIVEN_SERVICE_LAST_REQUEST_ID';
  var PREPARATION_ONLY = 'CF_SERVICEOPS_AUTOMATION_PREPARATION_ONLY';
  var STRUCTURE_CUTOFF = 'CF_AUTO_CUSTOMER_STRUCTURE_CUTOFF_MS';
  var DELAY_MS = 10000;
  var NEXT_TRIGGER_AT = 'CF_EVENT_DRIVEN_SERVICE_NEXT_TRIGGER_AT';

  function clean_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function upper_(v) { return clean_(v).toUpperCase(); }
  function props_() { return PropertiesService.getScriptProperties(); }
  function log_(action,status,requestId,details,message) {
    try { CF.Util.logEvent({ module:'70_Workflow_Automation', action:action, status:status, requestId:clean_(requestId), message:message||'', details:details||{}, version:VERSION }); } catch (ignored) {}
  }
  function handlerTriggers_() {
    var names=allHandlerNames_();
    return ScriptApp.getProjectTriggers().filter(function (trigger) {
      try{return trigger.getHandlerFunction&&names.indexOf(clean_(trigger.getHandlerFunction()))!==-1;}catch(ignored){return false;}
    });
  }
  function uid_(trigger) { try { return clean_(trigger.getUniqueId()); } catch (ignored) { return ''; } }
  function removeAllHandlerTriggers_() {
    var rows = handlerTriggers_(); rows.forEach(function(t){ ScriptApp.deleteTrigger(t); }); return rows.length;
  }
  function readQueue_() {
    var raw = props_().getProperty(REQUEST_QUEUE); if (!raw) return [];
    try { var x=JSON.parse(raw); return Array.isArray(x)?x.map(clean_).filter(Boolean):[]; } catch (ignored) { return []; }
  }
  function writeQueue_(rows) {
    var seen={},out=[];(rows||[]).forEach(function(id){id=clean_(id);if(id&&!seen[id]){seen[id]=true;out.push(id);}});
    props_().setProperty(REQUEST_QUEUE,JSON.stringify(out)); return out;
  }
  function withEventLock_(work) { var lock=LockService.getScriptLock();lock.waitLock(30000);try{return work();}finally{lock.releaseLock();} }
  function enqueueUnlocked_(requestId) { var q=readQueue_();q.push(clean_(requestId));return writeQueue_(q); }
  function dequeueUnlocked_(requestId) { return writeQueue_(readQueue_().filter(function(id){return id!==clean_(requestId);})); }
  function enqueue_(requestId) { return withEventLock_(function(){return enqueueUnlocked_(requestId);}); }
  function dequeue_(requestId) { return withEventLock_(function(){return dequeueUnlocked_(requestId);}); }
  function setFullMode_() {
    var p=props_();p.setProperty(ENABLED,'true');p.setProperty(AUTO_SALES_ORDER,'true');p.setProperty(PREPARATION_ONLY,'false');
  }
  function ensureCutoff_() {
    var p=props_();if(!clean_(p.getProperty(STRUCTURE_CUTOFF)))p.setProperty(STRUCTURE_CUTOFF,String(Date.now()-120000));
  }
  /* CF_SERVICEOPS_V5_12_6_FAST_INITIAL_TRIGGER_R1 */
  /* CF_SERVICEOPS_V5_12_7_QUEUE_DIAGNOSTICS_R1 */
  function scheduleNextUnlocked_(reason,currentUid) {
    var current=clean_(currentUid),work=describeQueuedWork_(reason),requestedMatch=String(reason||'').match(/^WEBFORM_RECEIVED_(SR-[0-9]+-[0-9]+)$/i);
    var requestedRequestId=requestedMatch?clean_(requestedMatch[1]):'';
    var activeQueueHeadRequestId=clean_(work.requestId);
    var queueHeadMatchesRequested=!requestedRequestId||requestedRequestId===activeQueueHeadRequestId;
    var existing=handlerTriggers_().filter(function(t){return !current||uid_(t)!==current;});
    if(existing.length)return{ok:true,scheduled:false,reason:'NEXT_ONE_SHOT_ALREADY_PENDING',activeFutureTriggers:existing.length,triggerReason:clean_(reason),requestId:activeQueueHeadRequestId,customerName:clean_(work.customerName),currentStage:clean_(work.currentStage),nextAction:clean_(work.nextAction),requestedRequestId:requestedRequestId,activeQueueHeadRequestId:activeQueueHeadRequestId,queueHeadMatchesRequested:queueHeadMatchesRequested,liveWriteExecuted:false};
    var nextHandler=clean_(work.recommendedHandler)||PHASE_HANDLERS.route;
    var delayMs=upper_(reason).indexOf('WEBFORM_RECEIVED_')===0?1000:DELAY_MS;
    ScriptApp.newTrigger(nextHandler).timeBased().after(delayMs).create();
    return{ok:true,scheduled:true,mode:'EVENT_DRIVEN_ONE_SHOT',delayMs:delayMs,triggerReason:clean_(reason),handler:nextHandler,phase:phaseNameForHandler_(nextHandler),requestId:activeQueueHeadRequestId,customerName:clean_(work.customerName),currentStage:clean_(work.currentStage),nextAction:clean_(work.nextAction),requestedRequestId:requestedRequestId,activeQueueHeadRequestId:activeQueueHeadRequestId,queueHeadMatchesRequested:queueHeadMatchesRequested,activeFutureTriggers:handlerTriggers_().filter(function(t){return !current||uid_(t)!==current;}).length,liveWriteExecuted:false};
  }
  function scheduleNext_(reason,currentUid) {
    var current=clean_(currentUid);
    var existing=handlerTriggers_().filter(function(t){return !current||uid_(t)!==current;});
    existing.forEach(function(t){try{ScriptApp.deleteTrigger(t);}catch(ignoredDelete){}});
    var work=describeQueuedWork_(reason),nextHandler=clean_(work.recommendedHandler)||PHASE_HANDLERS.route;
    ScriptApp.newTrigger(nextHandler).timeBased().after(DELAY_MS).create();
    var scheduledAt=new Date(Date.now()+DELAY_MS).toISOString();
    try{props_().setProperty(NEXT_TRIGGER_AT,scheduledAt);}catch(ignoredProp){}
    return{ok:true,scheduled:true,mode:'EVENT_DRIVEN_ONE_SHOT',delayMs:DELAY_MS,triggerReason:clean_(reason),handler:nextHandler,phase:phaseNameForHandler_(nextHandler),requestId:clean_(work.requestId),customerName:clean_(work.customerName),currentStage:clean_(work.currentStage),nextAction:clean_(work.nextAction),replacedExistingFutureTriggers:existing.length,scheduledAt:scheduledAt,activeFutureTriggers:handlerTriggers_().filter(function(t){return !current||uid_(t)!==current;}).length,liveWriteExecuted:false};
  }
  function kick(requestId) {
    requestId=clean_(requestId);if(!requestId)return{ok:false,scheduled:false,error:'Request ID is required.',liveWriteExecuted:false};
    return withEventLock_(function(){
      setFullMode_();ensureCutoff_();enqueueUnlocked_(requestId);
      /* CF_SERVICEOPS_V5_12_8_KICK_PRESERVE_PENDING_WORKER_R1 */
      var removed=0,next=scheduleNextUnlocked_('WEBFORM_RECEIVED_'+requestId,'');
      props_().setProperty(LAST_KICK,new Date().toISOString());props_().setProperty(LAST_REQUEST,requestId);
      next.version='5.10.12';next.requestId=requestId;next.removedExistingHandlerTriggers=removed;next.queuedRequestIds=readQueue_();next.automaticSalesOrderCreate=true;next.queueConcurrency='SCRIPT_LOCK_SERIALIZED';return next;
    });
  }
  function verifySetup() {
    var removed=removeAllHandlerTriggers_(),p=props_();
    p.setProperty(ENABLED,'true');p.setProperty(AUTO_SALES_ORDER,'true');p.setProperty(PREPARATION_ONLY,'false');p.setProperty(STRUCTURE_CUTOFF,String(Date.now()));
    writeQueue_([]);
    return{ok:true,version:VERSION,mode:'INCOMING_REQUEST_TO_GUARDED_SALES_ORDER',handler:HANDLER,cadence:'NO_PERMANENT_CADENCE',triggerCreatedOnIncomingRequest:true,oneShotChain:true,removedExistingHandlerTriggers:removed,activeHandlerTriggers:handlerTriggers_().length,preparationOnly:false,automaticCustomerContactWrites:true,automaticSalesOrderCreate:true,standaloneExistingCustomerLocationCreate:true,liveWriteExecuted:false,next:'SUBMIT ONE NEW WEBFORM REQUEST; SAFE REQUESTS WILL CONTINUE THROUGH RECONCILED QUOTED SALES ORDER'};
  }
  function disable() {
    return withEventLock_(function(){var removed=removeAllHandlerTriggers_(),p=props_();p.setProperty(ENABLED,'false');p.setProperty(AUTO_SALES_ORDER,'false');writeQueue_([]);return{ok:true,version:'5.10.12',status:'EVENT_DRIVEN_AUTOMATION_DISABLED',removedHandlerTriggers:removed,queueConcurrency:'SCRIPT_LOCK_SERIALIZED',liveWriteExecuted:false};});
  }
  function safeStop_(requestId,code,message,row) {
    dequeue_(requestId);log_('AUTO_SALES_ORDER_GATE','SAFE_STOP',requestId,{code:code,stage:clean_(row&&row['Current Stage']),duplicateRisk:clean_(row&&row['Duplicate Risk Status'])},message);
    return{ok:true,version:VERSION,status:'SAFE_STOP',requestId:requestId,code:code,message:message,automaticSalesOrderCreate:false,liveWriteExecuted:false};
  }
  function request_(id) { return CF.Util.findRecord('SERVICE_REQUESTS','Request ID',id); }
  function autoSalesOrder_(requestId) {
    var row=request_(requestId);
    if(!row)return safeStop_(requestId,'REQUEST_NOT_FOUND','Queued Service Request no longer exists.',{});
    var queueSnapshot=null;

    // v5.11.0 R2: a durable row ID OR prior POST response ID means CERTIFY, never CREATE.
    var knownSalesOrderId=clean_(row['Work Order ID']);
    if(!knownSalesOrderId){
      try{
        var knownRoot=CF.Util&&typeof CF.Util.parseJson==='function'?CF.Util.parseJson(row['Write Journal JSON'],{}):JSON.parse(String(row['Write Journal JSON']||'{}'));
        var knownOrder=knownRoot&&knownRoot.salesOrderCreate||{};
        knownSalesOrderId=clean_(knownOrder.canonicalSalesOrderId||knownOrder.responseIdentifier);
      }catch(ignoredKnownOrderId){}
    }
    if(knownSalesOrderId){
      if(!CF.OrderPreflight||typeof CF.OrderPreflight.certifyExisting!=='function')return safeStop_(requestId,'CERTIFICATION_MODULE_MISSING','A known Sales Order exists but the v5.11 certification controller is unavailable.',row);
      var existingCertification=CF.OrderPreflight.certifyExisting(requestId,knownSalesOrderId);
      if(existingCertification&&existingCertification.ok===true){
        dequeue_(requestId);
        try{if(typeof AUTO_scheduleQueueSnapshot_==='function')queueSnapshot=AUTO_scheduleQueueSnapshot_();}catch(ignoredQueueSnapshot){}
        existingCertification.queueSnapshot=queueSnapshot;
        return existingCertification;
      }
      if(existingCertification&&existingCertification.status==='SALES_ORDER_CERTIFICATION_GET_RETRY_REQUIRED'){
        return{ok:true,version:VERSION,status:'SALES_ORDER_READ_ONLY_RECONCILIATION_PENDING',requestId:requestId,certification:existingCertification,automaticPostRetry:false,liveWriteExecuted:false};
      }
      dequeue_(requestId);
      return existingCertification||{ok:false,version:VERSION,status:'SALES_ORDER_CERTIFICATION_FAILED',requestId:requestId,liveWriteExecuted:false};
    }

    var stage=upper_(row['Current Stage']),status=upper_(row['Request Status']);
    if(stage==='READY FOR LOCATION CREATE'){
      if(!CF.StandaloneLocationCreateV5128||typeof CF.StandaloneLocationCreateV5128.process!=='function')return safeStop_(requestId,'STANDALONE_LOCATION_MODULE_MISSING','Guarded standalone Location module is unavailable.',row);
      var locationGateResult=CF.StandaloneLocationCreateV5128.process(requestId,{autoMode:true});
      if(locationGateResult&&locationGateResult.liveWriteExecuted===true)return{ok:true,version:VERSION,status:'CUSTOMER_STRUCTURE_WRITE_COMPLETE',requestId:requestId,location:locationGateResult,automaticPostRetry:false,liveWriteExecuted:true};
      if(!locationGateResult||locationGateResult.ok===false)return{ok:false,version:VERSION,status:clean_(locationGateResult&&locationGateResult.status)||'LOCATION_EXECUTION_FAILED',requestId:requestId,location:locationGateResult||{},automaticPostRetry:false,liveWriteExecuted:false};
      row=request_(requestId);stage=upper_(row&&row['Current Stage']);status=upper_(row&&row['Request Status']);
      if(stage!=='CUSTOMER STRUCTURE COMPLETE')return{ok:true,version:VERSION,status:'WAITING_FOR_CUSTOMER_STRUCTURE',requestId:requestId,stage:clean_(row&&row['Current Stage']),location:locationGateResult,automaticPostRetry:false,liveWriteExecuted:false};
    }
    if(stage==='NEEDS REVIEW'||upper_(row['Manual Review?'])==='YES'||upper_(row['Duplicate Risk Status'])!=='NONE'||['BLOCKED','DUPLICATE','CANCELLED','CANCELED','ERROR'].indexOf(status)!==-1)return safeStop_(requestId,'REQUEST_REVIEW_OR_RISK','Request requires operator review or has unresolved duplicate/risk state.',row);
    if(stage!=='CUSTOMER STRUCTURE COMPLETE'||upper_(row['Customer Structure Status'])!=='COMPLETE')return{ok:true,version:VERSION,status:'WAITING_FOR_CUSTOMER_STRUCTURE',requestId:requestId,stage:clean_(row['Current Stage']),liveWriteExecuted:false};
    if(!CF.SalesOrderDraft||typeof CF.SalesOrderDraft.build!=='function')return safeStop_(requestId,'DRAFT_MODULE_MISSING','Sales Order draft module is unavailable.',row);
    if(!CF.OrderPreflight||typeof CF.OrderPreflight.previewRequest!=='function'||typeof CF.OrderPreflight.approveRequest!=='function'||typeof CF.OrderPreflight.executeApproved!=='function')return safeStop_(requestId,'WRITER_MODULE_MISSING','Guarded Sales Order writer is unavailable.',row);

    var preview=CF.OrderPreflight.previewRequest(requestId);
    if(!preview||preview.readyForApproval!==true){
      var pb=(preview&&preview.blockers||[]).map(function(x){return x.code+': '+x.message;}).join(' | ');
      return safeStop_(requestId,'PREFLIGHT_BLOCKED',pb||'Guarded Sales Order preflight did not pass.',row);
    }
    var approval=CF.OrderPreflight.approveRequest(requestId);
    var execution=CF.OrderPreflight.executeApproved(requestId,{executionToken:CF.OrderPreflight.executionToken});
    if(execution&&execution.status==='OPERATIONAL_CACHE_REFRESHED_RERUN_REQUIRED')return{ok:true,version:VERSION,status:'SALES_ORDER_OPERATIONAL_REFRESH_RERUN',requestId:requestId,approval:approval,execution:execution,liveWriteExecuted:false};
    if(execution&&execution.status==='SALES_ORDER_CERTIFICATION_GET_RETRY_REQUIRED')return{ok:true,version:VERSION,status:'SALES_ORDER_READ_ONLY_RECONCILIATION_PENDING',requestId:requestId,approval:approval,execution:execution,automaticPostRetry:false,liveWriteExecuted:!!execution.liveWriteExecuted};
    if(!execution||execution.ok!==true){
      if(execution&&execution.remoteWriteMayHaveSucceeded===true){
        return{ok:true,version:VERSION,status:'SALES_ORDER_READ_ONLY_RECONCILIATION_PENDING',requestId:requestId,approval:approval,execution:execution,automaticPostRetry:false,liveWriteExecuted:!!execution.liveWriteExecuted};
      }
      dequeue_(requestId);
      log_('AUTO_SALES_ORDER_CREATE',execution&&execution.status?execution.status:'FAILED',requestId,{approval:approval,execution:execution},execution&&execution.error?execution.error:'Sales Order execution stopped.');
      return{ok:false,version:VERSION,status:execution&&execution.status?execution.status:'SALES_ORDER_EXECUTION_FAILED',requestId:requestId,approval:approval,execution:execution||{},automaticPostRetry:false,liveWriteExecuted:!!(execution&&execution.liveWriteExecuted)};
    }

    dequeue_(requestId);
    try{if(typeof AUTO_scheduleQueueSnapshot_==='function')queueSnapshot=AUTO_scheduleQueueSnapshot_();}catch(ignoredQueueSnapshot2){}
    log_('AUTO_SALES_ORDER_CREATE',execution.status||'SALES_ORDER_VERIFIED_COMPLETE',requestId,{approval:approval,execution:execution,billToLocationId:execution.billToLocationId,shipToLocationId:execution.shipToLocationId,serviceLevel797:'503',requestSource855:execution.requestSource855,internalNotesConfirmed:execution.internalNotesConfirmed},'');
    return{ok:true,version:VERSION,mode:'AUTOMATIC_GUARDED_SALES_ORDER_CREATE_AND_CERTIFY',status:execution.status||'SALES_ORDER_VERIFIED_COMPLETE',requestId:requestId,approval:approval,execution:execution,automaticStatusTransition:false,manualReviewRequired:false,internalNotesDirectApiDeferred:false,queueSnapshot:queueSnapshot,liveWriteExecuted:!!execution.liveWriteExecuted};
  }
  function firstQueuedAction_() {
    var q=readQueue_();
    while(q.length){var id=q[0],row=request_(id);if(!row){dequeue_(id);q=readQueue_();continue;}return{id:id,row:row};}
    return null;
  }
  
  function refreshOperatorQueueSafely_(requestId,reason) {
    /* CF_SERVICEOPS_V5_10_30_FINAL_QUEUE_REFRESH_R1 */
    try {
      if(!CF.OperatorQueue||typeof CF.OperatorQueue.refresh!=='function') {
        return{ok:false,status:'OPERATOR_QUEUE_MODULE_MISSING',requestId:clean_(requestId),reason:clean_(reason)};
      }
      var refreshed=CF.OperatorQueue.refresh();
      try{SpreadsheetApp.flush();}catch(ignoredFlush){}
      var out={ok:!refreshed||refreshed.ok!==false,status:'REFRESHED',requestId:clean_(requestId),reason:clean_(reason),activeRequests:refreshed&&refreshed.activeRequests};
      log_('OPERATOR_QUEUE_FINAL_REFRESH',out.ok?'COMPLETE':'FAILED',requestId,{reason:clean_(reason),activeRequests:out.activeRequests},'');
      return out;
    } catch(error) {
      var message=error&&error.message?error.message:String(error);
      log_('OPERATOR_QUEUE_FINAL_REFRESH','FAILED',requestId,{reason:clean_(reason)},message);
      return{ok:false,status:'REFRESH_FAILED',requestId:clean_(requestId),reason:clean_(reason),error:message};
    }
  }


  /* CF_SERVICEOPS_V5_10_38_BOUNDED_LOCATION_STALL_QUEUE_FAIRNESS_R1 */
  var LOCATION_STALL_LIMIT=36; // v5.11.0: up to ~6 minutes of read-only reconciliation at the 10s continuation cadence; no Customer/Location POST retry
  var LOCATION_STALL_PREFIX='CF_E2E_LOCATION_STALL_';
  function structureStepStatus_(structureResult) {
    return clean_(structureResult&&structureResult.stepResult&&structureResult.stepResult.status || structureResult&&structureResult.result&&structureResult.result.status || '');
  }
  function structureResultRequestIdsV5139_(result){
    var out=[],seen={};
    function add(v){v=clean_(v);if(v&&!seen[v]){seen[v]=true;out.push(v);}}
    result=result||{};
    add(result.requestId);
    add(result.stepResult&&result.stepResult.requestId);
    add(result.result&&result.result.requestId);
    add(result.matching&&result.matching.requestId);
    add(result.matching&&result.matching.result&&result.matching.result.requestId);
    return out;
  }
  function crossRequestResultIdsV5139_(expectedId,result){
    expectedId=clean_(expectedId);
    return structureResultRequestIdsV5139_(result).filter(function(id){return id&&id!==expectedId;});
  }
  function locationPendingSignature_(requestId,structureResult,row) {
    var step=structureResult&&structureResult.stepResult||{};
    var candidates=step&&step.locationCandidates;
    if(!Array.isArray(candidates))candidates=[];
    return [clean_(requestId),clean_(row&&row['Matched Customer ID']||row&&row['Created Customer ID']),upper_(row&&row['Current Stage']),upper_(structureStepStatus_(structureResult)),candidates.map(clean_).sort().join(',')].join('|');
  }
  function readLocationStall_(requestId) {
    var raw=props_().getProperty(LOCATION_STALL_PREFIX+clean_(requestId));
    if(!raw)return{signature:'',count:0};
    try{var x=JSON.parse(raw);return x&&typeof x==='object'?x:{signature:'',count:0};}catch(ignored){return{signature:'',count:0};}
  }
  function trackLocationStall_(requestId,structureResult,row) {
    var sig=locationPendingSignature_(requestId,structureResult,row),prior=readLocationStall_(requestId);
    var out={signature:sig,count:prior.signature===sig?Number(prior.count||0)+1:1,lastAttemptAt:new Date().toISOString()};
    props_().setProperty(LOCATION_STALL_PREFIX+clean_(requestId),JSON.stringify(out));
    return out;
  }
  function clearLocationStall_(requestId) {try{props_().deleteProperty(LOCATION_STALL_PREFIX+clean_(requestId));}catch(ignored){}}
  function rotateQueuedRequestToTail_(requestId) {
    var id=clean_(requestId),q=readQueue_().filter(function(x){return clean_(x)!==id;});q.push(id);return writeQueue_(q);
  }
  function parkStalledLocationRequest_(requestId,stall) {
    var row=request_(requestId);if(!row)return{ok:false,status:'LOCATION_STALL_REQUEST_NOT_FOUND'};
    var message='Primary Location reconciliation stayed unchanged for '+Number(stall&&stall.count||0)+' read-only attempts. No Customer or Location create was retried.';
    CF.Util.patchRow('SERVICE_REQUESTS',row.__rowNumber,{
      'Updated At':CF.Util.nowString(),
      'Current Stage':'NEEDS REVIEW',
      'Request Status':'BLOCKED',
      'Manual Review?':'YES',
      'Manual Review Reason':message,
      'Blocking Issue':message,
      'Next Action':'REVIEW EXISTING LOCATION — DO NOT CREATE AGAIN',
      'Striven Sync Status':'BLOCKED',
      'Striven Sync Error':'',
      'Last Striven Sync':CF.Util.nowString(),
      'Reconciliation Status':'LOCATION_RECONCILIATION_STALLED_PARKED'
    });
    clearLocationStall_(requestId);
    log_('LOCATION_RECONCILIATION_STALL','PARKED_QUEUE_CONTINUES',requestId,{stallCount:Number(stall&&stall.count||0),queueAfterDequeue:readQueue_()},message);
    return{ok:true,status:'LOCATION_RECONCILIATION_STALLED_PARKED',requestId:clean_(requestId),stallCount:Number(stall&&stall.count||0),liveWriteExecuted:false,automaticWriteRetry:false};
  }


/* CF_SERVICEOPS_V5_13_2_STABILIZATION_R1_ORCHESTRATION_HELPERS */
function CF_V5132_businessState_(r){
  r=r||{}; var root={}; try{root=CF.Util&&CF.Util.parseJson?CF.Util.parseJson(r['Write Journal JSON'],{}):JSON.parse(String(r['Write Journal JSON']||'{}'));}catch(e){root={};}
  var cj=root&&root.contactCreate||{}, oj=root&&root.salesOrderCreate||{};
  function c(v){return v===null||v===undefined?'':String(v).trim();}
  var ids=Array.isArray(cj.existingDuplicateContactIds)?cj.existingDuplicateContactIds.map(c).filter(Boolean).sort():[];
  return JSON.stringify({stage:c(r['Current Stage']),requestStatus:c(r['Request Status']),next:c(r['Next Action']),structure:c(r['Customer Structure Status']),customer:c(r['Matched Customer ID']||r['Created Customer ID']),contact:c(r['Matched Contact ID']||r['Created Contact ID']),location:c(r['Matched Location ID']||r['Created Location ID']),association:c(r['Contact Association Status']),manual:c(r['Manual Review?']),blocking:c(r['Blocking Issue']),contactJournal:{status:c(cj.status),responseContactId:c(cj.responseContactId),duplicateIds:ids,associationStatus:c(cj.associationStatus),associationAttempts:Number(cj.associationAttempts||0),postAttempts:Number(cj.postAttempts||0)},salesOrderJournalStatus:c(oj.status)});
}
function CF_V5132_parkNoProgress_(requestId,reason,status){
  try{
    var r=CF.Util&&CF.Util.findRecord?CF.Util.findRecord('SERVICE_REQUESTS','Request ID',requestId):null;
    if(r&&r.__rowNumber&&CF.Util&&CF.Util.patchRow){
      if(typeof CF.Util.clearRowDataValidations==='function')CF.Util.clearRowDataValidations('SERVICE_REQUESTS',r.__rowNumber);
      CF.Util.patchRow('SERVICE_REQUESTS',r.__rowNumber,{'Updated At':CF.Util.nowString?CF.Util.nowString():new Date(),'Current Stage':'NEEDS REVIEW','Request Status':'BLOCKED','Manual Review?':'YES','Manual Review Reason':reason,'Blocking Issue':reason,'Next Action':'REVIEW TECHNICAL RECOVERY STATE','Striven Sync Status':'BLOCKED','Reconciliation Status':status||'TECHNICAL NO PROGRESS — AUTO STOPPED'});
      SpreadsheetApp.flush();
    }
  }catch(e){}
}
function worker(e,invocation) {
    /* CF_SERVICEOPS_V5_10_30_REQUEST_DRIVEN_ORCHESTRATION_R1 */
    var currentUid=clean_(e&&e.triggerUid);
    var finalResult=null;
    var activeRequestId='';
    var finalReason='WORKER_COMPLETE';
    /* CF_SERVICEOPS_V5_10_37_CLEAR_E2E_STEP_LOGS_R1 */
    var executionFunction=clean_(invocation&&invocation.executionFunction)||HANDLER;
    var executionPhase=clean_(invocation&&invocation.phase)||phaseNameForHandler_(executionFunction);
    setFullMode_();
    ensureCutoff_();
    try {
      if(upper_(props_().getProperty(ENABLED))!=='TRUE') {
        finalReason='AUTOMATION_DISABLED';
        finalResult={ok:true,version:VERSION,status:'AUTOMATION_DISABLED',liveWriteExecuted:false};
        return finalResult;
      }

      // The webhook already durably writes/reindexes the fresh Webform + Service Request
      // before kick(requestId). Do NOT invoke the legacy staged-intake batch processor here;
      // that path performs full-batch matching across the eligible backlog.
      var queued=firstQueuedAction_();
      if(!queued) {
        finalReason='IDLE_NO_QUEUED_INCOMING_REQUESTS';
        finalResult={ok:true,version:VERSION,status:'IDLE_NO_QUEUED_INCOMING_REQUESTS',activeFutureTriggers:handlerTriggers_().filter(function(t){return !currentUid||uid_(t)!==currentUid;}).length,liveWriteExecuted:false};
        return finalResult;
      }

      activeRequestId=queued.id;
      var startRow=queued.row||request_(queued.id)||{};
      log_('E2E_STEP_START','RUNNING',queued.id,{executionFunction:executionFunction,phase:executionPhase,customerName:clean_(startRow['Full Name']),currentStage:clean_(startRow['Current Stage']),requestStatus:clean_(startRow['Request Status']),nextAction:clean_(startRow['Next Action']),customerStructureStatus:clean_(startRow['Customer Structure Status']),customerId:clean_(startRow['Matched Customer ID']||startRow['Created Customer ID']),contactId:clean_(startRow['Matched Contact ID']||startRow['Created Contact ID']),locationId:clean_(startRow['Matched Location ID']||startRow['Created Location ID'])},'START '+executionPhase);
      var v5132BeforeBusinessState=CF_V5132_businessState_(request_(queued.id)||queued.row||{});
      var structureResult=CF.AutoCustomerStructure&&typeof CF.AutoCustomerStructure.process==='function'
        ? CF.AutoCustomerStructure.process({requestIds:[queued.id],fastPath:true})
        : {ok:false,status:'CUSTOMER_STRUCTURE_MODULE_MISSING',liveWriteExecuted:false};

      var mismatchedResultIdsV5139=crossRequestResultIdsV5139_(queued.id,structureResult);
      if(mismatchedResultIdsV5139.length){
        var nextIntegrityV5139=scheduleNext_('CROSS_REQUEST_RESULT_REJECTED',currentUid);
        finalReason='CROSS_REQUEST_RESULT_REJECTED';
        finalResult={ok:false,version:VERSION,status:'CROSS_REQUEST_RESULT_REJECTED',requestId:queued.id,rejectedRequestIds:mismatchedResultIdsV5139,structure:structureResult,nextTrigger:nextIntegrityV5139,liveWriteExecuted:!!(structureResult&&structureResult.liveWriteExecuted===true),automaticWriteRetry:false};
        try{log_('REQUEST_ID_INTEGRITY_GUARD','REJECTED_CROSS_REQUEST_RESULT',queued.id,{expectedRequestId:queued.id,resultRequestIds:structureResultRequestIdsV5139_(structureResult),rejectedRequestIds:mismatchedResultIdsV5139,liveWriteExecuted:finalResult.liveWriteExecuted},'Customer-structure result referenced a different request. Current request was not parked or advanced.');}catch(ignoredV5139IntegrityLog){}
        return finalResult;
      }

      if(structureResult&&structureResult.liveWriteExecuted===true) {
        var next2=scheduleNext_('AFTER_CUSTOMER_STRUCTURE_WRITE',currentUid);
        finalReason='CUSTOMER_STRUCTURE_WRITE_COMPLETE';
        finalResult={ok:structureResult.ok!==false,version:VERSION,status:'CUSTOMER_STRUCTURE_WRITE_COMPLETE',requestId:queued.id,structure:structureResult,nextTrigger:next2,liveWriteExecuted:true};
        return finalResult;
      }

      var structureStatus=clean_(structureResult&&structureResult.status);
      var nestedStructureStatus=upper_(structureStepStatus_(structureResult));
      /* CF_SERVICEOPS_V5_13_2_STABILIZATION_R1_ONE_ATTEMPT_CIRCUIT_BREAKER */
      var v5132AfterBusinessState=CF_V5132_businessState_(request_(queued.id)||queued.row||{});
      var v5132OuterStatus=upper_(structureStatus);
      var v5132Unsafe=/UNCERTAIN|AMBIGUOUS|OWNERSHIP_CONFLICT|IDENTITY_CONFLICT|DIRECT_GET_ID_MISMATCH|DIRECT_IDENTITY_CONFLICT|DUPLICATE_CONTACT_IDS_AMBIGUOUS|MANUAL_REVIEW|NEEDS_REVIEW|BLOCKED/.test(nestedStructureStatus+' '+v5132OuterStatus);
      var v5132Transient=v5132OuterStatus==='MATCHING_CACHE_REFRESHED'||v5132OuterStatus==='SKIPPED_ALREADY_RUNNING';
      var v5132SameState=!v5132Transient&&v5132BeforeBusinessState===v5132AfterBusinessState&&!(structureResult&&structureResult.liveWriteExecuted===true);
      if(v5132Unsafe||v5132SameState){
        try{dequeue_(queued.id);}catch(ignoredV5132Dequeue){}
        var v5132Reason=v5132Unsafe?('Unsafe customer/contact reconciliation state '+(nestedStructureStatus||v5132OuterStatus)+' was parked. Automatic continuation is disabled.'):('Customer structure phase produced no measurable business-state progress. Same-phase automatic continuation is disabled after one attempt.');
        CF_V5132_parkNoProgress_(queued.id,v5132Reason,v5132Unsafe?'UNSAFE RECONCILIATION — AUTO PARKED':'TECHNICAL NO PROGRESS — AUTO STOPPED');
        finalReason=v5132Unsafe?'CUSTOMER_STRUCTURE_UNSAFE_STATE_PARKED':'CUSTOMER_STRUCTURE_NO_PROGRESS_PARKED';
        finalResult={ok:false,version:VERSION,status:finalReason,requestId:queued.id,structure:structureResult,nestedStatus:nestedStructureStatus,sameBusinessState:v5132SameState,nextTrigger:{ok:true,scheduled:false,reason:'V5_13_2_ONE_ATTEMPT_CIRCUIT_BREAKER',liveWriteExecuted:false},liveWriteExecuted:false,automaticWriteRetry:false};
        try{log_('V5_13_2_CIRCUIT_BREAKER','PARKED',queued.id,{nestedStatus:nestedStructureStatus,outerStatus:structureStatus,sameBusinessState:v5132SameState},v5132Reason);}catch(ignoredV5132Log){}
        return finalResult;
      }
      if(nestedStructureStatus==='CUSTOMER_RECONCILED_LOCATION_PENDING') {
        var pendingRow=request_(queued.id)||queued.row||{};
        var stall=trackLocationStall_(queued.id,structureResult,pendingRow);
        var others=readQueue_().filter(function(id){return clean_(id)!==clean_(queued.id);});
        if(others.length) {
          var rotated=rotateQueuedRequestToTail_(queued.id);
          var nextFair=scheduleNext_('LOCATION_PENDING_ROTATED_QUEUE_FAIRNESS',currentUid);
          finalReason='LOCATION_RECONCILIATION_DEFERRED_QUEUE_FAIRNESS';
          finalResult={ok:true,version:VERSION,status:'LOCATION_RECONCILIATION_DEFERRED_QUEUE_FAIRNESS',requestId:queued.id,structure:structureResult,stallCount:stall.count,queuedRequestIds:rotated,nextTrigger:nextFair,liveWriteExecuted:false,automaticWriteRetry:false};
          log_('LOCATION_RECONCILIATION_STALL','ROTATED_QUEUE_CONTINUES',queued.id,{stallCount:stall.count,nextRequestId:others[0],queuedRequestIds:rotated},'Location reconciliation is unchanged; moving this request behind other queued work.');
          return finalResult;
        }
        if(stall.count>=LOCATION_STALL_LIMIT) {
          dequeue_(queued.id);
          var parked=parkStalledLocationRequest_(queued.id,stall);
          var remainingAfterPark=readQueue_();
          if(remainingAfterPark.length)parked.nextTrigger=scheduleNext_('AFTER_LOCATION_STALL_PARK',currentUid);
          else parked.nextTrigger={ok:true,scheduled:false,reason:'LOCATION_STALL_PARKED_NO_OTHER_QUEUE',liveWriteExecuted:false};
          finalReason='LOCATION_RECONCILIATION_STALLED_PARKED';
          finalResult=parked;
          return finalResult;
        }
      } else {
        clearLocationStall_(queued.id);
      }
      /* CF_SERVICEOPS_V5_10_32_NO_RETRY_LOOP_ON_AUTOMATION_NOT_INSTALLED_R1 */
      if(structureStatus==='AUTOMATION_NOT_INSTALLED') {
        try{dequeue_(queued.id);}catch(ignoredDequeueConfigBlock){}
        finalReason='AUTOMATION_CONFIGURATION_BLOCKED';
        finalResult={ok:false,version:VERSION,status:'AUTOMATION_CONFIGURATION_BLOCKED',requestId:queued.id,structure:structureResult,nextTrigger:{ok:true,scheduled:false,reason:'NO_RETRY_LOOP_ON_AUTOMATION_NOT_INSTALLED',liveWriteExecuted:false},liveWriteExecuted:false};
        return finalResult;
      }
            /* CF_SERVICEOPS_V5_12_6_SKIP_COMPLETED_STRUCTURE_LOOP_R1 */
      var structureStateV5126=request_(queued.id)||{};
      var structureAlreadyCompleteV5126=upper_(structureStateV5126['Current Stage'])==='CUSTOMER STRUCTURE COMPLETE'&&upper_(structureStateV5126['Customer Structure Status'])==='COMPLETE';
      var transientStructureStatusV5126=['MATCHING_CACHE_REFRESHED','MATCHING_PROCESSED','AUTO_STEP_COMPLETE','SKIPPED_ALREADY_RUNNING'].indexOf(structureStatus)!==-1;
      if(structureStatus!=='FAST_PATH_STRUCTURE_READY_FOR_SALES_ORDER' && transientStructureStatusV5126 && !structureAlreadyCompleteV5126) {
        var next3=scheduleNext_('CONTINUE_CUSTOMER_STRUCTURE_'+structureStatus,currentUid);
        finalReason='CUSTOMER_STRUCTURE_STEP_COMPLETE';
        finalResult={ok:structureResult.ok!==false,version:VERSION,status:'CUSTOMER_STRUCTURE_STEP_COMPLETE',requestId:queued.id,structure:structureResult,nextTrigger:next3,liveWriteExecuted:false};
        return finalResult;
      }

      /* CF_SERVICEOPS_V5_10_34_INFO_SYNC_BEFORE_SALES_ORDER_R2 */
      var infoRow=request_(queued.id);
      var infoReady=!!infoRow&&String(clean_(infoRow['Current Stage'])).toUpperCase()==='CUSTOMER STRUCTURE COMPLETE'&&String(clean_(infoRow['Customer Structure Status'])).toUpperCase()==='COMPLETE';
      if(infoReady){
        var infoSync=CF.CustomerContactInfoSync&&typeof CF.CustomerContactInfoSync.reconcile==='function'
          ? CF.CustomerContactInfoSync.reconcile(queued.id,{autoMode:true})
          : {ok:false,status:'CUSTOMER_CONTACT_INFO_SYNC_MODULE_MISSING',liveWriteExecuted:false};

        // A lock collision is a safe no-write transient condition. Reschedule the
        // worker once rather than continuing to Sales Order without completing sync.
        if(infoSync&&infoSync.status==='INFO_SYNC_SKIPPED_ALREADY_RUNNING'){
          var nextInfoBusy=scheduleNext_('CONTINUE_CUSTOMER_CONTACT_INFO_SYNC_LOCK_BUSY',currentUid);
          finalReason='CUSTOMER_CONTACT_INFO_SYNC_LOCK_BUSY';
          finalResult={ok:true,version:VERSION,status:'CUSTOMER_CONTACT_INFO_SYNC_LOCK_BUSY',requestId:queued.id,infoSync:infoSync,nextTrigger:nextInfoBusy,liveWriteExecuted:false};
          return finalResult;
        }

        // IMPORTANT: failures are evaluated BEFORE write-boundary continuation.
        // A rejected/uncertain POST must never schedule an automatic retry.
        if(!infoSync||infoSync.ok===false){
          /* CF_SERVICEOPS_V5_10_35_AUTOMATIC_READ_ONLY_INFO_RECONCILIATION_R1 */
          var infoStatus=clean_(infoSync&&infoSync.status);
          var readOnlyReconcileEligible=!!(infoSync&&infoSync.remoteWriteMayHaveSucceeded===true&&[
            'CONTACT_INFO_POSTWRITE_VERIFICATION_FAILED_DO_NOT_RETRY',
            'CONTACT_INFO_POST_OUTCOME_UNCERTAIN_GET_FAILED_DO_NOT_RETRY',
            'CUSTOMER_INFO_POSTWRITE_VERIFICATION_FAILED_DO_NOT_RETRY',
            'CUSTOMER_INFO_POST_OUTCOME_UNCERTAIN_GET_FAILED_DO_NOT_RETRY'
          ].indexOf(infoStatus)!==-1);
          if(readOnlyReconcileEligible){
            var nextReadOnly=scheduleNext_('READ_ONLY_RECONCILE_'+infoStatus,currentUid);
            finalReason='CUSTOMER_CONTACT_INFO_READ_ONLY_RECONCILIATION_SCHEDULED';
            finalResult={ok:true,version:VERSION,status:'CUSTOMER_CONTACT_INFO_READ_ONLY_RECONCILIATION_SCHEDULED',requestId:queued.id,infoSync:infoSync,nextTrigger:nextReadOnly,automaticPostRetry:false,liveWriteExecuted:false};
            return finalResult;
          }
          try{dequeue_(queued.id);}catch(ignoredInfoSyncDequeue){}
          finalReason='CUSTOMER_CONTACT_INFO_SYNC_BLOCKED';
          finalResult={ok:false,version:VERSION,status:'CUSTOMER_CONTACT_INFO_SYNC_BLOCKED',requestId:queued.id,infoSync:infoSync||{},nextTrigger:{ok:true,scheduled:false,reason:'INFO_SYNC_BLOCKED_NO_AUTOMATIC_RETRY',liveWriteExecuted:false},liveWriteExecuted:false};
          return finalResult;
        }

        if(infoSync.liveWriteExecuted===true){
          var nextInfo=scheduleNext_('AFTER_CUSTOMER_CONTACT_INFO_SYNC_WRITE',currentUid);
          finalReason='CUSTOMER_CONTACT_INFO_SYNC_WRITE_COMPLETE';
          finalResult={ok:true,version:VERSION,status:'CUSTOMER_CONTACT_INFO_SYNC_WRITE_COMPLETE',requestId:queued.id,infoSync:infoSync,nextTrigger:nextInfo,liveWriteExecuted:true};
          return finalResult;
        }
      }

      var so=autoSalesOrder_(queued.id);
      if(so.status==='WAITING_FOR_CUSTOMER_STRUCTURE'||so.status==='SALES_ORDER_OPERATIONAL_REFRESH_RERUN'||so.status==='SALES_ORDER_READ_ONLY_RECONCILIATION_PENDING') {
        var next4=scheduleNext_('CONTINUE_'+so.status,currentUid);
        so.nextTrigger=next4;
        finalReason=so.status;
        finalResult=so;
        return finalResult;
      }

      var remaining=readQueue_();
      if(remaining.length) so.nextTrigger=scheduleNext_('NEXT_QUEUED_REQUEST',currentUid);
      else so.nextTrigger={ok:true,scheduled:false,reason:'CHAIN_COMPLETE_NO_QUEUED_REQUESTS',liveWriteExecuted:false};
      finalReason=clean_(so&&so.status)||'SALES_ORDER_CHAIN_COMPLETE';
      finalResult=so;
      return finalResult;
    } finally {
      // Exactly one visible-state refresh per worker execution, including safe-stops,
      // successful Sales Order completion, write boundaries, and thrown errors.
      /* CF_SERVICEOPS_V5_10_35_DEFER_CONTINUATION_ONLY_FINAL_QUEUE_REFRESH_R1 */
      var finalStatus=clean_(finalResult&&finalResult.status);
      var continuationOnlyNoWrite=!!(finalResult&&finalResult.liveWriteExecuted!==true&&finalResult.nextTrigger&&finalResult.nextTrigger.scheduled===true&&[
        'CUSTOMER_STRUCTURE_STEP_COMPLETE',
        'WAITING_FOR_CUSTOMER_STRUCTURE',
        'SALES_ORDER_OPERATIONAL_REFRESH_RERUN',
        'CUSTOMER_CONTACT_INFO_SYNC_LOCK_BUSY',
        'CUSTOMER_CONTACT_INFO_READ_ONLY_RECONCILIATION_SCHEDULED',
        'SALES_ORDER_READ_ONLY_RECONCILIATION_PENDING'
      ].indexOf(finalStatus)!==-1);
      var queueRefresh=continuationOnlyNoWrite
        ? {ok:true,status:'DEFERRED_CONTINUATION_ONLY',requestId:clean_(activeRequestId),reason:clean_(finalReason),liveWriteExecuted:false}
        : refreshOperatorQueueSafely_(activeRequestId,finalReason);
      if(finalResult&&typeof finalResult==='object') finalResult.operatorQueueRefresh=queueRefresh;
      var endWork=activeRequestId?request_(activeRequestId):null;
      log_('E2E_STEP_RESULT',finalResult&&finalResult.ok===false?'STOPPED':'COMPLETE',activeRequestId,{executionFunction:executionFunction,phase:executionPhase,resultStatus:clean_(finalResult&&finalResult.status)||'THREW_OR_NO_RESULT',nextHandler:clean_(finalResult&&finalResult.nextTrigger&&finalResult.nextTrigger.handler),nextPhase:clean_(finalResult&&finalResult.nextTrigger&&finalResult.nextTrigger.phase),liveWriteExecuted:!!(finalResult&&finalResult.liveWriteExecuted===true),currentStage:clean_(endWork&&endWork['Current Stage']),requestStatus:clean_(endWork&&endWork['Request Status']),nextAction:clean_(endWork&&endWork['Next Action']),customerId:clean_(endWork&&(endWork['Matched Customer ID']||endWork['Created Customer ID'])),contactId:clean_(endWork&&(endWork['Matched Contact ID']||endWork['Created Contact ID'])),locationId:clean_(endWork&&(endWork['Matched Location ID']||endWork['Created Location ID'])),workOrderId:clean_(endWork&&endWork['Work Order ID']),workOrderNumber:clean_(endWork&&endWork['Work Order Number']),queueRefreshStatus:clean_(queueRefresh&&queueRefresh.status)},'END '+executionPhase+' -> '+clean_(finalResult&&finalResult.status));
    }
  }
  return{version:VERSION,kick:kick,verifySetup:verifySetup,disable:disable,worker:worker,describeQueuedWork:describeQueuedWork_,allHandlerNames:allHandlerNames_,queuedRequestIds:readQueue_};
})();


/* CF_SERVICEOPS_V5_10_10_INLINE_END_TO_END_WORKER_R2
 * Inline continuation wrapper for the v5.10.8 event-driven worker.
 * Cheap stages and no-write transitions continue inside the SAME trigger execution.
 * A future one-shot is retained only when the soft runtime budget is reached or a real
 * Customer/Contact/Operational write requires a clean reconciliation cycle.
 */
(function () {
  'use strict';
  if (!CF.EventDrivenServiceAutomation || typeof CF.EventDrivenServiceAutomation.worker !== 'function') return;
  if (CF.EventDrivenServiceAutomation.__inlineV51010R2) return;
  var baseWorker=CF.EventDrivenServiceAutomation.worker;
  var HANDLER='AUTO_processCustomerStructure';
  var SOFT_BUDGET_MS=240000;
  var MAX_INLINE_STEPS=10;
  var ENABLED='CF_EVENT_DRIVEN_SERVICE_AUTOMATION_ENABLED';
  var AUTO_SALES_ORDER='CF_EVENT_DRIVEN_AUTO_SALES_ORDER';
  var PREPARATION_ONLY='CF_SERVICEOPS_AUTOMATION_PREPARATION_ONLY';
  var STRUCTURE_CUTOFF='CF_AUTO_CUSTOMER_STRUCTURE_CUTOFF_MS';
  var QUEUE_PROP='CF_EVENT_DRIVEN_SERVICE_REQUEST_IDS';
  var INTAKE_STAGE_PROP='CF_SERVICEOPS_V5102_INTAKE_STAGE';
  function clean_(v){return v===null||v===undefined?'':String(v).trim();}
  function uid_(t){try{return clean_(t.getUniqueId());}catch(e){return'';}}
  function triggers_(){return ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction&&t.getHandlerFunction()===HANDLER;});}
  function future_(currentUid){currentUid=clean_(currentUid);return triggers_().filter(function(t){return !currentUid||uid_(t)!==currentUid;});}
  function withInlineTriggerLock_(work){var lock=LockService.getScriptLock();lock.waitLock(30000);try{return work();}finally{lock.releaseLock();}}function clearFutureUnlocked_(currentUid){var rows=future_(currentUid);rows.forEach(function(t){ScriptApp.deleteTrigger(t);});return rows.length;}function clearFuture_(currentUid){return withInlineTriggerLock_(function(){return clearFutureUnlocked_(currentUid);});}
  function scheduleUnlocked_(reason,currentUid){if(future_(currentUid).length)return false;ScriptApp.newTrigger(HANDLER).timeBased().after(10000).create();try{CF.Util.logEvent({module:'70_Workflow_Automation',action:'INLINE_RECOVERY_SCHEDULE',status:'SCHEDULED',message:clean_(reason),version:'5.10.12'});}catch(e){}return true;}function schedule_(reason,currentUid){return withInlineTriggerLock_(function(){return scheduleUnlocked_(reason,currentUid);});}
  function queue_(){var raw=PropertiesService.getScriptProperties().getProperty(QUEUE_PROP);if(!raw)return[];try{var x=JSON.parse(raw);return Array.isArray(x)?x.map(clean_).filter(Boolean):[];}catch(e){return[];}}
  function canContinue_(r){if(!r||r.liveWriteExecuted===true)return false;var s=clean_(r.status);return s==='INTAKE_STAGE_COMPLETE';}
  function decorate_(r,history,started,mode){if(!r||typeof r!=='object')r={ok:true,status:'COMPLETE'};r.version='5.10.10';r.inlineContinuation={mode:mode||'COMPLETE',steps:history,durationMs:Date.now()-started,softBudgetMs:SOFT_BUDGET_MS,queuedRequestIds:queue_(),intakeStage:clean_(PropertiesService.getScriptProperties().getProperty(INTAKE_STAGE_PROP))};return r;}
  CF.EventDrivenServiceAutomation.worker=function(e,invocation){
    e=e||{};var currentUid=clean_(e.triggerUid),started=Date.now(),history=[];
    for(var i=0;i<MAX_INLINE_STEPS;i++){
      var r;
      try{r=baseWorker(e,invocation);}catch(error){try{schedule_('RECOVERY_AFTER_INLINE_WORKER_ERROR',currentUid);}catch(ignored){}throw error;}
      history.push({step:i+1,status:clean_(r&&r.status),liveWriteExecuted:!!(r&&r.liveWriteExecuted),elapsedMs:Date.now()-started});
      if(!canContinue_(r))return decorate_(r,history,started,'TERMINAL_OR_WRITE_BOUNDARY');
      if(Date.now()-started>=SOFT_BUDGET_MS)return decorate_(r,history,started,'DEFERRED_AT_SOFT_RUNTIME_BUDGET');
      clearFuture_(currentUid);
    }
    schedule_('MAX_INLINE_STEPS_REACHED',currentUid);
    return decorate_({ok:true,status:'INLINE_STEP_LIMIT_REACHED',liveWriteExecuted:false},history,started,'DEFERRED_AT_STEP_LIMIT');
  };
  CF.EventDrivenServiceAutomation.verifySetup=function(){
    return withInlineTriggerLock_(function(){
      var p=PropertiesService.getScriptProperties(),existing=triggers_();existing.forEach(function(t){ScriptApp.deleteTrigger(t);});
      p.setProperty(ENABLED,'true');p.setProperty(AUTO_SALES_ORDER,'true');p.setProperty(PREPARATION_ONLY,'false');if(!clean_(p.getProperty(STRUCTURE_CUTOFF)))p.setProperty(STRUCTURE_CUTOFF,String(Date.now()));
      var q=queue_(),stage=clean_(p.getProperty(INTAKE_STAGE_PROP)),scheduled=false;if(q.length||stage){ScriptApp.newTrigger(HANDLER).timeBased().after(10000).create();scheduled=true;}
      return{ok:true,version:'5.10.12',mode:'ATOMIC_REQUEST_SCOPED_SMART_TTL_INLINE_INCOMING_TO_GUARDED_SALES_ORDER',handler:HANDLER,cadence:'NO_PERMANENT_CADENCE',triggerCreatedOnIncomingRequest:true,oneShotChain:true,resumePendingChain:true,preservedQueuedRequestIds:q,activeIntakeStage:stage,removedExistingHandlerTriggers:existing.length,activeHandlerTriggers:triggers_().length,resumeTriggerScheduled:scheduled,preparationOnly:false,automaticCustomerContactWrites:true,automaticSalesOrderCreate:true,standaloneExistingCustomerLocationCreate:true,smartFreshness:{customerMinutes:120,locationMinutes:120,operationalMinutes:30},inlineSoftBudgetSeconds:SOFT_BUDGET_MS/1000,queueConcurrency:'SCRIPT_LOCK_SERIALIZED',customerStructureScope:'QUEUED_REQUEST_ID_ONLY',liveWriteExecuted:false,next:q.length||stage?'PENDING CHAIN RESUMED; DO NOT RUN MANUAL STEPS':'SUBMIT ONE NEW WEBFORM REQUEST'};
    });
  };
  CF.EventDrivenServiceAutomation.__inlineV51010R2=true;
})();


/* CF_SERVICEOPS_V5_10_12_ATOMIC_REQUEST_SCOPED_END_TO_END_R1
 * Atomic queue/trigger lifecycle + exact queued Request ID Customer/Contact processing.
 */


/* CF_SERVICEOPS_V5_10_13_RUNTIME_MATCHING_SO_NOTES_QUEUE_R1 — DEFERRED QUEUE SNAPSHOT */
function AUTO_scheduleQueueSnapshot_() {
  var handler = 'AUTO_refreshQueueSnapshot';
  var existing = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction && t.getHandlerFunction() === handler; });
  if (!existing.length) ScriptApp.newTrigger(handler).timeBased().after(5000).create();
  return { ok:true, deferred:true, scheduled:existing.length===0, handler:handler };
}
function AUTO_refreshQueueSnapshot(e) {
  var uid = e && e.triggerUid ? String(e.triggerUid) : '';
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction && t.getHandlerFunction() === 'AUTO_refreshQueueSnapshot') {
        var id = ''; try { id = String(t.getUniqueId()); } catch (ignored) {}
        if (!uid || !id || id === uid) ScriptApp.deleteTrigger(t);
      }
    });
  } catch (ignoredDelete) {}
  return CF.OperatorQueue && typeof CF.OperatorQueue.refresh === 'function' ? CF.OperatorQueue.refresh() : {ok:false,status:'QUEUE_MODULE_MISSING'};
}

/* CF_SERVICEOPS_V5_10_14_RUNTIME_INTERNAL_NOTES_QUEUE_R1 — SPLIT SALES ORDER INTO FRESH EXECUTION + POST-BOUNDARY QUEUE SNAPSHOT */

/* CF_SERVICEOPS_V5_10_17_INTERNAL_NOTES_HTML_R1 — readable fallback note + safe manufacturer/model rule */


/* CF_SERVICEOPS_V5_11_1_WATCHDOG_PRIORITY_TRIGGER_LIVENESS_R1 — realtime-first recovery and trigger-liveness repair. */
(function(){
  'use strict';
  if(!CF.EventDrivenServiceAutomation)return;
  var WATCHDOG_HANDLER='AUTO_98_E2E_Recovery_Watchdog';
  var QUEUE_PROP='CF_EVENT_DRIVEN_SERVICE_REQUEST_IDS';
  var ENABLED_PROP='CF_EVENT_DRIVEN_SERVICE_AUTOMATION_ENABLED';
  var NEXT_TRIGGER_AT='CF_EVENT_DRIVEN_SERVICE_NEXT_TRIGGER_AT';
  var LAST_KICK='CF_EVENT_DRIVEN_SERVICE_LAST_KICK';
  var LAST_REQUEST='CF_EVENT_DRIVEN_SERVICE_LAST_REQUEST_ID';
  var LOOKBACK_MS=7*24*60*60*1000;
  var EXPLICIT_KICK_GRACE_MS=30*60*1000;
  var TRIGGER_OVERDUE_GRACE_MS=60*1000;
  var TRIGGER_DELAY_MS=10000;
  var PHASE_NAMES=['AUTO_processCustomerStructure','AUTO_00_E2E_Route_Request','AUTO_01_E2E_Customer_Match_Create','AUTO_02_E2E_Location_Reconcile','AUTO_03_E2E_Contact_Create_Recover','AUTO_04_E2E_Customer_Contact_Info_Sync','AUTO_05_E2E_Sales_Order_Create_Verify','AUTO_99_E2E_Safe_Stop_Review'];
  function clean(v){return v===null||v===undefined?'':String(v).trim();}
  function upper(v){return clean(v).toUpperCase();}
  function props(){return PropertiesService.getScriptProperties();}
  function watchdogTriggers(){return ScriptApp.getProjectTriggers().filter(function(t){try{return t.getHandlerFunction&&t.getHandlerFunction()===WATCHDOG_HANDLER;}catch(e){return false;}});}
  function phaseTriggers(){return ScriptApp.getProjectTriggers().filter(function(t){try{return t.getHandlerFunction&&PHASE_NAMES.indexOf(clean(t.getHandlerFunction()))!==-1;}catch(e){return false;}});}
  function deletePhaseTriggers(){var rows=phaseTriggers();rows.forEach(function(t){try{ScriptApp.deleteTrigger(t);}catch(e){}});return rows.length;}
  function ensureWatchdog(){var rows=watchdogTriggers();if(rows.length===1)return{ok:true,installed:true,created:false,count:1};rows.forEach(function(t){try{ScriptApp.deleteTrigger(t);}catch(e){}});ScriptApp.newTrigger(WATCHDOG_HANDLER).timeBased().everyMinutes(5).create();return{ok:true,installed:true,created:true,count:watchdogTriggers().length};}
  function removeWatchdog(){var rows=watchdogTriggers();rows.forEach(function(t){try{ScriptApp.deleteTrigger(t);}catch(e){}});return rows.length;}
  function readQueue(){var raw=props().getProperty(QUEUE_PROP);if(!raw)return[];try{var x=JSON.parse(raw);return Array.isArray(x)?x.map(clean).filter(Boolean):[];}catch(e){return[];}}
  function writeQueue(rows){var seen={},out=[];(rows||[]).forEach(function(id){id=clean(id);if(id&&!seen[id]){seen[id]=true;out.push(id);}});props().setProperty(QUEUE_PROP,JSON.stringify(out));return out;}
  function parseRoot(row){try{return CF.Util.parseJson?CF.Util.parseJson(row['Write Journal JSON'],{}):JSON.parse(String(row['Write Journal JSON']||'{}'));}catch(e){return{};}}
  function knownOrderId(row){var root=parseRoot(row),order=root&&root.salesOrderCreate||{};return clean(row['Work Order ID']||order.canonicalSalesOrderId||order.responseIdentifier);}
  function requestClock(row){
    var id=clean(row&&row['Request ID']),m=id.match(/^SR-(\d{14})-/);
    if(m)return Number(m[1])||0;
    var d=new Date(row&&row['Created At']||row&&row['Submitted At']||0),ms=d.getTime();
    return isNaN(ms)?0:ms;
  }
  function requestAgeMs(row){
    var id=clean(row&&row['Request ID']),m=id.match(/^SR-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-/);
    if(m){var dt=new Date(Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4]),Number(m[5]),Number(m[6]));return Math.max(0,Date.now()-dt.getTime());}
    var d=new Date(row&&row['Created At']||row&&row['Submitted At']||0);return isNaN(d.getTime())?Number.MAX_SAFE_INTEGER:Math.max(0,Date.now()-d.getTime());
  }
  function recentlyExplicitlyKicked(id){var p=props(),lastId=clean(p.getProperty(LAST_REQUEST)),raw=clean(p.getProperty(LAST_KICK)),t=raw?new Date(raw).getTime():0;return lastId===clean(id)&&t>0&&(Date.now()-t)<=EXPLICIT_KICK_GRACE_MS;}
  function terminal(row){return !!(CF.Config&&typeof CF.Config.isTerminalState==='function'&&(CF.Config.isTerminalState(row['Current Stage'])||CF.Config.isTerminalState(row['Final Outcome'])));}
  function falsePreflightParkRecoverableV5139(row){
    if(!row)return false;
    if(upper(row['Current Stage'])!=='NEEDS REVIEW'||upper(row['Request Status'])!=='BLOCKED'||upper(row['Manual Review?'])!=='YES')return false;
    var reason=[row['Manual Review Reason'],row['Blocking Issue'],row['Reconciliation Status']].map(clean).join(' ');
    if(!/PREFLIGHT_BLOCKED/i.test(reason))return false;
    if(upper(row['Duplicate Risk Status'])!=='NONE')return false;
    if(upper(row['Customer Match Status'])!=='NOT FOUND'||upper(row['Customer Action'])!=='CREATE')return false;
    if(upper(row['Contact Action'])!=='CREATE'||upper(row['Location Action'])!=='CREATE'||upper(row['Work Order Action'])!=='CREATE')return false;
    if(clean(row['Matched Customer ID']||row['Created Customer ID']||row['Matched Contact ID']||row['Created Contact ID']||row['Matched Location ID']||row['Created Location ID']||row['Work Order ID']))return false;
    var root=parseRoot(row),targets=['customerCreate','contactCreate','standaloneLocationCreate','salesOrderCreate'];
    for(var i=0;i<targets.length;i++){var x=root&&root[targets[i]]||{};if(Number(x.postAttempts||0)>0||x.remoteWriteMayHaveSucceeded===true)return false;}
    return true;
  }
  function restoreFalsePreflightParkV5139(row){
    if(!falsePreflightParkRecoverableV5139(row))return row;
    CF.Util.patchRow('SERVICE_REQUESTS',row.__rowNumber,{
      'Updated At':CF.Util.nowString(),
      'Current Stage':'READY FOR CUSTOMER CREATE',
      'Request Status':'OPEN',
      'Manual Review?':'NO',
      'Manual Review Reason':'',
      'Blocking Issue':'',
      'Next Action':'CREATE CUSTOMER',
      'Striven Sync Status':'PARTIAL',
      'Striven Sync Error':'',
      'Reconciliation Status':'AUTO-RECOVERED FALSE PREFLIGHT PARK — REQUEST-SCOPED RECHECK REQUIRED'
    });
    try{SpreadsheetApp.flush();}catch(e){}
    var restored=CF.Util.findRecord('SERVICE_REQUESTS','Request ID',clean(row['Request ID']))||row;
    try{CF.Util.logEvent({module:'70_Workflow_Automation',action:'FALSE_PREFLIGHT_PARK_RECOVERY',status:'RESTORED_REQUEST_SCOPED',requestId:clean(row['Request ID']),details:{priorStage:clean(row['Current Stage']),priorStatus:clean(row['Request Status']),nextStage:'READY FOR CUSTOMER CREATE',strivenWriteExecuted:false},version:'5.13.9'});}catch(e){}
    return restored;
  }
  function ledgerRecoverable(row){
    if(!row||terminal(row))return false;
    var risk=upper(row['Duplicate Risk Status']);if(risk&&risk!=='NONE')return false;
    if(requestAgeMs(row)>LOOKBACK_MS)return false; // historical cleanup must not occupy realtime recovery queue
    if(knownOrderId(row))return true; // exact GET certification may clear a false review state
    if(falsePreflightParkRecoverableV5139(row))return true;
    if(upper(row['Manual Review?'])==='YES')return false;
    var status=upper(row['Request Status']);if(['BLOCKED','DUPLICATE','CANCELLED','CANCELED','ERROR'].indexOf(status)!==-1)return false;
    return ['NEW INTAKE','CUSTOMER RESOLVED','READY FOR CUSTOMER CREATE','READY FOR LOCATION CREATE','READY FOR CONTACT CREATE','CREATING CUSTOMER STRUCTURE','CUSTOMER STRUCTURE COMPLETE'].indexOf(upper(row['Current Stage']))!==-1;
  }
  function queuedEligible(id,row){
    if(!row||terminal(row))return false;
    var risk=upper(row['Duplicate Risk Status']);if(risk&&risk!=='NONE')return false;
    if(upper(row['Manual Review?'])==='YES'&&!knownOrderId(row))return false;
    if(requestAgeMs(row)>LOOKBACK_MS&&!recentlyExplicitlyKicked(id))return false;
    var status=upper(row['Request Status']);if(['DUPLICATE','CANCELLED','CANCELED','ERROR'].indexOf(status)!==-1)return false;
    if(status==='BLOCKED'&&!knownOrderId(row))return false;
    return true;
  }
  function sanitizeQueue(){
    var before=readQueue(),kept=[],dropped=[];
    before.forEach(function(id){var row=CF.Util.findRecord('SERVICE_REQUESTS','Request ID',id);if(queuedEligible(id,row))kept.push(id);else dropped.push(id);});
    if(dropped.length)writeQueue(kept);
    return{before:before,kept:kept,dropped:dropped};
  }
  function nextAtMs(){var raw=clean(props().getProperty(NEXT_TRIGGER_AT));if(!raw)return 0;var t=new Date(raw).getTime();return isNaN(t)?0:t;}
  function triggerHealthy(){var rows=phaseTriggers(),at=nextAtMs();if(rows.length!==1||!at)return false;return Date.now()<=at+TRIGGER_OVERDUE_GRACE_MS;}
  function rebuildTrigger(reason){
    var removed=deletePhaseTriggers();
    var work=CF.EventDrivenServiceAutomation.describeQueuedWork?CF.EventDrivenServiceAutomation.describeQueuedWork(reason):{};
    var handler=clean(work.recommendedHandler)||'AUTO_00_E2E_Route_Request';
    ScriptApp.newTrigger(handler).timeBased().after(TRIGGER_DELAY_MS).create();
    var scheduledAt=new Date(Date.now()+TRIGGER_DELAY_MS).toISOString();props().setProperty(NEXT_TRIGGER_AT,scheduledAt);
    try{CF.Util.logEvent({module:'70_Workflow_Automation',action:'E2E_RECOVERY_TRIGGER',status:'REBUILT',requestId:clean(work.requestId),details:{reason:clean(reason),handler:handler,phase:clean(work.recommendedPhase),removedPhaseTriggers:removed,scheduledAt:scheduledAt},version:'5.11.1'});}catch(e){}
    return{ok:true,scheduled:true,handler:handler,phase:clean(work.recommendedPhase),requestId:clean(work.requestId),removedPhaseTriggers:removed,scheduledAt:scheduledAt};
  }
  function newestLedgerCandidate(){
    var rows=CF.Util.readRecords('SERVICE_REQUESTS').filter(ledgerRecoverable);
    rows.sort(function(a,b){return requestClock(b)-requestClock(a);});
    return{row:rows.length?rows[0]:null,count:rows.length};
  }
  function recoveryPreview(){
    var q=readQueue(),candidate=newestLedgerCandidate(),triggers=phaseTriggers(),at=nextAtMs();
    return{ok:true,version:'5.11.1',mode:'READ_ONLY',queuedRequestIds:q,queueHead:q.length?q[0]:'',activePhaseTriggers:triggers.length,nextTriggerAt:at?new Date(at).toISOString():'',triggerHealthy:triggerHealthy(),newestRecoverableRequestId:candidate.row?clean(candidate.row['Request ID']):'',recoverableRecentCount:candidate.count,recoveryLookbackDays:7,recoveryPriority:'NEWEST_FIRST',historicalBacklogOnRealtimeQueue:false,liveWriteExecuted:false};
  }
  function recoveryWatchdog(){
    var p=props();
    if(upper(p.getProperty(ENABLED_PROP))!=='TRUE')return{ok:true,version:'5.11.1',status:'RECOVERY_WATCHDOG_AUTOMATION_DISABLED',liveWriteExecuted:false};
    var lock=LockService.getScriptLock();if(!lock.tryLock(5000))return{ok:true,version:'5.11.1',status:'RECOVERY_WATCHDOG_LOCK_BUSY',liveWriteExecuted:false};
    try{
      var sanitized=sanitizeQueue(),q=sanitized.kept;
      if(sanitized.dropped.length){try{CF.Util.logEvent({module:'70_Workflow_Automation',action:'E2E_RECOVERY_QUEUE_SANITIZE',status:'DROPPED_NON_REALTIME_OR_NONRECOVERABLE',requestId:q.length?q[0]:'',details:{droppedRequestIds:sanitized.dropped,remainingQueuedRequestIds:q},version:'5.11.1'});}catch(e){}}
      if(q.length){
        if(!triggerHealthy()){
          var rebuilt=rebuildTrigger('WATCHDOG_QUEUE_TRIGGER_MISSING_OR_OVERDUE');
          return{ok:true,version:'5.11.1',status:'RECOVERY_TRIGGER_REBUILT_FOR_EXISTING_QUEUE',requestId:q[0],queuedRequestIds:q,rebuild:rebuilt,droppedRequestIds:sanitized.dropped,liveWriteExecuted:false};
        }
        return{ok:true,version:'5.11.1',status:'RECOVERY_QUEUE_HEALTHY',requestId:q[0],queuedRequestIds:q,activePhaseTriggers:phaseTriggers().length,nextTriggerAt:new Date(nextAtMs()).toISOString(),droppedRequestIds:sanitized.dropped,liveWriteExecuted:false};
      }
      // No live queue: remove abandoned phase triggers before selecting realtime recovery work.
      if(phaseTriggers().length)deletePhaseTriggers();
      var candidate=newestLedgerCandidate();
      if(!candidate.row)return{ok:true,version:'5.11.1',status:'RECOVERY_IDLE_NO_RECENT_RECOVERABLE_REQUESTS',recoveryLookbackDays:7,liveWriteExecuted:false};
      var id=clean(candidate.row['Request ID']);if(!id)return{ok:true,version:'5.11.1',status:'RECOVERY_IDLE_REQUEST_ID_MISSING',liveWriteExecuted:false};
      if(falsePreflightParkRecoverableV5139(candidate.row))candidate.row=restoreFalsePreflightParkV5139(candidate.row);
      q=writeQueue([id]);
      var rebuilt2=rebuildTrigger('WATCHDOG_RECOVER_RECENT_DURABLE_LEDGER_NEWEST_FIRST');
      try{CF.Util.logEvent({module:'70_Workflow_Automation',action:'E2E_RECOVERY_WATCHDOG',status:'RECOVERED_RECENT_NEWEST_FIRST',requestId:id,details:{recommendedHandler:rebuilt2.handler,recommendedPhase:rebuilt2.phase,recoverableRecentCount:candidate.count,recoveryLookbackDays:7},version:'5.11.1'});}catch(e){}
      return{ok:true,version:'5.11.1',status:'RECOVERY_REQUEST_REQUEUED',requestId:id,recommendedHandler:rebuilt2.handler,recommendedPhase:rebuilt2.phase,queuedRequestIds:q,recoveryPriority:'NEWEST_FIRST',recoveryLookbackDays:7,liveWriteExecuted:false};
    }finally{lock.releaseLock();}
  }
  var baseKick=CF.EventDrivenServiceAutomation.kick;
  if(typeof baseKick==='function')CF.EventDrivenServiceAutomation.kick=function(requestId){var result=baseKick(requestId);try{result.recoveryWatchdog=ensureWatchdog();}catch(e){result.recoveryWatchdog={ok:false,error:String(e&&e.message||e)};}result.recoveryPriority='REALTIME_QUEUE_THEN_RECENT_NEWEST_FIRST';return result;};
  var baseVerify=CF.EventDrivenServiceAutomation.verifySetup;
  if(typeof baseVerify==='function')CF.EventDrivenServiceAutomation.verifySetup=function(){var result=baseVerify();result.version='5.11.1';result.recoveryWatchdog=ensureWatchdog();try{result.recoveryActivation=recoveryWatchdog();}catch(e){result.recoveryActivation={ok:false,error:String(e&&e.message||e),liveWriteExecuted:false};}result.initialMatchingFreshnessMinutes=240;result.salesOrderCertification='READ_AFTER_WRITE_AUTHORITATIVE';result.recoveryPriority='REALTIME_QUEUE_THEN_RECENT_7_DAYS_NEWEST_FIRST';result.triggerLiveness='NEXT_TRIGGER_AT_OVERDUE_REBUILD';return result;};
  var baseDisable=CF.EventDrivenServiceAutomation.disable;
  if(typeof baseDisable==='function')CF.EventDrivenServiceAutomation.disable=function(){var result=baseDisable();result.recoveryWatchdogTriggersRemoved=removeWatchdog();return result;};
  CF.EventDrivenServiceAutomation.recoveryWatchdog=recoveryWatchdog;
  CF.EventDrivenServiceAutomation.recoveryPreview=recoveryPreview;
  CF.EventDrivenServiceAutomation.ensureRecoveryWatchdog=ensureWatchdog;
  CF.EventDrivenServiceAutomation.reliabilityVersion='5.11.1';
})();

/**
 * CF ServiceOps v5.12.0 — UNDER-10-MINUTE SLO CONTROLLER
 *
 * Additive production patch. This file does not replace any existing module.
 * It wraps CF.EventDrivenServiceAutomation so that deterministic / verified
 * transitions continue in the same Apps Script execution instead of waiting
 * for a one-shot trigger after every phase.
 *
 * Safety contract:
 * - never retries a failed or uncertain remote write;
 * - only continues after ok=true transitions;
 * - clears only future E2E automation phase triggers before an inline step;
 * - leaves the currently executing trigger and unrelated triggers untouched;
 * - retains the existing worker's duplicate prevention / write verification;
 * - stops inline work before the Apps Script hard runtime boundary;
 * - permanent configuration failures are parked once, not retried forever.
 */
(function CF_SERVICEOPS_V5_12_0_UNDER_10_MIN_SLO_R1() {
  'use strict';

  if (typeof CF === 'undefined' || !CF.EventDrivenServiceAutomation ||
      typeof CF.EventDrivenServiceAutomation.worker !== 'function') return;

  var automation = CF.EventDrivenServiceAutomation;
  if (automation.__under10MinuteSloV5120R1) return;

  var VERSION = '5.12.0';
  var RUN_SOFT_BUDGET_MS = 285000;       // 4m45s; preserves ~75s hard-limit reserve.
  var MAX_INLINE_STEPS = 20;
  var SLO_WARNING_MS = 420000;           // 7 minutes.
  var SLO_CRITICAL_MS = 540000;          // 9 minutes.
  var SLO_BREACH_MS = 600000;            // 10 minutes.
  var SLO_HARD_PARK_MS = 900000;         // 15 minutes; do not loop indefinitely.

  var QUEUE_PROP = 'CF_EVENT_DRIVEN_SERVICE_REQUEST_IDS';
  var START_PREFIX = 'CF_SLO_START_';
  var THRESHOLD_PREFIX = 'CF_SLO_THRESHOLD_';

  var originalWorker = automation.worker;
  var originalKick = typeof automation.kick === 'function' ? automation.kick : null;
  var originalVerifySetup = typeof automation.verifySetup === 'function' ? automation.verifySetup : null;

  function clean_(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  function upper_(value) {
    return clean_(value).toUpperCase();
  }

  function props_() {
    return PropertiesService.getScriptProperties();
  }

  function log_(action, status, requestId, details, message) {
    try {
      if (CF.Util && typeof CF.Util.logEvent === 'function') {
        CF.Util.logEvent({
          module: '70_Workflow_Automation',
          action: action,
          status: status,
          requestId: clean_(requestId),
          message: clean_(message),
          details: details || {},
          version: VERSION
        });
      }
    } catch (ignored) {}
  }

  function requestRow_(requestId) {
    try {
      return CF.Util && typeof CF.Util.findRecord === 'function'
        ? CF.Util.findRecord('SERVICE_REQUESTS', 'Request ID', clean_(requestId))
        : null;
    } catch (ignored) {
      return null;
    }
  }

  function describeWork_() {
    try {
      return typeof automation.describeQueuedWork === 'function'
        ? (automation.describeQueuedWork() || {})
        : {};
    } catch (ignored) {
      return {};
    }
  }

  function parseTimestamp_(value) {
    if (!value) return 0;
    if (Object.prototype.toString.call(value) === '[object Date]') {
      var direct = value.getTime();
      return isNaN(direct) ? 0 : direct;
    }
    var parsed = Date.parse(String(value));
    return isNaN(parsed) ? 0 : parsed;
  }

  function requestStartMs_(requestId, row) {
    var id = clean_(requestId);
    if (!id) return Date.now();

    var p = props_();
    var key = START_PREFIX + id;
    var stored = Number(p.getProperty(key) || 0);
    if (stored > 0) return stored;

    row = row || requestRow_(id) || {};
    var inferred = parseTimestamp_(row['Created At']) || parseTimestamp_(row['Submitted At']) || Date.now();
    p.setProperty(key, String(inferred));
    return inferred;
  }

  function thresholdLogged_(requestId, name) {
    return upper_(props_().getProperty(THRESHOLD_PREFIX + clean_(requestId) + '_' + name)) === 'TRUE';
  }

  function markThreshold_(requestId, name) {
    props_().setProperty(THRESHOLD_PREFIX + clean_(requestId) + '_' + name, 'true');
  }

  function emitSloThresholds_(requestId, startMs, phase, resultStatus) {
    var id = clean_(requestId);
    if (!id) return;
    var elapsed = Math.max(0, Date.now() - Number(startMs || Date.now()));
    var checks = [
      { name: 'WARNING_7M', ms: SLO_WARNING_MS, status: 'WARNING' },
      { name: 'CRITICAL_9M', ms: SLO_CRITICAL_MS, status: 'CRITICAL' },
      { name: 'BREACH_10M', ms: SLO_BREACH_MS, status: 'BREACHED' }
    ];
    checks.forEach(function (check) {
      if (elapsed >= check.ms && !thresholdLogged_(id, check.name)) {
        markThreshold_(id, check.name);
        log_('PROCESSING_SLO', check.status, id, {
          elapsedMs: elapsed,
          thresholdMs: check.ms,
          phase: clean_(phase),
          resultStatus: clean_(resultStatus)
        }, 'Processing SLO threshold reached: ' + check.name);
      }
    });
  }

  function clearSloState_(requestId) {
    var id = clean_(requestId);
    if (!id) return;
    var p = props_();
    [
      START_PREFIX + id,
      THRESHOLD_PREFIX + id + '_WARNING_7M',
      THRESHOLD_PREFIX + id + '_CRITICAL_9M',
      THRESHOLD_PREFIX + id + '_BREACH_10M'
    ].forEach(function (key) {
      try { p.deleteProperty(key); } catch (ignored) {}
    });
  }

  function preflight_() {
    var missing = [];
    var p = props_();

    if (!clean_(p.getProperty('STRIVEN_STANDARD_SERVICE_ITEM_ID'))) {
      missing.push('STRIVEN_STANDARD_SERVICE_ITEM_ID');
    }
    if (!CF.Util || typeof CF.Util.findRecord !== 'function' || typeof CF.Util.logEvent !== 'function') {
      missing.push('CF.Util');
    }
    if (!CF.AutoCustomerStructure || typeof CF.AutoCustomerStructure.process !== 'function') {
      missing.push('CF.AutoCustomerStructure.process');
    }
    if (!CF.CustomerContactInfoSync || typeof CF.CustomerContactInfoSync.reconcile !== 'function') {
      missing.push('CF.CustomerContactInfoSync.reconcile');
    }
    if (!CF.OrderPreflight || typeof CF.OrderPreflight.previewRequest !== 'function' ||
        typeof CF.OrderPreflight.approveRequest !== 'function' ||
        typeof CF.OrderPreflight.executeApproved !== 'function') {
      missing.push('CF.OrderPreflight');
    }

    return {
      ok: missing.length === 0,
      version: VERSION,
      status: missing.length ? 'CONFIGURATION_BLOCKED' : 'PREFLIGHT_OK',
      missing: missing
    };
  }

  function readQueue_() {
    var raw = props_().getProperty(QUEUE_PROP);
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(clean_).filter(Boolean) : [];
    } catch (ignored) {
      return [];
    }
  }

  function dequeue_(requestId) {
    var id = clean_(requestId);
    if (!id) return readQueue_();
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var out = readQueue_().filter(function (queuedId) { return clean_(queuedId) !== id; });
      props_().setProperty(QUEUE_PROP, JSON.stringify(out));
      return out;
    } finally {
      lock.releaseLock();
    }
  }

  function patchBlockedRow_(requestId, message, code) {
    var row = requestRow_(requestId);
    if (!row || !row.__rowNumber || !CF.Util || typeof CF.Util.patchRow !== 'function') return;
    try {
      CF.Util.patchRow('SERVICE_REQUESTS', row.__rowNumber, {
        'Updated At': typeof CF.Util.nowString === 'function' ? CF.Util.nowString() : new Date(),
        'Current Stage': 'NEEDS REVIEW',
        'Request Status': 'BLOCKED',
        'Manual Review?': 'YES',
        'Manual Review Reason': message,
        'Blocking Issue': message,
        'Next Action': code === 'SLO_HARD_PARK'
          ? 'REVIEW PROCESSING SLA BREACH — RESUME FROM CURRENT DURABLE STAGE'
          : 'FIX SYSTEM CONFIGURATION — THEN RESUME REQUEST',
        'Striven Sync Status': 'BLOCKED',
        'Striven Sync Error': ''
      });
    } catch (ignored) {}
  }

  function configurationBlock_(requestId, preflight) {
    var id = clean_(requestId);
    var message = 'Automation configuration is incomplete: ' + preflight.missing.join(', ') + '. No automatic retry was scheduled.';
    try { dequeue_(id); } catch (ignoredDequeue) {}
    clearSloState_(id);
    patchBlockedRow_(id, message, 'CONFIGURATION_BLOCKED');
    log_('AUTOMATION_PREFLIGHT', 'CONFIGURATION_BLOCKED', id, {
      missing: preflight.missing,
      automaticRetry: false
    }, message);
    return {
      ok: false,
      version: VERSION,
      status: 'AUTOMATION_CONFIGURATION_BLOCKED',
      requestId: id,
      missingConfiguration: preflight.missing,
      automaticRetry: false,
      liveWriteExecuted: false
    };
  }

  function automationHandlerNames_() {
    var names = [];
    try {
      if (typeof automation.allHandlerNames === 'function') {
        names = automation.allHandlerNames() || [];
      }
    } catch (ignored) {}
    names = names.concat([
      'AUTO_processCustomerStructure',
      'AUTO_00_E2E_Route_Request',
      'AUTO_01_E2E_Customer_Match_Create',
      'AUTO_02_E2E_Location_Reconcile',
      'AUTO_03_E2E_Contact_Create_Recover',
      'AUTO_04_E2E_Customer_Contact_Info_Sync',
      'AUTO_05_E2E_Sales_Order_Create_Verify',
      'AUTO_99_E2E_Safe_Stop_Review'
    ]);
    var seen = {};
    return names.map(clean_).filter(function (name) {
      if (!name || seen[name]) return false;
      seen[name] = true;
      return true;
    });
  }

  function triggerUid_(trigger) {
    try { return clean_(trigger.getUniqueId()); } catch (ignored) { return ''; }
  }

  function clearFuturePhaseTriggers_(currentUid) {
    var uid = clean_(currentUid);
    var names = automationHandlerNames_();
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var removed = 0;
      ScriptApp.getProjectTriggers().forEach(function (trigger) {
        var handler = '';
        try { handler = clean_(trigger.getHandlerFunction && trigger.getHandlerFunction()); } catch (ignoredHandler) {}
        if (names.indexOf(handler) === -1) return;
        var triggerId = triggerUid_(trigger);
        if (uid && triggerId && triggerId === uid) return;
        try {
          ScriptApp.deleteTrigger(trigger);
          removed += 1;
        } catch (ignoredDelete) {}
      });
      return removed;
    } finally {
      lock.releaseLock();
    }
  }

  function nestedStatus_(result) {
    return clean_(
      result && result.structure && result.structure.stepResult && result.structure.stepResult.status ||
      result && result.structure && result.structure.result && result.structure.result.status ||
      ''
    );
  }

  function canContinueInline_(result) {
    if (!result || result.ok === false) return false;

    var status = upper_(result.status);
    var allowedNoWrite = [
      'INTAKE_STAGE_COMPLETE',
      'CUSTOMER_STRUCTURE_STEP_COMPLETE',
      'WAITING_FOR_CUSTOMER_STRUCTURE',
      'SALES_ORDER_OPERATIONAL_REFRESH_RERUN',
      'CUSTOMER_CONTACT_INFO_SYNC_LOCK_BUSY',
      'CUSTOMER_CONTACT_INFO_READ_ONLY_RECONCILIATION_SCHEDULED',
      'INLINE_STEP_LIMIT_REACHED'
    ];
    var allowedVerifiedWrite = [
      'CUSTOMER_STRUCTURE_WRITE_COMPLETE',
      'CUSTOMER_CONTACT_INFO_SYNC_WRITE_COMPLETE'
    ];

    if (result.liveWriteExecuted === true) {
      return allowedVerifiedWrite.indexOf(status) !== -1;
    }
    return allowedNoWrite.indexOf(status) !== -1;
  }

  function hardPark_(requestId, elapsedMs, phase, result) {var id=clean_(requestId),message='Processing exceeded 15 minutes. Automation yielded at the current durable stage and will resume automatically; no operator review is required.';var lock=LockService.getScriptLock();lock.waitLock(30000);try{var q=readQueue_().filter(function(x){return clean_(x)!==id;});q.push(id);props_().setProperty(QUEUE_PROP,JSON.stringify(q));}finally{lock.releaseLock();}clearSloState_(id);props_().setProperty(START_PREFIX+id,String(Date.now()));var names=automationHandlerNames_(),hasFuture=ScriptApp.getProjectTriggers().some(function(t){try{return names.indexOf(clean_(t.getHandlerFunction()))!==-1;}catch(e){return false;}}),handler='AUTO_processCustomerStructure';if(!hasFuture){var work=describeWork_();handler=clean_(work.recommendedHandler)||handler;ScriptApp.newTrigger(handler).timeBased().after(30000).create();}log_('PROCESSING_SLO','AUTO_YIELDED_15M',id,{elapsedMs:elapsedMs,phase:clean_(phase),resultStatus:clean_(result&&result.status),nestedStatus:nestedStatus_(result),automaticRetry:true,manualReview:false,handler:handler},message);return{ok:true,version:VERSION,status:'PROCESSING_SLO_AUTO_YIELDED',requestId:id,elapsedMs:elapsedMs,automaticRetry:true,manualReviewRequired:false,liveWriteExecuted:false};}

  function completionStatus_(result, requestId) {
    var row = requestRow_(requestId) || {};
    if (clean_(row['Work Order ID'])) return true;
    if (result && result.ok === false) return false;
    var status = upper_(result && result.status);
    return status.indexOf('SALES_ORDER_CREATED') !== -1 || status === 'SALES_ORDER_ALREADY_DURABLE';
  }

  function addSloResult_(result, details) {
    result = result && typeof result === 'object' ? result : { ok: true, status: 'COMPLETE' };
    result.processingSlo = details;
    if (!result.version || /^5\.10\./.test(String(result.version))) result.version = VERSION;
    return result;
  }

  automation.worker = function (e, invocation) {
    e = e || {};
    var runStarted = Date.now();
    var currentUid = clean_(e.triggerUid);
    var history = [];
    var lastResult = null;
    var activeRequestId = '';
    var requestStart = 0;

    var initialWork = describeWork_();
    activeRequestId = clean_(initialWork.requestId);
    if (activeRequestId) {
      var initialRow = requestRow_(activeRequestId);
      requestStart = requestStartMs_(activeRequestId, initialRow);
      emitSloThresholds_(activeRequestId, requestStart, initialWork.recommendedPhase, 'START');

      var pf = preflight_();
      if (!pf.ok) return configurationBlock_(activeRequestId, pf);
    }

    for (var step = 0; step < MAX_INLINE_STEPS; step += 1) {
      var before = describeWork_();
      if (!activeRequestId) activeRequestId = clean_(before.requestId);
      if (activeRequestId && !requestStart) requestStart = requestStartMs_(activeRequestId, requestRow_(activeRequestId));

      var phaseBefore = clean_(before.recommendedPhase || invocation && invocation.phase);
      var stepStarted = Date.now();

      lastResult = originalWorker.call(automation, e, invocation);

      var stepDuration = Date.now() - stepStarted;
      var totalElapsed = activeRequestId && requestStart ? Date.now() - requestStart : 0;
      var after = describeWork_();
      var phaseAfter = clean_(after.recommendedPhase);
      var status = clean_(lastResult && lastResult.status);

      history.push({
        step: step + 1,
        phaseBefore: phaseBefore,
        phaseAfter: phaseAfter,
        status: status,
        nestedStatus: nestedStatus_(lastResult),
        activeMs: stepDuration,
        totalElapsedMs: totalElapsed,
        liveWriteExecuted: !!(lastResult && lastResult.liveWriteExecuted === true)
      });

      log_('SLO_STEP_TIMING', 'COMPLETE', activeRequestId, history[history.length - 1], '');
      emitSloThresholds_(activeRequestId, requestStart, phaseAfter || phaseBefore, status);

      if (completionStatus_(lastResult, activeRequestId)) {
        log_('PROCESSING_SLO', totalElapsed <= SLO_BREACH_MS ? 'ACHIEVED_UNDER_10M' : 'COMPLETED_AFTER_BREACH', activeRequestId, {
          totalElapsedMs: totalElapsed,
          runDurationMs: Date.now() - runStarted,
          inlineSteps: history.length,
          finalStatus: status,
          history: history
        }, 'Sales Order is durable.');
        clearSloState_(activeRequestId);
        return addSloResult_(lastResult, {
          targetMs: SLO_BREACH_MS,
          achieved: totalElapsed <= SLO_BREACH_MS,
          totalElapsedMs: totalElapsed,
          runDurationMs: Date.now() - runStarted,
          mode: 'COMPLETE',
          steps: history
        });
      }

      if (activeRequestId && totalElapsed >= SLO_HARD_PARK_MS && canContinueInline_(lastResult)) {
        return hardPark_(activeRequestId, totalElapsed, phaseAfter || phaseBefore, lastResult);
      }

      if (!canContinueInline_(lastResult)) {
        return addSloResult_(lastResult, {
          targetMs: SLO_BREACH_MS,
          achieved: false,
          totalElapsedMs: totalElapsed,
          runDurationMs: Date.now() - runStarted,
          mode: 'TERMINAL_OR_GUARDED_BOUNDARY',
          steps: history
        });
      }

      if (Date.now() - runStarted >= RUN_SOFT_BUDGET_MS) {
        // The wrapped worker already scheduled its normal continuation. Keep it.
        log_('SLO_INLINE_CONTINUATION', 'DEFERRED_RUNTIME_BUDGET', activeRequestId, {
          runDurationMs: Date.now() - runStarted,
          totalElapsedMs: totalElapsed,
          status: status,
          nextTrigger: lastResult && lastResult.nextTrigger || null
        }, 'Inline runtime budget reached; retaining one normal continuation trigger.');
        return addSloResult_(lastResult, {
          targetMs: SLO_BREACH_MS,
          achieved: false,
          totalElapsedMs: totalElapsed,
          runDurationMs: Date.now() - runStarted,
          mode: 'DEFERRED_RUNTIME_BUDGET',
          steps: history
        });
      }

      // The current result is verified/safe to continue. Remove only the future
      // phase trigger that the old worker scheduled, then run the next durable stage now.
      var removed = clearFuturePhaseTriggers_(currentUid);
      log_('SLO_INLINE_CONTINUATION', 'CONTINUING_INLINE', activeRequestId, {
        removedFuturePhaseTriggers: removed,
        priorStatus: status,
        nestedStatus: nestedStatus_(lastResult),
        nextPhase: phaseAfter,
        runDurationMs: Date.now() - runStarted,
        totalElapsedMs: totalElapsed
      }, 'Safe next stage is known; continuing without timer wait.');

      if (lastResult && lastResult.liveWriteExecuted === true) {
        // Short settle only; no write retry. The next worker invocation performs
        // normal durable reconciliation using IDs/state already written by the existing modules.
        Utilities.sleep(250);
      }

      invocation = {
        executionFunction: clean_(after.recommendedHandler) || clean_(invocation && invocation.executionFunction),
        phase: phaseAfter || clean_(invocation && invocation.phase)
      };
      e = {}; // Subsequent inline steps are not separate trigger invocations.
      currentUid = '';
    }

    // Do not clear the last result's scheduled continuation at the step limit.
    log_('SLO_INLINE_CONTINUATION', 'DEFERRED_STEP_LIMIT', activeRequestId, {
      inlineSteps: history.length,
      runDurationMs: Date.now() - runStarted,
      totalElapsedMs: activeRequestId && requestStart ? Date.now() - requestStart : 0
    }, 'Maximum inline step count reached; retaining normal continuation.');

    return addSloResult_(lastResult || { ok: true, status: 'INLINE_STEP_LIMIT_REACHED', liveWriteExecuted: false }, {
      targetMs: SLO_BREACH_MS,
      achieved: false,
      totalElapsedMs: activeRequestId && requestStart ? Date.now() - requestStart : 0,
      runDurationMs: Date.now() - runStarted,
      mode: 'DEFERRED_STEP_LIMIT',
      steps: history
    });
  };

  if (originalKick) {
    automation.kick = function (requestId) {
      var id = clean_(requestId);
      var pf = preflight_();
      if (!pf.ok) return configurationBlock_(id, pf);
      requestStartMs_(id, requestRow_(id));
      var result = originalKick.apply(automation, arguments);
      if (result && typeof result === 'object') {
        result.version = VERSION;
        result.processingSloTargetMinutes = 10;
        result.inlineContinuationEnabled = true;
      }
      return result;
    };
  }

  if (originalVerifySetup) {
    automation.verifySetup = function () {
      var pf = preflight_();
      if (!pf.ok) {
        return {
          ok: false,
          version: VERSION,
          status: 'AUTOMATION_CONFIGURATION_BLOCKED',
          missingConfiguration: pf.missing,
          automaticRetry: false,
          liveWriteExecuted: false
        };
      }
      // The legacy v5.10 inline setup only knows AUTO_processCustomerStructure.
      // Production now uses named E2E phase handlers as well, so remove the full
      // known E2E one-shot set before the existing setup creates at most one resume trigger.
      var removedPhaseTriggers = clearFuturePhaseTriggers_('');
      var result = originalVerifySetup.apply(automation, arguments);
      if (result && typeof result === 'object') {
        result.version = VERSION;
        result.removedPreSetupE2EPhaseTriggers = removedPhaseTriggers;
        result.processingSlo = {
          targetMinutes: 10,
          warningMinutes: 7,
          criticalMinutes: 9,
          hardParkMinutes: 15,
          runSoftBudgetSeconds: RUN_SOFT_BUDGET_MS / 1000,
          maxInlineSteps: MAX_INLINE_STEPS,
          inlineVerifiedWrites: true,
          noUncertainWriteRetry: true
        };
      }
      return result;
    };
  }

  automation.processingSloPreflight = preflight_;
  automation.processingSloConfig = function () {
    return {
      version: VERSION,
      targetMs: SLO_BREACH_MS,
      warningMs: SLO_WARNING_MS,
      criticalMs: SLO_CRITICAL_MS,
      hardParkMs: SLO_HARD_PARK_MS,
      runSoftBudgetMs: RUN_SOFT_BUDGET_MS,
      maxInlineSteps: MAX_INLINE_STEPS
    };
  };
  automation.__under10MinuteSloV5120R1 = true;

})();

/**
 * One-time safe enable/resume runner after the v5.12.0 patch is saved.
 * This changes trigger/config state only; it does not directly create a Striven record.
 */
function FIX_20260903_enableUnder10SloAndResume() {
  var automation = CF && CF.EventDrivenServiceAutomation;
  if (!automation || !automation.__under10MinuteSloV5120R1) {
    throw new Error('v5.12.0 UNDER-10 SLO patch is not loaded. Save the patch at the END of 70_Workflow_Automation.gs first.');
  }
  var preflight = typeof automation.processingSloPreflight === 'function' ? automation.processingSloPreflight() : {ok:false,status:'PREFLIGHT_UNAVAILABLE'};
  if (!preflight.ok) return {ok:false,version:'5.12.0',status:'CONFIGURATION_BLOCKED',preflight:preflight,liveWriteExecuted:false};
  var setup = typeof automation.verifySetup === 'function' ? automation.verifySetup() : {ok:false,status:'VERIFY_SETUP_UNAVAILABLE'};
  var work = typeof automation.describeQueuedWork === 'function' ? automation.describeQueuedWork() : {};
  return {
    ok: setup && setup.ok !== false,
    version: '5.12.0',
    status: 'UNDER_10_SLO_ENABLED_AND_QUEUE_RESUME_CHECKED',
    preflight: preflight,
    setup: setup,
    nextQueuedWork: work,
    liveWriteExecuted: false
  };
}

/** Read-only verification runner. */
function TESTING_20260903_under10SloStatus() {
  var automation = CF && CF.EventDrivenServiceAutomation;
  return {
    ok: !!(automation && automation.__under10MinuteSloV5120R1),
    version: '5.12.0',
    config: automation && typeof automation.processingSloConfig === 'function' ? automation.processingSloConfig() : null,
    preflight: automation && typeof automation.processingSloPreflight === 'function' ? automation.processingSloPreflight() : null,
    queuedWork: automation && typeof automation.describeQueuedWork === 'function' ? automation.describeQueuedWork() : null,
    liveWriteExecuted: false
  };
}

/**
 * CF ServiceOps v5.12.6 — WORKFLOW STABILITY / ATTEMPT CLOCK R1
 *
 * Additive wrapper loaded AFTER v5.12.0.
 * Separates the business end-to-end timer from the active automation-attempt
 * timer. Explicit kick() starts a new active attempt but preserves the original
 * request/submission timestamp for true business SLO reporting.
 *
 * Safety:
 * - no direct Striven write;
 * - no automatic clearing of genuine identity/duplicate review states;
 * - active attempt timer survives normal one-shot continuations;
 * - human review/wait time does not cause the next resume to hard-park instantly;
 * - v5.12.0 uncertain-write protections remain the write boundary authority.
 */
(function CF_SERVICEOPS_V5_12_6_WORKFLOW_STABILITY_R1() {
  'use strict';

  if (typeof CF === 'undefined' || !CF.EventDrivenServiceAutomation ||
      typeof CF.EventDrivenServiceAutomation.worker !== 'function') return;

  var automation = CF.EventDrivenServiceAutomation;
  if (automation.__workflowStabilityV5126R1) return;

  var VERSION = '5.12.6';
  var LEGACY_SLO_START_PREFIX = 'CF_SLO_START_';
  var LEGACY_THRESHOLD_PREFIX = 'CF_SLO_THRESHOLD_';
  var BUSINESS_START_PREFIX = 'CF_V5126_BUSINESS_START_';
  var ATTEMPT_START_PREFIX = 'CF_V5126_ATTEMPT_START_';
  var LAST_ACTIVITY_PREFIX = 'CF_V5126_ATTEMPT_ACTIVITY_';

  var originalWorker = automation.worker;
  var originalKick = typeof automation.kick === 'function' ? automation.kick : null;

  function clean_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
  function upper_(v) { return clean_(v).toUpperCase(); }
  function props_() { return PropertiesService.getScriptProperties(); }
  function row_(id) {
    try { return CF.Util && typeof CF.Util.findRecord === 'function' ? CF.Util.findRecord('SERVICE_REQUESTS', 'Request ID', clean_(id)) : null; }
    catch (ignored) { return null; }
  }
  function parseMs_(v) {
    if (!v) return 0;
    if (Object.prototype.toString.call(v) === '[object Date]') {
      var n = v.getTime();
      return isNaN(n) ? 0 : n;
    }
    var p = Date.parse(String(v));
    return isNaN(p) ? 0 : p;
  }
  function log_(action, status, requestId, details, message) {
    try {
      if (CF.Util && typeof CF.Util.logEvent === 'function') {
        CF.Util.logEvent({
          module: '70_Workflow_Automation', action: action, status: status,
          requestId: clean_(requestId), message: clean_(message),
          details: details || {}, version: VERSION
        });
      }
    } catch (ignored) {}
  }
  function queuedWork_() {
    try { return typeof automation.describeQueuedWork === 'function' ? (automation.describeQueuedWork() || {}) : {}; }
    catch (ignored) { return {}; }
  }
  function businessStart_(id, record) {
    id = clean_(id);
    if (!id) return Date.now();
    var p = props_(), key = BUSINESS_START_PREFIX + id;
    var stored = Number(p.getProperty(key) || 0);
    if (stored > 0) return stored;
    record = record || row_(id) || {};
    var inferred = parseMs_(record['Submitted At']) || parseMs_(record['Created At']) || Date.now();
    p.setProperty(key, String(inferred));
    return inferred;
  }
  function clearLegacyThresholds_(id) {
    var p = props_();
    ['WARNING_7M','CRITICAL_9M','BREACH_10M'].forEach(function (name) {
      try { p.deleteProperty(LEGACY_THRESHOLD_PREFIX + clean_(id) + '_' + name); } catch (ignored) {}
    });
  }
  function startAttempt_(id, reason) {
    id = clean_(id);
    if (!id) return 0;
    var now = Date.now(), p = props_();
    businessStart_(id, row_(id));
    p.setProperty(ATTEMPT_START_PREFIX + id, String(now));
    p.setProperty(LAST_ACTIVITY_PREFIX + id, String(now));
    // v5.12.0 reads this legacy property for its 7/9/10/15-minute decisions.
    // Point it at the ACTIVE attempt, not the original submission timestamp.
    p.setProperty(LEGACY_SLO_START_PREFIX + id, String(now));
    clearLegacyThresholds_(id);
    log_('AUTOMATION_ATTEMPT_CLOCK', 'STARTED', id, {
      attemptStartMs: now,
      businessStartMs: businessStart_(id, row_(id)),
      reason: clean_(reason)
    }, 'Active automation-attempt clock started; original business timestamp preserved separately.');
    return now;
  }
  function ensureAttempt_(id) {
    id = clean_(id);
    if (!id) return 0;
    var p = props_(), key = ATTEMPT_START_PREFIX + id;
    var started = Number(p.getProperty(key) || 0);
    if (!(started > 0)) started = startAttempt_(id, 'WORKER_WITHOUT_EXPLICIT_KICK');
    else {
      p.setProperty(LEGACY_SLO_START_PREFIX + id, String(started));
      p.setProperty(LAST_ACTIVITY_PREFIX + id, String(Date.now()));
    }
    return started;
  }
  function clearAttempt_(id) {
    id = clean_(id); if (!id) return;
    var p = props_();
    [ATTEMPT_START_PREFIX + id, LAST_ACTIVITY_PREFIX + id, LEGACY_SLO_START_PREFIX + id].forEach(function (k) {
      try { p.deleteProperty(k); } catch (ignored) {}
    });
    clearLegacyThresholds_(id);
  }
  function clearBusiness_(id) {
    try { props_().deleteProperty(BUSINESS_START_PREFIX + clean_(id)); } catch (ignored) {}
  }
  function hasDurableWorkOrder_(record) { return !!clean_(record && record['Work Order ID']); }
  function isReviewPause_(record) {
    var stage = upper_(record && record['Current Stage']);
    var status = upper_(record && record['Request Status']);
    var manual = upper_(record && record['Manual Review?']);
    return stage === 'NEEDS REVIEW' || status === 'BLOCKED' || manual === 'YES';
  }
  function hasScheduledContinuation_(result) {
    return !!(result && result.nextTrigger && result.nextTrigger.scheduled === true);
  }
  function decorate_(result, id, attemptStart, businessStart) {
    if (!result || typeof result !== 'object') result = { ok: true, status: 'COMPLETE' };
    var now = Date.now();
    result.workflowStability = {
      version: VERSION,
      automationAttemptElapsedMs: Math.max(0, now - Number(attemptStart || now)),
      businessEndToEndElapsedMs: Math.max(0, now - Number(businessStart || now)),
      businessTargetMs: 600000,
      hardParkClockBasis: 'ACTIVE_AUTOMATION_ATTEMPT_ONLY',
      humanReviewWaitExcludedFromHardPark: true
    };
    if (result.processingSlo && typeof result.processingSlo === 'object') {
      result.processingSlo.automationAttemptElapsedMs = result.workflowStability.automationAttemptElapsedMs;
      result.processingSlo.businessEndToEndElapsedMs = result.workflowStability.businessEndToEndElapsedMs;
      result.processingSlo.businessAchievedUnder10Minutes = result.workflowStability.businessEndToEndElapsedMs <= 600000;
      result.processingSlo.hardParkClockBasis = 'ACTIVE_AUTOMATION_ATTEMPT_ONLY';
    }
    if (!result.version || /^5\.1[01]\./.test(String(result.version))) result.version = VERSION;
    return result;
  }

  automation.worker = function (e, invocation) {
    var work = queuedWork_();
    var id = clean_(work.requestId);
    var attemptStart = id ? ensureAttempt_(id) : Date.now();
    var businessStart = id ? businessStart_(id, row_(id)) : Date.now();
    var result = originalWorker.call(automation, e || {}, invocation);
    var after = id ? (row_(id) || {}) : {};
    result = decorate_(result, id, attemptStart, businessStart);

    if (id && hasDurableWorkOrder_(after)) {
      log_('BUSINESS_E2E_SLO', result.workflowStability.businessEndToEndElapsedMs <= 600000 ? 'ACHIEVED_UNDER_10M' : 'COMPLETED_AFTER_10M', id, {
        businessElapsedMs: result.workflowStability.businessEndToEndElapsedMs,
        automationAttemptElapsedMs: result.workflowStability.automationAttemptElapsedMs,
        workOrderId: clean_(after['Work Order ID']),
        workOrderNumber: clean_(after['Work Order Number'])
      }, 'Durable Sales Order reached; business and automation-attempt timings recorded separately.');
      clearAttempt_(id);
      clearBusiness_(id);
    } else if (id && isReviewPause_(after)) {
      log_('AUTOMATION_ATTEMPT_CLOCK', 'PAUSED_FOR_REVIEW', id, {
        automationAttemptElapsedMs: result.workflowStability.automationAttemptElapsedMs,
        businessElapsedMs: result.workflowStability.businessEndToEndElapsedMs,
        stage: clean_(after['Current Stage']),
        nextAction: clean_(after['Next Action'])
      }, 'Automation attempt ended at a review boundary. A later explicit resume starts a fresh active-attempt clock.');
      clearAttempt_(id);
    } else if (id && !hasScheduledContinuation_(result) && result && result.ok === false) {
      clearAttempt_(id);
    }
    return result;
  };

  if (originalKick) {
    automation.kick = function (requestId) {
      var id = clean_(requestId);
      var attemptStart = startAttempt_(id, 'EXPLICIT_KICK');
      var businessStart = businessStart_(id, row_(id));
      var result = originalKick.apply(automation, arguments);
      result = decorate_(result, id, attemptStart, businessStart);
      if (result && typeof result === 'object') {
        result.version = VERSION;
        result.activeAttemptClockReset = true;
        result.businessClockPreserved = true;
      }
      return result;
    };
  }

  automation.workflowStabilityConfig = function () {
    return {
      version: VERSION,
      businessTargetMinutes: 10,
      hardParkMinutes: 15,
      hardParkClockBasis: 'ACTIVE_AUTOMATION_ATTEMPT_ONLY',
      businessClockBasis: 'ORIGINAL_SUBMISSION_OR_REQUEST_CREATION',
      explicitKickStartsNewAttempt: true,
      normalOneShotContinuationKeepsSameAttempt: true,
      humanReviewWaitExcludedFromHardPark: true
    };
  };
  automation.__workflowStabilityV5126R1 = true;

})();

/* CF_SERVICEOPS_V5_12_8_FAIR_MONOTONIC_ORCHESTRATION_R1 */
(function(){
  'use strict';
  if(typeof CF==='undefined'||!CF.EventDrivenServiceAutomation||!CF.Util)return;
  var a=CF.EventDrivenServiceAutomation;if(a.__fairMonotonicV5128R1)return;
  var originalWorker=a.worker,originalPatchRow=CF.Util.patchRow,QUEUE='CF_EVENT_DRIVEN_SERVICE_REQUEST_IDS',NP='CF_V5128_NOPROGRESS_';
  function clean_(v){return v===null||v===undefined?'':String(v).trim();}
  function upper_(v){return clean_(v).toUpperCase();}
  function props_(){return PropertiesService.getScriptProperties();}
  function row_(id){try{return CF.Util.findRecord('SERVICE_REQUESTS','Request ID',clean_(id));}catch(e){return null;}}
  function journal_(r){try{return JSON.parse(clean_(r&&r['Write Journal JSON'])||'{}')||{};}catch(e){return{};}}
  function verifiedSo_(r){
    if(!r||!clean_(r['Work Order ID']))return false;
    var risk=upper_(r['Duplicate Risk Status']);if(risk&&risk!=='NONE')return false;
    var j=journal_(r),o=j.salesOrderCreate||{},s=upper_(o.status),recon=upper_(r['Reconciliation Status']);
    if(s==='SALES_ORDER_CREATED_IDENTITY_REVIEW'||recon.indexOf('REVIEW REQUIRED')!==-1)return false;
    return s==='SALES_ORDER_CREATED_QUOTED_VERIFIED_AUTO_CONTINUE'||recon==='SALES ORDER CREATED QUOTED — VERIFIED'||(upper_(r['Work Order Status']).indexOf('QUOT')!==-1&&clean_(r['Work Order ID']));
  }
  function successPatch_(p){var o={};Object.keys(p||{}).forEach(function(k){o[k]=p[k];});o['Current Stage']='SALES ORDER CREATED';o['Request Status']='OPEN';o['Manual Review?']='NO';o['Manual Review Reason']='';o['Blocking Issue']='';o['Next Action']='SCHEDULE SERVICE';o['Work Order Action']='LINK EXISTING';o['Striven Sync Status']='SYNCED';o['Striven Sync Error']='';o['Reconciliation Status']='SALES ORDER CREATED QUOTED — VERIFIED';return o;}
  CF.Util.patchRow=function(sheetKey,rowNumber,patch){
    if(sheetKey==='SERVICE_REQUESTS'&&patch&&typeof patch==='object'){
      var rows=[];try{rows=CF.Util.readRecords('SERVICE_REQUESTS')||[];}catch(e){}
      var r=rows.filter(function(x){return Number(x.__rowNumber)===Number(rowNumber);})[0];
      var downgrade=upper_(patch['Current Stage'])==='NEEDS REVIEW'||upper_(patch['Manual Review?'])==='YES'||upper_(patch['Next Action']).indexOf('MANUAL REVIEW SALES ORDER')!==-1;
      if(downgrade&&verifiedSo_(r))patch=successPatch_(patch);
    }
    return originalPatchRow.apply(CF.Util,[sheetKey,rowNumber,patch]);
  };
  function repairSo_(id){var r=row_(id);if(!verifiedSo_(r))return false;var wrong=upper_(r['Current Stage'])!=='SALES ORDER CREATED'||upper_(r['Manual Review?'])==='YES'||upper_(r['Next Action'])!=='SCHEDULE SERVICE';if(!wrong)return false;originalPatchRow.call(CF.Util,'SERVICE_REQUESTS',r.__rowNumber,successPatch_({'Updated At':CF.Util.nowString()}));return true;}
  function q_(){var raw=props_().getProperty(QUEUE);if(!raw)return[];try{var x=JSON.parse(raw);return Array.isArray(x)?x.map(clean_).filter(Boolean):[];}catch(e){return[];}}
  function writeQ_(rows){var seen={},out=[];(rows||[]).forEach(function(id){id=clean_(id);if(id&&!seen[id]){seen[id]=true;out.push(id);}});props_().setProperty(QUEUE,JSON.stringify(out));return out;}
  function ensureQueuedTail_(id){var lock=LockService.getScriptLock();lock.waitLock(30000);try{var q=q_().filter(function(x){return x!==id;});q.push(id);return writeQ_(q);}finally{lock.releaseLock();}}
  function handlerNames_(){try{return typeof a.allHandlerNames==='function'?(a.allHandlerNames()||[]):[];}catch(e){return[];}}
  function futureTriggerExists_(){var names=handlerNames_();if(!names.length)names=['AUTO_processCustomerStructure'];return ScriptApp.getProjectTriggers().some(function(t){try{return names.indexOf(clean_(t.getHandlerFunction()))!==-1;}catch(e){return false;}});}
  function ensureTrigger_(reason){
    if(futureTriggerExists_())return{created:false,handler:''};
    var work={};try{work=typeof a.describeQueuedWork==='function'?(a.describeQueuedWork(reason)||{}):{};}catch(e){}
    var handler=clean_(work.recommendedHandler)||'AUTO_processCustomerStructure';ScriptApp.newTrigger(handler).timeBased().after(30000).create();return{created:true,handler:handler};
  }
  function sig_(r){return [upper_(r&&r['Current Stage']),upper_(r&&r['Customer Structure Status']),upper_(r&&r['Next Action']),clean_(r&&(r['Matched Customer ID']||r['Created Customer ID'])),clean_(r&&(r['Matched Contact ID']||r['Created Contact ID'])),clean_(r&&(r['Matched Location ID']||r['Created Location ID'])),clean_(r&&r['Work Order ID'])].join('|');}
  function technicalReview_(r){var t=clean_(r&&r['Manual Review Reason'])+' '+clean_(r&&r['Blocking Issue']);return /Processing exceeded 15 minutes|SLA BREACH|LOCATION_RECONCILIATION_STALLED_PARKED/i.test(t);}
  function genuineReview_(r){if(!r)return false;if(verifiedSo_(r)||technicalReview_(r))return false;var risk=upper_(r['Duplicate Risk Status']);if(risk&&risk!=='NONE')return true;return upper_(r['Manual Review?'])==='YES'||upper_(r['Request Status'])==='BLOCKED';}
  function resetAttempt_(id){var now=Date.now(),p=props_();['CF_V5126_ATTEMPT_START_','CF_V5126_ATTEMPT_ACTIVITY_','CF_SLO_START_'].forEach(function(prefix){p.setProperty(prefix+id,String(now));});}
  function locationPreStep_(id,r){
    if(!r||upper_(r['Current Stage'])!=='READY FOR LOCATION CREATE'||upper_(r['Manual Review?'])==='YES')return null;
    var risk=upper_(r['Duplicate Risk Status']);if(risk&&risk!=='NONE')return null;
    if(!CF.StandaloneLocationCreateV5128||typeof CF.StandaloneLocationCreateV5128.process!=='function')return null;
    return CF.StandaloneLocationCreateV5128.process(id,{autoMode:true});
  }
  a.worker=function(e,invocation){
    var beforeWork={};try{beforeWork=typeof a.describeQueuedWork==='function'?(a.describeQueuedWork()||{}):{};}catch(x){}
    var id=clean_(beforeWork.requestId),before=row_(id),beforeSig=sig_(before);
    if(id)repairSo_(id);
    var locationResult=id?locationPreStep_(id,row_(id)):null;
    if(locationResult){
      if(locationResult.liveWriteExecuted===true){var trg=ensureTrigger_('AFTER_STANDALONE_LOCATION_WRITE');locationResult.nextTrigger={ok:true,scheduled:true,createdNow:trg.created,handler:trg.handler,reason:'AFTER_STANDALONE_LOCATION_WRITE'};return locationResult;}
      if(['LOCATION_EXISTING_RECONCILED','LOCATION_CREATED_RECONCILED','LOCATION_ALREADY_DURABLE'].indexOf(clean_(locationResult.status))===-1){
        var q0=ensureQueuedTail_(id),trg0=ensureTrigger_('STANDALONE_LOCATION_RECONCILE_BACKOFF');resetAttempt_(id);locationResult.queuedRequestIds=q0;locationResult.nextTrigger={ok:true,scheduled:true,createdNow:trg0.created,handler:trg0.handler,reason:'STANDALONE_LOCATION_RECONCILE_BACKOFF'};return locationResult;
      }
      before=row_(id);beforeSig=sig_(before);
    }
    var result=originalWorker.call(a,e||{},invocation);
    if(!id)id=clean_(result&&result.requestId);if(id)repairSo_(id);
    var after=row_(id);
    if(id&&after&&!clean_(after['Work Order ID'])&&!genuineReview_(after)&&result&&result.liveWriteExecuted!==true){
      var key=NP+id,prior={};try{prior=JSON.parse(props_().getProperty(key)||'{}')||{};}catch(x){}
      var nowSig=sig_(after),count=(beforeSig===nowSig&&prior.signature===nowSig)?Number(prior.count||0)+1:(beforeSig===nowSig?1:0);
      if(count>=2){
        props_().setProperty(key,JSON.stringify({signature:nowSig,count:count,lastYieldAt:new Date().toISOString()}));
        var queue=ensureQueuedTail_(id),trg=ensureTrigger_('FAIR_QUEUE_TECHNICAL_YIELD');resetAttempt_(id);
        return{ok:true,version:'5.12.8',status:'TECHNICAL_NO_PROGRESS_AUTO_YIELDED',requestId:id,priorResultStatus:clean_(result&&result.status),noProgressCount:count,queuedRequestIds:queue,nextTrigger:{ok:true,scheduled:true,createdNow:trg.created,handler:trg.handler,reason:'FAIR_QUEUE_TECHNICAL_YIELD'},automaticPostRetry:false,liveWriteExecuted:false};
      }
      props_().setProperty(key,JSON.stringify({signature:nowSig,count:count}));
    }else if(id){try{props_().deleteProperty(NP+id);}catch(x){}}
    return result;
  };
  a.__fairMonotonicV5128R1=true;
})();

/* BEGIN CF_SERVICEOPS_V5_13_0_WORKFLOW_QUEUE_COMMIT_R1 */
/************************************************************
 * CF_SERVICEOPS_V5_13_0_WORKFLOW_QUEUE_COMMIT_R1
 * Final wrapper after all historical workflow patches.
 * Every request-bearing worker result is projected from committed
 * Service Request state before the execution returns.
 ************************************************************/
(function CF_SERVICEOPS_INSTALL_WORKFLOW_QUEUE_COMMIT_V5130_R1_(){
  'use strict';
  if(typeof CF==='undefined'||!CF.EventDrivenServiceAutomation||typeof CF.EventDrivenServiceAutomation.worker!=='function')return;
  if(CF.EventDrivenServiceAutomation.__workflowQueueCommitV5130R1===true)return;
  var VERSION='5.13.0',base=CF.EventDrivenServiceAutomation.worker;
  function clean_(v){return v===null||v===undefined?'':String(v).trim();}
  function sync_(requestId,status){
    requestId=clean_(requestId);if(!requestId)return{ok:true,status:'NO_REQUEST_ID_TO_SYNC',version:VERSION};
    try{
      SpreadsheetApp.flush();
      var out;
      if(CF.OperatorQueue&&typeof CF.OperatorQueue.refreshRequest==='function')out=CF.OperatorQueue.refreshRequest(requestId,{fullFallback:true,verifyLimit:25});
      else if(CF.OperatorQueue&&typeof CF.OperatorQueue.refresh==='function'){var full=CF.OperatorQueue.refresh();out={ok:!full||full.ok!==false,status:'FULL_REFRESH_FALLBACK',fullRefresh:full};}
      else out={ok:false,status:'QUEUE_MODULE_MISSING'};
      try{if(CF.Util&&typeof CF.Util.logEvent==='function')CF.Util.logEvent({module:'70_Workflow_Automation',action:'WORKFLOW_QUEUE_COMMIT_SYNC',status:out&&out.ok===false?'FAILED':'COMPLETE',requestId:requestId,message:clean_(status),details:out,version:VERSION});}catch(e){}
      return out;
    }catch(error){
      var msg=error&&error.message?error.message:String(error);
      try{if(CF.Util&&typeof CF.Util.logEvent==='function')CF.Util.logEvent({module:'70_Workflow_Automation',action:'WORKFLOW_QUEUE_COMMIT_SYNC',status:'FAILED',requestId:requestId,message:msg,details:{workerStatus:clean_(status)},version:VERSION});}catch(e){}
      return{ok:false,status:'QUEUE_COMMIT_SYNC_FAILED',requestId:requestId,error:msg,version:VERSION};
    }
  }
  function taxVerify_(requestId,status,result){
    var should=!!(result&&(result.liveWriteExecuted===true||clean_(result.salesOrderId)||clean_(result.workOrderId)||/SALES_ORDER_CREATED/i.test(clean_(status))));
    if(!should)return{ok:true,applicable:false,status:'NO_NEW_SALES_ORDER_TO_VERIFY',version:VERSION};
    if(!CF.ServiceOrderTaxContract||typeof CF.ServiceOrderTaxContract.verifySalesOrder!=='function')return{ok:false,applicable:true,status:'TAX_CONTRACT_MODULE_MISSING',version:VERSION};
    var r=requestId&&CF.Util?CF.Util.findRecord('SERVICE_REQUESTS','Request ID',requestId):null;
    var salesOrderId=clean_(result&&result.salesOrderId||result&&result.workOrderId||r&&r['Work Order ID']);
    if(!salesOrderId)return{ok:false,applicable:true,status:'SALES_ORDER_ID_NOT_RESOLVED_FOR_TAX_VERIFY',requestId:requestId,version:VERSION};
    try{
      var v=CF.ServiceOrderTaxContract.verifySalesOrder(salesOrderId);
      if(v.applicable&&v.ok===false&&r&&r.__rowNumber){
        var orderLabel=clean_(v.orderNumber)||salesOrderId;
        var msg='Sales Order '+orderLabel+' was created, but the service Item line is not taxable. DO NOT CREATE ANOTHER SALES ORDER. Correct taxability on this existing Sales Order and verify HST before continuing.';
        CF.Util.patchRow('SERVICE_REQUESTS',r.__rowNumber,{'Updated At':CF.Util.nowString(),'Current Stage':'NEEDS REVIEW','Request Status':'OPEN','Manual Review?':'YES','Manual Review Reason':msg,'Blocking Issue':msg,'Next Action':'REVIEW SALES ORDER TAXABILITY — DO NOT CREATE ANOTHER SALES ORDER','Striven Sync Status':'BLOCKED','Striven Sync Error':'TAXABILITY_VERIFICATION_FAILED','Reconciliation Status':'SALES ORDER CREATED — TAXABILITY REVIEW REQUIRED'});
        SpreadsheetApp.flush();
        try{if(CF.Util&&typeof CF.Util.logEvent==='function')CF.Util.logEvent({module:'70_Workflow_Automation',action:'POST_CREATE_TAXABILITY_VERIFY',status:'FAILED',requestId:requestId,message:msg,details:v,version:VERSION});}catch(e){}
      }else{
        try{if(v.applicable&&CF.Util&&typeof CF.Util.logEvent==='function')CF.Util.logEvent({module:'70_Workflow_Automation',action:'POST_CREATE_TAXABILITY_VERIFY',status:'COMPLETE',requestId:requestId,details:v,version:VERSION});}catch(e){}
      }
      return v;
    }catch(error){return{ok:false,applicable:true,status:'TAXABILITY_VERIFY_READ_FAILED',requestId:requestId,salesOrderId:salesOrderId,error:String(error&&error.message||error),version:VERSION};}
  }
  CF.EventDrivenServiceAutomation.worker=function(e){
    var result=base.apply(CF.EventDrivenServiceAutomation,arguments);
    var requestId=clean_(result&&result.requestId||result&&result.execution&&result.execution.requestId||result&&result.result&&result.result.requestId);
    var status=clean_(result&&result.status||result&&result.execution&&result.execution.status);
    var taxVerification=taxVerify_(requestId,status,result);
    var queueSync=sync_(requestId,status);
    if(result&&typeof result==='object'){result.taxContractVerificationV5130=taxVerification;result.operatorQueueCommitSyncV5130=queueSync;}
    return result;
  };
  CF.EventDrivenServiceAutomation.__workflowQueueCommitV5130R1=true;
})();
/* END CF_SERVICEOPS_V5_13_0_WORKFLOW_QUEUE_COMMIT_R1 */


/* CF_SERVICEOPS_V5_14_0_CANONICAL_AUTOMATION_OVERWRITE_R1
 * FINAL AUTOMATION CONTRACT
 * - One request worker: AUTO_FINAL_ServiceOps.
 * - One permanent liveness trigger: AUTO_98_E2E_Recovery_Watchdog.
 * - Legacy phase handlers remain only as compatibility aliases.
 * - Every worker/kick/watchdog boundary canonicalizes trigger topology.
 * - Existing durable queue state is preserved.
 * - No Striven mutation is performed by trigger migration itself.
 */
(function(){
  'use strict';
  if(!CF.EventDrivenServiceAutomation||typeof CF.EventDrivenServiceAutomation.worker!=='function')return;
  var a=CF.EventDrivenServiceAutomation;
  if(a.__canonicalAutomationV5140R1)return;

  var VERSION='5.14.0';
  var FINAL_HANDLER='AUTO_FINAL_ServiceOps';
  var WATCHDOG_HANDLER='AUTO_98_E2E_Recovery_Watchdog';
  var ENABLED_PROP='CF_EVENT_DRIVEN_SERVICE_AUTOMATION_ENABLED';
  var QUEUE_PROP='CF_EVENT_DRIVEN_SERVICE_REQUEST_IDS';
  var NEXT_TRIGGER_AT='CF_EVENT_DRIVEN_SERVICE_NEXT_TRIGGER_AT';
  var LEGACY_HANDLERS=[
    'AUTO_processCustomerStructure',
    'AUTO_00_E2E_Route_Request',
    'AUTO_01_E2E_Customer_Match_Create',
    'AUTO_02_E2E_Location_Reconcile',
    'AUTO_03_E2E_Contact_Create_Recover',
    'AUTO_04_E2E_Customer_Contact_Info_Sync',
    'AUTO_05_E2E_Sales_Order_Create_Verify',
    'AUTO_99_E2E_Safe_Stop_Review'
  ];

  function clean_(v){return v===null||v===undefined?'':String(v).trim();}
  function upper_(v){return clean_(v).toUpperCase();}
  function props_(){return PropertiesService.getScriptProperties();}
  function uid_(t){try{return clean_(t.getUniqueId());}catch(e){return'';}}
  function handler_(t){try{return clean_(t.getHandlerFunction&&t.getHandlerFunction());}catch(e){return'';}}
  function enabled_(){return upper_(props_().getProperty(ENABLED_PROP))==='TRUE';}
  function queue_(){
    try{
      if(typeof a.queuedRequestIds==='function'){
        var q=a.queuedRequestIds();
        if(Array.isArray(q))return q.map(clean_).filter(Boolean);
      }
      var raw=props_().getProperty(QUEUE_PROP);
      var x=raw?JSON.parse(raw):[];
      return Array.isArray(x)?x.map(clean_).filter(Boolean):[];
    }catch(e){return[];}
  }
  function log_(status,details,message){
    try{
      if(CF.Util&&typeof CF.Util.logEvent==='function')CF.Util.logEvent({
        module:'70_Workflow_Automation',
        action:'CANONICAL_AUTOMATION_TOPOLOGY',
        status:status,
        message:message||'',
        details:details||{},
        version:VERSION
      });
    }catch(e){}
  }

  function canonicalizeTriggers_(currentUid,ensureWorker){
    currentUid=clean_(currentUid);
    var lock=LockService.getScriptLock();
    if(!lock.tryLock(30000))return{ok:false,status:'CANONICAL_TRIGGER_LOCK_BUSY',liveWriteExecuted:false};
    try{
      var triggers=ScriptApp.getProjectTriggers(),removedLegacy=0,removedDuplicateFinal=0,removedDuplicateWatchdog=0;
      var keptFinal='',keptWatchdog='';
      triggers.forEach(function(t){
        var h=handler_(t),id=uid_(t);
        if(LEGACY_HANDLERS.indexOf(h)!==-1){
          try{ScriptApp.deleteTrigger(t);removedLegacy+=1;}catch(e){}
          return;
        }
        if(h===FINAL_HANDLER){
          if(currentUid&&id===currentUid){keptFinal=id;return;}
          if(!keptFinal){keptFinal=id;return;}
          try{ScriptApp.deleteTrigger(t);removedDuplicateFinal+=1;}catch(e){}
          return;
        }
        if(h===WATCHDOG_HANDLER){
          if(currentUid&&id===currentUid){keptWatchdog=id;return;}
          if(!keptWatchdog){keptWatchdog=id;return;}
          try{ScriptApp.deleteTrigger(t);removedDuplicateWatchdog+=1;}catch(e){}
        }
      });

      var watchdogCreated=false,workerCreated=false,scheduledAt='';
      if(enabled_()){
        var after=ScriptApp.getProjectTriggers();
        var watchdogs=after.filter(function(t){return handler_(t)===WATCHDOG_HANDLER;});
        if(!watchdogs.length){
          try{ScriptApp.newTrigger(WATCHDOG_HANDLER).timeBased().everyMinutes(5).create();watchdogCreated=true;}catch(e){}
        }

        var q=queue_();
        if(ensureWorker===true&&q.length){
          var finals=ScriptApp.getProjectTriggers().filter(function(t){
            if(handler_(t)!==FINAL_HANDLER)return false;
            var id=uid_(t);
            return !currentUid||!id||id!==currentUid;
          });
          if(!finals.length){
            try{
              ScriptApp.newTrigger(FINAL_HANDLER).timeBased().after(10000).create();
              scheduledAt=new Date(Date.now()+10000).toISOString();
              props_().setProperty(NEXT_TRIGGER_AT,scheduledAt);
              workerCreated=true;
            }catch(e){}
          }
        }
      }

      var out={
        ok:true,
        version:VERSION,
        status:'CANONICAL_TRIGGER_TOPOLOGY_APPLIED',
        finalHandler:FINAL_HANDLER,
        watchdogHandler:WATCHDOG_HANDLER,
        removedLegacyTriggers:removedLegacy,
        removedDuplicateFinalTriggers:removedDuplicateFinal,
        removedDuplicateWatchdogTriggers:removedDuplicateWatchdog,
        watchdogCreated:watchdogCreated,
        workerCreated:workerCreated,
        scheduledAt:scheduledAt,
        queuedRequestIds:queue_(),
        liveWriteExecuted:false
      };
      log_('APPLIED',out,'Legacy automation triggers were replaced by the canonical worker/watchdog topology.');
      return out;
    }finally{lock.releaseLock();}
  }

  var baseWorker=a.worker;
  a.worker=function(e,invocation){
    e=e||{};
    var before=canonicalizeTriggers_(e.triggerUid,false);
    var result=baseWorker(e,{executionFunction:FINAL_HANDLER,phase:'CANONICAL END TO END'});
    var after=canonicalizeTriggers_(e.triggerUid,true);
    if(result&&typeof result==='object'){
      result.version=VERSION;
      result.canonicalAutomation={
        active:true,
        version:VERSION,
        finalHandler:FINAL_HANDLER,
        watchdogHandler:WATCHDOG_HANDLER,
        topologyBefore:before,
        topologyAfter:after
      };
    }
    return result;
  };

  var baseKick=typeof a.kick==='function'?a.kick:null;
  if(baseKick)a.kick=function(requestId){
    var result=baseKick.apply(a,arguments);
    var topology=canonicalizeTriggers_('',true);
    if(result&&typeof result==='object'){
      result.version=VERSION;
      result.handler=FINAL_HANDLER;
      result.canonicalAutomation=topology;
    }
    return result;
  };

  var baseWatchdog=typeof a.recoveryWatchdog==='function'?a.recoveryWatchdog:null;
  if(baseWatchdog)a.recoveryWatchdog=function(){
    var before=canonicalizeTriggers_('',false);
    var result=baseWatchdog.apply(a,arguments);
    var after=canonicalizeTriggers_('',true);
    if(result&&typeof result==='object'){
      result.version=VERSION;
      result.canonicalAutomation={active:true,version:VERSION,topologyBefore:before,topologyAfter:after};
    }
    return result;
  };

  var baseVerify=typeof a.verifySetup==='function'?a.verifySetup:null;
  if(baseVerify)a.verifySetup=function(){
    var existingQueue=queue_();
    var result=baseVerify.apply(a,arguments);
    // Some legacy verifySetup generations clear the queue. Restore only the durable
    // queue IDs that existed before setup; no request state is invented here.
    try{
      if(existingQueue.length){
        var nowQueue=queue_(),seen={};
        var merged=nowQueue.concat(existingQueue).map(clean_).filter(function(id){if(!id||seen[id])return false;seen[id]=true;return true;});
        props_().setProperty(QUEUE_PROP,JSON.stringify(merged));
      }
    }catch(e){}
    var topology=canonicalizeTriggers_('',true);
    if(result&&typeof result==='object'){
      result.version=VERSION;
      result.handler=FINAL_HANDLER;
      result.canonicalAutomation=topology;
      result.preservedQueuedRequestIds=queue_();
    }
    return result;
  };

  var baseDisable=typeof a.disable==='function'?a.disable:null;
  if(baseDisable)a.disable=function(){
    var result=baseDisable.apply(a,arguments);
    var removed=0;
    try{
      ScriptApp.getProjectTriggers().forEach(function(t){
        var h=handler_(t);
        if(h===FINAL_HANDLER||h===WATCHDOG_HANDLER||LEGACY_HANDLERS.indexOf(h)!==-1){
          try{ScriptApp.deleteTrigger(t);removed+=1;}catch(e){}
        }
      });
    }catch(e){}
    if(result&&typeof result==='object'){
      result.version=VERSION;
      result.canonicalTriggersRemoved=removed;
    }
    return result;
  };

  a.allHandlerNames=function(){return [FINAL_HANDLER,WATCHDOG_HANDLER].concat(LEGACY_HANDLERS);};
  a.canonicalizeTriggers=function(options){options=options||{};return canonicalizeTriggers_(clean_(options.currentTriggerUid),options.ensureWorker!==false);};
  a.activateCanonical=function(){
    props_().setProperty(ENABLED_PROP,'true');
    props_().setProperty('CF_EVENT_DRIVEN_AUTO_SALES_ORDER','true');
    props_().setProperty('CF_SERVICEOPS_AUTOMATION_PREPARATION_ONLY','false');
    var topology=canonicalizeTriggers_('',true);
    var recovery=null;
    try{if(typeof a.recoveryWatchdog==='function')recovery=a.recoveryWatchdog();}catch(e){recovery={ok:false,status:'CANONICAL_RECOVERY_START_FAILED',error:String(e&&e.message||e),liveWriteExecuted:false};}
    return{ok:true,version:VERSION,status:'CANONICAL_SERVICEOPS_ACTIVE',finalHandler:FINAL_HANDLER,watchdogHandler:WATCHDOG_HANDLER,topology:topology,recovery:recovery,queuedRequestIds:queue_(),liveWriteExecuted:false};
  };
  a.canonicalVersion=VERSION;
  a.__canonicalAutomationV5140R1=true;
})();
