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
  return CF.PublicRunners.run('Striven full data refresh', function () {
    if (!CF.StrivenData) throw new Error('CF.StrivenData is required.');

    var customer = CF.StrivenData.refreshCustomerData();
    var location = CF.StrivenData.refreshLocationData();
    var operational = CF.StrivenData.refreshOperationalData();

    return {
      ok: customer.ok !== false && location.ok !== false && operational.ok !== false,
      version: '5.8.0',
      customerData: customer,
      locationData: location,
      operationalData: operational
    };
  });
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
  return CF.PublicRunners.run('Phase 5A transaction preview', function () {
    var requestId = CF.PublicRunners.selectedRequestId();
    var preview = CF.StrivenWrite.previewRequest(requestId, { persist: true });
    if (CF.OperatorQueue) CF.OperatorQueue.openRequest(requestId, { activate: false });
    return preview;
  });
}

function WRITE_approveSelected() {
  return CF.PublicRunners.run('Phase 5A dry-run approval', function () {
    var requestId = CF.PublicRunners.selectedRequestId();
    var result = CF.StrivenWrite.approveRequest(requestId);
    if (CF.OperatorQueue) {
      CF.OperatorQueue.refresh();
      CF.OperatorQueue.openRequest(requestId, { activate: false });
    }
    return result;
  });
}

function WRITE_processApproved() {
  return CF.PublicRunners.run('Phase 5A execution gate', function () {
    return CF.StrivenWrite.processApproved();
  });
}

/************************************************************
 * TRIGGERS / WEB APP
 ************************************************************/

function onOpen() {
  return CF.PublicRunners.buildMenu();
}

function onEdit(e) {
  if (CF.OperatorQueue && typeof CF.OperatorQueue.onEdit === 'function') {
    return CF.OperatorQueue.onEdit(e);
  }
}

function doPost(e) {
  return CF.Intake.handlePost(e);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({
    ok: true,
    service: 'CF ServiceOps',
    version: '5.8.0',
    status: 'AVAILABLE'
  })).setMimeType(ContentService.MimeType.JSON);
}
