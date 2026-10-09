/* CF_SERVICEOPS_V5_13_4_OPERATIONAL_CACHE_GRID_HYGIENE_R1 */
/* CF_SERVICEOPS_V5_13_3_API_BRAKE_R1 */
/************************************************************
 * APPS SCRIPT — 30_Striven_Data.gs
 * CF ServiceOps — Striven Read Caches
 * Version: 5.14.4
 ************************************************************/
var CF = CF || {};

CF.StrivenHttp = (function () {
  'use strict';
  var VERSION = '5.14.4';

  function deps_() {
    if (!CF.Config || !CF.Util) throw new Error('CF.Config and CF.Util are required.');
    return { config: CF.Config, util: CF.Util };
  }

  function baseUrl_() { return deps_().util.cleanText(deps_().util.getProperty('STRIVEN_BASE_URL', 'https://api.striven.com')).replace(/\/+$/, ''); }

  function token_() {
    var d = deps_();
    var token = d.util.getProperty('STRIVEN_ACCESS_TOKEN', '', { allowDefault: false });
    var expiresAt = Number(d.util.getProperty('STRIVEN_TOKEN_EXPIRES_AT', '0', { allowDefault: false }) || 0);
    var buffer = Number(d.config.getDefault('STRIVEN_TOKEN_REFRESH_BUFFER_SECONDS')) * 1000;
    if (token && (!expiresAt || expiresAt - Date.now() > buffer)) return token;

    var clientId = d.util.requireProperty('STRIVEN_CLIENT_ID', { allowDefault: false });
    var clientSecret = d.util.requireProperty('STRIVEN_CLIENT_SECRET', { allowDefault: false });
    var response = d.util.httpRequest(d.util.joinUrl(baseUrl_(), d.config.getEndpoint('ACCESS_TOKEN')), {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: 'grant_type=client_credentials',
      headers: { Authorization: 'Basic ' + Utilities.base64Encode(String(clientId) + ':' + String(clientSecret)), Accept: 'application/json' },
      attempts: 1
    });
    var body = response.json || {};
    token = body.access_token || body.accessToken || body.token || '';
    if (!token) throw new Error('Striven token response did not include an access token.');
    expiresAt = Date.now() + Math.max(60, Number(body.expires_in || body.expiresIn || 3600)) * 1000;
    d.util.setCanonicalProperty('STRIVEN_ACCESS_TOKEN', token);
    d.util.setCanonicalProperty('STRIVEN_TOKEN_EXPIRES_AT', String(expiresAt));
    return token;
  }

  function requestJson(pathOrUrl, options) {
    options = options || {};
    var d = deps_();
    var url = /^https?:\/\//i.test(String(pathOrUrl || '')) ? String(pathOrUrl) : d.util.joinUrl(baseUrl_(), pathOrUrl);
    var headers = options.headers || {};
    if (options.authMode !== 'NONE') headers.Authorization = 'Bearer ' + token_();
    headers.Accept = headers.Accept || 'application/json';
    return d.util.httpRequest(url, {
      method: options.method || 'get',
      headers: headers,
      payload: options.payload === undefined ? undefined : (typeof options.payload === 'string' ? options.payload : JSON.stringify(options.payload)),
      contentType: options.contentType || (options.payload === undefined ? undefined : 'application/json'),
      attempts: options.idempotent === false ? 1 : Number(options.attempts || d.config.getDefault('STRIVEN_MAX_READ_RETRIES'))
    });
  }

  function reportUrl(reportValue, pageIndex, pageSize) {
    var value = deps_().util.cleanText(reportValue);
    if (!value) throw new Error('A Striven report URL or API key is required.');
    var url = /^https?:\/\//i.test(value) ? value : baseUrl_() + '/v2/reports/' + encodeURIComponent(value);
    var separator = url.indexOf('?') === -1 ? '?' : '&';
    return url + separator + 'PageIndex=' + encodeURIComponent(pageIndex) + '&PageSize=' + encodeURIComponent(pageSize);
  }

  function findRows_(value, depth) {
    depth = depth || 0;
    if (depth > 6 || value === null || value === undefined) return null;
    if (Array.isArray(value)) {
      if (!value.length) return [];
      if (value[0] && typeof value[0] === 'object' && !Array.isArray(value[0])) return value;
      return null;
    }
    if (typeof value !== 'object') return null;
    var keys = ['Data','data','Results','results','Rows','rows','Items','items','Records','records','Value','value'];
    for (var i = 0; i < keys.length; i++) {
      var candidate = value[keys[i]];
      if (Array.isArray(candidate) && (!candidate.length || (candidate[0] && typeof candidate[0] === 'object' && !Array.isArray(candidate[0])))) return candidate;
      if (Array.isArray(candidate) && candidate.length && Array.isArray(candidate[0])) {
        var columns = value.Columns || value.columns || value.ColumnNames || value.columnNames || [];
        var names = columns.map(function (column) { return typeof column === 'string' ? column : (column.Name || column.name || column.ColumnName || column.columnName || ''); });
        if (names.length) return candidate.map(function (row) { var out = {}; names.forEach(function (name, index) { if (name) out[name] = row[index] === undefined ? '' : row[index]; }); return out; });
      }
    }
    var objectKeys = Object.keys(value);
    for (var j = 0; j < objectKeys.length; j++) {
      var nested = findRows_(value[objectKeys[j]], depth + 1);
      if (nested !== null) return nested;
    }
    return null;
  }

  function extractRows(response) {
    return (findRows_(response && response.json !== undefined ? response.json : response, 0) || []).map(function (record) {
      var output = {};
      Object.keys(record || {}).forEach(function (key) {
        var value = record[key];
        output[String(key).trim()] = value && typeof value === 'object' ? JSON.stringify(value) : (value === null || value === undefined ? '' : value);
      });
      return output;
    });
  }

  function fetchReport(reportValue, options) {
    options = options || {};
    var d = deps_();
    var pageSize = Number(options.pageSize || d.config.getDefault('STRIVEN_PAGE_SIZE'));
    var maxPages = Number(options.maxPages || d.config.getDefault('STRIVEN_MAX_PAGES'));
    var rows = [];
    for (var page = 0; page < maxPages; page++) {
      var current = extractRows(requestJson(reportUrl(reportValue, page, pageSize), { method: 'get' }));
      if (!current.length) return { rows: rows, pagesFetched: page + 1, stopReason: 'EMPTY PAGE' };
      Array.prototype.push.apply(rows, current);
      if (current.length < pageSize) return { rows: rows, pagesFetched: page + 1, stopReason: 'SHORT PAGE' };
    }
    return { rows: rows, pagesFetched: maxPages, stopReason: 'MAX PAGES' };
  }

  return { version: VERSION, requestJson: requestJson, fetchReport: fetchReport };
})();

