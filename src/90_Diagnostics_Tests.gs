/************************************************************
 * APPS SCRIPT — 90_Diagnostics_Tests.gs
 * CF ServiceOps — Phase 5A Diagnostics
 * Version: 5.8.0
 *
 * Routine output is intentionally compact. It does not expose
 * report URLs, tokens, payloads, or the migration backup snapshot.
 ************************************************************/
var CF = CF || {};

CF.Diagnostics = (function () {
  'use strict';

  var MODULE_NAME = '90_Diagnostics_Tests';
  var VERSION = '5.8.0';

  function deps_() {
    if (!CF.Config || !CF.Util) throw new Error('CF.Config and CF.Util are required.');
    return { config: CF.Config, util: CF.Util };
  }

  function clean_(value) {
    return deps_().util.cleanText(value);
  }

  function issue_(status, code, message, action, details) {
    return {
      status: status,
      code: code,
      message: message,
      action: action || '',
      details: details || {}
    };
  }

  function headersEqual_(actual, expected) {
    return actual.length === expected.length && expected.every(function (header, index) {
      return actual[index] === header;
    });
  }

  function stageCounts_(rows) {
    var counts = {};
    rows.forEach(function (row) {
      var stage = clean_(row['Current Stage']) || 'BLANK';
      counts[stage] = (counts[stage] || 0) + 1;
    });
    return counts;
  }

  function duplicateValues_(rows, header) {
    var counts = {};
    rows.forEach(function (row) {
      var value = clean_(row[header]);
      if (value) counts[value] = (counts[value] || 0) + 1;
    });
    return Object.keys(counts).filter(function (value) { return counts[value] > 1; });
  }

  function compactReadiness_() {
    if (!CF.StrivenData || typeof CF.StrivenData.inspectReadiness !== 'function') {
      return { ok: false, counts: {}, fresh: {}, requiredMissing: ['CF.StrivenData'] };
    }
    var raw = CF.StrivenData.inspectReadiness();
    return {
      ok: raw.ok === true,
      counts: raw.counts || {},
      fresh: raw.fresh || {},
      requiredMissing: raw.requiredMissing || []
    };
  }

  function phase5A_(requests) {
    var planned = 0;
    var approved = 0;
    var invalidApprovals = [];
    var readyForApproval = 0;
    var blockedPlans = 0;

    requests.forEach(function (row) {
      if (clean_(row['Transaction Fingerprint'])) planned++;
      if (clean_(row['Current Stage']) === 'APPROVED FOR CUSTOMER STRUCTURE' || clean_(row['Approval Fingerprint'])) {
        approved++;
        if (CF.StrivenWrite && typeof CF.StrivenWrite.verifyApproval === 'function') {
          var verification = CF.StrivenWrite.verifyApproval(row);
          if (!verification.ok) invalidApprovals.push(row['Request ID']);
        } else {
          invalidApprovals.push(row['Request ID']);
        }
      }
      if (CF.StrivenWrite && typeof CF.StrivenWrite.buildPreviewFromRecord === 'function') {
        var preview = CF.StrivenWrite.buildPreviewFromRecord(row);
        if (preview.readyForApproval) readyForApproval++;
        else blockedPlans++;
      }
    });

    return {
      planningModuleLoaded: !!(CF.StrivenWrite && typeof CF.StrivenWrite.buildPreviewFromRecord === 'function'),
      plannedRequests: planned,
      approvedDryRuns: approved,
      readyForApproval: readyForApproval,
      blockedPlans: blockedPlans,
      invalidApprovalCount: invalidApprovals.length,
      invalidApprovalRequestIds: invalidApprovals.slice(0, 10),
      liveWritesAllowed: false
    };
  }

  function run() {
    var d = deps_();
    var started = Date.now();
    var ss = d.util.getSpreadsheet();
    var issues = [];
    var activeNames = d.config.getActiveSheetNames();
    var visibleExpected = d.config.getVisibleSheetNames();
    var existingSheets = ss.getSheets();
    var existingNames = existingSheets.map(function (sheet) { return sheet.getName(); });
    var visibleActual = existingSheets.filter(function (sheet) { return !sheet.isSheetHidden(); }).map(function (sheet) { return sheet.getName(); });

    activeNames.forEach(function (name) {
      var sheet = ss.getSheetByName(name);
      if (!sheet) {
        issues.push(issue_('ERROR', 'MISSING_SHEET', 'Required sheet is missing: ' + name, 'Restore the eight-sheet contract.'));
        return;
      }
      var expected = d.config.getHeaders(name);
      if (expected.length) {
        var actual = d.util.getActualHeaders(sheet);
        if (!headersEqual_(actual, expected)) {
          issues.push(issue_('ERROR', 'HEADER_CONTRACT', 'Header contract mismatch: ' + name, 'Restore the v5.8 header contract.', {
            expectedColumns: expected.length,
            actualColumns: actual.length
          }));
        }
      }
    });

    var extraSheets = existingNames.filter(function (name) { return activeNames.indexOf(name) === -1; });
    if (extraSheets.length) {
      issues.push(issue_('WARNING', 'EXTRA_SHEETS', 'The workbook contains sheets outside the managed eight-sheet contract.', 'Leave them untouched unless they are intentionally archived; the v5.8 UX migration never deletes extra sheets.', {
        count: extraSheets.length,
        sample: extraSheets.slice(0, 10)
      }));
    }

    if (visibleActual.slice().sort().join('|') !== visibleExpected.slice().sort().join('|')) {
      issues.push(issue_('WARNING', 'VISIBLE_SHEETS', 'Visible sheets differ from the operator contract.', 'Keep only Dashboard and Operator Queue visible.', {
        expected: visibleExpected,
        actual: visibleActual
      }));
    }

    var requests = d.util.readRecords('SERVICE_REQUESTS');
    var queue = d.util.readRecords('OPERATOR_QUEUE');
    var duplicateRequestIds = duplicateValues_(requests, 'Request ID');
    if (duplicateRequestIds.length) {
      issues.push(issue_('ERROR', 'DUPLICATE_REQUEST_IDS', 'Duplicate Request IDs exist.', 'Resolve duplicate ledger rows before operator work.', {
        count: duplicateRequestIds.length,
        sample: duplicateRequestIds.slice(0, 10)
      }));
    }

    var activeRequestIds = requests.filter(function (row) {
      return !d.config.isTerminalState(row['Current Stage']) && !d.config.isTerminalState(row['Final Outcome']);
    }).map(function (row) { return clean_(row['Request ID']); }).filter(Boolean).sort();
    var queueRequestIds = queue.map(function (row) { return clean_(row['Request ID']); }).filter(Boolean).sort();
    if (activeRequestIds.join('|') !== queueRequestIds.join('|')) {
      issues.push(issue_('WARNING', 'QUEUE_OUT_OF_SYNC', 'Operator Queue does not match active Service Requests.', 'Run QUEUE_refresh.', {
        expectedActiveRows: activeRequestIds.length,
        queueRows: queueRequestIds.length
      }));
    }

    var readiness = compactReadiness_();
    if (!readiness.ok) {
      issues.push(issue_('ERROR', 'STRIVEN_CACHE_READINESS', 'Striven matching caches are not ready.', 'Refresh Customer, Location, and Operational data.', readiness));
    } else if (!readiness.fresh.customer || !readiness.fresh.location || !readiness.fresh.operational) {
      issues.push(issue_('WARNING', 'STALE_CACHE', 'One or more Striven caches are stale.', 'Refresh the stale cache before making operator decisions.', readiness.fresh));
    }

    var intake = CF.Intake && typeof CF.Intake.inspectState === 'function'
      ? CF.Intake.inspectState()
      : { ok: false, duplicateSubmissionIds: 0, duplicatePayloadHashes: 0 };
    if (!intake.ok) {
      issues.push(issue_('ERROR', 'INTAKE_MODULE', 'Intake diagnostics failed.', 'Review 20_Intake_Processing.gs.'));
    }
    if (intake.duplicateSubmissionIds || intake.duplicatePayloadHashes) {
      issues.push(issue_('WARNING', 'INTAKE_DUPLICATES', 'Duplicate intake identities were detected.', 'Review the duplicate intake rows.', {
        duplicateSubmissionIds: intake.duplicateSubmissionIds,
        duplicatePayloadHashes: intake.duplicatePayloadHashes
      }));
    }

    var safety = {
      configWriteAllowed: d.config.isWriteAllowed() === true,
      scriptWriteMode: d.util.getBooleanProperty('WRITE_MODE', false),
      testMode: d.util.getBooleanProperty('TEST_MODE', true),
      liveWritesAllowed: false
    };
    if (safety.configWriteAllowed || safety.scriptWriteMode || !safety.testMode) {
      issues.push(issue_('ERROR', 'WRITE_GATE', 'Live Striven write gates are not in the Phase 5A safe state.', 'Set TEST_MODE=true and WRITE_MODE=false. Config.isWriteAllowed must remain false.', safety));
    }

    var phase5A = phase5A_(requests);
    var queueSheet = d.util.requireSheet('OPERATOR_QUEUE');
    var queueHeaders = d.util.getActualHeaders(queueSheet);
    var dashboardSheet = d.util.requireSheet('DASHBOARD');
    phase5A.operatorWorkspace = {
      queueRunHeaderPresent: queueHeaders.indexOf('Run') !== -1,
      dashboardReadOnlyMarker: clean_(dashboardSheet.getRange('A1').getDisplayValue()) === 'CF ServiceOps — Service Snapshot'
    };
    phase5A.operatorWorkspace.ready = phase5A.operatorWorkspace.queueRunHeaderPresent && phase5A.operatorWorkspace.dashboardReadOnlyMarker;
    if (!phase5A.operatorWorkspace.ready) {
      issues.push(issue_('ERROR', 'OPERATOR_WORKSPACE', 'The v5.8 operator workspace is not fully installed.', 'Run QUEUE_refresh after installing v5.8.0.', phase5A.operatorWorkspace));
    }
    if (!phase5A.planningModuleLoaded) {
      issues.push(issue_('ERROR', 'PHASE5A_MODULE', 'Phase 5A transaction planning module is not loaded.', 'Confirm 60_Striven_Write.gs is loaded and compatible with v5.8.0.'));
    }
    if (phase5A.invalidApprovalCount) {
      issues.push(issue_('ERROR', 'INVALID_APPROVALS', 'Approved transaction content has changed or approval fingerprints are invalid.', 'Reopen and reapprove the listed requests.', {
        count: phase5A.invalidApprovalCount,
        requestIds: phase5A.invalidApprovalRequestIds
      }));
    }

    var stageCounts = stageCounts_(requests);
    var errors = issues.filter(function (item) { return item.status === 'ERROR'; }).length;
    var warnings = issues.filter(function (item) { return item.status === 'WARNING'; }).length;
    var result = {
      ok: errors === 0,
      version: VERSION,
      checkedAt: d.util.nowString(),
      durationMs: Date.now() - started,
      summary: {
        errors: errors,
        warnings: warnings,
        checksPassed: Math.max(0, 16 - errors - warnings)
      },
      workbook: {
        sheetCount: existingNames.length,
        activeSheets: activeNames,
        visibleSheets: visibleActual,
        serviceRequestColumns: d.config.getHeaders('SERVICE_REQUESTS').length,
        operatorQueueColumns: d.config.getHeaders('OPERATOR_QUEUE').length,
        serviceRequestRows: requests.length,
        operatorQueueRows: queue.length
      },
      workflow: {
        stageCounts: stageCounts,
        needsReview: stageCounts['NEEDS REVIEW'] || 0,
        readyCustomerCreate: stageCounts['READY FOR CUSTOMER CREATE'] || 0,
        readyContactCreate: stageCounts['READY FOR CONTACT CREATE'] || 0,
        readyLocationCreate: stageCounts['READY FOR LOCATION CREATE'] || 0,
        customerResolved: stageCounts['CUSTOMER RESOLVED'] || 0,
        approvedDryRun: stageCounts['APPROVED FOR CUSTOMER STRUCTURE'] || 0
      },
      strivenData: readiness,
      intake: {
        ok: intake.ok === true,
        webformRows: intake.webformRows || 0,
        serviceRequestRows: intake.serviceRequestRows || 0,
        duplicateSubmissionIds: intake.duplicateSubmissionIds || 0,
        duplicatePayloadHashes: intake.duplicatePayloadHashes || 0,
        duplicateServiceSubmissionIds: intake.duplicateServiceSubmissionIds || 0,
        duplicateServicePayloadHashes: intake.duplicateServicePayloadHashes || 0,
        missingServiceForWebform: intake.missingServiceForWebform || 0,
        missingWebformForService: intake.missingWebformForService || 0
      },
      phase5A: phase5A,
      safety: safety,
      issues: issues,
      phaseGate: {
        passed: errors === 0,
        status: errors ? 'BLOCKED' : (warnings ? 'COMPLETE_WITH_WARNINGS' : 'COMPLETE'),
        liveWritesAllowed: false,
        next: 'Process requests only in Operator Queue: select an Operator Action and check Run. Dashboard is read-only. Live Striven writes remain disabled.'
      }
    };

    d.util.logEvent({
      module: MODULE_NAME,
      action: 'RUN_PHASE5A_DIAGNOSTICS',
      status: result.phaseGate.status,
      message: 'Errors: ' + errors + '; warnings: ' + warnings + '; requests: ' + requests.length + '; queue: ' + queue.length + '.',
      details: {
        summary: result.summary,
        workflow: result.workflow,
        phase5A: result.phase5A,
        safety: result.safety,
        issueCodes: issues.map(function (item) { return item.code; })
      },
      durationMs: result.durationMs,
      version: VERSION
    });
    return result;
  }

  return {
    version: VERSION,
    run: run
  };
})();
