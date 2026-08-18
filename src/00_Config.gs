/************************************************************
 * APPS SCRIPT — 00_Config.gs
 * CF ServiceOps — Lean Production Contract
 * Version: 5.8.0
 *
 * ACTIVE WORKBOOK: 8 NUMBERED SHEETS
 * Visible operator sheets:
 *   00 Dashboard → 03 Operator Queue
 * Hidden technical support:
 *   01 Webform Requests → 02 Service Requests → 04 Striven Customer Data →
 *   05 Striven Location Data → 06 Striven Operational Data → 07 System Log
 ************************************************************/
var CF = CF || {};

CF.Config = (function () {
  'use strict';

  var APP = {
    NAME: 'CF ServiceOps',
    VERSION: '5.8.0',
    SCHEMA_VERSION: '2026-08-OPERATOR-UX-V6',
    TIMEZONE: 'America/Toronto',
    ENVIRONMENT: 'DEV'
  };

  var SHEETS = {
    DASHBOARD: '00 Dashboard',
    WEBFORM_REQUESTS: '01 Webform Requests',
    SERVICE_REQUESTS: '02 Service Requests',
    OPERATOR_QUEUE: '03 Operator Queue',
    STRIVEN_CUSTOMER_DATA: '04 Striven Customer Data',
    STRIVEN_LOCATION_DATA: '05 Striven Location Data',
    STRIVEN_OPERATIONAL_DATA: '06 Striven Operational Data',
    SYSTEM_LOG: '07 System Log'
  };

  var SHEET_ALIASES = {
    DASHBOARD: ['Dashboard'],
    WEBFORM_REQUESTS: ['Webform Requests'],
    SERVICE_REQUESTS: ['Service Requests'],
    OPERATOR_QUEUE: ['Operator Queue'],
    STRIVEN_CUSTOMER_DATA: ['Striven Customer Data'],
    STRIVEN_LOCATION_DATA: ['Striven Location Data'],
    STRIVEN_OPERATIONAL_DATA: ['Striven Operational Data'],
    SYSTEM_LOG: ['System Log']
  };

  var ACTIVE_SHEET_KEYS = [
    'DASHBOARD','WEBFORM_REQUESTS','SERVICE_REQUESTS','OPERATOR_QUEUE',
    'STRIVEN_CUSTOMER_DATA','STRIVEN_LOCATION_DATA','STRIVEN_OPERATIONAL_DATA','SYSTEM_LOG'
  ];

  var VISIBLE_SHEET_KEYS = ['DASHBOARD','OPERATOR_QUEUE'];
  var TECHNICAL_SHEET_KEYS = ['WEBFORM_REQUESTS','SERVICE_REQUESTS','STRIVEN_CUSTOMER_DATA','STRIVEN_LOCATION_DATA','STRIVEN_OPERATIONAL_DATA','SYSTEM_LOG'];

  var OBSOLETE_SHEET_NAMES = [
    'Service Customer Index','Service Contact Index','Service Location Index','Customer Profile','Customer 360','Import Queue','Service Events','Service Audit Checks','Striven Data Status','Service Config','Campaign Master','Striven_Customers','Striven_Contacts','Striven_CustomerLocations','Customer Assets','Sales Orders - Report','Service Work Orders - Report','Service Tasks','Tasks Customers Assets'
  ];

  var DEFAULTS = {
    DEFAULT_PROVINCE: 'ON', DEFAULT_COUNTRY: 'Canada', DEFAULT_CAMPAIGN_CODE: 'campaign1',
    INITIAL_STAGE: 'NEW INTAKE', INITIAL_REQUEST_STATUS: 'NEW', INITIAL_MATCH_STATUS: 'NOT CHECKED',
    INITIAL_SYNC_STATUS: 'NOT SYNCED', INITIAL_MANUAL_REVIEW: 'NO', STRIVEN_PAGE_SIZE: 2000,
    STRIVEN_MAX_PAGES: 200, STRIVEN_CACHE_MAX_AGE_MINUTES: 240, STRIVEN_TOKEN_REFRESH_BUFFER_SECONDS: 60,
    STRIVEN_MAX_READ_RETRIES: 3, MAX_RUNTIME_MS: 260000, MAX_LOG_TEXT: 45000, TEST_MODE: true,
    WRITE_MODE: false, REQUIRE_OPERATOR_APPROVAL: true, REQUIRE_FRESH_MATCHING_DATA: true, WORK_ORDER_CREATE_SUPPORTED: false
  };

  var PROPERTY_DEFINITIONS = {
    TEST_MODE:{candidates:['TEST_MODE'],defaultValue:'true'},
    WRITE_MODE:{candidates:['WRITE_MODE','SERVICEOPS_WRITE_MODE'],defaultValue:'false'},
    SPREADSHEET_ID:{candidates:['SPREADSHEET_ID']},
    WEBFORM_SHARED_SECRET:{candidates:['WEBFORM_SHARED_SECRET','SERVICEOPS_WEBHOOK_SECRET','SERVICE_WEBHOOK_SECRET']},
    STRIVEN_BASE_URL:{candidates:['STRIVEN_BASE_URL'],defaultValue:'https://api.striven.com'},
    STRIVEN_CLIENT_ID:{candidates:['STRIVEN_CLIENT_ID','CLIENT_ID']},
    STRIVEN_CLIENT_SECRET:{candidates:['STRIVEN_CLIENT_SECRET','CLIENT_SECRET']},
    STRIVEN_ACCESS_TOKEN:{candidates:['STRIVEN_ACCESS_TOKEN','STRIVEN_TOKEN','access_token','striven_token']},
    STRIVEN_TOKEN_EXPIRES_AT:{candidates:['STRIVEN_TOKEN_EXPIRES_AT','STRIVEN_ACCESS_TOKEN_EXPIRES_AT','STRIVEN_TOKEN_EXPIRY','expires_at']},
    STRIVEN_CUSTOMER_REPORT:{candidates:['STRIVEN_CUSTOMER_REPORT','STRIVEN_CUSTOMER_REPORT_URL','SERVICE_REPORT_CUSTOMERS_URL']},
    STRIVEN_CONTACT_REPORT:{candidates:['STRIVEN_CONTACT_REPORT','STRIVEN_CONTACT_REPORT_URL','REPORT_CONTACTS_KEY','REPORT_EMAILS_KEY','SERVICE_REPORT_CONTACTS_URL','SERVICE_REPORT_EMAILS_URL']},
    STRIVEN_CUSTOMER_LOCATION_REPORT:{candidates:['STRIVEN_CUSTOMER_LOCATION_REPORT','REPORT_LOCATIONS_KEY','SERVICE_REPORT_LOCATIONS_URL']},
    STRIVEN_CUSTOMER_ASSETS_REPORT:{candidates:['STRIVEN_CUSTOMER_ASSETS_REPORT','SERVICEOPS_CUSTOMER_ASSETS_REPORT','SERVICEOPS_CUSTOMER_ASSETS_REPORT_URL','SERVICE_REPORT_ASSETS_URL']},
    STRIVEN_WORK_ORDER_REPORT:{candidates:['STRIVEN_WORK_ORDER_REPORT','STRIVEN_SERVICE_WORK_ORDER_REPORT','SERVICE_REPORT_WORK_ORDERS_URL','STRIVEN_SALES_ORDER_REPORT','STRIVEN_SALES_ORDER_REPORT_URL','SERVICE_REPORT_SALES_ORDERS_URL']},
    STRIVEN_TASK_REPORT:{candidates:['STRIVEN_TASK_REPORT','STRIVEN_SERVICE_TASK_REPORT','SERVICE_TASKS_REPORT_URL','SERVICE_REPORT_TASKS_URL']},
    STRIVEN_TASK_RELATIONSHIP_REPORT:{candidates:['STRIVEN_TASKS_CUSTOMERS_ASSETS_REPORT','TASKS_CUSTOMERS_ASSETS_URL','Tasks_Customers_Assets_URL','SERVICE_REPORT_TASKS_CUSTOMERS_ASSETS_URL']},
    STRIVEN_WEB_APP_BASE_URL:{candidates:['STRIVEN_WEB_APP_BASE_URL','STRIVEN_TENANT_WEB_URL','STRIVEN_APP_BASE_URL']}
  };

  var ENDPOINTS = { ACCESS_TOKEN:'/accesstoken', CUSTOMERS:'/v1/customers', CONTACTS:'/v1/contacts', ASSOCIATE_CONTACT_TO_CUSTOMER:'/v1/contacts/{contactId}/associate-customer', CUSTOMER_LOCATION_CREATE:'/v1/customers/{customerId}/location' };

  var DROPDOWNS = {
    CURRENT_STAGE:['NEW INTAKE','CUSTOMER RESOLVED','READY FOR CUSTOMER CREATE','READY FOR CONTACT CREATE','READY FOR LOCATION CREATE','NEEDS REVIEW','APPROVED FOR CUSTOMER STRUCTURE','CREATING CUSTOMER STRUCTURE','CUSTOMER STRUCTURE COMPLETE','DUPLICATE','BLOCKED','ERROR','CANCELLED','COMPLETED'],
    REQUEST_STATUS:['NEW','OPEN','IN PROGRESS','BLOCKED','COMPLETED','CANCELLED','DUPLICATE','ERROR'],
    MATCH_STATUS:['NOT CHECKED','MATCHED','POSSIBLE MATCH','AMBIGUOUS','NOT FOUND','MISSING INFORMATION','ERROR'],
    MATCH_CONFIDENCE:['HIGH','MEDIUM','LOW','NONE'], MANUAL_REVIEW:['YES','NO'], DUPLICATE_RISK:['NONE','LOW','MEDIUM','HIGH'],
    OPERATOR_ACTION:['','APPROVE PROPOSED ACTION','LINK EXISTING CUSTOMER','LINK EXISTING CONTACT','LINK EXISTING LOCATION','CREATE CUSTOMER','CREATE CONTACT','CREATE LOCATION','REQUEST INFORMATION','MARK DUPLICATE','CANCEL'],
    ENTITY_ACTION:['NONE','LINK EXISTING','CREATE','REVIEW','REQUEST INFORMATION','BLOCKED'],
    SYNC_STATUS:['NOT SYNCED','READY','SYNCING','SYNCED','PARTIAL','UNCERTAIN — RECONCILE','BLOCKED','ERROR']
  };

  var HEADERS = {};
  HEADERS[SHEETS.OPERATOR_QUEUE] = ['Request ID','Status','Customer','Service','Striven','History','Next Step','Operator Action','Run','Operator Notes'];
  HEADERS[SHEETS.WEBFORM_REQUESTS] = ['Received At','Updated At','Submission ID','Request ID','Source Row ID','Correlation ID','Source System','Form ID','Form Title','Full Name','Phone','Email','Full Address','Campaign Code','Attribution JSON','Raw Payload','Payload Hash','Processing Status','Processing Error','Processed At'];
  HEADERS[SHEETS.SERVICE_REQUESTS] = ['Request ID','Created At','Updated At','Schema Version','Correlation ID','Source System','Source Row ID','Submission ID','Payload Hash','Submitted At','Campaign Code','Attribution JSON','First Name','Last Name','Full Name','Phone','Phone Extension','Alt Phone','Normalized Phone','Normalized Alt Phone','Email','Normalized Email','Street','City','Province','Postal Code','Normalized Postal','Country','Full Address','Normalized Address','Preferred Days','Unit Details','Service Details','Additional Notes','Current Stage','Request Status','Manual Review?','Manual Review Reason','Blocking Issue','Duplicate Risk Status','Duplicate Risk Reason','Next Action','Operator Action','Operator Notes','Approved By','Approved At','Customer Match Status','Matched Customer ID','Matched Customer Name','Contact Match Status','Matched Contact ID','Matched Contact Name','Location Match Status','Matched Location ID','Matched Location Address','Match Confidence','Match Score','Match Method','Match Evidence JSON','History Enrichment Status','Purchased From Us?','Customer Asset Count','Customer Assets Summary','Last Service Date','Last Service Technician','Last Service Summary','Active Work Summary','Active Work JSON','Customer Action','Contact Action','Location Action','Work Order Action','Customer Structure Status','Created Customer ID','Created Contact ID','Contact Association Status','Created Location ID','Work Order Status','Work Order ID','Work Order Number','Work Order Link','Transaction Plan JSON','Transaction Fingerprint','Approval Fingerprint','Write Fingerprint','Write Journal JSON','Striven Sync Status','Striven Sync Error','Last Striven Sync','Reconciliation Status','Final Outcome','Completed At'];
  HEADERS[SHEETS.STRIVEN_CUSTOMER_DATA] = ['Cache Updated At','Entity Type','Entity ID','Customer ID','Contact ID','Customer Name','First Name','Last Name','Full Name','Phone','Normalized Phone','Phone Extension','Email','Normalized Email','Status','Full Address','Normalized Address','City','Postal Code','Normalized Postal','Source Report','Source Row','Mapping Warnings'];
  HEADERS[SHEETS.STRIVEN_LOCATION_DATA] = ['Cache Updated At','Location ID','Customer ID','Location Name','Full Address','Normalized Address','City','Province','Postal Code','Normalized Postal','Country','Status','Created At','Source Report','Source Row','Mapping Warnings'];
  HEADERS[SHEETS.STRIVEN_OPERATIONAL_DATA] = ['Cache Updated At','Entity Type','Entity ID','Customer ID','Location ID','Asset ID','Asset Name','Asset Make','Asset Model','Serial Number','Install Date','Work Order ID','Work Order Number','Work Order Name','Task ID','Task Name','Parent Entity ID','Status','Scheduled Date','Technician','Created At','Completed At','Service Address','Description','Source Report','Source Row','Mapping Warnings'];
  HEADERS[SHEETS.SYSTEM_LOG] = ['Timestamp','Severity','Module','Action','Status','Request ID','Correlation ID','Message','Details JSON','Sheet','Row','Actor','Duration Ms','Version'];

  var REPORT_ALIASES = {
    CUSTOMER:{CUSTOMER_ID:['CustomerCustomerId','CustomerId','Customer ID','CustomerID','Customer Number','CustomerNumber','Id','ID'],CUSTOMER_NAME:['CustomerName','Customer Name','CustomerFullName','Customer Full Name','FullName','Full Name','Name'],PHONE:['CustomerPrimaryPhone','Customer Primary Phone','Customer Phone','CustomerPhone','Phone'],EMAIL:['CustomerPrimaryEmail','Customer Primary Email','Customer Email','CustomerEmail'],FULL_ADDRESS:['CustomerAddressFullAddress','AddressFullAddress','Full Address','FullAddress'],CITY:['CustomerAddressCity','AddressCity','City'],POSTAL:['CustomerAddressZip','AddressZip','Postal Code','PostalCode','Zip'],STATUS:['Customer Status','Status','IsActive']},
    CONTACT:{CONTACT_ID:['ContactId','Contact ID','ContactID','PrimaryContactId'],CUSTOMER_ID:['CustomerCustomerId','CustomerId','Customer ID','CustomerNumber'],FIRST_NAME:['Contact First Name','First Name','FirstName'],LAST_NAME:['Contact Last Name','Last Name','LastName'],FULL_NAME:['ContactFullName','Contact Name','FullName','Full Name','Name'],PHONE:['ContactPrimaryPhone','Contact Phone','PrimaryPhone','Primary Phone','Phone'],EMAIL:['ContactPrimaryEmail','Contact Email','PrimaryEmail','Primary Email','Email'],STATUS:['Contact Status','Status','IsActive']},
    LOCATION:{LOCATION_ID:['LocationId','Location ID','Customer Location ID','Id'],CUSTOMER_ID:['CustomerId','Customer ID','CustomerNumber','Customer Number'],NAME:['LocationName','Location Name','Name'],FULL_ADDRESS:['AddressFullAddress','Full Address','FullAddress'],CITY:['AddressCity','City'],PROVINCE:['AddressProvince','AddressState','Province','State'],POSTAL:['AddressZip','AddressPostalCode','Postal Code','PostalCode','Zip'],COUNTRY:['AddressCountry','Country'],STATUS:['Location Status','Status','IsActive'],CREATED_AT:['CreatedOn','Created At','Created Date']},
    ASSET:{ID:['AssetId','Asset ID','CustomerAssetId','Id'],CUSTOMER_ID:['CustomerId','Customer ID','CustomerNumber'],LOCATION_ID:['LocationId','Location ID'],NAME:['AssetName','Asset Name'],MAKE:['ManufacturerName','Manufacturer','Make'],MODEL:['ModelNumber','Model Number','Model'],SERIAL:['SerialNumber','Serial Number'],INSTALL_DATE:['DatePurchased','Install Date','Installation Date'],STATUS:['Asset Status','Status']},
    WORK_ORDER:{ID:['SOId','Work Order ID','WorkOrderId','ServiceWorkOrderId','Id'],NUMBER:['SONumber','SO Number','Work Order Number','WorkOrderNumber','Number'],CUSTOMER_ID:['CustomerNumber','CustomerId','Customer ID'],LOCATION_ID:['ShipToAddressId','LocationId','Location ID','BillToAddressId'],NAME:['SOName','Work Order Name','Name'],STATUS:['SOStatus','Work Order Status','Status'],SCHEDULED_DATE:['ServiceWorkOrderScheduledDate','Scheduled Date','Start Date'],TECHNICIAN:['ServiceWorkOrderServiceTech','AssignedTo','Technician'],CREATED_AT:['CreatedOn','Created At'],ADDRESS:['ShipToFullAddress','Service Address','Full Address']},
    TASK:{ID:['TaskId','Task ID','Id'],WORK_ORDER_NUMBER:['SONumber','SO Number','Work Order Number'],CUSTOMER_ID:['CustomerId','Customer ID'],LOCATION_ID:['LocationId','Location ID'],NAME:['TaskName','Task Name'],STATUS:['Status','Task Status'],SCHEDULED_DATE:['TaskStartDate','StartDate','SOScheduledDate','Scheduled Date'],TECHNICIAN:['AssignedTo','Technician'],COMPLETED_AT:['CompletedAt','Completed At'],DESCRIPTION:['TaskName','Description']},
    TASK_RELATIONSHIP:{TASK_ID:['TaskId','Task ID'],CUSTOMER_ID:['CustomerId','Customer ID'],ASSET_ID:['AssetIDs','AssetId','Asset ID'],NAME:['TaskName','Task Name']}
  };

  var CAMPAIGNS = { EB2026:{code:'EB2026',name:'Early Bird Fireplace Service 2026',year:'2026',trafficChannel:'SHOPIFY_LANDING_PAGE'}, CAMPAIGN1:{code:'campaign1',name:'Legacy Placeholder Campaign 1',year:'2026',trafficChannel:'LEGACY'}, CAMPAIGN2:{code:'campaign2',name:'Legacy Placeholder Campaign 2',year:'2026',trafficChannel:'LEGACY'}, CAMPAIGN3:{code:'campaign3',name:'Legacy Placeholder Campaign 3',year:'2026',trafficChannel:'LEGACY'} };

  function clone_(value){return JSON.parse(JSON.stringify(value));}
  function clean_(value){return value===null||value===undefined?'':String(value).trim();}
  function replaceParams_(path,params){var output=path;Object.keys(params||{}).forEach(function(key){output=output.replace(new RegExp('\\{'+key+'\\}','g'),encodeURIComponent(String(params[key])));});if(/\{[^}]+\}/.test(output))throw new Error('Missing endpoint parameter: '+output);return output;}

  return {
    getApp:function(){return clone_(APP);}, getVersion:function(){return APP.VERSION;}, getSchemaVersion:function(){return APP.SCHEMA_VERSION;}, getTimezone:function(){return APP.TIMEZONE;}, getSheets:function(){return clone_(SHEETS);},
    getSheetName:function(key){if(!SHEETS[key])throw new Error('Unknown sheet key: '+key);return SHEETS[key];},
    resolveSheetName:function(keyOrName){return SHEETS[keyOrName]||keyOrName;},
    getSheetCandidates:function(keyOrName){if(!SHEETS[keyOrName])return[keyOrName];return[SHEETS[keyOrName]].concat(SHEET_ALIASES[keyOrName]||[]).filter(function(name,index,list){return list.indexOf(name)===index;});},
    getActiveSheetNames:function(){return ACTIVE_SHEET_KEYS.map(function(key){return SHEETS[key];});}, getVisibleSheetNames:function(){return VISIBLE_SHEET_KEYS.map(function(key){return SHEETS[key];});}, getTechnicalSheetNames:function(){return TECHNICAL_SHEET_KEYS.map(function(key){return SHEETS[key];});}, getObsoleteSheetNames:function(){return clone_(OBSOLETE_SHEET_NAMES);},
    getHeaders:function(keyOrName){var name=SHEETS[keyOrName]||keyOrName;return clone_(HEADERS[name]||[]);},
    getHeaderMap:function(keyOrName){var map={};this.getHeaders(keyOrName).forEach(function(header,index){map[header]=index+1;});return map;},
    getDefaults:function(){return clone_(DEFAULTS);}, getDefault:function(key){if(DEFAULTS[key]===undefined)throw new Error('Unknown default: '+key);return DEFAULTS[key];}, getDropdown:function(key){return clone_(DROPDOWNS[key]||[]);},
    getPropertyDefinition:function(key){if(!PROPERTY_DEFINITIONS[key])throw new Error('Unknown property: '+key);return clone_(PROPERTY_DEFINITIONS[key]);}, getPropertyCandidates:function(key){return this.getPropertyDefinition(key).candidates||[];},
    getEndpoint:function(key,params){if(!ENDPOINTS[key])throw new Error('Unknown endpoint: '+key);return replaceParams_(ENDPOINTS[key],params||{});}, getReportAliases:function(entity){return clone_(REPORT_ALIASES[entity]||{});}, getCampaign:function(code){var key=clean_(code).toUpperCase();return clone_(CAMPAIGNS[key]||CAMPAIGNS.CAMPAIGN1);},
    isWriteAllowed:function(){return false;}, isTerminalState:function(value){var clean=clean_(value).toUpperCase();return /^(COMPLETED|CANCELLED|DUPLICATE)/.test(clean)||clean==='BLOCKED_PERMANENT'||clean==='FAILED_REQUIRES_ADMIN';}
  };
})();