CF.StrivenData = (function () {
  'use strict';

  var MODULE_NAME = '30_Striven_Data';
  var VERSION = '5.14.4';

  function deps_() {
    if (!CF.Config || !CF.Util || !CF.StrivenHttp) throw new Error('CF.Config, CF.Util and CF.StrivenHttp are required.');
    return { config: CF.Config, util: CF.Util, http: CF.StrivenHttp };
  }

  function value_(source, entity, field, fallback) {
    var aliases = deps_().config.getReportAliases(entity)[field] || [];
    return deps_().util.getAny(source, aliases, fallback === undefined ? '' : fallback);
  }

  function reportDefinitions_() {
    return {
      CUSTOMERS: {
        property: 'STRIVEN_CUSTOMER_REPORT',
        entity: 'CUSTOMER',
        sheet: 'STRIVEN_CUSTOMER_DATA',
        required: true
      },
      CONTACTS: {
        property: 'STRIVEN_CONTACT_REPORT',
        entity: 'CONTACT',
        sheet: 'STRIVEN_CUSTOMER_DATA',
        required: true
      },
      LOCATIONS: {
        property: 'STRIVEN_CUSTOMER_LOCATION_REPORT',
        entity: 'LOCATION',
        sheet: 'STRIVEN_LOCATION_DATA',
        required: true
      },
      CUSTOMER_ASSETS: {
        property: 'STRIVEN_CUSTOMER_ASSETS_REPORT',
        entity: 'ASSET',
        sheet: 'STRIVEN_OPERATIONAL_DATA',
        required: false
      },
      // Sales Orders = Service Work Orders in this tenant; fetch one canonical feed only.
      SERVICE_WORK_ORDERS: {
        property: 'STRIVEN_WORK_ORDER_REPORT',
        entity: 'WORK_ORDER',
        sheet: 'STRIVEN_OPERATIONAL_DATA',
        required: false
      },
      SERVICE_TASKS: {
        property: 'STRIVEN_TASK_REPORT',
        entity: 'TASK',
        sheet: 'STRIVEN_OPERATIONAL_DATA',
        required: false
      },
      TASKS_CUSTOMERS_ASSETS: {
        property: 'STRIVEN_TASK_RELATIONSHIP_REPORT',
        entity: 'TASK_RELATIONSHIP',
        sheet: 'STRIVEN_OPERATIONAL_DATA',
        required: false
      }
    };
  }

  function resolveReports_() {
    var d = deps_();
    var definitions = reportDefinitions_();
    var out = {};
    Object.keys(definitions).forEach(function (key) {
      var resolved = d.util.resolveProperty(definitions[key].property, { allowDefault: false });
      out[key] = { key: key, definition: definitions[key], found: resolved.found, propertyName: resolved.key, value: resolved.value, aliasUsed: resolved.aliasUsed === true };
    });
    return out;
  }

  function baseCacheRecord_(sheetKey, reportKey, sourceRow, cacheAt) {
    var record = deps_().util.makeBlankRecord(sheetKey);
    record['Cache Updated At'] = cacheAt;
    record['Source Report'] = reportKey;
    record['Source Row'] = sourceRow;
    return record;
  }

  function customerRecord_(source, entity, reportKey, sourceRow, cacheAt) {
    var d = deps_();
    var record = baseCacheRecord_('STRIVEN_CUSTOMER_DATA', reportKey, sourceRow, cacheAt);
    var customerId = d.util.cleanText(value_(source, entity, 'CUSTOMER_ID'));
    var contactId = entity === 'CONTACT' ? d.util.cleanText(value_(source, entity, 'CONTACT_ID')) : '';
    var id = entity === 'CUSTOMER' ? customerId : contactId;
    if (!id) return null;
    var phoneRaw = value_(source, entity, 'PHONE');
    var phone = d.util.parsePhone(phoneRaw);
    var fullName = d.util.toParagraphCase(value_(source, entity, entity === 'CUSTOMER' ? 'CUSTOMER_NAME' : 'FULL_NAME'));
    var firstName = entity === 'CONTACT' ? d.util.toParagraphCase(value_(source, entity, 'FIRST_NAME')) : '';
    var lastName = entity === 'CONTACT' ? d.util.toParagraphCase(value_(source, entity, 'LAST_NAME')) : '';
    if (!fullName) fullName = d.util.buildFullName(firstName, lastName);
    var fullAddress = entity === 'CUSTOMER' ? d.util.toParagraphCase(value_(source, entity, 'FULL_ADDRESS')) : '';
    var postal = entity === 'CUSTOMER' ? value_(source, entity, 'POSTAL') : '';
    record['Entity Type'] = entity;
    record['Entity ID'] = id;
    record['Customer ID'] = customerId;
    record['Contact ID'] = contactId;
    record['Customer Name'] = entity === 'CUSTOMER' ? fullName : d.util.toParagraphCase(value_(source, 'CUSTOMER', 'CUSTOMER_NAME'));
    record['First Name'] = firstName;
    record['Last Name'] = lastName;
    record['Full Name'] = fullName;
    record['Phone'] = phoneRaw;
    record['Normalized Phone'] = phone.number;
    record['Phone Extension'] = phone.extension;
    record['Email'] = value_(source, entity, 'EMAIL');
    record['Normalized Email'] = d.util.normalizeEmail(record['Email']);
    record['Status'] = value_(source, entity, 'STATUS');
    record['Full Address'] = fullAddress;
    record['Normalized Address'] = d.util.normalizeAddress(fullAddress);
    record['City'] = entity === 'CUSTOMER' ? d.util.toParagraphCase(value_(source, entity, 'CITY')) : '';
    record['Postal Code'] = postal;
    record['Normalized Postal'] = d.util.normalizePostal(postal);
    return record;
  }

  function locationRecord_(source, reportKey, sourceRow, cacheAt) {
    var d = deps_();
    var id = d.util.cleanText(value_(source, 'LOCATION', 'LOCATION_ID'));
    if (!id) return null;
    var record = baseCacheRecord_('STRIVEN_LOCATION_DATA', reportKey, sourceRow, cacheAt);
    var address = d.util.toParagraphCase(value_(source, 'LOCATION', 'FULL_ADDRESS'));
    var postal = value_(source, 'LOCATION', 'POSTAL');
    record['Location ID'] = id;
    record['Customer ID'] = d.util.cleanText(value_(source, 'LOCATION', 'CUSTOMER_ID'));
    record['Location Name'] = d.util.toParagraphCase(value_(source, 'LOCATION', 'NAME'));
    record['Full Address'] = address;
    record['Normalized Address'] = d.util.normalizeAddress(address);
    record['City'] = d.util.toParagraphCase(value_(source, 'LOCATION', 'CITY'));
    record['Province'] = d.util.cleanText(value_(source, 'LOCATION', 'PROVINCE')).toUpperCase();
    record['Postal Code'] = postal;
    record['Normalized Postal'] = d.util.normalizePostal(postal);
    record['Country'] = d.util.toParagraphCase(value_(source, 'LOCATION', 'COUNTRY'));
    record['Status'] = value_(source, 'LOCATION', 'STATUS');
    record['Created At'] = value_(source, 'LOCATION', 'CREATED_AT');
    return record;
  }

  function operationalRecord_(source, entity, reportKey, sourceRow, cacheAt) {
    var d = deps_();
    var record = baseCacheRecord_('STRIVEN_OPERATIONAL_DATA', reportKey, sourceRow, cacheAt);
    var id = '';

    if (entity === 'ASSET' || entity === 'WORK_ORDER' || entity === 'TASK') {
      id = d.util.cleanText(value_(source, entity, 'ID'));
    } else if (entity === 'TASK_RELATIONSHIP') {
      id = d.util.cleanText(value_(source, entity, 'TASK_ID'));
    }

    if (!id) return null;

    record['Entity Type'] = entity;
    record['Entity ID'] = id;
    record['Customer ID'] = d.util.cleanText(value_(source, entity, 'CUSTOMER_ID'));
    record['Location ID'] = d.util.cleanText(value_(source, entity, 'LOCATION_ID'));

    if (entity === 'ASSET') {
      record['Asset ID'] = id;
      record['Asset Name'] = d.util.toParagraphCase(value_(source, entity, 'NAME'));
      record['Asset Make'] = d.util.toParagraphCase(value_(source, entity, 'MAKE'));
      record['Asset Model'] = d.util.cleanText(value_(source, entity, 'MODEL'));
      record['Serial Number'] = d.util.cleanText(value_(source, entity, 'SERIAL'));
      record['Install Date'] = value_(source, entity, 'INSTALL_DATE');
      record['Status'] = value_(source, entity, 'STATUS');
    } else if (entity === 'WORK_ORDER') {
      record['Work Order ID'] = id;
      record['Work Order Number'] = d.util.cleanText(value_(source, entity, 'NUMBER'));
      record['Work Order Name'] = d.util.toParagraphCase(value_(source, entity, 'NAME'));
      // SALES_ORDER_DATE_CUTOFF_V1 — true Order Date, distinct from Created At.
      record['Sales Order Date'] = value_(source, entity, 'SALES_ORDER_DATE');
      record['Status'] = value_(source, entity, 'STATUS');
      record['Scheduled Date'] = value_(source, entity, 'SCHEDULED_DATE');
      record['Technician'] = value_(source, entity, 'TECHNICIAN');
      record['Created At'] = value_(source, entity, 'CREATED_AT');
      record['Service Address'] = d.util.toParagraphCase(value_(source, entity, 'ADDRESS'));
    } else {
      record['Task ID'] = id;
      record['Task Name'] = d.util.toParagraphCase(value_(source, entity, 'NAME'));
      record['Work Order Number'] = d.util.cleanText(value_(source, entity, 'WORK_ORDER_NUMBER'));
      record['Status'] = value_(source, entity, 'STATUS');
      record['Scheduled Date'] = value_(source, entity, 'SCHEDULED_DATE');
      record['Technician'] = value_(source, entity, 'TECHNICIAN');
      record['Completed At'] = value_(source, entity, 'COMPLETED_AT');
      record['Description'] = value_(source, entity, 'DESCRIPTION');
      if (entity === 'TASK_RELATIONSHIP') {
        record['Asset ID'] = d.util.cleanText(value_(source, entity, 'ASSET_ID'));
      }
    }

    return record;
  }

  function mergeRowsByKey_(rows, keyBuilder) {
    var d = deps_();
    var map = {};
    var conflicts = 0;
    rows.forEach(function (row) {
      if (!row) return;
      var key = keyBuilder(row);
      if (!key) return;
      if (!map[key]) { map[key] = row; return; }
      var base = map[key];
      Object.keys(row).forEach(function (field) {
        if (field === 'Source Row' || field === 'Mapping Warnings') return;
        if (d.util.isBlank(base[field]) && !d.util.isBlank(row[field])) base[field] = row[field];
        else if (!d.util.isBlank(base[field]) && !d.util.isBlank(row[field]) && String(base[field]) !== String(row[field])) {
          conflicts++;
          var warning = 'Conflicting ' + field + ' values';
          if (String(base['Mapping Warnings'] || '').indexOf(warning) === -1) base['Mapping Warnings'] = [base['Mapping Warnings'], warning].filter(Boolean).join('; ');
        }
      });
    });
    return { rows: Object.keys(map).map(function (key) { return map[key]; }), collapsedRows: rows.filter(Boolean).length - Object.keys(map).length, conflictCount: conflicts };
  }

  function fetchReports_(keys) {
    var d = deps_();
    var reports = resolveReports_();
    var fetchedByValue = {};
    var results = {};
    keys.forEach(function (key) {
      var report = reports[key];
      if (!report || !report.found) { results[key] = { skipped: true, rows: [], error: 'Missing property ' + (report ? report.definition.property : key) }; return; }
      var fingerprint = d.util.canonicalHash(report.value);
      if (!fetchedByValue[fingerprint]) fetchedByValue[fingerprint] = d.http.fetchReport(report.value);
      results[key] = { skipped: false, rows: fetchedByValue[fingerprint].rows, pagesFetched: fetchedByValue[fingerprint].pagesFetched, stopReason: fetchedByValue[fingerprint].stopReason, propertyName: report.propertyName, reusedSource: Object.keys(results).some(function (existingKey) { return results[existingKey] && results[existingKey]._fingerprint === fingerprint; }), _fingerprint: fingerprint };
    });
    return results;
  }


  function summarizeFetched_(fetched) {
    var out = {};
    Object.keys(fetched || {}).forEach(function (key) {
      var item = fetched[key] || {};
      out[key] = {
        skipped: item.skipped === true,
        rows: (item.rows || []).length,
        pagesFetched: item.pagesFetched || 0,
        stopReason: item.stopReason || '',
        propertyName: item.propertyName || '',
        reusedSource: item.reusedSource === true,
        error: item.error || ''
      };
    });
    return out;
  }

  
  /* CF_SERVICEOPS_V5_13_3_API_BRAKE_R1_HELPERS */
  function CF_V5133_floorTtl_(propertyName,floorMinutes){
    var floor=Number(floorMinutes);if(!isFinite(floor)||floor<1)floor=1;
    try{var raw=PropertiesService.getScriptProperties().getProperty(propertyName),n=Number(raw);return isFinite(n)&&n>floor?n:floor;}catch(e){return floor;}
  }
  function CF_V5133_cacheStampMs_(sheetKey){
    try{var d=deps_(),sh=d.util.requireSheet(sheetKey);if(sh.getLastRow()<2)return 0;var hm=d.util.getHeaderMap(sh),c=hm['Cache Updated At'];if(!c)return 0;var v=sh.getRange(2,c).getValue(),dt=v instanceof Date?v:new Date(v);return isNaN(dt.getTime())?0:dt.getTime();}catch(e){return 0;}
  }
  function CF_V5133_logBrake_(action,details){try{deps_().util.logEvent({module:'30_Striven_Data',action:action,status:'SKIPPED',details:details,version:VERSION});}catch(e){}}
  function CF_V5133_refreshGate_(group,sheetKey,ttlProperty,floorMinutes,options){
    options=options||{};var now=Date.now(),ttl=CF_V5133_floorTtl_(ttlProperty,floorMinutes),stamp=CF_V5133_cacheStampMs_(sheetKey),ageMs=stamp?now-stamp:null;
    var forced=options.forceApiRefresh===true&&options.operatorConfirmed===true;
    var props=PropertiesService.getScriptProperties(),attemptKey='CF_SERVICEOPS_API_BRAKE_LAST_ATTEMPT_'+group+'_MS',last=Number(props.getProperty(attemptKey)||0);
    if(!isFinite(last)||last<0||last>now+300000)last=0;
    if(!forced&&stamp&&ageMs>=0&&ageMs<=ttl*60000){var fresh={ok:true,allow:false,status:'BULK_REFRESH_SKIPPED_FRESH_CACHE',group:group,ttlMinutes:ttl,cacheAgeMinutes:Math.round(ageMs/6000)/10,apiCallsSuppressed:true,liveWriteExecuted:false};CF_V5133_logBrake_(fresh.status,fresh);return fresh;}
    if(!forced&&last&&now-last<=ttl*60000){var cool={ok:true,allow:false,status:'BULK_REFRESH_SKIPPED_COOLDOWN',group:group,ttlMinutes:ttl,minutesSinceLastAttempt:Math.round((now-last)/6000)/10,apiCallsSuppressed:true,liveWriteExecuted:false};CF_V5133_logBrake_(cool.status,cool);return cool;}
    props.setProperty(attemptKey,String(now));return{ok:true,allow:true,status:forced?'BULK_REFRESH_FORCED_MANUAL':'BULK_REFRESH_ALLOWED_STALE',group:group,ttlMinutes:ttl,forced:forced,cacheAgeMinutes:ageMs===null?null:Math.round(ageMs/6000)/10,apiCallsSuppressed:false};
  }
  function CF_V5133_skipResult_(gate){return{ok:true,version:VERSION,group:gate.group,status:gate.status,ttlMinutes:gate.ttlMinutes,cacheAgeMinutes:gate.cacheAgeMinutes,minutesSinceLastAttempt:gate.minutesSinceLastAttempt,apiCallsSuppressed:true,liveWriteExecuted:false,reports:{}};}
function CF_V5133_refreshCustomerDataBase_(options) {
    options = options || {};
    var d = deps_();
    return d.util.withScriptLock(function () {
      var started = Date.now();
      var cacheAt = d.util.nowString();
      var fetched = fetchReports_(['CUSTOMERS','CONTACTS']);
      var rows = [];
      ['CUSTOMERS','CONTACTS'].forEach(function (key) {
        var entity = key === 'CUSTOMERS' ? 'CUSTOMER' : 'CONTACT';
        (fetched[key].rows || []).forEach(function (source, index) { rows.push(customerRecord_(source, entity, key, index + 2, cacheAt)); });
      });
      var consolidated = mergeRowsByKey_(rows, function (row) { return row['Entity Type'] + '|' + row['Entity ID']; });
      var write = d.util.replaceSheetData('STRIVEN_CUSTOMER_DATA', consolidated.rows);
      var result = { ok: true, version: VERSION, group: 'CUSTOMER', rowsPrepared: consolidated.rows.length, rowsInput: rows.filter(Boolean).length, collapsedRows: consolidated.collapsedRows, conflictCount: consolidated.conflictCount, write: write, reports: summarizeFetched_(fetched), durationMs: Date.now() - started };
      d.util.logEvent({ module: MODULE_NAME, action: 'REFRESH_CUSTOMER', status: 'COMPLETE', details: result, durationMs: result.durationMs, version: VERSION });
      return result;
    });
  }

  function refreshCustomerData(options){
    options=options||{};var gate=CF_V5133_refreshGate_('CUSTOMER','STRIVEN_CUSTOMER_DATA','CF_SERVICEOPS_TTL_CUSTOMER_MINUTES',120,options);
    if(!gate.allow)return CF_V5133_skipResult_(gate);
    return CF_V5133_refreshCustomerDataBase_(options);
  }

  function CF_V5133_refreshLocationDataBase_(options) {
    options = options || {};
    var d = deps_();
    return d.util.withScriptLock(function () {
      var started = Date.now();
      var cacheAt = d.util.nowString();
      var fetched = fetchReports_(['LOCATIONS']);
      var rows = (fetched.LOCATIONS.rows || []).map(function (source, index) { return locationRecord_(source, 'LOCATIONS', index + 2, cacheAt); }).filter(Boolean);
      var consolidated = mergeRowsByKey_(rows, function (row) { return row['Location ID']; });
      var write = d.util.replaceSheetData('STRIVEN_LOCATION_DATA', consolidated.rows);
      var result = { ok: true, version: VERSION, group: 'LOCATION', rowsPrepared: consolidated.rows.length, collapsedRows: consolidated.collapsedRows, conflictCount: consolidated.conflictCount, write: write, reports: summarizeFetched_(fetched), durationMs: Date.now() - started };
      d.util.logEvent({ module: MODULE_NAME, action: 'REFRESH_LOCATION', status: 'COMPLETE', details: result, durationMs: result.durationMs, version: VERSION });
      return result;
    });
  }

  function refreshLocationData(options){
    options=options||{};var gate=CF_V5133_refreshGate_('LOCATION','STRIVEN_LOCATION_DATA','CF_SERVICEOPS_TTL_LOCATION_MINUTES',120,options);
    if(!gate.allow)return CF_V5133_skipResult_(gate);
    return CF_V5133_refreshLocationDataBase_(options);
  }

  function enrichOperational_(rows) {
    var d = deps_();
    var taskDetails = {};
    var workOrdersByNumber = {};
    rows.forEach(function (row) {
      if (row['Entity Type'] === 'TASK' && row['Task ID']) taskDetails[String(row['Task ID'])] = row;
      if (row['Entity Type'] === 'WORK_ORDER' && row['Work Order Number']) workOrdersByNumber[String(row['Work Order Number'])] = row;
    });
    rows.forEach(function (row) {
      if (row['Entity Type'] !== 'TASK_RELATIONSHIP') return;
      var detail = taskDetails[String(row['Task ID'])] || {};
      ['Task Name','Status','Scheduled Date','Technician','Completed At','Description','Work Order Number'].forEach(function (field) { if (d.util.isBlank(row[field]) && !d.util.isBlank(detail[field])) row[field] = detail[field]; });
      var workOrder = workOrdersByNumber[String(row['Work Order Number'])] || {};
      ['Work Order ID','Location ID','Scheduled Date','Technician','Service Address'].forEach(function (field) { if (d.util.isBlank(row[field]) && !d.util.isBlank(workOrder[field])) row[field] = workOrder[field]; });
    });
    return rows;
  }

  
  /* CF_SERVICEOPS_V5_13_4_OPERATIONAL_CACHE_GRID_HYGIENE_R1_HELPER */
  function CF_V5134_trimOperationalCacheGrid_(dataRowCount){
    var d=deps_();
    var sheet=d.util.requireSheet('STRIVEN_OPERATIONAL_DATA');
    var dataRows=Math.max(0,Number(dataRowCount)||0);
    var headerRows=1;
    var bufferRows=250;
    var minimumRows=1000;
    var targetRows=Math.max(minimumRows,headerRows+dataRows+bufferRows);
    var beforeRows=sheet.getMaxRows();
    var deletedRows=0;
    if(beforeRows>targetRows){
      deletedRows=beforeRows-targetRows;
      sheet.deleteRows(targetRows+1,deletedRows);
    }
    return{ok:true,mode:'OPERATIONAL_CURRENT_SNAPSHOT_BOUNDED_ROWS',dataRows:dataRows,bufferRows:bufferRows,minimumRows:minimumRows,beforeRows:beforeRows,afterRows:sheet.getMaxRows(),deletedRows:deletedRows,columnsPreserved:sheet.getMaxColumns(),historicalAppend:false};
  }
function CF_V5133_refreshOperationalDataBase_(options) {
    options = options || {};
    var d = deps_();
    return d.util.withScriptLock(function () {
      var started = Date.now();
      var cacheAt = d.util.nowString();
      var fetched = fetchReports_(['CUSTOMER_ASSETS','SERVICE_WORK_ORDERS','SERVICE_TASKS','TASKS_CUSTOMERS_ASSETS']);
      var rows = [];
      Object.keys(fetched).forEach(function (key) {
        var entity = reportDefinitions_()[key].entity;
        (fetched[key].rows || []).forEach(function (source, index) { rows.push(operationalRecord_(source, entity, key, index + 2, cacheAt)); });
      });
      rows = enrichOperational_(rows.filter(Boolean));
      var consolidated = mergeRowsByKey_(rows, function (row) { return row['Entity Type'] + '|' + row['Entity ID']; });
      var write = d.util.replaceSheetData('STRIVEN_OPERATIONAL_DATA', consolidated.rows);
      var gridHygiene = CF_V5134_trimOperationalCacheGrid_(consolidated.rows.length);
      var result = { ok: true, version: VERSION, group: 'OPERATIONAL', rowsPrepared: consolidated.rows.length, collapsedRows: consolidated.collapsedRows, conflictCount: consolidated.conflictCount, write: write, gridHygiene: gridHygiene, reports: summarizeFetched_(fetched), reportSummary: reportSummary_(), durationMs: Date.now() - started };
      d.util.logEvent({ module: MODULE_NAME, action: 'REFRESH_OPERATIONAL', status: 'COMPLETE', details: result, durationMs: result.durationMs, version: VERSION });
      return result;
    });
  }

  function refreshOperationalData(options){
    options=options||{};var gate=CF_V5133_refreshGate_('OPERATIONAL','STRIVEN_OPERATIONAL_DATA','CF_SERVICEOPS_TTL_OPERATIONAL_MINUTES',60,options);
    if(!gate.allow)return CF_V5133_skipResult_(gate);
    return CF_V5133_refreshOperationalDataBase_(options);
  }


  function reportPropertyInventory_() {
    var definitions = reportDefinitions_();
    var mappedCandidateNames = {};

    Object.keys(definitions).forEach(function (key) {
      var propertyKey = definitions[key].property;
      var candidates = deps_().config.getPropertyCandidates(propertyKey) || [];
      candidates.forEach(function (candidate) { mappedCandidateNames[candidate] = key; });
    });

    var properties = PropertiesService.getScriptProperties().getProperties();
    var configuredReportProperties = [];
    var unmappedReportProperties = [];

    Object.keys(properties).sort().forEach(function (name) {
      if (!properties[name]) return;
      if (!/(REPORT|TASKS_CUSTOMERS_ASSETS)/i.test(name)) return;

      configuredReportProperties.push(name);
      if (!mappedCandidateNames[name]) unmappedReportProperties.push(name);
    });

    return {
      configuredReportProperties: configuredReportProperties,
      unmappedReportProperties: unmappedReportProperties
    };
  }

  function reportSummary_() {
    var reports = resolveReports_();
    var inventory = reportPropertyInventory_();
    var configured = [];
    var missing = [];

    Object.keys(reports).forEach(function (key) {
      var report = reports[key];
      var item = {
        reportKey: key,
        entity: report.definition.entity,
        required: report.definition.required === true,
        configured: report.found === true,
        propertyName: report.propertyName || ''
      };
      if (item.configured) configured.push(item);
      else missing.push(item);
    });

    return {
      configured: configured,
      missing: missing,
      configuredCount: configured.length,
      knownReportCount: Object.keys(reports).length,
      configuredReportProperties: inventory.configuredReportProperties,
      unmappedReportProperties: inventory.unmappedReportProperties
    };
  }

  function addMap_(map, key, value) {
    if (!key) return;
    if (!map[key]) map[key] = [];
    map[key].push(value);
  }

  function getLookupMaps() {
    var d = deps_();
    var customers = d.util.readRecords('STRIVEN_CUSTOMER_DATA');
    var locations = d.util.readRecords('STRIVEN_LOCATION_DATA');
    var operational = d.util.readRecords('STRIVEN_OPERATIONAL_DATA');
    var maps = {
      customers: customers.filter(function (row) { return row['Entity Type'] === 'CUSTOMER'; }),
      contacts: customers.filter(function (row) { return row['Entity Type'] === 'CONTACT'; }),
      locations: locations,
      operational: operational,
      customersByPhone: {}, customersByEmail: {}, customersByPostal: {}, customersById: {},
      contactsByPhone: {}, contactsByEmail: {}, contactsByCustomer: {},
      locationsByCustomer: {}, operationalByCustomer: {}
    };
    maps.customers.forEach(function (row) {
      maps.customersById[String(row['Customer ID'])] = row;
      addMap_(maps.customersByPhone, row['Normalized Phone'], row);
      addMap_(maps.customersByEmail, row['Normalized Email'], row);
      addMap_(maps.customersByPostal, row['Normalized Postal'], row);
    });
    maps.contacts.forEach(function (row) {
      addMap_(maps.contactsByPhone, row['Normalized Phone'], row);
      addMap_(maps.contactsByEmail, row['Normalized Email'], row);
      addMap_(maps.contactsByCustomer, String(row['Customer ID']), row);
    });
    locations.forEach(function (row) { addMap_(maps.locationsByCustomer, String(row['Customer ID']), row); });
    operational.forEach(function (row) { addMap_(maps.operationalByCustomer, String(row['Customer ID']), row); });
    return maps;
  }

  function cacheFresh_(key){
    var group=key==='STRIVEN_OPERATIONAL_DATA'?'OPERATIONAL':(key==='STRIVEN_LOCATION_DATA'?'LOCATION':'CUSTOMER');
    var prop=group==='OPERATIONAL'?'CF_SERVICEOPS_TTL_OPERATIONAL_MINUTES':(group==='LOCATION'?'CF_SERVICEOPS_TTL_LOCATION_MINUTES':'CF_SERVICEOPS_TTL_CUSTOMER_MINUTES');
    var floor=group==='OPERATIONAL'?60:120,stamp=CF_V5133_cacheStampMs_(key);return !!stamp&&(Date.now()-stamp)<=CF_V5133_floorTtl_(prop,floor)*60000;
  }

  function inspectReadiness() {
    var d = deps_();
    var reports = resolveReports_();
    var counts = {
      customers: Math.max(0, d.util.requireSheet('STRIVEN_CUSTOMER_DATA').getLastRow() - 1),
      locations: Math.max(0, d.util.requireSheet('STRIVEN_LOCATION_DATA').getLastRow() - 1),
      operational: Math.max(0, d.util.requireSheet('STRIVEN_OPERATIONAL_DATA').getLastRow() - 1)
    };
    var requiredMissing = Object.keys(reports).filter(function (key) {
      return reports[key].definition.required === true && !reports[key].found;
    });
    return {
      ok: requiredMissing.length === 0 && counts.customers > 0 && counts.locations > 0,
      version: VERSION,
      counts: counts,
      fresh: {
        customer: cacheFresh_('STRIVEN_CUSTOMER_DATA'),
        location: cacheFresh_('STRIVEN_LOCATION_DATA'),
        operational: cacheFresh_('STRIVEN_OPERATIONAL_DATA')
      },
      reports: reports,
      reportSummary: reportSummary_(),
      requiredMissing: requiredMissing
    };
  }

  /*******************************************************
   * STRIVEN_SMART_REFRESH_V1
   * FAST / STALE-ONLY CACHE REFRESH
   *
   * Normal operator behavior:
   * - Read only the Cache Updated At cell from each cache.
   * - If all groups are fresh, return immediately.
   * - Refresh only stale groups.
   *
   * This deliberately does NOT read 100k+ cache rows merely
   * to decide whether a refresh is required.
   *******************************************************/

  function cacheTimestampFast_(keyOrName) {
    var d = deps_();
    var sheet = d.util.requireSheet(keyOrName);

    if (sheet.getLastRow() < 2) {
      return '';
    }

    var headerMap =
      d.util.getHeaderMap(
        sheet
      );

    var column =
      headerMap[
        'Cache Updated At'
      ];

    if (!column) {
      return '';
    }

    return sheet
      .getRange(
        2,
        column
      )
      .getValue();
  }

  function cacheFreshFast_(
    keyOrName,
    maxAgeMinutes
  ) {
    var raw =
      cacheTimestampFast_(
        keyOrName
      );

    if (!raw) {
      return false;
    }

    var timestamp =
      raw instanceof Date
        ? raw
        : new Date(raw);

    if (
      isNaN(
        timestamp.getTime()
      )
    ) {
      return false;
    }

    return (
      Date.now() -
      timestamp.getTime()
    ) <=
      Number(
        maxAgeMinutes
      ) *
      60000;
  }

  function refreshStaleData(options){
    options=options||{};var d=deps_(),started=Date.now();
    var ttl={customer:CF_V5133_floorTtl_('CF_SERVICEOPS_TTL_CUSTOMER_MINUTES',120),location:CF_V5133_floorTtl_('CF_SERVICEOPS_TTL_LOCATION_MINUTES',120),operational:CF_V5133_floorTtl_('CF_SERVICEOPS_TTL_OPERATIONAL_MINUTES',60)};
    var timestampsBefore={customer:CF_V5133_cacheStampMs_('STRIVEN_CUSTOMER_DATA'),location:CF_V5133_cacheStampMs_('STRIVEN_LOCATION_DATA'),operational:CF_V5133_cacheStampMs_('STRIVEN_OPERATIONAL_DATA')};
    var freshBefore={customer:!!timestampsBefore.customer&&(Date.now()-timestampsBefore.customer)<=ttl.customer*60000,location:!!timestampsBefore.location&&(Date.now()-timestampsBefore.location)<=ttl.location*60000,operational:!!timestampsBefore.operational&&(Date.now()-timestampsBefore.operational)<=ttl.operational*60000};
    var results={customerData:refreshCustomerData(options),locationData:refreshLocationData(options),operationalData:refreshOperationalData(options)},refreshedGroups=[],skippedGroups=[];
    [['CUSTOMER','customerData'],['LOCATION','locationData'],['OPERATIONAL','operationalData']].forEach(function(x){var r=results[x[1]]||{},st=String(r.status||'');if(st.indexOf('BULK_REFRESH_SKIPPED_')===0)skippedGroups.push(x[0]);else refreshedGroups.push(x[0]);});
    var timestampsAfter={customer:CF_V5133_cacheStampMs_('STRIVEN_CUSTOMER_DATA'),location:CF_V5133_cacheStampMs_('STRIVEN_LOCATION_DATA'),operational:CF_V5133_cacheStampMs_('STRIVEN_OPERATIONAL_DATA')};
    var ok=results.customerData.ok!==false&&results.locationData.ok!==false&&results.operationalData.ok!==false;
    var result={ok:ok,version:VERSION,mode:'SMART_STALE_ONLY_V5133_API_BRAKE',maxAgeMinutes:Math.max(ttl.customer,ttl.location,ttl.operational),ttlMinutes:ttl,allCachesAlreadyFresh:refreshedGroups.length===0,refreshedGroups:refreshedGroups,skippedGroups:skippedGroups,freshBefore:freshBefore,timestampsBefore:timestampsBefore,timestampsAfter:timestampsAfter,customerData:results.customerData,locationData:results.locationData,operationalData:results.operationalData,durationMs:Date.now()-started};
    try{d.util.logEvent({module:'30_Striven_Data',action:'REFRESH_SMART',status:ok?'COMPLETE':'ERROR',details:{mode:result.mode,ttlMinutes:ttl,refreshedGroups:refreshedGroups,skippedGroups:skippedGroups,apiBrake:true},durationMs:result.durationMs,version:VERSION});}catch(e){}
    return result;
  }

  function refreshAllData(options) {
    options = options || {};
    var started = Date.now();
    var customer = refreshCustomerData(options);
    var location = refreshLocationData(options);
    var operational = refreshOperationalData(options);
    var summary = reportSummary_();

    return {
      ok: customer.ok !== false && location.ok !== false && operational.ok !== false,
      version: VERSION,
      group: 'ALL_STRIVEN_REPORTS',
      customerData: customer,
      locationData: location,
      operationalData: operational,
      reportSummary: summary,
      durationMs: Date.now() - started
    };
  }

  return {
    version: VERSION,
    refreshAllData: refreshAllData,
    refreshStaleData: refreshStaleData,
    refreshCustomerData: refreshCustomerData,
    refreshLocationData: refreshLocationData,
    refreshOperationalData: refreshOperationalData,
    getLookupMaps: getLookupMaps,
    inspectReadiness: inspectReadiness,
    inspectConfiguredReports: reportSummary_
  };
})();


