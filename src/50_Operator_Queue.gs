/* CF_SERVICEOPS_V5_13_5_DURABLE_OPERATIONAL_EVIDENCE_R1 */
/* CF_SERVICEOPS_V5_13_3_QUEUE_TRIGGER_HYGIENE_R1 */
/************************************************************
 * APPS SCRIPT — 50_Operator_Queue.gs
 * CF ServiceOps — Operator Queue + Service Snapshot
 * Version: 5.8.0
 *
 * OPERATOR CONTRACT
 * - Dashboard is read-only and shows service-wide KPIs/snapshots.
 * - Operator Queue is the only processing workspace.
 * - All technical ledgers/caches remain hidden.
 * - Queue formatting is rebuilt deterministically on every refresh.
 * - No live Striven writes are performed by this module.
 ************************************************************/
var CF = CF || {};

CF.OperatorQueue = (function () {
  'use strict';

  var MODULE_NAME = '50_Operator_Queue';
  var VERSION = '5.8.1';

  var STAGE_PRIORITY = {
    'NEEDS REVIEW': 1,
    'READY FOR CUSTOMER CREATE': 2,
    'READY FOR CONTACT CREATE': 3,
    'READY FOR LOCATION CREATE': 4,
    'APPROVED FOR CUSTOMER STRUCTURE': 5,
    'CUSTOMER RESOLVED': 6,
    'CUSTOMER STRUCTURE COMPLETE': 7,
    'NEW INTAKE': 8
  };

  function deps_() {
    if (!CF.Config || !CF.Util) throw new Error('CF.Config and CF.Util are required.');
    return { config: CF.Config, util: CF.Util };
  }

  function clean_(value) { return deps_().util.cleanText(value); }
  function upper_(value) { return clean_(value).toUpperCase(); }

  function actor_(value) {
    var actor = clean_(value);
    if (actor) return actor;
    try { actor = clean_(Session.getActiveUser().getEmail()); } catch (ignored) {}
    return actor || 'OPERATOR';
  }

  function line_(items) {
    return (items || []).map(clean_).filter(Boolean).join('\n');
  }

  function compactDate_(value) {
    if (!value) return '';
    try { return deps_().util.formatDate(value, 'MMM d, yyyy'); } catch (ignored) { return clean_(value); }
  }

  function active_(row) {
    var d = deps_();
    return !d.config.isTerminalState(row['Current Stage']) && !d.config.isTerminalState(row['Final Outcome']);
  }

  function candidateIdsFromEvidence_(row, entityType) {
    var d = deps_();
    var evidence = d.util.parseJson(row['Match Evidence JSON'], {});
    var candidates = evidence[entityType + 'Candidates'] || [];
    var ids = [];
    candidates.forEach(function (candidate) {
      var item = candidate && candidate.row ? candidate.row : (candidate || {});
      var id = '';
      if (entityType === 'customer') id = item['Customer ID'] || item['Entity ID'] || candidate.id || '';
      if (entityType === 'contact') id = item['Contact ID'] || item['Entity ID'] || candidate.id || '';
      if (entityType === 'location') id = item['Location ID'] || candidate.id || '';
      id = clean_(id);
      if (id && ids.indexOf(id) === -1) ids.push(id);
    });
    return ids;
  }

  function candidateChoices_(row) {
    var choices = [];
    if (upper_(row['Customer Match Status']) === 'AMBIGUOUS') {
      candidateIdsFromEvidence_(row, 'customer').forEach(function (id) { choices.push('CUSTOMER ' + id); });
    }
    if (upper_(row['Contact Match Status']) === 'AMBIGUOUS') {
      candidateIdsFromEvidence_(row, 'contact').forEach(function (id) { choices.push('CONTACT ' + id); });
    }
    if (upper_(row['Location Match Status']) === 'AMBIGUOUS') {
      candidateIdsFromEvidence_(row, 'location').forEach(function (id) { choices.push('LOCATION ' + id); });
    }
    return choices;
  }

  function parseCandidateChoice_(value) {
    var match = /^\s*(CUSTOMER|CONTACT|LOCATION)\s+(.+?)\s*$/i.exec(clean_(value));
    if (!match) return null;
    return { entityType: match[1].toLowerCase(), entityId: clean_(match[2]) };
  }

  function operatorOptionsForRow_(row) {
    var options = [''];
    candidateChoices_(row).forEach(function (choice) { options.push(choice); });

    var stage = upper_(row['Current Stage']);
    var customerAction = upper_(row['Customer Action']);
    var contactAction = upper_(row['Contact Action']);
    var locationAction = upper_(row['Location Action']);

    if (stage !== 'NEW INTAKE') options.push('APPROVE PROPOSED ACTION');
    if (customerAction === 'REVIEW' || upper_(row['Customer Match Status']) === 'NOT FOUND') options.push('CREATE CUSTOMER');
    if (contactAction === 'REVIEW' || upper_(row['Contact Match Status']) === 'NOT FOUND') options.push('CREATE CONTACT');
    if (locationAction === 'REVIEW' || upper_(row['Location Match Status']) === 'NOT FOUND') options.push('CREATE LOCATION');
    options.push('REQUEST INFORMATION', 'MARK DUPLICATE', 'CANCEL');

    var unique = [];
    options.forEach(function (item) { if (unique.indexOf(item) === -1) unique.push(item); });
    return unique;
  }

  function entityMatchLine_(row, label, entityType, statusField, idField, actionField) {
    var status = upper_(row[statusField]);
    var id = clean_(row[idField]);
    if (status === 'MATCHED' && id) return label + ': ' + id + ' ✓';
    if (status === 'AMBIGUOUS') {
      var ids = candidateIdsFromEvidence_(row, entityType);
      return label + ': ' + (ids.length ? ids.join(' / ') + ' ⚠' : 'AMBIGUOUS ⚠');
    }
    if (upper_(row[actionField]) === 'CREATE') return label + ': NEW';
    return label + ': ' + (row[statusField] || '—');
  }

  function statusText_(row) {
    var review = upper_(row['Manual Review?']) === 'YES'
      ? 'Review: ' + (row['Manual Review Reason'] || row['Blocking Issue'] || 'Required')
      : '';
    return line_([
      row['Current Stage'] || row['Request Status'],
      'Submitted: ' + compactDate_(row['Submitted At'] || row['Created At']),
      review
    ]);
  }

  function customerText_(row) {
    return line_([
      row['Full Name'],
      row['Phone'] + (clean_(row['Alt Phone']) ? ' / ' + row['Alt Phone'] : ''),
      row['Email'],
      row['Full Address']
    ]);
  }

  function serviceText_(row) {
    var d = deps_();
    return line_([
      clean_(row['Unit Details']) ? 'Unit: ' + d.util.truncate(row['Unit Details'], 180) : '',
      clean_(row['Service Details']) ? 'Service: ' + d.util.truncate(row['Service Details'], 220) : '',
      clean_(row['Preferred Days']) ? 'Preferred: ' + d.util.truncate(row['Preferred Days'], 100) : '',
      clean_(row['Additional Notes']) ? 'Notes: ' + d.util.truncate(row['Additional Notes'], 180) : ''
    ]);
  }

  /* CF_SERVICEOPS_SERVICE_STRIVEN_CHECKLIST_R1
   * Compact service checklist rendered inside the existing Striven column.
   * Work Order is the service-facing name for the Sales Order record.
   */
  function checklistSymbol_(state) {
    state = upper_(state);
    if (state === 'DONE') return '✅';
    if (state === 'REVIEW') return '⚠️';
    return '⏳';
  }

  function customerChecklistState_(row, customerId) {
    if (customerId) return 'DONE';
    if (upper_(row['Customer Match Status']) === 'AMBIGUOUS' || upper_(row['Manual Review?']) === 'YES') return 'REVIEW';
    return 'PENDING';
  }

  function contactChecklistState_(row, contactId) {
    var association = upper_(row['Contact Association Status']);
    var structure = upper_(row['Customer Structure Status']);
    var reconciliation = upper_(row['Reconciliation Status']);
    if (/CONFLICT|AMBIGUOUS|REVIEW|ERROR/.test(association)) return 'REVIEW';
    if (contactId && (
      /ASSOCIATED|CONFIRMED|CACHE_CONFIRMED/.test(association) ||
      /CUSTOMER \+ CONTACT INFO CONFIRMED/.test(reconciliation) ||
      /CUSTOMER STRUCTURE COMPLETE|COMPLETE/.test(structure)
    )) return 'DONE';
    if (contactId) return 'PENDING';
    if (upper_(row['Contact Match Status']) === 'AMBIGUOUS' || upper_(row['Manual Review?']) === 'YES') return 'REVIEW';
    return 'PENDING';
  }

  function locationChecklistState_(row, locationId) {
    var status = upper_(row['Location Match Status']);
    var structure = upper_(row['Customer Structure Status']);
    if (status === 'AMBIGUOUS' || /LOCATION.*CONFLICT|LOCATION.*REVIEW|LOCATION.*ERROR/.test(upper_(row['Reconciliation Status']))) return 'REVIEW';
    if (locationId && (status === 'MATCHED' || /PRIMARY LOCATION.*CONFIRMED|CUSTOMER STRUCTURE COMPLETE|COMPLETE/.test(structure))) return 'DONE';
    if (locationId) return 'PENDING';
    if (upper_(row['Manual Review?']) === 'YES') return 'REVIEW';
    return 'PENDING';
  }

  function assetChecklist_(row, operationalIndex) {
    var customerId = resolvedCustomerId_(row);
    var assetIds = customerId && operationalIndex && operationalIndex.assetsByCustomer && operationalIndex.assetsByCustomer[customerId]
      ? uniqueStrings_(operationalIndex.assetsByCustomer[customerId])
      : [];
    var statedCount = Number(row['Customer Asset Count'] || 0);
    var count = Math.max(statedCount, assetIds.length);
    var historyStatus = upper_(row['History Enrichment Status']);
    var state = /ERROR|BLOCK|REVIEW|AMBIGUOUS/.test(historyStatus) ? 'REVIEW' : (historyStatus || assetIds.length || statedCount >= 0 ? 'DONE' : 'PENDING');
    if (!historyStatus && !assetIds.length && clean_(row['Customer Asset Count']) === '') state = 'PENDING';

    var display = '';
    if (assetIds.length) {
      display = assetIds.slice(0, 3).join(' / ');
      if (assetIds.length > 3) display += ' +' + (assetIds.length - 3);
    } else if (state === 'DONE') {
      display = String(count);
    }
    return { state: state, ids: assetIds, display: display };
  }

  function workOrderChecklist_(row) {
    var durable = durableSalesOrder_(row);
    var id = clean_(durable.id || row['Work Order ID']);
    var number = clean_(durable.number || row['Work Order Number'] || id);
    var outcome = upper_(row['Final Outcome']);
    var reconciliation = upper_(row['Reconciliation Status']);
    var stage = upper_(row['Current Stage']);
    var workOrderStatus = upper_(row['Work Order Status'] || durable.status);
    var verified = !!(id || number) && (
      /VERIFIED/.test(outcome) ||
      /SALES ORDER VERIFIED|WORK ORDER VERIFIED/.test(reconciliation) ||
      stage === 'COMPLETED'
    );
    var review = /BLOCK|ERROR|REVIEW|CONFLICT|AMBIGUOUS/.test(workOrderStatus) || upper_(row['Manual Review?']) === 'YES';
    return {
      state: verified ? 'DONE' : (review ? 'REVIEW' : 'PENDING'),
      id: id,
      number: number,
      url: clean_(durable.url || row['Work Order Link']) || (id ? strivenUrl_('WORK_ORDER', { entityId: id }) : '')
    };
  }

  function strivenText_(row, operationalIndex) {
    var customerId = resolvedCustomerId_(row);
    var contactId = clean_(row['Matched Contact ID'] || row['Created Contact ID']);
    var locationId = clean_(row['Matched Location ID'] || row['Created Location ID']);
    var assets = assetChecklist_(row, operationalIndex);
    var workOrder = workOrderChecklist_(row);

    return line_([
      'Customer: ' + (customerId || '') + (customerId ? ' ' : '') + checklistSymbol_(customerChecklistState_(row, customerId)),
      'Contact: ' + (contactId || '') + (contactId ? ' ' : '') + checklistSymbol_(contactChecklistState_(row, contactId)),
      'Location: ' + (locationId || '') + (locationId ? ' ' : '') + checklistSymbol_(locationChecklistState_(row, locationId)),
      'Assets: ' + (assets.display || '') + (assets.display ? ' ' : '') + checklistSymbol_(assets.state),
      'Work Order: ' + (workOrder.number || '') + (workOrder.number ? ' ' : '') + checklistSymbol_(workOrder.state)
    ]);
  }

  // STRIVEN_QUEUE_HYPERLINKS_V1
  // Keep URLs centralized so all Queue links use the same Striven routes.
  function strivenUrl_(entityType, ids) {
    ids = ids || {};
    var customerId = clean_(ids.customerId);
    var entityId = clean_(ids.entityId);
    if (!entityId) return '';

    if (entityType === 'CUSTOMER') {
      return 'https://classicfireplace.striven.com/CRM/AccountDashboard.aspx?AccountID=' + encodeURIComponent(entityId);
    }
    if (entityType === 'CONTACT') {
      return customerId ? 'https://classicfireplace.striven.com/next/crm#/accounts/' + encodeURIComponent(customerId) + '/contacts/' + encodeURIComponent(entityId) : '';
    }
    if (entityType === 'LOCATION') {
      return customerId ? 'https://classicfireplace.striven.com/next/crm#/accounts/' + encodeURIComponent(customerId) + '/locations/' + encodeURIComponent(entityId) : '';
    }
    if (entityType === 'WORK_ORDER' || entityType === 'SALES_ORDER') {
      return 'https://classicfireplace.striven.com/next/crm#/sales-orders/' + encodeURIComponent(entityId);
    }
    if (entityType === 'TASK') {
      return 'https://classicfireplace.striven.com/Tasks/TaskInfo.aspx?nav=1&TaskID=' + encodeURIComponent(entityId);
    }
    if (entityType === 'ASSET') {
      return 'https://classicfireplace.striven.com/AssetManagement/CustomerAssetsBasicInfo.aspx?AssetID=' + encodeURIComponent(entityId);
    }
    return '';
  }

  function uniqueStrings_(values) {
    var seen = {};
    var out = [];
    (values || []).forEach(function (value) {
      var clean = clean_(value);
      if (!clean || seen[clean]) return;
      seen[clean] = true;
      out.push(clean);
    });
    return out;
  }

  function resolvedCustomerId_(row) {
    return clean_(row['Matched Customer ID'] || row['Created Customer ID']);
  }

  function evidenceCandidateRows_(row, entityType) {
    var evidence = deps_().util.parseJson(row['Match Evidence JSON'], {});
    var key = entityType + 'Candidates';
    return (evidence[key] || []).map(function (candidate) {
      return candidate && candidate.row ? candidate.row : (candidate || {});
    });
  }

  // OPERATOR_QUEUE_OPERATIONAL_COLUMNS_V1
  // SALES_ORDER_DATE_CUTOFF_V1
  function parseOperationalDateMs_(value) {
    if (value instanceof Date) return value.getTime();
    var text = clean_(value);
    if (!text) return 0;

    var us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (us) return new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]), 0, 0, 0, 0).getTime();

    var iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 0, 0, 0, 0).getTime();

    var parsed = new Date(text).getTime();
    return isNaN(parsed) ? 0 : parsed;
  }

  function salesOrderDateMs_(row) {
    return parseOperationalDateMs_(row && row['Sales Order Date']);
  }

  function workOrderReportingCutoffMs_() {
    // Striven "Sales Order Date From: 07/01/2026" is inclusive.
    return new Date(2026, 6, 1, 0, 0, 0, 0).getTime();
  }

  function reportingWorkOrderStatus_(status) {
    var value = upper_(status);
    return value === 'APPROVED' || value === 'IN PROGRESS' || value === 'COMPLETED';
  }

  function reportingWorkOrder_(row) {
    if (upper_(row && row['Entity Type']) !== 'WORK_ORDER') return false;
    if (!reportingWorkOrderStatus_(row['Status'])) return false;
    var orderDate = salesOrderDateMs_(row);
    return !!orderDate && orderDate >= workOrderReportingCutoffMs_();
  }

  function operationalDateMs_(row) {
    var raw = clean_(row['Sales Order Date'] || row['Created At'] || row['Scheduled Date'] || row['Completed At']);
    return parseOperationalDateMs_(raw);
  }

  function pushOperational_(map, key, row, idField) {
    key = clean_(key);
    if (!key) return;
    if (!map[key]) map[key] = [];
    var id = clean_(row[idField] || row['Entity ID']);
    var duplicate = map[key].some(function (existing) {
      return id && clean_(existing[idField] || existing['Entity ID']) === id;
    });
    if (!duplicate) map[key].push(row);
  }

  function buildOperationalLinkIndex_(operationalRows) {
    var index = {
      assetsByCustomer: {},
      workOrdersByCustomer: {},
      workOrdersByLocation: {},
      workOrdersById: {},
      workOrdersByNumber: {},
      tasksByCustomer: {},
      tasksByLocation: {},
      tasksByWorkOrderNumber: {}
    };

    (operationalRows || []).forEach(function (row) {
      var customerId = clean_(row['Customer ID']);
      var locationId = clean_(row['Location ID']);
      var entityType = upper_(row['Entity Type']);
      var assetId = clean_(row['Asset ID'] || (entityType === 'ASSET' ? row['Entity ID'] : ''));

      if (customerId && assetId) {
        if (!index.assetsByCustomer[customerId]) index.assetsByCustomer[customerId] = [];
        if (index.assetsByCustomer[customerId].indexOf(assetId) === -1) index.assetsByCustomer[customerId].push(assetId);
      }

      if (entityType === 'WORK_ORDER' && reportingWorkOrder_(row)) {
        var workOrderId = clean_(row['Work Order ID'] || row['Entity ID']);
        var workOrderNumber = clean_(row['Work Order Number']);
        if (workOrderId) index.workOrdersById[workOrderId] = row;
        if (workOrderNumber) index.workOrdersByNumber[workOrderNumber] = row;
        pushOperational_(index.workOrdersByCustomer, customerId, row, 'Work Order ID');
        pushOperational_(index.workOrdersByLocation, locationId, row, 'Work Order ID');
      }

      if (entityType === 'TASK' || entityType === 'TASK_RELATIONSHIP') {
        var taskWorkOrderNumber = clean_(row['Work Order Number']);
        pushOperational_(index.tasksByCustomer, customerId, row, 'Task ID');
        pushOperational_(index.tasksByLocation, locationId, row, 'Task ID');
        pushOperational_(index.tasksByWorkOrderNumber, taskWorkOrderNumber, row, 'Task ID');
      }
    });

    Object.keys(index.workOrdersByCustomer).forEach(function (key) {
      index.workOrdersByCustomer[key].sort(function (a, b) { return operationalDateMs_(b) - operationalDateMs_(a); });
    });
    Object.keys(index.workOrdersByLocation).forEach(function (key) {
      index.workOrdersByLocation[key].sort(function (a, b) { return operationalDateMs_(b) - operationalDateMs_(a); });
    });
    return index;
  }

  function activeEntityIds_(row) {
    var payload = deps_().util.parseJson(row['Active Work JSON'], {});
    var rows = payload.activeAtLocation || [];
    var workOrderIds = [];
    var taskIds = [];

    rows.forEach(function (item) {
      var entityType = upper_(item['Entity Type']);
      var workOrderId = clean_(item['Work Order ID'] || (entityType === 'WORK_ORDER' ? item['Entity ID'] : ''));
      var taskId = clean_(item['Task ID'] || ((entityType === 'TASK' || entityType === 'TASK_RELATIONSHIP') ? item['Entity ID'] : ''));
      if (workOrderId) workOrderIds.push(workOrderId);
      if (taskId) taskIds.push(taskId);
    });

    if (clean_(row['Work Order ID'])) workOrderIds.push(row['Work Order ID']);
    return { workOrderIds: uniqueStrings_(workOrderIds), taskIds: uniqueStrings_(taskIds) };
  }

  function addLinkSpec_(specs, text, url, linePrefix, matchText) {
    text = clean_(text);
    url = clean_(url);
    if (!text || !url) return;
    specs.push({ text: text, url: url, linePrefix: clean_(linePrefix), matchText: clean_(matchText) || text });
  }

  function strivenLinkSpecs_(row, operationalIndex) {
    var specs = [];
    var customerId = resolvedCustomerId_(row);

    if (customerId) {
      addLinkSpec_(specs, customerId, strivenUrl_('CUSTOMER', { entityId: customerId }), 'Customer:');
    } else if (upper_(row['Customer Match Status']) === 'AMBIGUOUS') {
      evidenceCandidateRows_(row, 'customer').forEach(function (item) {
        var id = clean_(item['Customer ID'] || item['Entity ID']);
        addLinkSpec_(specs, id, strivenUrl_('CUSTOMER', { entityId: id }), 'Customer:');
      });
    }

    var contactId = clean_(row['Matched Contact ID'] || row['Created Contact ID']);
    if (contactId && customerId) {
      addLinkSpec_(specs, contactId, strivenUrl_('CONTACT', { customerId: customerId, entityId: contactId }), 'Contact:');
    } else if (upper_(row['Contact Match Status']) === 'AMBIGUOUS') {
      evidenceCandidateRows_(row, 'contact').forEach(function (item) {
        var id = clean_(item['Contact ID'] || item['Entity ID']);
        var parentId = clean_(item['Customer ID'] || customerId);
        addLinkSpec_(specs, id, strivenUrl_('CONTACT', { customerId: parentId, entityId: id }), 'Contact:');
      });
    }

    var locationId = clean_(row['Matched Location ID'] || row['Created Location ID']);
    if (locationId && customerId) {
      addLinkSpec_(specs, locationId, strivenUrl_('LOCATION', { customerId: customerId, entityId: locationId }), 'Location:');
    } else if (upper_(row['Location Match Status']) === 'AMBIGUOUS') {
      evidenceCandidateRows_(row, 'location').forEach(function (item) {
        var id = clean_(item['Location ID'] || item['Entity ID']);
        var parentId = clean_(item['Customer ID'] || customerId);
        addLinkSpec_(specs, id, strivenUrl_('LOCATION', { customerId: parentId, entityId: id }), 'Location:');
      });
    }

    var assets = assetChecklist_(row, operationalIndex);
    assets.ids.slice(0, 3).forEach(function (id) {
      addLinkSpec_(specs, id, strivenUrl_('ASSET', { entityId: id }), 'Assets:');
    });

    var workOrder = workOrderChecklist_(row);
    if (workOrder.number && workOrder.url) {
      addLinkSpec_(specs, workOrder.number, workOrder.url, 'Work Order:');
    }

    return specs;
  }

  function historyLinkSpecs_(row, operationalIndex) {
    var specs = [];
    var customerId = resolvedCustomerId_(row);
    var assetIds = customerId && operationalIndex && operationalIndex.assetsByCustomer[customerId]
      ? operationalIndex.assetsByCustomer[customerId]
      : [];
    assetIds.slice(0, 3).forEach(function (id) {
      addLinkSpec_(specs, id, strivenUrl_('ASSET', { entityId: id }), 'Assets:');
    });

    var activeIds = activeEntityIds_(row);
    activeIds.workOrderIds.slice(0, 3).forEach(function (id) {
      addLinkSpec_(specs, id, strivenUrl_('WORK_ORDER', { entityId: id }), 'Striven:', 'WO ' + id);
    });
    activeIds.taskIds.slice(0, 3).forEach(function (id) {
      addLinkSpec_(specs, id, strivenUrl_('TASK', { entityId: id }), 'Striven:', 'Task ' + id);
    });
    return specs;
  }

  function setRichLinks_(range, specs) {
    var text = String(range.getDisplayValue() || '');
    if (!text || !specs || !specs.length) return;

    var builder = SpreadsheetApp.newRichTextValue().setText(text);
    var linked = false;
    specs.forEach(function (spec) {
      var needle = String(spec.text || '');
      var matchText = String(spec.matchText || needle);
      if (!needle || !matchText || !spec.url) return;

      var lines = text.split('\n');
      var offset = 0;
      lines.forEach(function (line) {
        var lineStart = offset;
        offset += line.length + 1;
        if (spec.linePrefix && line.indexOf(spec.linePrefix) !== 0) return;

        var from = 0;
        while (from < line.length) {
          var matchIndex = line.indexOf(matchText, from);
          if (matchIndex === -1) break;
          var needleWithinMatch = matchText.indexOf(needle);
          if (needleWithinMatch === -1) break;
          var index = lineStart + matchIndex + needleWithinMatch;
          builder.setLinkUrl(index, index + needle.length, spec.url);
          linked = true;
          from = matchIndex + matchText.length;
        }
      });
    });
    if (linked) range.setRichTextValue(builder.build());
  }

  function applyStrivenHyperlinks_(sheet, sourceRows, operationalIndex) {
    var headers = deps_().util.getActualHeaders(sheet);
    var strivenCol = headers.indexOf('Striven') + 1;
    var historyCol = headers.indexOf('History') + 1;
    if (!strivenCol && !historyCol) return;

    (sourceRows || []).forEach(function (row, index) {
      var rowNumber = index + 2;
      if (strivenCol) setRichLinks_(sheet.getRange(rowNumber, strivenCol), strivenLinkSpecs_(row, operationalIndex));
      if (historyCol) setRichLinks_(sheet.getRange(rowNumber, historyCol), historyLinkSpecs_(row, operationalIndex));
    });
  }

  function historyText_(row, operationalIndex) {
    var d = deps_();
    var risk = upper_(row['Duplicate Risk Status']) === 'NONE'
      ? 'Duplicate risk: none'
      : 'Duplicate risk: ' + (row['Duplicate Risk Status'] || 'REVIEW') + (clean_(row['Duplicate Risk Reason']) ? ' — ' + row['Duplicate Risk Reason'] : '');

    var customerId = resolvedCustomerId_(row);
    var assetIds = customerId && operationalIndex && operationalIndex.assetsByCustomer[customerId]
      ? operationalIndex.assetsByCustomer[customerId]
      : [];
    var assetLine = 'Assets: ' + Number(row['Customer Asset Count'] || assetIds.length || 0);
    if (assetIds.length) {
      assetLine += ' · IDs ' + assetIds.slice(0, 3).join(' / ');
      if (assetIds.length > 3) assetLine += ' +' + (assetIds.length - 3);
    }

    var activeIds = activeEntityIds_(row);
    var idParts = [];
    if (activeIds.workOrderIds.length) idParts.push('WO ' + activeIds.workOrderIds.slice(0, 3).join(' / '));
    if (activeIds.taskIds.length) idParts.push('Task ' + activeIds.taskIds.slice(0, 3).join(' / '));

    return line_([
      assetLine,
      clean_(row['Last Service Date']) ? 'Last service: ' + compactDate_(row['Last Service Date']) + (clean_(row['Last Service Technician']) ? ' · ' + row['Last Service Technician'] : '') : '',
      d.util.truncate(row['Active Work Summary'], 180),
      idParts.length ? 'Striven: ' + idParts.join(' · ') : '',
      risk
    ]);
  }

  function resolvedLocationId_(row) {
    return clean_(row['Matched Location ID'] || row['Created Location ID']);
  }

  function dedupeOperationalRows_(rows, idField) {
    var seen = {};
    return (rows || []).filter(function (row) {
      var id = clean_(row[idField] || row['Entity ID']);
      if (!id || seen[id]) return false;
      seen[id] = true;
      return true;
    });
  }

  function relevantWorkOrders_(row, operationalIndex) {
    operationalIndex = operationalIndex || {};
    var exactId = clean_(row['Work Order ID']);
    var exactNumber = clean_(row['Work Order Number']);
    var locationId = resolvedLocationId_(row);
    var customerId = resolvedCustomerId_(row);
    var rows = [];

    if (exactId && operationalIndex.workOrdersById && operationalIndex.workOrdersById[exactId]) rows.push(operationalIndex.workOrdersById[exactId]);
    if (exactNumber && operationalIndex.workOrdersByNumber && operationalIndex.workOrdersByNumber[exactNumber]) rows.push(operationalIndex.workOrdersByNumber[exactNumber]);
    if (locationId && operationalIndex.workOrdersByLocation && operationalIndex.workOrdersByLocation[locationId]) rows = rows.concat(operationalIndex.workOrdersByLocation[locationId]);
    if (!rows.length && customerId && operationalIndex.workOrdersByCustomer && operationalIndex.workOrdersByCustomer[customerId]) rows = rows.concat(operationalIndex.workOrdersByCustomer[customerId]);

    rows = dedupeOperationalRows_(rows, 'Work Order ID');
    rows.sort(function (a, b) { return operationalDateMs_(b) - operationalDateMs_(a); });
    return rows;
  }

  function relevantTasks_(row, operationalIndex, workOrders) {
    operationalIndex = operationalIndex || {};
    var rows = [];
    var allowedNumbers = {};

    (workOrders || []).slice(0, 3).forEach(function (wo) {
      var number = clean_(wo['Work Order Number']);
      if (!number) return;
      allowedNumbers[number] = true;
      if (operationalIndex.tasksByWorkOrderNumber && operationalIndex.tasksByWorkOrderNumber[number]) {
        rows = rows.concat(operationalIndex.tasksByWorkOrderNumber[number]);
      }
    });

    // Tasks shown in the Queue must belong to one of the selected post-Jul-1 Work Orders.
    rows = rows.filter(function (task) {
      var number = clean_(task['Work Order Number']);
      return !!number && !!allowedNumbers[number];
    });
    rows = dedupeOperationalRows_(rows, 'Task ID');
    rows.sort(function (a, b) { return operationalDateMs_(b) - operationalDateMs_(a); });
    return rows;
  }

  // CF_SERVICEOPS_V5_10_13_RUNTIME_MATCHING_SO_NOTES_QUEUE_R1
  
  function durableSalesOrder_(row){
    var id=clean_(row['Work Order ID']),number=clean_(row['Work Order Number']),status=clean_(row['Work Order Status']),name='',url=clean_(row['Work Order Link']);
    var root={};
    try{root=deps_().util.parseJson(row['Write Journal JSON'],{})||{};}catch(e){root={};}
    var so=root&&root.salesOrderCreate||{};
    var recovery=root&&root.existingSalesOrderRecovery||{};
    var body=so&&so.verification&&so.verification.result&&so.verification.result.body||so.responseBody||{};
    if(!id)id=clean_(so.canonicalSalesOrderId||so.responseIdentifier||recovery.salesOrderId||body.id);
    if(!number)number=clean_(so.canonicalOrderNumber||recovery.salesOrderNumber||body.orderNumber);
    name=clean_(body.orderName||recovery.salesOrderName||row['Work Order Name']||row['Sales Order Name']);
    if(!status)status=clean_((body.status&&body.status.name)||recovery.salesOrderStatus);
    if(!url)url=clean_(recovery.salesOrderUrl);
    if(!url&&id)url='https://classicfireplace.striven.com/next/crm#/sales-orders/'+id;
    return{id:id,number:number||id,name:name||'Sales Order',status:status,url:url};
  }

  function durableTask_(row){
    var root={};
    try{root=deps_().util.parseJson(row['Write Journal JSON'],{})||{};}catch(e){root={};}
    var recovery=root&&root.existingSalesOrderRecovery||{};
    var task=root&&root.serviceTaskRecovery||{};
    var id=clean_(recovery.taskId||task.taskId||task.canonicalTaskId);
    var name=clean_(recovery.taskName||task.taskName);
    var status=clean_(recovery.taskStatus||task.taskStatus);
    var url=clean_(recovery.taskUrl||task.taskUrl);
    if(!url&&id)url='https://classicfireplace.striven.com/Tasks/TaskInfo.aspx?nav=1&TaskID='+encodeURIComponent(id);
    return{id:id,name:name||'Task',status:status,url:url};
  }
