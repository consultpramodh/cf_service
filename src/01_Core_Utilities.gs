/************************************************************
 * APPS SCRIPT — 01_Core_Utilities.gs
 * CF ServiceOps — Shared Infrastructure
 * Version: 5.14.4
 ************************************************************/
var CF = CF || {};

CF.Util = (function () {
  'use strict';

  var VERSION = '5.14.4';

  function config_() {
    if (!CF.Config) throw new Error('CF.Config is required.');
    return CF.Config;
  }

  function cleanText(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function isBlank(value) {
    return value === null || value === undefined || cleanText(value) === '';
  }

  function stripDiacritics_(value) {
    var text = cleanText(value);
    try { return text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) { return text; }
  }

  function toParagraphCase(value) {
    var text = cleanText(value);
    if (!text) return '';
    return text.toLowerCase().replace(/(^|[\s,./()'-])([a-z])/g, function (_, p, c) { return p + c.toUpperCase(); })
      .replace(/\bPo Box\b/g, 'PO Box').replace(/\bRr\b/g, 'RR');
  }

  function normalizeName(value) {
    return toParagraphCase(stripDiacritics_(value).replace(/[^A-Za-z0-9' &-]/g, ' '));
  }

  function normalizeEmail(value) {
    return cleanText(value).toLowerCase();
  }

  function parsePhone(value) {
    var text = cleanText(value);
    var extension = '';
    var match = text.match(/(?:ext\.?|extension|x)\s*(\d+)\s*$/i);
    if (match) {
      extension = match[1];
      text = text.slice(0, match.index);
    }
    var digits = text.replace(/\D/g, '');
    if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
    return { number: digits, extension: extension };
  }

  function normalizePhone(value) { return parsePhone(value).number; }
  function normalizePostal(value) { return cleanText(value).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  function normalizeAddress(value) {
    return stripDiacritics_(value).toUpperCase()
      .replace(/\bSTREET\b/g, 'ST').replace(/\bROAD\b/g, 'RD').replace(/\bAVENUE\b/g, 'AVE')
      .replace(/\bBOULEVARD\b/g, 'BLVD').replace(/\bDRIVE\b/g, 'DR').replace(/\bCOURT\b/g, 'CT')
      .replace(/\bCRESCENT\b/g, 'CRES').replace(/\bLANE\b/g, 'LN')
      .replace(/[^A-Z0-9]/g, '');
  }

  function normalizeKey(value) {
    return stripDiacritics_(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function buildFullName(firstName, lastName) {
    return cleanText([firstName, lastName].filter(function (x) { return !isBlank(x); }).join(' '));
  }

  function buildFullAddress(street, city, province, postalCode, country) {
    return [street, city, province, postalCode, country].map(cleanText).filter(Boolean).join(', ');
  }

  function truncate(value, maximum) {
    var text = value === null || value === undefined ? '' : String(value);
    return text.length <= maximum ? text : text.slice(0, Math.max(0, maximum - 1)) + '…';
  }

  function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

  function safeJson(value, fallback) {
    try { return JSON.stringify(value === undefined ? null : value); } catch (e) { return fallback === undefined ? '{}' : fallback; }
  }

  function parseJson(value, fallback) {
    if (typeof value === 'object' && value !== null) return value;
    try { return JSON.parse(String(value || '')); } catch (e) { return fallback === undefined ? {} : fallback; }
  }

  function canonicalize_(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonicalize_);
    if (typeof value === 'object') {
      var out = {};
      Object.keys(value).sort().forEach(function (key) { out[key] = canonicalize_(value[key]); });
      return out;
    }
    return value;
  }

  function canonicalJson(value) { return JSON.stringify(canonicalize_(value)); }

  function sha256(value) {
    var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8);
    return bytes.map(function (b) { var v = b < 0 ? b + 256 : b; return ('0' + v.toString(16)).slice(-2); }).join('');
  }

  function canonicalHash(value) { return sha256(canonicalJson(value)); }
  function now() { return new Date(); }
  function formatDate(value, pattern) { return Utilities.formatDate(new Date(value), config_().getTimezone(), pattern || 'yyyy-MM-dd HH:mm:ss'); }
  function nowString() { return formatDate(new Date(), 'yyyy-MM-dd HH:mm:ss'); }
  function uuid() { return Utilities.getUuid(); }
  function generateId(prefix) { return prefix + '-' + formatDate(new Date(), 'yyyyMMddHHmmss') + '-' + (Math.floor(Math.random() * 9000) + 1000); }

  function flattenObject(input, prefix, output) {
    output = output || {};
    prefix = prefix || '';
    if (input === null || input === undefined) return output;
    if (typeof input !== 'object' || input instanceof Date || Array.isArray(input)) {
      output[prefix] = input;
      return output;
    }
    Object.keys(input).forEach(function (key) {
      var path = prefix ? prefix + '.' + key : key;
      if (input[key] && typeof input[key] === 'object' && !Array.isArray(input[key]) && !(input[key] instanceof Date)) {
        flattenObject(input[key], path, output);
      } else {
        output[path] = input[key];
      }
    });
    return output;
  }

  function getAny(source, aliases, fallback) {
    var flat = flattenObject(source || {});
    var lower = {};
    Object.keys(flat).forEach(function (key) { lower[key.toLowerCase()] = flat[key]; });
    for (var i = 0; i < (aliases || []).length; i++) {
      var alias = aliases[i];
      if (source && source[alias] !== undefined && !isBlank(source[alias])) return source[alias];
      if (flat[alias] !== undefined && !isBlank(flat[alias])) return flat[alias];
      if (lower[String(alias).toLowerCase()] !== undefined && !isBlank(lower[String(alias).toLowerCase()])) return lower[String(alias).toLowerCase()];
    }
    return fallback === undefined ? '' : fallback;
  }

  function getScriptProperties_() { return PropertiesService.getScriptProperties(); }

  function resolveProperty(key, options) {
    options = options || {};
    var definition = config_().getPropertyDefinition(key);
    var properties = getScriptProperties_().getProperties();
    var candidates = definition.candidates || [key];
    for (var i = 0; i < candidates.length; i++) {
      if (!isBlank(properties[candidates[i]])) return { found: true, key: candidates[i], value: properties[candidates[i]], aliasUsed: candidates[i] !== key };
    }
    if (options.allowDefault !== false && definition.defaultValue !== undefined) return { found: true, key: key, value: definition.defaultValue, defaultUsed: true };
    return { found: false, key: '', value: '' };
  }

  function getProperty(key, fallback, options) {
    var result = resolveProperty(key, options || {});
    return result.found ? result.value : (fallback === undefined ? '' : fallback);
  }

  function requireProperty(key, options) {
    var result = resolveProperty(key, options || {});
    if (!result.found || isBlank(result.value)) throw new Error('Missing Script Property: ' + key);
    return result.value;
  }

  function setCanonicalProperty(key, value) {
    getScriptProperties_().setProperty(key, String(value));
  }

  function getBooleanProperty(key, fallback) {
    var value = cleanText(getProperty(key, String(fallback))).toLowerCase();
    return ['true','1','yes','y','on'].indexOf(value) !== -1;
  }

  function getNumberProperty(key, fallback) {
    var value = Number(getProperty(key, fallback));
    return isNaN(value) ? Number(fallback || 0) : value;
  }

  function getSpreadsheet() {
    var active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
    var id = getProperty('SPREADSHEET_ID', '', { allowDefault: false });
    if (id) return SpreadsheetApp.openById(id);
    throw new Error('No active spreadsheet. Set SPREADSHEET_ID in Script Properties.');
  }

  function getSheet(keyOrName) {
    var ss = getSpreadsheet();
    var candidates = typeof config_().getSheetCandidates === 'function'
      ? config_().getSheetCandidates(keyOrName)
      : [config_().resolveSheetName(keyOrName)];
    var matches = candidates.map(function (name) { return ss.getSheetByName(name); }).filter(Boolean);
    if (matches.length > 1) {
      throw new Error('Sheet name conflict for ' + keyOrName + ': ' + matches.map(function (sheet) { return sheet.getName(); }).join(', '));
    }
    return matches.length ? matches[0] : null;
  }
  function requireSheet(keyOrName) {
    var sheet = getSheet(keyOrName);
    if (!sheet) throw new Error('Missing sheet: ' + config_().resolveSheetName(keyOrName));
    return sheet;
  }

  function ensureGridSize(sheet, rows, columns) {
    if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
    if (sheet.getMaxColumns() < columns) sheet.insertColumnsAfter(sheet.getMaxColumns(), columns - sheet.getMaxColumns());
  }

  function getOrCreateSheet(keyOrName) {
    var sheet = getSheet(keyOrName);
    if (sheet) return sheet;
    var name = config_().resolveSheetName(keyOrName);
    return getSpreadsheet().insertSheet(name);
  }

  function getActualHeaders(sheetOrKey) {
    var sheet = typeof sheetOrKey === 'string' ? requireSheet(sheetOrKey) : sheetOrKey;
    var lastColumn = Math.max(sheet.getLastColumn(), 1);
    return sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(cleanText);
  }

  function getHeaderMap(sheetOrKey) {
    var map = {};
    getActualHeaders(sheetOrKey).forEach(function (header, index) { if (header) map[header] = index + 1; });
    return map;
  }

  function setHeaders(sheetOrKey, headers) {
    var sheet = typeof sheetOrKey === 'string' ? getOrCreateSheet(sheetOrKey) : sheetOrKey;
    headers = headers || config_().getHeaders(sheet.getName());
    ensureGridSize(sheet, Math.max(2, sheet.getMaxRows()), Math.max(1, headers.length));
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    if (sheet.getLastColumn() > headers.length) sheet.getRange(1, headers.length + 1, 1, sheet.getLastColumn() - headers.length).clearContent();
    sheet.setFrozenRows(1);
    return sheet;
  }

  function makeBlankRecord(keyOrName) {
    var record = {};
    config_().getHeaders(keyOrName).forEach(function (header) { record[header] = ''; });
    return record;
  }

  function recordToRow(keyOrName, record) {
    return config_().getHeaders(keyOrName).map(function (header) {
      var value = record && record[header] !== undefined && record[header] !== null ? record[header] : '';
      if (typeof value === 'string' && value.charAt(0) === '=') return "'" + value;
      if (typeof value === 'object' && !(value instanceof Date)) return truncate(safeJson(value), 45000);
      return value;
    });
  }

  function rowToRecord(headers, row, rowNumber) {
    var record = {};
    headers.forEach(function (header, index) { record[header] = row[index] === undefined || row[index] === null ? '' : row[index]; });
    if (rowNumber) record.__rowNumber = rowNumber;
    return record;
  }

  function readRecords(keyOrName, options) {
    options = options || {};
    var sheet = requireSheet(keyOrName);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    var headers = getActualHeaders(sheet);
    var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    return values.map(function (row, index) { return rowToRecord(headers, row, options.includeRowNumber === false ? 0 : index + 2); });
  }

  function appendRecord(keyOrName, record) {
    var sheet = requireSheet(keyOrName);
    var row = recordToRow(keyOrName, record);
    var rowNumber = sheet.getLastRow() + 1;
    ensureGridSize(sheet, rowNumber, row.length);
    sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
    return rowNumber;
  }

  function replaceSheetData(keyOrName, records) {
    var sheet = getOrCreateSheet(keyOrName);
    var headers = config_().getHeaders(keyOrName);
    setHeaders(sheet, headers);
    var oldRows = Math.max(0, sheet.getLastRow() - 1);
    if (oldRows) sheet.getRange(2, 1, oldRows, Math.max(sheet.getLastColumn(), headers.length)).clearContent();
    if (!records || !records.length) return { rows: 0, columns: headers.length };
    var rows = records.map(function (record) { return recordToRow(keyOrName, record); });
    ensureGridSize(sheet, rows.length + 1, headers.length);
    var batch = 5000;
    for (var start = 0; start < rows.length; start += batch) {
      var chunk = rows.slice(start, start + batch);
      sheet.getRange(start + 2, 1, chunk.length, headers.length).setValues(chunk);
    }
    return { rows: rows.length, columns: headers.length };
  }

  function groupContiguousColumns_(patch, headerMap) {
    var items = Object.keys(patch).filter(function (key) { return headerMap[key]; }).map(function (key) {
      return { header: key, column: headerMap[key], value: patch[key] };
    }).sort(function (a, b) { return a.column - b.column; });
    var groups = [];
    items.forEach(function (item) {
      var group = groups.length ? groups[groups.length - 1] : null;
      if (!group || item.column !== group.end + 1) {
        group = { start: item.column, end: item.column, values: [item.value] };
        groups.push(group);
      } else {
        group.end = item.column;
        group.values.push(item.value);
      }
    });
    return groups;
  }

  function isTechnicalSheet_(sheet) {
    var config = config_();
    var names = typeof config.getTechnicalSheetNames === 'function'
      ? config.getTechnicalSheetNames()
      : [];
    return names.indexOf(sheet.getName()) !== -1;
  }

  function clearRowDataValidations(keyOrName, rowNumber) {
    var sheet = requireSheet(keyOrName);
    if (rowNumber < 2 || rowNumber > sheet.getMaxRows()) return 0;
    var columns = Math.max(sheet.getLastColumn(), 1);
    sheet.getRange(rowNumber, 1, 1, columns).clearDataValidations();
    return columns;
  }

  function clearSheetDataValidations(keyOrName) {
    var sheet = requireSheet(keyOrName);
    var rows = Math.max(0, sheet.getLastRow() - 1);
    var columns = Math.max(sheet.getLastColumn(), 1);
    if (rows > 0) sheet.getRange(2, 1, rows, columns).clearDataValidations();
    return { rows: rows, columns: columns, cells: rows * columns };
  }

  function writeTechnicalRange_(sheet, range, values) {
    try {
      range.setValues([values]);
    } catch (error) {
      var message = error && error.message ? error.message : String(error);
      if (!isTechnicalSheet_(sheet) || !/data validation/i.test(message)) throw error;
      range.clearDataValidations();
      SpreadsheetApp.flush();
      range.setValues([values]);
    }
  }

  function patchRow(keyOrName, rowNumber, patch) {
    var sheet = requireSheet(keyOrName);
    var map = getHeaderMap(sheet);
    groupContiguousColumns_(patch, map).forEach(function (group) {
      var values = group.values.map(function (value) {
        if (typeof value === 'object' && !(value instanceof Date)) return truncate(safeJson(value), 45000);
        return typeof value === 'string' && value.charAt(0) === '=' ? "'" + value : value;
      });
      var range = sheet.getRange(rowNumber, group.start, 1, values.length);
      writeTechnicalRange_(sheet, range, values);
    });
    return patch;
  }

  function findRecord(keyOrName, header, value) {
    var target = cleanText(value);
    var records = readRecords(keyOrName);
    for (var i = 0; i < records.length; i++) if (cleanText(records[i][header]) === target) return records[i];
    return null;
  }

  function withScriptLock(callback, timeoutMs) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(timeoutMs || 30000)) throw new Error('Another CF ServiceOps execution is already running.');
    try { return callback(); } finally { lock.releaseLock(); }
  }

  function joinUrl(base, path) { return cleanText(base).replace(/\/+$/, '') + '/' + cleanText(path).replace(/^\/+/, ''); }

  function httpRequest(url, options) {
    options = options || {};
    var attempts = Math.max(1, Number(options.attempts || 1));
    var lastError;
    for (var attempt = 1; attempt <= attempts; attempt++) {
      var retryable = true;
      try {
        var response = UrlFetchApp.fetch(url, {
          method: options.method || 'get',
          headers: options.headers || {},
          payload: options.payload,
          contentType: options.contentType,
          muteHttpExceptions: true
        });
        var status = response.getResponseCode();
        var text = response.getContentText();
        if (status >= 200 && status < 300) return { ok: true, status: status, text: text, json: parseJson(text, {}) };
        lastError = new Error('HTTP ' + status + ': ' + truncate(text, 500));
        if (status < 500 && status !== 429) { retryable = false; throw lastError; }
      } catch (error) {
        lastError = error;
        if (!retryable) break;
      }
      if (attempt < attempts) Utilities.sleep(Math.min(8000, 500 * Math.pow(2, attempt - 1)));
    }
    throw lastError || new Error('HTTP request failed.');
  }

  function logEvent(entry) {
    entry = entry || {};
    try {
      var record = makeBlankRecord('SYSTEM_LOG');
      record['Timestamp'] = nowString();
      record['Severity'] = entry.severity || 'INFO';
      record['Module'] = entry.module || '';
      record['Action'] = entry.action || '';
      record['Status'] = entry.status || '';
      record['Request ID'] = entry.requestId || '';
      record['Correlation ID'] = entry.correlationId || '';
      record['Message'] = truncate(entry.message || '', 1000);
      record['Details JSON'] = truncate(safeJson(entry.details || {}), 45000);
      record['Sheet'] = entry.sheet || '';
      record['Row'] = entry.row || '';
      record['Actor'] = entry.actor || '';
      record['Duration Ms'] = entry.durationMs || '';
      record['Version'] = entry.version || VERSION;
      appendRecord('SYSTEM_LOG', record);
    } catch (ignored) {}
  }

  return {
    version: VERSION,
    cleanText: cleanText,
    isBlank: isBlank,
    toParagraphCase: toParagraphCase,
    normalizeName: normalizeName,
    normalizeEmail: normalizeEmail,
    parsePhone: parsePhone,
    normalizePhone: normalizePhone,
    normalizePostal: normalizePostal,
    normalizeAddress: normalizeAddress,
    normalizeKey: normalizeKey,
    buildFullName: buildFullName,
    buildFullAddress: buildFullAddress,
    truncate: truncate,
    clone: clone,
    safeJson: safeJson,
    parseJson: parseJson,
    canonicalJson: canonicalJson,
    canonicalHash: canonicalHash,
    now: now,
    formatDate: formatDate,
    nowString: nowString,
    uuid: uuid,
    generateId: generateId,
    flattenObject: flattenObject,
    getAny: getAny,
    resolveProperty: resolveProperty,
    getProperty: getProperty,
    requireProperty: requireProperty,
    setCanonicalProperty: setCanonicalProperty,
    getBooleanProperty: getBooleanProperty,
    getNumberProperty: getNumberProperty,
    getSpreadsheet: getSpreadsheet,
    getSheet: getSheet,
    requireSheet: requireSheet,
    getOrCreateSheet: getOrCreateSheet,
    ensureGridSize: ensureGridSize,
    getActualHeaders: getActualHeaders,
    getHeaderMap: getHeaderMap,
    setHeaders: setHeaders,
    makeBlankRecord: makeBlankRecord,
    recordToRow: recordToRow,
    rowToRecord: rowToRecord,
    readRecords: readRecords,
    appendRecord: appendRecord,
    replaceSheetData: replaceSheetData,
    patchRow: patchRow,
    clearRowDataValidations: clearRowDataValidations,
    clearSheetDataValidations: clearSheetDataValidations,
    findRecord: findRecord,
    withScriptLock: withScriptLock,
    joinUrl: joinUrl,
    httpRequest: httpRequest,
    logEvent: logEvent
  };
})();

