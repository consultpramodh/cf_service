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
 * CF ServiceOps — Customer Structure Engine
 * Version: 5.14.1
 *
 * Internal request-scoped helper only. It owns no triggers.
 ************************************************************/
var CF = CF || {};

CF.CustomerStructureEngine = (function () {
  'use strict';
  var VERSION='5.14.1';
  function deps_(){if(!CF.Config||!CF.Util||!CF.Matching||!CF.StrivenControlledCustomerCreate||!CF.StrivenControlledContactCreate)throw new Error('CUSTOMER_STRUCTURE_SETUP_REQUIRED');return{config:CF.Config,util:CF.Util,matching:CF.Matching,customer:CF.StrivenControlledCustomerCreate,contact:CF.StrivenControlledContactCreate};}
  function clean_(v){return deps_().util.cleanText(v);}
  function upper_(v){return clean_(v).toUpperCase();}
  function request_(id){return deps_().util.findRecord('SERVICE_REQUESTS','Request ID',clean_(id));}
  function active_(r){return !!r&&!deps_().config.isTerminalState(r['Current Stage'])&&!deps_().config.isTerminalState(r['Final Outcome']);}
  function safe_(r){if(!active_(r))return false;if(upper_(r['Manual Review?'])==='YES')return false;var risk=upper_(r['Duplicate Risk Status']);if(risk&&risk!=='NONE')return false;if(['BLOCKED','DUPLICATE','CANCELLED','CANCELED','ERROR'].indexOf(upper_(r['Request Status']))!==-1)return false;return true;}
  function ids_(r){return{customer:clean_(r['Matched Customer ID']||r['Created Customer ID']),contact:clean_(r['Matched Contact ID']||r['Created Contact ID']),location:clean_(r['Matched Location ID']||r['Created Location ID'])};}
  function patch_(r,p){if(typeof deps_().util.clearRowDataValidations==='function')deps_().util.clearRowDataValidations('SERVICE_REQUESTS',r.__rowNumber);deps_().util.patchRow('SERVICE_REQUESTS',r.__rowNumber,p);SpreadsheetApp.flush();}
  function finalize_(r,reason){var ids=ids_(r);if(!ids.customer||!ids.contact||!ids.location)return{ok:false,version:VERSION,status:'CUSTOMER_STRUCTURE_IDS_INCOMPLETE',requestId:clean_(r['Request ID']),ids:ids,liveWriteExecuted:false};patch_(r,{'Updated At':deps_().util.nowString(),'Current Stage':'CUSTOMER STRUCTURE COMPLETE','Request Status':'OPEN','Manual Review?':'NO','Manual Review Reason':'','Blocking Issue':'','Next Action':'CONTINUE TO WORK ORDER','Customer Structure Status':'COMPLETE','Contact Association Status':clean_(r['Contact Association Status'])||'ASSOCIATED','Striven Sync Status':'PARTIAL','Striven Sync Error':'','Reconciliation Status':reason||'CUSTOMER STRUCTURE COMPLETE'});return{ok:true,version:VERSION,status:'CUSTOMER_STRUCTURE_COMPLETE',requestId:clean_(r['Request ID']),customerId:ids.customer,contactId:ids.contact,locationId:ids.location,liveWriteExecuted:false};}
  function verifyResultRequest_(requestId,result){if(!result||typeof result!=='object')return result;var nested=[result.requestId,result.stepResult&&result.stepResult.requestId,result.result&&result.result.requestId,result.matching&&result.matching.requestId].map(clean_).filter(Boolean);var bad=nested.filter(function(id){return id!==clean_(requestId);});if(bad.length)return{ok:false,version:VERSION,status:'CROSS_REQUEST_RESULT_REJECTED',requestId:clean_(requestId),returnedRequestIds:nested,rejectedRequestIds:bad,liveWriteExecuted:!!result.liveWriteExecuted,originalResult:result};return result;}
  function step(requestId){requestId=clean_(requestId);if(!requestId)return{ok:false,version:VERSION,status:'REQUEST_ID_REQUIRED',liveWriteExecuted:false};var r=request_(requestId);if(!r)return{ok:false,version:VERSION,status:'REQUEST_NOT_FOUND',requestId:requestId,liveWriteExecuted:false};if(!active_(r))return{ok:true,version:VERSION,status:'REQUEST_NOT_ACTIVE',requestId:requestId,liveWriteExecuted:false};var stage=upper_(r['Current Stage']);
    if(stage==='NEW INTAKE'){var matching=deps_().matching.recheckRequest(requestId,{persist:true});return verifyResultRequest_(requestId,{ok:!matching||matching.ok!==false,version:VERSION,status:'MATCHING_PROCESSED',requestId:requestId,matching:matching,liveWriteExecuted:false});}
    if((stage==='CUSTOMER STRUCTURE COMPLETE'||upper_(r['Customer Structure Status'])==='COMPLETE')){var existingIds=ids_(r);if(existingIds.customer&&existingIds.contact&&existingIds.location)return{ok:true,version:VERSION,status:'CUSTOMER_STRUCTURE_ALREADY_COMPLETE',requestId:requestId,ids:existingIds,liveWriteExecuted:false};}
    if(!safe_(r))return{ok:true,version:VERSION,status:'CUSTOMER_STRUCTURE_REVIEW_REQUIRED',requestId:requestId,stage:clean_(r['Current Stage']),liveWriteExecuted:false};
    var ids=ids_(r),association=upper_(r['Contact Association Status']),result;
    if(stage==='READY FOR CUSTOMER CREATE'){result=deps_().customer.executeAutoCustomerCreate(requestId);return verifyResultRequest_(requestId,result);}
    if(stage==='READY FOR LOCATION CREATE'){if(!CF.StandaloneLocationCreateV5128||typeof CF.StandaloneLocationCreateV5128.process!=='function')return{ok:false,version:VERSION,status:'STANDALONE_LOCATION_MODULE_MISSING',requestId:requestId,liveWriteExecuted:false};result=CF.StandaloneLocationCreateV5128.process(requestId,{autoMode:true});return verifyResultRequest_(requestId,result);}
    if(stage==='READY FOR CONTACT CREATE'){
      if(!ids.location){
        if(ids.customer&&clean_(r['Created Customer ID'])){
          result=deps_().customer.executeAutoCustomerCreate(requestId);
          var locationResult=verifyResultRequest_(requestId,result);
          var refreshedAfterCustomer=request_(requestId)||r;
          var repairedIds=ids_(refreshedAfterCustomer);
          if(!repairedIds.location){
            patch_(refreshedAfterCustomer,{
              'Current Stage':'CREATING CUSTOMER STRUCTURE',
              'Request Status':'IN PROGRESS',
              'Manual Review?':'NO',
              'Manual Review Reason':'',
              'Blocking Issue':'Primary Location is not yet durably resolved. Contact creation is blocked until a Location ID is confirmed.',
              'Next Action':'RECONCILE PRIMARY LOCATION — DO NOT CREATE CONTACT YET',
              'Customer Structure Status':'CUSTOMER CONFIRMED — PRIMARY LOCATION PENDING',
              'Striven Sync Status':'PARTIAL',
              'Striven Sync Error':'',
              'Reconciliation Status':'LOCATION ID REQUIRED BEFORE CONTACT'
            });
            return{ok:true,version:VERSION,status:'LOCATION_ID_REPAIR_PENDING',requestId:requestId,matchedCustomerId:ids.customer,liveWriteExecuted:!!(locationResult&&locationResult.liveWriteExecuted===true)};
          }
          return locationResult;
        }
        if(ids.customer&&upper_(r['Location Action'])==='CREATE'&&CF.StandaloneLocationCreateV5128&&typeof CF.StandaloneLocationCreateV5128.process==='function'){
          patch_(r,{
            'Current Stage':'READY FOR LOCATION CREATE',
            'Request Status':'OPEN',
            'Manual Review?':'NO',
            'Manual Review Reason':'',
            'Blocking Issue':'',
            'Next Action':'CREATE OR RECONCILE LOCATION BEFORE CONTACT',
            'Customer Structure Status':'IN PROGRESS',
            'Reconciliation Status':'LOCATION STAGE RESTORED BEFORE CONTACT'
          });
          result=CF.StandaloneLocationCreateV5128.process(requestId,{autoMode:true});
          return verifyResultRequest_(requestId,result);
        }
        return{ok:false,version:VERSION,status:'LOCATION_ID_REQUIRED_BEFORE_CONTACT',requestId:requestId,customerId:ids.customer,liveWriteExecuted:false};
      }
      result=deps_().contact.executeAutoContactCreate(requestId);
      return verifyResultRequest_(requestId,result);
    }
    if(stage==='CUSTOMER RESOLVED'||stage==='CREATING CUSTOMER STRUCTURE'){
      if(!ids.customer){result=deps_().customer.executeAutoCustomerCreate(requestId);return verifyResultRequest_(requestId,result);}
      if(!ids.location){if(clean_(r['Created Customer ID']))result=deps_().customer.executeAutoCustomerCreate(requestId);else{if(!CF.StandaloneLocationCreateV5128||typeof CF.StandaloneLocationCreateV5128.process!=='function')return{ok:false,version:VERSION,status:'STANDALONE_LOCATION_MODULE_MISSING',requestId:requestId,liveWriteExecuted:false};result=CF.StandaloneLocationCreateV5128.process(requestId,{autoMode:true});}return verifyResultRequest_(requestId,result);}
      if(!ids.contact||association!=='ASSOCIATED'){result=deps_().contact.executeAutoContactCreate(requestId);return verifyResultRequest_(requestId,result);}
      return finalize_(r,'REQUEST-SCOPED CUSTOMER STRUCTURE RECONCILED');
    }
    ids=ids_(r);if(ids.customer&&ids.contact&&ids.location)return finalize_(r,'CUSTOMER STRUCTURE IDS CONFIRMED');
    return{ok:true,version:VERSION,status:'CUSTOMER_STRUCTURE_NO_ACTION_FOR_STAGE',requestId:requestId,stage:clean_(r['Current Stage']),ids:ids,liveWriteExecuted:false};
  }
  return{version:VERSION,step:step};
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


/* CF_SERVICEOPS_V5_14_1_SINGLE_AUTOMATION_MODEL_R1 */
CF.EventDrivenServiceAutomation = (function () {
  'use strict';
  var VERSION='5.14.1';
  var FINAL_HANDLER='AUTO_FINAL_ServiceOps';
  var WATCHDOG_HANDLER='AUTO_98_E2E_Recovery_Watchdog';
  var ENABLED='CF_EVENT_DRIVEN_SERVICE_AUTOMATION_ENABLED';
  var AUTO_SO='CF_EVENT_DRIVEN_AUTO_SALES_ORDER';
  var PREPARATION_ONLY='CF_SERVICEOPS_AUTOMATION_PREPARATION_ONLY';
  var QUEUE='CF_EVENT_DRIVEN_SERVICE_REQUEST_IDS';
  var NEXT_AT='CF_EVENT_DRIVEN_SERVICE_NEXT_TRIGGER_AT';
  var LAST_KICK='CF_EVENT_DRIVEN_SERVICE_LAST_KICK';
  var LAST_REQUEST='CF_EVENT_DRIVEN_SERVICE_LAST_REQUEST_ID';
  var RECOVERY_LOOKBACK_MS=7*24*60*60*1000;
  var WORKER_DELAY_MS=10000;
  var WORKER_BUDGET_MS=220000;
  var MAX_STEPS=12;
  function clean_(v){return v===null||v===undefined?'':String(v).trim();}
  function upper_(v){return clean_(v).toUpperCase();}
  function props_(){return PropertiesService.getScriptProperties();}
  function request_(id){return CF.Util.findRecord('SERVICE_REQUESTS','Request ID',clean_(id));}
  function now_(){return CF.Util&&typeof CF.Util.nowString==='function'?CF.Util.nowString():new Date();}
  function log_(action,status,requestId,details,message,durationMs){try{CF.Util.logEvent({module:'70_Workflow_Automation',action:action,status:status,requestId:clean_(requestId),details:details||{},message:message||'',durationMs:durationMs||'',version:VERSION});}catch(e){}}
  function parse_(v){try{return CF.Util&&typeof CF.Util.parseJson==='function'?CF.Util.parseJson(v,{}):JSON.parse(String(v||'{}'));}catch(e){return{};}}
  function dateMs_(v){if(v instanceof Date&&!isNaN(v.getTime()))return v.getTime();var d=new Date(v);return isNaN(d.getTime())?0:d.getTime();}
  function terminal_(r){if(!r)return true;if(CF.Config&&typeof CF.Config.isTerminalState==='function')return CF.Config.isTerminalState(r['Current Stage'])||CF.Config.isTerminalState(r['Final Outcome']);return /COMPLETED|CANCELLED|CANCELED/.test(upper_(r['Current Stage']||r['Final Outcome']));}
  function knownOrderId_(r){if(!r)return'';var id=clean_(r['Work Order ID']);if(id)return id;var root=parse_(r['Write Journal JSON']),o=root&&root.salesOrderCreate||{};return clean_(o.canonicalSalesOrderId||o.responseIdentifier);}
  function queue_(){var raw=props_().getProperty(QUEUE);if(!raw)return[];try{var q=JSON.parse(raw),seen={};return Array.isArray(q)?q.map(clean_).filter(function(id){if(!id||seen[id])return false;seen[id]=true;return true;}):[];}catch(e){return[];}}
  function writeQueue_(rows){var seen={},out=[];(rows||[]).forEach(function(id){id=clean_(id);if(id&&!seen[id]){seen[id]=true;out.push(id);}});props_().setProperty(QUEUE,JSON.stringify(out));return out;}
  function mutateQueue_(fn){var lock=LockService.getScriptLock();lock.waitLock(30000);try{return writeQueue_(fn(queue_().slice())||[]);}finally{lock.releaseLock();}}
  function enqueue_(id){id=clean_(id);if(!id)return queue_();return mutateQueue_(function(q){q.push(id);return q;});}
  function prioritize_(id){id=clean_(id);if(!id)return queue_();return mutateQueue_(function(q){return [id].concat(q.filter(function(x){return x!==id;}));});}
  function dequeue_(id){id=clean_(id);return mutateQueue_(function(q){return q.filter(function(x){return x!==id;});});}
  function isLegacyAutomationHandler_(h){h=clean_(h);return h===('AUTO_'+'process'+'CustomerStructure')||/^AUTO_0[0-9]_E2E_/.test(h)||h===('AUTO_'+'99_E2E_'+'Safe_Stop_Review')||h==='AUTO_refreshQueueSnapshot';}
  function triggersBy_(handler){return ScriptApp.getProjectTriggers().filter(function(t){try{return clean_(t.getHandlerFunction&&t.getHandlerFunction())===handler;}catch(e){return false;}});}
  function deleteTriggerSafe_(t){try{ScriptApp.deleteTrigger(t);return true;}catch(e){return false;}}
  function cleanLegacyTriggers_(){var removed=[];ScriptApp.getProjectTriggers().forEach(function(t){var h='';try{h=clean_(t.getHandlerFunction&&t.getHandlerFunction());}catch(e){}if(isLegacyAutomationHandler_(h)){if(deleteTriggerSafe_(t))removed.push(h);}});return removed;}
  function ensureWatchdog_(){var rows=triggersBy_(WATCHDOG_HANDLER);while(rows.length>1){deleteTriggerSafe_(rows.pop());}if(!rows.length){ScriptApp.newTrigger(WATCHDOG_HANDLER).timeBased().everyMinutes(5).create();return{created:true,count:1};}return{created:false,count:1};}
  function ensureWorker_(delayMs,currentUid){var current=clean_(currentUid),rows=triggersBy_(FINAL_HANDLER).filter(function(t){var id='';try{id=clean_(t.getUniqueId&&t.getUniqueId());}catch(e){}return !current||!id||id!==current;});if(rows.length)return{created:false,count:rows.length};if(!queue_().length)return{created:false,count:0,reason:'QUEUE_EMPTY'};var delay=Math.max(1000,Number(delayMs||WORKER_DELAY_MS));ScriptApp.newTrigger(FINAL_HANDLER).timeBased().after(delay).create();var at=new Date(Date.now()+delay).toISOString();props_().setProperty(NEXT_AT,at);return{created:true,count:1,scheduledAt:at};}
  function normalizeTopology_(currentUid){var removed=cleanLegacyTriggers_();var finals=triggersBy_(FINAL_HANDLER),current=clean_(currentUid),kept=false,removedFinal=0;finals.forEach(function(t){var id='';try{id=clean_(t.getUniqueId&&t.getUniqueId());}catch(e){}if(current&&id===current){kept=true;return;}if(!kept){kept=true;return;}if(deleteTriggerSafe_(t))removedFinal++;});return{removedLegacyTriggers:removed,removedDuplicateFinalTriggers:removedFinal,watchdog:ensureWatchdog_()};}
  function falsePreflightPark_(r){if(!r)return false;if(upper_(r['Current Stage'])!=='NEEDS REVIEW'||upper_(r['Request Status'])!=='BLOCKED'||upper_(r['Manual Review?'])!=='YES')return false;var reason=[r['Manual Review Reason'],r['Blocking Issue'],r['Reconciliation Status']].map(clean_).join(' ');if(!/PREFLIGHT_BLOCKED/i.test(reason))return false;if(upper_(r['Duplicate Risk Status'])!=='NONE')return false;if(upper_(r['Customer Match Status'])!=='NOT FOUND'||upper_(r['Customer Action'])!=='CREATE')return false;if(upper_(r['Contact Action'])!=='CREATE'||upper_(r['Location Action'])!=='CREATE'||upper_(r['Work Order Action'])!=='CREATE')return false;if(clean_(r['Matched Customer ID']||r['Created Customer ID']||r['Matched Contact ID']||r['Created Contact ID']||r['Matched Location ID']||r['Created Location ID']||r['Work Order ID']))return false;var root=parse_(r['Write Journal JSON']),keys=['customerCreate','contactCreate','standaloneLocationCreate','salesOrderCreate'];for(var i=0;i<keys.length;i++){var x=root&&root[keys[i]]||{};if(Number(x.postAttempts||0)>0||x.remoteWriteMayHaveSucceeded===true)return false;}return true;}
  function recoverFalsePreflightPark_(r){if(!falsePreflightPark_(r))return r;if(typeof CF.Util.clearRowDataValidations==='function')CF.Util.clearRowDataValidations('SERVICE_REQUESTS',r.__rowNumber);CF.Util.patchRow('SERVICE_REQUESTS',r.__rowNumber,{'Updated At':now_(),'Current Stage':'READY FOR CUSTOMER CREATE','Request Status':'OPEN','Manual Review?':'NO','Manual Review Reason':'','Blocking Issue':'','Next Action':'CREATE CUSTOMER','Striven Sync Status':'PARTIAL','Striven Sync Error':'','Reconciliation Status':'AUTO-RECOVERED FALSE PREFLIGHT PARK'});SpreadsheetApp.flush();log_('FALSE_PREFLIGHT_PARK_RECOVERY','RESTORED',r['Request ID'],{},'No Striven write had occurred; request returned to its own durable stage.');return request_(r['Request ID'])||r;}
  function genuineReview_(r){if(!r)return true;if(falsePreflightPark_(r))return false;var risk=upper_(r['Duplicate Risk Status']);if(risk&&risk!=='NONE')return true;return upper_(r['Manual Review?'])==='YES'||['BLOCKED','DUPLICATE','CANCELLED','CANCELED','ERROR'].indexOf(upper_(r['Request Status']))!==-1||upper_(r['Current Stage'])==='NEEDS REVIEW';}
  function structureComplete_(r){return !!r&&upper_(r['Customer Structure Status'])==='COMPLETE'&&!!clean_(r['Matched Customer ID']||r['Created Customer ID'])&&!!clean_(r['Matched Contact ID']||r['Created Contact ID'])&&!!clean_(r['Matched Location ID']||r['Created Location ID']);}
  function infoConfirmed_(r){return upper_(r&&r['Reconciliation Status']).indexOf('CUSTOMER + CONTACT INFO CONFIRMED')!==-1;}
  function resultIds_(result){result=result||{};var seen={},out=[];function add(v){v=clean_(v);if(v&&!seen[v]){seen[v]=true;out.push(v);}}add(result.requestId);add(result.stepResult&&result.stepResult.requestId);add(result.result&&result.result.requestId);add(result.matching&&result.matching.requestId);add(result.execution&&result.execution.requestId);add(result.certification&&result.certification.requestId);return out;}
  function assertRequestScoped_(requestId,result){var bad=resultIds_(result).filter(function(id){return id!==clean_(requestId);});if(!bad.length)return result;log_('REQUEST_ID_INTEGRITY_GUARD','REJECTED_CROSS_REQUEST_RESULT',requestId,{returnedRequestIds:resultIds_(result),rejectedRequestIds:bad},'A result for another request was ignored.');return{ok:false,version:VERSION,status:'CROSS_REQUEST_RESULT_REJECTED',requestId:clean_(requestId),returnedRequestIds:resultIds_(result),rejectedRequestIds:bad,liveWriteExecuted:!!(result&&result.liveWriteExecuted===true)};}
  function signature_(r){if(!r)return'';return[clean_(r['Current Stage']),clean_(r['Request Status']),clean_(r['Next Action']),clean_(r['Matched Customer ID']||r['Created Customer ID']),clean_(r['Matched Contact ID']||r['Created Contact ID']),clean_(r['Matched Location ID']||r['Created Location ID']),clean_(r['Work Order ID']),clean_(r['Reconciliation Status']),clean_(r['Manual Review?'])].join('|');}
  function reconcileOperationalLinks_(){try{if(typeof CF_SERVICEOPS_OPERATIONAL_LINK_RECONCILIATION_V51016_R1_!=='undefined'&&CF_SERVICEOPS_OPERATIONAL_LINK_RECONCILIATION_V51016_R1_&&typeof CF_SERVICEOPS_OPERATIONAL_LINK_RECONCILIATION_V51016_R1_.reconcileAll==='function')return CF_SERVICEOPS_OPERATIONAL_LINK_RECONCILIATION_V51016_R1_.reconcileAll({refreshIfStale:false});}catch(e){return{ok:false,status:'OPERATIONAL_LINK_RECONCILIATION_FAILED',error:String(e&&e.message||e),liveWriteExecuted:false};}return{ok:true,status:'OPERATIONAL_LINK_RECONCILIATION_UNAVAILABLE',liveWriteExecuted:false};}
  function review_(r,code,message){if(!r||!r.__rowNumber)return{ok:false,version:VERSION,status:code||'REVIEW_REQUIRED',requestId:clean_(r&&r['Request ID']),message:message||'',liveWriteExecuted:false};if(typeof CF.Util.clearRowDataValidations==='function')CF.Util.clearRowDataValidations('SERVICE_REQUESTS',r.__rowNumber);CF.Util.patchRow('SERVICE_REQUESTS',r.__rowNumber,{'Updated At':now_(),'Current Stage':'NEEDS REVIEW','Request Status':'BLOCKED','Manual Review?':'YES','Manual Review Reason':message||code||'Review required.','Blocking Issue':message||code||'Review required.','Next Action':'REVIEW REQUEST','Striven Sync Status':'BLOCKED','Reconciliation Status':code||'REVIEW REQUIRED'});SpreadsheetApp.flush();return{ok:false,version:VERSION,status:code||'REVIEW_REQUIRED',requestId:clean_(r['Request ID']),message:message||'',manualReviewRequired:true,liveWriteExecuted:false};}
  function workOrderStep_(requestId){var r=request_(requestId);if(!r)return{ok:false,version:VERSION,status:'REQUEST_NOT_FOUND',requestId:requestId,liveWriteExecuted:false};var known=knownOrderId_(r);if(known){if(!CF.OrderPreflight||typeof CF.OrderPreflight.certifyExisting!=='function')return review_(r,'CERTIFICATION_MODULE_MISSING','Known Service Work Order cannot be certified because the certification module is unavailable.');return CF.OrderPreflight.certifyExisting(requestId,known);}reconcileOperationalLinks_();r=request_(requestId)||r;known=knownOrderId_(r);if(known)return CF.OrderPreflight.certifyExisting(requestId,known);if(!CF.OrderPreflight||typeof CF.OrderPreflight.previewRequest!=='function'||typeof CF.OrderPreflight.approveRequest!=='function'||typeof CF.OrderPreflight.executeApproved!=='function')return review_(r,'WORK_ORDER_WRITER_MODULE_MISSING','Guarded Service Work Order writer is unavailable.');var preview=CF.OrderPreflight.previewRequest(requestId);if(!preview||preview.readyForApproval!==true){var blockers=(preview&&preview.blockers||[]),codes=blockers.map(function(x){return clean_(x.code);});if(codes.indexOf('OPERATIONAL_EVIDENCE_FAILED')!==-1&&CF.StrivenData&&typeof CF.StrivenData.refreshOperationalData==='function'){var refresh=CF.StrivenData.refreshOperationalData({});reconcileOperationalLinks_();return{ok:true,version:VERSION,status:'OPERATIONAL_CACHE_REFRESHED_RERUN_REQUIRED',requestId:requestId,refresh:refresh,liveWriteExecuted:false};}reconcileOperationalLinks_();r=request_(requestId)||r;known=knownOrderId_(r);if(known)return CF.OrderPreflight.certifyExisting(requestId,known);var text=blockers.map(function(x){return clean_(x.code)+': '+clean_(x.message);}).join(' | ')||'Guarded Service Work Order preflight did not pass.';return review_(r,'WORK_ORDER_PREFLIGHT_BLOCKED',text);}var approval;try{approval=CF.OrderPreflight.approveRequest(requestId);}catch(e){reconcileOperationalLinks_();r=request_(requestId)||r;known=knownOrderId_(r);if(known)return CF.OrderPreflight.certifyExisting(requestId,known);return review_(r,'WORK_ORDER_APPROVAL_BLOCKED',String(e&&e.message||e));}reconcileOperationalLinks_();r=request_(requestId)||r;known=knownOrderId_(r);if(known)return CF.OrderPreflight.certifyExisting(requestId,known);var execution=CF.OrderPreflight.executeApproved(requestId,{executionToken:CF.OrderPreflight.executionToken});if(execution&&execution.status==='OPERATIONAL_CACHE_REFRESHED_RERUN_REQUIRED')return{ok:true,version:VERSION,status:'OPERATIONAL_CACHE_REFRESHED_RERUN_REQUIRED',requestId:requestId,approval:approval,execution:execution,liveWriteExecuted:false};if(execution&&execution.status==='SALES_ORDER_CERTIFICATION_GET_RETRY_REQUIRED')return{ok:true,version:VERSION,status:'WORK_ORDER_READ_ONLY_RECONCILIATION_PENDING',requestId:requestId,approval:approval,execution:execution,automaticPostRetry:false,liveWriteExecuted:!!execution.liveWriteExecuted};if(!execution||execution.ok!==true){if(execution&&execution.remoteWriteMayHaveSucceeded===true)return{ok:true,version:VERSION,status:'WORK_ORDER_READ_ONLY_RECONCILIATION_PENDING',requestId:requestId,approval:approval,execution:execution,automaticPostRetry:false,liveWriteExecuted:!!execution.liveWriteExecuted};return review_(request_(requestId)||r,clean_(execution&&execution.status)||'WORK_ORDER_EXECUTION_FAILED',clean_(execution&&execution.error)||'Service Work Order execution failed.');}return execution;}
  function stepLabel_(r){if(!r)return'UNKNOWN';if(knownOrderId_(r))return'WORK_ORDER_CERTIFICATION';if(!structureComplete_(r)){var st=upper_(r['Current Stage']);if(st==='NEW INTAKE')return'MATCHING';if(st==='READY FOR CUSTOMER CREATE')return'CUSTOMER_CREATE_OR_RECONCILE';if(st==='READY FOR LOCATION CREATE')return'LOCATION_CREATE_OR_RECONCILE';if(st==='READY FOR CONTACT CREATE')return'CONTACT_CREATE_OR_RECONCILE';return'CUSTOMER_STRUCTURE';}if(!infoConfirmed_(r))return'CUSTOMER_CONTACT_INFO_SYNC';return'WORK_ORDER_CREATE_OR_CERTIFY';}
  function step_(requestId){var r=request_(requestId);if(!r)return{ok:false,version:VERSION,status:'REQUEST_NOT_FOUND',requestId:requestId,liveWriteExecuted:false};r=recoverFalsePreflightPark_(r);if(terminal_(r))return{ok:true,version:VERSION,status:'REQUEST_TERMINAL',requestId:requestId,liveWriteExecuted:false};var known=knownOrderId_(r);if(known)return assertRequestScoped_(requestId,workOrderStep_(requestId));if(genuineReview_(r))return{ok:true,version:VERSION,status:'GENUINE_REVIEW_WAIT',requestId:requestId,liveWriteExecuted:false,manualReviewRequired:true};if(!structureComplete_(r)){if(!CF.CustomerStructureEngine||typeof CF.CustomerStructureEngine.step!=='function')return review_(r,'CUSTOMER_STRUCTURE_ENGINE_MISSING','Customer Structure Engine is unavailable.');return assertRequestScoped_(requestId,CF.CustomerStructureEngine.step(requestId));}if(!infoConfirmed_(r)){if(!CF.CustomerContactInfoSync||typeof CF.CustomerContactInfoSync.reconcile!=='function')return review_(r,'CUSTOMER_INFO_SYNC_MODULE_MISSING','Customer/contact information reconciliation module is unavailable.');return assertRequestScoped_(requestId,CF.CustomerContactInfoSync.reconcile(requestId,{autoMode:true}));}return assertRequestScoped_(requestId,workOrderStep_(requestId));}
  function refreshQueue_(){try{if(CF.OperatorQueue&&typeof CF.OperatorQueue.refresh==='function')return CF.OperatorQueue.refresh();}catch(e){return{ok:false,status:'QUEUE_REFRESH_FAILED',error:String(e&&e.message||e)};}return{ok:false,status:'QUEUE_REFRESH_UNAVAILABLE'};}
  function kick(requestId){requestId=clean_(requestId);if(!requestId)return{ok:false,version:VERSION,status:'REQUEST_ID_REQUIRED',scheduled:false,liveWriteExecuted:false};props_().setProperty(ENABLED,'true');props_().setProperty(AUTO_SO,'true');props_().setProperty(PREPARATION_ONLY,'false');prioritize_(requestId);props_().setProperty(LAST_KICK,new Date().toISOString());props_().setProperty(LAST_REQUEST,requestId);var topology=normalizeTopology_(''),worker=ensureWorker_(1000,'');return{ok:true,version:VERSION,status:'CANONICAL_REQUEST_PRIORITY_QUEUED',requestId:requestId,queuedRequestIds:queue_(),worker:worker,topology:topology,liveWriteExecuted:false};}
  function worker(e){e=e||{};if(upper_(props_().getProperty(ENABLED))!=='TRUE')return{ok:true,version:VERSION,status:'AUTOMATION_DISABLED',liveWriteExecuted:false};var started=Date.now(),history=[],last=null,currentUid=clean_(e.triggerUid);normalizeTopology_(currentUid);for(var i=0;i<MAX_STEPS&&Date.now()-started<WORKER_BUDGET_MS;i++){var q=queue_();if(!q.length)break;var id=q[0],before=request_(id);if(!before){dequeue_(id);continue;}before=recoverFalsePreflightPark_(before);if(terminal_(before)){dequeue_(id);continue;}if(genuineReview_(before)){dequeue_(id);last={ok:true,version:VERSION,status:'GENUINE_REVIEW_DEQUEUED',requestId:id,liveWriteExecuted:false};continue;}var beforeSig=signature_(before),result,stepStarted=Date.now(),stepLabel=stepLabel_(before),beforeUpdatedMs=dateMs_(before['Updated At']),beforeCreatedMs=dateMs_(before['Created At']||before['Submitted At']);try{result=step_(id);}catch(error){var failedMs=Date.now()-stepStarted;log_('CANONICAL_STEP_TIMING','ERROR',id,{stepLabel:stepLabel,stepIndex:i+1,fromStage:clean_(before['Current Stage']),fromRequestStatus:clean_(before['Request Status']),fromNextAction:clean_(before['Next Action']),waitSinceLastUpdateMs:beforeUpdatedMs?Math.max(0,stepStarted-beforeUpdatedMs):'',requestAgeAtStepStartMs:beforeCreatedMs?Math.max(0,stepStarted-beforeCreatedMs):'',error:String(error&&error.message||error)},String(error&&error.stack||error),failedMs);log_('FINAL_WORKER','ERROR',id,{error:String(error&&error.message||error)},String(error&&error.stack||error),failedMs);ensureWorker_(WORKER_DELAY_MS,currentUid);throw error;}result=assertRequestScoped_(id,result);history.push({requestId:id,status:clean_(result&&result.status),liveWriteExecuted:!!(result&&result.liveWriteExecuted)});last=result;var after=request_(id),stepDurationMs=Date.now()-stepStarted;log_('CANONICAL_STEP_TIMING','COMPLETE',id,{stepLabel:stepLabel,stepIndex:i+1,resultStatus:clean_(result&&result.status),liveWriteExecuted:!!(result&&result.liveWriteExecuted),fromStage:clean_(before['Current Stage']),toStage:clean_(after&&after['Current Stage']),fromRequestStatus:clean_(before['Request Status']),toRequestStatus:clean_(after&&after['Request Status']),fromNextAction:clean_(before['Next Action']),toNextAction:clean_(after&&after['Next Action']),waitSinceLastUpdateMs:beforeUpdatedMs?Math.max(0,stepStarted-beforeUpdatedMs):'',requestAgeAtStepStartMs:beforeCreatedMs?Math.max(0,stepStarted-beforeCreatedMs):'',requestAgeAtStepEndMs:beforeCreatedMs?Math.max(0,Date.now()-beforeCreatedMs):'',queueDepthAtStepStart:q.length,queueDepthAfterStep:queue_().length},'',stepDurationMs);if(after&&(terminal_(after)||(knownOrderId_(after)&&upper_(after['Current Stage'])==='COMPLETED'))){dequeue_(id);refreshQueue_();continue;}if(after&&genuineReview_(after)){dequeue_(id);refreshQueue_();continue;}if(result&&result.status==='CROSS_REQUEST_RESULT_REJECTED'){ensureWorker_(WORKER_DELAY_MS,currentUid);break;}if(result&&result.liveWriteExecuted===true){ensureWorker_(WORKER_DELAY_MS,currentUid);break;}var afterSig=signature_(after);if(beforeSig===afterSig){ensureWorker_(WORKER_DELAY_MS,currentUid);break;}}
    if(queue_().length)ensureWorker_(WORKER_DELAY_MS,currentUid);else refreshQueue_();
    return{ok:!last||last.ok!==false,version:VERSION,status:last&&last.status?last.status:'IDLE_NO_QUEUED_REQUESTS',requestId:last&&last.requestId||'',lastResult:last,history:history,queuedRequestIds:queue_(),durationMs:Date.now()-started,liveWriteExecuted:!!(last&&last.liveWriteExecuted===true)};}
  function recentRecoverable_(){var now=Date.now(),rows=CF.Util.readRecords('SERVICE_REQUESTS').filter(function(r){if(!r||terminal_(r))return false;var created=dateMs_(r['Submitted At']||r['Created At']||r['Updated At']);if(created&&now-created>RECOVERY_LOOKBACK_MS)return false;if(falsePreflightPark_(r))return true;if(genuineReview_(r))return false;if(knownOrderId_(r))return true;var stage=upper_(r['Current Stage']);return['NEW INTAKE','READY FOR CUSTOMER CREATE','READY FOR LOCATION CREATE','READY FOR CONTACT CREATE','CREATING CUSTOMER STRUCTURE','CUSTOMER RESOLVED','CUSTOMER STRUCTURE COMPLETE','SALES ORDER CREATED'].indexOf(stage)!==-1;});rows.sort(function(a,b){return dateMs_(b['Submitted At']||b['Created At'])-dateMs_(a['Submitted At']||a['Created At']);});return rows;}
  function recoveryWatchdog(){if(upper_(props_().getProperty(ENABLED))!=='TRUE')return{ok:true,version:VERSION,status:'RECOVERY_WATCHDOG_AUTOMATION_DISABLED',liveWriteExecuted:false};var topology=normalizeTopology_(''),q=queue_();if(!q.length){var rows=recentRecoverable_();if(rows.length){mutateQueue_(function(existing){rows.forEach(function(r){existing.push(clean_(r['Request ID']));});return existing;});q=queue_();}}var worker=ensureWorker_(WORKER_DELAY_MS,'');return{ok:true,version:VERSION,status:q.length?'RECOVERY_QUEUE_ACTIVE':'RECOVERY_IDLE',queuedRequestIds:q,recoverableRecentCount:recentRecoverable_().length,topology:topology,worker:worker,liveWriteExecuted:false};}
  function activate(){props_().setProperty(ENABLED,'true');props_().setProperty(AUTO_SO,'true');props_().setProperty(PREPARATION_ONLY,'false');cleanLegacyTriggers_();triggersBy_(FINAL_HANDLER).forEach(deleteTriggerSafe_);triggersBy_(WATCHDOG_HANDLER).forEach(deleteTriggerSafe_);ensureWatchdog_();var rows=recentRecoverable_();mutateQueue_(function(q){rows.forEach(function(r){q.push(clean_(r['Request ID']));});return q;});var worker=ensureWorker_(1000,''),hardening=null;try{if(typeof CFH_installAndVerifyProductionHardening==='function')hardening=CFH_installAndVerifyProductionHardening();}catch(e){hardening={ok:false,status:'PRODUCTION_GUARD_INSTALL_FAILED',error:String(e&&e.message||e)};}var handlers=ScriptApp.getProjectTriggers().map(function(t){try{return clean_(t.getHandlerFunction&&t.getHandlerFunction());}catch(e){return'';}});var result={ok:!hardening||hardening.ok!==false,version:VERSION,status:'SINGLE_SERVICEOPS_MODEL_ACTIVE',finalHandler:FINAL_HANDLER,watchdogHandler:WATCHDOG_HANDLER,queuedRequestIds:queue_(),recoveredRequestIds:rows.map(function(r){return clean_(r['Request ID']);}),worker:worker,hardening:hardening,activeAutomationHandlers:handlers.filter(function(h){return h===FINAL_HANDLER||h===WATCHDOG_HANDLER;}),legacyAutomationTriggerCount:handlers.filter(isLegacyAutomationHandler_).length,liveWriteExecuted:false};log_('ACTIVATE_SINGLE_MODEL',result.legacyAutomationTriggerCount===0?'PASS':'FAIL','',{result:result},'');return result;}
  function disable(){props_().setProperty(ENABLED,'false');props_().setProperty(AUTO_SO,'false');triggersBy_(FINAL_HANDLER).forEach(deleteTriggerSafe_);triggersBy_(WATCHDOG_HANDLER).forEach(deleteTriggerSafe_);cleanLegacyTriggers_();writeQueue_([]);return{ok:true,version:VERSION,status:'SERVICEOPS_AUTOMATION_DISABLED',liveWriteExecuted:false};}
  function inspect(){var handlers=ScriptApp.getProjectTriggers().map(function(t){try{return clean_(t.getHandlerFunction&&t.getHandlerFunction());}catch(e){return'';}});return{ok:true,version:VERSION,enabled:upper_(props_().getProperty(ENABLED))==='TRUE',finalHandler:FINAL_HANDLER,watchdogHandler:WATCHDOG_HANDLER,queuedRequestIds:queue_(),finalWorkerTriggers:handlers.filter(function(h){return h===FINAL_HANDLER;}).length,watchdogTriggers:handlers.filter(function(h){return h===WATCHDOG_HANDLER;}).length,legacyAutomationTriggerCount:handlers.filter(isLegacyAutomationHandler_).length,singleModel:handlers.filter(isLegacyAutomationHandler_).length===0&&handlers.filter(function(h){return h===WATCHDOG_HANDLER;}).length===1};}
  return{version:VERSION,kick:kick,worker:worker,recoveryWatchdog:recoveryWatchdog,activate:activate,disable:disable,inspect:inspect,queuedRequestIds:queue_,allHandlerNames:function(){return[FINAL_HANDLER,WATCHDOG_HANDLER];}};
})();