function salesOrderText_(row,operationalIndex){
    var workOrders=relevantWorkOrders_(row,operationalIndex);
    if(!workOrders.length){
      var durable=durableSalesOrder_(row);
      if(!durable.id&&!durable.number)return'—';
      return line_([
        [(durable.number?'#'+durable.number:''),durable.name].filter(Boolean).join(' - '),
        durable.status
      ]);
    }
    var workOrder=workOrders[0];
    var number=clean_(workOrder['Work Order Number']||workOrder['Work Order ID']||workOrder['Entity ID']);
    var name=clean_(workOrder['Work Order Name']||workOrder['Description'])||'Sales Order';
    var status=clean_(workOrder['Status']||row['Work Order Status']);
    return line_([
      [(number?'#'+number:''),name].filter(Boolean).join(' - '),
      status,
      workOrders.length>1?'+'+(workOrders.length-1)+' more related order(s)':''
    ]);
  }

  function taskText_(row,operationalIndex){
    var workOrders=relevantWorkOrders_(row,operationalIndex);
    var tasks=relevantTasks_(row,operationalIndex,workOrders);
    if(!tasks.length){
      var durable=durableTask_(row);
      if(!durable.id)return'—';
      return line_([
        [(durable.id?'#'+durable.id:''),deps_().util.truncate(durable.name,125)].filter(Boolean).join(' - '),
        durable.status
      ]);
    }
    var task=tasks[0];
    var number=clean_(task['Task ID']||task['Entity ID']);
    var name=clean_(task['Task Name']||task['Description'])||'Task';
    var status=clean_(task['Status']);
    return line_([
      [(number?'#'+number:''),deps_().util.truncate(name,125)].filter(Boolean).join(' - '),
      status,
      tasks.length>1?'+'+(tasks.length-1)+' more related task(s)':''
    ]);
  }

  function operationalColumnLinkSpecs_(row,operationalIndex){
    var out={orders:[],tasks:[]};
    var workOrders=relevantWorkOrders_(row,operationalIndex);
    if(workOrders.length){
      var wo=workOrders[0];
      var woId=clean_(wo['Work Order ID']||wo['Entity ID']);
      var woNumber=clean_(wo['Work Order Number']||woId);
      var woName=clean_(wo['Work Order Name']||wo['Description'])||'Sales Order';
      var woLine=[(woNumber?'#'+woNumber:''),woName].filter(Boolean).join(' - ');
      addLinkSpec_(out.orders,woLine,strivenUrl_('WORK_ORDER',{entityId:woId}),'',woLine);
    }else{
      var durable=durableSalesOrder_(row);
      if(durable.id||durable.number){
        var durableLine=[(durable.number?'#'+durable.number:''),durable.name].filter(Boolean).join(' - ');
        addLinkSpec_(out.orders,durableLine,durable.url||strivenUrl_('WORK_ORDER',{entityId:durable.id}),'',durableLine);
      }
    }
    var tasks=relevantTasks_(row,operationalIndex,workOrders);
    if(tasks.length){
      var task=tasks[0],taskId=clean_(task['Task ID']||task['Entity ID']);
      var taskName=clean_(task['Task Name']||task['Description'])||'Task';
      var taskLine=[(taskId?'#'+taskId:''),deps_().util.truncate(taskName,125)].filter(Boolean).join(' - ');
      addLinkSpec_(out.tasks,taskLine,strivenUrl_('TASK',{entityId:taskId}),'',taskLine);
    }else{
      var durableTask=durableTask_(row);
      if(durableTask.id){
        var durableTaskLine=[(durableTask.id?'#'+durableTask.id:''),deps_().util.truncate(durableTask.name,125)].filter(Boolean).join(' - ');
        addLinkSpec_(out.tasks,durableTaskLine,durableTask.url,'',durableTaskLine);
      }
    }
    return out;
  }

  function operationalStatusColor_(status) {
    var s = upper_(status);
    if (/COMPLETED|DONE|FULFILLED/.test(s)) return '#38761d';
    if (/IN PROGRESS|APPROVED/.test(s)) return '#1155cc';
    if (/QUOTED|PENDING|ON HOLD|INCOMPLETE/.test(s)) return '#b45f06';
    if (/DECLINED|CANCELLED|CANCELED|LOST|ERROR/.test(s)) return '#cc0000';
    if (/OPEN|SCHEDULED|ASSIGNED/.test(s)) return '#1155cc';
    return '#666666';
  }

  function styleOperationalCell_(range, linkSpecs, status) {
    var text = String(range.getDisplayValue() || '');
    if (!text || text === '—') return;
    var builder = SpreadsheetApp.newRichTextValue().setText(text);
    var firstLineEnd = text.indexOf('\n');
    if (firstLineEnd < 0) firstLineEnd = text.length;
    (linkSpecs || []).forEach(function (spec) {
      if (spec && spec.url && spec.text && text.indexOf(spec.text) === 0) {
        builder.setLinkUrl(0, Math.min(firstLineEnd, spec.text.length), spec.url);
      }
    });
    var secondStart = firstLineEnd < text.length ? firstLineEnd + 1 : -1;
    if (secondStart >= 0) {
      var secondEnd = text.indexOf('\n', secondStart);
      if (secondEnd < 0) secondEnd = text.length;
      if (secondEnd > secondStart) {
        var style = SpreadsheetApp.newTextStyle().setForegroundColor(operationalStatusColor_(status)).setBold(true).build();
        builder.setTextStyle(secondStart, secondEnd, style);
      }
    }
    range.setRichTextValue(builder.build());
  }

  function buildOperationalRichText_(text,linkSpecs,status){
    text=String(text||'');
    var builder=SpreadsheetApp.newRichTextValue().setText(text);
    if(!text||text==='—')return builder.build();
    var firstLineEnd=text.indexOf('\n');if(firstLineEnd<0)firstLineEnd=text.length;
    (linkSpecs||[]).forEach(function(spec){
      if(spec&&spec.url&&spec.text&&text.indexOf(spec.text)===0){
        builder.setLinkUrl(0,Math.min(firstLineEnd,spec.text.length),spec.url);
      }
    });
    var secondStart=firstLineEnd<text.length?firstLineEnd+1:-1;
    if(secondStart>=0){
      var secondEnd=text.indexOf('\n',secondStart);if(secondEnd<0)secondEnd=text.length;
      if(secondEnd>secondStart){
        builder.setTextStyle(secondStart,secondEnd,SpreadsheetApp.newTextStyle().setForegroundColor(operationalStatusColor_(status)).setBold(true).build());
      }
    }
    return builder.build();
  }
  function applyOperationalColumnLinks_(sheet,sourceRows,operationalIndex){
    var headers=deps_().util.getActualHeaders(sheet);
    var orderCol=headers.indexOf('Sales Order / Work Order')+1;
    var taskCol=headers.indexOf('Task')+1;
    var orderValues=[],taskValues=[];
    (sourceRows||[]).forEach(function(row){
      var specs=operationalColumnLinkSpecs_(row,operationalIndex);
      var workOrders=relevantWorkOrders_(row,operationalIndex);
      var tasks=relevantTasks_(row,operationalIndex,workOrders);
      var durable=durableSalesOrder_(row);
      var orderStatus=workOrders.length?clean_(workOrders[0]['Status']):durable.status;
      var taskStatus=tasks.length?clean_(tasks[0]['Status']):'';
      orderValues.push([buildOperationalRichText_(salesOrderText_(row,operationalIndex),specs.orders,orderStatus)]);
      taskValues.push([buildOperationalRichText_(taskText_(row,operationalIndex),specs.tasks,taskStatus)]);
    });
    if(orderCol&&orderValues.length)sheet.getRange(2,orderCol,orderValues.length,1).setRichTextValues(orderValues);
    if(taskCol&&taskValues.length)sheet.getRange(2,taskCol,taskValues.length,1).setRichTextValues(taskValues);
  }

  function queueRecord_(row, operationalIndex) {
    var d = deps_();
    var record = d.util.makeBlankRecord('OPERATOR_QUEUE');
    record['Request ID'] = row['Request ID'];
    record['Status'] = statusText_(row);
    record['Customer'] = customerText_(row);
    record['Service'] = serviceText_(row);
    record['Striven'] = strivenText_(row, operationalIndex);
    record['History'] = historyText_(row, operationalIndex);
    record['Next Step'] = row['Next Action'];
    record['Sales Order / Work Order'] = salesOrderText_(row, operationalIndex);
    record['Task'] = taskText_(row, operationalIndex);
    return record;
  }

  function queueSort_(a, b) {
    // GLOBAL_SUBMISSION_TIME_Z_TO_A
    var bValue = b['Submitted At'] || b['Created At'] || 0;
    var aValue = a['Submitted At'] || a['Created At'] || 0;
    var bTime = bValue instanceof Date ? bValue.getTime() : new Date(bValue).getTime();
    var aTime = aValue instanceof Date ? aValue.getTime() : new Date(aValue).getTime();

    if (!isFinite(bTime)) bTime = 0;
    if (!isFinite(aTime)) aTime = 0;
    if (bTime !== aTime) return bTime - aTime;

    return clean_(b['Request ID']).localeCompare(clean_(a['Request ID']));
  }

  function stageColor_(stage) {
    var value = upper_(stage);
    if (value === 'COMPLETED') return '#d9ead3';
    if (value === 'NEEDS REVIEW') return '#fff2cc';
    if (/^READY FOR /.test(value)) return '#fff2cc';
    if (value === 'APPROVED FOR CUSTOMER STRUCTURE' || value === 'CUSTOMER RESOLVED' || value === 'CUSTOMER STRUCTURE COMPLETE') return '#d9ead3';
    if (value === 'BLOCKED' || value === 'ERROR') return '#f4cccc';
    if (value === 'NEW INTAKE') return '#d9eaf7';
    return '#ffffff';
  }

  function resetQueuePresentation_(sheet) {
    var rows = Math.max(1, sheet.getMaxRows() - 1);
    var columns = Math.max(1, sheet.getMaxColumns());
    var body = sheet.getRange(2, 1, rows, columns);
    body.clearFormat();
    body.clearDataValidations();
    body.clearNote();
    sheet.setRowHeights(2, rows, 21);
    if (sheet.getFilter()) sheet.getFilter().remove();
  }

  function applyQueueFormatting_(sheet, sourceRows) {
    var d = deps_();
    var headers = d.config.getHeaders('OPERATOR_QUEUE');
    var rowCount = sourceRows.length;

    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(1);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setFontSize(10)
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle')
      .setBackground('#1f4e78')
      .setFontColor('#ffffff');
    sheet.setRowHeight(1, 32);

    if (rowCount > 0) {
      var body = sheet.getRange(2, 1, rowCount, headers.length);
      body.setVerticalAlignment('top').setWrap(true).setFontSize(10).setBackground('#ffffff');
      sheet.setRowHeights(2, rowCount, 108);

      var statusCol = headers.indexOf('Status') + 1;
      sourceRows.forEach(function (sourceRow, index) {
        sheet.getRange(index + 2, statusCol)
          .setBackground(stageColor_(sourceRow['Current Stage']))
          .setFontWeight('bold');
      });

      sheet.getRange(1, 1, rowCount + 1, headers.length).createFilter();
    }

    [175, 205, 310, 360, 280, 310, 235, 310, 330].forEach(function (width, index) {
      sheet.setColumnWidth(index + 1, width);
    });
  }

  function countBy_(rows, getter) {
    var counts = {};
    rows.forEach(function (row) {
      var key = clean_(getter(row));
      if (!key) return;
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.keys(counts).map(function (key) { return [key, counts[key]]; })
      .sort(function (a, b) { return b[1] - a[1] || String(a[0]).localeCompare(String(b[0])); });
  }

  function operationalScheduleIndex_(operationalRows) {
    var byId = {};
    var byNumber = {};
    (operationalRows || []).forEach(function (row) {
      var date = clean_(row['Scheduled Date']);
      if (!date) return;
      var id = clean_(row['Work Order ID'] || (upper_(row['Entity Type']) === 'WORK_ORDER' ? row['Entity ID'] : ''));
      var number = clean_(row['Work Order Number']);
      if (id && !byId[id]) byId[id] = date;
      if (number && !byNumber[number]) byNumber[number] = date;
    });
    return { byId: byId, byNumber: byNumber };
  }

  function scheduledDateForRequest_(row, scheduleIndex) {
    var activeWork = deps_().util.parseJson(row['Active Work JSON'], {});
    var direct = clean_(activeWork.scheduledDate || activeWork.scheduled_date || '');
    if (direct) return direct;
    var id = clean_(row['Work Order ID']);
    var number = clean_(row['Work Order Number']);
    if (id && scheduleIndex.byId[id]) return scheduleIndex.byId[id];
    if (number && scheduleIndex.byNumber[number]) return scheduleIndex.byNumber[number];
    return '';
  }

  function startOfCurrentWeek_() {
    var now = new Date();
    var day = now.getDay();
    var diff = day === 0 ? 6 : day - 1;
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff, 0, 0, 0, 0);
    return start.getTime();
  }

  function requestDateMs_(row) {
    var value = row['Submitted At'] || row['Created At'];
    var ms = value instanceof Date ? value.getTime() : new Date(value || 0).getTime();
    return isNaN(ms) ? 0 : ms;
  }

  function dashboardMetrics_(requests, operationalRows) {
    var d = deps_();
    var scheduleIndex = operationalScheduleIndex_(operationalRows);
    var activeRows = requests.filter(active_);
    var weekStart = startOfCurrentWeek_();
    var scheduled = 0;
    var toSchedule = 0;

    activeRows.forEach(function (row) {
      if (scheduledDateForRequest_(row, scheduleIndex)) scheduled++;
      else toSchedule++;
    });

    var completed = requests.filter(function (row) {
      return upper_(row['Current Stage']) === 'COMPLETED' || upper_(row['Final Outcome']) === 'COMPLETED' || !!clean_(row['Completed At']);
    }).length;
    var cancelledDuplicate = requests.filter(function (row) {
      var stage = upper_(row['Current Stage']);
      var outcome = upper_(row['Final Outcome']);
      return stage === 'CANCELLED' || stage === 'DUPLICATE' || outcome.indexOf('CANCEL') !== -1 || outcome.indexOf('DUPLICATE') !== -1;
    }).length;

    var allWorkOrders = (operationalRows || []).filter(function (row) {
      return upper_(row['Entity Type']) === 'WORK_ORDER';
    });
    var statusEligibleWorkOrders = allWorkOrders.filter(function (row) {
      return reportingWorkOrderStatus_(row['Status']);
    });
    var reportingWorkOrders = statusEligibleWorkOrders.filter(reportingWorkOrder_);
    var statusCounts = { APPROVED: 0, 'IN PROGRESS': 0, COMPLETED: 0 };
    reportingWorkOrders.forEach(function (row) {
      var status = upper_(row['Status']);
      if (statusCounts.hasOwnProperty(status)) statusCounts[status]++;
    });
    var workOrderStatusTable = [
      ['Total', reportingWorkOrders.length],
      ['Approved', statusCounts.APPROVED],
      ['In Progress', statusCounts['IN PROGRESS']],
      ['Completed', statusCounts.COMPLETED]
    ];

    return {
      total: requests.length,
      newThisWeek: requests.filter(function (row) { return requestDateMs_(row) >= weekStart; }).length,
      activeQueue: activeRows.length,
      needsReview: activeRows.filter(function (row) { return upper_(row['Current Stage']) === 'NEEDS REVIEW' || upper_(row['Manual Review?']) === 'YES'; }).length,
      scheduled: scheduled,
      toSchedule: toSchedule,
      completed: completed,
      cancelledDuplicate: cancelledDuplicate,
      cities: countBy_(requests, function (row) { return row['City']; }).slice(0, 10),
      campaigns: countBy_(requests, function (row) { return row['Campaign Code']; }).slice(0, 10),
      stages: countBy_(activeRows, function (row) { return row['Current Stage']; }).slice(0, 10),
      workOrdersSince20260701: reportingWorkOrders.length,
      workOrderStatusesSince20260701: {
        approved: statusCounts.APPROVED,
        inProgress: statusCounts['IN PROGRESS'],
        completed: statusCounts.COMPLETED
      },
      workOrdersMissingSalesOrderDate: statusEligibleWorkOrders.filter(function (row) { return !salesOrderDateMs_(row); }).length,
      workOrderStatusTable: workOrderStatusTable
    };
  }

  function writeTopTable_(sheet, startRow, startCol, title, rows, emptyText) {
    sheet.getRange(startRow, startCol, 1, 2).merge().setValue(title)
      .setFontWeight('bold').setBackground('#d9eaf7').setHorizontalAlignment('center');
    var target = sheet.getRange(startRow + 1, startCol, 10, 2);
    target.breakApart();
    target.clearContent().clearFormat();
    var values = (rows || []).slice(0, 10);
    while (values.length < 10) values.push(['', '']);
    target.setValues(values).setWrap(true).setVerticalAlignment('middle');
    if (!(rows || []).length && emptyText) sheet.getRange(startRow + 1, startCol, 1, 2).merge().setValue(emptyText).setFontStyle('italic');
  }

  function refreshDashboard_(operationalRows) {
    var d = deps_();
    var sheet = d.util.requireSheet('DASHBOARD');
    var requests = d.util.readRecords('SERVICE_REQUESTS');
    if (!operationalRows) {
      operationalRows = [];
      try { operationalRows = d.util.readRecords('STRIVEN_OPERATIONAL_DATA'); } catch (ignored) {}
    }
    var metrics = dashboardMetrics_(requests, operationalRows);

    sheet.getRange('A1:H40').breakApart();
    sheet.clear();

    sheet.getRange('A1:H1').merge().setValue('CF ServiceOps — Service Snapshot')
      .setFontWeight('bold').setFontSize(18).setHorizontalAlignment('center')
      .setBackground('#1f4e78').setFontColor('#ffffff');
    sheet.getRange('A2:H2').merge().setValue('Read-only management view · Refreshed ' + d.util.nowString())
      .setHorizontalAlignment('center').setFontColor('#666666');

    var kpis = [
      ['Total Requests', metrics.total],
      ['New This Week', metrics.newThisWeek],
      ['Active Queue', metrics.activeQueue],
      ['Needs Review', metrics.needsReview],
      ['Scheduled', metrics.scheduled],
      ['To Be Scheduled', metrics.toSchedule],
      ['Completed', metrics.completed],
      ['Cancelled / Duplicate', metrics.cancelledDuplicate]
    ];

    kpis.forEach(function (item, index) {
      var row = 4 + Math.floor(index / 4) * 3;
      var col = 1 + (index % 4) * 2;
      sheet.getRange(row, col, 1, 2).merge().setValue(item[0])
        .setFontWeight('bold').setHorizontalAlignment('center').setBackground('#eaf2f8');
      sheet.getRange(row + 1, col, 1, 2).merge().setValue(item[1])
        .setFontWeight('bold').setFontSize(16).setHorizontalAlignment('center');
    });

    writeTopTable_(sheet, 11, 1, 'Top 10 Cities — Requests', metrics.cities, 'No city data yet.');
    writeTopTable_(sheet, 11, 4, 'Service Work Orders — Since Jul 1, 2026', metrics.workOrderStatusTable, 'No qualifying Service Work Orders found.');
    writeTopTable_(sheet, 24, 1, 'Top Campaigns — Requests', metrics.campaigns, 'No campaign data yet.');
    writeTopTable_(sheet, 24, 4, 'Active Workflow', metrics.stages, 'No active requests.');

    sheet.getRange('G11:H20').merge().setValue(
      'Definitions\n\n' +
      'Scheduled = active Service Request linked to a scheduled date in Active Work JSON or the Striven operational cache.\n\n' +
      'To Be Scheduled = active Service Request with no linked scheduled date.\n\n' +
      'Service Work Orders = Striven WORK_ORDER records with Sales Order Date on/after Jul 1, 2026 and Status Approved, In Progress, or Completed. Created At is not used for this count.'
    ).setWrap(true).setVerticalAlignment('top').setBackground('#fffdf2');

    sheet.getRange('G24:H33').merge().setValue(
      'Operator processing belongs in 03 Operator Queue.\n\n' +
      '01 Webform Requests, 02 Service Requests and all Striven/cache/log sheets are backend technical ledgers and remain hidden during normal operation.'
    ).setWrap(true).setVerticalAlignment('top').setBackground('#f3f3f3');

    [150, 95, 28, 180, 95, 28, 190, 190].forEach(function (width, index) { sheet.setColumnWidth(index + 1, width); });
    sheet.setFrozenRows(2);
    sheet.setRowHeight(1, 34);
    return metrics;
  }

  function refresh() {
    var d = deps_();
    // CF ServiceOps v5.11.4 R2 — Operator Queue retains completed requests for tracking
    // Tracking view: keep every Service Request visible; active_ is retained only for active-count metrics.
    var rows = d.util.readRecords('SERVICE_REQUESTS').sort(queueSort_);
    var activeRequestCount = rows.filter(active_).length;
    var operationalRows = [];
    try { operationalRows = d.util.readRecords('STRIVEN_OPERATIONAL_DATA'); } catch (ignored) {}
    var operationalIndex = buildOperationalLinkIndex_(operationalRows);
    var records = rows.map(function (row) { return queueRecord_(row, operationalIndex); });
    var queueSheet = d.util.requireSheet('OPERATOR_QUEUE');

    resetQueuePresentation_(queueSheet);
    var write = d.util.replaceSheetData('OPERATOR_QUEUE', records);
    applyQueueFormatting_(queueSheet, rows);
    applyStrivenHyperlinks_(queueSheet, rows, operationalIndex);
    applyOperationalColumnLinks_(queueSheet, rows, operationalIndex);
    var dashboard = refreshDashboard_(operationalRows);

    return {
      ok: true,
      version: VERSION,
      activeRequests: activeRequestCount,
      trackedRequests: records.length,
      queueColumns: d.config.getHeaders('OPERATOR_QUEUE').length,
      write: write,
      dashboard: dashboard,
      visibleSheets: d.config.getVisibleSheetNames(),
      liveWritesAllowed: false
    };
  }

  function findEntityById_(sheetKey, idHeader, id, entityType) {
    var d = deps_();
    var target = clean_(id);
    if (!target) return null;
    var sheet = d.util.requireSheet(sheetKey);
    var headers = d.util.getActualHeaders(sheet);
    var idColumn = headers.indexOf(idHeader) + 1;
    if (!idColumn || sheet.getLastRow() < 2) return null;
    var matches = sheet.getRange(2, idColumn, sheet.getLastRow() - 1, 1)
      .createTextFinder(target).matchEntireCell(true).findAll();
    for (var i = 0; i < matches.length; i++) {
      var rowNumber = matches[i].getRow();
      var values = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
      var record = d.util.rowToRecord(headers, values);
      record.__rowNumber = rowNumber;
      if (!entityType || upper_(record['Entity Type']) === entityType) return record;
    }
    return null;
  }

  function customerById_(id) { return findEntityById_('STRIVEN_CUSTOMER_DATA', 'Entity ID', id, 'CUSTOMER'); }
  function contactById_(id) { return findEntityById_('STRIVEN_CUSTOMER_DATA', 'Entity ID', id, 'CONTACT'); }
  function locationById_(id) { return findEntityById_('STRIVEN_LOCATION_DATA', 'Location ID', id, ''); }

  function clearApprovalPatch_() {
    return {
      'Approved By': '',
      'Approved At': '',
      'Approval Fingerprint': '',
      'Customer Structure Status': 'NOT STARTED',
      'Striven Sync Status': 'NOT SYNCED'
    };
  }

  function mergePatch_(target, source) {
    Object.keys(source || {}).forEach(function (key) { target[key] = source[key]; });
    return target;
  }

  function resolvedCustomerIdFrom_(record, patch) {
    return clean_(patch['Matched Customer ID'] !== undefined ? patch['Matched Customer ID'] : (record['Matched Customer ID'] || record['Created Customer ID']));
  }

  function stageFromResolution_(record, patch) {
    var customerAction = upper_(patch['Customer Action'] !== undefined ? patch['Customer Action'] : record['Customer Action']);
    var contactAction = upper_(patch['Contact Action'] !== undefined ? patch['Contact Action'] : record['Contact Action']);
    var locationAction = upper_(patch['Location Action'] !== undefined ? patch['Location Action'] : record['Location Action']);
    var customerId = clean_(patch['Matched Customer ID'] !== undefined ? patch['Matched Customer ID'] : record['Matched Customer ID']);
    var contactId = clean_(patch['Matched Contact ID'] !== undefined ? patch['Matched Contact ID'] : record['Matched Contact ID']);
    var locationId = clean_(patch['Matched Location ID'] !== undefined ? patch['Matched Location ID'] : record['Matched Location ID']);

    var customerReady = customerAction === 'CREATE' || (customerAction === 'LINK EXISTING' && customerId);
    var contactReady = contactAction === 'CREATE' || (contactAction === 'LINK EXISTING' && contactId);
    var locationReady = locationAction === 'CREATE' || (locationAction === 'LINK EXISTING' && locationId);

    if (!customerReady || !contactReady || !locationReady) return 'NEEDS REVIEW';
    if (customerAction === 'CREATE') return 'READY FOR CUSTOMER CREATE';
    if (contactAction === 'CREATE') return 'READY FOR CONTACT CREATE';
    if (locationAction === 'CREATE') return 'READY FOR LOCATION CREATE';
    return 'CUSTOMER RESOLVED';
  }

  function nextActionForStage_(stage) {
    if (stage === 'NEEDS REVIEW') return 'RESOLVE MATCHES IN OPERATOR QUEUE';
    if (stage === 'READY FOR CUSTOMER CREATE' || stage === 'READY FOR CONTACT CREATE' || stage === 'READY FOR LOCATION CREATE' || stage === 'CUSTOMER RESOLVED') return 'PREVIEW AND APPROVE PROPOSED ACTION';
    if (stage === 'APPROVED FOR CUSTOMER STRUCTURE') return 'PHASE 5B EXECUTION IS DISABLED';
    return '';
  }

  function applyOperatorDecision(requestId, decision) {
    decision = decision || {};
    var d = deps_();
    var record = d.util.findRecord('SERVICE_REQUESTS', 'Request ID', requestId);
    if (!record) throw new Error('Service Request not found: ' + requestId);
    if (d.config.isTerminalState(record['Current Stage']) || d.config.isTerminalState(record['Final Outcome'])) {
      throw new Error('Terminal requests cannot be changed.');
    }

    var action = upper_(decision.action || record['Operator Action']);
    if (!action) throw new Error('Select an Operator Action.');
    var operator = actor_(decision.actor);
    var now = d.util.nowString();
    var patch = {
      'Operator Action': action,
      'Operator Notes': decision.notes !== undefined ? decision.notes : record['Operator Notes'],
      'Updated At': now
    };
    mergePatch_(patch, clearApprovalPatch_());

    var selectedCustomerId = clean_(decision.customerId || record['Matched Customer ID'] || record['Created Customer ID']);
    var selectedContactId = clean_(decision.contactId || record['Matched Contact ID'] || record['Created Contact ID']);
    var selectedLocationId = clean_(decision.locationId || record['Matched Location ID'] || record['Created Location ID']);

    if (action === 'LINK EXISTING CUSTOMER') {
      if (!selectedCustomerId) throw new Error('Selected Customer ID is required.');
      var customer = customerById_(selectedCustomerId);
      if (!customer) throw new Error('Customer ID was not found in the fresh Striven Customer cache: ' + selectedCustomerId);
      var customerChanged = clean_(record['Matched Customer ID']) && clean_(record['Matched Customer ID']) !== selectedCustomerId;
      patch['Matched Customer ID'] = selectedCustomerId;
      patch['Matched Customer Name'] = customer['Customer Name'] || customer['Full Name'] || '';
      patch['Customer Match Status'] = 'MATCHED';
      patch['Customer Action'] = 'LINK EXISTING';
      if (customerChanged) {
        patch['Matched Contact ID'] = '';
        patch['Matched Contact Name'] = '';
        patch['Contact Match Status'] = 'NOT CHECKED';
        patch['Contact Action'] = 'REVIEW';
        patch['Matched Location ID'] = '';
        patch['Matched Location Address'] = '';
        patch['Location Match Status'] = 'NOT CHECKED';
        patch['Location Action'] = 'REVIEW';
      }
    } else if (action === 'LINK EXISTING CONTACT') {
      if (!selectedContactId) throw new Error('Selected Contact ID is required.');
      var contact = contactById_(selectedContactId);
      if (!contact) throw new Error('Contact ID was not found in the fresh Striven Contact cache: ' + selectedContactId);
      var resolvedCustomerId = selectedCustomerId || clean_(record['Matched Customer ID'] || record['Created Customer ID']);
      if (!resolvedCustomerId) throw new Error('Resolve the Customer before linking a Contact.');
      if (clean_(contact['Customer ID']) && clean_(contact['Customer ID']) !== resolvedCustomerId) {
        throw new Error('Contact ' + selectedContactId + ' belongs to Customer ' + contact['Customer ID'] + ', not Customer ' + resolvedCustomerId + '.');
      }
      patch['Matched Contact ID'] = selectedContactId;
      patch['Matched Contact Name'] = contact['Full Name'] || '';
      patch['Contact Match Status'] = 'MATCHED';
      patch['Contact Action'] = 'LINK EXISTING';
    } else if (action === 'LINK EXISTING LOCATION') {
      if (!selectedLocationId) throw new Error('Selected Location ID is required.');
      var location = locationById_(selectedLocationId);
      if (!location) throw new Error('Location ID was not found in the fresh Striven Location cache: ' + selectedLocationId);
      var customerIdForLocation = selectedCustomerId || clean_(record['Matched Customer ID'] || record['Created Customer ID']);
      if (!customerIdForLocation) throw new Error('Resolve the Customer before linking a Location.');
      if (clean_(location['Customer ID']) && clean_(location['Customer ID']) !== customerIdForLocation) {
        throw new Error('Location ' + selectedLocationId + ' belongs to Customer ' + location['Customer ID'] + ', not Customer ' + customerIdForLocation + '.');
      }
      patch['Matched Location ID'] = selectedLocationId;
      patch['Matched Location Address'] = location['Full Address'] || '';
      patch['Location Match Status'] = 'MATCHED';
      patch['Location Action'] = 'LINK EXISTING';
    } else if (action === 'CREATE CUSTOMER') {
      patch['Matched Customer ID'] = '';
      patch['Matched Customer Name'] = '';
      patch['Customer Match Status'] = 'NOT FOUND';
      patch['Customer Action'] = 'CREATE';
      patch['Matched Contact ID'] = '';
      patch['Matched Contact Name'] = '';
      patch['Contact Match Status'] = 'NOT FOUND';
      patch['Contact Action'] = 'CREATE';
      patch['Matched Location ID'] = '';
      patch['Matched Location Address'] = '';
      patch['Location Match Status'] = 'NOT FOUND';
      patch['Location Action'] = 'CREATE';
    } else if (action === 'CREATE CONTACT') {
      if (!resolvedCustomerIdFrom_(record, patch) && upper_(record['Customer Action']) !== 'CREATE') throw new Error('Resolve or create the Customer before creating a Contact.');
      patch['Matched Contact ID'] = '';
      patch['Matched Contact Name'] = '';
      patch['Contact Match Status'] = 'NOT FOUND';
      patch['Contact Action'] = 'CREATE';
    } else if (action === 'CREATE LOCATION') {
      if (!resolvedCustomerIdFrom_(record, patch) && upper_(record['Customer Action']) !== 'CREATE') throw new Error('Resolve or create the Customer before creating a Location.');
      patch['Matched Location ID'] = '';
      patch['Matched Location Address'] = '';
      patch['Location Match Status'] = 'NOT FOUND';
      patch['Location Action'] = 'CREATE';
    } else if (action === 'REQUEST INFORMATION') {
      patch['Current Stage'] = 'NEEDS REVIEW';
      patch['Request Status'] = 'BLOCKED';
      patch['Manual Review?'] = 'YES';
      patch['Manual Review Reason'] = clean_(decision.notes) || 'Additional information requested by operator.';
      patch['Blocking Issue'] = patch['Manual Review Reason'];
      patch['Next Action'] = 'REQUEST INFORMATION FROM CUSTOMER';
    } else if (action === 'MARK DUPLICATE') {
      patch['Current Stage'] = 'DUPLICATE';
      patch['Request Status'] = 'DUPLICATE';
      patch['Manual Review?'] = 'NO';
      patch['Manual Review Reason'] = '';
      patch['Blocking Issue'] = '';
      patch['Next Action'] = 'NONE';
      patch['Final Outcome'] = 'DUPLICATE_REQUEST';
      patch['Completed At'] = now;
    } else if (action === 'CANCEL') {
      patch['Current Stage'] = 'CANCELLED';
      patch['Request Status'] = 'CANCELLED';
      patch['Manual Review?'] = 'NO';
      patch['Manual Review Reason'] = '';
      patch['Blocking Issue'] = '';
      patch['Next Action'] = 'NONE';
      patch['Final Outcome'] = 'CANCELLED';
      patch['Completed At'] = now;
    } else if (action !== 'APPROVE PROPOSED ACTION') {
      throw new Error('Unsupported Operator Action: ' + action);
    }

    if (['REQUEST INFORMATION','MARK DUPLICATE','CANCEL','APPROVE PROPOSED ACTION'].indexOf(action) === -1) {
      var stage = stageFromResolution_(record, patch);
      patch['Current Stage'] = stage;
      patch['Request Status'] = stage === 'NEEDS REVIEW' ? 'BLOCKED' : 'OPEN';
      patch['Manual Review?'] = stage === 'NEEDS REVIEW' ? 'YES' : 'NO';
      patch['Manual Review Reason'] = stage === 'NEEDS REVIEW' ? 'One or more Customer, Contact, or Location resolutions are incomplete.' : '';
      patch['Blocking Issue'] = patch['Manual Review Reason'];
      patch['Next Action'] = nextActionForStage_(stage);
    }

    if (typeof d.util.clearRowDataValidations === 'function') d.util.clearRowDataValidations('SERVICE_REQUESTS', record.__rowNumber);
    d.util.patchRow('SERVICE_REQUESTS', record.__rowNumber, patch);

    var result;
    if (action === 'APPROVE PROPOSED ACTION') {
      if (!CF.StrivenWrite || typeof CF.StrivenWrite.approveRequest !== 'function') throw new Error('CF.StrivenWrite approval module is required.');
      result = CF.StrivenWrite.approveRequest(record['Request ID'], operator);
    } else if (!d.config.isTerminalState(patch['Current Stage'] || record['Current Stage'])) {
      if (!CF.StrivenWrite || typeof CF.StrivenWrite.previewRequest !== 'function') throw new Error('CF.StrivenWrite preview module is required.');
      result = CF.StrivenWrite.previewRequest(record['Request ID'], { persist: true });
    } else {
      result = { ok: true, requestId: record['Request ID'], status: patch['Current Stage'], liveWritesAllowed: false };
    }

    d.util.logEvent({
      module: MODULE_NAME,
      action: 'APPLY_OPERATOR_DECISION',
      status: action,
      requestId: record['Request ID'],
      correlationId: record['Correlation ID'],
      actor: operator,
      details: {
        selectedCustomerId: selectedCustomerId,
        selectedContactId: selectedContactId,
        selectedLocationId: selectedLocationId,
        stage: patch['Current Stage'] || record['Current Stage'],
        liveWritesAllowed: false
      },
      version: VERSION
    });

    refresh();
    return { ok: true, version: VERSION, requestId: record['Request ID'], action: action, result: result, liveWritesAllowed: false };
  }

  function isChecked_(value) { return value === true || upper_(value) === 'TRUE'; }

  function toast_(message, title) {
    try { deps_().util.getSpreadsheet().toast(message, title || 'CF ServiceOps', 8); } catch (ignored) {}
  }

  function withActionLock_(callback) {
    var lock = LockService.getDocumentLock();
    if (!lock.tryLock(5000)) throw new Error('Another operator action is already running. Wait a moment and try again.');
    try { return callback(); } finally { lock.releaseLock(); }
  }

  // CF ServiceOps v5.11.8 R1 — simple-trigger-safe fast candidate resolution
  function fastResolveCandidate_(requestId, entityType, entityId) {
    var d = deps_();
    entityType = clean_(entityType).toLowerCase();
    entityId = clean_(entityId);
    if (['customer','contact','location'].indexOf(entityType) === -1) throw new Error('Unsupported candidate entity: ' + entityType);
    if (!entityId) throw new Error('Candidate ID is required.');

    // A simple onEdit trigger has a ~30 second ceiling. Fail quickly on lock contention
    // and do only targeted identity validation + one Service Request patch here.
    return d.util.withScriptLock(function () {
      var record = d.util.findRecord('SERVICE_REQUESTS', 'Request ID', requestId);
      if (!record) throw new Error('Service Request not found: ' + requestId);
      if (d.config.isTerminalState(record['Current Stage']) || d.config.isTerminalState(record['Final Outcome'])) throw new Error('Terminal requests cannot be changed.');

      var statusField = entityType === 'customer' ? 'Customer Match Status' : (entityType === 'contact' ? 'Contact Match Status' : 'Location Match Status');
      if (upper_(record[statusField]) !== 'AMBIGUOUS') throw new Error('The ' + entityType + ' is no longer ambiguous. Refresh the Operator Queue.');
      var allowedIds = candidateIdsFromEvidence_(record, entityType);
      if (allowedIds.indexOf(entityId) === -1) throw new Error('Candidate ' + entityId + ' is not one of the current ' + entityType + ' candidates.');

      var patch = { 'Updated At': d.util.nowString(), 'Operator Action': '' };
      mergePatch_(patch, clearApprovalPatch_());
      var evidence = d.util.parseJson(record['Match Evidence JSON'], {}) || {};
      var selections = evidence.manualSelections || {};
      var resolvedName = '';

      if (entityType === 'customer') {
        var customer = customerById_(entityId);
        if (!customer) throw new Error('Customer ID was not found in the fresh Striven Customer cache: ' + entityId);
        var customerChanged = clean_(record['Matched Customer ID']) && clean_(record['Matched Customer ID']) !== entityId;
        patch['Matched Customer ID'] = entityId;
        patch['Matched Customer Name'] = customer['Customer Name'] || customer['Full Name'] || '';
        patch['Customer Match Status'] = 'MATCHED';
        patch['Customer Action'] = 'LINK EXISTING';
        resolvedName = patch['Matched Customer Name'];
        if (customerChanged) {
          patch['Matched Contact ID'] = ''; patch['Matched Contact Name'] = ''; patch['Contact Match Status'] = 'NOT CHECKED'; patch['Contact Action'] = 'REVIEW';
          patch['Matched Location ID'] = ''; patch['Matched Location Address'] = ''; patch['Location Match Status'] = 'NOT CHECKED'; patch['Location Action'] = 'REVIEW';
          selections.contactId = ''; selections.locationId = '';
        }
        selections.customerId = entityId;
      } else if (entityType === 'contact') {
        var contact = contactById_(entityId);
        if (!contact) throw new Error('Contact ID was not found in the fresh Striven Contact cache: ' + entityId);
        var resolvedCustomerId = resolvedCustomerIdFrom_(record, patch);
        if (!resolvedCustomerId) throw new Error('Resolve the Customer before linking a Contact.');
        if (clean_(contact['Customer ID']) && clean_(contact['Customer ID']) !== resolvedCustomerId) throw new Error('Contact ' + entityId + ' belongs to Customer ' + contact['Customer ID'] + ', not Customer ' + resolvedCustomerId + '.');
        patch['Matched Contact ID'] = entityId;
        patch['Matched Contact Name'] = contact['Full Name'] || '';
        patch['Contact Match Status'] = 'MATCHED';
        patch['Contact Action'] = 'LINK EXISTING';
        resolvedName = patch['Matched Contact Name'];
        selections.contactId = entityId;
      } else {
        var location = locationById_(entityId);
        if (!location) throw new Error('Location ID was not found in the fresh Striven Location cache: ' + entityId);
        var customerIdForLocation = resolvedCustomerIdFrom_(record, patch);
        if (!customerIdForLocation) throw new Error('Resolve the Customer before linking a Location.');
        if (clean_(location['Customer ID']) && clean_(location['Customer ID']) !== customerIdForLocation) throw new Error('Location ' + entityId + ' belongs to Customer ' + location['Customer ID'] + ', not Customer ' + customerIdForLocation + '.');
        patch['Matched Location ID'] = entityId;
        patch['Matched Location Address'] = location['Full Address'] || '';
        patch['Location Match Status'] = 'MATCHED';
        patch['Location Action'] = 'LINK EXISTING';
        resolvedName = patch['Matched Location Address'];
        selections.locationId = entityId;
      }

      evidence.manualSelections = selections;
      patch['Match Evidence JSON'] = evidence;
      var stage = stageFromResolution_(record, patch);
      patch['Current Stage'] = stage;
      patch['Request Status'] = stage === 'NEEDS REVIEW' ? 'BLOCKED' : 'OPEN';
      patch['Manual Review?'] = stage === 'NEEDS REVIEW' ? 'YES' : 'NO';
      patch['Manual Review Reason'] = stage === 'NEEDS REVIEW' ? 'One or more Customer, Contact, or Location resolutions are incomplete.' : '';
      patch['Blocking Issue'] = patch['Manual Review Reason'];
      patch['Next Action'] = nextActionForStage_(stage);
      d.util.patchRow('SERVICE_REQUESTS', record.__rowNumber, patch);

      d.util.logEvent({
        module: MODULE_NAME, action: 'FAST_RESOLVE_AMBIGUOUS_CANDIDATE', status: 'COMPLETE',
        requestId: record['Request ID'], correlationId: record['Correlation ID'], actor: actor_(),
        details: { entityType: entityType, entityId: entityId, resolvedName: resolvedName, resultingStage: stage, queueRefreshDeferred: true, simpleTriggerSafe: true },
        version: '5.11.8'
      });
      return { ok: true, version: '5.11.8', requestId: record['Request ID'], selectedEntity: entityType.toUpperCase(), selectedId: entityId, stage: stage, queueRefreshDeferred: true, liveWritesAllowed: false };
    }, 3000);
  }

  function resolveCandidateChoice_(requestId, entityType, entityId) {
    var result = fastResolveCandidate_(requestId, entityType, entityId);
    toast_('Resolved ' + entityType + ' ' + entityId + ' → ' + (result.stage || 'updated') + '. Queue snapshot will refresh automatically.', 'Striven candidate selected');
    return result;
  }

  function runQueueAction_(sheet, rowNumber, headers) {
    var d = deps_();
    var requestCol = headers.indexOf('Request ID') + 1;
    var actionCol = headers.indexOf('Operator Action') + 1;
    var runCol = headers.indexOf('Run') + 1;
    var notesCol = headers.indexOf('Operator Notes') + 1;
    var runRange = sheet.getRange(rowNumber, runCol);
    runRange.setValue(false);

    var requestId = clean_(sheet.getRange(rowNumber, requestCol).getValue());
    var action = upper_(sheet.getRange(rowNumber, actionCol).getValue());
    var notes = notesCol ? sheet.getRange(rowNumber, notesCol).getValue() : '';
    if (!requestId) throw new Error('The selected queue row has no Request ID.');
    if (!action) throw new Error('Select an Operator Action before checking Run.');
    if (parseCandidateChoice_(action)) throw new Error('Candidate choices resolve immediately; do not use Run.');

    return withActionLock_(function () {
      return applyOperatorDecision(requestId, { action: action, notes: notes });
    });
  }

  function selectedRequestId_() {
    var d = deps_();
    var sheet = d.util.getSpreadsheet().getActiveSheet();
    if (!sheet || sheet.getName() !== d.config.getSheetName('OPERATOR_QUEUE')) {
      throw new Error('Select a request row in ' + d.config.getSheetName('OPERATOR_QUEUE') + '.');
    }
    var row = sheet.getActiveRange().getRow();
    if (row < 2) throw new Error('Select a request row first.');
    var headers = d.util.getActualHeaders(sheet);
    var requestCol = headers.indexOf('Request ID') + 1;
    if (!requestCol) throw new Error('Operator Queue does not contain Request ID.');
    var requestId = clean_(sheet.getRange(row, requestCol).getValue());
    if (!requestId) throw new Error('The selected row has no Request ID.');
    return requestId;
  }

  function openRequest(requestId, options) {
    options = options || {};
    var d = deps_();
    var queue = d.util.requireSheet('OPERATOR_QUEUE');
    var headers = d.util.getActualHeaders(queue);
    var requestCol = headers.indexOf('Request ID') + 1;
    if (!requestCol) throw new Error('Operator Queue does not contain Request ID.');

    var match = null;
    if (queue.getLastRow() >= 2) {
      match = queue.getRange(2, requestCol, queue.getLastRow() - 1, 1)
        .createTextFinder(clean_(requestId)).matchEntireCell(true).findNext();
    }
    if (!match) {
      refresh();
      queue = d.util.requireSheet('OPERATOR_QUEUE');
      if (queue.getLastRow() >= 2) {
        match = queue.getRange(2, requestCol, queue.getLastRow() - 1, 1)
          .createTextFinder(clean_(requestId)).matchEntireCell(true).findNext();
      }
    }
    if (!match) throw new Error('Active request is not present in Operator Queue: ' + requestId);
    if (options.activate !== false) {
      d.util.getSpreadsheet().setActiveSheet(queue);
      queue.setActiveRange(queue.getRange(match.getRow(), 1, 1, headers.length));
    }
    var record = d.util.findRecord('SERVICE_REQUESTS', 'Request ID', requestId);
    return {
      ok: true,
      version: VERSION,
      requestId: requestId,
      stage: record ? record['Current Stage'] : '',
      nextStep: record ? record['Next Action'] : '',
      workspace: d.config.getSheetName('OPERATOR_QUEUE')
    };
  }

  function openSelectedRequest() { return openRequest(selectedRequestId_(), { activate: true }); }

  function saveDashboardDecision() {
    return {
      ok: false,
      version: VERSION,
      status: 'DASHBOARD_READ_ONLY',
      message: 'Dashboard is a read-only service snapshot. Process requests in Operator Queue.'
    };
  }

  function onEdit(event) {
    var d = deps_();
    if (!event || !event.range || event.range.getNumRows() !== 1 || event.range.getNumColumns() !== 1) return;
    var sheet = event.range.getSheet();
    if (sheet.getName() !== d.config.getSheetName('OPERATOR_QUEUE') || event.range.getRow() < 2) return;

    var headers = d.util.getActualHeaders(sheet);
    var header = headers[event.range.getColumn() - 1];
    var requestCol = headers.indexOf('Request ID') + 1;
    var requestId = requestCol ? clean_(sheet.getRange(event.range.getRow(), requestCol).getValue()) : '';
    if (!requestId) return;

    try {
      if (header === 'Run') {
        if (isChecked_(event.value !== undefined ? event.value : event.range.getValue())) runQueueAction_(sheet, event.range.getRow(), headers);
        return;
      }

      if (header === 'Operator Notes') {
        var request = d.util.findRecord('SERVICE_REQUESTS', 'Request ID', requestId);
        if (!request) throw new Error('Request not found: ' + requestId);
        d.util.patchRow('SERVICE_REQUESTS', request.__rowNumber, {
          'Operator Notes': event.range.getValue(),
          'Updated At': d.util.nowString()
        });
        d.util.logEvent({ module: MODULE_NAME, action: 'QUEUE_NOTE', status: 'UPDATED', requestId: requestId, actor: actor_(), version: VERSION });
        return;
      }

      if (header === 'Operator Action') {
        var rawSelection = clean_(event.range.getValue());
        var candidate = parseCandidateChoice_(rawSelection);
        if (candidate) {
          resolveCandidateChoice_(requestId, candidate.entityType, candidate.entityId);
          return;
        }
        var selectedAction = upper_(rawSelection);
        var actionRequest = d.util.findRecord('SERVICE_REQUESTS', 'Request ID', requestId);
        if (!actionRequest) throw new Error('Request not found: ' + requestId);
        d.util.patchRow('SERVICE_REQUESTS', actionRequest.__rowNumber, {
          'Operator Action': selectedAction,
          'Updated At': d.util.nowString()
        });
        d.util.logEvent({ module: MODULE_NAME, action: 'QUEUE_ACTION_SELECTED', status: selectedAction || 'CLEARED', requestId: requestId, actor: actor_(), version: VERSION });
      }
    } catch (error) {
      d.util.logEvent({ severity: 'ERROR', module: MODULE_NAME, action: 'QUEUE_EDIT', status: 'BLOCKED', requestId: requestId, actor: actor_(), message: error.message || String(error), version: VERSION });
      toast_(error.message || String(error), 'Action blocked');
      var runCol = headers.indexOf('Run') + 1;
      if (runCol) sheet.getRange(event.range.getRow(), runCol).setValue(false);
    }
  }

  function repairServiceRequestValidations() {
    var d = deps_();
    var result = typeof d.util.clearSheetDataValidations === 'function'
      ? d.util.clearSheetDataValidations('SERVICE_REQUESTS')
      : { rows: 0, columns: 0, cells: 0 };
    d.util.logEvent({ module: MODULE_NAME, action: 'REPAIR_TECHNICAL_VALIDATIONS', status: 'COMPLETE', actor: actor_(), details: result, version: VERSION });
    return {
      ok: true,
      version: VERSION,
      sheet: d.config.getSheetName('SERVICE_REQUESTS'),
      validationsCleared: result,
      operatorWorkspace: d.config.getSheetName('OPERATOR_QUEUE'),
      dashboardReadOnly: true
    };
  }

  return {
    version: VERSION,
    refresh: refresh,
    refreshDashboard: refreshDashboard_,
    openRequest: openRequest,
    openSelectedRequest: openSelectedRequest,
    saveDashboardDecision: saveDashboardDecision,
    repairServiceRequestValidations: repairServiceRequestValidations,
    applyOperatorDecision: applyOperatorDecision,
    selectedRequestId: selectedRequestId_,
    onEdit: onEdit
  };
})();

