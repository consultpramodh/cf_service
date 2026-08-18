/************************************************************
 * APPS SCRIPT — 10_Setup_Admin.gs
 * CF ServiceOps — Safe Operator UX Migration
 * Version: 5.8.0
 *
 * SAFETY CONTRACT
 * - Never deletes a sheet.
 * - Never rebuilds Webform Requests or Service Requests.
 * - Renames managed sheets in place only.
 * - Requires a verified spreadsheet backup before renaming.
 * - Verifies durable Webform and Service Request identities before/after.
 * - Only Dashboard and Operator Queue are visible after migration.
 ************************************************************/
var CF = CF || {};

CF.Setup = (function () {
  'use strict';

  var VERSION = '5.8.0';
  var STATE_PROPERTY = 'CF_OPERATOR_UX_MIGRATION_V580';

  var LEGACY_NAMES = {
    DASHBOARD: ['Dashboard', '00 Dashboard'],
    WEBFORM_REQUESTS: ['Webform Requests', '01 Webform Requests'],
    SERVICE_REQUESTS: ['Service Requests', '02 Service Requests'],
    OPERATOR_QUEUE: ['Operator Queue', '03 Operator Queue'],
    STRIVEN_CUSTOMER_DATA: ['Striven Customer Data', '04 Striven Customer Data'],
    STRIVEN_LOCATION_DATA: ['Striven Location Data', '05 Striven Location Data'],
    STRIVEN_OPERATIONAL_DATA: ['Striven Operational Data', '06 Striven Operational Data'],
    SYSTEM_LOG: ['System Log', '07 System Log']
  };

  var DATA_KEYS = [
    'WEBFORM_REQUESTS',
    'SERVICE_REQUESTS',
    'STRIVEN_CUSTOMER_DATA',
    'STRIVEN_LOCATION_DATA',
    'STRIVEN_OPERATIONAL_DATA',
    'SYSTEM_LOG'
  ];

  function deps_() {
    if (!CF.Config || !CF.Util) throw new Error('CF.Config and CF.Util are required.');
    return { config: CF.Config, util: CF.Util };
  }

  function state_() {
    var d = deps_();
    var raw = PropertiesService.getScriptProperties().getProperty(STATE_PROPERTY);
    var parsed = raw ? d.util.parseJson(raw, {}) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  }

  function saveState_(value) {
    value = value || {};
    value.version = VERSION;
    value.updatedAt = deps_().util.nowString();
    PropertiesService.getScriptProperties().setProperty(STATE_PROPERTY, deps_().util.safeJson(value));
    return value;
  }

  function unique_(items) {
    var out = [];
    (items || []).forEach(function (item) {
      if (item && out.indexOf(item) === -1) out.push(item);
    });
    return out;
  }

  function candidateNames_(key) {
    var canonical = deps_().config.getSheetName(key);
    return unique_([canonical].concat(LEGACY_NAMES[key] || []));
  }

  function findManagedSheets_(spreadsheet, key) {
    return candidateNames_(key).map(function (name) {
      return spreadsheet.getSheetByName(name);
    }).filter(Boolean);
  }

  function requireUniqueManagedSheet_(spreadsheet, key, allowCreate) {
    var matches = findManagedSheets_(spreadsheet, key);
    if (matches.length > 1) {
      throw new Error(
        'SHEET_NAME_CONFLICT | Multiple sheets could represent ' + key + ': ' +
        matches.map(function (sheet) { return sheet.getName(); }).join(', ') +
        '. Resolve the duplicate names manually; no automatic choice will be made.'
      );
    }
    if (matches.length === 1) return matches[0];
    if (allowCreate) return spreadsheet.insertSheet(deps_().config.getSheetName(key));
    throw new Error('MISSING_SHEET | Required data sheet is missing for ' + key + '.');
  }

  function sheetHeaders_(sheet) {
    if (!sheet || sheet.getLastRow() < 1 || sheet.getLastColumn() < 1) return [];
    return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(deps_().util.cleanText);
  }

  function identitySpec_(key) {
    if (key === 'WEBFORM_REQUESTS') return ['Submission ID', 'Request ID', 'Payload Hash'];
    if (key === 'SERVICE_REQUESTS') return ['Request ID', 'Submission ID', 'Payload Hash'];
    if (key === 'STRIVEN_CUSTOMER_DATA') return ['Entity Type', 'Entity ID', 'Customer ID', 'Contact ID'];
    if (key === 'STRIVEN_LOCATION_DATA') return ['Location ID', 'Customer ID'];
    if (key === 'STRIVEN_OPERATIONAL_DATA') return ['Entity Type', 'Entity ID', 'Work Order ID', 'Task ID', 'Asset ID'];
    if (key === 'SYSTEM_LOG') return ['Timestamp', 'Request ID', 'Correlation ID', 'Action'];
    return [];
  }

  function identitySnapshot_(sheet, key) {
    var d = deps_();
    var headers = sheetHeaders_(sheet);
    var rowCount = Math.max(0, sheet.getLastRow() - 1);
    var spec = identitySpec_(key);
    var columns = spec.map(function (header) { return headers.indexOf(header); });
    var missing = spec.filter(function (header, index) { return columns[index] < 0; });
    if (missing.length) {
      return {
        key: key,
        sheet: sheet.getName(),
        rows: rowCount,
        columns: sheet.getLastColumn(),
        identityHeaders: spec,
        missingIdentityHeaders: missing,
        hash: ''
      };
    }

    var identities = [];
    if (rowCount > 0) {
      var values = sheet.getRange(2, 1, rowCount, headers.length).getDisplayValues();
      values.forEach(function (row) {
        var parts = columns.map(function (index) { return d.util.cleanText(row[index]); });
        if (parts.join('') !== '') identities.push(parts);
      });
    }

    return {
      key: key,
      sheet: sheet.getName(),
      rows: rowCount,
      columns: sheet.getLastColumn(),
      identityHeaders: spec,
      missingIdentityHeaders: [],
      identityRows: identities.length,
      hash: d.util.canonicalHash(identities)
    };
  }

  function preservationSnapshot_(spreadsheet) {
    var out = {};
    DATA_KEYS.forEach(function (key) {
      var sheet = requireUniqueManagedSheet_(spreadsheet, key, false);
      out[key] = identitySnapshot_(sheet, key);
    });
    return out;
  }

  function comparePreservation_(before, after) {
    var differences = [];
    DATA_KEYS.forEach(function (key) {
      var a = before[key] || {};
      var b = after[key] || {};
      if (a.rows !== b.rows) differences.push(key + ': row count ' + a.rows + ' → ' + b.rows);
      if (a.hash && b.hash && a.hash !== b.hash) differences.push(key + ': identity hash changed');
      if ((a.missingIdentityHeaders || []).join('|') !== (b.missingIdentityHeaders || []).join('|')) {
        differences.push(key + ': identity header availability changed');
      }
    });
    return { ok: differences.length === 0, differences: differences };
  }

  function workbookSnapshot_(spreadsheet) {
    return spreadsheet.getSheets().map(function (sheet) {
      return {
        name: sheet.getName(),
        rows: sheet.getLastRow(),
        columns: sheet.getLastColumn()
      };
    });
  }

  function verifyBackup_(backup, sourceSnapshot, preservationBefore) {
    var problems = [];
    (sourceSnapshot || []).forEach(function (expected) {
      var sheet = backup.getSheetByName(expected.name);
      if (!sheet) {
        problems.push('Missing sheet in backup: ' + expected.name);
        return;
      }
      if (sheet.getLastRow() !== expected.rows || sheet.getLastColumn() !== expected.columns) {
        problems.push(
          'Dimension mismatch in backup: ' + expected.name +
          ' expected ' + expected.rows + 'x' + expected.columns +
          ', found ' + sheet.getLastRow() + 'x' + sheet.getLastColumn()
        );
      }
    });
    if (backup.getSheets().length !== (sourceSnapshot || []).length) {
      problems.push('Backup sheet count differs from source snapshot.');
    }
    if (!problems.length && preservationBefore) {
      try {
        var backupPreservation = preservationSnapshot_(backup);
        var identityCheck = comparePreservation_(preservationBefore, backupPreservation);
        if (!identityCheck.ok) problems = problems.concat(identityCheck.differences.map(function (item) { return 'Backup identity mismatch: ' + item; }));
      } catch (error) {
        problems.push('Backup identity verification failed: ' + (error.message || String(error)));
      }
    }
    if (problems.length) throw new Error('BACKUP_VERIFICATION_FAILED | ' + problems.join(' | '));
    return true;
  }

  function previewMigration() {
    var d = deps_();
    var ss = d.util.getSpreadsheet();
    var conflicts = [];
    var renames = [];
    Object.keys(LEGACY_NAMES).forEach(function (key) {
      var matches = findManagedSheets_(ss, key);
      if (matches.length > 1) {
        conflicts.push({ key: key, sheets: matches.map(function (sheet) { return sheet.getName(); }) });
      } else if (matches.length === 1 && matches[0].getName() !== d.config.getSheetName(key)) {
        renames.push({ key: key, from: matches[0].getName(), to: d.config.getSheetName(key) });
      }
    });

    var preservation = null;
    try { preservation = preservationSnapshot_(ss); } catch (error) { conflicts.push({ key: 'PRESERVATION', error: error.message || String(error) }); }

    return {
      ok: conflicts.length === 0,
      version: VERSION,
      mode: 'IN_PLACE_RENAME_ONLY',
      deletesSheets: false,
      rebuildsDurableLedgers: false,
      targetVisibleSheets: d.config.getVisibleSheetNames(),
      renames: renames,
      conflicts: conflicts,
      preservation: preservation,
      backupRequired: true,
      nextAction: conflicts.length
        ? 'Resolve the reported sheet-name conflict before migration.'
        : 'Run SETUP_createMigrationBackup, then SETUP_continueLeanMigration.'
    };
  }

  function inspectMigrationState() {
    var preview = previewMigration();
    preview.migrationState = state_();
    return preview;
  }

  function createOrVerifyMigrationBackup() {
    var d = deps_();
    return d.util.withScriptLock(function () {
      var ss = d.util.getSpreadsheet();
      var state = state_();

      if (state.backup && state.backup.id) {
        var existing = SpreadsheetApp.openById(state.backup.id);
        verifyBackup_(existing, state.backup.sourceSnapshot || [], state.preservationBefore || null);
        state.backup.verified = true;
        state.backup.verifiedAt = d.util.nowString();
        state.phase = 'BACKUP_VERIFIED';
        saveState_(state);
        return {
          ok: true,
          version: VERSION,
          status: 'BACKUP_VERIFIED',
          backupName: state.backup.name,
          backupUrl: state.backup.url,
          nextAction: 'Run SETUP_continueLeanMigration.'
        };
      }

      var sourceSnapshot = workbookSnapshot_(ss);
      var backup = ss.copy('CF ServiceOps Backup v5.8.0 ' + d.util.formatDate(new Date(), 'yyyyMMdd-HHmmss'));
      state = {
        version: VERSION,
        phase: 'BACKUP_CREATED',
        sourceSpreadsheetId: ss.getId(),
        preservationBefore: preservationSnapshot_(ss),
        backup: {
          id: backup.getId(),
          name: backup.getName(),
          url: backup.getUrl(),
          sourceSnapshot: sourceSnapshot,
          verified: false,
          createdAt: d.util.nowString()
        }
      };
      saveState_(state);

      try {
        verifyBackup_(SpreadsheetApp.openById(backup.getId()), sourceSnapshot, state.preservationBefore);
        state.backup.verified = true;
        state.backup.verifiedAt = d.util.nowString();
        state.phase = 'BACKUP_VERIFIED';
        saveState_(state);
      } catch (error) {
        return {
          ok: true,
          version: VERSION,
          status: 'BACKUP_CREATED_NOT_YET_VERIFIED',
          backupName: state.backup.name,
          backupUrl: state.backup.url,
          nextAction: 'Run SETUP_createMigrationBackup again to verify before any sheet rename.',
          verificationMessage: error.message || String(error)
        };
      }

      return {
        ok: true,
        version: VERSION,
        status: 'BACKUP_VERIFIED',
        backupName: state.backup.name,
        backupUrl: state.backup.url,
        nextAction: 'Run SETUP_continueLeanMigration.'
      };
    }, 30000);
  }

  function renameInPlace_(spreadsheet, key) {
    var d = deps_();
    var canonical = d.config.getSheetName(key);
    var sheet = requireUniqueManagedSheet_(spreadsheet, key, key === 'DASHBOARD' || key === 'OPERATOR_QUEUE');
    if (sheet.getName() === canonical) return { key: key, renamed: false, name: canonical };
    if (spreadsheet.getSheetByName(canonical)) {
      throw new Error('SHEET_NAME_CONFLICT | Target sheet already exists: ' + canonical);
    }
    var from = sheet.getName();
    sheet.setName(canonical);
    return { key: key, renamed: true, from: from, to: canonical };
  }

  function applyVisibility_(spreadsheet) {
    var d = deps_();
    var visible = d.config.getVisibleSheetNames();
    var active = d.config.getActiveSheetNames();
    active.forEach(function (name) {
      var sheet = spreadsheet.getSheetByName(name);
      if (!sheet) return;
      if (visible.indexOf(name) !== -1) {
        if (sheet.isSheetHidden()) sheet.showSheet();
      } else if (!sheet.isSheetHidden()) {
        sheet.hideSheet();
      }
    });
    var dashboard = spreadsheet.getSheetByName(d.config.getSheetName('DASHBOARD'));
    if (dashboard) spreadsheet.setActiveSheet(dashboard);
  }

  function continueLeanMigration() {
    var d = deps_();
    return d.util.withScriptLock(function () {
      var state = state_();
      if (!state.backup || !state.backup.id || state.backup.verified !== true) {
        throw new Error('BACKUP_REQUIRED | Run SETUP_createMigrationBackup until it reports BACKUP_VERIFIED.');
      }

      var ss = d.util.getSpreadsheet();
      var before = preservationSnapshot_(ss);
      if (state.preservationBefore) {
        var priorCheck = comparePreservation_(state.preservationBefore, before);
        if (!priorCheck.ok) {
          throw new Error('SOURCE_CHANGED_SINCE_BACKUP | ' + priorCheck.differences.join(' | ') + '. Create a new backup before migrating.');
        }
      }

      var renamed = [];
      [
        'DASHBOARD', 'WEBFORM_REQUESTS', 'SERVICE_REQUESTS', 'OPERATOR_QUEUE',
        'STRIVEN_CUSTOMER_DATA', 'STRIVEN_LOCATION_DATA', 'STRIVEN_OPERATIONAL_DATA', 'SYSTEM_LOG'
      ].forEach(function (key) {
        renamed.push(renameInPlace_(ss, key));
      });
      SpreadsheetApp.flush();

      var afterRename = preservationSnapshot_(ss);
      var preservation = comparePreservation_(before, afterRename);
      if (!preservation.ok) {
        throw new Error('PRESERVATION_CHECK_FAILED | ' + preservation.differences.join(' | '));
      }

      applyVisibility_(ss);

      var queueResult = null;
      if (CF.OperatorQueue && typeof CF.OperatorQueue.refresh === 'function') {
        queueResult = CF.OperatorQueue.refresh();
      }

      var after = preservationSnapshot_(ss);
      var finalPreservation = comparePreservation_(before, after);
      if (!finalPreservation.ok) {
        throw new Error('POST_REFRESH_PRESERVATION_FAILED | ' + finalPreservation.differences.join(' | '));
      }

      state.phase = 'COMPLETE';
      state.completedAt = d.util.nowString();
      state.renamed = renamed;
      state.preservationAfter = after;
      saveState_(state);

      return {
        ok: true,
        version: VERSION,
        status: 'COMPLETE',
        renamedInPlace: renamed.filter(function (item) { return item.renamed; }),
        deletedSheets: 0,
        durableDataPreserved: true,
        visibleSheets: d.config.getVisibleSheetNames(),
        queue: queueResult,
        backupName: state.backup.name,
        backupUrl: state.backup.url,
        nextAction: 'Run DIAGNOSTICS_run, then submit one controlled Gravity Forms test and verify Webform → Service Request linkage.'
      };
    }, 30000);
  }

  function resetMigrationState() {
    PropertiesService.getScriptProperties().deleteProperty(STATE_PROPERTY);
    return { ok: true, version: VERSION, status: 'STATE_RESET' };
  }

  return {
    version: VERSION,
    previewMigration: previewMigration,
    inspectMigrationState: inspectMigrationState,
    createOrVerifyMigrationBackup: createOrVerifyMigrationBackup,
    continueLeanMigration: continueLeanMigration,
    resetMigrationState: resetMigrationState
  };
})();
