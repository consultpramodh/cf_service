/************************************************************
 * APPS SCRIPT — 70_Customer_360.gs
 * CF ServiceOps — Deterministic Customer 360 Reporting Layer
 * Version: 4.3.8
 *
 * AUTHORITY
 * - Source sheets and validated Striven report caches establish facts.
 * - Deterministic identifiers establish relationships.
 * - Customer 360 only presents derived facts.
 * - This module never calls a Striven write endpoint.
 * - Optional OpenAI enrichment is isolated in 75_Customer_360_AI.gs.
 ************************************************************/
var CF = CF || {};

CF.Customer360 = (function () {
  'use strict';

  var MODULE_NAME = '70_Customer_360';
  var VERSION = '4.3.8';
  var SHEET_KEY = 'CUSTOMER_360';
  var BACKUP_PREFIX = 'Backup - Customer 360 - ';
  var SOURCE_SHEET_KEYS = [
    'SERVICE_REQUESTS',
    'WEBFORM_REQUESTS',
    'STRIVEN_CUSTOMER_DATA',
    'STRIVEN_LOCATION_DATA',
    'STRIVEN_OPERATIONAL_DATA',
    'CAMPAIGN_MASTER'
  ];
  var AI_HEADERS = [
    'AI Customer Overview',
    'AI Service History Summary',
    'AI Equipment Summary',
    'AI Open Work Summary',
    'AI Review Recommendation',
    'AI Missing Data Categories',
    'AI Contradictions',
    'AI Confidence',
    'AI Model',
    'AI Generated At',
    'AI Input Fingerprint',
    'AI Enrichment Status',
    'AI Enrichment Error'
  ];
  var VOLATILE_HEADERS = [
    'Last Refreshed At',
    'Customer Cache Timestamp',
    'Location Cache Timestamp',
    'Operational Cache Timestamp',
    'Source Selection Summary',
    'Customer 360 Version',
    'Factual Profile Fingerprint'
  ];

  function deps_() {
    if (!CF.Config || !CF.Util || !CF.StrivenData) {
      throw new Error('CF.Config, CF.Util and CF.StrivenData are required.');
    }
    return {
      config: CF.Config,
      util: CF.Util,
      striven: CF.StrivenData
    };
  }

  function clean_(value) {
    return deps_().util.cleanText(value);
  }

  function id_(value) {
    return clean_(value);
  }

  function asArray_(value) {
    return Array.isArray(value) ? value : [];
  }

  function unique_(values) {
    var d = deps_();
    return d.util.dedupeArray((values || []).map(clean_).filter(Boolean));
  }

  function number_(value) {
    if (typeof value === 'number' && isFinite(value)) return value;
    var text = clean_(value).replace(/[^0-9.\-]/g, '');
    if (!text || text === '-' || text === '.') return null;
    var parsed = Number(text);
    return isFinite(parsed) ? parsed : null;
  }

  function sum_(values) {
    var total = 0;
    var found = false;
    (values || []).forEach(function (value) {
      var parsed = number_(value);
      if (parsed === null) return;
      found = true;
      total += parsed;
    });
    return found ? total : '';
  }

  function dateMs_(value) {
    if (value instanceof Date && !isNaN(value.getTime())) return value.getTime();
    var text = clean_(value);
    if (!text) return 0;
    var date = new Date(text);
    return isNaN(date.getTime()) ? 0 : date.getTime();
  }

  function dateDisplay_(value) {
    if (value instanceof Date && !isNaN(value.getTime())) return value;
    var text = clean_(value);
    if (!text) return '';
    var date = new Date(text);
    return isNaN(date.getTime()) ? text : date;
  }

  function latestDate_(values) {
    var best = '';
    var bestMs = 0;
    (values || []).forEach(function (value) {
      var ms = dateMs_(value);
      if (ms > bestMs) {
        bestMs = ms;
        best = value;
      }
    });
    return dateDisplay_(best);
  }

  function earliestDate_(values) {
    var best = '';
    var bestMs = 0;
    (values || []).forEach(function (value) {
      var ms = dateMs_(value);
      if (!ms) return;
      if (!bestMs || ms < bestMs) {
        bestMs = ms;
        best = value;
      }
    });
    return dateDisplay_(best);
  }

  function newestFirst_(rows, fields) {
    fields = fields || [];
    return (rows || []).slice().sort(function (a, b) {
      function score_(row) {
        for (var i = 0; i < fields.length; i++) {
          var score = dateMs_(row[fields[i]]);
          if (score) return score;
        }
        return 0;
      }
      return score_(b) - score_(a);
    });
  }

  function statusClass_(value) {
    var status = clean_(value).toUpperCase();
    if (/CANCEL|VOID|DELETED/.test(status)) return 'CANCELLED';
    if (/COMPLETE|COMPLETED|CLOSED|DONE|FINISHED|INVOICED|PAID/.test(status)) return 'COMPLETED';
    return 'OPEN';
  }

  function isActive_(value) {
    var status = clean_(value).toUpperCase();
    if (!status) return true;
    return statusClass_(status) === 'OPEN' && !/INACTIVE|DISABLED|ARCHIVED/.test(status);
  }

  function yes_(value) {
    return deps_().util.toBoolean(value, false);
  }

  function lines_(values, maximumLength) {
    var d = deps_();
    var max = Number(maximumLength || d.config.getDefault('CUSTOMER_360_SUMMARY_MAX_CELL_LENGTH') || 4000);
    var text = (values || []).map(function (value) {
      return clean_(value);
    }).filter(Boolean).join('\n');
    return max && text.length > max ? text.substring(0, Math.max(0, max - 3)) + '...' : text;
  }

  function label_(label, value) {
    var clean = clean_(value);
    return clean ? label + ': ' + clean : '';
  }

  function identity_(prefix, idValue, numberValue, nameValue) {
    var parts = [];
    if (clean_(numberValue)) parts.push('#' + clean_(numberValue));
    else if (clean_(idValue)) parts.push(clean_(idValue));
    if (clean_(nameValue)) parts.push(clean_(nameValue));
    return (prefix ? prefix + ' ' : '') + parts.join(' — ');
  }

  function countFilled_(record) {
    var count = 0;
    Object.keys(record || {}).forEach(function (key) {
      if (key.indexOf('__') === 0) return;
      if (clean_(record[key])) count++;
    });
    return count;
  }

  function selectBestById_(rows, idHeader) {
    var best = {};
    var duplicates = {};
    var missingId = [];

    (rows || []).forEach(function (row) {
      var key = id_(row[idHeader]);
      if (!key) {
        missingId.push(row);
        return;
      }
      if (!best[key]) {
        best[key] = row;
        return;
      }
      duplicates[key] = (duplicates[key] || 1) + 1;
      var currentScore = dateMs_(best[key]['Source Updated At'] || best[key]['Updated At']) * 1000 + countFilled_(best[key]);
      var candidateScore = dateMs_(row['Source Updated At'] || row['Updated At']) * 1000 + countFilled_(row);
      if (candidateScore > currentScore) best[key] = row;
    });

    return {
      byId: best,
      rows: Object.keys(best).map(function (key) { return best[key]; }),
      duplicateIds: Object.keys(duplicates),
      missingIdRows: missingId
    };
  }

  function dedupeRecords_(rows, idHeader, fallbackFields) {
    var d = deps_();
    var seen = {};
    var output = [];

    (rows || []).forEach(function (row, index) {
      var durableId = id_(row[idHeader]);
      var key = durableId ? 'ID|' + durableId : 'ROW|' + index;
      if (!durableId && fallbackFields && fallbackFields.length) {
        var fallback = fallbackFields.map(function (header) {
          return d.util.normalizeKey(row[header]);
        }).join('|');
        if (fallback.replace(/\|/g, '')) key = 'FALLBACK|' + fallback + '|ROW|' + index;
      }
      if (seen[key]) {
        var existing = seen[key];
        Object.keys(row || {}).forEach(function (header) {
          if (!clean_(existing[header]) && clean_(row[header])) existing[header] = row[header];
        });
        return;
      }
      var copy = deps_().util.clone(row);
      seen[key] = copy;
      output.push(copy);
    });

    return output;
  }

  function readSources_(options) {
    options = options || {};
    var d = deps_();
    return {
      serviceRequests: d.util.readObjects('SERVICE_REQUESTS', { includeRowNumber: true }),
      webformRequests: d.util.readObjects('WEBFORM_REQUESTS', { includeRowNumber: false }),
      customersAndContacts: d.util.readObjectsExcludingHeaders(
        'STRIVEN_CUSTOMER_DATA', ['Raw Source JSON'], { includeRowNumber: true }
      ),
      locations: d.util.readObjectsExcludingHeaders(
        'STRIVEN_LOCATION_DATA', ['Raw Source JSON'], { includeRowNumber: true }
      ),
      operational: d.util.readObjectsExcludingHeaders(
        'STRIVEN_OPERATIONAL_DATA', ['Raw Source JSON'], { includeRowNumber: true }
      ),
      campaigns: d.util.readObjects('CAMPAIGN_MASTER', { includeRowNumber: false }),
      systemLog: d.util.readObjects('SYSTEM_LOG', { includeRowNumber: false }),
      existingCustomer360: options.includeExistingCustomer360 === false
        ? []
        : (d.util.getSheet(SHEET_KEY)
          ? d.util.readObjects(SHEET_KEY, { includeRowNumber: true })
          : [])
    };
  }

  function sheetMetadata_() {
    var d = deps_();
    var output = {};
    SOURCE_SHEET_KEYS.forEach(function (key) {
      var sheet = d.util.getSheet(key);
      output[d.config.getSheetName(key)] = sheet ? d.util.getSheetMetadata(sheet) : {
        sheet: d.config.getSheetName(key), rows: 0, columns: 0, missing: true
      };
    });
    return output;
  }

  function cacheTimestamp_(rows) {
    return latestDate_((rows || []).map(function (row) { return row['Cache Updated At']; }));
  }

  function domainRows_(sources, reportKey, entityType) {
    if (entityType === 'CUSTOMER' || entityType === 'CONTACT') {
      return sources.customersAndContacts.filter(function (row) {
        return clean_(row['Entity Type']).toUpperCase() === entityType;
      });
    }
    if (entityType === 'LOCATION') return sources.locations;
    return sources.operational.filter(function (row) {
      var sourceKey = clean_(row['Source Report Key'] || row['Source Report']).toUpperCase();
      if (sourceKey === reportKey) return true;
      return clean_(row['Entity Type']).toUpperCase() === entityType && !sourceKey;
    });
  }

  function buildSourceSelection_(sources, discovery, options) {
    options = options || {};
    var d = deps_();
    var refreshed = {};
    var reportErrors = {};
    asArray_(options.refreshedReportKeys).forEach(function (key) { refreshed[clean_(key).toUpperCase()] = true; });
    asArray_(options.reportErrors).forEach(function (item) { reportErrors[clean_(item.key).toUpperCase()] = true; });
    var selection = {};

    (discovery.reports || []).forEach(function (report) {
      var spec = null;
      d.striven.getReportSpecs().some(function (candidate) {
        if (candidate.key === report.key) { spec = candidate; return true; }
        return false;
      });
      var rows = spec ? domainRows_(sources, report.key, spec.entity) : [];
      var fresh = spec ? d.striven.isCacheFresh(spec.cache) : false;
      var key = report.domain || report.key;

      if (refreshed[report.key]) selection[key] = 'REPORT REFRESH';
      else if (reportErrors[report.key] && !rows.length) selection[key] = 'BLOCKED';
      else if (rows.length && fresh) selection[key] = 'FRESH CACHE';
      else if (rows.length) selection[key] = 'STALE CACHE';
      else if (report.found) selection[key] = 'MISSING';
      else selection[key] = 'MISSING';
    });

    selection.SERVICE_REQUESTS = sources.serviceRequests.length ? 'FRESH CACHE' : 'MISSING';
    selection.WEBFORM_REQUESTS = sources.webformRequests.length ? 'FRESH CACHE' : 'MISSING';
    selection.CAMPAIGNS = sources.campaigns.length ? 'FRESH CACHE' : 'MISSING';
    if ((discovery.unmappedReportLikeProperties || []).length) {
      selection.UNMAPPED_REPORT_PROPERTIES = 'UNMAPPED';
    }
    return selection;
  }

  function reportDiagnosticsFromCache_(sources) {
    var d = deps_();
    var specs = d.striven.getReportSpecs();
    var validated = [];
    var rejected = [];
    var headers = {};
    var blankIds = {};
    var duplicateIds = {};
    var idHeaders = {
      CUSTOMER: 'Customer ID', CONTACT: 'Contact ID', LOCATION: 'Location ID',
      ASSET: 'Asset ID', OPPORTUNITY: 'Opportunity ID', WORK_ORDER: 'Work Order ID',
      TASK: 'Task ID', INVOICE: 'Invoice ID', PAYMENT: 'Payment ID',
      COLLECTION: 'Collection ID', REVENUE: 'Revenue ID'
    };

    specs.forEach(function (spec) {
      var rows = domainRows_(sources, spec.key, spec.entity);
      var idHeader = idHeaders[spec.entity] || 'Entity ID';
      var ids = rows.map(function (row) { return id_(row[idHeader] || row['Entity ID']); });
      var nonBlank = ids.filter(Boolean);
      var distinct = unique_(nonBlank);
      blankIds[spec.key] = ids.length - nonBlank.length;
      duplicateIds[spec.key] = Math.max(0, nonBlank.length - distinct.length);
      headers[spec.key] = rows.length ? Object.keys(rows[0]).filter(function (h) {
        return h.indexOf('__') !== 0 && h !== 'Raw Source JSON';
      }) : [];
      var invalid = rows.some(function (row) {
        return /MISSING ID|REJECTED|ERROR/i.test(clean_(row['Normalization Status'])) ||
          /unsafe|missing durable/i.test(clean_(row['Mapping Warnings']));
      });
      if (rows.length && !invalid) validated.push(spec.key);
      else if (rows.length && invalid) rejected.push(spec.key);
    });

    return {
      validated: validated,
      rejected: rejected,
      headers: headers,
      blankIds: blankIds,
      duplicateIds: duplicateIds
    };
  }

  function lastDataStatus_(systemLog) {
    var output = {};
    newestFirst_((systemLog || []).filter(function (row) {
      return clean_(row['Record Type']).toUpperCase() === 'DATA_STATUS';
    }), ['Timestamp']).forEach(function (row) {
      var key = clean_(row['Data Source']);
      if (!output[key]) output[key] = row;
    });
    return output;
  }

  function hydrateOperationalRelationshipFields_(rows) {
    var d = deps_();
    var stats = {
      algorithm: 'CONTROLLED_RAW_JSON_RELATIONSHIP_RECOVERY',
      rowsInspected: (rows || []).length,
      rawJsonRowsAvailable: 0,
      rawJsonRowsParsed: 0,
      rawJsonParseFailures: 0,
      rowsHydrated: 0,
      multiValueFieldsSkipped: 0,
      recoveredByField: {},
      recoveredBySourceDomain: {}
    };

    function configuredAliases_(entityType, field, extras) {
      var aliases = [];
      try {
        aliases = d.config.getReportFieldAliases(entityType)[field] || [];
      } catch (ignore) {
        aliases = [];
      }
      return unique_(aliases.concat(extras || []));
    }

    function scalarValue_(value) {
      if (Array.isArray(value)) {
        if (value.length !== 1) return '';
        return value[0];
      }
      if (value && typeof value === 'object') return '';
      return value;
    }

    function recover_(row, raw, entityType, header, aliasField, extras) {
      if (clean_(row[header])) return false;
      var value = scalarValue_(d.util.getAny(
        raw,
        configuredAliases_(entityType, aliasField, extras),
        ''
      ));
      if (!clean_(value)) {
        var possible = d.util.getAny(raw, configuredAliases_(entityType, aliasField, extras), '');
        if (Array.isArray(possible) && possible.length > 1) stats.multiValueFieldsSkipped += 1;
        return false;
      }
      row[header] = clean_(value);
      stats.recoveredByField[header] = (stats.recoveredByField[header] || 0) + 1;
      var domain = clean_(row['Source Domain'] || row['Source Report Key'] || row['Source Report']) || 'UNKNOWN';
      stats.recoveredBySourceDomain[domain] = stats.recoveredBySourceDomain[domain] || {};
      stats.recoveredBySourceDomain[domain][header] =
        (stats.recoveredBySourceDomain[domain][header] || 0) + 1;
      return true;
    }

    (rows || []).forEach(function (row) {
      var rawText = clean_(row['Raw Source JSON']);
      if (!rawText) return;
      stats.rawJsonRowsAvailable += 1;
      var raw = d.util.parseJson(rawText, null);
      if (!raw || typeof raw !== 'object') {
        stats.rawJsonParseFailures += 1;
        return;
      }
      stats.rawJsonRowsParsed += 1;
      var type = clean_(row['Entity Type']).toUpperCase();
      if (!type) return;
      var hydrated = false;

      hydrated = recover_(row, raw, type, 'Customer ID', 'CUSTOMER_ID', [
        'Customer ID', 'CustomerId', 'CustomerID', 'Customer Id',
        'Customer Number', 'CustomerNumber', 'Customer #', 'Customer: Number',
        'Account ID', 'AccountId', 'Account Number'
      ]) || hydrated;
      hydrated = recover_(row, raw, type, 'Contact ID', 'CONTACT_ID', [
        'Contact ID', 'ContactId', 'ContactID', 'Requested By Contact ID',
        'RequestedByContactId', 'Primary Contact ID'
      ]) || hydrated;
      hydrated = recover_(row, raw, type, 'Location ID', 'LOCATION_ID', [
        'Location ID', 'LocationId', 'Customer Location ID', 'CustomerLocationId',
        'Ship To Location ID', 'Ship To Address Id', 'ShipToAddressId',
        'Service Location ID', 'Address Id', 'AddressId'
      ]) || hydrated;

      if (type === 'ASSET' || type === 'TASK' || type === 'WORK_ORDER' || type === 'INVOICE') {
        hydrated = recover_(row, raw, type, 'Asset ID', 'ASSET_ID', [
          'Asset ID', 'AssetId', 'Customer Asset ID', 'CustomerAssetId'
        ]) || hydrated;
      }

      if (type === 'WORK_ORDER' || type === 'TASK' || type === 'INVOICE') {
        hydrated = recover_(row, raw, type, 'Work Order ID', 'WORK_ORDER_ID', [
          'Work Order ID', 'WorkOrderId', 'WorkOrderID', 'Work Order Id',
          'Service Work Order ID', 'ServiceWorkOrderId', 'Service Work Order Id',
          'Service Order ID', 'ServiceOrderId', 'Sales Order ID', 'SalesOrderId',
          'SalesOrderID', 'Sales Order Id', 'SOId', 'SO Id', 'SO ID',
          'Order ID', 'OrderId'
        ]) || hydrated;
        hydrated = recover_(row, raw, type, 'Work Order Number', 'WORK_ORDER_NUMBER', [
          'Work Order Number', 'Work Order #', 'WorkOrderNumber',
          'Service Work Order Number', 'Service Work Order #',
          'Service Order Number', 'Service Order #',
          'Sales Order Number', 'Sales Order #', 'SalesOrderNumber',
          'SO Number', 'SONumber', 'SO #', 'Order Number', 'Order #'
        ]) || hydrated;
      }

      if (type === 'TASK') {
        hydrated = recover_(row, raw, type, 'Task ID', 'TASK_ID', [
          'Task ID', 'TaskId', 'TaskID', 'Id'
        ]) || hydrated;
        if (!clean_(row['Parent Entity ID'])) {
          row['Parent Entity ID'] = clean_(row['Work Order ID'] || row['Work Order Number']);
        }
        if (clean_(row['Parent Entity ID']) && !clean_(row['Parent Entity Type'])) {
          row['Parent Entity Type'] = 'WORK_ORDER';
        }
      }

      if (hydrated) stats.rowsHydrated += 1;
    });

    return stats;
  }

  function buildRelationships_(sources) {
    var d = deps_();
    var customerRows = sources.customersAndContacts.filter(function (row) {
      return clean_(row['Entity Type']).toUpperCase() === 'CUSTOMER';
    });
    var contactRows = sources.customersAndContacts.filter(function (row) {
      return clean_(row['Entity Type']).toUpperCase() === 'CONTACT';
    });
    var selectedCustomers = selectBestById_(customerRows, 'Customer ID');
    var selectedLocations = selectBestById_(sources.locations, 'Location ID');
    var customersById = selectedCustomers.byId;
    var locationOwner = {};
    var locationConflicts = {};
    var validLocations = [];
    var orphans = {
      contacts: [], locations: [], assets: [], workOrders: [],
      tasks: [], serviceRequests: []
    };
    var ambiguous = [];
    var customerOwnerByNumber = {};
    var customerNumberConflicts = {};
    var relationshipDiagnostics = {
      algorithm: 'SOURCE_AUTHORITY_RELATIONSHIP_DIAGNOSTICS',
      customerNumbers: {
        uniqueNumbers: 0,
        conflictedNumbers: 0,
        fromCustomerCache: 0,
        bootstrappedFromTaskRelationships: 0,
        bootstrappedFromLocations: 0,
        bootstrappedFromServiceRequests: 0
      },
      tasks: {
        taskReportRows: 0,
        taskRelationshipRows: 0,
        uniqueTaskReportIds: 0,
        uniqueRelationshipTaskIds: 0,
        overlappingTaskIds: 0,
        tasksOnlyInTaskReport: 0,
        tasksOnlyInRelationshipReport: 0,
        relationshipCustomerIdsFound: 0,
        relationshipCustomerIdsMissing: 0,
        mergedTasks: 0,
        multipleCustomerIdConflicts: 0,
        fieldConflicts: 0,
        ignoredUntrustedCustomerReferences: 0,
        resolvedDirectCustomerId: 0,
        resolvedThroughWorkOrder: 0,
        resolvedThroughAsset: 0,
        rejectedDueConflict: 0,
        unresolvedNoOwnershipEvidence: 0
      },
      workOrders: {
        rows: 0,
        customerNumberReferences: 0,
        customerNumberResolved: 0,
        customerNumberMissing: 0,
        customerNumberNotFound: 0,
        customerNumberAmbiguous: 0,
        locationReferences: 0,
        locationResolved: 0,
        resolvedThroughCustomerNumber: 0,
        resolvedThroughShipToAddressId: 0,
        resolvedThroughTaskRelationship: 0,
        resolvedThroughServiceRequest: 0,
        resolvedWithMultipleEvidenceTypes: 0,
        rejectedDueConflict: 0,
        unresolvedCustomerNumberMissing: 0,
        unresolvedCustomerNumberNotFound: 0,
        unresolvedCustomerNumberAmbiguous: 0,
        unresolvedNoOwnershipEvidence: 0
      }
    };

    function addCustomerNumberOwner_(customerNumber, customerId, evidenceType) {
      var number = id_(customerNumber);
      var cid = id_(customerId);
      if (!number || !cid || !customersById[cid]) return false;

      if (Object.prototype.hasOwnProperty.call(customerOwnerByNumber, number)) {
        if (customerOwnerByNumber[number] === cid) return true;
        customerNumberConflicts[number] = true;
        customerOwnerByNumber[number] = null;
        return false;
      }

      if (customerNumberConflicts[number]) return false;
      customerOwnerByNumber[number] = cid;

      if (evidenceType === 'CUSTOMER_CACHE') {
        relationshipDiagnostics.customerNumbers.fromCustomerCache += 1;
      } else if (evidenceType === 'TASK_RELATIONSHIP') {
        relationshipDiagnostics.customerNumbers.bootstrappedFromTaskRelationships += 1;
      } else if (evidenceType === 'LOCATION') {
        relationshipDiagnostics.customerNumbers.bootstrappedFromLocations += 1;
      } else if (evidenceType === 'SERVICE_REQUEST') {
        relationshipDiagnostics.customerNumbers.bootstrappedFromServiceRequests += 1;
      }

      return true;
    }

    function refreshCustomerNumberDiagnostics_() {
      relationshipDiagnostics.customerNumbers.uniqueNumbers = Object.keys(customerOwnerByNumber)
        .filter(function (number) { return !!customerOwnerByNumber[number]; })
        .length;
      relationshipDiagnostics.customerNumbers.conflictedNumbers = Object.keys(customerNumberConflicts).length;
    }

    selectedCustomers.rows.forEach(function (row) {
      addCustomerNumberOwner_(
        row['Customer Number'],
        row['Customer ID'],
        'CUSTOMER_CACHE'
      );
    });
    refreshCustomerNumberDiagnostics_();

    selectedLocations.rows.forEach(function (row) {
      var lid = id_(row['Location ID']);
      var cid = id_(row['Customer ID']);
      if (!lid || !cid || !customersById[cid]) {
        orphans.locations.push(row);
        return;
      }
      if (locationOwner[lid] && locationOwner[lid] !== cid) {
        locationConflicts[lid] = true;
        ambiguous.push({
          type: 'LOCATION_OWNER_CONFLICT',
          locationId: lid,
          customerIds: unique_([locationOwner[lid], cid])
        });
        return;
      }
      locationOwner[lid] = cid;
      validLocations.push(row);
    });

    var contactsByCustomer = {};
    var contactOwner = {};
    dedupeRecords_(contactRows, 'Contact ID', ['Customer ID', 'Email', 'Phone']).forEach(function (row) {
      var cid = id_(row['Customer ID']);
      var contactId = id_(row['Contact ID']);
      if (!cid || !customersById[cid]) {
        orphans.contacts.push(row);
        return;
      }
      contactsByCustomer[cid] = contactsByCustomer[cid] || [];
      contactsByCustomer[cid].push(row);
      if (contactId) {
        if (contactOwner[contactId] && contactOwner[contactId] !== cid) {
          ambiguous.push({
            type: 'CONTACT_OWNER_CONFLICT',
            contactId: contactId,
            customerIds: unique_([contactOwner[contactId], cid])
          });
          contactOwner[contactId] = null;
        } else if (contactOwner[contactId] !== null) {
          contactOwner[contactId] = cid;
        }
      }
    });

    var locationsByCustomer = {};
    validLocations.forEach(function (row) {
      var cid = id_(row['Customer ID']);
      locationsByCustomer[cid] = locationsByCustomer[cid] || [];
      locationsByCustomer[cid].push(row);
    });

    var relationshipFieldRecovery = hydrateOperationalRelationshipFields_(sources.operational);
    var rawOperationalByType = {};
    sources.operational.forEach(function (row) {
      var type = clean_(row['Entity Type']).toUpperCase();
      rawOperationalByType[type] = rawOperationalByType[type] || [];
      rawOperationalByType[type].push(row);
    });

    function evidence_() {
      return { customers: {}, locations: {}, warnings: [], sources: [], tags: {} };
    }

    function tagEvidence_(ev, tag) {
      if (tag) ev.tags[tag] = true;
    }

    function addWarning_(ev, warning) {
      var clean = clean_(warning);
      if (clean && ev.warnings.indexOf(clean) === -1) ev.warnings.push(clean);
    }

    function addCustomerEvidence_(ev, customerId, sourceLabel, tag) {
      var cid = id_(customerId);
      if (!cid) return false;
      if (!customersById[cid]) {
        addWarning_(ev, 'Unknown Customer ID ' + cid + (sourceLabel ? ' from ' + sourceLabel : ''));
        if (tag) tagEvidence_(ev, tag + '_NOT_FOUND');
        return false;
      }
      ev.customers[cid] = true;
      if (sourceLabel) ev.sources.push(sourceLabel + ' → Customer ' + cid);
      if (tag) tagEvidence_(ev, tag);
      return true;
    }

    function addCustomerNumberEvidence_(ev, customerNumber, sourceLabel) {
      var number = id_(customerNumber);
      if (!number) {
        tagEvidence_(ev, 'CUSTOMER_NUMBER_MISSING');
        return 'MISSING';
      }
      tagEvidence_(ev, 'CUSTOMER_NUMBER_REFERENCE');
      if (customerNumberConflicts[number]) {
        addWarning_(ev, 'Customer Number ' + number + ' maps to multiple Customer IDs');
        tagEvidence_(ev, 'CUSTOMER_NUMBER_AMBIGUOUS');
        return 'AMBIGUOUS';
      }
      var customerId = customerOwnerByNumber[number];
      if (!customerId) {
        addWarning_(ev, 'Customer Number ' + number + ' was not found in the Customer cache');
        tagEvidence_(ev, 'CUSTOMER_NUMBER_NOT_FOUND');
        return 'NOT_FOUND';
      }
      addCustomerEvidence_(ev, customerId, sourceLabel || 'Customer Number', 'CUSTOMER_NUMBER_RESOLVED');
      return 'RESOLVED';
    }

    function addLocationEvidence_(ev, locationId, sourceLabel) {
      var lid = id_(locationId);
      if (!lid) return;
      if (locationConflicts[lid]) {
        addWarning_(ev, 'Location ownership is conflicted for ' + lid);
        return;
      }
      var cid = locationOwner[lid];
      if (!cid) {
        addWarning_(ev, 'Location ownership is missing for ' + lid);
        return;
      }
      ev.locations[lid] = true;
      addCustomerEvidence_(ev, cid, sourceLabel ? sourceLabel + ' location' : 'Location');
    }

    function addContactEvidence_(ev, contactId, sourceLabel) {
      var contact = id_(contactId);
      if (!contact) return;
      var cid = contactOwner[contact];
      if (!cid) {
        addWarning_(ev, 'Contact ownership is missing or conflicted for ' + contact);
        return;
      }
      addCustomerEvidence_(ev, cid, sourceLabel ? sourceLabel + ' contact' : 'Contact');
    }

    function addMapEvidence_(ev, key, ownerMap, locationMap, sourceLabel) {
      var cleanKey = id_(key);
      if (!cleanKey) return;
      if (ownerMap[cleanKey]) addCustomerEvidence_(ev, ownerMap[cleanKey], sourceLabel);
      if (locationMap && locationMap[cleanKey]) addLocationEvidence_(ev, locationMap[cleanKey], sourceLabel);
    }

    function addDirectRowEvidence_(ev, row, sourceLabel, assetOwner, assetLocation) {
      var entityType = clean_(row['Entity Type']).toUpperCase();
      var sourceDomain = clean_(row['Source Domain'] || row['Source Report Key'] || row['Source Report']).toUpperCase();
      var details = {
        customerReferenceStatus: '',
        directCustomerIdResolved: false,
        directLocationReferenced: false,
        directLocationResolved: false,
        directAssetResolved: false
      };

      if (entityType === 'WORK_ORDER' && sourceDomain === 'WORK_ORDERS') {
        details.customerReferenceStatus = addCustomerNumberEvidence_(
          ev,
          row['Customer ID'],
          sourceLabel + ' Customer Number'
        );
      } else {
        details.directCustomerIdResolved = addCustomerEvidence_(
          ev,
          row['Customer ID'],
          sourceLabel + ' direct',
          'DIRECT_CUSTOMER_ID'
        );
      }

      if (id_(row['Location ID'])) {
        details.directLocationReferenced = true;
        var beforeLocations = Object.keys(ev.locations).length;
        addLocationEvidence_(ev, row['Location ID'], sourceLabel + ' direct');
        details.directLocationResolved = Object.keys(ev.locations).length > beforeLocations;
        if (details.directLocationResolved) tagEvidence_(ev, 'DIRECT_LOCATION_RESOLVED');
      }
      addContactEvidence_(ev, row['Contact ID'], sourceLabel);
      if (assetOwner && id_(row['Asset ID'])) {
        var beforeCustomers = Object.keys(ev.customers).length;
        addMapEvidence_(ev, row['Asset ID'], assetOwner, assetLocation, sourceLabel + ' asset');
        details.directAssetResolved = Object.keys(ev.customers).length > beforeCustomers;
        if (details.directAssetResolved) tagEvidence_(ev, 'ASSET_EVIDENCE');
      }
      return details;
    }

    function evaluateEvidence_(ev) {
      var customerIds = Object.keys(ev.customers);
      if (!customerIds.length) {
        return { ok: false, conflict: false, warnings: ev.warnings.slice(), customerIds: [], locationIds: [], tags: ev.tags };
      }
      if (customerIds.length > 1) {
        return {
          ok: false,
          conflict: true,
          warnings: ev.warnings.slice(),
          customerIds: customerIds,
          locationIds: Object.keys(ev.locations),
          tags: ev.tags
        };
      }
      var customerId = customerIds[0];
      var locationIds = Object.keys(ev.locations).filter(function (lid) {
        return !locationConflicts[lid] && locationOwner[lid] === customerId;
      });
      if (locationIds.length > 1) {
        addWarning_(ev, 'Multiple confirmed locations support the same customer; record kept at customer level');
        locationIds = [];
      }
      return {
        ok: true,
        conflict: false,
        customerId: customerId,
        locationId: locationIds.length === 1 ? locationIds[0] : '',
        warnings: unique_(ev.warnings),
        customerIds: customerIds,
        locationIds: locationIds,
        tags: ev.tags
      };
    }

    function resolvedCopy_(sourceRow, result) {
      var row = d.util.clone(sourceRow);
      row.__customerId = result.customerId;
      row.__locationId = result.locationId || '';
      row.__relationshipStatus = result.warnings.length ? 'PARTIAL' : 'CONFIRMED';
      row.__relationshipWarnings = result.warnings.slice();
      row.__relationshipEvidenceTags = Object.keys(result.tags || {});
      return row;
    }

    function recordConflict_(type, sourceRow, idHeader, result) {
      ambiguous.push({
        type: type + '_OWNERSHIP_CONFLICT',
        entityId: id_(sourceRow[idHeader] || sourceRow['Entity ID']),
        customerIds: result.customerIds || [],
        locationIds: result.locationIds || [],
        warnings: result.warnings || []
      });
    }

    function splitIdentifierValues_(value) {
      if (Array.isArray(value)) {
        return unique_(value.reduce(function (all, item) {
          return all.concat(splitIdentifierValues_(item));
        }, []));
      }
      var text = clean_(value);
      if (!text) return [];
      if (/^\[.*\]$/.test(text)) {
        var parsed = d.util.parseJson(text, null);
        if (Array.isArray(parsed)) return splitIdentifierValues_(parsed);
      }
      return unique_(text.split(/[;,|\n]+/).map(clean_).filter(Boolean));
    }

    function mergeTaskRows_(rows) {
      var groups = {};
      var order = [];
      var scalarRelationshipFields = ['Customer ID', 'Contact ID', 'Location ID', 'Work Order ID'];

      function taskSourceType_(row) {
        var domain = clean_(row['Source Domain'] || row['Source Report Key']).toUpperCase();
        var reportKey = clean_(row['Source Report Key']).toUpperCase();
        if (domain === 'TASK_RELATIONSHIPS' || reportKey === 'TASKS_CUSTOMERS_ASSETS') {
          return 'RELATIONSHIP';
        }
        if (domain === 'TASKS') return 'TASK_REPORT';
        return 'OTHER';
      }

      function isTrustedTaskRelationshipField_(sourceType, header) {
        if (header === 'Customer ID' || header === 'Contact ID' || header === 'Location ID') {
          return sourceType === 'RELATIONSHIP';
        }
        if (header === 'Work Order ID') {
          return sourceType === 'TASK_REPORT' || sourceType === 'RELATIONSHIP';
        }
        return true;
      }

      (rows || []).forEach(function (sourceRow, index) {
        var taskId = id_(sourceRow['Task ID']);
        var key = taskId ? 'ID|' + taskId : 'ROW|' + index;
        if (!groups[key]) {
          groups[key] = {
            row: d.util.clone(sourceRow),
            values: {},
            assetIds: {},
            sources: []
          };
          order.push(key);
        }
        var group = groups[key];
        var sourceType = taskSourceType_(sourceRow);
        group.sources.push(clean_(sourceRow['Source Domain'] || sourceRow['Source Report Key'] || sourceRow['Source Report']));
        Object.keys(sourceRow || {}).forEach(function (header) {
          if (!clean_(group.row[header]) && clean_(sourceRow[header])) group.row[header] = sourceRow[header];
        });
        scalarRelationshipFields.forEach(function (header) {
          var value = id_(sourceRow[header]);
          if (!value) return;
          if (!isTrustedTaskRelationshipField_(sourceType, header)) {
            if (header === 'Customer ID') {
              relationshipDiagnostics.tasks.ignoredUntrustedCustomerReferences += 1;
            }
            return;
          }
          group.values[header] = group.values[header] || {};
          group.values[header][value] = true;
        });
        splitIdentifierValues_(sourceRow['Asset ID']).forEach(function (assetId) {
          group.assetIds[assetId] = true;
        });
      });

      var merged = order.map(function (key) {
        var group = groups[key];
        var row = group.row;
        row.__mergedSourceDomains = unique_(group.sources);
        row.__mergeWarnings = [];
        row.__hasRelationshipConflict = false;
        scalarRelationshipFields.forEach(function (header) {
          var values = Object.keys(group.values[header] || {});
          row[header] = '';
          if (values.length === 1) row[header] = values[0];
          if (values.length > 1) {
            row[header] = '';
            row.__hasRelationshipConflict = true;
            row.__mergeWarnings.push('Conflicting ' + header + ' values: ' + values.join(', '));
            relationshipDiagnostics.tasks.fieldConflicts += 1;
            if (header === 'Customer ID') relationshipDiagnostics.tasks.multipleCustomerIdConflicts += 1;
            ambiguous.push({
              type: 'TASK_FIELD_CONFLICT',
              taskId: id_(row['Task ID']),
              field: header,
              values: values
            });
          }
        });
        row.__assetIds = Object.keys(group.assetIds);
        if (row.__assetIds.length === 1) row['Asset ID'] = row.__assetIds[0];
        if (row.__assetIds.length > 1) {
          row['Asset ID'] = '';
          row.__mergeWarnings.push('Multiple Asset IDs retained as relationship evidence: ' + row.__assetIds.join(', '));
        }
        return row;
      });
      relationshipDiagnostics.tasks.mergedTasks = merged.length;
      return merged;
    }

    function workOrderKeysFromRow_(row) {
      var entityType = clean_(row['Entity Type']).toUpperCase();
      return unique_([
        row['Work Order ID'],
        row['Work Order Number'],
        entityType === 'WORK_ORDER' ? row['Entity ID'] : '',
        clean_(row['Parent Entity Type']).toUpperCase() === 'WORK_ORDER' ? row['Parent Entity ID'] : ''
      ]);
    }

    function workOrderKeysFromRequest_(row) {
      return unique_([
        row['Work Order ID'],
        row['Work Order Number'],
        row['Existing Active Work Order ID'],
        row['Existing Active Work Order Number'],
        row['Last Work Order ID']
      ]);
    }

    function taskKeysFromRequest_(row) {
      return unique_([
        row['Task ID'],
        row['Existing Active Task ID'],
        row['Last Service Task ID']
      ]);
    }

    var resolvedByType = {};
    var assetOwner = {};
    var assetLocation = {};

    function resolveDirectRows_(type, rows, options) {
      options = options || {};
      var resolved = [];
      dedupeRecords_(rows, options.idHeader || 'Entity ID', options.fallbackFields || []).forEach(function (sourceRow) {
        var ev = evidence_();
        addDirectRowEvidence_(ev, sourceRow, type, options.useAssetEvidence ? assetOwner : null, options.useAssetEvidence ? assetLocation : null);
        var result = evaluateEvidence_(ev);
        if (!result.ok) {
          if (result.conflict) recordConflict_(type, sourceRow, options.idHeader || 'Entity ID', result);
          orphans[options.orphanKey || type.toLowerCase()].push(sourceRow);
          return;
        }
        var row = resolvedCopy_(sourceRow, result);
        resolved.push(row);
        if (type === 'ASSET') {
          var assetId = id_(row['Asset ID']);
          if (assetId) {
            assetOwner[assetId] = result.customerId;
            if (result.locationId) assetLocation[assetId] = result.locationId;
          }
        }
      });
      resolvedByType[type] = resolved;
      return resolved;
    }

    resolveDirectRows_('ASSET', rawOperationalByType.ASSET || [], {
      idHeader: 'Asset ID', orphanKey: 'assets'
    });

    var allTaskRows = rawOperationalByType.TASK || [];
    var taskReportRows = allTaskRows.filter(function (row) {
      return clean_(row['Source Domain'] || row['Source Report Key']).toUpperCase() === 'TASKS';
    });
    var taskRelationshipRows = allTaskRows.filter(function (row) {
      return clean_(row['Source Domain'] || row['Source Report Key']).toUpperCase() === 'TASK_RELATIONSHIPS' ||
        clean_(row['Source Report Key']).toUpperCase() === 'TASKS_CUSTOMERS_ASSETS';
    });
    var taskReportIds = {};
    var taskRelationshipIds = {};
    taskReportRows.forEach(function (row) { var key = id_(row['Task ID']); if (key) taskReportIds[key] = true; });
    taskRelationshipRows.forEach(function (row) {
      var key = id_(row['Task ID']);
      if (key) taskRelationshipIds[key] = true;
      var customerId = id_(row['Customer ID']);
      if (!customerId) return;
      if (customersById[customerId]) relationshipDiagnostics.tasks.relationshipCustomerIdsFound += 1;
      else relationshipDiagnostics.tasks.relationshipCustomerIdsMissing += 1;
    });
    relationshipDiagnostics.tasks.taskReportRows = taskReportRows.length;
    relationshipDiagnostics.tasks.taskRelationshipRows = taskRelationshipRows.length;
    relationshipDiagnostics.tasks.uniqueTaskReportIds = Object.keys(taskReportIds).length;
    relationshipDiagnostics.tasks.uniqueRelationshipTaskIds = Object.keys(taskRelationshipIds).length;
    Object.keys(taskReportIds).forEach(function (key) {
      if (taskRelationshipIds[key]) relationshipDiagnostics.tasks.overlappingTaskIds += 1;
      else relationshipDiagnostics.tasks.tasksOnlyInTaskReport += 1;
    });
    Object.keys(taskRelationshipIds).forEach(function (key) {
      if (!taskReportIds[key]) relationshipDiagnostics.tasks.tasksOnlyInRelationshipReport += 1;
    });

    var mergedTasks = mergeTaskRows_(allTaskRows);
    var workOrderRows = dedupeRecords_(
      rawOperationalByType.WORK_ORDER || [],
      'Work Order ID',
      ['Work Order Number']
    );
    var workOrderRowsByNumber = {};
    var workOrderRowsByKey = {};

    workOrderRows.forEach(function (row) {
      var number = id_(row['Work Order Number']);
      if (number) {
        workOrderRowsByNumber[number] = workOrderRowsByNumber[number] || [];
        workOrderRowsByNumber[number].push(row);
      }
      workOrderKeysFromRow_(row).forEach(function (key) {
        var cleanKey = id_(key);
        if (!cleanKey) return;
        workOrderRowsByKey[cleanKey] = workOrderRowsByKey[cleanKey] || [];
        workOrderRowsByKey[cleanKey].push(row);
      });
    });

    /*
     * Customer Number is a different identifier type from Customer ID.
     * Bootstrap the crosswalk only from already-confirmed relationships:
     * Task relationship CustomerId, owned Location, or matched Service Request.
     */
    mergedTasks.forEach(function (row) {
      if (row.__hasRelationshipConflict) return;
      var customerId = id_(row['Customer ID']);
      var workOrderNumber = id_(row['Work Order Number']);
      if (!customerId || !customersById[customerId] || !workOrderNumber) return;
      (workOrderRowsByNumber[workOrderNumber] || []).forEach(function (workOrderRow) {
        addCustomerNumberOwner_(
          workOrderRow['Customer ID'],
          customerId,
          'TASK_RELATIONSHIP'
        );
      });
    });

    workOrderRows.forEach(function (row) {
      var locationId = id_(row['Location ID']);
      var customerId = locationId && !locationConflicts[locationId]
        ? locationOwner[locationId]
        : '';
      if (!customerId) return;
      addCustomerNumberOwner_(
        row['Customer ID'],
        customerId,
        'LOCATION'
      );
    });
    refreshCustomerNumberDiagnostics_();

    var taskPreResolved = [];
    mergedTasks.forEach(function (sourceRow) {
      if (sourceRow.__hasRelationshipConflict) return;
      var ev = evidence_();
      addDirectRowEvidence_(ev, sourceRow, 'TASK', assetOwner, assetLocation);
      asArray_(sourceRow.__assetIds).forEach(function (assetId) {
        addMapEvidence_(ev, assetId, assetOwner, assetLocation, 'TASK asset');
      });
      asArray_(sourceRow.__mergeWarnings).forEach(function (warning) { addWarning_(ev, warning); });
      var result = evaluateEvidence_(ev);
      if (result.ok) taskPreResolved.push(resolvedCopy_(sourceRow, result));
    });

    var directResolvedRequests = [];
    sources.serviceRequests.forEach(function (sourceRow) {
      var ev = evidence_();
      addCustomerEvidence_(ev, sourceRow['Matched Customer ID'], 'SERVICE_REQUEST matched');
      addCustomerEvidence_(ev, sourceRow['Created Customer ID'], 'SERVICE_REQUEST created');
      addLocationEvidence_(ev, sourceRow['Matched Location ID'], 'SERVICE_REQUEST matched');
      addLocationEvidence_(ev, sourceRow['Created Location ID'], 'SERVICE_REQUEST created');
      addContactEvidence_(ev, sourceRow['Matched Contact ID'], 'SERVICE_REQUEST matched');
      addContactEvidence_(ev, sourceRow['Created Contact ID'], 'SERVICE_REQUEST created');
      var result = evaluateEvidence_(ev);
      if (result.ok) directResolvedRequests.push(resolvedCopy_(sourceRow, result));
    });

    directResolvedRequests.forEach(function (requestRow) {
      workOrderKeysFromRequest_(requestRow).forEach(function (key) {
        var cleanKey = id_(key);
        if (!cleanKey) return;
        (workOrderRowsByKey[cleanKey] || []).forEach(function (workOrderRow) {
          addCustomerNumberOwner_(
            workOrderRow['Customer ID'],
            requestRow.__customerId,
            'SERVICE_REQUEST'
          );
        });
      });
    });
    refreshCustomerNumberDiagnostics_();

    var workOrderEvidence = {};
    function workOrderEvidenceFor_(key) {
      var cleanKey = id_(key);
      if (!cleanKey) return null;
      workOrderEvidence[cleanKey] = workOrderEvidence[cleanKey] || evidence_();
      return workOrderEvidence[cleanKey];
    }
    function addResolvedToWorkOrder_(keys, row, sourceLabel) {
      (keys || []).forEach(function (key) {
        var ev = workOrderEvidenceFor_(key);
        if (!ev) return;
        addCustomerEvidence_(ev, row.__customerId, sourceLabel);
        addLocationEvidence_(ev, row.__locationId, sourceLabel);
        if (/^TASK\b/i.test(sourceLabel || '')) tagEvidence_(ev, 'TASK_RELATIONSHIP_EVIDENCE');
        if (/^SERVICE_REQUEST\b/i.test(sourceLabel || '')) tagEvidence_(ev, 'SERVICE_REQUEST_EVIDENCE');
      });
    }

    relationshipDiagnostics.workOrders.rows = workOrderRows.length;
    workOrderRows.forEach(function (row) {
      var direct = evidence_();
      var directDetails = addDirectRowEvidence_(direct, row, 'WORK_ORDER', assetOwner, assetLocation);
      row.__workOrderDirectDetails = directDetails;
      if (directDetails.customerReferenceStatus === 'RESOLVED') {
        relationshipDiagnostics.workOrders.customerNumberReferences += 1;
        relationshipDiagnostics.workOrders.customerNumberResolved += 1;
      } else if (directDetails.customerReferenceStatus === 'NOT_FOUND') {
        relationshipDiagnostics.workOrders.customerNumberReferences += 1;
        relationshipDiagnostics.workOrders.customerNumberNotFound += 1;
      } else if (directDetails.customerReferenceStatus === 'AMBIGUOUS') {
        relationshipDiagnostics.workOrders.customerNumberReferences += 1;
        relationshipDiagnostics.workOrders.customerNumberAmbiguous += 1;
      } else {
        relationshipDiagnostics.workOrders.customerNumberMissing += 1;
      }
      if (directDetails.directLocationReferenced) relationshipDiagnostics.workOrders.locationReferences += 1;
      if (directDetails.directLocationResolved) relationshipDiagnostics.workOrders.locationResolved += 1;
      workOrderKeysFromRow_(row).forEach(function (key) {
        var target = workOrderEvidenceFor_(key);
        Object.keys(direct.customers).forEach(function (cid) { target.customers[cid] = true; });
        Object.keys(direct.locations).forEach(function (lid) { target.locations[lid] = true; });
        Object.keys(direct.tags).forEach(function (tag) { target.tags[tag] = true; });
        direct.warnings.forEach(function (warning) { addWarning_(target, warning); });
      });
    });
    taskPreResolved.forEach(function (row) {
      addResolvedToWorkOrder_(workOrderKeysFromRow_(row), row, 'TASK ' + id_(row['Task ID']));
    });
    directResolvedRequests.forEach(function (row) {
      addResolvedToWorkOrder_(workOrderKeysFromRequest_(row), row, 'SERVICE_REQUEST ' + clean_(row['Request ID']));
    });

    var workOrderOwner = {};
    var workOrderLocation = {};
    var resolvedWorkOrders = [];
    workOrderRows.forEach(function (sourceRow) {
      var combined = evidence_();
      workOrderKeysFromRow_(sourceRow).forEach(function (key) {
        var ev = workOrderEvidence[key];
        if (!ev) return;
        Object.keys(ev.customers).forEach(function (cid) { combined.customers[cid] = true; });
        Object.keys(ev.locations).forEach(function (lid) { combined.locations[lid] = true; });
        Object.keys(ev.tags || {}).forEach(function (tag) { combined.tags[tag] = true; });
        ev.warnings.forEach(function (warning) { addWarning_(combined, warning); });
      });
      var result = evaluateEvidence_(combined);
      if (!result.ok) {
        if (result.conflict) {
          relationshipDiagnostics.workOrders.rejectedDueConflict += 1;
          recordConflict_('WORK_ORDER', sourceRow, 'Work Order ID', result);
        } else if (combined.tags.CUSTOMER_NUMBER_AMBIGUOUS) {
          relationshipDiagnostics.workOrders.unresolvedCustomerNumberAmbiguous += 1;
        } else if (combined.tags.CUSTOMER_NUMBER_NOT_FOUND) {
          relationshipDiagnostics.workOrders.unresolvedCustomerNumberNotFound += 1;
        } else if (combined.tags.CUSTOMER_NUMBER_MISSING) {
          relationshipDiagnostics.workOrders.unresolvedCustomerNumberMissing += 1;
        } else {
          relationshipDiagnostics.workOrders.unresolvedNoOwnershipEvidence += 1;
        }
        orphans.workOrders.push(sourceRow);
        return;
      }
      var evidenceTypeCount = 0;
      if (combined.tags.CUSTOMER_NUMBER_RESOLVED) {
        relationshipDiagnostics.workOrders.resolvedThroughCustomerNumber += 1;
        evidenceTypeCount += 1;
      }
      if (combined.tags.DIRECT_LOCATION_RESOLVED) {
        relationshipDiagnostics.workOrders.resolvedThroughShipToAddressId += 1;
        evidenceTypeCount += 1;
      }
      if (combined.tags.TASK_RELATIONSHIP_EVIDENCE) {
        relationshipDiagnostics.workOrders.resolvedThroughTaskRelationship += 1;
        evidenceTypeCount += 1;
      }
      if (combined.tags.SERVICE_REQUEST_EVIDENCE) {
        relationshipDiagnostics.workOrders.resolvedThroughServiceRequest += 1;
        evidenceTypeCount += 1;
      }
      if (evidenceTypeCount > 1) relationshipDiagnostics.workOrders.resolvedWithMultipleEvidenceTypes += 1;
      var row = resolvedCopy_(sourceRow, result);
      resolvedWorkOrders.push(row);
      workOrderKeysFromRow_(row).forEach(function (key) {
        workOrderOwner[key] = result.customerId;
        if (result.locationId) workOrderLocation[key] = result.locationId;
      });
    });
    resolvedByType.WORK_ORDER = resolvedWorkOrders;

    var taskOwner = {};
    var taskLocation = {};
    var resolvedTasks = [];
    mergedTasks.forEach(function (sourceRow) {
      if (sourceRow.__hasRelationshipConflict) {
        orphans.tasks.push(sourceRow);
        return;
      }
      var ev = evidence_();
      var taskDirectDetails = addDirectRowEvidence_(ev, sourceRow, 'TASK', assetOwner, assetLocation);
      asArray_(sourceRow.__assetIds).forEach(function (assetId) {
        addMapEvidence_(ev, assetId, assetOwner, assetLocation, 'TASK asset');
      });
      var hadWorkOrderEvidence = false;
      workOrderKeysFromRow_(sourceRow).forEach(function (key) {
        var cleanKey = id_(key);
        if (cleanKey && workOrderOwner[cleanKey]) hadWorkOrderEvidence = true;
        addMapEvidence_(ev, key, workOrderOwner, workOrderLocation, 'TASK work order');
      });
      asArray_(sourceRow.__mergeWarnings).forEach(function (warning) { addWarning_(ev, warning); });
      var result = evaluateEvidence_(ev);
      if (!result.ok) {
        if (result.conflict) {
          relationshipDiagnostics.tasks.rejectedDueConflict += 1;
          recordConflict_('TASK', sourceRow, 'Task ID', result);
        } else {
          relationshipDiagnostics.tasks.unresolvedNoOwnershipEvidence += 1;
        }
        orphans.tasks.push(sourceRow);
        return;
      }
      if (taskDirectDetails.directCustomerIdResolved) {
        relationshipDiagnostics.tasks.resolvedDirectCustomerId += 1;
      } else if (hadWorkOrderEvidence) {
        relationshipDiagnostics.tasks.resolvedThroughWorkOrder += 1;
      } else if (Object.keys(ev.tags).some(function (tag) { return tag === 'ASSET_EVIDENCE'; })) {
        relationshipDiagnostics.tasks.resolvedThroughAsset += 1;
      }
      var row = resolvedCopy_(sourceRow, result);
      resolvedTasks.push(row);
      var taskId = id_(row['Task ID']);
      if (taskId) {
        taskOwner[taskId] = result.customerId;
        if (result.locationId) taskLocation[taskId] = result.locationId;
      }
    });
    resolvedByType.TASK = resolvedTasks;

    var resolvedRequests = [];
    sources.serviceRequests.forEach(function (sourceRow) {
      var ev = evidence_();
      addCustomerEvidence_(ev, sourceRow['Matched Customer ID'], 'SERVICE_REQUEST matched');
      addCustomerEvidence_(ev, sourceRow['Created Customer ID'], 'SERVICE_REQUEST created');
      addLocationEvidence_(ev, sourceRow['Matched Location ID'], 'SERVICE_REQUEST matched');
      addLocationEvidence_(ev, sourceRow['Created Location ID'], 'SERVICE_REQUEST created');
      addContactEvidence_(ev, sourceRow['Matched Contact ID'], 'SERVICE_REQUEST matched');
      addContactEvidence_(ev, sourceRow['Created Contact ID'], 'SERVICE_REQUEST created');
      workOrderKeysFromRequest_(sourceRow).forEach(function (key) {
        addMapEvidence_(ev, key, workOrderOwner, workOrderLocation, 'SERVICE_REQUEST work order');
      });
      taskKeysFromRequest_(sourceRow).forEach(function (key) {
        addMapEvidence_(ev, key, taskOwner, taskLocation, 'SERVICE_REQUEST task');
      });
      var result = evaluateEvidence_(ev);
      if (!result.ok) {
        if (result.conflict) recordConflict_('SERVICE_REQUEST', sourceRow, 'Request ID', result);
        orphans.serviceRequests.push(sourceRow);
        return;
      }
      resolvedRequests.push(resolvedCopy_(sourceRow, result));
    });

    // Opportunities and finance domains are intentionally out of scope.


    var rawCounts = {
      ASSET: (rawOperationalByType.ASSET || []).length,
      WORK_ORDER: workOrderRows.length,
      TASK: mergedTasks.length,
      SERVICE_REQUEST: sources.serviceRequests.length
    };
    var resolvedCounts = {};
    Object.keys(rawCounts).forEach(function (type) {
      resolvedCounts[type] = type === 'SERVICE_REQUEST'
        ? resolvedRequests.length
        : ((resolvedByType[type] || []).length);
    });

    return {
      customerSelection: selectedCustomers,
      locationSelection: selectedLocations,
      customersById: customersById,
      customerRows: selectedCustomers.rows,
      contactsByCustomer: contactsByCustomer,
      contactOwner: contactOwner,
      locationsByCustomer: locationsByCustomer,
      locationOwner: locationOwner,
      locationConflicts: locationConflicts,
      operationalByType: resolvedByType,
      serviceRequests: resolvedRequests,
      orphans: orphans,
      ambiguous: ambiguous,
      relationshipFieldRecovery: relationshipFieldRecovery,
      relationshipDiagnostics: relationshipDiagnostics,
      resolutionStats: {
        algorithm: 'DETERMINISTIC_SOURCE_AUTHORITY_TWO_PASS',
        raw: rawCounts,
        resolved: resolvedCounts,
        orphaned: {
          ASSET: orphans.assets.length,
          WORK_ORDER: orphans.workOrders.length,
          TASK: orphans.tasks.length,
          SERVICE_REQUEST: orphans.serviceRequests.length
        }
      }
    };
  }

  function profileLocationKey_(customerId, locationId) {
    return clean_(customerId) + '\u001F' + clean_(locationId);
  }

  /**
   * Builds the one-to-many relationship lookup once.
   *
   * The former implementation filtered every complete entity array for every
   * Customer + Location profile. With tens of thousands of locations that
   * became O(profile count × source row count) and could exceed Apps Script's
   * execution limit. This index reduces profile row resolution to O(1) lookup
   * plus the number of records actually attached to that profile.
   */
  function buildProfileRowsIndex_(relationships) {
    var index = {};

    function addType_(type, rows) {
      var customerLevel = {};
      var byLocation = {};

      (rows || []).forEach(function (row) {
        var customerId = clean_(row.__customerId);
        var locationId = clean_(row.__locationId);
        if (!customerId) return;

        if (!locationId) {
          customerLevel[customerId] = customerLevel[customerId] || [];
          customerLevel[customerId].push(row);
          return;
        }

        var key = profileLocationKey_(customerId, locationId);
        byLocation[key] = byLocation[key] || [];
        byLocation[key].push(row);
      });

      index[type] = {
        customerLevel: customerLevel,
        byLocation: byLocation
      };
    }

    Object.keys(relationships.operationalByType || {}).forEach(function (type) {
      addType_(type, relationships.operationalByType[type]);
    });
    addType_('SERVICE_REQUEST', relationships.serviceRequests || []);

    return index;
  }

  function rowsForProfileFromIndex_(profileIndex, type, customerId, locationId) {
    var typed = profileIndex[type] || { customerLevel: {}, byLocation: {} };
    var customerRows = typed.customerLevel[customerId] || [];
    var locationRows = locationId
      ? (typed.byLocation[profileLocationKey_(customerId, locationId)] || [])
      : [];

    if (!customerRows.length) return locationRows;
    if (!locationRows.length) return customerRows;
    return customerRows.concat(locationRows);
  }

  function contactSummary_(contacts) {
    return lines_(newestFirst_(contacts, ['Source Updated At', 'Customer Created At']).map(function (row) {
      return lines_([
        identity_('Contact', row['Contact ID'], '', row['Full Name'] || row['Customer Name']),
        [clean_(row['Phone']), clean_(row['Email'])].filter(Boolean).join(' • '),
        [label_('Role', row['Contact Role']), label_('Status', row['Status']), yes_(row['Primary Contact?']) ? 'Primary' : ''].filter(Boolean).join(' • ')
      ], 700);
    }));
  }

  function locationSummary_(location) {
    if (!location) return 'No confirmed Striven location';
    return lines_([
      identity_('Location', location['Location ID'], location['Location Number'], location['Location Name']),
      location['Full Address'],
      label_('Status', location['Status'])
    ]);
  }

  function assetSummary_(assets) {
    return lines_(newestFirst_(assets, ['Install Date', 'Updated At']).map(function (row) {
      var locationLabel = row.__locationId ? 'Location ' + row.__locationId : 'Customer-level — location unconfirmed';
      return lines_([
        identity_('Asset', row['Asset ID'], row['Asset Number'], row['Asset Name']),
        [clean_(row['Asset Make']), clean_(row['Asset Model']), clean_(row['Serial Number']) ? 'Serial ' + clean_(row['Serial Number']) : ''].filter(Boolean).join(' • '),
        [label_('Installed', row['Install Date']), label_('Age', row['Asset Age']), label_('Status', row['Status'])].filter(Boolean).join(' • '),
        locationLabel
      ], 900);
    }));
  }

  function workOrderLine_(row) {
    return lines_([
      identity_('WO', row['Work Order ID'], row['Work Order Number'], row['Work Order Name']),
      [label_('Status', row['Status']), label_('Created', row['Created At']), label_('Completed', row['Completed At'])].filter(Boolean).join(' • '),
      [label_('Scheduled', row['Scheduled Date']), label_('Tech', row['Technician'])].filter(Boolean).join(' • '),
      clean_(row['Description']),
      row.__locationId ? 'Location ' + row.__locationId : 'Customer-level — location unconfirmed'
    ], 1000);
  }

  function taskLine_(row) {
    return lines_([
      identity_('Task', row['Task ID'], '', row['Task Name']),
      [label_('Status', row['Status']), label_('Scheduled', row['Scheduled Date']), label_('Tech', row['Technician'])].filter(Boolean).join(' • '),
      row['Work Order ID'] ? 'WO ' + clean_(row['Work Order ID']) : '',
      clean_(row['Description']),
      row.__locationId ? 'Location ' + row.__locationId : 'Customer-level — location unconfirmed'
    ], 900);
  }

  function serviceHistorySummary_(workOrders, tasks) {
    var entries = [];
    newestFirst_(workOrders, ['Completed At', 'Scheduled Date', 'Created At', 'Updated At']).forEach(function (row) {
      entries.push('[' + statusClass_(row['Status']) + '] ' + workOrderLine_(row));
    });
    newestFirst_(tasks, ['Completed At', 'Scheduled Date', 'Created At', 'Updated At']).forEach(function (row) {
      entries.push('[' + statusClass_(row['Status']) + '] ' + taskLine_(row));
    });
    return lines_(entries);
  }

  function opportunitySummary_(rows) {
    return lines_(newestFirst_(rows, ['Updated At', 'Created At']).map(function (row) {
      return lines_([
        identity_('Opportunity', row['Opportunity ID'], row['Opportunity Number'], row['Opportunity Name']),
        [label_('Stage', row['Opportunity Stage']), label_('Status', row['Status'])].filter(Boolean).join(' • '),
        row.__locationId ? 'Location ' + row.__locationId : 'Customer-level — location unconfirmed'
      ], 800);
    }));
  }

  function existingWorkSummary_(workOrders, tasks) {
    var lines = [];
    newestFirst_(workOrders.filter(function (row) { return statusClass_(row['Status']) === 'OPEN'; }), ['Scheduled Date', 'Updated At', 'Created At']).forEach(function (row) {
      lines.push(workOrderLine_(row));
    });
    newestFirst_(tasks.filter(function (row) { return statusClass_(row['Status']) === 'OPEN'; }), ['Scheduled Date', 'Updated At', 'Created At']).forEach(function (row) {
      lines.push(taskLine_(row));
    });
    return lines_(lines);
  }

  function invoiceLine_(row) {
    return lines_([
      identity_('Invoice', row['Invoice ID'], row['Invoice Number'], ''),
      [label_('Date', row['Invoice Date']), label_('Status', row['Invoice Status'] || row['Status'])].filter(Boolean).join(' • '),
      [label_('Invoiced', row['Invoiced Amount']), label_('Collected', row['Collected Amount']), label_('Outstanding', row['Outstanding Balance'])].filter(Boolean).join(' • ')
    ], 800);
  }

  function revenueSummary_(invoices, payments, collections, revenueRows, totals) {
    var output = [];
    newestFirst_(invoices, ['Invoice Date', 'Updated At']).forEach(function (row) { output.push(invoiceLine_(row)); });
    if (payments.length) output.push('Payments: ' + payments.length + ' validated record(s)');
    if (collections.length) output.push('Collections: ' + collections.length + ' validated record(s)');
    if (revenueRows.length) output.push('Revenue evidence: ' + revenueRows.length + ' validated record(s)');
    output.push(lines_([
      label_('Total invoiced', totals.totalInvoiced),
      label_('Total collected', totals.totalCollected),
      label_('Outstanding', totals.outstanding),
      label_('Revenue', totals.revenue)
    ]));
    return lines_(output);
  }

  function requestSummary_(requests) {
    return lines_(newestFirst_(requests, ['Created Timestamp', 'Last Updated Timestamp']).map(function (row) {
      return lines_([
        identity_('Request', row['Request ID'], '', row['Full Name']),
        [label_('Stage', row['Current Stage']), label_('Status', row['Request Status'])].filter(Boolean).join(' • '),
        label_('Next', row['Next Action']),
        clean_(row['Service Request Summary'] || row['Details']),
        row.__locationId ? 'Location ' + row.__locationId : 'Customer-level — location unconfirmed'
      ], 1000);
    }));
  }

  function campaignSummary_(requests) {
    return lines_(newestFirst_(requests, ['Created Timestamp']).map(function (row) {
      return [
        clean_(row['Created Timestamp']),
        clean_(row['Campaign Code']),
        clean_(row['Campaign Name']),
        clean_(row['Source System'])
      ].filter(Boolean).join(' • ');
    }));
  }

  function primaryContact_(contacts) {
    var sorted = (contacts || []).slice().sort(function (a, b) {
      var aScore = (yes_(a['Primary Contact?']) ? 100 : 0) + (isActive_(a['Status']) ? 10 : 0) + countFilled_(a);
      var bScore = (yes_(b['Primary Contact?']) ? 100 : 0) + (isActive_(b['Status']) ? 10 : 0) + countFilled_(b);
      return bScore - aScore;
    });
    return sorted.length ? sorted[0] : {};
  }

  function financialTotals_(invoices, payments, collections, revenueRows) {
    var totalInvoiced = sum_(invoices.map(function (r) { return r['Invoiced Amount'] || r['Amount']; }));
    var collectionValues = collections.map(function (r) { return r['Collected Amount'] || r['Amount']; });
    var paymentValues = payments.map(function (r) { return r['Collected Amount'] || r['Amount']; });
    var invoiceCollected = invoices.map(function (r) { return r['Collected Amount']; });
    var totalCollected = collections.length ? sum_(collectionValues) : (payments.length ? sum_(paymentValues) : sum_(invoiceCollected));
    var explicitOutstandingValues = invoices.map(function (r) { return r['Outstanding Balance']; }).filter(function (v) { return number_(v) !== null; });
    var outstanding = explicitOutstandingValues.length ? sum_(explicitOutstandingValues) : '';
    if (outstanding === '' && totalInvoiced !== '' && totalCollected !== '' && (payments.length || collections.length || invoiceCollected.some(function (v) { return number_(v) !== null; }))) {
      outstanding = Math.max(0, totalInvoiced - totalCollected);
    }
    var revenueValues = revenueRows.map(function (r) { return r['Revenue Amount'] || r['Amount']; });
    if (!revenueValues.length) revenueValues = invoices.map(function (r) { return r['Revenue Amount']; }).filter(function (v) { return number_(v) !== null; });
    var revenue = revenueValues.length ? sum_(revenueValues) : '';
    return {
      totalInvoiced: totalInvoiced,
      totalCollected: totalCollected,
      outstanding: outstanding,
      revenue: revenue,
      paymentStatus: outstanding === '' ? 'INSUFFICIENT EVIDENCE' : (Number(outstanding) > 0 ? 'OUTSTANDING' : 'CURRENT')
    };
  }

  function sourceSummary_(selection) {
    return lines_(Object.keys(selection || {}).sort().map(function (key) {
      return key + ': ' + selection[key];
    }));
  }

  function factualFingerprint_(record) {
    var d = deps_();
    var payload = {};
    Object.keys(record || {}).sort().forEach(function (header) {
      if (AI_HEADERS.indexOf(header) !== -1) return;
      if (VOLATILE_HEADERS.indexOf(header) !== -1) return;
      payload[header] = record[header];
    });
    return d.util.fingerprint(payload);
  }

  function aiConfigured_() {
    return Boolean(PropertiesService.getScriptProperties().getProperty('ServiceOps_OpenAI_API_Key'));
  }

  function preserveAI_(record, prior) {
    var d = deps_();
    var sameFacts = prior && clean_(prior['Factual Profile Fingerprint']) === clean_(record['Factual Profile Fingerprint']);
    if (sameFacts) {
      AI_HEADERS.forEach(function (header) { record[header] = prior[header] || ''; });
      return record;
    }
    AI_HEADERS.forEach(function (header) { record[header] = ''; });
    if (!aiConfigured_()) record['AI Enrichment Status'] = 'NOT CONFIGURED';
    else if (!d.util.getBooleanProperty('SERVICEOPS_OPENAI_ENABLED', false)) record['AI Enrichment Status'] = 'NOT REQUESTED';
    else if (record['Relationship Status'] === 'CONFIRMED') record['AI Enrichment Status'] = 'READY';
    else record['AI Enrichment Status'] = 'SKIPPED';
    return record;
  }

  function buildProfiles_(sources, options) {
    options = options || {};
    var d = deps_();
    var previewOnly = options.previewOnly === true;
    var discovery = d.striven.discoverReportProperties();
    var selection = buildSourceSelection_(sources, discovery, options);
    var relationships = buildRelationships_(sources);
    var profileRowsIndex = buildProfileRowsIndex_(relationships);
    var priorByKey = previewOnly ? {} : d.util.indexBy(sources.existingCustomer360, 'Profile Key');
    var profiles = [];
    var customerCacheTimestamp = cacheTimestamp_(sources.customersAndContacts);
    var locationCacheTimestamp = cacheTimestamp_(sources.locations);
    var operationalCacheTimestamp = cacheTimestamp_(sources.operational);
    var sourceDataTimestamp = latestDate_([
      customerCacheTimestamp, locationCacheTimestamp, operationalCacheTimestamp,
      latestDate_(sources.serviceRequests.map(function (r) { return r['Last Updated Timestamp'] || r['Created Timestamp']; }))
    ]);
    var now = d.util.nowString();
    var sourceSelectionSummary = sourceSummary_(selection);
    var nextScheduleCutoffMs = Date.now() - 86400000;
    var ambiguousByCustomer = {};

    relationships.ambiguous.forEach(function (item) {
      var cid = clean_(item.customerId || item.locationCustomerId);
      if (cid) ambiguousByCustomer[cid] = (ambiguousByCustomer[cid] || 0) + 1;
    });

    relationships.customerRows.forEach(function (customer) {
      var customerId = id_(customer['Customer ID']);
      if (!customerId) return;
      var locations = relationships.locationsByCustomer[customerId] || [];
      var locationRows = locations.length ? locations : [null];
      var contacts = relationships.contactsByCustomer[customerId] || [];
      var primaryContact = primaryContact_(contacts);

      locationRows.forEach(function (location) {
        var locationId = location ? id_(location['Location ID']) : 'NO_LOCATION';
        var profileLocationId = location ? locationId : '';
        var assets = rowsForProfileFromIndex_(profileRowsIndex, 'ASSET', customerId, profileLocationId);
        var workOrders = rowsForProfileFromIndex_(profileRowsIndex, 'WORK_ORDER', customerId, profileLocationId);
        var tasks = rowsForProfileFromIndex_(profileRowsIndex, 'TASK', customerId, profileLocationId);
        var requests = rowsForProfileFromIndex_(profileRowsIndex, 'SERVICE_REQUEST', customerId, profileLocationId);

        if (previewOnly) {
          profiles.push({
            'Profile Key': customerId + '|' + locationId,
            'Customer ID': customerId,
            'Asset Count': assets.length,
            'Total Historical Work Orders': workOrders.length,
            'Total Historical Tasks': tasks.length,
            'Open Service Request Count': requests.filter(function (r) {
              return statusClass_(r['Request Status']) === 'OPEN';
            }).length,
            'Factual Profile Fingerprint': ''
          });
          return;
        }

        var openWorkOrders = workOrders.filter(function (r) { return statusClass_(r['Status']) === 'OPEN'; });
        var completedWorkOrders = workOrders.filter(function (r) { return statusClass_(r['Status']) === 'COMPLETED'; });
        var cancelledWorkOrders = workOrders.filter(function (r) { return statusClass_(r['Status']) === 'CANCELLED'; });
        var openTasks = tasks.filter(function (r) { return statusClass_(r['Status']) === 'OPEN'; });
        var completedTasks = tasks.filter(function (r) { return statusClass_(r['Status']) === 'COMPLETED'; });
        var newestWorkOrder = newestFirst_(workOrders, ['Completed At', 'Scheduled Date', 'Updated At', 'Created At'])[0] || {};
        var newestTask = newestFirst_(tasks, ['Completed At', 'Scheduled Date', 'Updated At', 'Created At'])[0] || {};
        var newestRequest = newestFirst_(requests, ['Created Timestamp', 'Last Updated Timestamp'])[0] || {};
        var oldestRequest = requests.slice().sort(function (a, b) { return dateMs_(a['Created Timestamp']) - dateMs_(b['Created Timestamp']); })[0] || {};
        var newestCampaignRequest = newestRequest;
        var oldestCampaignRequest = oldestRequest;
        var serviceDates = workOrders.concat(tasks).map(function (r) {
          return r['Completed At'] || r['Scheduled Date'] || r['Created At'];
        });
        var technicianHistory = unique_(workOrders.concat(tasks).map(function (r) { return r['Technician']; }));
        var relationshipWarnings = [];
        assets.concat(workOrders, tasks, requests).forEach(function (row) {
          asArray_(row.__relationshipWarnings).forEach(function (warning) { relationshipWarnings.push(warning); });
        });
        relationshipWarnings = unique_(relationshipWarnings);
        var missing = [];
        if (!clean_(customer['Customer Name'] || customer['Full Name'])) missing.push('Customer name');
        if (!clean_(customer['Phone']) && !clean_(customer['Email'])) missing.push('Customer contact method');
        if (location && !clean_(location['Full Address'])) missing.push('Location address');
        if (!contacts.length) missing.push('Contacts');
        var relationshipStatus = relationshipWarnings.length || ambiguousByCustomer[customerId]
          ? 'PARTIAL'
          : 'CONFIRMED';
        var profileKey = customerId + '|' + locationId;
        var record = d.config.makeBlankRecord(SHEET_KEY);

        record['Profile Key'] = profileKey;
        record['Customer ID'] = customerId;
        record['Customer Number'] = customer['Customer Number'];
        record['Customer Name'] = customer['Customer Name'] || customer['Full Name'];
        record['Customer Status'] = customer['Status'];
        record['Customer Type'] = customer['Customer Type'];
        record['Primary Phone'] = customer['Phone'];
        record['Primary Email'] = customer['Email'];
        record['Customer Created Date'] = dateDisplay_(customer['Customer Created At']);
        record['Customer Last Updated Date'] = dateDisplay_(customer['Source Updated At']);
        record['Customer Summary'] = lines_([
          identity_('Customer', customerId, customer['Customer Number'], record['Customer Name']),
          [label_('Phone', record['Primary Phone']), label_('Email', record['Primary Email'])].filter(Boolean).join(' • '),
          [label_('Status', record['Customer Status']), label_('Type', record['Customer Type'])].filter(Boolean).join(' • ')
        ]);

        record['Primary Contact ID'] = primaryContact['Contact ID'];
        record['Primary Contact Name'] = primaryContact['Full Name'] || primaryContact['Customer Name'];
        record['Primary Contact Phone'] = primaryContact['Phone'];
        record['Primary Contact Email'] = primaryContact['Email'];
        record['Contact Count'] = contacts.length;
        record['Active Contact Count'] = contacts.filter(function (r) { return isActive_(r['Status']); }).length;
        record['Contacts Summary'] = contactSummary_(contacts);

        record['Location ID'] = location ? locationId : '';
        record['Location Number'] = location ? location['Location Number'] : '';
        record['Location Name'] = location ? location['Location Name'] : '';
        record['Street'] = location ? location['Street'] : '';
        record['City'] = location ? location['City'] : '';
        record['Province'] = location ? location['Province'] : '';
        record['Postal Code'] = location ? location['Postal Code'] : '';
        record['Country'] = location ? location['Country'] : '';
        record['Full Address'] = location ? location['Full Address'] : '';
        record['Location Status'] = location ? location['Status'] : 'NO CONFIRMED LOCATION';
        record['Location Created Date'] = location ? dateDisplay_(location['Location Created At']) : '';
        record['Location Last Updated Date'] = location ? dateDisplay_(location['Source Updated At']) : '';
        record['Location Summary'] = locationSummary_(location);

        record['Asset Count'] = assets.length;
        record['Active Asset Count'] = assets.filter(function (r) { return isActive_(r['Status']); }).length;
        record['Asset Makes'] = unique_(assets.map(function (r) { return r['Asset Make']; })).join(', ');
        record['Asset Models'] = unique_(assets.map(function (r) { return r['Asset Model']; })).join(', ');
        record['Oldest Asset Install Date'] = earliestDate_(assets.map(function (r) { return r['Install Date']; }));
        record['Most Recent Asset Install Date'] = latestDate_(assets.map(function (r) { return r['Install Date']; }));
        record['Assets Summary'] = assetSummary_(assets);

        record['First Service Date'] = earliestDate_(serviceDates);
        record['Most Recent Service Date'] = latestDate_(serviceDates);
        record['Last Technician'] = newestTask['Technician'] || newestWorkOrder['Technician'];
        record['Last Work Order ID'] = newestWorkOrder['Work Order ID'];
        record['Last Work Order Number'] = newestWorkOrder['Work Order Number'];
        record['Last Task ID'] = newestTask['Task ID'];
        record['Total Historical Work Orders'] = workOrders.length;
        record['Completed Work Orders'] = completedWorkOrders.length;
        record['Open Work Orders'] = openWorkOrders.length;
        record['Cancelled Work Orders'] = cancelledWorkOrders.length;
        record['Total Historical Tasks'] = tasks.length;
        record['Completed Tasks'] = completedTasks.length;
        record['Open Tasks'] = openTasks.length;
        record['Completed Jobs'] = completedWorkOrders.length;
        record['Open Jobs'] = openWorkOrders.length;
        record['Technician History'] = technicianHistory.join(', ');
        record['Service History Summary'] = serviceHistorySummary_(workOrders, tasks);

        // Retained as blank compatibility columns; Opportunities are out of scope.
        record['Opportunity Count'] = '';
        record['Active Opportunity Count'] = '';
        record['Latest Opportunity ID'] = '';
        record['Latest Opportunity Number'] = '';
        record['Latest Opportunity Name'] = '';
        record['Latest Opportunity Stage'] = '';
        record['Latest Opportunity Status'] = '';
        record['Opportunity Summary'] = '';

        record['Active Work Order Count'] = openWorkOrders.length;
        record['Active Task Count'] = openTasks.length;
        record['Next Scheduled Date'] = earliestDate_(openTasks.concat(openWorkOrders).map(function (r) { return r['Scheduled Date']; }).filter(function (v) { return dateMs_(v) >= nextScheduleCutoffMs; }));
        record['Assigned Technician'] = unique_(openTasks.concat(openWorkOrders).map(function (r) { return r['Technician']; })).join(', ');
        record['Existing Work Summary'] = existingWorkSummary_(workOrders, tasks);

        // Retained as blank compatibility columns; finance domains are out of scope.
        record['Invoice Count'] = '';
        record['Latest Invoice ID'] = '';
        record['Latest Invoice Number'] = '';
        record['Latest Invoice Date'] = '';
        record['Latest Invoice Status'] = '';
        record['Total Invoiced'] = '';
        record['Total Collected'] = '';
        record['Outstanding Balance'] = '';
        record['Payment Status'] = '';
        record['Revenue'] = '';
        record['Revenue Summary'] = '';

        record['Open Service Request Count'] = requests.filter(function (r) { return statusClass_(r['Request Status']) === 'OPEN'; }).length;
        record['Total Service Request Count'] = requests.length;
        record['Latest Service Request ID'] = newestRequest['Request ID'];
        record['Latest Request Created Date'] = dateDisplay_(newestRequest['Created Timestamp']);
        record['Latest Request Stage'] = newestRequest['Current Stage'];
        record['Latest Request Status'] = newestRequest['Request Status'];
        record['Latest Next Action'] = newestRequest['Next Action'];
        record['Manual Review Required?'] = requests.some(function (r) { return clean_(r['Manual Review?']).toUpperCase() === 'YES'; }) ? 'YES' : 'NO';
        record['Duplicate Risk Status'] = requests.some(function (r) { return clean_(r['Duplicate Risk Status']).toUpperCase() === 'HIGH'; }) ? 'HIGH' :
          (requests.some(function (r) { return clean_(r['Duplicate Risk Status']).toUpperCase() === 'MEDIUM'; }) ? 'MEDIUM' :
            (requests.some(function (r) { return clean_(r['Duplicate Risk Status']).toUpperCase() === 'LOW'; }) ? 'LOW' : 'NONE'));
        record['Service Request Summary'] = requestSummary_(requests);

        record['Latest Campaign Code'] = newestCampaignRequest['Campaign Code'];
        record['Latest Campaign Name'] = newestCampaignRequest['Campaign Name'];
        record['First Campaign Code'] = oldestCampaignRequest['Campaign Code'];
        record['First Campaign Name'] = oldestCampaignRequest['Campaign Name'];
        record['Original Request Source'] = oldestCampaignRequest['Original Request Source'] || oldestCampaignRequest['Source System'];
        record['First Request Date'] = dateDisplay_(oldestRequest['Created Timestamp']);
        record['Most Recent Request Date'] = dateDisplay_(newestRequest['Created Timestamp']);
        record['Request Count'] = requests.length;
        record['Campaign Summary'] = campaignSummary_(requests);

        record['Data Completeness Status'] = missing.length ? 'INCOMPLETE' : 'COMPLETE';
        record['Missing Data Categories'] = unique_(missing).join(', ');
        record['Relationship Status'] = relationshipStatus;
        record['Relationship Warnings'] = lines_(relationshipWarnings);
        record['Orphan Record Count'] = 0;
        record['Ambiguous Relationship Count'] = ambiguousByCustomer[customerId] || 0;
        record['Last Refreshed At'] = now;
        record['Source Data Timestamp'] = sourceDataTimestamp;
        record['Customer Cache Timestamp'] = customerCacheTimestamp;
        record['Location Cache Timestamp'] = locationCacheTimestamp;
        record['Operational Cache Timestamp'] = operationalCacheTimestamp;
        record['Source Selection Summary'] = sourceSelectionSummary;
        record['Customer 360 Version'] = VERSION;
        record['Factual Profile Fingerprint'] = factualFingerprint_(record);
        preserveAI_(record, priorByKey[profileKey]);
        profiles.push(record);
      });
    });

    profiles.sort(function (a, b) {
      var nameCompare = clean_(a['Customer Name']).localeCompare(clean_(b['Customer Name']));
      if (nameCompare) return nameCompare;
      return clean_(a['Full Address']).localeCompare(clean_(b['Full Address']));
    });

    return {
      profiles: profiles,
      relationships: relationships,
      sourceSelection: selection,
      discovery: discovery,
      cacheDiagnostics: reportDiagnosticsFromCache_(sources),
      cacheTimestamps: {
        customer: customerCacheTimestamp,
        location: locationCacheTimestamp,
        operational: operationalCacheTimestamp
      }
    };
  }

  function uniqueCustomerCount_(profiles, predicate) {
    var seen = {};
    (profiles || []).forEach(function (profile) {
      if (!predicate || predicate(profile)) seen[id_(profile['Customer ID'])] = true;
    });
    delete seen[''];
    return Object.keys(seen).length;
  }

  function lastReportRefreshDiagnostics_(systemLog) {
    var reports = {};
    newestFirst_((systemLog || []).filter(function (row) {
      return clean_(row['Event Type']).toUpperCase() === 'STRIVEN_CACHE_REFRESH';
    }), ['Timestamp']).forEach(function (row) {
      var metadata = deps_().util.parseJson(row['Metadata JSON'], {});
      (metadata.reports || []).forEach(function (report) {
        if (!reports[report.key]) reports[report.key] = report;
      });
    });
    return reports;
  }

  function buildPreviewResult_(sources, built) {
    var d = deps_();
    var profiles = built.profiles;
    var relationships = built.relationships;
    var duplicateKeys = [];
    var seenKeys = {};
    profiles.forEach(function (profile) {
      var key = clean_(profile['Profile Key']);
      if (seenKeys[key]) duplicateKeys.push(key);
      seenKeys[key] = true;
    });
    var customersWithoutLocations = relationships.customerRows.filter(function (customer) {
      return !(relationships.locationsByCustomer[id_(customer['Customer ID'])] || []).length;
    }).length;
    var customersWithMultipleLocations = relationships.customerRows.filter(function (customer) {
      return (relationships.locationsByCustomer[id_(customer['Customer ID'])] || []).length > 1;
    }).length;
    var customersWithMultipleContacts = relationships.customerRows.filter(function (customer) {
      return (relationships.contactsByCustomer[id_(customer['Customer ID'])] || []).length > 1;
    }).length;
    var orphanCounts = {};
    Object.keys(relationships.orphans).forEach(function (key) {
      orphanCounts[key] = relationships.orphans[key].length;
    });
    var blockingErrors = [];
    var warnings = [];
    var customerReportConfigured = (built.discovery.reports || []).some(function (r) { return r.key === 'CUSTOMERS' && r.found; });
    var contactReportConfigured = (built.discovery.reports || []).some(function (r) { return r.key === 'CONTACTS' && r.found; });
    var locationReportConfigured = (built.discovery.reports || []).some(function (r) { return r.key === 'LOCATIONS' && r.found; });
    var hasValidatedContacts = sources.customersAndContacts.some(function (r) {
      return clean_(r['Entity Type']).toUpperCase() === 'CONTACT' && clean_(r['Contact ID']);
    });
    var effectiveRequiredMissing = (built.discovery.requiredMissing || []).filter(function (key) {
      if (key === 'CUSTOMERS' && relationships.customerRows.length) return false;
      if (key === 'CONTACTS' && hasValidatedContacts) return false;
      if (key === 'LOCATIONS' && sources.locations.length) return false;
      return true;
    });
    if (!relationships.customerRows.length) {
      if (customerReportConfigured) warnings.push('Customer cache is empty; a report refresh is required.');
      else blockingErrors.push('No validated Customer IDs are available and the customer report is not configured.');
    }
    if (!hasValidatedContacts) {
      if (contactReportConfigured) warnings.push('Contact cache is empty; a report refresh or schema review is required.');
      else blockingErrors.push('No validated Contact IDs are available and the required contact report is not configured.');
    }
    if (!sources.locations.length) {
      if (locationReportConfigured) warnings.push('Location cache is empty; a report refresh is required.');
      else blockingErrors.push('Locations cache is empty and the required location report is not configured.');
    }
    if ((built.discovery.optionalMissing || []).length) warnings.push('Optional reports are missing: ' + built.discovery.optionalMissing.join(', '));
    if ((built.discovery.unmappedReportLikeProperties || []).length) warnings.push('Unmapped report-like Script Properties were found.');
    if (relationships.ambiguous.length) warnings.push('Ambiguous relationships remain unmerged.');

    var numberDiagnostics = relationships.relationshipDiagnostics &&
      relationships.relationshipDiagnostics.customerNumbers
        ? relationships.relationshipDiagnostics.customerNumbers
        : {};
    if (Number(numberDiagnostics.fromCustomerCache || 0) === 0 &&
        Number((relationships.resolutionStats.raw || {}).WORK_ORDER || 0) > 0) {
      warnings.push(
        'Customer cache contains no usable Customer Number crosswalk. ' +
        'Work Order ownership is using only confirmed Task, Location, and Service Request bootstrap evidence.'
      );
    }

    var resolutionStats = relationships.resolutionStats || { raw: {}, resolved: {}, orphaned: {} };
    var configuredZeroResolutionDomains = [
      { reportKey: 'ASSETS', type: 'ASSET', label: 'Assets' },
      { reportKey: 'WORK_ORDERS', type: 'WORK_ORDER', label: 'Work Orders' },
      { reportKey: 'TASKS', type: 'TASK', label: 'Tasks' }
    ];
    configuredZeroResolutionDomains.forEach(function (spec) {
      var configured = (built.discovery.reports || []).some(function (report) {
        return report.key === spec.reportKey && report.found;
      });
      var rawCount = Number(resolutionStats.raw[spec.type] || 0);
      var resolvedCount = Number(resolutionStats.resolved[spec.type] || 0);
      if (configured && rawCount > 0 && resolvedCount === 0) {
        blockingErrors.push(
          spec.label + ' report contains ' + rawCount +
          ' normalized row(s), but zero records have a confirmed Customer relationship.'
        );
      }
    });

    Object.keys(resolutionStats.raw || {}).forEach(function (type) {
      var rawCount = Number(resolutionStats.raw[type] || 0);
      var orphanCount = Number(resolutionStats.orphaned[type] || 0);
      if (!rawCount || !orphanCount) return;
      var rate = orphanCount / rawCount;
      if (rate >= 0.25) {
        warnings.push(
          type.replace(/_/g, ' ') + ' orphan rate is ' +
          Math.round(rate * 1000) / 10 + '% (' + orphanCount + ' of ' + rawCount + ').'
        );
      }
    });

    var dataStatus = lastDataStatus_(sources.systemLog);
    var reportHistory = lastReportRefreshDiagnostics_(sources.systemLog);
    var pagesFetched = 0;
    var rowsFetched = 0;
    Object.keys(dataStatus).forEach(function (key) {
      pagesFetched += Number(dataStatus[key]['Pages Fetched'] || 0);
      rowsFetched += Number(dataStatus[key]['Rows Available'] || 0);
    });

    return {
      ok: blockingErrors.length === 0,
      preview: true,
      version: VERSION,
      scope: ['CUSTOMERS', 'CONTACTS', 'LOCATIONS', 'ASSETS', 'WORK_ORDERS', 'TASKS', 'TASK_RELATIONSHIPS', 'SERVICE_REQUESTS', 'CAMPAIGNS'],
      sourceMetadata: sheetMetadata_(),
      counts: {
        uniqueCustomers: relationships.customerRows.length,
        uniqueCustomerLocationProfiles: profiles.length,
        customersWithoutLocations: customersWithoutLocations,
        customersWithMultipleLocations: customersWithMultipleLocations,
        customersWithMultipleContacts: customersWithMultipleContacts,
        customersWithAssets: uniqueCustomerCount_(profiles, function (p) { return Number(p['Asset Count']) > 0; }),
        customersWithWorkOrders: uniqueCustomerCount_(profiles, function (p) { return Number(p['Total Historical Work Orders']) > 0; }),
        customersWithTasks: uniqueCustomerCount_(profiles, function (p) { return Number(p['Total Historical Tasks']) > 0; }),
        customersWithOpenServiceRequests: uniqueCustomerCount_(profiles, function (p) { return Number(p['Open Service Request Count']) > 0; }),
        ambiguousRelationships: relationships.ambiguous.length,
        duplicateProfileKeys: duplicateKeys.length,
        missingRequiredIds: relationships.customerSelection.missingIdRows.length + relationships.locationSelection.missingIdRows.length,
        customer360RowsWouldBeProduced: profiles.length
      },
      orphans: orphanCounts,
      duplicateProfileKeys: unique_(duplicateKeys),
      reportPropertyNamesFound: built.discovery.propertyNamesFound,
      canonicalReportPropertiesResolved: built.discovery.canonicalResolved,
      legacyAliasesUsed: built.discovery.legacyAliasesUsed,
      requiredReportsMissing: effectiveRequiredMissing,
      optionalReportsMissing: built.discovery.optionalMissing,
      unmappedReportLikeProperties: built.discovery.unmappedReportLikeProperties,
      reportsValidated: Object.keys(reportHistory).length ? Object.keys(reportHistory).filter(function (key) { return reportHistory[key].schemaValidated && !reportHistory[key].error; }) : built.cacheDiagnostics.validated,
      reportsRejected: Object.keys(reportHistory).length ? Object.keys(reportHistory).filter(function (key) { return !reportHistory[key].schemaValidated || reportHistory[key].error; }) : built.cacheDiagnostics.rejected,
      reportHeadersDetected: Object.keys(reportHistory).length ? Object.keys(reportHistory).reduce(function (output, key) { output[key] = reportHistory[key].headersDetected || []; return output; }, {}) : built.cacheDiagnostics.headers,
      pagesFetched: pagesFetched,
      rowsFetched: rowsFetched,
      normalizedRows: {
        customersAndContacts: sources.customersAndContacts.length,
        locations: sources.locations.length,
        operational: sources.operational.length
      },
      blankIds: built.cacheDiagnostics.blankIds,
      duplicateIds: built.cacheDiagnostics.duplicateIds,
      sourceSelectedByDomain: built.sourceSelection,
      cacheFreshness: {
        customer: d.striven.isCacheFresh('STRIVEN_CUSTOMER_DATA'),
        location: d.striven.isCacheFresh('STRIVEN_LOCATION_DATA'),
        operational: d.striven.isCacheFresh('STRIVEN_OPERATIONAL_DATA')
      },
      cacheTimestamps: built.cacheTimestamps,
      relationshipResolution: resolutionStats,
      relationshipFieldRecovery: relationships.relationshipFieldRecovery || null,
      relationshipDiagnostics: relationships.relationshipDiagnostics || null,
      profileSetFingerprint: d.util.fingerprint(profiles.map(function (profile) { return [profile['Profile Key'], profile['Factual Profile Fingerprint']]; })),
      blockingErrors: blockingErrors,
      warnings: warnings
    };
  }

  function previewRefresh(options) {
    options = options || {};
    var previewOptions = {};
    Object.keys(options).forEach(function (key) { previewOptions[key] = options[key]; });
    previewOptions.previewOnly = true;

    var startedMs = Date.now();
    var sources = readSources_({ includeExistingCustomer360: false });
    var readCompletedMs = Date.now();
    var built = buildProfiles_(sources, previewOptions);
    var buildCompletedMs = Date.now();
    var result = buildPreviewResult_(sources, built);
    result.performance = {
      sourceReadMs: readCompletedMs - startedMs,
      relationshipAndProfileIndexMs: buildCompletedMs - readCompletedMs,
      previewResultMs: Date.now() - buildCompletedMs,
      totalMs: Date.now() - startedMs,
      algorithm: 'INDEXED_LINEAR_PREVIEW'
    };
    return result;
  }

  function uniqueBackupName_(spreadsheet) {
    var d = deps_();
    var base = BACKUP_PREFIX + d.util.formatDate(new Date(), 'yyyyMMdd-HHmmss');
    var candidate = base.substring(0, 99);
    var counter = 2;
    while (spreadsheet.getSheetByName(candidate)) {
      var suffix = ' (' + counter + ')';
      candidate = base.substring(0, 99 - suffix.length) + suffix;
      counter++;
    }
    return candidate;
  }

  function createBackup_() {
    var d = deps_();
    var ss = d.util.getSpreadsheet();
    var source = ss.getSheetByName(d.config.getSheetName(SHEET_KEY));
    if (!source) return { ok: true, existed: false, sheet: '' };
    var backup = source.copyTo(ss);
    var name = uniqueBackupName_(ss);
    backup.setName(name);
    backup.hideSheet();
    return {
      ok: true,
      existed: true,
      sheet: name,
      rows: source.getLastRow(),
      columns: source.getLastColumn(),
      createdAt: d.util.nowString()
    };
  }

  function restoreBackup_(backupInfo) {
    var d = deps_();
    var ss = d.util.getSpreadsheet();
    var targetName = d.config.getSheetName(SHEET_KEY);
    var target = ss.getSheetByName(targetName);
    if (!backupInfo || !backupInfo.existed) {
      if (target) ss.deleteSheet(target);
      return { ok: true, restored: false, removedNewSheet: true };
    }
    var backup = ss.getSheetByName(backupInfo.sheet);
    if (!backup) throw new Error('Customer 360 backup not found: ' + backupInfo.sheet + '.');
    if (target) ss.deleteSheet(target);
    var restored = backup.copyTo(ss);
    restored.setName(targetName);
    restored.showSheet();
    return { ok: true, restored: true, backupSheet: backupInfo.sheet };
  }

  function pruneBackups_() {
    var d = deps_();
    var ss = d.util.getSpreadsheet();
    var keep = Number(d.config.getDefault('CUSTOMER_360_BACKUP_RETENTION') || 5);
    var backups = ss.getSheets().filter(function (sheet) {
      return sheet.getName().indexOf(BACKUP_PREFIX) === 0;
    }).sort(function (a, b) { return b.getName().localeCompare(a.getName()); });
    backups.slice(Math.max(0, keep)).forEach(function (sheet) { ss.deleteSheet(sheet); });
    return { retained: Math.min(backups.length, keep), removed: Math.max(0, backups.length - keep) };
  }

  function formatSectionHeaders_(sheet, headers, layout) {
    var map = {};
    headers.forEach(function (header, index) { map[header] = index + 1; });
    (layout.sections || []).forEach(function (section) {
      var start = map[section.startHeader];
      var end = map[section.endHeader];
      if (!start || !end || end < start) return;
      sheet.getRange(1, start, 1, end - start + 1)
        .setBackground(section.background)
        .setFontColor(section.fontColor)
        .setFontWeight('bold')
        .setWrap(true)
        .setHorizontalAlignment('center')
        .setVerticalAlignment('middle');
    });
    return map;
  }

  function applyColumnGroups_(sheet, headers, layout, map) {
    try {
      sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).shiftColumnGroupDepth(-8);
    } catch (ignore) {}
    var grouped = [];
    (layout.sections || []).forEach(function (section) {
      if (section.name === 'CUSTOMER') return;
      var start = map[section.startHeader];
      var end = map[section.endHeader];
      if (!start || !end || end < start) return;
      try {
        sheet.getRange(1, start, sheet.getMaxRows(), end - start + 1).shiftColumnGroupDepth(1);
        grouped.push(section.name);
      } catch (ignoreGroup) {}
    });
    return grouped;
  }

  function applyConditionalFormatting_(sheet, map) {
    var maxRows = Math.max(sheet.getMaxRows() - 1, 1);
    var rules = [];
    function range_(header) { return sheet.getRange(2, map[header], maxRows, 1); }
    if (map['Data Completeness Status']) rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('INCOMPLETE').setBackground('#F4CCCC').setFontColor('#990000').setRanges([range_('Data Completeness Status')]).build());
    if (map['Relationship Status']) rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('UNCONFIRMED').setBackground('#F4CCCC').setFontColor('#990000').setRanges([range_('Relationship Status')]).build());
    if (map['Orphan Record Count']) rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setBackground('#F4CCCC').setFontColor('#990000').setRanges([range_('Orphan Record Count')]).build());
    if (map['Active Work Order Count']) rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setBackground('#FCE5CD').setFontColor('#990000').setRanges([range_('Active Work Order Count')]).build());
    if (map['Manual Review Required?']) rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('YES').setBackground('#FFF2CC').setFontColor('#7F6000').setRanges([range_('Manual Review Required?')]).build());
    if (map['Duplicate Risk Status']) rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('HIGH').setBackground('#F4CCCC').setFontColor('#990000').setRanges([range_('Duplicate Risk Status')]).build());
    if (map['Outstanding Balance']) rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setBackground('#FFF2CC').setFontColor('#7F6000').setRanges([range_('Outstanding Balance')]).build());
    if (map['AI Enrichment Status']) {
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('ERROR').setBackground('#F4CCCC').setFontColor('#990000').setRanges([range_('AI Enrichment Status')]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('REJECTED').setBackground('#F4CCCC').setFontColor('#990000').setRanges([range_('AI Enrichment Status')]).build());
    }
    if (map['AI Contradictions']) rules.push(SpreadsheetApp.newConditionalFormatRule().whenCellNotEmpty().setBackground('#FCE5CD').setFontColor('#990000').setRanges([range_('AI Contradictions')]).build());
    sheet.setConditionalFormatRules(rules);
    return rules.length;
  }

  function rebuildFormatting() {
    var d = deps_();
    var sheet = d.util.requireSheet(SHEET_KEY);
    var headers = d.config.getCustomer360Headers();
    var layout = d.config.getCustomer360Layout();
    var actual = d.util.getActualHeaders(sheet);
    if (d.util.canonicalJson(actual) !== d.util.canonicalJson(headers)) {
      throw new Error('Customer 360 headers do not match the configured contract. Refresh the sheet before rebuilding formatting.');
    }
    var lastRow = Math.max(sheet.getLastRow(), 1);
    var lastColumn = headers.length;
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(Number(layout.frozenColumns || 3));
    sheet.setRowHeight(1, 48);
    sheet.setColumnWidths(1, lastColumn, 130);
    var map = formatSectionHeaders_(sheet, headers, layout);
    Object.keys(layout.columnWidths || {}).forEach(function (header) {
      if (map[header]) sheet.setColumnWidth(map[header], Number(layout.columnWidths[header]));
    });
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, lastColumn).setWrap(true).setVerticalAlignment('top');
      sheet.setRowHeights(2, lastRow - 1, Number(layout.dataRowHeight || 96));
    }
    (layout.currencyHeaders || []).forEach(function (header) {
      if (map[header] && sheet.getMaxRows() > 1) sheet.getRange(2, map[header], sheet.getMaxRows() - 1, 1).setNumberFormat('$#,##0.00;-$#,##0.00');
    });
    (layout.dateHeaders || []).forEach(function (header) {
      if (map[header] && sheet.getMaxRows() > 1) sheet.getRange(2, map[header], sheet.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');
    });
    var filter = sheet.getFilter();
    if (filter) filter.remove();
    if (lastRow >= 1) sheet.getRange(1, 1, Math.max(lastRow, 1), lastColumn).createFilter();
    sheet.getBandings().forEach(function (banding) { banding.remove(); });
    if (lastRow > 1) sheet.getRange(1, 1, lastRow, lastColumn).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);
    map = formatSectionHeaders_(sheet, headers, layout);
    var groups = applyColumnGroups_(sheet, headers, layout, map);
    var conditionalRules = applyConditionalFormatting_(sheet, map);
    return { ok: true, rows: lastRow - 1, columns: lastColumn, groups: groups, conditionalRules: conditionalRules };
  }

  function verifyWritten_(expectedProfiles) {
    var d = deps_();
    var rows = d.util.readObjects(SHEET_KEY, { includeRowNumber: false });
    var expectedKeys = unique_((expectedProfiles || []).map(function (r) { return r['Profile Key']; })).sort();
    var actualKeys = rows.map(function (r) { return clean_(r['Profile Key']); }).filter(Boolean).sort();
    var uniqueActual = unique_(actualKeys).sort();
    var duplicates = actualKeys.filter(function (key, index) { return index > 0 && actualKeys[index - 1] === key; });
    return {
      ok: rows.length === expectedProfiles.length && duplicates.length === 0 && d.util.canonicalJson(expectedKeys) === d.util.canonicalJson(uniqueActual),
      expectedRows: expectedProfiles.length,
      actualRows: rows.length,
      duplicateKeys: unique_(duplicates),
      expectedKeyHash: d.util.fingerprint(expectedKeys),
      actualKeyHash: d.util.fingerprint(uniqueActual)
    };
  }

  function refresh(options) {
    options = options || {};
    var d = deps_();
    return d.util.withScriptLock(function () {
      var startedAt = d.util.nowString();
      var initialPreview = previewRefresh();
      if (!initialPreview.ok) {
        throw new Error('Customer 360 preview has blocking errors: ' + initialPreview.blockingErrors.join('; '));
      }

      var checksumsBeforeSourceRefresh = d.util.computeSheetChecksums(SOURCE_SHEET_KEYS, { chunkRows: 500 });
      var sourceRefresh = null;
      var refreshSources = options.refreshSources !== false && d.config.getDefault('CUSTOMER_360_REFRESH_SOURCES') !== false;
      if (refreshSources) {
        sourceRefresh = d.striven.refreshStaleDataUnlocked({
          skipLock: true,
          replaceWithEmpty: false,
          includeRawJson: false,
          includeOperationalRawJson: false
        });
      }
      var checksumsAfterSourceRefresh = d.util.computeSheetChecksums(SOURCE_SHEET_KEYS, { chunkRows: 500 });
      var intentionalSourceChanges = d.util.compareSheetChecksums(checksumsBeforeSourceRefresh, checksumsAfterSourceRefresh);
      var refreshedReportKeys = [];
      var reportErrors = [];
      if (sourceRefresh) {
        (sourceRefresh.reports || []).forEach(function (report) {
          if (!report.error && !report.skipped) refreshedReportKeys.push(report.key);
          if (report.error) reportErrors.push({ key: report.key, message: report.error });
        });
      }

      var sources = readSources_();
      var built = buildProfiles_(sources, { refreshedReportKeys: refreshedReportKeys, reportErrors: reportErrors });
      var previewAfterRefresh = buildPreviewResult_(sources, built);
      if (!previewAfterRefresh.ok) {
        throw new Error('Customer 360 remains blocked after source refresh: ' + previewAfterRefresh.blockingErrors.join('; '));
      }
      if (!built.profiles.length) {
        throw new Error('No Customer 360 profiles were produced after source refresh.');
      }
      if (built.profiles.length > Number(d.config.getDefault('CUSTOMER_360_MAX_ROWS') || 100000)) {
        throw new Error('Customer 360 row safety limit exceeded.');
      }

      var backup = createBackup_();
      var rollback = null;
      try {
        var write = d.util.replaceManagedSheetObjects(SHEET_KEY, built.profiles, { batchSize: 1000 });
        var formatting = rebuildFormatting();
        var writeVerification = verifyWritten_(built.profiles);
        if (!writeVerification.ok) throw new Error('Customer 360 write verification failed.');
        var checksumsAfterWrite = d.util.computeSheetChecksums(SOURCE_SHEET_KEYS, { chunkRows: 500 });
        var sourceIntegrity = d.util.compareSheetChecksums(checksumsAfterSourceRefresh, checksumsAfterWrite);
        if (!sourceIntegrity.ok) throw new Error('A source sheet changed while Customer 360 was being written.');
        var validation = validate({ expectedProfiles: built.profiles });
        if (!validation.ok) throw new Error('Customer 360 validation failed after write.');
        var backupMaintenance = pruneBackups_();
        var result = {
          ok: true,
          version: VERSION,
          startedAt: startedAt,
          completedAt: d.util.nowString(),
          previewBeforeRefresh: initialPreview,
          sourceRefresh: sourceRefresh,
          intentionalSourceRefreshChanges: intentionalSourceChanges.differences,
          previewAfterRefresh: previewAfterRefresh,
          rowsWritten: built.profiles.length,
          write: write,
          formatting: formatting,
          writeVerification: writeVerification,
          sourceIntegrity: sourceIntegrity,
          validation: validation,
          backup: backup,
          backupMaintenance: backupMaintenance,
          rollback: rollback
        };
        d.util.safeLogEvent({
          phase: d.config.getPhase('STRIVEN_DATA'),
          module: MODULE_NAME,
          eventType: 'CUSTOMER_360_REFRESH',
          decision: 'PASS',
          reason: 'Customer 360 factual refresh completed.',
          metadata: {
            rowsWritten: result.rowsWritten,
            sourceRefreshOk: sourceRefresh ? sourceRefresh.ok : null,
            validationOk: validation.ok,
            sourceIntegrityOk: sourceIntegrity.ok,
            backupSheet: backup.sheet || ''
          }
        });
        return result;
      } catch (error) {
        try { rollback = restoreBackup_(backup); } catch (rollbackError) {
          throw new Error('Customer 360 refresh failed and rollback also failed. Refresh error: ' + (error.message || String(error)) + '. Rollback error: ' + (rollbackError.message || String(rollbackError)) + '.');
        }
        d.util.safeLogEvent({
          phase: d.config.getPhase('STRIVEN_DATA'), module: MODULE_NAME,
          eventType: 'CUSTOMER_360_REFRESH_ERROR', decision: 'FAIL',
          reason: error.message || String(error), metadata: { rollback: rollback, backupSheet: backup.sheet || '' }
        });
        throw new Error('Customer 360 refresh failed. Prior output was restored. Cause: ' + (error.message || String(error)));
      }
    }, options.lockTimeoutMs);
  }

  function validate(options) {
    options = options || {};
    var d = deps_();
    var sheet = d.util.getSheet(SHEET_KEY);
    var errors = [];
    var warnings = [];
    if (!sheet) return { ok: false, errors: ['Customer 360 sheet is missing.'], warnings: [] };
    var contract = d.util.inspectManagedHeaderContract(SHEET_KEY);
    if (!contract.ok) errors.push('Customer 360 header contract does not match configuration.');
    var rows = d.util.readObjects(SHEET_KEY, { includeRowNumber: true });
    var keys = {};
    var duplicateKeys = [];
    rows.forEach(function (row) {
      var key = clean_(row['Profile Key']);
      if (!key) errors.push('Blank Profile Key at row ' + row.__rowNumber + '.');
      else if (keys[key]) duplicateKeys.push(key);
      else keys[key] = true;
      if (!clean_(row['Customer ID'])) errors.push('Blank Customer ID at row ' + row.__rowNumber + '.');
      if (clean_(row['Profile Key']) !== clean_(row['Customer ID']) + '|' + (clean_(row['Location ID']) || 'NO_LOCATION')) {
        errors.push('Invalid Profile Key composition at row ' + row.__rowNumber + '.');
      }
      if (clean_(row['Relationship Status']) === 'UNCONFIRMED') warnings.push('Unconfirmed relationship at ' + key + '.');
    });
    if (duplicateKeys.length) errors.push('Duplicate Profile Keys: ' + unique_(duplicateKeys).join(', '));

    var customerRows = d.util.readObjectsExcludingHeaders('STRIVEN_CUSTOMER_DATA', ['Raw Source JSON'], { includeRowNumber: false }).filter(function (r) {
      return clean_(r['Entity Type']).toUpperCase() === 'CUSTOMER' && clean_(r['Customer ID']);
    });
    var customerIds = unique_(customerRows.map(function (r) { return r['Customer ID']; }));
    var represented = {};
    rows.forEach(function (r) { represented[id_(r['Customer ID'])] = true; });
    var missingCustomers = customerIds.filter(function (cid) { return !represented[cid]; });
    if (missingCustomers.length) errors.push('Validated customers missing from Customer 360: ' + missingCustomers.slice(0, 20).join(', '));

    if (options.expectedProfiles && rows.length !== options.expectedProfiles.length) errors.push('Written row count differs from in-memory profile count.');
    return {
      ok: errors.length === 0,
      version: VERSION,
      rows: rows.length,
      uniqueProfileKeys: Object.keys(keys).length,
      customersExpected: customerIds.length,
      customersRepresented: Object.keys(represented).filter(Boolean).length,
      duplicateProfileKeys: unique_(duplicateKeys),
      missingCustomers: missingCustomers,
      contract: contract,
      errors: errors,
      warnings: unique_(warnings)
    };
  }

  function getProfilesForAI() {
    var d = deps_();
    return d.util.readObjects(SHEET_KEY, { includeRowNumber: true });
  }

  return {
    moduleName: MODULE_NAME,
    version: VERSION,
    previewRefresh: previewRefresh,
    refresh: refresh,
    validate: validate,
    rebuildFormatting: rebuildFormatting,
    buildProfilesFromCurrentSources: function (options) {
      options = options || {};
      var sources = readSources_({
        includeExistingCustomer360: options.previewOnly !== true
      });
      return buildProfiles_(sources, options);
    },
    getProfilesForAI: getProfilesForAI,
    getAIHeaders: function () { return AI_HEADERS.slice(); },
    createBackup: createBackup_,
    restoreBackup: restoreBackup_
  };
})();