/************************************************************
 * CF_SERVICEOPS_V5_10_0_OPERATIONAL_PROJECTION_R6
 *
 * READ-ONLY operational projection installed around the
 * existing CF.OperatorQueue.refresh export.
 *
 * PURPOSE
 * - Populate 03 Operator Queue Work Order / Task columns
 *   directly from 06 Striven Operational Data.
 * - Recalculate Dashboard Service Work Orders since Jul 1,
 *   2026 using Sales Order Date when available and Created At
 *   only as a fallback when the report leaves Sales Order Date
 *   blank.
 *
 * SAFETY
 * - No Striven API write.
 * - No change to CF.StrivenWrite.
 * - No new public runner.
 * - Does not depend on OperatorQueue.refresh internals.
 ************************************************************/
var CF_SERVICEOPS_OPERATIONAL_PROJECTION_V5100_R6_ = (function () {
  'use strict';

  var CUTOFF_MS = new Date(2026, 6, 1, 0, 0, 0, 0).getTime();
  var DAY_MS = 24 * 60 * 60 * 1000;

  function clean_(value) {
    return String(value === null || value === undefined ? '' : value).trim();
  }

  function upper_(value) {
    return clean_(value).toUpperCase();
  }

  function dateMs_(value) {
    if (value instanceof Date && !isNaN(value.getTime())) return value.getTime();
    var text = clean_(value);
    if (!text) return 0;
    var parsed = new Date(text);
    if (!isNaN(parsed.getTime())) return parsed.getTime();
    var match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?$/i);
    if (!match) return 0;
    var hour = Number(match[4] || 0);
    var minute = Number(match[5] || 0);
    var ap = upper_(match[6]);
    if (ap === 'PM' && hour < 12) hour += 12;
    if (ap === 'AM' && hour === 12) hour = 0;
    return new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2]), hour, minute, 0, 0).getTime();
  }

  function formatDate_(value) {
    var ms = dateMs_(value);
    if (!ms) return clean_(value);
    try {
      return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone() || 'America/Toronto', 'MMM d, yyyy');
    } catch (ignored) {
      return clean_(value);
    }
  }

  function truncate_(value, maxLength) {
    var text = clean_(value);
    var limit = Number(maxLength || 80);
    return text.length <= limit ? text : text.substring(0, Math.max(0, limit - 1)) + '…';
  }

  function normalizeAddress_(value) {
    if (typeof CF !== 'undefined' && CF.Util && typeof CF.Util.normalizeAddress === 'function') {
      try { return clean_(CF.Util.normalizeAddress(value)); } catch (ignored) {}
    }
    return upper_(value)
      .replace(/\bSTREET\b/g, 'ST')
      .replace(/\bROAD\b/g, 'RD')
      .replace(/\bAVENUE\b/g, 'AVE')
      .replace(/\bCOURT\b/g, 'CT')
      .replace(/\bCRESCENT\b/g, 'CRES')
      .replace(/[^A-Z0-9]/g, '');
  }

  function safeJson_(value) {
    var text = clean_(value);
    if (!text) return null;
    try { return JSON.parse(text); } catch (ignored) { return null; }
  }

  function headerMap_(sheet) {
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    var map = {};
    headers.forEach(function (header, index) {
      var key = clean_(header);
      if (key) map[key] = index + 1;
    });
    return map;
  }

  function workStatusRank_(value) {
    var status = upper_(value);
    if (status === 'IN PROGRESS') return 0;
    if (status === 'APPROVED') return 1;
    if (status === 'QUOTED' || status === 'PENDING APPROVAL') return 2;
    if (status === 'COMPLETED') return 3;
    return 8;
  }

  function taskStatusRank_(value) {
    var status = upper_(value);
    if (status === 'OPEN' || status === 'IN PROGRESS') return 0;
    if (status === 'SCHEDULED') return 1;
    if (status === 'DONE' || status === 'COMPLETED') return 3;
    return 7;
  }

  function workOrderText_(row) {
    if (!row) return '—';
    var number = clean_(row['Work Order Number']);
    var id = clean_(row['Work Order ID'] || row['Entity ID']);
    var status = clean_(row['Status']);
    var first = (number ? '#' + number : (id ? 'WO ' + id : 'Work Order')) + (status ? ' · ' + status : '');
    var second = truncate_(row['Work Order Name'], 80);
    var businessDate = row['Sales Order Date'] || row['Created At'] || row['Scheduled Date'];
    var third = [businessDate ? formatDate_(businessDate) : '', clean_(row['Technician'])].filter(Boolean).join(' · ');
    return [first, second, third].filter(Boolean).join('\n') || '—';
  }

  function taskText_(row) {
    if (!row) return '—';
    var id = clean_(row['Task ID'] || row['Entity ID']);
    var status = clean_(row['Status']);
    var first = (id ? '#' + id : 'Task') + (status ? ' · ' + status : '');
    var second = truncate_(row['Task Name'], 90);
    var third = [row['Scheduled Date'] ? formatDate_(row['Scheduled Date']) : '', clean_(row['Technician'])].filter(Boolean).join(' · ');
    return [first, second, third].filter(Boolean).join('\n') || '—';
  }

  function workOrderDate_(row) {
    return dateMs_(row && (row['Sales Order Date'] || row['Created At'] || row['Scheduled Date']));
  }

  function activeWorkIdentity_(request) {
    var active = safeJson_(request['Active Work JSON']);
    var ids = {};
    var numbers = {};
    if (!active) return { ids: ids, numbers: numbers };
    ['activeAtLocation', 'activeForCustomer'].forEach(function (key) {
      var rows = Array.isArray(active[key]) ? active[key] : [];
      rows.forEach(function (row) {
        var id = clean_(row && (row['Work Order ID'] || row['Entity ID']));
        var number = clean_(row && row['Work Order Number']);
        if (id) ids[id] = true;
        if (number) numbers[number] = true;
      });
    });
    return { ids: ids, numbers: numbers };
  }

  function selectWorkOrder_(request, candidates) {
    var rows = (candidates || []).slice();
    if (!rows.length) return null;

    var activeIdentity = activeWorkIdentity_(request);
    var activeRows = rows.filter(function (row) {
      var id = clean_(row['Work Order ID'] || row['Entity ID']);
      var number = clean_(row['Work Order Number']);
      return (id && activeIdentity.ids[id]) || (number && activeIdentity.numbers[number]);
    });
    if (activeRows.length) rows = activeRows;

    var submittedMs = dateMs_(request['Submitted At'] || request['Created At']);
    var requestAddress = normalizeAddress_(request['Full Address'] || request['Matched Location Address']);
    var requestLocationId = clean_(request['Matched Location ID'] || request['Created Location ID']);

    if (!activeRows.length && submittedMs) {
      var timeRelevant = rows.filter(function (row) {
        var ms = workOrderDate_(row);
        return ms && ms >= submittedMs - (14 * DAY_MS);
      });
      if (timeRelevant.length) rows = timeRelevant;
    }

    rows.sort(function (a, b) {
      function score_(row) {
        var score = 0;
        var rowAddress = normalizeAddress_(row['Service Address']);
        var rowLocation = clean_(row['Location ID']);
        if (requestAddress && rowAddress && requestAddress === rowAddress) score += 160;
        if (requestLocationId && rowLocation && requestLocationId === rowLocation) score += 130;
        var rank = workStatusRank_(row['Status']);
        if (rank <= 2) score += 75;
        var ms = workOrderDate_(row);
        if (submittedMs && ms && ms >= submittedMs - (14 * DAY_MS)) score += 45;
        return score;
      }
      var scoreDiff = score_(b) - score_(a);
      if (scoreDiff) return scoreDiff;
      var rankDiff = workStatusRank_(a['Status']) - workStatusRank_(b['Status']);
      if (rankDiff) return rankDiff;
      return workOrderDate_(b) - workOrderDate_(a);
    });

    var chosen = rows[0] || null;
    if (!chosen) return null;

    if (!activeRows.length && submittedMs) {
      var chosenMs = workOrderDate_(chosen);
      var exactAddress = requestAddress && normalizeAddress_(chosen['Service Address']) === requestAddress;
      if (chosenMs && chosenMs < submittedMs - (60 * DAY_MS) && !exactAddress) return null;
    }
    return chosen;
  }

  function mergeTaskRows_(rows) {
    var byId = {};
    (rows || []).forEach(function (row) {
      var id = clean_(row['Task ID'] || row['Entity ID']);
      if (!id) return;
      var existing = byId[id];
      if (!existing) { byId[id] = row; return; }
      var existingScore = [existing['Customer ID'], existing['Location ID'], existing['Scheduled Date'], existing['Technician'], existing['Service Address']].filter(Boolean).length;
      var rowScore = [row['Customer ID'], row['Location ID'], row['Scheduled Date'], row['Technician'], row['Service Address']].filter(Boolean).length;
      if (rowScore > existingScore) byId[id] = row;
    });
    return Object.keys(byId).map(function (id) { return byId[id]; });
  }

  function selectTask_(rows) {
    var candidates = mergeTaskRows_(rows);
    candidates.sort(function (a, b) {
      var rankDiff = taskStatusRank_(a['Status']) - taskStatusRank_(b['Status']);
      if (rankDiff) return rankDiff;
      var aMs = dateMs_(a['Scheduled Date'] || a['Completed At']);
      var bMs = dateMs_(b['Scheduled Date'] || b['Completed At']);
      if (aMs !== bMs) return bMs - aMs;
      return Number(b['Task ID'] || b['Entity ID'] || 0) - Number(a['Task ID'] || a['Entity ID'] || 0);
    });
    return candidates[0] || null;
  }

  function updateDashboard_(workOrders) {
    var counts = { total: 0, approved: 0, inProgress: 0, completed: 0, usedCreatedAtFallback: 0 };
    (workOrders || []).forEach(function (row) {
      var salesDate = row['Sales Order Date'];
      var effectiveDate = salesDate || row['Created At'];
      var ms = dateMs_(effectiveDate);
      if (!salesDate && row['Created At']) counts.usedCreatedAtFallback++;
      if (!ms || ms < CUTOFF_MS) return;
      var status = upper_(row['Status']);
      if (status === 'APPROVED') { counts.approved++; counts.total++; }
      else if (status === 'IN PROGRESS') { counts.inProgress++; counts.total++; }
      else if (status === 'COMPLETED') { counts.completed++; counts.total++; }
    });

    var sheet = CF.Util.requireSheet('DASHBOARD');
    var display = sheet.getDataRange().getDisplayValues();
    var titleRow = -1;
    var titleCol = -1;
    for (var r = 0; r < display.length && titleRow < 0; r++) {
      for (var c = 0; c < display[r].length; c++) {
        if (clean_(display[r][c]).indexOf('Service Work Orders') >= 0) {
          titleRow = r + 1;
          titleCol = c + 1;
          break;
        }
      }
    }
    if (titleRow < 1 || titleCol < 1) {
      return { ok: false, status: 'DASHBOARD_WORK_ORDER_TABLE_NOT_FOUND', counts: counts };
    }

    var values = {
      'TOTAL': counts.total,
      'APPROVED': counts.approved,
      'IN PROGRESS': counts.inProgress,
      'COMPLETED': counts.completed
    };
    for (var rr = titleRow + 1; rr <= Math.min(sheet.getLastRow(), titleRow + 8); rr++) {
      var label = upper_(sheet.getRange(rr, titleCol).getDisplayValue());
      if (Object.prototype.hasOwnProperty.call(values, label)) {
        sheet.getRange(rr, titleCol + 1).setValue(values[label]);
      }
    }

    for (var dr = 0; dr < display.length; dr++) {
      for (var dc = 0; dc < display[dr].length; dc++) {
        var text = clean_(display[dr][dc]);
        if (text.indexOf('Created At is not used for this count.') >= 0) {
          sheet.getRange(dr + 1, dc + 1).setValue(
            text.replace(
              'Created At is not used for this count.',
              'Sales Order Date is used when available; Created At is used only when the Striven report leaves Sales Order Date blank.'
            )
          );
        }
      }
    }
    return { ok: true, counts: counts };
  }

  function refresh_() {
    if (typeof CF === 'undefined' || !CF.Util || typeof CF.Util.readRecords !== 'function' || typeof CF.Util.requireSheet !== 'function') {
      throw new Error('OPERATIONAL_PROJECTION_SETUP_REQUIRED | CF.Util.readRecords/requireSheet are required.');
    }

    var requests = CF.Util.readRecords('SERVICE_REQUESTS');
    var operational = CF.Util.readRecords('STRIVEN_OPERATIONAL_DATA');
    var requestById = {};
    requests.forEach(function (row) {
      var id = clean_(row['Request ID']);
      if (id) requestById[id] = row;
    });

    var workOrders = [];
    var workOrdersByCustomer = {};
    var tasksByWorkOrderNumber = {};
    operational.forEach(function (row) {
      var type = upper_(row['Entity Type']);
      if (type === 'WORK_ORDER') {
        workOrders.push(row);
        var customerId = clean_(row['Customer ID']);
        if (customerId) {
          if (!workOrdersByCustomer[customerId]) workOrdersByCustomer[customerId] = [];
          workOrdersByCustomer[customerId].push(row);
        }
      } else if (type === 'TASK' || type === 'TASK_RELATIONSHIP') {
        var number = clean_(row['Work Order Number']);
        if (number) {
          if (!tasksByWorkOrderNumber[number]) tasksByWorkOrderNumber[number] = [];
          tasksByWorkOrderNumber[number].push(row);
        }
      }
    });

    var queue = CF.Util.requireSheet('OPERATOR_QUEUE');
    var map = headerMap_(queue);
    if (!map['Request ID'] || !map['Sales Order / Work Order'] || !map['Task']) {
      throw new Error('OPERATIONAL_PROJECTION_SAFETY_STOP | 03 Operator Queue requires Request ID, Sales Order / Work Order, and Task headers.');
    }

    var queueRows = Math.max(0, queue.getLastRow() - 1);
    var workValues = [];
    var taskValues = [];
    var linkedWorkOrders = 0;
    var linkedTasks = 0;
    if (queueRows > 0) {
      var ids = queue.getRange(2, map['Request ID'], queueRows, 1).getDisplayValues();
      ids.forEach(function (cell) {
        var request = requestById[clean_(cell[0])] || {};
        var customerId = clean_(request['Matched Customer ID'] || request['Created Customer ID']);
        var workOrder = customerId ? selectWorkOrder_(request, workOrdersByCustomer[customerId] || []) : null;
        var number = workOrder ? clean_(workOrder['Work Order Number']) : '';
        var task = number ? selectTask_(tasksByWorkOrderNumber[number] || []) : null;
        if (workOrder) linkedWorkOrders++;
        if (task) linkedTasks++;
        workValues.push([workOrderText_(workOrder)]);
        taskValues.push([taskText_(task)]);
      });
      queue.getRange(2, map['Sales Order / Work Order'], queueRows, 1)
        .setValues(workValues).setWrap(true).setVerticalAlignment('top');
      queue.getRange(2, map['Task'], queueRows, 1)
        .setValues(taskValues).setWrap(true).setVerticalAlignment('top');
    }

    var dashboard = updateDashboard_(workOrders);
    SpreadsheetApp.flush();
    return {
      ok: true,
      version: '5.10.0',
      mode: 'OPERATIONAL_PROJECTION_R6',
      queueRows: queueRows,
      workOrdersInCache: workOrders.length,
      linkedWorkOrders: linkedWorkOrders,
      linkedTasks: linkedTasks,
      dashboard: dashboard
    };
  }

  return { refresh: refresh_ };
})();

(function CF_SERVICEOPS_INSTALL_OPERATIONAL_PROJECTION_V5100_R6_() {
  if (typeof CF === 'undefined' || !CF.OperatorQueue || typeof CF.OperatorQueue.refresh !== 'function') {
    throw new Error('OPERATIONAL_PROJECTION_SETUP_REQUIRED | CF.OperatorQueue.refresh is required.');
  }
  if (CF.OperatorQueue.__operationalProjectionV5100R6 === true) return;

  var originalRefresh = CF.OperatorQueue.refresh;
  var wrappedRefresh = function () {
    var result = originalRefresh.apply(CF.OperatorQueue, arguments);
    var projection;
    try {
      projection = CF_SERVICEOPS_OPERATIONAL_PROJECTION_V5100_R6_.refresh();
    } catch (error) {
      projection = {
        ok: false,
        version: '5.10.0',
        mode: 'OPERATIONAL_PROJECTION_R6',
        error: error && error.message ? error.message : String(error)
      };
      try { console.error('CF ServiceOps operational projection failed', projection); } catch (ignored) {}
    }
    if (result && typeof result === 'object') result.operationalProjection = projection;
    return result;
  };

  CF.OperatorQueue.refresh = wrappedRefresh;
  CF.OperatorQueue.refreshOperationalProjection = function () {
    return CF_SERVICEOPS_OPERATIONAL_PROJECTION_V5100_R6_.refresh();
  };
  CF.OperatorQueue.__operationalProjectionV5100R6 = true;
})();


/* CF_SERVICEOPS_V5_10_14_RUNTIME_INTERNAL_NOTES_QUEUE_R1 — DURABLE SO FALLBACK + BATCHED RICH TEXT */


/************************************************************
 * CF_SERVICEOPS_V5_10_15_LEAN_QUEUE_SNAPSHOT_R1
 * CF ServiceOps — Authoritative Lean Operator Queue Snapshot
 * Version: 5.10.15
 *
 * This block is intentionally appended AFTER all historical
 * Queue/projection wrappers. It supersedes the legacy refresh
 * chain without deleting historical source.
 *
 * - Queue refresh does NOT rebuild Dashboard.
 * - One Service Request read.
 * - One Operational cache read.
 * - One A:I values write.
 * - Batched Status background.
 * - Batched RichText for Striven / SO / Task columns.
 * - Durable Service Request Sales Order wins over report lag.
 * - No Striven mutation.
 ************************************************************/
var CF_SERVICEOPS_LEAN_QUEUE_V51015_R1_ = (function () {
  'use strict';

  var VERSION='5.11.7';
  var LAYOUT_PROPERTY='CF_OPERATOR_QUEUE_LAYOUT_V51015_R1';

  function clean_(v){return String(v===null||v===undefined?'':v).trim();}
  function upper_(v){return clean_(v).toUpperCase();}
  function line_(rows){return (rows||[]).map(clean_).filter(Boolean).join('\n');}
  function truncate_(v,n){var s=clean_(v),m=Number(n||120);return s.length<=m?s:s.substring(0,Math.max(0,m-1))+'…';}
  function parseJson_(v,f){try{return CF.Util.parseJson(v,f);}catch(e){try{return JSON.parse(String(v||''));}catch(e2){return f;}}}
  function compactDate_(v){if(!v)return'';try{return CF.Util.formatDate(v,'MMM d, yyyy');}catch(e){return clean_(v);}}
  function dateMs_(v){if(v instanceof Date)return isNaN(v.getTime())?0:v.getTime();var n=new Date(v||0).getTime();return isNaN(n)?0:n;}
  function active_(r){return !CF.Config.isTerminalState(r['Current Stage'])&&!CF.Config.isTerminalState(r['Final Outcome']);}
  function queueSort_(a,b){
    var bt=dateMs_(b['Submitted At']||b['Created At']),at=dateMs_(a['Submitted At']||a['Created At']);
    return bt!==at?bt-at:clean_(b['Request ID']).localeCompare(clean_(a['Request ID']));
  }
  function customerId_(r){return clean_(r['Matched Customer ID']||r['Created Customer ID']);}
  function contactId_(r){return clean_(r['Matched Contact ID']||r['Created Contact ID']);}
  /* CF_SERVICEOPS_V5_14_2_SCOPED_CONTACT_QUEUE_LINK_R1
   * A Customer-scoped Contact ID and a global Contact ID are distinct Striven
   * identifiers. Prefer the verified customer-scoped identifier for the
   * /accounts/{customer}/contacts/{id} route. If scope is not verified, use
   * the legacy global ContactInfo.aspx route rather than constructing a broken
   * customer-scoped URL from a global ID.
   */
  function contactLinkIdentity_(r){
    var customer=customerId_(r),base=contactId_(r),root=parseJson_(r['Write Journal JSON'],{})||{},identity=root.contactIdentity||{};
    var scoped='';
    if(upper_(identity.scope)==='CUSTOMER'&&identity.identityVerified===true&&clean_(identity.customerId)===customer){
      scoped=clean_(identity.customerScopedContactId||identity.contactId);
    }
    var globalId=clean_(identity.globalContactId);
    if(!globalId&&base&&base!==scoped)globalId=base;
    var displayId=scoped||base,url='';
    if(scoped&&customer)url='https://classicfireplace.striven.com/next/crm#/accounts/'+encodeURIComponent(customer)+'/contacts/'+encodeURIComponent(scoped);
    else if(globalId||base)url='https://classicfireplace.striven.com/CRM/ContactInfo.aspx?ContactID='+encodeURIComponent(globalId||base);
    return{displayId:displayId,customerScopedContactId:scoped,globalContactId:globalId||(!scoped?base:''),url:url,scope:scoped?'CUSTOMER':'GLOBAL_OR_UNKNOWN'};
  }
  function locationId_(r){return clean_(r['Matched Location ID']||r['Created Location ID']);}
  function strivenUrl_(type,id,parent){
    id=clean_(id);parent=clean_(parent);if(!id)return'';
    if(type==='CUSTOMER')return'https://classicfireplace.striven.com/CRM/AccountDashboard.aspx?AccountID='+encodeURIComponent(id);
    if(type==='CONTACT')return parent?'https://classicfireplace.striven.com/next/crm#/accounts/'+encodeURIComponent(parent)+'/contacts/'+encodeURIComponent(id):'';
    if(type==='LOCATION')return parent?'https://classicfireplace.striven.com/next/crm#/accounts/'+encodeURIComponent(parent)+'/locations/'+encodeURIComponent(id):'';
    if(type==='SALES_ORDER')return'https://classicfireplace.striven.com/next/crm#/sales-orders/'+encodeURIComponent(id);
    if(type==='TASK')return'https://classicfireplace.striven.com/Tasks/TaskInfo.aspx?nav=1&TaskID='+encodeURIComponent(id);
    if(type==='ASSET')return'https://classicfireplace.striven.com/AssetManagement/CustomerAssetsBasicInfo.aspx?AssetID='+encodeURIComponent(id);
    return'';
  }
  function statusText_(r){
    var review=upper_(r['Manual Review?'])==='YES'?'Review: '+clean_(r['Manual Review Reason']||r['Blocking Issue']||'Required'):'';
    return line_([r['Current Stage']||r['Request Status'],'Submitted: '+compactDate_(r['Submitted At']||r['Created At']),review]);
  }
  function customerText_(r){
    return line_([r['Full Name'],clean_(r['Phone'])+(clean_(r['Alt Phone'])?' / '+clean_(r['Alt Phone']):''),r['Email'],r['Full Address']]);
  }
  function serviceText_(r){
    return line_([
      clean_(r['Unit Details'])?'Unit: '+truncate_(r['Unit Details'],180):'',
      clean_(r['Service Details'])?'Service: '+truncate_(r['Service Details'],220):'',
      clean_(r['Preferred Days'])?'Preferred: '+truncate_(r['Preferred Days'],100):'',
      clean_(r['Additional Notes'])?'Notes: '+truncate_(r['Additional Notes'],180):''
    ]);
  }
  function evidenceIds_(r,type){
    var e=parseJson_(r['Match Evidence JSON'],{})||{},rows=e[type+'Candidates']||[],out=[];
    rows.forEach(function(c){
      var x=c&&c.row?c.row:(c||{}),id='';
      if(type==='customer')id=x['Customer ID']||x['Entity ID']||c.id;
      if(type==='contact')id=x['Contact ID']||x['Entity ID']||c.id;
      if(type==='location')id=x['Location ID']||x['Entity ID']||c.id;
      id=clean_(id);if(id&&out.indexOf(id)<0)out.push(id);
    });
    return out;
  }
  // CF ServiceOps v5.11.7 R1 — compact immediate candidate resolution in Lean Operator Queue
  function candidateChoices_(r){
    var out=[];
    if(upper_(r['Customer Match Status'])==='AMBIGUOUS')evidenceIds_(r,'customer').forEach(function(id){out.push('CUSTOMER '+id);});
    if(upper_(r['Contact Match Status'])==='AMBIGUOUS')evidenceIds_(r,'contact').forEach(function(id){out.push('CONTACT '+id);});
    if(upper_(r['Location Match Status'])==='AMBIGUOUS')evidenceIds_(r,'location').forEach(function(id){out.push('LOCATION '+id);});
    return out;
  }
  function entityLine_(r,label,type,statusField,idField,actionField){
    var status=upper_(r[statusField]),id=clean_(r[idField]);
    if(status==='MATCHED'&&id)return label+': '+id+' ✓';
    if(status==='AMBIGUOUS'){var ids=evidenceIds_(r,type);return label+': '+(ids.length?ids.join(' / ')+' ⚠':'AMBIGUOUS ⚠');}
    if(upper_(r[actionField])==='CREATE')return label+': NEW';
    return label+': '+clean_(r[statusField]||'—');
  }
  /* CF_SERVICEOPS_SERVICE_STRIVEN_CHECKLIST_R2_ACTIVE_LEAN
   * Active Operator Queue projection. Work Order is the Service name for
   * the same Striven Sales Order entity.
   */
  function checklistSymbol_(state){
    state=upper_(state);
    if(state==='DONE')return'✅';
    if(state==='REVIEW')return'⚠️';
    return'⏳';
  }
  function customerChecklistState_(r,id){
    if(id)return'DONE';
    if(upper_(r['Customer Match Status'])==='AMBIGUOUS'||upper_(r['Manual Review?'])==='YES')return'REVIEW';
    return'PENDING';
  }
  function contactChecklistState_(r,id){
    var assoc=upper_(r['Contact Association Status']),structure=upper_(r['Customer Structure Status']),recon=upper_(r['Reconciliation Status']);
    if(/CONFLICT|AMBIGUOUS|REVIEW|ERROR/.test(assoc))return'REVIEW';
    if(id&&(/ASSOCIATED|CONFIRMED|CACHE_CONFIRMED/.test(assoc)||/CUSTOMER \+ CONTACT INFO CONFIRMED/.test(recon)||/CUSTOMER STRUCTURE COMPLETE|COMPLETE/.test(structure)))return'DONE';
    if(id)return'PENDING';
    if(upper_(r['Contact Match Status'])==='AMBIGUOUS'||upper_(r['Manual Review?'])==='YES')return'REVIEW';
    return'PENDING';
  }
  function locationChecklistState_(r,id){
    var status=upper_(r['Location Match Status']),structure=upper_(r['Customer Structure Status']),recon=upper_(r['Reconciliation Status']);
    if(status==='AMBIGUOUS'||/LOCATION.*CONFLICT|LOCATION.*REVIEW|LOCATION.*ERROR/.test(recon))return'REVIEW';
    if(id&&(status==='MATCHED'||/PRIMARY LOCATION.*CONFIRMED|CUSTOMER STRUCTURE COMPLETE|COMPLETE/.test(structure)))return'DONE';
    if(id)return'PENDING';
    if(upper_(r['Manual Review?'])==='YES')return'REVIEW';
    return'PENDING';
  }
  function assetChecklist_(r,index){
    var cid=customerId_(r),ids=cid&&index.assetsByCustomer[cid]?index.assetsByCustomer[cid].slice():[];
    ids=ids.filter(function(id,i,a){return id&&a.indexOf(id)===i;});
    var rawCount=clean_(r['Customer Asset Count']),count=Math.max(Number(rawCount||0),ids.length);
    var hs=upper_(r['History Enrichment Status']),state='PENDING';
    if(/ERROR|BLOCK|REVIEW|AMBIGUOUS/.test(hs))state='REVIEW';
    else if(hs||ids.length||rawCount!=='')state='DONE';
    var display=ids.length?ids.slice(0,3).join(' / ')+(ids.length>3?' +'+(ids.length-3):''):(state==='DONE'?String(count):'');
    return{state:state,ids:ids,display:display};
  }
  function workOrderChecklist_(r,order){
    order=order||{text:'—',url:'',status:'',number:'',workOrderNumber:''};
    var durable=durableOrder_(r);
    var id=clean_(durable.id||r['Work Order ID']);
    var number=clean_(order.number||order.workOrderNumber||durable.number||r['Work Order Number']||id);
    var url=clean_(order.url||durable.url||r['Work Order Link'])||(id?strivenUrl_('SALES_ORDER',id):'');
    var outcome=upper_(r['Final Outcome']),recon=upper_(r['Reconciliation Status']),stage=upper_(r['Current Stage']),status=upper_(r['Work Order Status']||order.status||durable.status);
    var verified=!!(id||number)&&(/VERIFIED/.test(outcome)||/SALES ORDER VERIFIED|WORK ORDER VERIFIED/.test(recon)||stage==='COMPLETED');
    var review=/BLOCK|ERROR|REVIEW|CONFLICT|AMBIGUOUS/.test(status)||upper_(r['Manual Review?'])==='YES';
    return{state:verified?'DONE':(review?'REVIEW':'PENDING'),id:id,number:number,url:url};
  }
  // CF_SERVICEOPS_V5_14_2_IDENTITY_CONFLICT_CHECKLIST_R1
  function strivenText_(r,index,order){
    var cid=customerId_(r);
    var candidateCustomerIds=!cid&&upper_(r['Customer Match Status'])==='AMBIGUOUS'?evidenceIds_(r,'customer'):[];
    var customerDisplay=cid||candidateCustomerIds.join(' / ');
    var contactLink=contactLinkIdentity_(r),contact=contactLink.displayId,location=locationId_(r),assets=assetChecklist_(r,index),wo=workOrderChecklist_(r,order);
    return line_([
      'Customer: '+customerDisplay+(customerDisplay?' ':'')+checklistSymbol_(customerChecklistState_(r,cid)),
      'Contact: '+(contact||'')+(contact?' ':'')+checklistSymbol_(contactChecklistState_(r,contact)),
      'Location: '+(location||'')+(location?' ':'')+checklistSymbol_(locationChecklistState_(r,location)),
      'Assets: '+(assets.display||'')+(assets.display?' ':'')+checklistSymbol_(assets.state),
      'Work Order: '+(wo.number||'')+(wo.number?' ':'')+checklistSymbol_(wo.state)
    ]);
  }
  function historyText_(r,index){
    var cid=customerId_(r),assets=cid&&index.assetsByCustomer[cid]?index.assetsByCustomer[cid]:[];
    var assetCount=Number(r['Customer Asset Count']||assets.length||0);
    var assetLine='Assets: '+assetCount;
    if(assets.length)assetLine+=' · IDs '+assets.slice(0,3).join(' / ')+(assets.length>3?' +'+(assets.length-3):'');
    var risk=upper_(r['Duplicate Risk Status'])==='NONE'?'Duplicate risk: none':'Duplicate risk: '+clean_(r['Duplicate Risk Status']||'REVIEW')+(clean_(r['Duplicate Risk Reason'])?' — '+r['Duplicate Risk Reason']:'');
    var durable=durableOrder_(r);
    return line_([
      assetLine,
      clean_(r['Last Service Date'])?'Last service: '+compactDate_(r['Last Service Date'])+(clean_(r['Last Service Technician'])?' · '+r['Last Service Technician']:''):'',
      truncate_(r['Active Work Summary'],180),
      durable.id?'Striven: SO '+(durable.number||durable.id):'',
      risk
    ]);
  }

  function operationalIndex_(rows){
    var idx={assetsByCustomer:{},workOrdersById:{},workOrdersByNumber:{},tasksByWorkOrderNumber:{}};
    (rows||[]).forEach(function(r){
      var type=upper_(r['Entity Type']),cid=clean_(r['Customer ID']);
      var asset=clean_(r['Asset ID']||(type==='ASSET'?r['Entity ID']:''));
      if(cid&&asset){
        if(!idx.assetsByCustomer[cid])idx.assetsByCustomer[cid]=[];
        if(idx.assetsByCustomer[cid].indexOf(asset)<0)idx.assetsByCustomer[cid].push(asset);
      }
      if(type==='WORK_ORDER'){
        var id=clean_(r['Work Order ID']||r['Entity ID']),num=clean_(r['Work Order Number']);
        if(id)idx.workOrdersById[id]=r;
        if(num)idx.workOrdersByNumber[num]=r;
      }
      if(type==='TASK'||type==='TASK_RELATIONSHIP'){
        var n=clean_(r['Work Order Number']);
        if(n){
          if(!idx.tasksByWorkOrderNumber[n])idx.tasksByWorkOrderNumber[n]=[];
          idx.tasksByWorkOrderNumber[n].push(r);
        }
      }
    });
    return idx;
  }
  function durableOrder_(r){
    var id=clean_(r['Work Order ID']),number=clean_(r['Work Order Number']),status=clean_(r['Work Order Status']),name='',url=clean_(r['Work Order Link']);
    var root=parseJson_(r['Write Journal JSON'],{})||{},so=root.salesOrderCreate||{};
    var body=(so.verification&&so.verification.result&&so.verification.result.body)||so.responseBody||{};
    if(!id)id=clean_(so.canonicalSalesOrderId||so.responseIdentifier||body.id);
    if(!number)number=clean_(so.canonicalOrderNumber||body.orderNumber);
    name=clean_(body.orderName||r['Work Order Name']||r['Sales Order Name']);
    if(!status)status=clean_(body.status&&body.status.name);
    if(!url&&id)url=strivenUrl_('SALES_ORDER',id);
    return{id:id,number:number||id,name:name||'Sales Order',status:status,url:url};
  }
  function activeWorkIdentity_(r){
    var payload=parseJson_(r['Active Work JSON'],{})||{},ids={},numbers={};
    ['activeAtLocation','activeForCustomer'].forEach(function(key){
      var rows=Array.isArray(payload[key])?payload[key]:[];
      rows.forEach(function(x){
        var id=clean_(x&&x['Work Order ID']||x&&x['Entity ID']);
        var number=clean_(x&&x['Work Order Number']);
        if(id)ids[id]=true;
        if(number)numbers[number]=true;
      });
    });
    var durableId=clean_(r['Work Order ID']),durableNumber=clean_(r['Work Order Number']);
    if(durableId)ids[durableId]=true;
    if(durableNumber)numbers[durableNumber]=true;
    return{ids:ids,numbers:numbers};
  }
  function chooseOperationalOrder_(r,index){
    var durable=durableOrder_(r);
    if(durable.id){
      var exact=index.workOrdersById[durable.id]||index.workOrdersByNumber[durable.number];
      if(exact)return{source:'OPERATIONAL_EXACT_DURABLE',row:exact,durable:durable};
      return{source:'DURABLE',row:null,durable:durable};
    }
    var identity=activeWorkIdentity_(r),chosen=null;
    Object.keys(identity.ids).some(function(id){
      if(index.workOrdersById[id]){chosen=index.workOrdersById[id];return true;}
      return false;
    });
    if(!chosen){
      Object.keys(identity.numbers).some(function(number){
        if(index.workOrdersByNumber[number]){chosen=index.workOrdersByNumber[number];return true;}
        return false;
      });
    }
    return chosen
      ?{source:'OPERATIONAL_EXACT_ACTIVE_WORK',row:chosen,durable:durable}
      :{source:'NONE',row:null,durable:durable};
  }
  function orderProjection_(r,index){
    var chosen=chooseOperationalOrder_(r,index),wo=chosen.row,d=chosen.durable;
    if(!wo&&!d.id)return{text:'—',url:'',status:'',number:'',name:'',workOrderNumber:''};
    if(wo){
      var id=clean_(wo['Work Order ID']||wo['Entity ID']),num=clean_(wo['Work Order Number']||id);
      var name=clean_(wo['Work Order Name']||wo['Description']||d.name||'Sales Order');
      var status=clean_(wo['Status']||d.status);
      return{text:line_([[(num?'#'+num:''),name].filter(Boolean).join(' - '),status]),url:strivenUrl_('SALES_ORDER',id||d.id),status:status,number:num,name:name,workOrderNumber:num};
    }
    return{text:line_([[(d.number?'#'+d.number:''),d.name].filter(Boolean).join(' - '),d.status]),url:d.url,status:d.status,number:d.number,name:d.name,workOrderNumber:d.number};
  }
  function taskProjection_(order,index){
    var num=clean_(order.workOrderNumber);if(!num)return{text:'—',url:'',status:''};
    var rows=(index.tasksByWorkOrderNumber[num]||[]).slice();
    if(!rows.length)return{text:'—',url:'',status:''};
    rows.sort(function(a,b){
      function rank(x){var s=upper_(x['Status']);if(s==='OPEN'||s==='IN PROGRESS')return 0;if(s==='SCHEDULED')return 1;if(s==='DONE'||s==='COMPLETED')return 3;return 7;}
      var x=rank(a)-rank(b);if(x)return x;return dateMs_(b['Scheduled Date']||b['Completed At'])-dateMs_(a['Scheduled Date']||a['Completed At']);
    });
    var t=rows[0],id=clean_(t['Task ID']||t['Entity ID']),name=clean_(t['Task Name']||t['Description']||'Task'),status=clean_(t['Status']);
    return{text:line_([[(id?'#'+id:''),truncate_(name,125)].filter(Boolean).join(' - '),status]),url:strivenUrl_('TASK',id),status:status};
  }
  function statusColor_(s){
    s=upper_(s);
    if(/CANCEL|DECLIN|VOID|ERROR|BLOCK/.test(s))return'#cc0000';
    if(/COMPLET|DONE|CLOSED/.test(s))return'#38761d';
    if(/IN PROGRESS|APPROVED|SCHEDULED|ASSIGNED|OPEN/.test(s))return'#1155cc';
    if(/QUOTED|PENDING|HOLD|REVIEW|INCOMPLETE/.test(s))return'#b45f06';
    return'#666666';
  }
  function stageBg_(s){
    s=upper_(s);
    if(s==='COMPLETED')return'#d9ead3';
    if(s==='NEEDS REVIEW'||/^READY FOR /.test(s))return'#fff2cc';
    if(s==='CUSTOMER RESOLVED'||s==='CUSTOMER STRUCTURE COMPLETE'||s==='APPROVED FOR CUSTOMER STRUCTURE')return'#d9ead3';
    if(s==='BLOCKED'||s==='ERROR')return'#f4cccc';
    if(s==='NEW INTAKE')return'#d9eaf7';
    return'#ffffff';
  }
  function richFirstLine_(text,url,status){
    text=String(text||'');
    var b=SpreadsheetApp.newRichTextValue().setText(text);
    if(!text||text==='—')return b.build();
    var firstEnd=text.indexOf('\n');if(firstEnd<0)firstEnd=text.length;
    if(url&&firstEnd>0)b.setLinkUrl(0,firstEnd,url);
    if(firstEnd<text.length){
      var start=firstEnd+1,end=text.indexOf('\n',start);if(end<0)end=text.length;
      if(end>start)b.setTextStyle(start,end,SpreadsheetApp.newTextStyle().setBold(true).setForegroundColor(statusColor_(status)).build());
    }
    return b.build();
  }
  function richStriven_(r,text,index,order){
    var cid=customerId_(r),contactLink=contactLinkIdentity_(r),contact=contactLink.displayId,location=locationId_(r);
    var assets=assetChecklist_(r,index),wo=workOrderChecklist_(r,order);
    var b=SpreadsheetApp.newRichTextValue().setText(text),specs=[
      {prefix:'Customer: ',id:cid,url:strivenUrl_('CUSTOMER',cid)},
      {prefix:'Contact: ',id:contact,url:contactLink.url},
      {prefix:'Location: ',id:location,url:strivenUrl_('LOCATION',location,cid)}
    ];
    if(!cid&&upper_(r['Customer Match Status'])==='AMBIGUOUS'){
      var customerLineEnd=text.indexOf('\n');if(customerLineEnd<0)customerLineEnd=text.length;
      var customerCursor='Customer: '.length;
      evidenceIds_(r,'customer').forEach(function(id){
        var pos=text.indexOf(id,customerCursor);
        if(pos>=customerCursor&&pos<customerLineEnd){
          b.setLinkUrl(pos,pos+id.length,strivenUrl_('CUSTOMER',id));
          customerCursor=pos+id.length;
        }
      });
    }
    assets.ids.slice(0,3).forEach(function(id){
      specs.push({prefix:'Assets: ',id:id,url:strivenUrl_('ASSET',id)});
    });
    if(wo.number&&wo.url)specs.push({prefix:'Work Order: ',id:wo.number,url:wo.url});
    specs.forEach(function(spec){
      if(!spec.id||!spec.url)return;
      var lineStart=text.indexOf(spec.prefix);
      if(lineStart<0)return;
      var lineEnd=text.indexOf('\n',lineStart);if(lineEnd<0)lineEnd=text.length;
      var pos=text.indexOf(spec.id,lineStart);
      if(pos>=lineStart&&pos<lineEnd)b.setLinkUrl(pos,pos+spec.id.length,spec.url);
    });
    return b.build();
  }
  function ensureLayout_(sheet,headers){
    var p=PropertiesService.getScriptProperties(),key='CF_OPERATOR_QUEUE_LAYOUT_V5117_R1';
    if(p.getProperty(key)==='true')return;
    sheet.setFrozenRows(1);sheet.setFrozenColumns(1);
    sheet.getRange(1,1,1,headers.length)
      .setFontWeight('bold')
      .setFontSize(10)
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle')
      .setBackground('#1f4e78')
      .setFontColor('#ffffff');
    sheet.setRowHeight(1,32);
    [175,205,310,360,280,310,235,310,330,170].forEach(function(w,i){sheet.setColumnWidth(i+1,w);});
    var maxBody=Math.max(1,sheet.getMaxRows()-1);
    sheet.getRange(2,1,maxBody,headers.length).setWrap(true).setVerticalAlignment('top').setFontSize(10);
    if(!sheet.getFilter())sheet.getRange(1,1,Math.max(2,sheet.getLastRow()),headers.length).createFilter();
    p.setProperty(key,'true');
  }
  function refresh(){
    var started=Date.now(),baseHeaders=CF.Config.getHeaders('OPERATOR_QUEUE'),sheet=CF.Util.requireSheet('OPERATOR_QUEUE');
    var headers=baseHeaders.indexOf('Operator Action')>=0?baseHeaders.slice():baseHeaders.concat(['Operator Action']);
    var t0=Date.now();
    // CF ServiceOps v5.11.4 R3 — patch the active Lean Queue override, not the shadowed legacy refresh
    // Persistent tracking view: render every Service Request; active_ is metrics-only.
    var requests=CF.Util.readRecords('SERVICE_REQUESTS').sort(queueSort_);
    var activeRequestCount=requests.filter(active_).length;
    var tRequests=Date.now();
    var operational=[];
    try{operational=CF.Util.readRecords('STRIVEN_OPERATIONAL_DATA');}catch(e){operational=[];}
    var tOperational=Date.now();
    var index=operationalIndex_(operational);
    var tIndex=Date.now();

    ensureLayout_(sheet,headers);
    var currentHeaders=sheet.getRange(1,1,1,headers.length).getDisplayValues()[0];
    if(currentHeaders.join('|')!==headers.join('|'))sheet.getRange(1,1,1,headers.length).setValues([headers]);

    var values=[],strivenRich=[],orderRich=[],taskRich=[],statusBg=[],actionValidations=[];
    requests.forEach(function(r){
      var order=orderProjection_(r,index),task=taskProjection_(order,index);
      var st=statusText_(r),cust=customerText_(r),svc=serviceText_(r),str=strivenText_(r,index,order),hist=historyText_(r,index);
      var candidateChoices=candidateChoices_(r);
      values.push([r['Request ID'],st,cust,svc,str,hist,r['Next Action'],order.text,task.text,'']);
      actionValidations.push([candidateChoices.length?SpreadsheetApp.newDataValidation().requireValueInList(candidateChoices,true).setAllowInvalid(false).build():null]);
      strivenRich.push([richStriven_(r,str,index,order)]);
      orderRich.push([richFirstLine_(order.text,order.url,order.status)]);
      taskRich.push([richFirstLine_(task.text,task.url,task.status)]);
      statusBg.push([stageBg_(r['Current Stage'])]);
    });
    var tModel=Date.now();

    var oldRows=Math.max(0,sheet.getLastRow()-1),n=values.length;
    if(n){
      sheet.getRange(2,1,n,headers.length).setValues(values);
    }
    if(oldRows>n)sheet.getRange(n+2,1,oldRows-n,headers.length).clearContent();
    var actionCol=headers.indexOf('Operator Action')+1;
    if(n&&actionCol)sheet.getRange(2,actionCol,n,1).setDataValidations(actionValidations);
    if(oldRows>n&&actionCol)sheet.getRange(n+2,actionCol,oldRows-n,1).clearDataValidations();
    var tValues=Date.now();

    if(n){
      sheet.getRange(2,2,n,1).setBackgrounds(statusBg).setFontWeight('bold');
      sheet.setRowHeights(2,n,108);
    }
    var tStatus=Date.now();

    if(n){
      sheet.getRange(2,5,n,1).setRichTextValues(strivenRich);
      sheet.getRange(2,8,n,1).setRichTextValues(orderRich);
      sheet.getRange(2,9,n,1).setRichTextValues(taskRich);
    }
    var finished=Date.now();

    var out={
      ok:true,
      version:VERSION,
      mode:'LEAN_QUEUE_PERSISTENT_TRACKING_IMMEDIATE_CANDIDATE_RESOLUTION_R1',
      activeRequests:activeRequestCount,
      trackedRequests:n,
      candidateResolutionColumn:true,
      operationalRowsRead:operational.length,
      dashboardRefreshed:false,
      legacyOperationalProjectionCalled:false,
      durableSalesOrderFallback:true,
      customerLevelSalesOrderGuessing:false,
      exactOrderSourcesOnly:['DURABLE_SERVICE_REQUEST','ACTIVE_WORK_EXACT_ID_OR_NUMBER'],
      richTextBatchWrites:n?3:0,
      timingsMs:{
        serviceRequestsRead:tRequests-t0,
        operationalRead:tOperational-tRequests,
        operationalIndex:tIndex-tOperational,
        modelBuild:tModel-tIndex,
        valuesWrite:tValues-tModel,
        statusFormat:tStatus-tValues,
        richTextWrites:finished-tStatus,
        total:finished-started
      },
      durationMs:finished-started,
      liveWritesAllowed:false
    };
    try{console.log('Lean Queue Snapshot: '+JSON.stringify(out));}catch(ignored){}
    return out;
  }
  return{refresh:refresh};
})();

(function CF_SERVICEOPS_INSTALL_LEAN_QUEUE_V51015_R1_(){
  if(typeof CF==='undefined'||!CF.OperatorQueue||typeof CF.OperatorQueue.refresh!=='function'){
    throw new Error('LEAN_QUEUE_SETUP_REQUIRED | CF.OperatorQueue.refresh is required.');
  }
  if(CF.OperatorQueue.__leanQueueV51015R1===true)return;
  CF.OperatorQueue.refreshLegacyBeforeV51015=CF.OperatorQueue.refresh;
  CF.OperatorQueue.refresh=function(){return CF_SERVICEOPS_LEAN_QUEUE_V51015_R1_.refresh();};
  CF.OperatorQueue.__leanQueueV51015R1=true;
  CF.OperatorQueue.__leanQueueV51015R2=true;
})();

/* CF_SERVICEOPS_V5_10_15_LEAN_QUEUE_SNAPSHOT_R2 — EXACT ORDER IDENTITY + TIMING INSTRUMENTATION */


/************************************************************
 * CF_SERVICEOPS_V5_10_16_ALL_REQUEST_OPERATIONAL_RECONCILIATION_R1
 * CF ServiceOps — All-Request Operational Link Reconciliation
 * Version: 5.10.16
 *
 * PURPOSE
 * Permanently link Service Requests to existing Striven
 * Sales Orders/Work Orders when the Operational cache provides
 * a unique high-confidence request-to-order identity.
 *
 * SAFETY
 * - Never creates or updates anything in Striven.
 * - Never overwrites an existing durable Work Order ID/number.
 * - Never links from Customer ID alone.
 * - Requires post-request temporal evidence plus address/task
 *   identity, or an exact Active Work identity.
 * - Ambiguous candidates remain untouched and are reported.
 ************************************************************/
var CF_SERVICEOPS_OPERATIONAL_LINK_RECONCILIATION_V51016_R1_ = (function () {
  'use strict';

  var VERSION='5.10.16';
  var DAY_MS=24*60*60*1000;
  var MAX_AFTER_DAYS=120;
  var MAX_BEFORE_MS=1*DAY_MS;

  function clean_(v){return String(v===null||v===undefined?'':v).trim();}
  function upper_(v){return clean_(v).toUpperCase();}
  function digits_(v){return clean_(v).replace(/\D/g,'');}
  function last10_(v){var d=digits_(v);return d.length>=10?d.slice(-10):d;}
  function dateMs_(v){
    if(v instanceof Date)return isNaN(v.getTime())?0:v.getTime();
    if(!v)return 0;
    var d=new Date(v),ms=d.getTime();
    if(!isNaN(ms))return ms;
    var m=clean_(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?$/i);
    if(!m)return 0;
    var h=Number(m[4]||0),mi=Number(m[5]||0),ap=upper_(m[6]);
    if(ap==='PM'&&h<12)h+=12;if(ap==='AM'&&h===12)h=0;
    return new Date(Number(m[3]),Number(m[1])-1,Number(m[2]),h,mi,0,0).getTime();
  }
  function normalizeAddress_(v){
    try{
      if(CF&&CF.Util&&typeof CF.Util.normalizeAddress==='function')return clean_(CF.Util.normalizeAddress(v));
    }catch(e){}
    return upper_(v)
      .replace(/\bSTREET\b/g,'ST').replace(/\bROAD\b/g,'RD')
      .replace(/\bDRIVE\b/g,'DR').replace(/\bAVENUE\b/g,'AVE')
      .replace(/\bCOURT\b/g,'CT').replace(/\bCRESCENT\b/g,'CRES')
      .replace(/\bBOULEVARD\b/g,'BLVD').replace(/[^A-Z0-9]/g,'');
  }
  function normalizeWords_(v){return upper_(v).replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
  function streetCityKeyFromRequest_(r){
    var street=clean_(r['Street']),city=clean_(r['City']);
    if(street||city)return normalizeAddress_(street+' '+city);
    var parts=clean_(r['Full Address']).split(',').map(clean_).filter(Boolean);
    return normalizeAddress_((parts[0]||'')+' '+(parts[1]||''));
  }
  function streetCityKeyFromOperational_(address){
    var parts=clean_(address).split(',').map(clean_).filter(Boolean);
    return normalizeAddress_((parts[0]||'')+' '+(parts[1]||''));
  }
  function safeJson_(v){
    if(v&&typeof v==='object')return v;
    var s=clean_(v);if(!s)return null;
    try{return JSON.parse(s);}catch(e){return null;}
  }
  function customerId_(r){return clean_(r['Matched Customer ID']||r['Created Customer ID']);}
  function durableId_(r){return clean_(r['Work Order ID']);}
  function durableNumber_(r){return clean_(r['Work Order Number']);}
  function workOrderDate_(wo){
    return dateMs_(wo['Sales Order Date']||wo['Created At']||wo['Scheduled Date']||wo['Completed At']);
  }
  function isTerminalWork_(status){
    return /^(COMPLETED|DONE|CANCELLED|CANCELED|DECLINED|VOID|CLOSED)$/i.test(clean_(status));
  }
  function activeIdentity_(request){
    var ids={},numbers={},payload=safeJson_(request['Active Work JSON'])||{};
    ['activeAtLocation','activeForCustomer'].forEach(function(key){
      var rows=Array.isArray(payload[key])?payload[key]:[];
      rows.forEach(function(x){
        var id=clean_(x&&x['Work Order ID']||x&&x['Entity ID']);
        var number=clean_(x&&x['Work Order Number']);
        if(id)ids[id]=true;if(number)numbers[number]=true;
      });
    });
    return{ids:ids,numbers:numbers};
  }
  function buildIndex_(operational){
    var idx={workOrdersByCustomer:{},workOrdersById:{},workOrdersByNumber:{},tasksByWorkOrderNumber:{}};
    (operational||[]).forEach(function(row){
      var type=upper_(row['Entity Type']);
      if(type==='WORK_ORDER'){
        var cid=clean_(row['Customer ID']),id=clean_(row['Work Order ID']||row['Entity ID']),num=clean_(row['Work Order Number']);
        if(cid){if(!idx.workOrdersByCustomer[cid])idx.workOrdersByCustomer[cid]=[];idx.workOrdersByCustomer[cid].push(row);}
        if(id)idx.workOrdersById[id]=row;if(num)idx.workOrdersByNumber[num]=row;
      }
      if(type==='TASK'||type==='TASK_RELATIONSHIP'){
        var number=clean_(row['Work Order Number']);
        if(number){if(!idx.tasksByWorkOrderNumber[number])idx.tasksByWorkOrderNumber[number]=[];idx.tasksByWorkOrderNumber[number].push(row);}
      }
    });
    return idx;
  }
  function taskEvidence_(request,workOrder,index){
    var number=clean_(workOrder['Work Order Number']),tasks=(index.tasksByWorkOrderNumber[number]||[]);
    var text=tasks.map(function(t){return clean_(t['Task Name']||t['Description']);}).join(' | ');
    var digits=digits_(text),words=normalizeWords_(text);
    var phones=[last10_(request['Normalized Phone']||request['Phone']),last10_(request['Normalized Alt Phone']||request['Alt Phone'])].filter(function(x){return x&&x.length>=7;});
    var phoneMatch=phones.some(function(p){return digits.indexOf(p)>=0;});
    var name=normalizeWords_(request['Full Name']);
    var nameMatch=!!(name&&words.indexOf(name)>=0);
    return{tasks:tasks,phoneMatch:phoneMatch,nameMatch:nameMatch,text:text};
  }
  function scoreCandidate_(request,wo,index,activeIdentity){
    var submitted=dateMs_(request['Submitted At']||request['Created At']);
    var created=workOrderDate_(wo);
    var id=clean_(wo['Work Order ID']||wo['Entity ID']),number=clean_(wo['Work Order Number']);
    var activeExact=!!((id&&activeIdentity.ids[id])||(number&&activeIdentity.numbers[number]));

    if(submitted&&created&&created<submitted-MAX_BEFORE_MS&&!activeExact)return null;
    if(submitted&&created&&created>submitted+(MAX_AFTER_DAYS*DAY_MS)&&!activeExact)return null;

    var requestAddress=normalizeAddress_(request['Full Address']||request['Matched Location Address']);
    var workAddress=normalizeAddress_(wo['Service Address']);
    var exactAddress=!!(requestAddress&&workAddress&&requestAddress===workAddress);
    var requestStreetCity=streetCityKeyFromRequest_(request);
    var workStreetCity=streetCityKeyFromOperational_(wo['Service Address']);
    var streetCity=!!(requestStreetCity&&workStreetCity&&requestStreetCity===workStreetCity);
    var task=taskEvidence_(request,wo,index);

    var score=0,reasons=[];
    if(activeExact){score+=1000;reasons.push('EXACT ACTIVE WORK ID/NUMBER');}
    if(exactAddress){score+=400;reasons.push('EXACT ADDRESS');}
    else if(streetCity){score+=280;reasons.push('STREET + CITY');}
    if(task.phoneMatch){score+=320;reasons.push('TASK PHONE');}
    if(task.nameMatch){score+=180;reasons.push('TASK NAME');}

    var daysAfter=null;
    if(submitted&&created){
      daysAfter=(created-submitted)/DAY_MS;
      if(daysAfter>=-1&&daysAfter<=7){score+=180;reasons.push('CREATED WITHIN 7 DAYS');}
      else if(daysAfter>7&&daysAfter<=30){score+=120;reasons.push('CREATED WITHIN 30 DAYS');}
      else if(daysAfter>30&&daysAfter<=60){score+=60;reasons.push('CREATED WITHIN 60 DAYS');}
      else if(daysAfter>60&&daysAfter<=120){score+=25;reasons.push('CREATED WITHIN 120 DAYS');}
    }

    if(!isTerminalWork_(wo['Status'])){score+=40;reasons.push('ACTIVE STATUS');}

    return{
      row:wo,
      id:id,
      number:number,
      status:clean_(wo['Status']),
      createdAt:clean_(wo['Created At']||wo['Sales Order Date']||wo['Scheduled Date']||wo['Completed At']),
      createdMs:created,
      daysAfter:daysAfter,
      exactAddress:exactAddress,
      streetCity:streetCity,
      phoneMatch:task.phoneMatch,
      nameMatch:task.nameMatch,
      taskCount:task.tasks.length,
      activeExact:activeExact,
      score:score,
      reasons:reasons
    };
  }
  function choose_(request,index){
    var cid=customerId_(request);
    if(!cid)return{status:'NO_RESOLVED_CUSTOMER',candidate:null,candidates:[]};

    var durableId=durableId_(request),durableNumber=durableNumber_(request);
    if(durableId||durableNumber){
      var exact=(durableId&&index.workOrdersById[durableId])||(durableNumber&&index.workOrdersByNumber[durableNumber])||null;
      return{
        status:'ALREADY_DURABLE',
        candidate:exact?scoreCandidate_(request,exact,index,activeIdentity_(request)):null,
        candidates:[]
      };
    }

    var workOrders=(index.workOrdersByCustomer[cid]||[]);
    if(!workOrders.length)return{status:'NO_OPERATIONAL_WORK_ORDER',candidate:null,candidates:[]};

    var active=activeIdentity_(request);
    var scored=workOrders.map(function(wo){return scoreCandidate_(request,wo,index,active);}).filter(Boolean);
    if(!scored.length)return{status:'NO_POST_REQUEST_CANDIDATE',candidate:null,candidates:[]};

    scored.sort(function(a,b){
      if(b.score!==a.score)return b.score-a.score;
      if(b.createdMs!==a.createdMs)return b.createdMs-a.createdMs;
      return Number(b.id||0)-Number(a.id||0);
    });

    var top=scored[0],second=scored[1]||null;
    var only=scored.length===1;

    if(top.activeExact){
      var activeCount=scored.filter(function(x){return x.activeExact;}).length;
      if(activeCount===1)return{status:'MATCHED_EXACT_ACTIVE_WORK',candidate:top,candidates:scored};
      return{status:'AMBIGUOUS_ACTIVE_WORK',candidate:null,candidates:scored};
    }

    var strongIdentity=top.phoneMatch||(top.nameMatch&&(top.exactAddress||top.streetCity));
    var strongAddress=top.exactAddress||top.streetCity;
    var temporalStrong=top.daysAfter!==null&&top.daysAfter>=-1&&top.daysAfter<=30;

    if(only&&strongAddress&&top.daysAfter!==null&&top.daysAfter>=-1&&top.daysAfter<=120){
      return{status:'MATCHED_UNIQUE_ADDRESS_TIME',candidate:top,candidates:scored};
    }
    if(only&&strongIdentity&&temporalStrong){
      return{status:'MATCHED_UNIQUE_IDENTITY_TIME',candidate:top,candidates:scored};
    }

    var gap=second?top.score-second.score:top.score;
    if(top.score>=650&&gap>=180&&(top.phoneMatch||top.exactAddress)){
      return{status:'MATCHED_DOMINANT_EVIDENCE',candidate:top,candidates:scored};
    }

    return{status:'AMBIGUOUS_OPERATIONAL_WORK_ORDER',candidate:null,candidates:scored};
  }
  function patchRequest_(request,candidate){
    var id=clean_(candidate.id),number=clean_(candidate.number),status=clean_(candidate.status);
    var patch={
      'Work Order Action':'LINK EXISTING',
      'Work Order Status':status,
      'Work Order ID':id,
      'Work Order Number':number,
      'Work Order Link':id?'https://classicfireplace.striven.com/next/crm#/sales-orders/'+id:''
    };
    CF.Util.patchRow('SERVICE_REQUESTS',request.__rowNumber,patch);
    Object.keys(patch).forEach(function(k){request[k]=patch[k];});
    return patch;
  }
  function enrichExisting_(request,index,persist){
    var id=durableId_(request),number=durableNumber_(request);
    if(!id&&!number)return null;
    var wo=(id&&index.workOrdersById[id])||(number&&index.workOrdersByNumber[number])||null;
    if(!wo)return null;
    var patch={},changed=false;
    if(!clean_(request['Work Order ID'])&&clean_(wo['Work Order ID']||wo['Entity ID'])){patch['Work Order ID']=clean_(wo['Work Order ID']||wo['Entity ID']);changed=true;}
    if(!clean_(request['Work Order Number'])&&clean_(wo['Work Order Number'])){patch['Work Order Number']=clean_(wo['Work Order Number']);changed=true;}
    if(!clean_(request['Work Order Status'])&&clean_(wo['Status'])){patch['Work Order Status']=clean_(wo['Status']);changed=true;}
    if(upper_(request['Work Order Action'])!=='LINK EXISTING'){patch['Work Order Action']='LINK EXISTING';changed=true;}
    var finalId=clean_(patch['Work Order ID']||request['Work Order ID']);
    if(!clean_(request['Work Order Link'])&&finalId){patch['Work Order Link']='https://classicfireplace.striven.com/next/crm#/sales-orders/'+finalId;changed=true;}
    if(changed&&persist){
      CF.Util.patchRow('SERVICE_REQUESTS',request.__rowNumber,patch);
      Object.keys(patch).forEach(function(k){request[k]=patch[k];});
    }
    return{changed:changed,patch:patch,workOrder:wo};
  }
  function run_(requests,operational,options){
    options=options||{};
    var persist=options.persist===true,index=buildIndex_(operational),started=Date.now();
    var result={
      ok:true,version:VERSION,mode:persist?'PERSIST_SAFE_OPERATIONAL_LINKS':'PREVIEW_SAFE_OPERATIONAL_LINKS',
      requestsScanned:0,alreadyDurable:0,enrichedExisting:0,newlyLinked:0,
      taskDetailsAvailable:0,noResolvedCustomer:0,noOperationalWorkOrder:0,
      noPostRequestCandidate:0,ambiguous:0,
      samples:{linked:[],ambiguous:[],noCandidate:[]},
      liveStrivenWriteExecuted:false,sheetWritesExecuted:persist,durationMs:0
    };

    (requests||[]).forEach(function(request){
      result.requestsScanned++;
      var existing=enrichExisting_(request,index,persist);
      if(durableId_(request)||durableNumber_(request)){
        result.alreadyDurable++;
        if(existing&&existing.changed)result.enrichedExisting++;
        var n=durableNumber_(request);
        if(n&&(index.tasksByWorkOrderNumber[n]||[]).length)result.taskDetailsAvailable++;
        return;
      }

      var chosen=choose_(request,index);
      if(!chosen.candidate){
        if(chosen.status==='NO_RESOLVED_CUSTOMER')result.noResolvedCustomer++;
        else if(chosen.status==='NO_OPERATIONAL_WORK_ORDER')result.noOperationalWorkOrder++;
        else if(chosen.status==='NO_POST_REQUEST_CANDIDATE')result.noPostRequestCandidate++;
        else result.ambiguous++;

        var sample={
          requestId:clean_(request['Request ID']),
          customerId:customerId_(request),
          fullName:clean_(request['Full Name']),
          submittedAt:clean_(request['Submitted At']||request['Created At']),
          status:chosen.status,
          topCandidates:(chosen.candidates||[]).slice(0,3).map(function(x){
            return{workOrderId:x.id,workOrderNumber:x.number,status:x.status,createdAt:x.createdAt,score:x.score,reasons:x.reasons};
          })
        };
        if(result.samples.noCandidate.length<12&&(chosen.status==='NO_OPERATIONAL_WORK_ORDER'||chosen.status==='NO_POST_REQUEST_CANDIDATE'))result.samples.noCandidate.push(sample);
        if(result.samples.ambiguous.length<12&&chosen.status.indexOf('AMBIGUOUS')===0)result.samples.ambiguous.push(sample);
        return;
      }

      var c=chosen.candidate;
      if(persist)patchRequest_(request,c);
      result.newlyLinked++;
      if((index.tasksByWorkOrderNumber[c.number]||[]).length)result.taskDetailsAvailable++;
      if(result.samples.linked.length<20){
        result.samples.linked.push({
          requestId:clean_(request['Request ID']),
          customerId:customerId_(request),
          fullName:clean_(request['Full Name']),
          workOrderId:c.id,
          workOrderNumber:c.number,
          workOrderName:clean_(c.row['Work Order Name']),
          workOrderStatus:c.status,
          createdAt:c.createdAt,
          taskCount:(index.tasksByWorkOrderNumber[c.number]||[]).length,
          matchStatus:chosen.status,
          score:c.score,
          reasons:c.reasons
        });
      }
    });

    result.durationMs=Date.now()-started;
    return result;
  }
  function operationalAgeMinutes_(){
    try{
      var sheet=CF.Util.requireSheet('STRIVEN_OPERATIONAL_DATA'),map=CF.Util.getHeaderMap(sheet),col=map['Cache Updated At'];
      if(!col||sheet.getLastRow()<2)return null;
      var raw=sheet.getRange(2,col).getValue(),ms=dateMs_(raw);
      return ms?Math.max(0,(Date.now()-ms)/60000):null;
    }catch(e){return null;}
  }
  function previewAll(){
    var requests=CF.Util.readRecords('SERVICE_REQUESTS');
    var operational=CF.Util.readRecords('STRIVEN_OPERATIONAL_DATA');
    var out=run_(requests,operational,{persist:false});
    out.operationalCacheAgeMinutes=operationalAgeMinutes_();
    return out;
  }
  function reconcileAll(options){
    options=options||{};
    var refreshResult=null,age=operationalAgeMinutes_();
    if((age===null||age>30)&&options.refreshIfStale!==false){
      if(!CF.StrivenData||typeof CF.StrivenData.refreshOperationalData!=='function'){
        throw new Error('CF.StrivenData.refreshOperationalData is unavailable.');
      }
      refreshResult=CF.StrivenData.refreshOperationalData({});
    }
    var requests=CF.Util.readRecords('SERVICE_REQUESTS');
    var operational=CF.Util.readRecords('STRIVEN_OPERATIONAL_DATA');
    var out=run_(requests,operational,{persist:true});
    out.operationalRefresh=refreshResult;
    out.operationalCacheAgeMinutesAfter=operationalAgeMinutes_();
    return out;
  }
  /* CF_SERVICEOPS_REQUEST_SCOPED_OPERATIONAL_RECONCILIATION_R1
   * Same proven candidate scoring, but for exactly one Service Request.
   * No Striven call and no all-request scan. The operational cache remains the
   * evidence source; stale-cache refresh policy stays owned by Sales Order preflight.
   */
  function reconcileRequest(requestId,options){
    options=options||{};
    requestId=clean_(requestId);
    var request=CF.Util.findRecord('SERVICE_REQUESTS','Request ID',requestId);
    if(!request)return{ok:false,version:VERSION,status:'REQUEST_NOT_FOUND',requestId:requestId,liveStrivenWriteExecuted:false,sheetWritesExecuted:false};
    var operational=CF.Util.readRecords('STRIVEN_OPERATIONAL_DATA');
    var out=run_([request],operational,{persist:options.persist!==false});
    out.mode='REQUEST_SCOPED_SAFE_OPERATIONAL_LINK';
    out.requestId=requestId;
    out.operationalCacheAgeMinutes=operationalAgeMinutes_();
    out.liveStrivenWriteExecuted=false;
    return out;
  }
  return{
    version:VERSION,
    previewAll:previewAll,
    reconcileAll:reconcileAll,
    reconcileRequest:reconcileRequest
  };
})();

/************************************************************
 * CF_SERVICEOPS_V5_12_1_AUTO_SO_TASK_QUEUE_RECONCILIATION_R1
 * CF ServiceOps — Automatic Existing SO/Task Queue Reconciliation
 * Version: 5.12.1
 *
 * PURPOSE
 * - After a successful Striven Operational Data refresh, automatically:
 *     1) reconcile PRE-CUTOFF historical Service Requests to EXISTING
 *        Striven Sales Orders/Work Orders using the proven v5.10.16
 *        high-confidence reconciler;
 *     2) refresh 03 Operator Queue so current SO status and related
 *        Tasks appear without a manual reconciliation runner.
 *
 * SAFETY
 * - NO Striven create/update/delete call is added here.
 * - Historical reconciliation only persists Google Sheet linkage fields.
 * - New/current requests (submitted on/after the cutoff) are hidden from
 *   the historical reconciler, so this patch cannot cause a new request
 *   to be linked to an older SO instead of following the guarded workflow.
 * - Existing durable Work Order IDs/numbers remain authoritative.
 * - Ambiguous historical matches remain untouched.
 * - Operational refresh success is fail-soft: a projection/reconciliation
 *   error is logged but does not turn a successful cache refresh into a
 *   failed Striven-data refresh.
 ************************************************************/
(function CF_SERVICEOPS_INSTALL_AUTO_SO_TASK_QUEUE_RECONCILIATION_V5121_R1_() {
  'use strict';

  var VERSION = '5.12.1';
  var MODULE = '50_Operator_Queue';
  var HISTORICAL_CUTOFF_ISO = '2026-09-03T13:30:00-04:00';
  var HISTORICAL_CUTOFF_MS = new Date(HISTORICAL_CUTOFF_ISO).getTime();

  if (
    typeof CF === 'undefined' ||
    !CF.Util ||
    !CF.StrivenData ||
    typeof CF.StrivenData.refreshOperationalData !== 'function' ||
    !CF.OperatorQueue ||
    typeof CF.OperatorQueue.refresh !== 'function'
  ) {
    throw new Error('AUTO_SO_TASK_QUEUE_RECONCILIATION_SETUP_REQUIRED | CF.Util, CF.StrivenData.refreshOperationalData and CF.OperatorQueue.refresh are required.');
  }

  if (
    typeof CF_SERVICEOPS_OPERATIONAL_LINK_RECONCILIATION_V51016_R1_ === 'undefined' ||
    !CF_SERVICEOPS_OPERATIONAL_LINK_RECONCILIATION_V51016_R1_ ||
    typeof CF_SERVICEOPS_OPERATIONAL_LINK_RECONCILIATION_V51016_R1_.reconcileAll !== 'function'
  ) {
    throw new Error('AUTO_SO_TASK_QUEUE_RECONCILIATION_SETUP_REQUIRED | v5.10.16 operational link reconciler is required.');
  }

  if (CF.StrivenData.__autoSoTaskQueueReconciliationV5121R1 === true) return;

  var originalRefreshOperationalData = CF.StrivenData.refreshOperationalData;
  var inPostRefresh = false;

  function clean_(value) {
    return String(value === null || value === undefined ? '' : value).trim();
  }

  function dateMs_(value) {
    if (value instanceof Date && !isNaN(value.getTime())) return value.getTime();
    var text = clean_(value);
    if (!text) return 0;
    var parsed = new Date(text);
    if (!isNaN(parsed.getTime())) return parsed.getTime();
    var match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
    if (!match) return 0;
    var hour = Number(match[4] || 0);
    var minute = Number(match[5] || 0);
    var second = Number(match[6] || 0);
    var ap = clean_(match[7]).toUpperCase();
    if (ap === 'PM' && hour < 12) hour += 12;
    if (ap === 'AM' && hour === 12) hour = 0;
    return new Date(Number(match[3]), Number(match[1]) - 1, Number(match[2]), hour, minute, second, 0).getTime();
  }

  function isHistoricalRequest_(row) {
    var ms = dateMs_(row && (row['Submitted At'] || row['Created At']));
    return !!ms && ms < HISTORICAL_CUTOFF_MS;
  }

  function compactResult_(value) {
    if (!value || typeof value !== 'object') return value || null;
    return {
      ok: value.ok !== false,
      version: value.version || '',
      mode: value.mode || '',
      requestsScanned: Number(value.requestsScanned || 0),
      alreadyDurable: Number(value.alreadyDurable || 0),
      enrichedExisting: Number(value.enrichedExisting || 0),
      newlyLinked: Number(value.newlyLinked || 0),
      taskDetailsAvailable: Number(value.taskDetailsAvailable || 0),
      ambiguous: Number(value.ambiguous || 0),
      noOperationalWorkOrder: Number(value.noOperationalWorkOrder || 0),
      noPostRequestCandidate: Number(value.noPostRequestCandidate || 0),
      activeRequests: Number(value.activeRequests || 0),
      operationalRowsRead: Number(value.operationalRowsRead || 0),
      historicalServiceRequestsScanned: Number(value.historicalServiceRequestsScanned || 0),
      newCurrentRequestsExcluded: Number(value.newCurrentRequestsExcluded || 0),
      durationMs: Number(value.durationMs || 0),
      liveStrivenWriteExecuted: value.liveStrivenWriteExecuted === true,
      liveWritesAllowed: value.liveWritesAllowed === true
    };
  }

  function log_(status, details, error) {
    try {
      if (CF.Util && typeof CF.Util.logEvent === 'function') {
        CF.Util.logEvent({
          module: MODULE,
          action: 'AUTO_SO_TASK_QUEUE_RECONCILIATION',
          status: status,
          message: error ? String(error && error.message ? error.message : error) : '',
          details: details || {},
          version: VERSION
        });
      } else if (typeof console !== 'undefined' && console.log) {
        console.log('AUTO_SO_TASK_QUEUE_RECONCILIATION ' + status + ' ' + JSON.stringify(details || {}));
      }
    } catch (ignored) {}
  }

  function reconcileHistoricalOnly_() {
    var originalReadRecords = CF.Util.readRecords;
    if (typeof originalReadRecords !== 'function') {
      throw new Error('CF.Util.readRecords is required for historical reconciliation.');
    }

    var totalRequests = 0;
    var historicalRequests = 0;

    CF.Util.readRecords = function (key) {
      var rows = originalReadRecords.apply(CF.Util, arguments);
      if (String(key || '') !== 'SERVICE_REQUESTS') return rows;
      rows = Array.isArray(rows) ? rows : [];
      totalRequests = rows.length;
      var filtered = rows.filter(isHistoricalRequest_);
      historicalRequests = filtered.length;
      return filtered;
    };

    try {
      var result = CF_SERVICEOPS_OPERATIONAL_LINK_RECONCILIATION_V51016_R1_.reconcileAll({
        refreshIfStale: false
      });
      if (result && typeof result === 'object') {
        result.autoHistoricalCutoff = HISTORICAL_CUTOFF_ISO;
        result.totalServiceRequestsVisibleBeforeFilter = totalRequests;
        result.historicalServiceRequestsScanned = historicalRequests;
        result.newCurrentRequestsExcluded = Math.max(0, totalRequests - historicalRequests);
        result.strivenMutationExecuted = false;
        result.liveWriteExecuted = false;
      }
      return result;
    } finally {
      CF.Util.readRecords = originalReadRecords;
    }
  }

  CF.StrivenData.refreshOperationalDataBeforeV5121R1 = originalRefreshOperationalData;

  CF.StrivenData.refreshOperationalData = function (options) {
    var refreshResult = originalRefreshOperationalData.apply(CF.StrivenData, arguments);

    if (inPostRefresh) return refreshResult;

    var post = {
      ok: true,
      version: VERSION,
      mode: 'OPERATIONAL_REFRESH_TO_HISTORICAL_RECONCILIATION_TO_QUEUE',
      historicalCutoff: HISTORICAL_CUTOFF_ISO,
      strivenMutationExecuted: false,
      reconciliation: null,
      queueRefresh: null
    };

    if (!refreshResult || refreshResult.ok === false) {
      post.ok = false;
      post.status = 'SKIPPED_OPERATIONAL_REFRESH_NOT_SUCCESSFUL';
      if (refreshResult && typeof refreshResult === 'object') refreshResult.autoSoTaskQueueReconciliation = post;
      log_(post.status, post, null);
      return refreshResult;
    }

    inPostRefresh = true;
    try {
      try {
        post.reconciliation = compactResult_(reconcileHistoricalOnly_());
      } catch (reconcileError) {
        post.ok = false;
        post.reconciliation = {
          ok: false,
          error: String(reconcileError && reconcileError.message ? reconcileError.message : reconcileError)
        };
      }

      try {
        post.queueRefresh = compactResult_(CF.OperatorQueue.refresh());
      } catch (queueError) {
        post.ok = false;
        post.queueRefresh = {
          ok: false,
          error: String(queueError && queueError.message ? queueError.message : queueError)
        };
      }

      post.status = post.ok ? 'COMPLETE' : 'COMPLETE_WITH_PROJECTION_WARNING';
      if (refreshResult && typeof refreshResult === 'object') refreshResult.autoSoTaskQueueReconciliation = post;
      log_(post.status, post, post.ok ? null : 'One or more post-refresh projection steps reported a warning.');
      return refreshResult;
    } finally {
      inPostRefresh = false;
    }
  };

  CF.StrivenData.__autoSoTaskQueueReconciliationV5121R1 = true;
  CF.StrivenData.__autoSoTaskQueueReconciliationConfigV5121R1 = {
    version: VERSION,
    historicalCutoff: HISTORICAL_CUTOFF_ISO,
    historicalReconciliation: 'GOOGLE_SHEET_LINKAGE_ONLY',
    currentRequestPolicy: 'EXCLUDED_FROM_HISTORICAL_RECONCILER',
    queueRefreshAfterOperationalRefresh: true,
    strivenMutationAddedByPatch: false
  };

})();

/************************************************************
 * CF_SERVICEOPS_V5_12_2_ALL_EXISTING_QUEUE_RECONCILIATION_R1
 * CF ServiceOps — All Existing Operator Queue SO/Task Reconciliation
 * Version: 5.12.2
 *
 * PURPOSE
 * - Ignore request dates for Operator Queue reconciliation.
 * - Treat every row already present in 03 Operator Queue as in-scope.
 * - Project EXISTING Striven Sales Orders/Work Orders from the current
 *   06 Striven Operational Data cache using deterministic evidence.
 * - Show ALL unique Tasks tied to the exact projected Sales Order number.
 *
 * SAFETY
 * - This patch NEVER creates/updates/deletes a Striven record.
 * - This patch does NOT create historical Sales Orders or Tasks.
 * - This patch does NOT add or remove Operator Queue columns.
 * - Existing durable Work Order ID/number on 02 Service Requests wins.
 * - A blank historical row is only linked by fallback when there is
 *   strong service-address evidence plus either the same resolved Customer
 *   or unique Task identity evidence (phone/name).
 * - Customer-only matching is explicitly forbidden.
 * - Ambiguous matches stay blank/unchanged.
 * - Only 03 Operator Queue columns H and I are post-projected.
 ************************************************************/
var CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5122_R1_ = (function () {
  'use strict';

  var VERSION = '5.12.2';
  var MODULE = '50_Operator_Queue';
  var ORDER_COLUMN = 8;
  var TASK_COLUMN = 9;

  function clean_(value) {
    return String(value === null || value === undefined ? '' : value).trim();
  }

  function upper_(value) {
    return clean_(value).toUpperCase();
  }

  function digits_(value) {
    var s = clean_(value).replace(/\D/g, '');
    return s.length > 10 ? s.slice(-10) : s;
  }

  function normalizeWords_(value) {
    return upper_(value)
      .replace(/&/g, ' AND ')
      .replace(/[^A-Z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeStreet_(value) {
    var s = upper_(value).split(',')[0]
      .replace(/\bST\.?\b/g, 'STREET')
      .replace(/\bRD\.?\b/g, 'ROAD')
      .replace(/\bDR\.?\b/g, 'DRIVE')
      .replace(/\bAVE\.?\b/g, 'AVENUE')
      .replace(/\bAV\.?\b/g, 'AVENUE')
      .replace(/\bBLVD\.?\b/g, 'BOULEVARD')
      .replace(/\bCRES\.?\b/g, 'CRESCENT')
      .replace(/\bCT\.?\b/g, 'COURT')
      .replace(/\bPL\.?\b/g, 'PLACE')
      .replace(/\bLN\.?\b/g, 'LANE')
      .replace(/\bTRL\.?\b/g, 'TRAIL')
      .replace(/\bPKWY\.?\b/g, 'PARKWAY')
      .replace(/\bHWY\.?\b/g, 'HIGHWAY')
      .replace(/\bN\.?\b/g, 'NORTH')
      .replace(/\bS\.?\b/g, 'SOUTH')
      .replace(/\bE\.?\b/g, 'EAST')
      .replace(/\bW\.?\b/g, 'WEST')
      .replace(/[^A-Z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return s;
  }

  function postal_(value) {
    var text = upper_(value).replace(/\s+/g, '');
    var m = text.match(/[A-Z]\d[A-Z]\d[A-Z]\d/);
    return m ? m[0] : '';
  }

  function requestStreet_(row) {
    return normalizeStreet_(row && (row['Street'] || row['Full Address'] || row['Matched Location Address']));
  }

  function requestPostal_(row) {
    return postal_(row && (row['Normalized Postal'] || row['Postal Code'] || row['Full Address'] || row['Matched Location Address']));
  }

  function workStreet_(row) {
    return normalizeStreet_(row && row['Service Address']);
  }

  function workPostal_(row) {
    return postal_(row && row['Service Address']);
  }

  function addressEvidence_(request, workOrder) {
    var rs = requestStreet_(request);
    var ws = workStreet_(workOrder);
    var rp = requestPostal_(request);
    var wp = workPostal_(workOrder);
    var street = !!rs && !!ws && rs === ws;
    var post = !!rp && !!wp && rp === wp;
    return {
      street: street,
      postal: post,
      strong: street && post,
      requestStreet: rs,
      workStreet: ws,
      requestPostal: rp,
      workPostal: wp
    };
  }

  function taskOrderNumber_(row) {
    var direct = clean_(row && row['Work Order Number']);
    if (direct) return direct;
    var text = clean_(row && (row['Task Name'] || row['Description']));
    var m = text.match(/\bSO\s*#?\s*(\d{4,})\b/i);
    return m ? clean_(m[1]) : '';
  }

  function taskId_(row) {
    return clean_(row && (row['Task ID'] || row['Entity ID']));
  }

  function workId_(row) {
    return clean_(row && (row['Work Order ID'] || row['Entity ID']));
  }

  function workNumber_(row) {
    return clean_(row && (row['Work Order Number'] || workId_(row)));
  }

  function richness_(row) {
    if (!row) return 0;
    var score = 0;
    ['Customer ID','Location ID','Work Order ID','Work Order Number','Task ID','Task Name','Service Address','Status'].forEach(function (key) {
      if (clean_(row[key])) score++;
    });
    if (upper_(row['Entity Type']) === 'TASK_RELATIONSHIP') score += 2;
    return score;
  }

  function mergeTask_(a, b) {
    if (!a) return b;
    if (!b) return a;
    var primary = richness_(b) > richness_(a) ? b : a;
    var secondary = primary === a ? b : a;
    var out = {};
    Object.keys(secondary).forEach(function (key) { out[key] = secondary[key]; });
    Object.keys(primary).forEach(function (key) {
      if (clean_(primary[key]) || !clean_(out[key])) out[key] = primary[key];
    });
    return out;
  }

  function buildIndex_(operationalRows) {
    var index = {
      works: [],
      workById: {},
      workByNumber: {},
      tasksByWorkOrderNumber: {}
    };
    var taskMaps = {};

    (operationalRows || []).forEach(function (row) {
      var type = upper_(row['Entity Type']);
      if (type === 'WORK_ORDER') {
        var id = workId_(row);
        var number = workNumber_(row);
        index.works.push(row);
        if (id) index.workById[id] = row;
        if (number) index.workByNumber[number] = row;
        return;
      }
      if (type !== 'TASK' && type !== 'TASK_RELATIONSHIP') return;
      var orderNumber = taskOrderNumber_(row);
      var idTask = taskId_(row);
      if (!orderNumber || !idTask) return;
      if (!taskMaps[orderNumber]) taskMaps[orderNumber] = {};
      taskMaps[orderNumber][idTask] = mergeTask_(taskMaps[orderNumber][idTask], row);
    });

    Object.keys(taskMaps).forEach(function (number) {
      index.tasksByWorkOrderNumber[number] = Object.keys(taskMaps[number]).map(function (id) {
        return taskMaps[number][id];
      });
    });
    return index;
  }

  function requestCustomerId_(row) {
    return clean_(row && (row['Matched Customer ID'] || row['Created Customer ID']));
  }

  function requestName_(row) {
    return normalizeWords_(row && row['Full Name']);
  }

  function taskIdentity_(request, workOrder, index) {
    var number = workNumber_(workOrder);
    var tasks = (index.tasksByWorkOrderNumber[number] || []).slice();
    var phoneValues = [digits_(request && rowValue_(request, 'Phone')), digits_(request && rowValue_(request, 'Alt Phone'))].filter(Boolean);
    var name = requestName_(request);
    var nameTokens = name ? name.split(' ').filter(function (x) { return x && x !== 'AND'; }) : [];
    var first = nameTokens.length ? nameTokens[0] : '';
    var last = nameTokens.length > 1 ? nameTokens[nameTokens.length - 1] : '';
    var phoneMatch = false;
    var nameMatch = false;

    tasks.forEach(function (task) {
      var taskText = clean_(task['Task Name'] || task['Description']);
      var taskDigits = digits_(taskText);
      if (taskDigits && phoneValues.indexOf(taskDigits) !== -1) phoneMatch = true;
      var taskNorm = normalizeWords_(taskText);
      if (first && last && taskNorm.indexOf(first) !== -1 && taskNorm.indexOf(last) !== -1) nameMatch = true;
    });
    return { phoneMatch: phoneMatch, nameMatch: nameMatch, tasks: tasks };
  }

  function rowValue_(row, key) {
    return row && Object.prototype.hasOwnProperty.call(row, key) ? row[key] : '';
  }

  function candidateEvidence_(request, workOrder, index) {
    var address = addressEvidence_(request, workOrder);
    if (!address.strong) return null;
    var identity = taskIdentity_(request, workOrder, index);
    var requestCustomer = requestCustomerId_(request);
    var workCustomer = clean_(workOrder['Customer ID']);
    var sameCustomer = !!requestCustomer && !!workCustomer && requestCustomer === workCustomer;
    var score = 600;
    if (sameCustomer) score += 300;
    if (identity.phoneMatch) score += 500;
    if (identity.nameMatch) score += 250;
    return {
      row: workOrder,
      score: score,
      sameCustomer: sameCustomer,
      phoneMatch: identity.phoneMatch,
      nameMatch: identity.nameMatch,
      taskCount: identity.tasks.length
    };
  }

  function safeFallbackOrder_(request, index) {
    if (!request || !requestStreet_(request) || !requestPostal_(request)) {
      return {status:'NO_STRONG_ADDRESS', row:null, evidence:null};
    }

    var candidates = [];
    (index.works || []).forEach(function (wo) {
      var evidence = candidateEvidence_(request, wo, index);
      if (evidence) candidates.push(evidence);
    });
    if (!candidates.length) return {status:'NO_OPERATIONAL_MATCH', row:null, evidence:null};

    var sameCustomer = candidates.filter(function (c) { return c.sameCustomer; });
    if (sameCustomer.length === 1) {
      return {status:'MATCHED_UNIQUE_EXACT_ADDRESS_SAME_CUSTOMER_NO_DATE', row:sameCustomer[0].row, evidence:sameCustomer[0]};
    }
    if (sameCustomer.length > 1) candidates = sameCustomer;

    var identity = candidates.filter(function (c) { return c.phoneMatch || c.nameMatch; });
    if (!identity.length) return {status:'AMBIGUOUS_EXACT_ADDRESS_NO_IDENTITY', row:null, evidence:null, candidateCount:candidates.length};

    identity.sort(function (a, b) { return b.score - a.score; });
    var top = identity[0];
    var second = identity.length > 1 ? identity[1] : null;
    if (!second || top.score > second.score) {
      var reason = top.phoneMatch ? 'MATCHED_UNIQUE_EXACT_ADDRESS_TASK_PHONE_NO_DATE' : 'MATCHED_UNIQUE_EXACT_ADDRESS_TASK_NAME_NO_DATE';
      return {status:reason, row:top.row, evidence:top};
    }
    return {status:'AMBIGUOUS_EXACT_ADDRESS_TASK_IDENTITY', row:null, evidence:null, candidateCount:identity.length};
  }

  function parseOrderNumber_(text) {
    var m = clean_(text).match(/#(\d{4,})\b/);
    return m ? clean_(m[1]) : '';
  }

  function exactOrder_(request, currentOrderText, index) {
    var currentNumber = parseOrderNumber_(currentOrderText);
    if (currentNumber && index.workByNumber[currentNumber]) {
      return {status:'CURRENT_QUEUE_EXACT_NUMBER', row:index.workByNumber[currentNumber]};
    }
    var requestId = clean_(request && request['Work Order ID']);
    if (requestId && index.workById[requestId]) {
      return {status:'SERVICE_REQUEST_EXACT_ID', row:index.workById[requestId]};
    }
    var requestNumber = clean_(request && request['Work Order Number']);
    if (requestNumber && index.workByNumber[requestNumber]) {
      return {status:'SERVICE_REQUEST_EXACT_NUMBER', row:index.workByNumber[requestNumber]};
    }
    return {status:'NONE', row:null};
  }

  function resolveOrder_(request, currentOrderText, index) {
    var exact = exactOrder_(request, currentOrderText, index);
    if (exact.row) return exact;
    if (clean_(request && (request['Work Order ID'] || request['Work Order Number']))) {
      return {status:'DURABLE_NOT_IN_OPERATIONAL_CACHE', row:null, preserveCurrent:true};
    }
    return safeFallbackOrder_(request, index);
  }

  function statusRank_(row) {
    var s = upper_(row && row['Status']);
    if (s === 'OPEN' || s === 'IN PROGRESS') return 0;
    if (s === 'SCHEDULED' || s === 'ASSIGNED') return 1;
    if (s === 'ON HOLD' || s === 'PENDING') return 2;
    if (s === 'DONE' || s === 'COMPLETED' || s === 'CLOSED') return 3;
    return 4;
  }

  function tasksForOrder_(workOrder, index) {
    if (!workOrder) return [];
    var number = workNumber_(workOrder);
    var rows = (index.tasksByWorkOrderNumber[number] || []).slice();
    rows.sort(function (a, b) {
      var rank = statusRank_(a) - statusRank_(b);
      if (rank) return rank;
      var ai = Number(taskId_(a) || 0);
      var bi = Number(taskId_(b) || 0);
      if (isFinite(ai) && isFinite(bi) && ai !== bi) return ai - bi;
      return taskId_(a).localeCompare(taskId_(b));
    });
    return rows;
  }

  function strivenUrl_(type, id) {
    id = clean_(id);
    if (!id) return '';
    if (type === 'ORDER') return 'https://classicfireplace.striven.com/next/crm#/sales-orders/' + encodeURIComponent(id);
    if (type === 'TASK') return 'https://classicfireplace.striven.com/Tasks/TaskInfo.aspx?nav=1&TaskID=' + encodeURIComponent(id);
    return '';
  }

  function statusColor_(status) {
    var s = upper_(status);
    if (/CANCEL|DECLIN|VOID|ERROR|BLOCK/.test(s)) return '#cc0000';
    if (/COMPLET|DONE|CLOSED/.test(s)) return '#38761d';
    if (/IN PROGRESS|APPROVED|SCHEDULED|ASSIGNED|OPEN/.test(s)) return '#1155cc';
    if (/QUOTED|PENDING|HOLD|REVIEW|INCOMPLETE/.test(s)) return '#b45f06';
    return '#666666';
  }

  function orderRich_(workOrder) {
    var id = workId_(workOrder);
    var number = workNumber_(workOrder);
    var name = clean_(workOrder && (workOrder['Work Order Name'] || workOrder['Description'])) || 'Sales Order';
    var status = clean_(workOrder && workOrder['Status']);
    var first = [(number ? '#' + number : ''), name].filter(Boolean).join(' - ');
    var text = status ? first + '\n' + status : first;
    var builder = SpreadsheetApp.newRichTextValue().setText(text);
    if (first && id) builder.setLinkUrl(0, first.length, strivenUrl_('ORDER', id));
    if (status) {
      var start = first.length + 1;
      builder.setTextStyle(start, start + status.length,
        SpreadsheetApp.newTextStyle().setBold(true).setForegroundColor(statusColor_(status)).build());
    }
    return {rich:builder.build(), text:text, number:number, status:status};
  }

  function taskLine_(task) {
    var id = taskId_(task);
    var name = clean_(task && (task['Task Name'] || task['Description'])) || 'Task';
    var status = clean_(task && task['Status']);
    if (name.length > 150) name = name.slice(0, 147) + '...';
    return {id:id, name:name, status:status, text:[(id ? '#' + id : ''), name, status].filter(Boolean).join(' - ')};
  }

  function tasksRich_(tasks) {
    if (!tasks || !tasks.length) {
      return SpreadsheetApp.newRichTextValue().setText('—').build();
    }
    var lines = tasks.map(taskLine_);
    var text = lines.map(function (line) { return line.text; }).join('\n');
    var builder = SpreadsheetApp.newRichTextValue().setText(text);
    var offset = 0;
    lines.forEach(function (line) {
      var end = offset + line.text.length;
      if (line.id) builder.setLinkUrl(offset, end, strivenUrl_('TASK', line.id));
      if (line.status) {
        var statusStart = end - line.status.length;
        builder.setTextStyle(statusStart, end,
          SpreadsheetApp.newTextStyle().setBold(true).setForegroundColor(statusColor_(line.status)).build());
      }
      offset = end + 1;
    });
    return builder.build();
  }

  function serviceRequestMap_(rows) {
    var map = {};
    (rows || []).forEach(function (row) {
      var id = clean_(row['Request ID']);
      if (id) map[id] = row;
    });
    return map;
  }

  function compact_(value) {
    if (!value || typeof value !== 'object') return value || null;
    return {
      ok: value.ok !== false,
      version: value.version || '',
      mode: value.mode || '',
      queueRowsScanned: Number(value.queueRowsScanned || 0),
      exactOrdersProjected: Number(value.exactOrdersProjected || 0),
      safeFallbackOrdersProjected: Number(value.safeFallbackOrdersProjected || 0),
      ambiguousRows: Number(value.ambiguousRows || 0),
      noMatchRows: Number(value.noMatchRows || 0),
      taskRowsProjected: Number(value.taskRowsProjected || 0),
      totalTasksProjected: Number(value.totalTasksProjected || 0),
      multiTaskRows: Number(value.multiTaskRows || 0),
      sheetWritesExecuted: value.sheetWritesExecuted === true,
      strivenMutationExecuted: false,
      liveStrivenWriteExecuted: false,
      durationMs: Number(value.durationMs || 0)
    };
  }

  function log_(status, details, error) {
    try {
      if (CF.Util && typeof CF.Util.logEvent === 'function') {
        CF.Util.logEvent({
          module: MODULE,
          action: 'ALL_EXISTING_QUEUE_RECONCILIATION',
          status: status,
          message: error ? String(error && error.message ? error.message : error) : '',
          details: compact_(details),
          version: VERSION
        });
      }
    } catch (ignored) {}
  }

  function project(options) {
    options = options || {};
    var started = Date.now();
    var write = options.write === true;
    var serviceRequests = options.serviceRequests || CF.Util.readRecords('SERVICE_REQUESTS') || [];
    var operationalRows = options.operationalRows || CF.Util.readRecords('STRIVEN_OPERATIONAL_DATA') || [];
    var sheet = CF.Util.requireSheet('OPERATOR_QUEUE');
    var lastRow = sheet.getLastRow();
    var out = {
      ok:true,
      version:VERSION,
      mode:'ALL_EXISTING_OPERATOR_QUEUE_ROWS_READ_ONLY_STRIVEN_PROJECTION',
      queueRowsScanned:0,
      exactOrdersProjected:0,
      safeFallbackOrdersProjected:0,
      ambiguousRows:0,
      noMatchRows:0,
      taskRowsProjected:0,
      totalTasksProjected:0,
      multiTaskRows:0,
      sheetWritesExecuted:false,
      strivenMutationExecuted:false,
      liveStrivenWriteExecuted:false,
      liveWritesAllowed:false,
      matchingRules:[
        'EXACT_DURABLE_ORDER_ID_OR_NUMBER',
        'UNIQUE_EXACT_STREET_POSTAL_PLUS_SAME_CUSTOMER',
        'UNIQUE_EXACT_STREET_POSTAL_PLUS_TASK_PHONE_OR_NAME',
        'NEVER_CUSTOMER_ONLY',
        'AMBIGUOUS_STAYS_UNCHANGED'
      ]
    };
    if (lastRow < 2) {
      out.durationMs = Date.now() - started;
      return out;
    }

    var count = lastRow - 1;
    var queueValues = sheet.getRange(2, 1, count, TASK_COLUMN).getDisplayValues();
    var oldOrderRich = sheet.getRange(2, ORDER_COLUMN, count, 1).getRichTextValues();
    var oldTaskRich = sheet.getRange(2, TASK_COLUMN, count, 1).getRichTextValues();
    var requestMap = serviceRequestMap_(serviceRequests);
    var index = buildIndex_(operationalRows);
    var orderRichValues = [];
    var taskRichValues = [];

    queueValues.forEach(function (queueRow, i) {
      var requestId = clean_(queueRow[0]);
      var currentOrderText = clean_(queueRow[ORDER_COLUMN - 1]);
      var request = requestMap[requestId] || null;
      out.queueRowsScanned++;

      if (!request) {
        orderRichValues.push([oldOrderRich[i][0]]);
        taskRichValues.push([oldTaskRich[i][0]]);
        out.noMatchRows++;
        return;
      }

      var resolved = resolveOrder_(request, currentOrderText, index);
      if (!resolved.row) {
        orderRichValues.push([oldOrderRich[i][0]]);
        taskRichValues.push([oldTaskRich[i][0]]);
        if (/^AMBIGUOUS/.test(resolved.status)) out.ambiguousRows++;
        else out.noMatchRows++;
        return;
      }

      if (/^(CURRENT_QUEUE_EXACT|SERVICE_REQUEST_EXACT)/.test(resolved.status)) out.exactOrdersProjected++;
      else out.safeFallbackOrdersProjected++;

      var orderProjection = orderRich_(resolved.row);
      var tasks = tasksForOrder_(resolved.row, index);
      orderRichValues.push([orderProjection.rich]);
      taskRichValues.push([tasksRich_(tasks)]);
      if (tasks.length) out.taskRowsProjected++;
      out.totalTasksProjected += tasks.length;
      if (tasks.length > 1) out.multiTaskRows++;
    });

    if (write && count) {
      sheet.getRange(2, ORDER_COLUMN, count, 1).setRichTextValues(orderRichValues);
      sheet.getRange(2, TASK_COLUMN, count, 1).setRichTextValues(taskRichValues);
      out.sheetWritesExecuted = true;
    }
    out.durationMs = Date.now() - started;
    return out;
  }

  return {
    version: VERSION,
    buildIndex: buildIndex_,
    resolveOrder: resolveOrder_,
    tasksForOrder: tasksForOrder_,
    project: project,
    compact: compact_,
    log: log_
  };
})();

(function CF_SERVICEOPS_INSTALL_ALL_EXISTING_QUEUE_RECONCILIATION_V5122_R1_() {
  'use strict';
  var VERSION = '5.12.2';

  if (
    typeof CF === 'undefined' ||
    !CF.Util || typeof CF.Util.readRecords !== 'function' || typeof CF.Util.requireSheet !== 'function' ||
    !CF.OperatorQueue || typeof CF.OperatorQueue.refresh !== 'function' ||
    typeof SpreadsheetApp === 'undefined'
  ) {
    throw new Error('ALL_EXISTING_QUEUE_RECONCILIATION_SETUP_REQUIRED | CF.Util, CF.OperatorQueue.refresh and SpreadsheetApp are required.');
  }

  if (CF.OperatorQueue.__allExistingQueueReconciliationV5122R1 === true) return;

  var originalRefresh = CF.OperatorQueue.refresh;
  var originalReadRecords = CF.Util.readRecords;
  var inWrapper = false;

  CF.OperatorQueue.refreshBeforeV5122R1 = originalRefresh;
  CF.OperatorQueue.refresh = function () {
    if (inWrapper) return originalRefresh.apply(CF.OperatorQueue, arguments);
    inWrapper = true;
    var capturedServiceRequests = null;
    var capturedOperational = null;
    var baseResult = null;
    try {
      CF.Util.readRecords = function (key) {
        var rows = originalReadRecords.apply(CF.Util, arguments);
        var name = String(key || '');
        if (name === 'SERVICE_REQUESTS' && !capturedServiceRequests) capturedServiceRequests = rows;
        if (name === 'STRIVEN_OPERATIONAL_DATA' && !capturedOperational) capturedOperational = rows;
        return rows;
      };

      baseResult = originalRefresh.apply(CF.OperatorQueue, arguments);
    } finally {
      CF.Util.readRecords = originalReadRecords;
    }

    try {
      if (baseResult && baseResult.ok === false) return baseResult;
      var projection = CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5122_R1_.project({
        write:true,
        serviceRequests:capturedServiceRequests || originalReadRecords.call(CF.Util, 'SERVICE_REQUESTS'),
        operationalRows:capturedOperational || originalReadRecords.call(CF.Util, 'STRIVEN_OPERATIONAL_DATA')
      });
      if (baseResult && typeof baseResult === 'object') {
        baseResult.allExistingQueueReconciliation = CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5122_R1_.compact(projection);
        baseResult.strivenMutationExecuted = false;
        baseResult.liveStrivenWriteExecuted = false;
      }
      CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5122_R1_.log('COMPLETE', projection, null);
      return baseResult || projection;
    } catch (projectionError) {
      var warning = {
        ok:false,
        version:VERSION,
        mode:'ALL_EXISTING_OPERATOR_QUEUE_ROWS_READ_ONLY_STRIVEN_PROJECTION',
        strivenMutationExecuted:false,
        liveStrivenWriteExecuted:false,
        error:String(projectionError && projectionError.message ? projectionError.message : projectionError)
      };
      if (baseResult && typeof baseResult === 'object') baseResult.allExistingQueueReconciliation = warning;
      CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5122_R1_.log('PROJECTION_WARNING', warning, projectionError);
      return baseResult || warning;
    } finally {
      inWrapper = false;
    }
  };

  CF.OperatorQueue.__allExistingQueueReconciliationV5122R1 = true;
  CF.OperatorQueue.__allExistingQueueReconciliationConfigV5122R1 = {
    version:VERSION,
    queueScope:'EVERY_EXISTING_ROW_IN_03_OPERATOR_QUEUE_NO_DATE_FILTER',
    historicalStrivenCreatesAllowed:false,
    historicalTaskCreatesAllowed:false,
    newColumnsAdded:false,
    customerOnlyGuessingAllowed:false,
    exactAddressPlusEvidenceFallback:true,
    allTasksPerExactSalesOrder:true,
    targetColumns:['Sales Order / Work Order','Task']
  };
})();

function TESTING_20260903_allExistingQueueReconciliationStatus() {
  var result = CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5122_R1_.project({write:false});
  result.liveWriteExecuted = false;
  result.liveStrivenWriteExecuted = false;
  result.strivenMutationExecuted = false;
  return result;
}

function FIX_20260903_reconcileAllExistingOperatorQueue() {
  if (!CF || !CF.OperatorQueue || !CF.OperatorQueue.__allExistingQueueReconciliationV5122R1) {
    throw new Error('v5.12.2 All Existing Queue Reconciliation patch is not loaded.');
  }
  var result = CF.OperatorQueue.refresh();
  return {
    ok: !result || result.ok !== false,
    version:'5.12.2',
    status:'ALL_EXISTING_OPERATOR_QUEUE_RECONCILED',
    queueRefresh:result || null,
    liveWriteExecuted:false,
    liveStrivenWriteExecuted:false,
    strivenMutationExecuted:false
  };
}

/************************************************************
 * CF_SERVICEOPS_V5_12_4_TEMPORAL_IDENTITY_TIEBREAK_R1
 * CF ServiceOps — Temporal Identity Tiebreak + Newsletter Tracking foundation
 * Version: 5.12.4
 *
 * PURPOSE
 * - Keep every existing Operator Queue row in scope regardless of date.
 * - Use request/order timestamps only as deterministic identity evidence.
 * - Treat every row already present in 03 Operator Queue as in-scope.
 * - Project EXISTING Striven Sales Orders/Work Orders from the current
 *   06 Striven Operational Data cache using deterministic evidence.
 * - Show ALL unique Tasks tied to the exact projected Sales Order number.
 *
 * SAFETY
 * - This patch NEVER creates/updates/deletes a Striven record.
 * - This patch does NOT create historical Sales Orders or Tasks.
 * - This patch does NOT add or remove Operator Queue columns.
 * - Existing durable Work Order ID/number on 02 Service Requests wins.
 * - A blank historical row is only linked by fallback when there is
 *   strong service-address evidence plus either the same resolved Customer
 *   or unique Task identity evidence (phone/name).
 * - Customer-only matching is explicitly forbidden.
 * - If multiple same-address orders exist, prefer the nearest qualifying order
 *   created within 14 days after the request; far/prior dated orders do not auto-link.
 * - Ambiguous matches stay blank/unchanged.
 * - Only 03 Operator Queue columns H and I are post-projected.
 ************************************************************/
var CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5124_R1_ = (function () {
  'use strict';

  var VERSION = '5.12.4';
  var MODULE = '50_Operator_Queue';
  var ORDER_COLUMN = 8;
  var TASK_COLUMN = 9;

  function clean_(value) {
    return String(value === null || value === undefined ? '' : value).trim();
  }

  function upper_(value) {
    return clean_(value).toUpperCase();
  }

  function digits_(value) {
    var s = clean_(value).replace(/\D/g, '');
    return s.length > 10 ? s.slice(-10) : s;
  }

  function normalizeWords_(value) {
    return upper_(value)
      .replace(/&/g, ' AND ')
      .replace(/[^A-Z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeStreet_(value) {
    var s = upper_(value).split(',')[0]
      .replace(/\bST\.?\b/g, 'STREET')
      .replace(/\bRD\.?\b/g, 'ROAD')
      .replace(/\bDR\.?\b/g, 'DRIVE')
      .replace(/\bAVE\.?\b/g, 'AVENUE')
      .replace(/\bAV\.?\b/g, 'AVENUE')
      .replace(/\bBLVD\.?\b/g, 'BOULEVARD')
      .replace(/\bCRES\.?\b/g, 'CRESCENT')
      .replace(/\bCT\.?\b/g, 'COURT')
      .replace(/\bPL\.?\b/g, 'PLACE')
      .replace(/\bLN\.?\b/g, 'LANE')
      .replace(/\bTRL\.?\b/g, 'TRAIL')
      .replace(/\bPKWY\.?\b/g, 'PARKWAY')
      .replace(/\bHWY\.?\b/g, 'HIGHWAY')
      .replace(/\bN\.?\b/g, 'NORTH')
      .replace(/\bS\.?\b/g, 'SOUTH')
      .replace(/\bE\.?\b/g, 'EAST')
      .replace(/\bW\.?\b/g, 'WEST')
      .replace(/[^A-Z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return s;
  }

  function postal_(value) {
    var text = upper_(value).replace(/\s+/g, '');
    var m = text.match(/[A-Z]\d[A-Z]\d[A-Z]\d/);
    return m ? m[0] : '';
  }

  function requestStreet_(row) {
    return normalizeStreet_(row && (row['Street'] || row['Full Address'] || row['Matched Location Address']));
  }

  function requestPostal_(row) {
    return postal_(row && (row['Normalized Postal'] || row['Postal Code'] || row['Full Address'] || row['Matched Location Address']));
  }

  function workStreet_(row) {
    return normalizeStreet_(row && row['Service Address']);
  }

  function workPostal_(row) {
    return postal_(row && row['Service Address']);
  }

  function addressEvidence_(request, workOrder) {
    var rs = requestStreet_(request);
    var ws = workStreet_(workOrder);
    var rp = requestPostal_(request);
    var wp = workPostal_(workOrder);
    var street = !!rs && !!ws && rs === ws;
    var post = !!rp && !!wp && rp === wp;
    return {
      street: street,
      postal: post,
      strong: street && post,
      requestStreet: rs,
      workStreet: ws,
      requestPostal: rp,
      workPostal: wp
    };
  }

  function taskOrderNumber_(row) {
    var direct = clean_(row && row['Work Order Number']);
    if (direct) return direct;
    var text = clean_(row && (row['Task Name'] || row['Description']));
    var m = text.match(/\bSO\s*#?\s*(\d{4,})\b/i);
    return m ? clean_(m[1]) : '';
  }

  function taskId_(row) {
    return clean_(row && (row['Task ID'] || row['Entity ID']));
  }

  function workId_(row) {
    return clean_(row && (row['Work Order ID'] || row['Entity ID']));
  }

  function workNumber_(row) {
    return clean_(row && (row['Work Order Number'] || workId_(row)));
  }

  function richness_(row) {
    if (!row) return 0;
    var score = 0;
    ['Customer ID','Location ID','Work Order ID','Work Order Number','Task ID','Task Name','Service Address','Status'].forEach(function (key) {
      if (clean_(row[key])) score++;
    });
    if (upper_(row['Entity Type']) === 'TASK_RELATIONSHIP') score += 2;
    return score;
  }

  function mergeTask_(a, b) {
    if (!a) return b;
    if (!b) return a;
    var primary = richness_(b) > richness_(a) ? b : a;
    var secondary = primary === a ? b : a;
    var out = {};
    Object.keys(secondary).forEach(function (key) { out[key] = secondary[key]; });
    Object.keys(primary).forEach(function (key) {
      if (clean_(primary[key]) || !clean_(out[key])) out[key] = primary[key];
    });
    return out;
  }

  function buildIndex_(operationalRows) {
    var index = {
      works: [],
      workById: {},
      workByNumber: {},
      tasksByWorkOrderNumber: {}
    };
    var taskMaps = {};

    (operationalRows || []).forEach(function (row) {
      var type = upper_(row['Entity Type']);
      if (type === 'WORK_ORDER') {
        var id = workId_(row);
        var number = workNumber_(row);
        index.works.push(row);
        if (id) index.workById[id] = row;
        if (number) index.workByNumber[number] = row;
        return;
      }
      if (type !== 'TASK' && type !== 'TASK_RELATIONSHIP') return;
      var orderNumber = taskOrderNumber_(row);
      var idTask = taskId_(row);
      if (!orderNumber || !idTask) return;
      if (!taskMaps[orderNumber]) taskMaps[orderNumber] = {};
      taskMaps[orderNumber][idTask] = mergeTask_(taskMaps[orderNumber][idTask], row);
    });

    Object.keys(taskMaps).forEach(function (number) {
      index.tasksByWorkOrderNumber[number] = Object.keys(taskMaps[number]).map(function (id) {
        return taskMaps[number][id];
      });
    });
    return index;
  }

  function requestCustomerId_(row) {
    return clean_(row && (row['Matched Customer ID'] || row['Created Customer ID']));
  }

  function requestName_(row) {
    return normalizeWords_(row && row['Full Name']);
  }

  function taskIdentity_(request, workOrder, index) {
    var number = workNumber_(workOrder);
    var tasks = (index.tasksByWorkOrderNumber[number] || []).slice();
    var phoneValues = [digits_(request && rowValue_(request, 'Phone')), digits_(request && rowValue_(request, 'Alt Phone'))].filter(Boolean);
    var name = requestName_(request);
    var nameTokens = name ? name.split(' ').filter(function (x) { return x && x !== 'AND'; }) : [];
    var first = nameTokens.length ? nameTokens[0] : '';
    var last = nameTokens.length > 1 ? nameTokens[nameTokens.length - 1] : '';
    var phoneMatch = false;
    var nameMatch = false;

    tasks.forEach(function (task) {
      var taskText = clean_(task['Task Name'] || task['Description']);
      var taskDigits = digits_(taskText);
      if (taskDigits && phoneValues.indexOf(taskDigits) !== -1) phoneMatch = true;
      var taskNorm = normalizeWords_(taskText);
      if (first && last && taskNorm.indexOf(first) !== -1 && taskNorm.indexOf(last) !== -1) nameMatch = true;
    });
    return { phoneMatch: phoneMatch, nameMatch: nameMatch, tasks: tasks };
  }

  function rowValue_(row, key) {
    return row && Object.prototype.hasOwnProperty.call(row, key) ? row[key] : '';
  }

  function parseDateMs_(value) {
    if (value instanceof Date) return value.getTime();
    var text = clean_(value);
    if (!text) return 0;
    var parsed = new Date(text).getTime();
    return isNaN(parsed) ? 0 : parsed;
  }

  function requestDateMs_(request) {
    return parseDateMs_(request && (request['Submitted At'] || request['Created At']));
  }

  function workDateMs_(workOrder) {
    return parseDateMs_(workOrder && (workOrder['Created At'] || workOrder['Sales Order Date'] || workOrder['Scheduled Date']));
  }

  function temporalEvidence_(request, workOrder) {
    var requestMs = requestDateMs_(request);
    var workMs = workDateMs_(workOrder);
    if (!requestMs || !workMs) return {available:false, deltaDays:null, nearPostRequest:false, postRequest:false};
    var deltaDays = (workMs - requestMs) / 86400000;
    // Allow a small clock/time-zone tolerance, but never use dates as a queue-scope cutoff.
    var postRequest = deltaDays >= -0.75;
    var nearPostRequest = postRequest && deltaDays <= 14;
    return {available:true, deltaDays:deltaDays, nearPostRequest:nearPostRequest, postRequest:postRequest};
  }

  function candidateEvidence_(request, workOrder, index) {
    var address = addressEvidence_(request, workOrder);
    if (!address.strong) return null;
    var identity = taskIdentity_(request, workOrder, index);
    var requestCustomer = requestCustomerId_(request);
    var workCustomer = clean_(workOrder['Customer ID']);
    var sameCustomer = !!requestCustomer && !!workCustomer && requestCustomer === workCustomer;
    var temporal = temporalEvidence_(request, workOrder);
    var score = 600;
    if (sameCustomer) score += 300;
    if (identity.phoneMatch) score += 500;
    if (identity.nameMatch) score += 250;
    if (temporal.nearPostRequest) score += 800;
    return {
      row: workOrder,
      score: score,
      sameCustomer: sameCustomer,
      phoneMatch: identity.phoneMatch,
      nameMatch: identity.nameMatch,
      taskCount: identity.tasks.length,
      temporalAvailable: temporal.available,
      deltaDays: temporal.deltaDays,
      nearPostRequest: temporal.nearPostRequest,
      postRequest: temporal.postRequest
    };
  }

  function safeFallbackOrder_(request, index) {
    if (!request || !requestStreet_(request) || !requestPostal_(request)) {
      return {status:'NO_STRONG_ADDRESS', row:null, evidence:null};
    }

    var candidates = [];
    (index.works || []).forEach(function (wo) {
      var evidence = candidateEvidence_(request, wo, index);
      if (evidence) candidates.push(evidence);
    });
    if (!candidates.length) return {status:'NO_OPERATIONAL_MATCH', row:null, evidence:null};

    // Request dates do NOT limit queue scope. They are only identity evidence.
    // Prefer the closest qualifying SO created shortly after this request.
    var near = candidates.filter(function (c) {
      return c.nearPostRequest && (c.sameCustomer || c.phoneMatch || c.nameMatch);
    });
    if (near.length) {
      near.sort(function (a, b) {
        var ad = Number(a.deltaDays), bd = Number(b.deltaDays);
        if (isFinite(ad) && isFinite(bd) && ad !== bd) return ad - bd;
        if (b.score !== a.score) return b.score - a.score;
        return workNumber_(a.row).localeCompare(workNumber_(b.row));
      });
      var first = near[0];
      var secondNear = near.length > 1 ? near[1] : null;
      if (!secondNear || Number(first.deltaDays) + 0.5 < Number(secondNear.deltaDays)) {
        return {status:'MATCHED_NEAREST_POST_REQUEST_EXACT_ADDRESS', row:first.row, evidence:first};
      }
      if (first.score > secondNear.score) {
        return {status:'MATCHED_NEAREST_POST_REQUEST_EVIDENCE', row:first.row, evidence:first};
      }
      return {status:'AMBIGUOUS_NEAR_POST_REQUEST_EXACT_ADDRESS', row:null, evidence:null, candidateCount:near.length};
    }

    // If dated candidates exist but none are near this request, do not attach old/far
    // orders merely because they share a Customer/address. This protects cases like
    // unrelated prior service or later warranty work. Undated report rows may still
    // use the no-date evidence path below.
    var undated = candidates.filter(function (c) { return !c.temporalAvailable; });
    if (!undated.length) {
      return {status:'NO_NEAR_POST_REQUEST_MATCH', row:null, evidence:null, candidateCount:candidates.length};
    }
    candidates = undated;

    var sameCustomer = candidates.filter(function (c) { return c.sameCustomer; });
    if (sameCustomer.length === 1) {
      return {status:'MATCHED_UNIQUE_EXACT_ADDRESS_SAME_CUSTOMER_NO_DATE', row:sameCustomer[0].row, evidence:sameCustomer[0]};
    }
    if (sameCustomer.length > 1) candidates = sameCustomer;

    var identity = candidates.filter(function (c) { return c.phoneMatch || c.nameMatch; });
    if (!identity.length) return {status:'AMBIGUOUS_EXACT_ADDRESS_NO_IDENTITY', row:null, evidence:null, candidateCount:candidates.length};

    identity.sort(function (a, b) { return b.score - a.score; });
    var top = identity[0];
    var second = identity.length > 1 ? identity[1] : null;
    if (!second || top.score > second.score) {
      var reason = top.phoneMatch ? 'MATCHED_UNIQUE_EXACT_ADDRESS_TASK_PHONE_NO_DATE' : 'MATCHED_UNIQUE_EXACT_ADDRESS_TASK_NAME_NO_DATE';
      return {status:reason, row:top.row, evidence:top};
    }
    return {status:'AMBIGUOUS_EXACT_ADDRESS_TASK_IDENTITY', row:null, evidence:null, candidateCount:identity.length};
  }

  function parseOrderNumber_(text) {
    var m = clean_(text).match(/#(\d{4,})\b/);
    return m ? clean_(m[1]) : '';
  }

  function exactOrder_(request, currentOrderText, index) {
    var currentNumber = parseOrderNumber_(currentOrderText);
    if (currentNumber && index.workByNumber[currentNumber]) {
      return {status:'CURRENT_QUEUE_EXACT_NUMBER', row:index.workByNumber[currentNumber]};
    }
    var requestId = clean_(request && request['Work Order ID']);
    if (requestId && index.workById[requestId]) {
      return {status:'SERVICE_REQUEST_EXACT_ID', row:index.workById[requestId]};
    }
    var requestNumber = clean_(request && request['Work Order Number']);
    if (requestNumber && index.workByNumber[requestNumber]) {
      return {status:'SERVICE_REQUEST_EXACT_NUMBER', row:index.workByNumber[requestNumber]};
    }
    return {status:'NONE', row:null};
  }

  function resolveOrder_(request, currentOrderText, index) {
    var exact = exactOrder_(request, currentOrderText, index);
    if (exact.row) return exact;
    if (clean_(request && (request['Work Order ID'] || request['Work Order Number']))) {
      return {status:'DURABLE_NOT_IN_OPERATIONAL_CACHE', row:null, preserveCurrent:true};
    }
    return safeFallbackOrder_(request, index);
  }

  function statusRank_(row) {
    var s = upper_(row && row['Status']);
    if (s === 'OPEN' || s === 'IN PROGRESS') return 0;
    if (s === 'SCHEDULED' || s === 'ASSIGNED') return 1;
    if (s === 'ON HOLD' || s === 'PENDING') return 2;
    if (s === 'DONE' || s === 'COMPLETED' || s === 'CLOSED') return 3;
    return 4;
  }

  function tasksForOrder_(workOrder, index) {
    if (!workOrder) return [];
    var number = workNumber_(workOrder);
    var rows = (index.tasksByWorkOrderNumber[number] || []).slice();
    rows.sort(function (a, b) {
      var rank = statusRank_(a) - statusRank_(b);
      if (rank) return rank;
      var ai = Number(taskId_(a) || 0);
      var bi = Number(taskId_(b) || 0);
      if (isFinite(ai) && isFinite(bi) && ai !== bi) return ai - bi;
      return taskId_(a).localeCompare(taskId_(b));
    });
    return rows;
  }

  function strivenUrl_(type, id) {
    id = clean_(id);
    if (!id) return '';
    if (type === 'ORDER') return 'https://classicfireplace.striven.com/next/crm#/sales-orders/' + encodeURIComponent(id);
    if (type === 'TASK') return 'https://classicfireplace.striven.com/Tasks/TaskInfo.aspx?nav=1&TaskID=' + encodeURIComponent(id);
    return '';
  }

  function statusColor_(status) {
    var s = upper_(status);
    if (/CANCEL|DECLIN|VOID|ERROR|BLOCK/.test(s)) return '#cc0000';
    if (/COMPLET|DONE|CLOSED/.test(s)) return '#38761d';
    if (/IN PROGRESS|APPROVED|SCHEDULED|ASSIGNED|OPEN/.test(s)) return '#1155cc';
    if (/QUOTED|PENDING|HOLD|REVIEW|INCOMPLETE/.test(s)) return '#b45f06';
    return '#666666';
  }

  function orderRich_(workOrder) {
    var id = workId_(workOrder);
    var number = workNumber_(workOrder);
    var name = clean_(workOrder && (workOrder['Work Order Name'] || workOrder['Description'])) || 'Sales Order';
    var status = clean_(workOrder && workOrder['Status']);
    var first = [(number ? '#' + number : ''), name].filter(Boolean).join(' - ');
    var text = status ? first + '\n' + status : first;
    var builder = SpreadsheetApp.newRichTextValue().setText(text);
    if (first && id) builder.setLinkUrl(0, first.length, strivenUrl_('ORDER', id));
    if (status) {
      var start = first.length + 1;
      builder.setTextStyle(start, start + status.length,
        SpreadsheetApp.newTextStyle().setBold(true).setForegroundColor(statusColor_(status)).build());
    }
    return {rich:builder.build(), text:text, number:number, status:status};
  }

  function taskLine_(task) {
    var id = taskId_(task);
    var name = clean_(task && (task['Task Name'] || task['Description'])) || 'Task';
    var status = clean_(task && task['Status']);
    if (name.length > 150) name = name.slice(0, 147) + '...';
    return {id:id, name:name, status:status, text:[(id ? '#' + id : ''), name, status].filter(Boolean).join(' - ')};
  }

  function tasksRich_(tasks) {
    if (!tasks || !tasks.length) {
      return SpreadsheetApp.newRichTextValue().setText('—').build();
    }
    var lines = tasks.map(taskLine_);
    var text = lines.map(function (line) { return line.text; }).join('\n');
    var builder = SpreadsheetApp.newRichTextValue().setText(text);
    var offset = 0;
    lines.forEach(function (line) {
      var end = offset + line.text.length;
      if (line.id) builder.setLinkUrl(offset, end, strivenUrl_('TASK', line.id));
      if (line.status) {
        var statusStart = end - line.status.length;
        builder.setTextStyle(statusStart, end,
          SpreadsheetApp.newTextStyle().setBold(true).setForegroundColor(statusColor_(line.status)).build());
      }
      offset = end + 1;
    });
    return builder.build();
  }

  function serviceRequestMap_(rows) {
    var map = {};
    (rows || []).forEach(function (row) {
      var id = clean_(row['Request ID']);
      if (id) map[id] = row;
    });
    return map;
  }

  function compact_(value) {
    if (!value || typeof value !== 'object') return value || null;
    return {
      ok: value.ok !== false,
      version: value.version || '',
      mode: value.mode || '',
      queueRowsScanned: Number(value.queueRowsScanned || 0),
      exactOrdersProjected: Number(value.exactOrdersProjected || 0),
      safeFallbackOrdersProjected: Number(value.safeFallbackOrdersProjected || 0),
      ambiguousRows: Number(value.ambiguousRows || 0),
      noMatchRows: Number(value.noMatchRows || 0),
      taskRowsProjected: Number(value.taskRowsProjected || 0),
      totalTasksProjected: Number(value.totalTasksProjected || 0),
      multiTaskRows: Number(value.multiTaskRows || 0),
      sheetWritesExecuted: value.sheetWritesExecuted === true,
      strivenMutationExecuted: false,
      liveStrivenWriteExecuted: false,
      durationMs: Number(value.durationMs || 0)
    };
  }

  function log_(status, details, error) {
    try {
      if (CF.Util && typeof CF.Util.logEvent === 'function') {
        CF.Util.logEvent({
          module: MODULE,
          action: 'ALL_EXISTING_QUEUE_RECONCILIATION',
          status: status,
          message: error ? String(error && error.message ? error.message : error) : '',
          details: compact_(details),
          version: VERSION
        });
      }
    } catch (ignored) {}
  }

  function project(options) {
    options = options || {};
    var started = Date.now();
    var write = options.write === true;
    var serviceRequests = options.serviceRequests || CF.Util.readRecords('SERVICE_REQUESTS') || [];
    var operationalRows = options.operationalRows || CF.Util.readRecords('STRIVEN_OPERATIONAL_DATA') || [];
    var sheet = CF.Util.requireSheet('OPERATOR_QUEUE');
    var lastRow = sheet.getLastRow();
    var out = {
      ok:true,
      version:VERSION,
      mode:'ALL_EXISTING_OPERATOR_QUEUE_ROWS_READ_ONLY_STRIVEN_PROJECTION',
      queueRowsScanned:0,
      exactOrdersProjected:0,
      safeFallbackOrdersProjected:0,
      ambiguousRows:0,
      noMatchRows:0,
      taskRowsProjected:0,
      totalTasksProjected:0,
      multiTaskRows:0,
      sheetWritesExecuted:false,
      strivenMutationExecuted:false,
      liveStrivenWriteExecuted:false,
      liveWritesAllowed:false,
      matchingRules:[
        'EXACT_DURABLE_ORDER_ID_OR_NUMBER',
        'NEAREST_POST_REQUEST_EXACT_STREET_POSTAL_PLUS_CUSTOMER_OR_TASK_IDENTITY',
        'UNIQUE_EXACT_STREET_POSTAL_PLUS_SAME_CUSTOMER_WHEN_ORDER_DATE_UNAVAILABLE',
        'UNIQUE_EXACT_STREET_POSTAL_PLUS_TASK_PHONE_OR_NAME_WHEN_ORDER_DATE_UNAVAILABLE',
        'NEVER_CUSTOMER_ONLY',
        'AMBIGUOUS_STAYS_UNCHANGED'
      ]
    };
    if (lastRow < 2) {
      out.durationMs = Date.now() - started;
      return out;
    }

    var count = lastRow - 1;
    var queueValues = sheet.getRange(2, 1, count, TASK_COLUMN).getDisplayValues();
    var oldOrderRich = sheet.getRange(2, ORDER_COLUMN, count, 1).getRichTextValues();
    var oldTaskRich = sheet.getRange(2, TASK_COLUMN, count, 1).getRichTextValues();
    var requestMap = serviceRequestMap_(serviceRequests);
    var index = buildIndex_(operationalRows);
    var orderRichValues = [];
    var taskRichValues = [];

    queueValues.forEach(function (queueRow, i) {
      var requestId = clean_(queueRow[0]);
      var currentOrderText = clean_(queueRow[ORDER_COLUMN - 1]);
      var request = requestMap[requestId] || null;
      out.queueRowsScanned++;

      if (!request) {
        orderRichValues.push([oldOrderRich[i][0]]);
        taskRichValues.push([oldTaskRich[i][0]]);
        out.noMatchRows++;
        return;
      }

      var resolved = resolveOrder_(request, currentOrderText, index);
      if (!resolved.row) {
        orderRichValues.push([oldOrderRich[i][0]]);
        taskRichValues.push([oldTaskRich[i][0]]);
        if (/^AMBIGUOUS/.test(resolved.status)) out.ambiguousRows++;
        else out.noMatchRows++;
        return;
      }

      if (/^(CURRENT_QUEUE_EXACT|SERVICE_REQUEST_EXACT)/.test(resolved.status)) out.exactOrdersProjected++;
      else out.safeFallbackOrdersProjected++;

      var orderProjection = orderRich_(resolved.row);
      var tasks = tasksForOrder_(resolved.row, index);
      orderRichValues.push([orderProjection.rich]);
      taskRichValues.push([tasksRich_(tasks)]);
      if (tasks.length) out.taskRowsProjected++;
      out.totalTasksProjected += tasks.length;
      if (tasks.length > 1) out.multiTaskRows++;
    });

    if (write && count) {
      sheet.getRange(2, ORDER_COLUMN, count, 1).setRichTextValues(orderRichValues);
      sheet.getRange(2, TASK_COLUMN, count, 1).setRichTextValues(taskRichValues);
      out.sheetWritesExecuted = true;
    }
    out.durationMs = Date.now() - started;
    return out;
  }

  return {
    version: VERSION,
    buildIndex: buildIndex_,
    resolveOrder: resolveOrder_,
    tasksForOrder: tasksForOrder_,
    project: project,
    compact: compact_,
    log: log_
  };
})();

(function CF_SERVICEOPS_INSTALL_TEMPORAL_IDENTITY_TIEBREAK_V5124_R1_() {
  'use strict';
  var VERSION = '5.12.4';

  if (
    typeof CF === 'undefined' || !CF.OperatorQueue || typeof CF.OperatorQueue.refresh !== 'function' ||
    typeof CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5122_R1_ === 'undefined' ||
    !CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5122_R1_ ||
    typeof SpreadsheetApp === 'undefined'
  ) {
    throw new Error('TEMPORAL_IDENTITY_TIEBREAK_SETUP_REQUIRED | v5.12.2 queue reconciler and SpreadsheetApp are required.');
  }

  if (CF.OperatorQueue.__temporalIdentityTiebreakV5124R1 === true) return;

  // Reuse the existing v5.12.2 queue wrapper so there is no second projection pass.
  // The wrapper resolves these methods dynamically on each refresh.
  CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5122_R1_.project = CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5124_R1_.project;
  CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5122_R1_.compact = CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5124_R1_.compact;
  CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5122_R1_.log = CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5124_R1_.log;

  CF.OperatorQueue.__temporalIdentityTiebreakV5124R1 = true;
  CF.OperatorQueue.__temporalIdentityTiebreakConfigV5124R1 = {
    version:VERSION,
    queueScope:'EVERY_EXISTING_ROW_IN_03_OPERATOR_QUEUE_NO_DATE_FILTER',
    requestDateUsedOnlyAsIdentityEvidence:true,
    nearestPostRequestWindowDays:14,
    historicalStrivenCreatesAllowed:false,
    historicalTaskCreatesAllowed:false,
    customerOnlyGuessingAllowed:false,
    allTasksPerExactSalesOrder:true,
    targetColumns:['Sales Order / Work Order','Task']
  };
})();

/************************************************************
 * CF_SERVICEOPS_V5_12_4_NEWSLETTER_TRACKING_DASHBOARD_R1
 * CF ServiceOps — Early Bird newsletter attribution tracking
 * Version: 5.12.4
 *
 * PURPOSE
 * - Preserve Newsletter 2's supplied tracking contract even when
 *   source_url is truncated upstream.
 * - Backfill canonical attribution into existing Attribution JSON
 *   without adding Service Request or Operator Queue columns.
 * - Maintain fixed Dashboard slots for Email 01 / 02 / 03.
 * - Future-proof Email 03+ through generic emailNN / eb26_emailNN
 *   parsing; do not invent future creative/offer values.
 *
 * SAFETY
 * - Google Sheets attribution/dashboard writes only.
 * - Raw Payload is never modified.
 * - No Striven mutation path.
 ************************************************************/
var CF_SERVICEOPS_NEWSLETTER_TRACKING_V5124_R1_ = (function () {
  'use strict';

  var VERSION = '5.12.4';
  var MODULE = '50_Operator_Queue';
  var DASHBOARD_START_ROW = 36;
  var DASHBOARD_START_COL = 1;

  function clean_(value) {
    return String(value === null || value === undefined ? '' : value).trim();
  }

  function lower_(value) {
    return clean_(value).toLowerCase();
  }

  function parseJson_(value) {
    if (value && typeof value === 'object') return value;
    var text = clean_(value);
    if (!text) return {};
    try {
      var parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (ignored) {
      return {};
    }
  }

  function copy_(value) {
    var out = {};
    Object.keys(value || {}).forEach(function (key) { out[key] = value[key]; });
    return out;
  }

  function parseQuery_(url) {
    var result = {};
    var raw = clean_(url).replace(/&amp;/gi, '&');
    var q = raw.indexOf('?');
    if (q < 0) return result;
    var query = raw.slice(q + 1).split('#')[0];
    query.split('&').forEach(function (part) {
      if (!part) return;
      var eq = part.indexOf('=');
      var key = eq < 0 ? part : part.slice(0, eq);
      var value = eq < 0 ? '' : part.slice(eq + 1);
      try { key = decodeURIComponent(key.replace(/\+/g, ' ')); } catch (ignored1) {}
      try { value = decodeURIComponent(value.replace(/\+/g, ' ')); } catch (ignored2) {}
      key = lower_(key);
      if (key && result[key] === undefined) result[key] = value;
    });
    return result;
  }

  function value_(obj, query, keys) {
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (obj && clean_(obj[key])) return clean_(obj[key]);
      if (query && clean_(query[key])) return clean_(query[key]);
    }
    return '';
  }

  function normalizeSend_(value) {
    var s = lower_(value).replace(/^eb26_/, '');
    return /^email\d{2}(?:_[a-z0-9]+)+$/.test(s) ? s : '';
  }

  function contentParts_(content) {
    var c = lower_(content);
    var m = c.match(/^(email\d{2}(?:_[a-z0-9]+)+)_([a-z])_(hero|final)$/);
    if (m) return {send:m[1], variant:m[1] + '_' + m[2], placement:m[3]};
    m = c.match(/^(email\d{2}(?:_[a-z0-9]+)+)_(hero|final)$/);
    if (m) return {send:m[1], variant:m[1], placement:m[2]};
    return {send:'', variant:'', placement:''};
  }

  function canonicalize_(input) {
    var source = parseJson_(input);
    var out = copy_(source);
    var query = parseQuery_(value_(source, null, ['source_url']));
    var utmId = value_(source, query, ['utm_id','current_utm_id','first_utm_id']);
    var utmContent = value_(source, query, ['utm_content','current_utm_content','first_utm_content']);
    var utmTerm = value_(source, query, ['utm_term','current_utm_term','first_utm_term']);
    var explicitSend = value_(source, query, ['send_id','current_send_id','cf_send','current_cf_send','first_send_id','first_cf_send']);
    var explicitVariant = value_(source, query, ['message_variant','current_message_variant','first_message_variant']);
    var content = contentParts_(utmContent);
    var sendId = normalizeSend_(explicitSend) || normalizeSend_(utmId) || content.send || normalizeSend_(utmTerm);
    var variant = lower_(explicitVariant) || content.variant;
    var placement = lower_(value_(source, query, ['cta_placement'])) || content.placement;

    if (utmId && !clean_(out.utm_id)) out.utm_id = utmId;
    if (sendId) {
      out.send_id = sendId;
      out.cf_send = sendId;
      var number = sendId.match(/^email(\d{2})/);
      if (number) out.newsletter_number = number[1];
    }
    if (variant) out.message_variant = variant;
    if (placement) out.cta_placement = placement;

    if (sendId === 'email02_followup') {
      if (!clean_(out.utm_source)) out.utm_source = 'Klaviyo';
      if (!clean_(out.utm_medium)) out.utm_medium = 'email';
      if (!clean_(out.utm_campaign)) out.utm_campaign = 'early_bird_2026_fireplace_service';
      if (!clean_(out.utm_id)) out.utm_id = 'eb26_email02_followup';
      if (!clean_(out.cf_campaign)) out.cf_campaign = 'eb26';
      if (!clean_(out.cf_offer)) out.cf_offer = '200_hst_included';
      if (!clean_(out.cf_landing)) out.cf_landing = 'service_maintenance_page';
      if (!clean_(out.referral_source)) out.referral_source = 'klaviyo_email';
      if (!clean_(out.message_variant) && /^email02_followup_a_(hero|final)$/.test(lower_(utmContent))) {
        out.message_variant = 'email02_followup_a';
      }
    }

    if (/^email\d{2}_/.test(sendId) && !clean_(out.cf_campaign) && /^eb26_/.test(lower_(utmId))) {
      out.cf_campaign = 'eb26';
    }

    return out;
  }

  function newsletterNumber_(attr) {
    var obj = canonicalize_(attr);
    var explicit = Number(clean_(obj.newsletter_number));
    if (isFinite(explicit) && explicit > 0) return explicit;
    var m = lower_(obj.send_id || obj.cf_send).match(/^email(\d{2})/);
    return m ? Number(m[1]) : 0;
  }

  function placement_(attr) {
    var obj = canonicalize_(attr);
    var p = lower_(obj.cta_placement);
    return p === 'hero' || p === 'final' ? p : 'other';
  }

  function readAttributionColumn_(sheetKey) {
    var sheet = CF.Util.requireSheet(sheetKey);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return {sheet:sheet, column:0, values:[], lastRow:lastRow};
    var headers = CF.Util.getActualHeaders(sheet);
    var col = headers.indexOf('Attribution JSON') + 1;
    if (!col) throw new Error('Attribution JSON column not found on ' + sheet.getName());
    return {
      sheet:sheet,
      column:col,
      values:sheet.getRange(2, col, lastRow - 1, 1).getDisplayValues(),
      lastRow:lastRow
    };
  }

  function aggregateValues_(values) {
    var slots = {
      1:{newsletter:'Email 01',requests:0,hero:0,final:0,other:0},
      2:{newsletter:'Email 02',requests:0,hero:0,final:0,other:0},
      3:{newsletter:'Email 03',requests:0,hero:0,final:0,other:0}
    };
    var recognized = 0;
    (values || []).forEach(function (row) {
      var attr = parseJson_(row && row[0]);
      var number = newsletterNumber_(attr);
      if (!number) return;
      recognized++;
      if (!slots[number]) return;
      slots[number].requests++;
      slots[number][placement_(attr)]++;
    });
    return {
      recognized:recognized,
      slots:slots,
      rows:[1,2,3].map(function (n) {
        var s = slots[n];
        return [s.newsletter, s.requests, s.hero, s.final, s.other];
      })
    };
  }

  function dashboardTracker_(options) {
    options = options || {};
    var started = Date.now();
    var source = readAttributionColumn_('SERVICE_REQUESTS');
    var agg = aggregateValues_(source.values);
    var dashboard = CF.Util.requireSheet('DASHBOARD');

    if (options.write !== false) {
      var title = dashboard.getRange(DASHBOARD_START_ROW, DASHBOARD_START_COL, 1, 5);
      title.breakApart();
      title.merge().setValue('Early Bird Newsletter Tracking — Requests')
        .setFontWeight('bold').setBackground('#d9eaf7').setHorizontalAlignment('center');
      dashboard.getRange(DASHBOARD_START_ROW + 1, DASHBOARD_START_COL, 1, 5)
        .setValues([['Newsletter','Requests','Hero CTA','Final CTA','Other / Legacy']])
        .setFontWeight('bold').setBackground('#f3f3f3').setHorizontalAlignment('center');
      dashboard.getRange(DASHBOARD_START_ROW + 2, DASHBOARD_START_COL, 3, 5)
        .setValues(agg.rows).setVerticalAlignment('middle');
      dashboard.getRange(DASHBOARD_START_ROW + 5, DASHBOARD_START_COL, 1, 5)
        .merge().setValue('Email 03 is reserved and will populate automatically when email03_* / eb26_email03_* tracking begins.')
        .setFontStyle('italic').setFontColor('#666666').setWrap(true);
    }

    return {
      ok:true,
      version:VERSION,
      mode:'NEWSLETTER_TRACKING_DASHBOARD',
      email01:agg.slots[1],
      email02:agg.slots[2],
      email03:agg.slots[3],
      recognizedNewsletterRequests:agg.recognized,
      dashboardRows:[DASHBOARD_START_ROW,DASHBOARD_START_ROW+5],
      sheetWritesExecuted:options.write !== false,
      strivenMutationExecuted:false,
      liveStrivenWriteExecuted:false,
      durationMs:Date.now()-started
    };
  }

  function backfillSheet_(sheetKey, write) {
    var source = readAttributionColumn_(sheetKey);
    var changed = 0;
    var recognized = 0;
    var output = [];
    source.values.forEach(function (row) {
      var raw = clean_(row && row[0]);
      var parsed = parseJson_(raw);
      var canon = canonicalize_(parsed);
      var number = newsletterNumber_(canon);
      if (number) recognized++;
      var serialized = raw;
      if (number) {
        serialized = JSON.stringify(canon);
        if (serialized !== raw) changed++;
      }
      output.push([serialized]);
    });
    if (write && output.length && changed) {
      source.sheet.getRange(2, source.column, output.length, 1).setValues(output);
    }
    return {sheet:source.sheet.getName(),rows:output.length,recognized:recognized,changed:changed,written:write && changed > 0};
  }

  function backfill(options) {
    options = options || {};
    var started = Date.now();
    var write = options.write === true;
    var webform = backfillSheet_('WEBFORM_REQUESTS', write);
    var requests = backfillSheet_('SERVICE_REQUESTS', write);
    var dashboard = dashboardTracker_({write:write});
    return {
      ok:true,
      version:VERSION,
      mode:'NEWSLETTER_ATTRIBUTION_BACKFILL_NO_NEW_COLUMNS',
      webformRequests:webform,
      serviceRequests:requests,
      dashboard:dashboard,
      totalChanged:Number(webform.changed||0)+Number(requests.changed||0),
      sheetWritesExecuted:write && (webform.changed > 0 || requests.changed > 0 || dashboard.sheetWritesExecuted),
      rawPayloadModified:false,
      newColumnsAdded:false,
      strivenMutationExecuted:false,
      liveStrivenWriteExecuted:false,
      durationMs:Date.now()-started
    };
  }

  function log_(status, details, error) {
    try {
      if (CF.Util && typeof CF.Util.logEvent === 'function') {
        CF.Util.logEvent({
          module:MODULE,
          action:'NEWSLETTER_TRACKING',
          status:status,
          message:error ? String(error && error.message ? error.message : error) : '',
          details:details || null,
          version:VERSION
        });
      }
    } catch (ignored) {}
  }

  return {
    version:VERSION,
    canonicalize:canonicalize_,
    newsletterNumber:newsletterNumber_,
    aggregateValues:aggregateValues_,
    dashboardTracker:dashboardTracker_,
    backfill:backfill,
    log:log_
  };
})();

(function CF_SERVICEOPS_INSTALL_NEWSLETTER_TRACKING_V5124_R1_() {
  'use strict';
  var VERSION = '5.12.4';
  if (typeof CF === 'undefined' || !CF.Util || !CF.OperatorQueue || typeof CF.OperatorQueue.refresh !== 'function') {
    throw new Error('NEWSLETTER_TRACKING_SETUP_REQUIRED | CF.Util and CF.OperatorQueue.refresh are required.');
  }
  if (CF.OperatorQueue.__newsletterTrackingV5124R1 === true) return;

  var originalRefresh = CF.OperatorQueue.refresh;
  CF.OperatorQueue.refreshBeforeNewsletterTrackingV5124R1 = originalRefresh;
  CF.OperatorQueue.refresh = function () {
    var result = originalRefresh.apply(CF.OperatorQueue, arguments);
    try {
      var tracking = CF_SERVICEOPS_NEWSLETTER_TRACKING_V5124_R1_.dashboardTracker({write:true});
      if (result && typeof result === 'object') result.newsletterTracking = tracking;
    } catch (trackingError) {
      var warning = {ok:false,version:VERSION,error:String(trackingError && trackingError.message ? trackingError.message : trackingError),strivenMutationExecuted:false};
      if (result && typeof result === 'object') result.newsletterTracking = warning;
      CF_SERVICEOPS_NEWSLETTER_TRACKING_V5124_R1_.log('DASHBOARD_WARNING', warning, trackingError);
    }
    return result;
  };

  if (typeof CF.OperatorQueue.refreshDashboard === 'function') {
    var originalDashboard = CF.OperatorQueue.refreshDashboard;
    CF.OperatorQueue.refreshDashboardBeforeNewsletterTrackingV5124R1 = originalDashboard;
    CF.OperatorQueue.refreshDashboard = function () {
      var result = originalDashboard.apply(CF.OperatorQueue, arguments);
      try { CF_SERVICEOPS_NEWSLETTER_TRACKING_V5124_R1_.dashboardTracker({write:true}); } catch (ignored) {}
      return result;
    };
  }

  CF.OperatorQueue.__newsletterTrackingV5124R1 = true;
  CF.OperatorQueue.__newsletterTrackingConfigV5124R1 = {
    version:VERSION,
    storage:'EXISTING_ATTRIBUTION_JSON_NO_NEW_COLUMNS',
    dashboardSlots:['Email 01','Email 02','Email 03'],
    email02CanonicalSend:'email02_followup',
    email02UtmId:'eb26_email02_followup',
    email03Reserved:true,
    genericFuturePattern:'emailNN_* / eb26_emailNN_*',
    historicalBackfillWritesGoogleSheetsOnly:true,
    rawPayloadModified:false,
    strivenMutationExecuted:false
  };
})();

function TESTING_20260903_allExistingQueueReconciliationStatus() {
  var result = CF_SERVICEOPS_ALL_EXISTING_QUEUE_RECONCILIATION_V5124_R1_.project({write:false});
  result.liveWriteExecuted = false;
  result.liveStrivenWriteExecuted = false;
  result.strivenMutationExecuted = false;
  return result;
}

function TESTING_20260903_newsletterTrackingStatus() {
  var result = CF_SERVICEOPS_NEWSLETTER_TRACKING_V5124_R1_.backfill({write:false});
  result.liveWriteExecuted = false;
  result.liveStrivenWriteExecuted = false;
  result.strivenMutationExecuted = false;
  return result;
}

function TRACKING_refreshNewsletterDashboard() {
  var result = CF_SERVICEOPS_NEWSLETTER_TRACKING_V5124_R1_.dashboardTracker({write:true});
  result.liveWriteExecuted = false;
  result.liveStrivenWriteExecuted = false;
  result.strivenMutationExecuted = false;
  return result;
}

function FIX_20260903_reconcileAllExistingOperatorQueue() {
  if (!CF || !CF.OperatorQueue || !CF.OperatorQueue.__temporalIdentityTiebreakV5124R1 || !CF.OperatorQueue.__newsletterTrackingV5124R1) {
    throw new Error('v5.12.4 Temporal Identity + Newsletter Tracking patch is not loaded.');
  }
  var backfill = CF_SERVICEOPS_NEWSLETTER_TRACKING_V5124_R1_.backfill({write:true});
  var result = CF.OperatorQueue.refresh();
  return {
    ok:(!result || result.ok !== false) && backfill.ok !== false,
    version:'5.12.4',
    status:'QUEUE_RECONCILED_AND_NEWSLETTER_TRACKING_BACKFILLED',
    queueRefresh:result || null,
    newsletterBackfill:backfill,
    liveWriteExecuted:false,
    liveStrivenWriteExecuted:false,
    strivenMutationExecuted:false
  };
}

/* BEGIN CF_SERVICEOPS_V5_13_1_QUEUE_TIMING_HARDENING_R1 */
/************************************************************
 * CF_SERVICEOPS_V5_13_1_QUEUE_TIMING_HARDENING_R1
 * Fixes the v5.13.0 queue timing projection gap.
 *
 * - Full refresh now reapplies Submitted/Processed/Duration.
 * - Request refresh preserves Customer/Contact/Location hyperlinks.
 * - Parity verifies full Status text and Sales Order hyperlink.
 * - Adds one read-only/logging acceptance function.
 ************************************************************/
(function CF_SERVICEOPS_INSTALL_QUEUE_TIMING_HARDENING_V5131_R1_(){
  'use strict';
  if(typeof CF==='undefined'||!CF.OperatorQueue||!CF.Util) throw new Error('QUEUE_TIMING_HARDENING_SETUP_REQUIRED');
  if(CF.OperatorQueue.__queueTimingHardeningV5131R1===true) return;

  var VERSION='5.13.1';
  var baseRefresh=CF.OperatorQueue.refresh;
  var baseApply=CF.OperatorQueue.applyOperatorDecision;
  var basePatchRow=CF.Util.patchRow;
  var DIRTY_ROWS_PROP='CF_QUEUE_DIRTY_SERVICE_REQUEST_ROWS_V5131';
  var SCHEDULED_AT_PROP='CF_QUEUE_SYNC_SCHEDULED_AT_V5131';
  var TRIGGER='AUTO_CF_QUEUE_SYNC_AFTER_SERVICE_REQUEST_MUTATION';

  function clean_(v){return v===null||v===undefined?'':String(v).trim();}
  function upper_(v){return clean_(v).toUpperCase();}
  function nowMs_(){return Date.now();}
  function relevantPatch_(patch){
    patch=patch||{};
    var keys=['Current Stage','Request Status','Manual Review?','Manual Review Reason','Blocking Issue','Next Action',
      'Striven Sync Status','Striven Sync Error','Reconciliation Status','Final Outcome','Completed At','Last Striven Sync','Submitted At',
      'Matched Customer ID','Created Customer ID','Matched Contact ID','Created Contact ID','Matched Location ID','Created Location ID',
      'Customer Match Status','Contact Match Status','Location Match Status','Customer Action','Contact Action','Location Action',
      'Work Order Action','Work Order Status','Work Order ID','Work Order Number','Work Order Link','Active Work JSON'];
    return keys.some(function(k){return Object.prototype.hasOwnProperty.call(patch,k);});
  }
  function request_(id){return CF.Util.findRecord('SERVICE_REQUESTS','Request ID',clean_(id));}
  function queueSheet_(){return CF.Util.requireSheet('OPERATOR_QUEUE');}
  function parseDate_(v){
    if(!v)return null;
    if(Object.prototype.toString.call(v)==='[object Date]')return isNaN(v.getTime())?null:v;
    var s=clean_(v),m;
    m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if(m)return new Date(Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4]),Number(m[5]),Number(m[6]||0));
    m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if(m)return new Date(Number(m[3]),Number(m[1])-1,Number(m[2]),Number(m[4]),Number(m[5]),Number(m[6]||0));
    var d=new Date(s);return isNaN(d.getTime())?null:d;
  }
  function tz_(){try{return SpreadsheetApp.getActive().getSpreadsheetTimeZone()||'America/Toronto';}catch(e){return'America/Toronto';}}
  function formatDateTime_(v){var d=parseDate_(v);if(!d)return'';try{return Utilities.formatDate(d,tz_(),'MMM d, yyyy h:mm a');}catch(e){return clean_(v);}}
  function duration_(start,end){
    var a=parseDate_(start),b=parseDate_(end);if(!a||!b)return'';var sec=Math.max(0,Math.round((b.getTime()-a.getTime())/1000));
    var days=Math.floor(sec/86400);sec-=days*86400;var hrs=Math.floor(sec/3600);sec-=hrs*3600;var mins=Math.floor(sec/60),parts=[];
    if(days)parts.push(days+'d');if(hrs||days)parts.push(hrs+'h');parts.push(mins+'m');return parts.join(' ');
  }
  // CF_SERVICEOPS_V5_14_2_IDENTITY_CONFLICT_UI_R1
  function processedValue_(r){return r['Last Striven Sync']||r['Completed At']||'';}
  function processComplete_(r){return !!clean_(r['Work Order ID'])||upper_(r['Current Stage'])==='SALES ORDER CREATED'||upper_(r['Striven Sync Status'])==='SYNCED';}
  function matchEvidence_(r){
    var raw=r&&r['Match Evidence JSON'];
    try{return CF.Util.parseJson(raw,{})||{};}catch(e){try{return JSON.parse(String(raw||'{}'))||{};}catch(e2){return{};}}
  }
  function customerCandidateEvidence_(r){
    var evidence=matchEvidence_(r),raw=Array.isArray(evidence.customerCandidates)?evidence.customerCandidates:[],out=[],seen={};
    raw.forEach(function(candidate){
      candidate=candidate||{};
      var row=candidate.row||candidate||{};
      var id=clean_(row['Customer ID']||row['Entity ID']||candidate.id),name=clean_(row['Customer Name']||row['Full Name']);
      if(!id||seen[id])return;
      var reasons=Array.isArray(candidate.reasons)?candidate.reasons:(Array.isArray(row.reasons)?row.reasons:[]);
      reasons=reasons.map(clean_).filter(Boolean);
      seen[id]=true;out.push({id:id,name:name,reasons:reasons});
    });
    return out;
  }
  function friendlyEvidence_(reasons){
    reasons=(reasons||[]).map(upper_);
    var labels=[];
    var secondaryAddress=reasons.indexOf('SECONDARY ADDRESS')>=0,secondaryName=reasons.indexOf('SECONDARY NAME')>=0;
    if(reasons.indexOf('PRIMARY EMAIL')>=0)labels.push('Email');
    if(reasons.indexOf('PRIMARY PHONE')>=0)labels.push('Phone');
    if(reasons.indexOf('PRIMARY ALT PHONE')>=0)labels.push('Alt phone');
    if(secondaryAddress&&secondaryName)labels.push('Address + name');
    else{
      if(secondaryAddress)labels.push('Address');
      if(secondaryName)labels.push('Name');
    }
    reasons.forEach(function(reason){
      if(['PRIMARY EMAIL','PRIMARY PHONE','PRIMARY ALT PHONE','SECONDARY ADDRESS','SECONDARY NAME'].indexOf(reason)>=0)return;
      var label=clean_(reason).replace(/^PRIMARY\s+/i,'').replace(/^SECONDARY\s+/i,'');
      if(label&&labels.indexOf(label)<0)labels.push(label);
    });
    return labels.length?labels.join(' + '):'Candidate';
  }
  function customerConflictLines_(r){
    if(upper_(r['Customer Match Status'])!=='AMBIGUOUS')return[];
    return customerCandidateEvidence_(r).map(function(candidate){
      return friendlyEvidence_(candidate.reasons)+' → Customer '+candidate.id+(candidate.name?' — '+candidate.name:'');
    });
  }
  function reviewLines_(r){
    if(upper_(r['Manual Review?'])!=='YES')return[];
    if(upper_(r['Customer Match Status'])==='AMBIGUOUS'){
      var conflictLines=customerConflictLines_(r);
      return ['Review: Customer identity conflict'].concat(conflictLines).concat(['Action: Confirm the correct Customer']);
    }
    return ['Review: '+clean_(r['Manual Review Reason']||r['Blocking Issue']||'Required')];
  }
  function statusText_(r){
    var lines=[clean_(r['Current Stage']||r['Request Status'])];
    var submittedRaw=r['Submitted At']||r['Created At'],processedRaw=processedValue_(r),submitted=formatDateTime_(submittedRaw);
    if(submitted)lines.push('Submitted: '+submitted);
    if(processedRaw){
      lines.push((processComplete_(r)?'Processed: ':'Last processed: ')+formatDateTime_(processedRaw));
      var dur=duration_(submittedRaw,processedRaw);if(dur)lines.push((processComplete_(r)?'Processing time: ':'Processing time so far: ')+dur);
    }else lines.push('Processed: Pending');
    lines=lines.concat(reviewLines_(r));
    return lines.filter(Boolean).join('\n');
  }
  function ids_(r){return{
    customer:clean_(r['Matched Customer ID']||r['Created Customer ID']),
    contact:clean_(r['Matched Contact ID']||r['Created Contact ID']),
    location:clean_(r['Matched Location ID']||r['Created Location ID'])
  };}
  function parseJournal_(v){try{return CF.Util.parseJson(v,{})||{};}catch(e){try{return JSON.parse(String(v||'{}'))||{};}catch(e2){return{};}}}
  function contactLinkIdentity_(r){
    var x=ids_(r),root=parseJournal_(r['Write Journal JSON']),identity=root.contactIdentity||{},scoped='';
    if(upper_(identity.scope)==='CUSTOMER'&&identity.identityVerified===true&&clean_(identity.customerId)===x.customer)scoped=clean_(identity.customerScopedContactId||identity.contactId);
    var globalId=clean_(identity.globalContactId);
    if(!globalId&&x.contact&&x.contact!==scoped)globalId=x.contact;
    var displayId=scoped||x.contact,url='';
    if(scoped&&x.customer)url='https://classicfireplace.striven.com/next/crm#/accounts/'+encodeURIComponent(x.customer)+'/contacts/'+encodeURIComponent(scoped);
    else if(globalId||x.contact)url='https://classicfireplace.striven.com/CRM/ContactInfo.aspx?ContactID='+encodeURIComponent(globalId||x.contact);
    return{displayId:displayId,url:url,customerScopedContactId:scoped,globalContactId:globalId||(!scoped?x.contact:'')};
  }
  function strivenText_(r){
    var x=ids_(r),contactLink=contactLinkIdentity_(r),lines=[],candidateIds=customerCandidateEvidence_(r).map(function(candidate){return candidate.id;});
    var customerDisplay=x.customer?x.customer+' ✓'
      :(upper_(r['Customer Match Status'])==='AMBIGUOUS'?(candidateIds.length?candidateIds.join(' / ')+' ⚠':'AMBIGUOUS ⚠')
        :(upper_(r['Customer Action'])==='CREATE'?'NEW':'—'));
    lines.push('Customer: '+customerDisplay);
    lines.push('Contact: '+(contactLink.displayId?contactLink.displayId+' ✓':(upper_(r['Contact Action'])==='CREATE'?'NEW':'—')));
    lines.push('Location: '+(x.location?x.location+' ✓':(upper_(r['Location Action'])==='CREATE'?'NEW':'—')));
    if(clean_(r['Match Confidence']))lines.push('Confidence: '+clean_(r['Match Confidence'])+(clean_(r['Match Score'])?' ('+clean_(r['Match Score'])+')':''));
    return lines.join('\n');
  }
  function customerUrl_(id){return id?'https://classicfireplace.striven.com/CRM/AccountDashboard.aspx?AccountID='+encodeURIComponent(id):'';}
  function contactUrl_(customer,id){return customer&&id?'https://classicfireplace.striven.com/next/crm#/accounts/'+encodeURIComponent(customer)+'/contacts/'+encodeURIComponent(id):'';}
  function locationUrl_(customer,id){return customer&&id?'https://classicfireplace.striven.com/next/crm#/accounts/'+encodeURIComponent(customer)+'/locations/'+encodeURIComponent(id):'';}
  function setLinkForToken_(builder,text,token,url,from){
    if(!token||!url)return;var i=text.indexOf(token,from||0);if(i>=0)builder.setLinkUrl(i,i+token.length,url);
  }
  function setCustomerCandidateLinks_(builder,text,r){
    customerCandidateEvidence_(r).forEach(function(candidate){
      var prefix=friendlyEvidence_(candidate.reasons)+' → Customer ',needle=prefix+candidate.id,pos=text.indexOf(needle);
      if(pos>=0)builder.setLinkUrl(pos+prefix.length,pos+needle.length,customerUrl_(candidate.id));
    });
  }
  function statusRich_(r){
    var text=statusText_(r),b=SpreadsheetApp.newRichTextValue().setText(text);
    setCustomerCandidateLinks_(b,text,r);
    return b.build();
  }
  function setStatusRich_(range,r){
    range.setRichTextValue(statusRich_(r));
    range.setBackground(stageBg_(r['Current Stage'])).setFontWeight('bold');
  }
  function setStrivenRich_(range,r){
    var text=strivenText_(r),x=ids_(r),contactLink=contactLinkIdentity_(r),b=SpreadsheetApp.newRichTextValue().setText(text);
    var firstBreak=text.indexOf('\n'),contactStart=firstBreak>=0?firstBreak+1:0,secondBreak=text.indexOf('\n',contactStart),locationStart=secondBreak>=0?secondBreak+1:contactStart;
    if(x.customer)setLinkForToken_(b,text,x.customer,customerUrl_(x.customer),0);
    else{
      var candidateCursor='Customer: '.length;
      customerCandidateEvidence_(r).forEach(function(candidate){
        var pos=text.indexOf(candidate.id,candidateCursor);
        if(pos>=0&&firstBreak>=0&&pos<firstBreak){b.setLinkUrl(pos,pos+candidate.id.length,customerUrl_(candidate.id));candidateCursor=pos+candidate.id.length;}
      });
    }
    if(contactLink.displayId)setLinkForToken_(b,text,contactLink.displayId,contactLink.url,contactStart);
    if(x.location)setLinkForToken_(b,text,x.location,locationUrl_(x.customer,x.location),locationStart);
    range.setRichTextValue(b.build());
  }
  function orderText_(r){var number=clean_(r['Work Order Number']),id=clean_(r['Work Order ID']);if(!number&&!id)return'—';return'#'+(number||id)+' - Sales Order\n'+(clean_(r['Work Order Status'])||'Quoted');}
  function orderUrl_(r){var url=clean_(r['Work Order Link']);if(!url&&clean_(r['Work Order ID']))url='https://classicfireplace.striven.com/next/crm#/sales-orders/'+encodeURIComponent(clean_(r['Work Order ID']));return url;}
  function setOrderRich_(range,r){var text=orderText_(r),url=orderUrl_(r),b=SpreadsheetApp.newRichTextValue().setText(text);if(url&&text!=='—'){var e=text.indexOf('\n');if(e<0)e=text.length;b.setLinkUrl(0,e,url);}range.setRichTextValue(b.build());}
  function stageBg_(stage){stage=upper_(stage);if(stage==='SALES ORDER CREATED')return'#d9ead3';if(stage==='NEEDS REVIEW')return'#f4cccc';if(stage.indexOf('READY FOR')===0)return'#fff2cc';if(stage.indexOf('CREATING')===0)return'#cfe2f3';return'#ffffff';}
  function findQueueRow_(requestId){var s=queueSheet_(),last=s.getLastRow();if(last<2)return 0;var hit=s.getRange(2,1,last-1,1).createTextFinder(clean_(requestId)).matchEntireCell(true).findNext();return hit?hit.getRow():0;}
  function applyStatusTimingProjectionAll_(){
    var s=queueSheet_(),last=s.getLastRow();if(last<2)return{ok:true,status:'NO_QUEUE_ROWS',updated:0};
    var headers=s.getRange(1,1,1,s.getLastColumn()).getDisplayValues()[0],idCol=headers.indexOf('Request ID')+1,statusCol=headers.indexOf('Status')+1;
    if(!idCol||!statusCol)return{ok:false,status:'QUEUE_COLUMNS_MISSING'};
    var src=CF.Util.readRecords('SERVICE_REQUESTS'),map={};src.forEach(function(r){var id=clean_(r['Request ID']);if(id)map[id]=r;});
    var ids=s.getRange(2,idCol,last-1,1).getDisplayValues(),existing=s.getRange(2,statusCol,last-1,1).getDisplayValues(),values=[],bgs=[],updated=0;
    for(var i=0;i<ids.length;i++){
      var id=clean_(ids[i][0]),r=map[id];
      if(r){values.push([statusRich_(r)]);bgs.push([stageBg_(r['Current Stage'])]);updated++;}
      else{values.push([SpreadsheetApp.newRichTextValue().setText(String(existing[i][0]||'')).build()]);bgs.push(['#ffffff']);}
    }
    s.getRange(2,statusCol,values.length,1).setRichTextValues(values).setBackgrounds(bgs).setFontWeight('bold');
    return{ok:true,status:'STATUS_TIMING_PROJECTED',updated:updated};
  }
  function refreshRequest_(requestId,options){
    options=options||{};requestId=clean_(requestId);if(!requestId)return{ok:false,status:'REQUEST_ID_REQUIRED'};SpreadsheetApp.flush();
    var r=request_(requestId);if(!r)return{ok:false,status:'SERVICE_REQUEST_NOT_FOUND',requestId:requestId};var row=findQueueRow_(requestId);
    if(!row){var full=refreshAll_({verifyLimit:options.verifyLimit||25}),after=findQueueRow_(requestId);return{ok:!!after,status:after?'FULL_REFRESH_INSERTED_REQUEST':'REQUEST_STILL_MISSING_AFTER_FULL_REFRESH',requestId:requestId,fullRefresh:full,parity:verifyRequest_(requestId)};}
    var s=queueSheet_(),headers=s.getRange(1,1,1,s.getLastColumn()).getDisplayValues()[0];function col_(name){return headers.indexOf(name)+1;}
    var cStatus=col_('Status'),cStriven=col_('Striven'),cNext=col_('Next Step'),cOrder=col_('Sales Order / Work Order');
    if(cStatus)setStatusRich_(s.getRange(row,cStatus),r);
    if(cStriven)setStrivenRich_(s.getRange(row,cStriven),r);
    if(cNext)s.getRange(row,cNext).setValue(clean_(r['Next Action'])||'—');
    if(cOrder)setOrderRich_(s.getRange(row,cOrder),r);
    SpreadsheetApp.flush();var parity=verifyRequest_(requestId);
    if(!parity.ok&&options.fullFallback!==false){var full2=refreshAll_({verifyLimit:options.verifyLimit||25});parity=verifyRequest_(requestId);return{ok:parity.ok,status:parity.ok?'REQUEST_REFRESH_REPAIRED_BY_FULL_FALLBACK':'PARITY_FAILED_AFTER_FULL_FALLBACK',requestId:requestId,parity:parity,fullRefresh:full2};}
    return{ok:parity.ok,status:parity.ok?'REQUEST_REFRESHED_AND_VERIFIED':'REQUEST_REFRESH_PARITY_FAILED',requestId:requestId,parity:parity};
  }
  function richUrls_(range){var out=[];try{var rt=range.getRichTextValue();if(!rt)return out;(rt.getRuns()||[]).forEach(function(run){var u=run.getLinkUrl();if(u&&out.indexOf(u)<0)out.push(u);});}catch(e){}return out;}
  function verifyRequest_(requestId){
    requestId=clean_(requestId);var src=request_(requestId),row=findQueueRow_(requestId),issues=[];if(!src)return{ok:false,requestId:requestId,issues:['SOURCE_REQUEST_MISSING']};if(!row)return{ok:false,requestId:requestId,issues:['QUEUE_ROW_MISSING']};
    var s=queueSheet_(),headers=s.getRange(1,1,1,s.getLastColumn()).getDisplayValues()[0],vals=s.getRange(row,1,1,headers.length).getDisplayValues()[0];function idx_(name){return headers.indexOf(name);}function q_(name){var i=idx_(name);return i>=0?clean_(vals[i]):'';}
    var expectedStatus=statusText_(src),actualStatus=q_('Status');if(expectedStatus!==actualStatus)issues.push('STATUS_TEXT_MISMATCH');
    var expectedNext=clean_(src['Next Action'])||'—',actualNext=q_('Next Step')||'—';if(expectedNext!==actualNext)issues.push('NEXT_ACTION:'+actualNext+'!='+expectedNext);
    var n=clean_(src['Work Order Number']);if(n&&q_('Sales Order / Work Order').indexOf(n)<0)issues.push('ORDER_NUMBER_MISSING:'+n);
    var oi=idx_('Sales Order / Work Order'),expectedOrderUrl=orderUrl_(src);if(oi>=0&&expectedOrderUrl&&richUrls_(s.getRange(row,oi+1)).indexOf(expectedOrderUrl)<0)issues.push('ORDER_LINK_MISSING');
    if(upper_(src['Customer Match Status'])==='AMBIGUOUS'){
      var candidateIds=customerCandidateEvidence_(src).map(function(candidate){return candidate.id;});
      var statusIndex=idx_('Status'),strivenIndex=idx_('Striven');
      var statusUrls=statusIndex>=0?richUrls_(s.getRange(row,statusIndex+1)):[];
      var strivenUrls=strivenIndex>=0?richUrls_(s.getRange(row,strivenIndex+1)):[];
      candidateIds.forEach(function(candidateId){
        var url=customerUrl_(candidateId);
        if(statusIndex>=0&&statusUrls.indexOf(url)<0)issues.push('STATUS_CUSTOMER_LINK_MISSING:'+candidateId);
        if(strivenIndex>=0&&strivenUrls.indexOf(url)<0)issues.push('STRIVEN_CUSTOMER_LINK_MISSING:'+candidateId);
      });
    }
    if(upper_(src['Striven Sync Status'])==='RECONCILE REQUIRED'&&upper_(actualNext).indexOf('RECONCILE')!==0)issues.push('UNSAFE_RECONCILE_PROJECTION');
    return{ok:issues.length===0,requestId:requestId,rowNumber:row,expectedStatus:expectedStatus,actualStatus:actualStatus,sourceNextAction:expectedNext,queueNextAction:actualNext,workOrderNumber:n,issues:issues};
  }
  function verifyRecent_(limit){limit=Math.max(1,Number(limit||20));var rows=CF.Util.readRecords('SERVICE_REQUESTS').slice();function ms_(r){var v=r['Submitted At']||r['Created At'];var d=v instanceof Date?v:new Date(v),t=d.getTime();return isNaN(t)?0:t;}rows.sort(function(a,b){return ms_(b)-ms_(a);});var checked=[],mismatches=[];rows.slice(0,limit).forEach(function(r){var id=clean_(r['Request ID']);if(!id)return;var p=verifyRequest_(id);checked.push(p);if(!p.ok)mismatches.push(p);});return{ok:mismatches.length===0,version:VERSION,limit:limit,checked:checked.length,mismatchCount:mismatches.length,mismatches:mismatches};}
  function refreshAll_(options){options=options||{};SpreadsheetApp.flush();var out=baseRefresh.apply(CF.OperatorQueue,[]);SpreadsheetApp.flush();var timing=applyStatusTimingProjectionAll_();SpreadsheetApp.flush();var parity=verifyRecent_(options.verifyLimit||20);if(out&&typeof out==='object'){out.commitFlushBeforeRead=true;out.commitFlushAfterWrite=true;out.statusTimingProjection=timing;out.recentParity=parity;out.versionQueueCommitParity=VERSION;}try{if(CF.Util&&typeof CF.Util.logEvent==='function')CF.Util.logEvent({module:'50_Operator_Queue',action:'QUEUE_TIMING_HARDENING_REFRESH',status:parity.ok?'COMPLETE':'PARITY_FAILED',details:{timing:timing,parity:parity},version:VERSION});}catch(e){}return out||{ok:parity.ok,statusTimingProjection:timing,recentParity:parity,versionQueueCommitParity:VERSION};}
  function unsafeWriteReason_(r,action){action=upper_(action);if(['CREATE CUSTOMER','CREATE CONTACT','CREATE LOCATION','APPROVE PROPOSED ACTION'].indexOf(action)<0)return'';if(clean_(r['Work Order ID'])||upper_(r['Current Stage'])==='SALES ORDER CREATED')return'DURABLE_SALES_ORDER_ALREADY_EXISTS';var sync=upper_(r['Striven Sync Status']),recon=upper_(r['Reconciliation Status']),next=upper_(r['Next Action']),block=upper_(r['Blocking Issue']);if(sync==='RECONCILE REQUIRED'||next.indexOf('RECONCILE')===0||recon.indexOf('UNCERTAIN')>=0||recon.indexOf('RECONCILE')>=0||block.indexOf('PRIOR WRITE MAY HAVE SUCCEEDED')>=0||block.indexOf('DO NOT RETRY')>=0)return'RECONCILE_REQUIRED_DO_NOT_RETRY';return'';}
  
  /* CF_SERVICEOPS_V5_13_3_QUEUE_TRIGGER_HYGIENE_R1_HELPER */
  function CF_V5133_createDedupedOneShot_(handlerName,delayMs){
    handlerName=String(handlerName||'');var existing=[];try{existing=ScriptApp.getProjectTriggers().filter(function(t){try{return t.getEventType()===ScriptApp.EventType.CLOCK&&t.getHandlerFunction()===handlerName;}catch(e){return false;}});}catch(e){}
    if(existing.length>1){for(var i=1;i<existing.length;i++){try{ScriptApp.deleteTrigger(existing[i]);}catch(ignored){}}try{if(CF.Util&&CF.Util.logEvent)CF.Util.logEvent({module:'50_Operator_Queue',action:'QUEUE_TRIGGER_DEDUPED',status:'COMPLETE',details:{handler:handlerName,removed:existing.length-1},version:'5.13.3'});}catch(logErr){}}
    if(existing.length)return existing[0];
    try{return ScriptApp.newTrigger(handlerName).timeBased().after(Math.max(1000,Number(delayMs)||5000)).create();}
    catch(e){var msg=String(e&&e.message||e);if(/too many triggers|trigger.*quota|quota.*trigger/i.test(msg)){try{if(CF.Util&&CF.Util.logEvent)CF.Util.logEvent({module:'50_Operator_Queue',action:'QUEUE_TRIGGER_QUOTA_FAIL_SOFT',status:'SKIPPED',message:msg,details:{handler:handlerName,queueStatePreserved:true,businessWriteNotFailed:true},version:'5.13.3'});}catch(logErr2){}return{getUniqueId:function(){return'';},getHandlerFunction:function(){return handlerName;},getEventType:function(){return ScriptApp.EventType.CLOCK;},__cfV5133QuotaDeferred:true};}throw e;}
  }
function scheduleDirtyRow_(rowNumber){rowNumber=Number(rowNumber||0);if(!rowNumber)return;var lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;try{var p=PropertiesService.getScriptProperties(),rows=[];try{rows=JSON.parse(p.getProperty(DIRTY_ROWS_PROP)||'[]');}catch(e){rows=[];}if(!Array.isArray(rows))rows=[];if(rows.indexOf(rowNumber)<0)rows.push(rowNumber);if(rows.length>100)rows=rows.slice(-100);p.setProperty(DIRTY_ROWS_PROP,JSON.stringify(rows));var scheduled=Number(p.getProperty(SCHEDULED_AT_PROP)||0),stale=!scheduled||(nowMs_()-scheduled>120000);if(stale){CF_V5133_createDedupedOneShot_(TRIGGER,5000);p.setProperty(SCHEDULED_AT_PROP,String(nowMs_()));}}finally{lock.releaseLock();}}
  function flushPending_(){var p=PropertiesService.getScriptProperties(),rows=[];try{rows=JSON.parse(p.getProperty(DIRTY_ROWS_PROP)||'[]');}catch(e){rows=[];}p.deleteProperty(DIRTY_ROWS_PROP);p.deleteProperty(SCHEDULED_AT_PROP);if(!Array.isArray(rows)||!rows.length)return{ok:true,status:'NO_DIRTY_ROWS',version:VERSION};SpreadsheetApp.flush();if(rows.length>8){var full=refreshAll_({verifyLimit:25});return{ok:!full||full.ok!==false,status:'COALESCED_FULL_REFRESH',dirtyRows:rows.length,fullRefresh:full,version:VERSION};}var sheet=CF.Util.requireSheet('SERVICE_REQUESTS'),headers=CF.Util.getActualHeaders(sheet),idCol=headers.indexOf('Request ID')+1,results=[];rows.forEach(function(row){if(row<2||row>sheet.getLastRow()||!idCol)return;var id=clean_(sheet.getRange(row,idCol).getDisplayValue());if(id)results.push(refreshRequest_(id,{fullFallback:true,verifyLimit:25}));});var ok=results.every(function(x){return x&&x.ok!==false;});return{ok:ok,status:ok?'DIRTY_ROWS_REFRESHED':'DIRTY_ROW_REFRESH_FAILED',dirtyRows:rows.length,results:results,version:VERSION};}

  CF.OperatorQueue.refresh=function(){return refreshAll_({verifyLimit:20});};
  CF.OperatorQueue.refreshRequest=refreshRequest_;
  CF.OperatorQueue.verifyRequestParity=verifyRequest_;
  CF.OperatorQueue.verifyRecentParity=verifyRecent_;
  CF.OperatorQueue.flushPendingMutationSync=flushPending_;
  CF.OperatorQueue.projectStatusTimingAll=applyStatusTimingProjectionAll_;

  if(typeof baseApply==='function')CF.OperatorQueue.applyOperatorDecision=function(requestId,decision){SpreadsheetApp.flush();var r=request_(requestId);if(!r)throw new Error('Service Request not found: '+clean_(requestId));var action=upper_(decision&&decision.action||r['Operator Action']),reason=unsafeWriteReason_(r,action);if(reason){try{refreshRequest_(requestId,{fullFallback:true});}catch(e){}throw new Error(reason+' | Authoritative Service Request state blocks '+action+'. Refresh/reconcile; never retry the live create POST.');}var out=baseApply.apply(CF.OperatorQueue,arguments);SpreadsheetApp.flush();var sync=refreshRequest_(requestId,{fullFallback:true,verifyLimit:25});if(out&&typeof out==='object')out.queueCommitSync=sync;return out;};
  if(typeof basePatchRow==='function')CF.Util.patchRow=function(sheetKey,rowNumber,patch){var out=basePatchRow.apply(CF.Util,arguments);if(upper_(sheetKey)==='SERVICE_REQUESTS'&&relevantPatch_(patch))scheduleDirtyRow_(rowNumber);return out;};

  CF.OperatorQueue.__queueTimingHardeningV5131R1=true;
})();

function AUTO_CF_QUEUE_SYNC_AFTER_SERVICE_REQUEST_MUTATION(e){return(typeof CF!=='undefined'&&CF.OperatorQueue&&typeof CF.OperatorQueue.flushPendingMutationSync==='function')?CF.OperatorQueue.flushPendingMutationSync():{ok:false,status:'QUEUE_SYNC_MODULE_MISSING'};}

function TESTING_CF_QUEUE_VERIFY_RECENT_20(){
  if(typeof CF==='undefined'||!CF.OperatorQueue)throw new Error('CF.OperatorQueue unavailable.');
  var refresh=CF.OperatorQueue.refresh(),parity=CF.OperatorQueue.verifyRecentParity(20),out={ok:parity.ok,version:'5.13.1',status:parity.ok?'RECENT_20_QUEUE_TIMING_PARITY_VERIFIED':'QUEUE_PARITY_FAILED',parity:parity,refresh:refresh,liveStrivenWriteExecuted:false};
  console.log(JSON.stringify(out));if(!parity.ok)throw new Error('QUEUE_PARITY_FAILED | '+JSON.stringify(parity));return out;
}

function TESTING_CF_V5131_RELEASE_ACCEPTANCE(){
  if(typeof CF==='undefined'||!CF.OperatorQueue||!CF.ServiceOrderTaxContract)throw new Error('v5.13.1 acceptance dependencies unavailable.');
  var sample={LineItems:[{Item:{Id:41481},Qty:1,Price:200},{Item:{Id:41434},Qty:1,Price:176.99},{Item:{Id:99999},Qty:1,Price:1}]};
  var applied=CF.ServiceOrderTaxContract.applyPayload(sample),lines=applied.payload.LineItems||[];
  var taxContractOk=lines[0]&&lines[0].Taxable===true&&lines[1]&&lines[1].Taxable===true&&!Object.prototype.hasOwnProperty.call(lines[2]||{},'Taxable');
  var historicalTaxAudit=CF.ServiceOrderTaxContract.auditRecent(20);
  var refresh=CF.OperatorQueue.refresh(),parity=CF.OperatorQueue.verifyRecentParity(20);
  var out={ok:taxContractOk&&parity.ok,version:'5.13.1',status:(taxContractOk&&parity.ok)?'RELEASE_ACCEPTANCE_CLEAR':'RELEASE_ACCEPTANCE_REVIEW_REQUIRED',taxContractSampleOk:taxContractOk,historicalTaxAudit:historicalTaxAudit,queueParity:parity,queueRefresh:refresh,liveStrivenWriteExecuted:false};
  console.log(JSON.stringify(out));if(!taxContractOk)throw new Error('TAX_CONTRACT_SAMPLE_FAILED');if(!parity.ok)throw new Error('QUEUE_PARITY_FAILED | '+JSON.stringify(parity));return out;
}
/* END CF_SERVICEOPS_V5_13_1_QUEUE_TIMING_HARDENING_R1 */
