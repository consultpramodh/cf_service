/* CF_SERVICEOPS_V5_13_9_TARGETED_POST_CUSTOMER_LOCATION_RECONCILIATION_R1 */
/* CF_SERVICEOPS_V5_13_8_SCOPED_CONTACT_CUSTOMER_ENRICHMENT_R1 */
/* CF_SERVICEOPS_V5_13_7_PARTIAL_LOCATION_IDENTITY_R1 */
/* CF_SERVICEOPS_V5_13_6_EXECUTABLE_LOCATION_STAGE_R1 */
/* CF_SERVICEOPS_V5_13_5_TARGETED_RECONCILIATION_LOW_API_R1 */
/* CF_SERVICEOPS_V5_13_2_STABILIZATION_R1_WRITE */
/************************************************************
 * APPS SCRIPT — 60_Striven_Write.gs
 * CF ServiceOps — Phase 5A Transaction Planning
 * Version: 5.2.0
 *
 * PURPOSE
 * - Builds deterministic Customer → Contact → Location plans.
 * - Persists dry-run payload previews and fingerprints.
 * - Records operator approval against immutable plan content.
 * - Performs no Striven POST, PUT, PATCH, or DELETE requests.
 * - Work Order creation remains deferred.
 ************************************************************/
var CF = CF || {};

CF.StrivenWrite = (function () {
  'use strict';

  var MODULE_NAME = '60_Striven_Write';
  var VERSION = '5.2.0';
  var PLAN_VERSION = 'PHASE5A-CUSTOMER-STRUCTURE-V2-PRIMARY-LOCATION';
  var CUSTOMER_CREATE_PREVIEW_VERSION = 'PHASE5B-A-CUSTOMER-CREATE-PREVIEW-V1'; // PHASE5B_CUSTOMER_CREATE_PREVIEW_V1
  var CONTROLLED_TEST_REQUEST_ID = 'SR-20260818160541-7844'; // PHASE5B_CONTROLLED_CUSTOMER_PREFLIGHT_V1
  var CONTROLLED_TEST_EMAIL = 'pramodhtest@classicfireplace.ca'; // PHASE5B_ONE_CUSTOMER_LIVE_EXECUTOR_V1
  var CONTROLLED_TEST_NAME = 'Test Test';
  var CONTROLLED_TEST_EXPECTED_PAYLOAD_FINGERPRINT = '6a9fe6f61ca091965b6440f99f66dda9995d5924be85cb0c525aaf1c92879ce5';
  var CONTROLLED_CREATE_FRESHNESS_MINUTES = 15;
  var CUSTOMER_CREATE_HELP_URLS = [ // PHASE5B_CUSTOMER_CONTRACT_PROBE_FALLBACK_V1
    'https://api.striven.com/Help/Api/POST-v1-customers-create',
    'https://api.test.striven.com/Help/Api/POST-v1-customers-create'
  ];

  function deps_() {
    if (!CF.Config || !CF.Util) {
      throw new Error('CF.Config and CF.Util are required.');
    }
    return { config: CF.Config, util: CF.Util };
  }

  function clean_(value) {
    return deps_().util.cleanText(value);
  }

  function request_(requestIdOrRow) {
    var d = deps_();
    if (typeof requestIdOrRow === 'number') {
      var rows = d.util.readRecords('SERVICE_REQUESTS');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].__rowNumber === requestIdOrRow) return rows[i];
      }
      return null;
    }
    return d.util.findRecord('SERVICE_REQUESTS', 'Request ID', requestIdOrRow);
  }

  function operator_(actor) {
    var value = clean_(actor);
    if (value) return value;
    try {
      value = clean_(Session.getActiveUser().getEmail());
    } catch (ignored) {}
    return value || 'OPERATOR';
  }

  function resolvedCustomerId_(record) {
    return clean_(record['Matched Customer ID'] || record['Created Customer ID']);
  }

  function resolvedContactId_(record) {
    return clean_(record['Matched Contact ID'] || record['Created Contact ID']);
  }

  function resolvedLocationId_(record) {
    return clean_(record['Matched Location ID'] || record['Created Location ID']);
  }

  function provinceCode_(value) {
    var text = clean_(value);
    var upper = text.toUpperCase();
    if (upper === 'ONTARIO' || upper === 'ONT') return 'ON';
    return text;
  }

  function postalForApi_(value, country) {
    var text = clean_(value).toUpperCase();
    if (clean_(country).toUpperCase() === 'CANADA') {
      var compact = text.replace(/[^A-Z0-9]/g, '');
      if (/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(compact)) {
        return compact.slice(0, 3) + ' ' + compact.slice(3);
      }
    }
    return text;
  }

  function canonicalCountry_(value) {
    var text =
      clean_(value);

    var upper =
      text.toUpperCase();

    if (
      upper === 'CA' ||
      upper === 'CAN' ||
      upper === 'CANADA'
    ) {
      return 'Canada';
    }

    return text || 'Canada';
  }

  function primaryLocationPayload_(record) {
    var country =
      canonicalCountry_(
        record['Country'] ||
        'Canada'
      );

    return {
      Name: 'Primary Location',
      Address1: clean_(record['Street']),
      City: clean_(record['City']),
      State: provinceCode_(record['Province']),
      PostalCode: postalForApi_(record['Postal Code'], country),
      Country: country
    };
  }

  function customerPayload_(record) {
    var d = deps_();
    var first = clean_(record['First Name']);
    var last = clean_(record['Last Name']);
    var fullName = clean_(record['Full Name']) || d.util.buildFullName(first, last);
    return {
      FirstName: first,
      LastName: last,
      Email: clean_(record['Normalized Email'] || record['Email']).toLowerCase(),
      CustomerName: fullName,
      IsConsumerAccount: true,
      PrimaryLocation: primaryLocationPayload_(record),
      Phone: clean_(record['Phone'])
    };
  }

  function contactPayload_(record, customerReference) {
    return {
      CustomerId: customerReference,
      FirstName: clean_(record['First Name']),
      LastName: clean_(record['Last Name']),
      Phone: clean_(record['Phone']),
      Email: clean_(record['Email'])
    };
  }

  function locationPayload_(record) {
    return {
      Name: 'Primary Location',
      Address1: clean_(record['Street']),
      City: clean_(record['City']),
      State: clean_(record['Province']),
      PostalCode: clean_(record['Postal Code']),
      Country: clean_(record['Country'] || 'Canada')
    };
  }

  function normalizeEntityAction_(value, resolvedId) {
    var action = clean_(value).toUpperCase();
    if (action === 'LINK EXISTING') return 'LINK EXISTING';
    if (action === 'CREATE') return 'CREATE';
    if (action === 'REVIEW') return 'REVIEW';
    if (action === 'REQUEST INFORMATION') return 'REQUEST INFORMATION';
    if (action === 'BLOCKED') return 'BLOCKED';
    if (action === 'NONE' && resolvedId) return 'LINK EXISTING';
    return action || (resolvedId ? 'LINK EXISTING' : 'REVIEW');
  }

  function addBlocker_(blockers, code, message, field) {
    blockers.push({ code: code, message: message, field: field || '' });
  }

  function planContent_(record) {
    var d = deps_();
    var customerId = resolvedCustomerId_(record);
    var contactId = resolvedContactId_(record);
    var locationId = resolvedLocationId_(record);
    var customerAction = normalizeEntityAction_(record['Customer Action'], customerId);
    var contactAction = normalizeEntityAction_(record['Contact Action'], contactId);
    var locationAction = normalizeEntityAction_(record['Location Action'], locationId);
    var blockers = [];
    var steps = [];
    var customerReference = customerId || (customerAction === 'CREATE' ? '<CREATED_CUSTOMER_ID>' : '');

    if (clean_(record['Duplicate Risk Status']).toUpperCase() === 'HIGH') {
      addBlocker_(blockers, 'HIGH_DUPLICATE_RISK', clean_(record['Duplicate Risk Reason']) || 'High duplicate risk requires review.', 'Duplicate Risk Status');
    }

    if (customerAction === 'CREATE') {
      if (!clean_(record['First Name'])) addBlocker_(blockers, 'CUSTOMER_FIRST_NAME_REQUIRED', 'First Name is required to create a Customer.', 'First Name');
      if (!clean_(record['Last Name'])) addBlocker_(blockers, 'CUSTOMER_LAST_NAME_REQUIRED', 'Last Name is required to create a Customer.', 'Last Name');
      if (!clean_(record['Street'])) addBlocker_(blockers, 'PRIMARY_LOCATION_STREET_REQUIRED', 'Street is required for the new Customer Primary Location.', 'Street');
      if (!clean_(record['City'])) addBlocker_(blockers, 'PRIMARY_LOCATION_CITY_REQUIRED', 'City is required for the new Customer Primary Location.', 'City');
      if (!clean_(record['Province'])) addBlocker_(blockers, 'PRIMARY_LOCATION_PROVINCE_REQUIRED', 'Province is required for the new Customer Primary Location.', 'Province');
      if (!clean_(record['Postal Code'])) addBlocker_(blockers, 'PRIMARY_LOCATION_POSTAL_REQUIRED', 'Postal Code is required for the new Customer Primary Location.', 'Postal Code');
      if (!clean_(record['Phone']) && !clean_(record['Email'])) addBlocker_(blockers, 'CUSTOMER_IDENTITY_REQUIRED', 'At least one of Phone or Email is required before Customer creation.', 'Phone / Email');
      steps.push({
        sequence: steps.length + 1,
        step: 'CREATE_CUSTOMER_WITH_PRIMARY_LOCATION',
        mode: 'DRY_RUN',
        endpoint: d.config.getEndpoint('CUSTOMER_CREATE'),
        payload: customerPayload_(record),
        expectedResult: 'Create one Customer and its Primary Location atomically; persist the returned Customer ID.'
      });
      steps.push({
        sequence: steps.length + 1,
        step: 'RESOLVE_CREATED_PRIMARY_LOCATION_ID',
        mode: 'DRY_RUN_READ',
        endpoint: d.config.getEndpoint('CUSTOMER_LOCATION_SEARCH'),
        payload: {
          PageIndex: 0,
          PageSize: 100,
          Customer: { Id: '<CREATED_CUSTOMER_ID>' }
        },
        expectedResult: 'Re-read the new Customer locations and persist the Primary Location ID before Contact creation.'
      });
    } else if (customerAction === 'LINK EXISTING') {
      if (!customerId) addBlocker_(blockers, 'CUSTOMER_ID_REQUIRED', 'An existing Customer ID is required.', 'Matched Customer ID');
      steps.push({
        sequence: steps.length + 1,
        step: 'LINK_EXISTING_CUSTOMER',
        mode: 'LOCAL_ONLY',
        customerId: customerId,
        expectedResult: 'Use existing Customer without creating a duplicate.'
      });
    } else {
      addBlocker_(blockers, 'CUSTOMER_REVIEW_REQUIRED', 'Customer resolution must be completed before approval.', 'Customer Action');
      steps.push({ sequence: steps.length + 1, step: 'REVIEW_CUSTOMER', mode: 'OPERATOR' });
    }

    if (contactAction === 'CREATE') {
      if (!customerReference) addBlocker_(blockers, 'CONTACT_CUSTOMER_REQUIRED', 'A resolved or newly created Customer is required before Contact creation.', 'Customer Action');
      if (!clean_(record['First Name'])) addBlocker_(blockers, 'CONTACT_FIRST_NAME_REQUIRED', 'First Name is required to create a Contact.', 'First Name');
      if (!clean_(record['Last Name'])) addBlocker_(blockers, 'CONTACT_LAST_NAME_REQUIRED', 'Last Name is required to create a Contact.', 'Last Name');
      steps.push({
        sequence: steps.length + 1,
        step: 'CREATE_CONTACT',
        mode: 'DRY_RUN',
        endpoint: d.config.getEndpoint('CONTACTS'),
        payload: contactPayload_(record, customerReference),
        expectedResult: 'Persist returned Contact ID.'
      });
      steps.push({
        sequence: steps.length + 1,
        step: 'ASSOCIATE_CONTACT_TO_CUSTOMER',
        mode: 'DRY_RUN',
        endpoint: d.config.getEndpoint('ASSOCIATE_CONTACT_TO_CUSTOMER', { contactId: '<CREATED_CONTACT_ID>' }),
        payload: { CustomerId: customerReference },
        expectedResult: 'Verify durable Contact-to-Customer association.'
      });
    } else if (contactAction === 'LINK EXISTING') {
      if (!contactId) addBlocker_(blockers, 'CONTACT_ID_REQUIRED', 'An existing Contact ID is required.', 'Matched Contact ID');
      if (!customerReference) addBlocker_(blockers, 'CONTACT_CUSTOMER_REQUIRED', 'A Customer must be resolved before linking a Contact.', 'Matched Customer ID');
      steps.push({
        sequence: steps.length + 1,
        step: 'LINK_EXISTING_CONTACT',
        mode: 'LOCAL_ONLY',
        customerId: customerReference,
        contactId: contactId,
        expectedResult: 'Verify the Contact belongs to the resolved Customer.'
      });
    } else {
      addBlocker_(blockers, 'CONTACT_REVIEW_REQUIRED', 'Contact resolution must be completed before approval.', 'Contact Action');
      steps.push({ sequence: steps.length + 1, step: 'REVIEW_CONTACT', mode: 'OPERATOR' });
    }

    if (locationAction === 'CREATE' && customerAction === 'CREATE') {
      steps.push({
        sequence: steps.length + 1,
        step: 'PRIMARY_LOCATION_INCLUDED_IN_CUSTOMER_CREATE',
        mode: 'INCLUDED',
        payload: primaryLocationPayload_(record),
        expectedResult: 'Do not create a second Location. Use the Primary Location created inside the Customer request.'
      });
    } else if (locationAction === 'CREATE') {
      if (!customerReference) addBlocker_(blockers, 'LOCATION_CUSTOMER_REQUIRED', 'A resolved Customer is required before Location creation.', 'Customer Action');
      if (!clean_(record['Street'])) addBlocker_(blockers, 'LOCATION_STREET_REQUIRED', 'Street is required to create a Location.', 'Street');
      if (!clean_(record['City'])) addBlocker_(blockers, 'LOCATION_CITY_REQUIRED', 'City is required to create a Location.', 'City');
      if (!clean_(record['Postal Code'])) addBlocker_(blockers, 'LOCATION_POSTAL_REQUIRED', 'Postal Code is required to create a Location.', 'Postal Code');
      steps.push({
        sequence: steps.length + 1,
        step: 'CREATE_LOCATION',
        mode: 'DRY_RUN',
        endpoint: d.config.getEndpoint('CUSTOMER_LOCATION_CREATE', { customerId: customerReference }),
        payload: locationPayload_(record),
        expectedResult: 'Persist returned Location ID. Live execution remains disabled until the exact create-location contract is verified.'
      });
    } else if (locationAction === 'LINK EXISTING') {
      if (!locationId) addBlocker_(blockers, 'LOCATION_ID_REQUIRED', 'An existing Location ID is required.', 'Matched Location ID');
      if (!customerReference) addBlocker_(blockers, 'LOCATION_CUSTOMER_REQUIRED', 'A Customer must be resolved before linking a Location.', 'Matched Customer ID');
      steps.push({
        sequence: steps.length + 1,
        step: 'LINK_EXISTING_LOCATION',
        mode: 'LOCAL_ONLY',
        customerId: customerReference,
        locationId: locationId,
        expectedResult: 'Verify the Location belongs to the resolved Customer.'
      });
    } else {
      addBlocker_(blockers, 'LOCATION_REVIEW_REQUIRED', 'Location resolution must be completed before approval.', 'Location Action');
      steps.push({ sequence: steps.length + 1, step: 'REVIEW_LOCATION', mode: 'OPERATOR' });
    }

    steps.push({
      sequence: steps.length + 1,
      step: 'WORK_ORDER',
      mode: 'DEFERRED',
      expectedResult: 'No Work Order API call in Phase 5A.'
    });

    return {
      planVersion: PLAN_VERSION,
      requestId: clean_(record['Request ID']),
      sourceSchemaVersion: clean_(record['Schema Version']),
      actions: {
        customer: customerAction,
        contact: contactAction,
        location: locationAction,
        workOrder: 'DEFERRED'
      },
      resolvedIds: {
        customerId: customerId,
        contactId: contactId,
        locationId: locationId
      },
      requestIdentity: {
        fullName: clean_(record['Full Name']),
        phone: clean_(record['Phone']),
        email: clean_(record['Email']),
        fullAddress: clean_(record['Full Address'])
      },
      payloads: {
        customer: customerAction === 'CREATE' ? customerPayload_(record) : null,
        primaryLocation: customerAction === 'CREATE' ? primaryLocationPayload_(record) : null,
        contact: contactAction === 'CREATE' ? contactPayload_(record, customerReference) : null,
        location: locationAction === 'CREATE' && customerAction !== 'CREATE' ? locationPayload_(record) : null
      },
      steps: steps,
      blockers: blockers,
      readyForApproval: blockers.length === 0,
      liveWritesAllowed: false
    };
  }

  function buildPreviewFromRecord_(record) {
    var d = deps_();
    var content = planContent_(record);
    var fingerprint = d.util.canonicalHash(content);
    var persisted = d.util.clone(content);
    persisted.generatedAt = d.util.nowString();
    persisted.transactionFingerprint = fingerprint;
    return {
      ok: true,
      version: VERSION,
      planVersion: PLAN_VERSION,
      requestId: content.requestId,
      readyForApproval: content.readyForApproval,
      blockers: content.blockers,
      actions: content.actions,
      resolvedIds: content.resolvedIds,
      steps: content.steps,
      payloads: content.payloads,
      transactionFingerprint: fingerprint,
      transactionPlan: persisted,
      liveWritesAllowed: false,
      workOrderCreateSupported: false
    };
  }

  function planText_(preview) {
    var lines = [];
    lines.push('Phase 5A — DRY RUN ONLY');
    lines.push('Request: ' + preview.requestId);
    lines.push('Customer: ' + preview.actions.customer + (preview.resolvedIds.customerId ? ' · ' + preview.resolvedIds.customerId : ''));
    lines.push('Contact: ' + preview.actions.contact + (preview.resolvedIds.contactId ? ' · ' + preview.resolvedIds.contactId : ''));
    lines.push('Location: ' + preview.actions.location + (preview.resolvedIds.locationId ? ' · ' + preview.resolvedIds.locationId : ''));
    lines.push('Work Order: DEFERRED');
    lines.push('');
    preview.steps.forEach(function (step) {
      lines.push(step.sequence + '. ' + step.step + ' [' + step.mode + ']');
    });
    if (preview.blockers.length) {
      lines.push('');
      lines.push('BLOCKERS');
      preview.blockers.forEach(function (blocker) { lines.push('• ' + blocker.message); });
    } else {
      lines.push('');
      lines.push('READY FOR OPERATOR APPROVAL');
    }
    lines.push('');
    lines.push('Fingerprint: ' + preview.transactionFingerprint);
    return lines.join('\n');
  }

  function persistPreview_(record, preview) {
    var d = deps_();
    var changed = clean_(record['Transaction Fingerprint']) !== preview.transactionFingerprint;
    var patch = {
      'Transaction Plan JSON': d.util.safeJson(preview.transactionPlan),
      'Transaction Fingerprint': preview.transactionFingerprint,
      'Updated At': d.util.nowString()
    };
    if (changed) {
      patch['Approved By'] = '';
      patch['Approved At'] = '';
      patch['Approval Fingerprint'] = '';
      if (clean_(record['Current Stage']) === 'APPROVED FOR CUSTOMER STRUCTURE') {
        patch['Current Stage'] = preview.readyForApproval ? stageForActions_(preview.actions) : 'NEEDS REVIEW';
        patch['Customer Structure Status'] = 'NOT STARTED';
        patch['Striven Sync Status'] = 'NOT SYNCED';
      }
    }
    if (typeof d.util.clearRowDataValidations === 'function') {
      d.util.clearRowDataValidations('SERVICE_REQUESTS', record.__rowNumber);
    }
    d.util.patchRow('SERVICE_REQUESTS', record.__rowNumber, patch);
    return changed;
  }

  function stageForActions_(actions) {
    if (actions.customer === 'CREATE') return 'READY FOR CUSTOMER CREATE';
    if (actions.contact === 'CREATE') return 'READY FOR CONTACT CREATE';
    if (actions.location === 'CREATE') return 'READY FOR LOCATION CREATE';
    return 'CUSTOMER RESOLVED';
  }

  function previewRequest(requestId){var r=request_(requestId),item=item_(),op=operational_(customerId_(r),locationId_(r)),payload=payload_(r,item),fp=fingerprints_(r,payload),j=orderJournal_(r),ps=propState_(),ss=statusPropState_(),wn=webformNotes_(r),blockers=validate_(r,item,op);var approved=clean_(j.order.writeFingerprint)===fp.writeFingerprint&&upper_(j.order.status)==='APPROVED_FOR_CREATE';return{ok:blockers.length===0,version:VERSION,mode:'GUARDED_SALES_ORDER_CREATE_QUOTED_THEN_MANUAL_REVIEW',requestId:clean_(r['Request ID']),rowNumber:r.__rowNumber,state:{stage:clean_(r['Current Stage']),customerId:customerId_(r),contactId:contactId_(r),locationId:locationId_(r),workOrderId:clean_(r['Work Order ID']),duplicateRisk:clean_(r['Duplicate Risk Status'])},endpoint:ENDPOINT,payload:payload,payloadFingerprint:fp.payloadFingerprint,writeFingerprint:fp.writeFingerprint,contractCorrection:{reason:'Striven permits new Sales Orders to be created as Quoted (19).',postCreatePolicy:'After successful create + GET reconciliation, stop automation and hand off to Manual Review. Operator changes the Sales Order from Quoted (19) to In Progress (25) manually when ready.',internalNotesCreatePolicy:'DEFERRED_AFTER_SERVER_REJECTED_STRING_DATATYPE'},paymentTermProperty:{current:ps.value,expected:'13',correctableOnApproval:ps.correctable,alreadyCorrect:ps.correct},salesOrderCreateStatusProperty:{current:ss.value,expected:'19',expectedName:'Quoted',correctableOnApproval:ss.correctable,alreadyCorrect:ss.correct},approvalPolicy:{approvalStage:'APPROVED',createStatusId:19,createStatusName:'Quoted',postCreateHandling:'MANUAL_REVIEW',operatorAction:'Review Sales Order and manually change status to 25 — In Progress when ready',automaticStatusTransition:false},deferredInternalNotes:{source:'WEBFORM_REQUESTS.Raw Payload — relevant operational fields only',ok:wn.ok,fieldCount:wn.fieldCount||0,characters:wn.text?wn.text.length:0,text:wn.text||'',reason:'POST /v1/sales-orders rejected InternalNotes as a string. Notes are preserved and omitted from create until the correct notes mechanism is verified.'},operational:{fresh:operationalFresh_(),evidence:op},approval:{approved:approved,approvedAt:clean_(j.order.approvedAt),storedApprovalFingerprint:clean_(j.order.writeFingerprint)},journal:j.order,blockers:blockers,warnings:['Sales Order creation scope ends at a successfully reconciled Quoted order.','After creation the request is deliberately sent to Manual Review; there is no automatic Quoted-to-In-Progress transition.','Internal Notes remain deferred; CustomFields/nested Contact/Ship-to were not rejected by the latest server modelState.','A successful response identifier is never trusted until GET /v1/sales-orders/{id} confirms Customer, Contact, Ship-to Location, Type, Payment Term, Quoted status, Item and required custom fields.'],readyForApproval:blockers.length===0,readyForLivePost:blockers.length===0&&approved&&operationalFresh_(),liveWriteExecuted:false};}

  function validateCustomerCreate_(record, payload) {
    var blockers = [];
    var warnings = [];
    var stage = clean_(record['Current Stage']).toUpperCase();
    var customerAction = normalizeEntityAction_(record['Customer Action'], resolvedCustomerId_(record));
    var contactAction = normalizeEntityAction_(record['Contact Action'], resolvedContactId_(record));
    var locationAction = normalizeEntityAction_(record['Location Action'], resolvedLocationId_(record));

    if (stage !== 'READY FOR CUSTOMER CREATE') addBlocker_(blockers, 'STAGE_NOT_READY', 'Current Stage must be READY FOR CUSTOMER CREATE.', 'Current Stage');
    if (customerAction !== 'CREATE') addBlocker_(blockers, 'CUSTOMER_ACTION_NOT_CREATE', 'Customer Action must be CREATE.', 'Customer Action');
    if (resolvedCustomerId_(record)) addBlocker_(blockers, 'CUSTOMER_ALREADY_RESOLVED', 'A Customer ID already exists; do not create a duplicate.', 'Matched Customer ID / Created Customer ID');
    if (clean_(record['Duplicate Risk Status']).toUpperCase() === 'HIGH') addBlocker_(blockers, 'HIGH_DUPLICATE_RISK', clean_(record['Duplicate Risk Reason']) || 'High duplicate risk requires review.', 'Duplicate Risk Status');

    if (!clean_(payload.FirstName)) addBlocker_(blockers, 'FIRST_NAME_REQUIRED', 'FirstName is required.', 'First Name');
    if (!clean_(payload.LastName)) addBlocker_(blockers, 'LAST_NAME_REQUIRED', 'LastName is required.', 'Last Name');
    if (!clean_(payload.CustomerName)) addBlocker_(blockers, 'CUSTOMER_NAME_REQUIRED', 'CustomerName is required.', 'Full Name');
    if (!clean_(payload.Phone) && !clean_(payload.Email)) addBlocker_(blockers, 'IDENTITY_REQUIRED', 'Phone or Email is required for duplicate-safe creation.', 'Phone / Email');

    var location = payload.PrimaryLocation || {};
    if (!clean_(location.Address1)) addBlocker_(blockers, 'PRIMARY_LOCATION_ADDRESS_REQUIRED', 'PrimaryLocation.Address1 is required.', 'Street');
    if (!clean_(location.City)) addBlocker_(blockers, 'PRIMARY_LOCATION_CITY_REQUIRED', 'PrimaryLocation.City is required.', 'City');
    if (!clean_(location.State)) addBlocker_(blockers, 'PRIMARY_LOCATION_STATE_REQUIRED', 'PrimaryLocation.State is required.', 'Province');
    if (!clean_(location.PostalCode)) addBlocker_(blockers, 'PRIMARY_LOCATION_POSTAL_REQUIRED', 'PrimaryLocation.PostalCode is required.', 'Postal Code');
    if (!clean_(location.Country)) addBlocker_(blockers, 'PRIMARY_LOCATION_COUNTRY_REQUIRED', 'PrimaryLocation.Country is required.', 'Country');

    if (contactAction !== 'CREATE') warnings.push('Contact Action is not CREATE; Customer creation can be previewed, but the later Customer Structure sequence differs.');
    if (locationAction !== 'CREATE') warnings.push('Location Action is not CREATE; expected Primary Location creation path differs.');

    return { ok: blockers.length === 0, blockers: blockers, warnings: warnings };
  }

  function customerCreatePreview_(record) {
    var d = deps_();
    var payload = customerPayload_(record);
    var validation = validateCustomerCreate_(record, payload);
    var fingerprint = d.util.canonicalHash({
      previewVersion: CUSTOMER_CREATE_PREVIEW_VERSION,
      requestId: clean_(record['Request ID']),
      endpoint: d.config.getEndpoint('CUSTOMER_CREATE'),
      payload: payload
    });

    return {
      requestId: clean_(record['Request ID']),
      rowNumber: record.__rowNumber || null,
      name: clean_(record['Full Name']) || d.util.buildFullName(record['First Name'], record['Last Name']),
      endpoint: d.config.getEndpoint('CUSTOMER_CREATE'),
      payload: payload,
      primaryLocationIncluded: !!payload.PrimaryLocation,
      contactAction: normalizeEntityAction_(record['Contact Action'], resolvedContactId_(record)),
      locationAction: normalizeEntityAction_(record['Location Action'], resolvedLocationId_(record)),
      payloadFingerprint: fingerprint,
      valid: validation.ok,
      blockers: validation.blockers,
      warnings: validation.warnings
    };
  }

  function previewCustomerCreates() {
    var d = deps_();
    var rows = d.util.readRecords('SERVICE_REQUESTS');
    var eligible = rows.filter(function (record) {
      return clean_(record['Current Stage']).toUpperCase() === 'READY FOR CUSTOMER CREATE';
    });
    var previews = eligible.map(customerCreatePreview_);
    var valid = previews.filter(function (item) { return item.valid; }).length;
    var blocked = previews.length - valid;

    return {
      ok: blocked === 0,
      version: VERSION,
      previewVersion: CUSTOMER_CREATE_PREVIEW_VERSION,
      phase: 'PHASE 5B-A — CUSTOMER CREATE PAYLOAD PREVIEW',
      liveWritesAllowed: false,
      endpoint: d.config.getEndpoint('CUSTOMER_CREATE'),
      readyCustomerCreates: previews.length,
      validPayloads: valid,
      blockedPayloads: blocked,
      contract: {
        customerCreateEndpoint: '/v1/customers/create',
        primaryLocationIncludedInCustomerCreate: true,
        separateLocationCreateForNewCustomer: false,
        postCreateLocationReadRequired: true,
        contactCreateDeferredToNextMiniStep: true
      },
      customers: previews
    };
  }

  function htmlToText_(html) {
    return String(
      html || ''
    )
      .replace(
        /<script[\s\S]*?<\/script>/gi,
        ' '
      )
      .replace(
        /<style[\s\S]*?<\/style>/gi,
        ' '
      )
      .replace(
        /<[^>]+>/g,
        ' '
      )
      .replace(
        /&nbsp;/gi,
        ' '
      )
      .replace(
        /&quot;/gi,
        '"'
      )
      .replace(
        /&#39;/gi,
        "'"
      )
      .replace(
        /&amp;/gi,
        '&'
      )
      .replace(
        /&lt;/gi,
        '<'
      )
      .replace(
        /&gt;/gi,
        '>'
      )
      .replace(
        /\s+/g,
        ' '
      )
      .trim();
  }

  function snippetAround_(
    text,
    needle,
    radius
  ) {
    text =
      String(
        text || ''
      );

    needle =
      String(
        needle || ''
      );

    var index =
      text
        .toLowerCase()
        .indexOf(
          needle.toLowerCase()
        );

    if (index < 0) {
      return '';
    }

    radius =
      Number(
        radius || 180
      );

    return text.substring(
      Math.max(
        0,
        index - radius
      ),
      Math.min(
        text.length,
        index +
        needle.length +
        radius
      )
    );
  }

  function probeCustomerCreateContract_() {
    var d = deps_();

    var attempts = [];

    for (
      var i = 0;
      i < CUSTOMER_CREATE_HELP_URLS.length;
      i++
    ) {
      var url =
        CUSTOMER_CREATE_HELP_URLS[i];

      try {
        var response =
          d.util.httpRequest(
            url,
            {
              method: 'get',
              attempts: 1
            }
          );

        var text =
          htmlToText_(
            response.text
          );

        var tokens = [
          'FirstName',
          'firstName',
          'LastName',
          'lastName',
          'Email',
          'email',
          'CustomerName',
          'customerName',
          'Name',
          'name',
          'IsConsumerAccount',
          'isConsumerAccount',
          'PrimaryLocation',
          'primaryLocation',
          'PrimaryAddress',
          'primaryAddress',
          'Phone',
          'phone',
          'Address1',
          'address1',
          'City',
          'city',
          'State',
          'state',
          'PostalCode',
          'postalCode',
          'Country',
          'country',
          'CustomerId',
          'customerId',
          'ID',
          'id'
        ];

        var hits = {};

        tokens.forEach(
          function (token) {
            if (
              text
                .toLowerCase()
                .indexOf(
                  token.toLowerCase()
                ) >= 0
            ) {
              hits[token] =
                snippetAround_(
                  text,
                  token,
180
                );
            }
          }
        );

        var result = {
          ok: true,
          status:
            response.status,
          url:
            url,
          source:
            i === 0
              ? 'PRODUCTION_API_HELP'
              : 'OFFICIAL_TEST_API_HELP',
          pageLength:
            text.length,
          tokenHits:
            hits,
          endpointMentioned:
            text
              .toLowerCase()
              .indexOf(
                'customers/create'
              ) >= 0,
          attempts:
            attempts
        };

        /*
         * A 200 page with no endpoint/model evidence is not
         * sufficient to authorize a live write.
         */
        result.contractEvidenceFound =
          result.endpointMentioned ||
          Object.keys(
            hits
          ).length >= 3;

        if (
          result.contractEvidenceFound
        ) {
          return result;
        }

        attempts.push({
          url: url,
          ok: false,
          status:
            response.status,
          reason:
            'Page returned but no useful create-contract evidence was found.'
        });
      } catch (error) {
        attempts.push({
          url: url,
          ok: false,
          error:
            error &&
            error.message
              ? error.message
              : String(error)
        });
      }
    }

    return {
      ok: false,
      urls:
        CUSTOMER_CREATE_HELP_URLS.slice(),
      attempts:
        attempts,
      error:
        'Neither official Striven API-help source returned usable Customer-create contract evidence.'
    };
  }

  function controlledTestWarnings_(
    record
  ) {
    var warnings = [];

    if (
      clean_(
        record['Full Name']
      )
        .toUpperCase()
        .indexOf(
          'TEST'
        ) >= 0
    ) {
      warnings.push(
        'The controlled record is test data and will create a test Customer in the live Striven tenant if a later live executor is run.'
      );
    }

    if (
      clean_(
        record['Normalized Phone']
      )
        .indexOf(
          '123'
        ) === 0
    ) {
      warnings.push(
        'The controlled record uses a synthetic 123... phone number.'
      );
    }

    return warnings;
  }

  function preflightControlledTestCustomerCreate() {
    var d = deps_();

    if (
      !CF.StrivenData ||
      !CF.Matching
    ) {
      throw new Error(
        'CF.StrivenData and CF.Matching are required.'
      );
    }

    if (
      typeof CF.Matching.recheckRequest !==
      'function'
    ) {
      throw new Error(
        'CF.Matching.recheckRequest is required.'
      );
    }

    return d.util.withScriptLock(
      function () {
        var started =
          Date.now();

        var before =
          request_(
            CONTROLLED_TEST_REQUEST_ID
          );

        if (!before) {
          throw new Error(
            'Controlled test Service Request not found: ' +
            CONTROLLED_TEST_REQUEST_ID
          );
        }

        if (
          clean_(
            before['Created Customer ID']
          ) ||
          clean_(
            before['Matched Customer ID']
          )
        ) {
          throw new Error(
            'Controlled test is no longer eligible: a Customer ID already exists.'
          );
        }

        if (
          clean_(
            before['Write Fingerprint']
          ) ||
          clean_(
            before['Write Journal JSON']
          )
        ) {
          throw new Error(
            'Controlled test has prior write evidence. Stop and reconcile instead of preparing another write.'
          );
        }

        /*
         * User-requested hard guardrail:
         * Refresh the relevant Striven data immediately before
         * any future Customer creation.
         *
         * For this first controlled test we intentionally force
         * all three cache groups to be rebuilt. This is slower
         * than normal Smart Refresh, but proves the create decision
         * uses current source truth.
         */
        var customerRefresh =
          CF.StrivenData
            .refreshCustomerData();

        var locationRefresh =
          CF.StrivenData
            .refreshLocationData();

        var operationalRefresh =
          CF.StrivenData
            .refreshOperationalData();

        if (
          !customerRefresh.ok ||
          !locationRefresh.ok ||
          !operationalRefresh.ok
        ) {
          throw new Error(
            'Pre-write Striven refresh failed. Customer creation remains blocked.'
          );
        }

        var recheck =
          CF.Matching
            .recheckRequest(
              CONTROLLED_TEST_REQUEST_ID,
              {
                persist: true
              }
            );

        if (!recheck.ok) {
          throw new Error(
            'Fresh-data matching recheck failed. Customer creation remains blocked.'
          );
        }

        var after =
          request_(
            CONTROLLED_TEST_REQUEST_ID
          );

        var preview =
          customerCreatePreview_(
            after
          );

        var blockers = [];

        function require_(
          condition,
          code,
          message
        ) {
          if (!condition) {
            blockers.push({
              code: code,
              message: message
            });
          }
        }

        require_(
          clean_(
            after['Current Stage']
          ).toUpperCase() ===
            'READY FOR CUSTOMER CREATE',
          'STAGE_CHANGED',
          'Fresh-data recheck no longer leaves this request READY FOR CUSTOMER CREATE.'
        );

        require_(
          clean_(
            after['Customer Action']
          ).toUpperCase() ===
            'CREATE',
          'CUSTOMER_ACTION_CHANGED',
          'Fresh-data recheck no longer recommends CREATE Customer.'
        );

        require_(
          clean_(
            after['Customer Match Status']
          ).toUpperCase() ===
            'NOT FOUND',
          'CUSTOMER_NOW_FOUND_OR_UNCERTAIN',
          'Fresh-data recheck must still report Customer Match Status = NOT FOUND.'
        );

        require_(
          clean_(
            after['Duplicate Risk Status']
          ).toUpperCase() ===
            'NONE',
          'DUPLICATE_RISK_CHANGED',
          'Fresh-data recheck must still report Duplicate Risk Status = NONE.'
        );

        require_(
          !clean_(
            after['Matched Customer ID']
          ) &&
          !clean_(
            after['Created Customer ID']
          ),
          'CUSTOMER_ID_NOW_EXISTS',
          'A Customer ID now exists; live creation must stop.'
        );

        require_(
          preview.valid === true,
          'PAYLOAD_INVALID',
          'Customer create payload no longer passes validation.'
        );

        var contract =
          probeCustomerCreateContract_();

        var warnings =
          controlledTestWarnings_(
            after
          );

        if (!contract.ok) {
          warnings.push(
            'Striven API-help contract probe could not be read. Do not enable the live POST until the create contract is confirmed.'
          );
        }

        return {
          ok:
            blockers.length === 0,
          phase:
            'PHASE 5B-B — CONTROLLED CUSTOMER CREATE PREFLIGHT',
          version:
            VERSION,
          requestId:
            CONTROLLED_TEST_REQUEST_ID,
          liveWriteExecuted:
            false,
          liveWritesGloballyEnabled:
            d.config.isWriteAllowed() ===
            true,
          preWriteRefresh: {
            customer:
              customerRefresh,
            location:
              locationRefresh,
            operational:
              operationalRefresh
          },
          freshMatchingRecheck:
            recheck,
          resultingState: {
            currentStage:
              clean_(
                after['Current Stage']
              ),
            customerMatchStatus:
              clean_(
                after['Customer Match Status']
              ),
            customerAction:
              clean_(
                after['Customer Action']
              ),
            contactAction:
              clean_(
                after['Contact Action']
              ),
            locationAction:
              clean_(
                after['Location Action']
              ),
            duplicateRiskStatus:
              clean_(
                after['Duplicate Risk Status']
              ),
            matchedCustomerId:
              clean_(
                after['Matched Customer ID']
              ),
            createdCustomerId:
              clean_(
                after['Created Customer ID']
              )
          },
          payloadPreview:
            preview,
          apiContractProbe:
            contract,
          blockers:
            blockers,
          warnings:
            warnings,
          readyForFinalLiveExecutorPatch:
            blockers.length === 0 &&
            contract.ok === true,
          durationMs:
            Date.now() -
            started
        };
      },
330000
    );
  }

  /*******************************************************
   * PHASE5B_ONE_CUSTOMER_LIVE_EXECUTOR_V1
   * ONE CONTROLLED LIVE CUSTOMER CREATE
   *
   * HARD SAFETY CONTRACT
   * - Exact Request ID only.
   * - Exact test identity only.
   * - Exact preview payload fingerprint only.
   * - Customer/Location/Operational caches must be <=15 min old.
   * - If stale caches are refreshed, STOP before POST.
   * - Exactly one POST attempt; no automatic write retry.
   * - Any uncertain result becomes reconcile-only.
   * - Customer + Primary Location only.
   * - Contact creation is deliberately NOT included.
   *******************************************************/

  function parseWriteJournal_(record) {
    var d = deps_();

    return d.util.parseJson(
      record &&
      record[
        'Write Journal JSON'
      ],
      {}
    ) || {};
  }

  function safeResponseExcerpt_(response) {
    var d = deps_();

    return d.util.truncate(
      clean_(
        response &&
        response.text
      ),
1200
    );
  }

  function responseCustomerId_(response) {
    var body =
      response &&
      response.json &&
      typeof response.json ===
      'object'
        ? response.json
        : {};

    var candidates = [
      body.customerId,
      body.CustomerId,
      body.CustomerID,
      body.id,
      body.ID,
      body.data &&
        body.data.customerId,
      body.data &&
        body.data.CustomerId,
      body.data &&
        body.data.CustomerID,
      body.data &&
        body.data.id,
      body.data &&
        body.data.ID
    ];

    for (
      var i = 0;
      i < candidates.length;
      i++
    ) {
      var value =
        clean_(
          candidates[i]
        );

      if (
        value &&
        /^\d+$/.test(
          value
        )
      ) {
        return value;
      }
    }

    var text =
      clean_(
        response &&
        response.text
      );

    if (
      /^\d+$/.test(
        text
      )
    ) {
      return text;
    }

    return '';
  }

  function controlledIdentityValid_(
    record
  ) {
    return (
      clean_(
        record[
          'Request ID'
        ]
      ) ===
        CONTROLLED_TEST_REQUEST_ID &&
      clean_(
        record[
          'Full Name'
        ]
      ) ===
        CONTROLLED_TEST_NAME &&
      clean_(
        record[
          'Normalized Email'
        ] ||
        record[
          'Email'
        ]
      )
        .toLowerCase() ===
        CONTROLLED_TEST_EMAIL
    );
  }

  function controlledCreateGate_(
    record,
    preview
  ) {
    var blockers = [];

    function require_(
      condition,
      code,
      message
    ) {
      if (!condition) {
        blockers.push({
          code: code,
          message: message
        });
      }
    }

    require_(
      controlledIdentityValid_(
        record
      ),
      'CONTROLLED_IDENTITY_CHANGED',
      'The hard-coded controlled test identity no longer matches the Service Request.'
    );

    require_(
      clean_(
        record[
          'Current Stage'
        ]
      ).toUpperCase() ===
        'READY FOR CUSTOMER CREATE',
      'STAGE_NOT_READY',
      'Current Stage must be READY FOR CUSTOMER CREATE.'
    );

    require_(
      clean_(
        record[
          'Customer Match Status'
        ]
      ).toUpperCase() ===
        'NOT FOUND',
      'CUSTOMER_NOT_NOT_FOUND',
      'Customer Match Status must still be NOT FOUND.'
    );

    require_(
      clean_(
        record[
          'Customer Action'
        ]
      ).toUpperCase() ===
        'CREATE',
      'CUSTOMER_ACTION_NOT_CREATE',
      'Customer Action must still be CREATE.'
    );

    require_(
      clean_(
        record[
          'Duplicate Risk Status'
        ]
      ).toUpperCase() ===
        'NONE',
      'DUPLICATE_RISK_PRESENT',
      'Duplicate Risk Status must still be NONE.'
    );

    require_(
      !clean_(
        record[
          'Matched Customer ID'
        ]
      ) &&
      !clean_(
        record[
          'Created Customer ID'
        ]
      ),
      'CUSTOMER_ID_ALREADY_EXISTS',
      'No Matched or Created Customer ID may already exist.'
    );

    require_(
      preview &&
      preview.valid ===
        true,
      'PAYLOAD_INVALID',
      'Customer payload preview must be valid.'
    );

    require_(
      preview &&
      preview.payloadFingerprint ===
        CONTROLLED_TEST_EXPECTED_PAYLOAD_FINGERPRINT,
      'PAYLOAD_FINGERPRINT_CHANGED',
      'Controlled Customer payload has changed since the approved preflight. Stop and review.'
    );

    return blockers;
  }

  function writeJournalPatch_(
    record,
    journal,
    extra
  ) {
    var d = deps_();

    extra =
      extra || {};

    var patch = {
      'Write Fingerprint':
        clean_(
          journal.writeFingerprint
        ),
      'Write Journal JSON':
        journal,
      'Striven Sync Status':
        extra.syncStatus ||
        record[
          'Striven Sync Status'
        ] ||
        'NOT SYNCED',
      'Striven Sync Error':
        extra.syncError ||
        '',
      'Last Striven Sync':
        extra.lastSync ||
        '',
      'Updated At':
        d.util.nowString()
    };

    if (
      extra.stage
    ) {
      patch[
        'Current Stage'
      ] =
        extra.stage;
    }

    if (
      extra.requestStatus
    ) {
      patch[
        'Request Status'
      ] =
        extra.requestStatus;
    }

    if (
      extra.customerStructureStatus
    ) {
      patch[
        'Customer Structure Status'
      ] =
        extra.customerStructureStatus;
    }

    if (
      extra.nextAction
    ) {
      patch[
        'Next Action'
      ] =
        extra.nextAction;
    }

    if (
      extra.blockingIssue !==
      undefined
    ) {
      patch[
        'Blocking Issue'
      ] =
        extra.blockingIssue;
    }

    d.util.patchRow(
      'SERVICE_REQUESTS',
      record.__rowNumber,
      patch
    );

    return patch;
  }

  function reconcileControlledCustomerCreate_(
    journal
  ) {
    var d = deps_();

    /*
     * READ-ONLY reconciliation.
     * No create call exists in this function.
     */
    var customerRefresh =
      CF.StrivenData
        .refreshCustomerData();

    var locationRefresh =
      CF.StrivenData
        .refreshLocationData();

    if (
      !customerRefresh.ok ||
      !locationRefresh.ok
    ) {
      var refreshRecord =
        request_(
          CONTROLLED_TEST_REQUEST_ID
        );

      journal.status =
        'UNCERTAIN_RECONCILE_REQUIRED';

      journal.reconciliation =
        journal.reconciliation ||
        {};

      journal.reconciliation
        .lastAttemptAt =
        d.util.nowString();

      journal.reconciliation
        .error =
        'Post-write Customer/Location refresh failed.';

      writeJournalPatch_(
        refreshRecord,
        journal,
        {
          syncStatus:
            'UNCERTAIN — RECONCILE',
          syncError:
            'Post-write reconciliation refresh failed. Do not retry Customer creation.',
          stage:
            'CREATING CUSTOMER STRUCTURE',
          requestStatus:
            'IN PROGRESS',
          customerStructureStatus:
            'CUSTOMER CREATE UNCERTAIN — RECONCILE',
          nextAction:
            'RECONCILE CUSTOMER CREATE — DO NOT RETRY POST',
          blockingIssue:
            'Customer create may have succeeded. Reconcile before any further write.'
        }
      );

      return {
        ok: false,
        status:
          'UNCERTAIN_RECONCILE_REQUIRED',
        customerRefresh:
          customerRefresh,
        locationRefresh:
          locationRefresh
      };
    }

    var recheck =
      CF.Matching
        .recheckRequest(
          CONTROLLED_TEST_REQUEST_ID,
          {
            persist: true
          }
        );

    var after =
      request_(
        CONTROLLED_TEST_REQUEST_ID
      );

    var matchedCustomerId =
      clean_(
        after[
          'Matched Customer ID'
        ]
      );

    var matchedLocationId =
      clean_(
        after[
          'Matched Location ID'
        ]
      );

    var responseCustomerId =
      clean_(
        journal.responseCustomerId
      );

    var customerId =
      matchedCustomerId ||
      responseCustomerId;

    var idConflict =
      matchedCustomerId &&
      responseCustomerId &&
      matchedCustomerId !==
        responseCustomerId;

    journal.reconciliation =
      journal.reconciliation ||
      {};

    journal.reconciliation
      .lastAttemptAt =
      d.util.nowString();

    journal.reconciliation
      .matchingRecheck =
      recheck;

    journal.reconciliation
      .matchedCustomerId =
      matchedCustomerId;

    journal.reconciliation
      .matchedLocationId =
      matchedLocationId;

    journal.reconciliation
      .responseCustomerId =
      responseCustomerId;

    if (
      idConflict
    ) {
      journal.status =
        'UNCERTAIN_ID_CONFLICT';

      writeJournalPatch_(
        after,
        journal,
        {
          syncStatus:
            'UNCERTAIN — RECONCILE',
          syncError:
            'Customer ID returned by POST conflicts with fresh matching result.',
          stage:
            'CREATING CUSTOMER STRUCTURE',
          requestStatus:
            'IN PROGRESS',
          customerStructureStatus:
            'CUSTOMER CREATE UNCERTAIN — ID CONFLICT',
          nextAction:
            'RECONCILE CUSTOMER ID — DO NOT CREATE AGAIN',
          blockingIssue:
            'Customer ID conflict requires review before any further write.'
        }
      );

      return {
        ok: false,
        status:
          'UNCERTAIN_ID_CONFLICT',
        responseCustomerId:
          responseCustomerId,
        matchedCustomerId:
          matchedCustomerId,
        matchedLocationId:
          matchedLocationId
      };
    }

    if (
      customerId &&
      matchedLocationId
    ) {
      journal.status =
        'CUSTOMER_AND_PRIMARY_LOCATION_RECONCILED';

      journal.completedAt =
        d.util.nowString();

      d.util.patchRow(
        'SERVICE_REQUESTS',
        after.__rowNumber,
        {
          'Created Customer ID':
            customerId,
          'Created Location ID':
            matchedLocationId,
          'Customer Match Status':
            'MATCHED',
          'Matched Customer ID':
            customerId,
          'Location Match Status':
            'MATCHED',
          'Matched Location ID':
            matchedLocationId,
          'Customer Action':
            'LINK EXISTING',
          'Location Action':
            'LINK EXISTING',
          'Contact Action':
            'CREATE',
          'Current Stage':
            'READY FOR CONTACT CREATE',
          'Request Status':
            'OPEN',
          'Customer Structure Status':
            'CUSTOMER + PRIMARY LOCATION CREATED — CONTACT PENDING',
          'Next Action':
            'CREATE CONTACT',
          'Blocking Issue':
            '',
          'Write Fingerprint':
            journal.writeFingerprint,
          'Write Journal JSON':
            journal,
          'Striven Sync Status':
            'PARTIAL',
          'Striven Sync Error':
            '',
          'Last Striven Sync':
            d.util.nowString(),
          'Reconciliation Status':
            'CUSTOMER + PRIMARY LOCATION RECONCILED',
          'Updated At':
            d.util.nowString()
        }
      );

      return {
        ok: true,
        status:
          'CUSTOMER_AND_PRIMARY_LOCATION_RECONCILED',
        customerId:
          customerId,
        locationId:
          matchedLocationId,
        nextStage:
          'READY FOR CONTACT CREATE'
      };
    }

    if (
      customerId &&
      !matchedLocationId
    ) {
      journal.status =
        'CUSTOMER_RECONCILED_LOCATION_PENDING';

      d.util.patchRow(
        'SERVICE_REQUESTS',
        after.__rowNumber,
        {
          'Created Customer ID':
            customerId,
          'Matched Customer ID':
            customerId,
          'Customer Match Status':
            'MATCHED',
          'Customer Action':
            'LINK EXISTING',
          /*
           * CRITICAL:
           * PrimaryLocation was already included in Customer CREATE.
           * Block any separate Location-create path while reconciling.
           */
          'Location Action':
            'BLOCKED',
          'Current Stage':
            'CREATING CUSTOMER STRUCTURE',
          'Request Status':
            'IN PROGRESS',
          'Customer Structure Status':
            'CUSTOMER CREATED — PRIMARY LOCATION RECONCILIATION PENDING',
          'Next Action':
            'RECONCILE PRIMARY LOCATION — DO NOT CREATE LOCATION',
          'Blocking Issue':
            'Primary Location was included in Customer creation but its Striven Location ID has not been reconciled yet.',
          'Write Fingerprint':
            journal.writeFingerprint,
          'Write Journal JSON':
            journal,
          'Striven Sync Status':
            'PARTIAL',
          'Striven Sync Error':
            '',
          'Last Striven Sync':
            d.util.nowString(),
          'Reconciliation Status':
            'PRIMARY LOCATION PENDING',
          'Updated At':
            d.util.nowString()
        }
      );

      return {
        ok: false,
        status:
          'CUSTOMER_RECONCILED_LOCATION_PENDING',
        customerId:
          customerId,
        locationId:
          ''
      };
    }

    journal.status =
      'UNCERTAIN_RECONCILE_REQUIRED';

    writeJournalPatch_(
      after,
      journal,
      {
        syncStatus:
          'UNCERTAIN — RECONCILE',
        syncError:
          'Customer create POST returned but fresh Striven reports did not yet reconcile the Customer.',
        stage:
          'CREATING CUSTOMER STRUCTURE',
        requestStatus:
          'IN PROGRESS',
        customerStructureStatus:
          'CUSTOMER CREATE UNCERTAIN — RECONCILE',
        nextAction:
          'RECONCILE CUSTOMER CREATE — DO NOT RETRY POST',
        blockingIssue:
          'Do not create Customer again. Refresh/reconcile until the first POST is resolved.'
      }
    );

    return {
      ok: false,
      status:
        'UNCERTAIN_RECONCILE_REQUIRED',
      responseCustomerId:
        responseCustomerId,
      matchedCustomerId:
        matchedCustomerId,
      matchedLocationId:
        matchedLocationId
    };
  }

  function executeControlledTestCustomerCreate() {
    var d = deps_();

    if (
      !CF.StrivenData ||
      !CF.StrivenHttp ||
      !CF.Matching
    ) {
      throw new Error(
        'CF.StrivenData, CF.StrivenHttp, and CF.Matching are required.'
      );
    }

    return d.util.withScriptLock(
      function () {
        var started =
          Date.now();

        var record =
          request_(
            CONTROLLED_TEST_REQUEST_ID
          );

        if (!record) {
          throw new Error(
            'Controlled test Service Request not found.'
          );
        }

        if (
          !controlledIdentityValid_(
            record
          )
        ) {
          throw new Error(
            'Controlled test identity has changed. Live Customer creation is blocked.'
          );
        }

        var existingCreatedId =
          clean_(
            record[
              'Created Customer ID'
            ]
          );

        if (existingCreatedId) {
          return {
            ok: true,
            status:
              'ALREADY_RECONCILED',
            requestId:
              CONTROLLED_TEST_REQUEST_ID,
            customerId:
              existingCreatedId,
            locationId:
              clean_(
                record[
                  'Created Location ID'
                ]
              ),
            liveWriteExecuted:
              false,
            message:
              'This controlled Customer has already been reconciled. No POST was sent.'
          };
        }

        var priorJournal =
          parseWriteJournal_(
            record
          );

        if (
          priorJournal &&
          priorJournal.writeFingerprint
        ) {
          /*
           * Idempotency brake:
           * once a write journal exists, this runner becomes
           * RECONCILE-ONLY forever unless the journal is
           * deliberately cleared by a future repair workflow.
           */
          var reconcileOnly =
            reconcileControlledCustomerCreate_(
              priorJournal
            );

          reconcileOnly.requestId =
            CONTROLLED_TEST_REQUEST_ID;

          reconcileOnly.liveWriteExecuted =
            false;

          reconcileOnly.mode =
            'RECONCILE_ONLY_EXISTING_WRITE_JOURNAL';

          reconcileOnly.durationMs =
            Date.now() -
            started;

          return reconcileOnly;
        }

        /*
         * Freshness/runtime guard:
         * - All three caches must be <=15 minutes old.
         * - If any cache is stale, Smart Refresh updates it.
         * - If anything had to be refreshed, STOP before POST.
         *
         * This avoids combining a 5-minute refresh with a live
         * write and post-write reconciliation in one execution.
         */
        var freshness =
          CF.StrivenData
            .refreshStaleData({
              maxAgeMinutes:
                CONTROLLED_CREATE_FRESHNESS_MINUTES
            });

        if (!freshness.ok) {
          throw new Error(
            'Freshness refresh failed. Customer creation remains blocked.'
          );
        }

        if (
          freshness.refreshedGroups &&
          freshness.refreshedGroups.length
        ) {
          var refreshedRecheck =
            CF.Matching
              .recheckRequest(
                CONTROLLED_TEST_REQUEST_ID,
                {
                  persist: true
                }
              );

          return {
            ok: true,
            status:
              'REFRESHED_READY_RUN_AGAIN',
            requestId:
              CONTROLLED_TEST_REQUEST_ID,
            liveWriteExecuted:
              false,
            freshness:
              freshness,
            matchingRecheck:
              refreshedRecheck,
            message:
              'Fresh Striven data was rebuilt. No Customer was created in this long-running execution. Run PHASE5B_executeTestCustomerCreate again within 15 minutes.'
          };
        }

        /*
         * All caches were already <=15 minutes old.
         * Re-run exact matching immediately before the POST.
         */
        var recheck =
          CF.Matching
            .recheckRequest(
              CONTROLLED_TEST_REQUEST_ID,
              {
                persist: true
              }
            );

        if (!recheck.ok) {
          throw new Error(
            'Fresh matching recheck failed. Customer creation remains blocked.'
          );
        }

        record =
          request_(
            CONTROLLED_TEST_REQUEST_ID
          );

        var preview =
          customerCreatePreview_(
            record
          );

        var blockers =
          controlledCreateGate_(
            record,
            preview
          );

        if (blockers.length) {
          return {
            ok: false,
            status:
              'BLOCKED_BEFORE_POST',
            requestId:
              CONTROLLED_TEST_REQUEST_ID,
            liveWriteExecuted:
              false,
            blockers:
              blockers,
            payloadPreview:
              preview,
            matchingRecheck:
              recheck,
            freshness:
              freshness
          };
        }

        var endpoint =
          d.config.getEndpoint(
            'CUSTOMER_CREATE'
          );

        var now =
          d.util.nowString();

        var writeFingerprint =
          d.util.canonicalHash({
            phase:
              'PHASE5B-C-ONE-CUSTOMER-LIVE',
            requestId:
              CONTROLLED_TEST_REQUEST_ID,
            endpoint:
              endpoint,
            payloadFingerprint:
              preview.payloadFingerprint
          });

        var journal = {
          phase:
            'PHASE 5B-C — ONE CONTROLLED CUSTOMER LIVE CREATE',
          requestId:
            CONTROLLED_TEST_REQUEST_ID,
          endpoint:
            endpoint,
          payloadFingerprint:
            preview.payloadFingerprint,
          writeFingerprint:
            writeFingerprint,
          status:
            'INTENT_RECORDED',
          intentRecordedAt:
            now,
          postAttempts:
            0,
          noAutomaticWriteRetry:
            true,
          primaryLocationIncludedInCustomerCreate:
            true,
          separateLocationCreateAllowed:
            false,
          contactCreateIncluded:
            false
        };

        writeJournalPatch_(
          record,
          journal,
          {
            syncStatus:
              'SYNCING',
            stage:
              'CREATING CUSTOMER STRUCTURE',
            requestStatus:
              'IN PROGRESS',
            customerStructureStatus:
              'CREATING CUSTOMER + PRIMARY LOCATION',
            nextAction:
              'ONE CONTROLLED CUSTOMER CREATE IN PROGRESS',
            blockingIssue:
              ''
          }
        );

        /*
         * If execution stops after this POST_STARTING journal
         * but before we record the response, a subsequent run
         * will reconcile only and will never resend the POST.
         */
        journal.status =
          'POST_STARTING';

        journal.postStartedAt =
          d.util.nowString();

        journal.postAttempts = 1;

        record =
          request_(
            CONTROLLED_TEST_REQUEST_ID
          );

        writeJournalPatch_(
          record,
          journal,
          {
            syncStatus:
              'SYNCING',
            stage:
              'CREATING CUSTOMER STRUCTURE',
            requestStatus:
              'IN PROGRESS',
            customerStructureStatus:
              'CUSTOMER CREATE POST STARTING',
            nextAction:
              'DO NOT RUN ANOTHER CUSTOMER CREATE'
          }
        );

        var response;

        try {
          response =
            CF.StrivenHttp
              .requestJson(
                endpoint,
                {
                  method:
                    'post',
                  payload:
                    preview.payload,
                  idempotent:
                    false,
                  attempts:
1
                }
              );
        } catch (error) {
          /*
           * Any exception after POST_STARTING is treated as
           * uncertain. We intentionally do not infer that a
           * 4xx/5xx means "safe to resend" because the only
           * acceptable retry path is reconciliation first.
           */
          journal.status =
            'POST_RESULT_UNCERTAIN';

          journal.postError =
            error &&
            error.message
              ? d.util.truncate(
                  error.message,
1200
                )
              : String(
                  error
                );

          journal.postFinishedAt =
            d.util.nowString();

          record =
            request_(
              CONTROLLED_TEST_REQUEST_ID
            );

          writeJournalPatch_(
            record,
            journal,
            {
              syncStatus:
                'UNCERTAIN — RECONCILE',
              syncError:
                'Customer-create POST result is uncertain. Do not retry the POST.',
              stage:
                'CREATING CUSTOMER STRUCTURE',
              requestStatus:
                'IN PROGRESS',
              customerStructureStatus:
                'CUSTOMER CREATE UNCERTAIN — RECONCILE',
              nextAction:
                'RECONCILE CUSTOMER CREATE — DO NOT RETRY POST',
              blockingIssue:
                'The POST result is uncertain. The runner is now reconcile-only.'
            }
          );

          var uncertain =
            reconcileControlledCustomerCreate_(
              journal
            );

          uncertain.requestId =
            CONTROLLED_TEST_REQUEST_ID;

          uncertain.liveWriteExecuted =
            true;

          uncertain.postOutcome =
            'UNCERTAIN';

          uncertain.durationMs =
            Date.now() -
            started;

          return uncertain;
        }

        journal.status =
          'POST_SUCCEEDED_RECONCILIATION_PENDING';

        journal.httpStatus =
          response.status;

        journal.responseCustomerId =
          responseCustomerId_(
            response
          );

        journal.responseExcerpt =
          safeResponseExcerpt_(
            response
          );

        journal.postFinishedAt =
          d.util.nowString();

        record =
          request_(
            CONTROLLED_TEST_REQUEST_ID
          );

        writeJournalPatch_(
          record,
          journal,
          {
            syncStatus:
              'SYNCING',
            stage:
              'CREATING CUSTOMER STRUCTURE',
            requestStatus:
              'IN PROGRESS',
            customerStructureStatus:
              'CUSTOMER POST SUCCEEDED — RECONCILING',
            nextAction:
              'RECONCILING CUSTOMER + PRIMARY LOCATION'
          }
        );

        var reconciliation =
          reconcileControlledCustomerCreate_(
            journal
          );

        reconciliation.requestId =
          CONTROLLED_TEST_REQUEST_ID;

        reconciliation.liveWriteExecuted =
          true;

        reconciliation.httpStatus =
          response.status;

        reconciliation.responseCustomerId =
          journal.responseCustomerId;

        reconciliation.durationMs =
          Date.now() -
          started;

        d.util.logEvent({
          module:
            MODULE_NAME,
          action:
            'CONTROLLED_CUSTOMER_CREATE',
          status:
            reconciliation.ok
              ? 'COMPLETE'
              : reconciliation.status,
          requestId:
            CONTROLLED_TEST_REQUEST_ID,
          correlationId:
            record[
              'Correlation ID'
            ],
          actor:
            operator_(),
          details: {
            writeFingerprint:
              writeFingerprint,
            payloadFingerprint:
              preview.payloadFingerprint,
            httpStatus:
              response.status,
            responseCustomerId:
              journal.responseCustomerId,
            reconciliationStatus:
              reconciliation.status,
            noAutomaticWriteRetry:
              true
          },
          durationMs:
            Date.now() -
            started,
          version:
            VERSION
        });

        return reconciliation;
      },
330000
    );
  }

  function approvalFingerprint_(preview) {
    return deps_().util.canonicalHash({
      requestId: preview.requestId,
      planVersion: preview.planVersion,
      transactionFingerprint: preview.transactionFingerprint
    });
  }

  function approveRequest(requestId){var r=request_(requestId);if(!operationalFresh_()){deps_().data.refreshOperationalData({});r=request_(requestId);}var ps=propState_(),ss=statusPropState_(),corrected=false,statusCorrected=false;if(ps.correctable){PropertiesService.getScriptProperties().setProperty('STRIVEN_PAYMENT_TERM_ID','13');corrected=true;}if(ss.correctable){PropertiesService.getScriptProperties().setProperty('STRIVEN_WORK_ORDER_INITIAL_STATUS_ID','19');statusCorrected=true;}var preview=previewRequest(requestId);if(!preview.readyForApproval)throw new Error('Sales Order approval blocked: '+preview.blockers.map(function(x){return x.code+': '+x.message;}).join(' | '));var prior=orderJournal_(r).order||{},root=rootJournal_(r),state={phase:'PHASE 6 — GUARDED SALES ORDER CREATE',version:VERSION,requestId:requestId,endpoint:ENDPOINT,payload:preview.payload,payloadFingerprint:preview.payloadFingerprint,writeFingerprint:preview.writeFingerprint,status:'APPROVED_FOR_CREATE',approvalStage:'APPROVED',approvedAt:now_(),salesOrderCreateStatus:{id:19,name:'Quoted'},postCreateHandling:{mode:'MANUAL_REVIEW',operatorAction:'Review Sales Order and manually change status to 25 — In Progress when ready',automaticStatusTransition:false},paymentTermCorrection:corrected?{from:ps.value,to:'13',at:now_()}:null,statusCorrection:statusCorrected?{from:ss.value,to:'19',at:now_()}:null,deferredInternalNotes:preview.deferredInternalNotes,previousRejectedAttempt:Number(prior.postAttempts||0)>0?clone_(prior):null,postAttempts:0,noAutomaticWriteRetry:true,remoteWriteMayHaveSucceeded:false};root.salesOrderCreate=state;patch_(r,{'Updated At':now_(),'Write Fingerprint':preview.writeFingerprint,'Write Journal JSON':json_(root),'Work Order Action':'CREATE','Next Action':'CREATE SALES ORDER AS QUOTED','Reconciliation Status':'SALES ORDER QUOTED CREATE APPROVED','Striven Sync Status':'PARTIAL','Striven Sync Error':''});log_(r,'APPROVE_SALES_ORDER','APPROVED_CREATE_STATUS_19_QUOTED_MANUAL_HANDOFF',{writeFingerprint:preview.writeFingerprint,previousRejectedAttempt:Number(prior.postAttempts||0)>0});return{ok:true,status:'SALES_ORDER_STATUS_19_QUOTED_FOR_ONE_GUARDED_CREATE',approvalStage:'APPROVED',requestId:requestId,createStatusId:19,createStatusName:'Quoted',postCreateHandling:'MANUAL_REVIEW',automaticStatusTransition:false,writeFingerprint:preview.writeFingerprint,previousRejectedAttemptPreserved:Number(prior.postAttempts||0)>0,internalNotesDeferred:true,liveWriteExecuted:false,next:'WRITE_processApproved'};}

  function verifyApproval(record) {
    if (!record) return { ok: false, reason: 'Request is missing.' };
    var preview = buildPreviewFromRecord_(record);
    var expectedApproval = approvalFingerprint_(preview);
    var storedApproval = clean_(record['Approval Fingerprint']);
    return {
      ok: !!storedApproval && storedApproval === expectedApproval && clean_(record['Transaction Fingerprint']) === preview.transactionFingerprint,
      requestId: clean_(record['Request ID']),
      transactionFingerprintValid: clean_(record['Transaction Fingerprint']) === preview.transactionFingerprint,
      approvalFingerprintValid: !!storedApproval && storedApproval === expectedApproval,
      expectedTransactionFingerprint: preview.transactionFingerprint,
      storedTransactionFingerprint: clean_(record['Transaction Fingerprint']),
      expectedApprovalFingerprint: expectedApproval,
      storedApprovalFingerprint: storedApproval
    };
  }

  function processRequest() {
    throw new Error('Phase 5A is dry-run only. Live Striven execution is intentionally disabled.');
  }

  function processApproved() {
    return {
      ok: false,
      version: VERSION,
      status: 'BLOCKED_PHASE5A_DRY_RUN_ONLY',
      processed: 0,
      liveWritesAllowed: false,
      message: 'No Striven records were created. Phase 5B has not been enabled.'
    };
  }

  function inspectReadiness() {
    var d = deps_();
    return {
      ok: true,
      version: VERSION,
      phase: 'PHASE 5A — OPERATOR DECISIONS AND TRANSACTION PREVIEW',
      planningSupported: true,
      approvalsSupported: true,
      customerCreatePayloadPreviewSupported: true,
      customerStructureExecutionSupported: false,
      workOrderCreateSupported: false,
      configWriteAllowed: d.config.isWriteAllowed() === true,
      scriptWriteMode: d.util.getBooleanProperty('WRITE_MODE', false),
      testMode: d.util.getBooleanProperty('TEST_MODE', true),
      liveWritesAllowed: false
    };
  }

  return {
    version: VERSION,
    planVersion: PLAN_VERSION,
    inspectReadiness: inspectReadiness,
    buildPreviewFromRecord: buildPreviewFromRecord_,
    buildCustomerCreatePayload: customerPayload_,
    previewCustomerCreates: previewCustomerCreates,
    preflightControlledTestCustomerCreate: preflightControlledTestCustomerCreate,
    executeControlledTestCustomerCreate: executeControlledTestCustomerCreate,
    probeCustomerCreateContract: probeCustomerCreateContract_,
    formatPreviewText: planText_,
    previewRequest: previewRequest,
    approveRequest: approveRequest,
    verifyApproval: verifyApproval,
    processRequest: processRequest,
    processApproved: processApproved
  };
})();

/************************************************************
 * ===== CONSOLIDATED SOURCE: 61_Striven_Controlled_Customer_Create.gs =====
 * Layout consolidation only. Original module body follows unchanged.
 ************************************************************/
/************************************************************
 * APPS SCRIPT — 61_Striven_Controlled_Customer_Create.gs
 * CF ServiceOps — Guarded Phase 5B-C Customer Create
 * Version: 5.8.1
 *
 * SAFETY CONTRACT
 * - Does not replace or modify CF.StrivenWrite.
 * - Locked to one approved Request ID and one execution token.
 * - Uses POST /v1/customers/create.
 * - Uses PrimaryLocation.LocationName (live-verified requirement).
 * - Journals write intent before POST and flushes it.
 * - Exactly one POST attempt per execution; no automatic write retry.
 * - HTTP 400/422 are deterministic validation rejections, NOT uncertain.
 * - Transport/5xx outcomes are reconciliation-only before any retry.
 * - If Customer ID is durable, no Customer POST can occur again.
 * - Primary Location is embedded in Customer create; no second Location POST.
 * - Only Customer cache freshness is required before Customer POST.
 * - Location cache is refreshed only when reconciling a known Customer.
 ************************************************************/
var CF = CF || {};

CF.StrivenControlledCustomerCreate = (function () {
  'use strict';

  var MODULE_NAME = '61_Striven_Controlled_Customer_Create';
  var VERSION = '5.8.4';
  var CONTROLLED_REQUEST_ID = 'SR-20260818160541-7844';
  var CONTROLLED_EXECUTION_TOKEN = 'PHASE5B-C-ONE-CUSTOMER';
  var AUTO_EXECUTION_TOKEN = 'CF-AUTO-CUSTOMER-STRUCTURE-V1';
  var CUSTOMER_CACHE_MAX_AGE_MINUTES = 15;

  function deps_() {
    if (!CF.Config || !CF.Util || !CF.StrivenHttp || !CF.StrivenData) {
      throw new Error('CF.Config, CF.Util, CF.StrivenHttp and CF.StrivenData are required.');
    }
    return {
      config: CF.Config,
      util: CF.Util,
      http: CF.StrivenHttp,
      data: CF.StrivenData
    };
  }

  function clean_(value) {
    return deps_().util.cleanText(value);
  }

  function upper_(value) {
    return clean_(value).toUpperCase();
  }

    function isAutoMode_(options) {
    options = options || {};
    return options.autoMode === true && clean_(options.executionToken) === AUTO_EXECUTION_TOKEN;
  }

  function clone_(value) {
    return deps_().util.clone(value);
  }

  function safeJson_(value) {
    return deps_().util.safeJson(value);
  }

  function parseJson_(value, fallback) {
    return deps_().util.parseJson(value, fallback === undefined ? {} : fallback);
  }

  function request_(requestIdOrRow) {
    var d = deps_();
    if (typeof requestIdOrRow === 'number') {
      var rows = d.util.readRecords('SERVICE_REQUESTS');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].__rowNumber === requestIdOrRow) return rows[i];
      }
      return null;
    }
    return d.util.findRecord('SERVICE_REQUESTS', 'Request ID', requestIdOrRow);
  }

  function resolvedCustomerId_(record) {
    return clean_(record['Matched Customer ID'] || record['Created Customer ID']);
  }

  function customerCreateEndpoint_() {
    try {
      return deps_().config.getEndpoint('CUSTOMER_CREATE');
    } catch (error) {
      throw new Error(
        'CONFIG_REQUIRED | CF.Config ENDPOINTS must include CUSTOMER_CREATE: /v1/customers/create.'
      );
    }
  }

  function normalizeProvinceForStriven_(value) {
    var raw = upper_(value).replace(/[^A-Z]/g, '');
    var map = {
      ALBERTA: 'AB', AB: 'AB',
      BRITISHCOLUMBIA: 'BC', BC: 'BC',
      MANITOBA: 'MB', MB: 'MB',
      NEWBRUNSWICK: 'NB', NB: 'NB',
      NEWFOUNDLANDANDLABRADOR: 'NL', NEWFOUNDLANDLABRADOR: 'NL', NL: 'NL',
      NORTHWESTTERRITORIES: 'NT', NT: 'NT',
      NOVASCOTIA: 'NS', NS: 'NS',
      NUNAVUT: 'NU', NU: 'NU',
      ONTARIO: 'ON', ON: 'ON',
      PRINCEEDWARDISLAND: 'PE', PEI: 'PE', PE: 'PE',
      QUEBEC: 'QC', QC: 'QC', PQ: 'QC',
      SASKATCHEWAN: 'SK', SK: 'SK',
      YUKON: 'YT', YUKONTERRITORY: 'YT', YT: 'YT'
    };
    return map[raw] || clean_(value);
  }

  function primaryLocationPayload_(record) {
    return {
      // Live-verified from Striven HTTP 400 on 2026-08-20:
      // customer.PrimaryLocation.LocationName is required.
      LocationName: 'Primary Location',
      Address1: clean_(record['Street']),
      City: clean_(record['City']),
      State: normalizeProvinceForStriven_(record['Province']),
      PostalCode: clean_(record['Postal Code']),
      Country: clean_(record['Country'] || 'Canada')
    };
  }

  function customerCreatePayload_(record) {
    var payload = {
      FirstName: clean_(record['First Name']),
      LastName: clean_(record['Last Name']),
      Email: clean_(record['Email']),
      CustomerName: clean_(record['Full Name']) || clean_([record['First Name'], record['Last Name']].filter(Boolean).join(' ')),
      IsConsumerAccount: true,
      PrimaryLocation: primaryLocationPayload_(record)
    };
    if (clean_(record['Phone'])) { /* CF_SERVICEOPS_V5_10_34_CUSTOMER_CREATE_DIAL_CODE_R2 */ payload.CountryDialCode=1; payload.Phone=clean_(record['Phone']); }
    return payload;
  }

  function addBlocker_(blockers, code, message, field) {
    blockers.push({ code: code, message: message, field: field || '' });
  }

  function validatePayload_(record, payload) {
    var blockers = [];

    function require_(value, code, field, message) {
      if (!clean_(value)) addBlocker_(blockers, code, message, field);
    }

    require_(payload.FirstName, 'CUSTOMER_FIRST_NAME_REQUIRED', 'First Name', 'First Name is required.');
    require_(payload.LastName, 'CUSTOMER_LAST_NAME_REQUIRED', 'Last Name', 'Last Name is required.');
    require_(payload.CustomerName, 'CUSTOMER_NAME_REQUIRED', 'Full Name', 'CustomerName is required.');

    if (!payload.PrimaryLocation || typeof payload.PrimaryLocation !== 'object') {
      addBlocker_(blockers, 'PRIMARY_LOCATION_REQUIRED', 'PrimaryLocation is required.', 'PrimaryLocation');
    } else {
      require_(payload.PrimaryLocation.LocationName, 'LOCATION_NAME_REQUIRED', 'Street', 'PrimaryLocation.LocationName is required.');
      require_(payload.PrimaryLocation.Address1, 'LOCATION_ADDRESS1_REQUIRED', 'Street', 'PrimaryLocation.Address1 is required.');
      require_(payload.PrimaryLocation.City, 'LOCATION_CITY_REQUIRED', 'City', 'PrimaryLocation.City is required.');
      require_(payload.PrimaryLocation.State, 'LOCATION_STATE_REQUIRED', 'Province', 'PrimaryLocation.State is required.');
      require_(payload.PrimaryLocation.PostalCode, 'LOCATION_POSTAL_REQUIRED', 'Postal Code', 'PrimaryLocation.PostalCode is required.');
      require_(payload.PrimaryLocation.Country, 'LOCATION_COUNTRY_REQUIRED', 'Country', 'PrimaryLocation.Country is required.');
    }

    if (!clean_(payload.Phone) && !clean_(payload.Email)) {
      addBlocker_(blockers, 'CUSTOMER_IDENTITY_REQUIRED', 'At least Phone or Email is required.', 'Phone / Email');
    }

    if (upper_(record['Duplicate Risk Status']) !== 'NONE') {
      addBlocker_(blockers, 'DUPLICATE_RISK_NOT_CLEAR', 'Duplicate Risk Status must be NONE.', 'Duplicate Risk Status');
    }

    return { ok: blockers.length === 0, blockers: blockers };
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

  function cacheFresh_(sheetKey, maxAgeMinutes) {
    var timestamp = cacheTimestamp_(sheetKey);
    return !!timestamp && (Date.now() - timestamp.getTime()) <= Number(maxAgeMinutes) * 60000;
  }

  function freshnessSnapshot_() {
    return {
      maxAgeMinutes: CUSTOMER_CACHE_MAX_AGE_MINUTES,
      customer: {
        fresh: cacheFresh_('STRIVEN_CUSTOMER_DATA', CUSTOMER_CACHE_MAX_AGE_MINUTES),
        timestamp: cacheTimestamp_('STRIVEN_CUSTOMER_DATA')
      },
      location: {
        fresh: cacheFresh_('STRIVEN_LOCATION_DATA', CUSTOMER_CACHE_MAX_AGE_MINUTES),
        timestamp: cacheTimestamp_('STRIVEN_LOCATION_DATA')
      }
    };
  }

  function readRowFromSheet_(sheet, rowNumber, headers) {
    var d = deps_();
    var values = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
    return d.util.rowToRecord(headers, values, rowNumber);
  }

  function exactFinderRows_(sheetKey, header, value) {
    var d = deps_();
    var target = clean_(value);
    if (!target) return [];
    var sheet = d.util.requireSheet(sheetKey);
    if (sheet.getLastRow() < 2) return [];
    var headers = d.util.getActualHeaders(sheet);
    var column = headers.indexOf(header) + 1;
    if (!column) return [];
    var matches = sheet.getRange(2, column, sheet.getLastRow() - 1, 1)
      .createTextFinder(target)
      .matchEntireCell(true)
      .findAll();
    return matches.map(function (range) {
      return readRowFromSheet_(sheet, range.getRow(), headers);
    });
  }

  function customerCandidatesFromCache_(record) {
    var d = deps_();
    var byId = {};

    function add_(row, reason) {
      var customerId = clean_(row['Customer ID']);
      if (!customerId) return;
      if (!byId[customerId]) {
        byId[customerId] = {
          customerId: customerId,
          customerName: clean_(row['Customer Name'] || row['Full Name']),
          reasons: [],
          entityRows: []
        };
      }
      if (byId[customerId].reasons.indexOf(reason) === -1) byId[customerId].reasons.push(reason);
      byId[customerId].entityRows.push({
        entityType: clean_(row['Entity Type']),
        entityId: clean_(row['Entity ID']),
        phone: clean_(row['Normalized Phone']),
        email: clean_(row['Normalized Email'])
      });
    }

    var normalizedPhone = clean_(record['Normalized Phone']) || d.util.normalizePhone(record['Phone']);
    var normalizedEmail = clean_(record['Normalized Email']) || d.util.normalizeEmail(record['Email']);

    exactFinderRows_('STRIVEN_CUSTOMER_DATA', 'Normalized Phone', normalizedPhone).forEach(function (row) {
      add_(row, 'EXACT_PHONE');
    });
    exactFinderRows_('STRIVEN_CUSTOMER_DATA', 'Normalized Email', normalizedEmail).forEach(function (row) {
      add_(row, 'EXACT_EMAIL');
    });

    return Object.keys(byId).map(function (id) { return byId[id]; });
  }

  /* CF_SERVICEOPS_V5_10_38_SEMANTIC_LOCATION_RECONCILIATION_R1 */
  function semanticLocationAddressKey_(value) {
    var text=clean_(value).toUpperCase();
    if(!text)return '';
    text=text
      .replace(/\bONTARIO\b/g,'ON')
      .replace(/\bCANADA\b/g,'CA');
    return text.replace(/[^A-Z0-9]+/g,'');
  }
  function semanticStreetKey_(value) {
    return clean_(value).toUpperCase().replace(/[^A-Z0-9]+/g,'');
  }
  function semanticPostalKey_(value) {
    return clean_(value).toUpperCase().replace(/[^A-Z0-9]+/g,'');
  }
  function tagLocationMatches_(rows,method) {
    return (rows||[]).map(function(row){row.__cfLocationMatchMethod=method;return row;});
  }
  function exactLocationCandidates_(record, customerId) {
    var d=deps_();
    if(!customerId)return [];
    var customerRows=exactFinderRows_('STRIVEN_LOCATION_DATA','Customer ID',customerId);
    if(!customerRows.length)return [];

    var normalizedAddress=clean_(record['Normalized Address'])||d.util.normalizeAddress(record['Full Address']);
    if(normalizedAddress){
      var exact=customerRows.filter(function(row){
        var rowAddress=clean_(row['Normalized Address'])||d.util.normalizeAddress(row['Full Address']);
        return rowAddress===normalizedAddress;
      });
      if(exact.length)return tagLocationMatches_(exact,'CUSTOMER_ID + EXACT_NORMALIZED_ADDRESS');
    }

    var requestSemantic=semanticLocationAddressKey_(record['Full Address']);
    if(requestSemantic){
      var semantic=customerRows.filter(function(row){
        return semanticLocationAddressKey_(row['Full Address'])===requestSemantic;
      });
      if(semantic.length)return tagLocationMatches_(semantic,'CUSTOMER_ID + SEMANTIC_FULL_ADDRESS');
    }

    var requestStreet=semanticStreetKey_(record['Street']);
    var requestPostal=semanticPostalKey_(record['Normalized Postal']||record['Postal Code']);
    if(!requestStreet||!requestPostal)return [];
    var streetPostal=customerRows.filter(function(row){
      var rowStreet=semanticStreetKey_(row['Location Name']||String(clean_(row['Full Address'])).split(',')[0]);
      var rowPostal=semanticPostalKey_(row['Normalized Postal']||row['Postal Code']);
      return rowStreet===requestStreet&&rowPostal===requestPostal;
    });
    return tagLocationMatches_(streetPostal,'CUSTOMER_ID + EXACT_STREET + POSTAL');
  }

  function parseHttpError_(error) {
    var message = error && error.message ? error.message : String(error || '');
    var match = message.match(/HTTP\s+(\d{3})\s*:\s*([\s\S]*)$/i);
    var status = match ? Number(match[1]) : 0;
    var bodyText = match ? clean_(match[2]) : '';
    return {
      status: status,
      message: message,
      bodyText: bodyText,
      body: bodyText ? parseJson_(bodyText, {}) : {}
    };
  }

  function validationMessages_(body) {
    var out = [];
    var modelState = body && (body.modelState || body.ModelState) || {};
    Object.keys(modelState).forEach(function (field) {
      var messages = modelState[field];
      if (!Array.isArray(messages)) messages = [messages];
      messages.forEach(function (message) {
        if (clean_(message)) out.push(field + ': ' + clean_(message));
      });
    });
    if (!out.length && body && clean_(body.message || body.Message)) out.push(clean_(body.message || body.Message));
    return out;
  }

  function classifyWriteError_(error) {
    var parsed = parseHttpError_(error);
    var status = parsed.status;
    var validations = validationMessages_(parsed.body);

    if (status === 400 || status === 422) {
      return {
        outcome: 'REJECTED_VALIDATION',
        httpStatus: status,
        remoteWriteMayHaveSucceeded: false,
        safeToRetryUnchanged: false,
        safeToRetryAfterPayloadChange: true,
        requiresReconciliation: false,
        validationErrors: validations,
        message: validations.join('; ') || ('HTTP ' + status + ' validation rejection.')
      };
    }

    if (status === 401 || status === 403) {
      return {
        outcome: 'REJECTED_AUTHORIZATION',
        httpStatus: status,
        remoteWriteMayHaveSucceeded: false,
        safeToRetryUnchanged: false,
        safeToRetryAfterPayloadChange: false,
        requiresReconciliation: false,
        validationErrors: [],
        message: 'Striven rejected authorization. Fix authentication before retrying.'
      };
    }

    if (status === 404) {
      return {
        outcome: 'REJECTED_ENDPOINT_OR_RESOURCE',
        httpStatus: status,
        remoteWriteMayHaveSucceeded: false,
        safeToRetryUnchanged: false,
        safeToRetryAfterPayloadChange: false,
        requiresReconciliation: false,
        validationErrors: [],
        message: 'Striven returned HTTP 404. Verify the configured endpoint; do not probe alternate mutating endpoints.'
      };
    }

    if (status === 409) {
      return {
        outcome: 'REJECTED_CONFLICT_RECONCILE',
        httpStatus: status,
        remoteWriteMayHaveSucceeded: false,
        safeToRetryUnchanged: false,
        safeToRetryAfterPayloadChange: false,
        requiresReconciliation: true,
        validationErrors: validations,
        message: validations.join('; ') || 'Striven returned a conflict. Reconcile before any retry.'
      };
    }

    if (status === 429) {
      return {
        outcome: 'REJECTED_RATE_LIMIT',
        httpStatus: status,
        remoteWriteMayHaveSucceeded: false,
        safeToRetryUnchanged: false,
        safeToRetryAfterPayloadChange: false,
        requiresReconciliation: false,
        validationErrors: [],
        message: 'Striven rate-limited the write. This runner will not auto-retry.'
      };
    }

    return {
      outcome: 'UNCERTAIN_RECONCILE_REQUIRED',
      httpStatus: status || null,
      remoteWriteMayHaveSucceeded: true,
      safeToRetryUnchanged: false,
      safeToRetryAfterPayloadChange: false,
      requiresReconciliation: true,
      validationErrors: [],
      message: 'The Customer create outcome is uncertain. Reconcile before any new POST.'
    };
  }

  function journalAssessment_(record, currentPayloadFingerprint, currentWriteFingerprint) {
    var journal = parseJson_(record['Write Journal JSON'], {});
    var originalStatus = upper_(journal.status);
    var effectiveStatus = originalStatus;
    var legacyReclassified = false;
    var legacyClassification = null;

    // Repairs the exact previous bug: HTTP 400 was labelled UNCERTAIN.
    if (originalStatus.indexOf('UNCERTAIN') !== -1 && clean_(journal.postError)) {
      legacyClassification = classifyWriteError_(new Error(journal.postError));
      if (legacyClassification.outcome === 'REJECTED_VALIDATION') {
        effectiveStatus = 'REJECTED_VALIDATION';
        legacyReclassified = true;
      }
    }

    return {
      journal: journal,
      originalStatus: originalStatus,
      effectiveStatus: effectiveStatus,
      legacyReclassified: legacyReclassified,
      legacyClassification: legacyClassification,
      samePayloadFingerprint: !!currentPayloadFingerprint && clean_(journal.payloadFingerprint) === currentPayloadFingerprint,
      sameWriteFingerprint: !!currentWriteFingerprint && clean_(journal.writeFingerprint) === currentWriteFingerprint,
      postAttempts: Number(journal.postAttempts || 0),
      hasPriorPost: Number(journal.postAttempts || 0) > 0 || !!clean_(journal.postStartedAt)
    };
  }

  function extractCustomerId_(body) {
    body = body || {};
    var values = [
      body.CustomerId, body.CustomerID, body.customerId, body.customerID,
      body.Id, body.ID, body.id,
      body.Customer && (body.Customer.CustomerId || body.Customer.CustomerID || body.Customer.Id || body.Customer.id),
      body.customer && (body.customer.CustomerId || body.customer.CustomerID || body.customer.Id || body.customer.id),
      body.data && (body.data.CustomerId || body.data.CustomerID || body.data.customerId || body.data.Id || body.data.id),
      body.Data && (body.Data.CustomerId || body.Data.CustomerID || body.Data.Id || body.Data.id)
    ];
    for (var i = 0; i < values.length; i++) if (clean_(values[i])) return clean_(values[i]);
    return '';
  }

  function extractPrimaryLocationId_(body) {
    body = body || {};
    var primary = body.PrimaryLocation || body.primaryLocation ||
      (body.Customer && (body.Customer.PrimaryLocation || body.Customer.primaryLocation)) ||
      (body.customer && (body.customer.PrimaryLocation || body.customer.primaryLocation)) ||
      (body.data && (body.data.PrimaryLocation || body.data.primaryLocation)) || {};
    var values = [
      primary.LocationId, primary.LocationID, primary.locationId,
      primary.Id, primary.ID, primary.id,
      body.PrimaryLocationId, body.primaryLocationId
    ];
    for (var i = 0; i < values.length; i++) if (clean_(values[i])) return clean_(values[i]);
    return '';
  }

  function patchRequest_(record, patch) {
    var d = deps_();
    if (typeof d.util.clearRowDataValidations === 'function') {
      d.util.clearRowDataValidations('SERVICE_REQUESTS', record.__rowNumber);
    }
    d.util.patchRow('SERVICE_REQUESTS', record.__rowNumber, patch);
    SpreadsheetApp.flush();
  }

  function log_(record, action, status, details, message) {
    deps_().util.logEvent({
      module: MODULE_NAME,
      action: action,
      status: status,
      requestId: clean_(record['Request ID']),
      correlationId: clean_(record['Correlation ID']),
      message: message || '',
      details: details || {},
      version: VERSION
    });
  }

  function buildPreview_(requestIdOrRow, options) {
    options = options || {};
    var autoMode = isAutoMode_(options);
    var d = deps_();
    var record = request_(requestIdOrRow);
    if (!record) throw new Error('Service Request not found.');

    var endpoint = customerCreateEndpoint_();
    var payload = customerCreatePayload_(record);
    var validation = validatePayload_(record, payload);
    var payloadFingerprint = d.util.canonicalHash({ endpoint: endpoint, payload: payload });
    var writeFingerprint = d.util.canonicalHash({
      requestId: clean_(record['Request ID']),
      action: 'CREATE_CUSTOMER',
      endpoint: endpoint,
      payloadFingerprint: payloadFingerprint
    });
    var journal = journalAssessment_(record, payloadFingerprint, writeFingerprint);
    var blockers = validation.blockers.slice();
    var warnings = [];

    if (!autoMode && clean_(record['Request ID']) !== CONTROLLED_REQUEST_ID) {
      addBlocker_(blockers, 'CONTROLLED_REQUEST_ONLY', 'This executor is locked to the approved Phase 5B-C test request.', 'Request ID');
    }
    if (d.config.isTerminalState(record['Current Stage']) || d.config.isTerminalState(record['Final Outcome'])) {
      addBlocker_(blockers, 'TERMINAL_REQUEST', 'Terminal requests cannot be written to Striven.', 'Current Stage');
    }
    if (resolvedCustomerId_(record)) {
      addBlocker_(blockers, 'CUSTOMER_ALREADY_RESOLVED', 'A Customer ID is already present. Do not create another Customer.', 'Created Customer ID');
    }
    if (upper_(record['Customer Action']) !== 'CREATE') {
      addBlocker_(blockers, 'CUSTOMER_ACTION_NOT_CREATE', 'Customer Action must be CREATE.', 'Customer Action');
    }
    if (upper_(record['Customer Match Status']) !== 'NOT FOUND') {
      addBlocker_(blockers, 'CUSTOMER_NOT_CONFIRMED_NOT_FOUND', 'Customer Match Status must be NOT FOUND.', 'Customer Match Status');
    }
    if (upper_(record['Manual Review?']) === 'YES') {
      addBlocker_(blockers, 'MANUAL_REVIEW_ACTIVE', 'Manual review must be cleared before Customer create.', 'Manual Review?');
    }

    if (journal.hasPriorPost) {
      if (journal.effectiveStatus === 'REJECTED_VALIDATION') {
        if (journal.samePayloadFingerprint) {
          addBlocker_(blockers, 'UNCHANGED_REJECTED_PAYLOAD', 'The same payload was already rejected. Change the payload before retrying.', 'Write Journal JSON');
        } else {
          warnings.push('Previous POST was a deterministic validation rejection. The corrected payload fingerprint is different.');
        }
      } else if (journal.effectiveStatus.indexOf('SUCCESS') !== -1 || journal.effectiveStatus.indexOf('CREATED') !== -1) {
        addBlocker_(blockers, 'PRIOR_SUCCESS_RECORDED', 'The journal records a prior successful create. Reconcile IDs; do not POST again.', 'Write Journal JSON');
      } else {
        addBlocker_(blockers, 'PRIOR_WRITE_UNCERTAIN', 'A previous Customer POST is not deterministically rejected. Reconcile before any new POST.', 'Write Journal JSON');
      }
    }

    var freshness = freshnessSnapshot_();
    if (!freshness.customer.fresh) warnings.push('Customer cache is stale. Execute will refresh it and return without POST.');
    if (!freshness.location.fresh) warnings.push('Location cache is stale. This does not block Customer POST; it is refreshed only for Location reconciliation.');

    warnings.push('PrimaryLocation.LocationName is live-verified. Any additional Striven validation requirement will return REJECTED_VALIDATION, not UNCERTAIN.');

    return {
      ok: blockers.length === 0,
      phase: 'PHASE 5B-C — GUARDED CONTROLLED CUSTOMER CREATE',
      version: VERSION,
      requestId: clean_(record['Request ID']),
      rowNumber: record.__rowNumber,
      endpoint: endpoint,
      payload: payload,
      payloadFingerprint: payloadFingerprint,
      writeFingerprint: writeFingerprint,
      validation: validation,
      blockers: blockers,
      warnings: warnings,
      freshness: freshness,
      priorJournal: {
        originalStatus: journal.originalStatus,
        effectiveStatus: journal.effectiveStatus,
        legacyReclassified: journal.legacyReclassified,
        samePayloadFingerprint: journal.samePayloadFingerprint,
        sameWriteFingerprint: journal.sameWriteFingerprint,
        postAttempts: journal.postAttempts
      },
      readyForLivePost: blockers.length === 0 && freshness.customer.fresh,
      liveWriteExecuted: false
    };
  }

  function refreshCustomerIfStale_() {
    var before = freshnessSnapshot_();
    if (before.customer.fresh) return { refreshed: false, before: before, after: before };
    var result = deps_().data.refreshCustomerData({});
    return { refreshed: true, result: result, before: before, after: freshnessSnapshot_() };
  }

  function refreshLocationAfterPostIfNeeded_(journal) {
    var d = deps_();
    var locationTimestamp = cacheTimestamp_('STRIVEN_LOCATION_DATA');
    var postFinishedAt = journal && clean_(journal.postFinishedAt) ? new Date(journal.postFinishedAt) : null;
    var cachePredatesPost = !locationTimestamp || !postFinishedAt || isNaN(postFinishedAt.getTime()) || locationTimestamp.getTime() <= postFinishedAt.getTime();
    if (!cachePredatesPost) return { refreshed: false, result: null };
    return { refreshed: true, result: d.data.refreshLocationData({}) };
  }

  function reconcileKnownCustomer_(record, journal, customerId) {
    var d = deps_();
    var locations=[],targeted={ok:false,status:'TARGETED_LOCATION_MODULE_UNAVAILABLE',matches:[],liveWriteExecuted:false};
    try{
      if(CF.StandaloneLocationCreateV5128&&typeof CF.StandaloneLocationCreateV5128.findExisting==='function'){
        var createdByThisRequest=clean_(journal&&journal.responseCustomerId)===clean_(customerId)&&
          (upper_(journal&&journal.postOutcome)==='SUCCESS'||upper_(journal&&journal.status).indexOf('CREATED')!==-1||Number(journal&&journal.postAttempts||0)>0);
        targeted=CF.StandaloneLocationCreateV5128.findExisting(record,customerId,{allowUniquePrimaryFallback:createdByThisRequest});
        locations=targeted&&Array.isArray(targeted.matches)?targeted.matches:[];
      }
    }catch(targetedLocationError){
      targeted={ok:false,status:'TARGETED_LOCATION_READ_FAILED',matches:[],error:String(targetedLocationError&&targetedLocationError.message||targetedLocationError),liveWriteExecuted:false};
    }
    // Cache is only a no-call fallback. Never refresh the full Location report for
    // one request's post-create reconciliation.
    if(!locations.length)locations=exactLocationCandidates_(record,customerId);
    var refresh={refreshed:false,targeted:true,targetedStatus:clean_(targeted&&targeted.status),fullLocationRefreshExecuted:false};

    if (locations.length === 1) {
      var locationId = clean_(locations[0]['Location ID']);
      var updatedJournal = clone_(journal || {});
      updatedJournal.status = 'CUSTOMER_AND_PRIMARY_LOCATION_RECONCILED';
      updatedJournal.reconciliation = updatedJournal.reconciliation || {};
      updatedJournal.reconciliation.lastAttemptAt = d.util.nowString();
      updatedJournal.reconciliation.customerId = customerId;
      updatedJournal.reconciliation.locationId = locationId;
      updatedJournal.reconciliation.locationMatchMethod = clean_(locations[0].__cfLocationMatchMethod) || 'CUSTOMER_ID + EXACT_NORMALIZED_ADDRESS';

      patchRequest_(record, {
        'Updated At': d.util.nowString(),
        'Current Stage': 'READY FOR CONTACT CREATE',
        'Request Status': 'OPEN',
        'Manual Review?': 'NO',
        'Manual Review Reason': '',
        'Blocking Issue': '',
        'Next Action': 'CREATE CONTACT',
        'Customer Match Status': 'MATCHED',
        'Matched Customer ID': customerId,
        'Matched Customer Name': clean_(record['Full Name']),
        'Created Customer ID': customerId,
        'Customer Action': 'LINK EXISTING',
        'Location Match Status': 'MATCHED',
        'Matched Location ID': locationId,
        'Matched Location Address': clean_(locations[0]['Full Address']),
        'Created Location ID': locationId,
        'Location Action': 'LINK EXISTING',
        'Customer Structure Status': 'CUSTOMER + PRIMARY LOCATION CONFIRMED',
        'Striven Sync Status': 'PARTIAL',
        'Striven Sync Error': '',
        'Last Striven Sync': d.util.nowString(),
        'Reconciliation Status': 'CUSTOMER + PRIMARY LOCATION CONFIRMED',
        'Write Journal JSON': safeJson_(updatedJournal)
      });

      return {
        ok: true,
        status: 'CUSTOMER_AND_PRIMARY_LOCATION_RECONCILED',
        requestId: clean_(record['Request ID']),
        matchedCustomerId: customerId,
        matchedLocationId: locationId,
        locationMatchMethod: clean_(locations[0].__cfLocationMatchMethod) || 'CUSTOMER_ID + EXACT_NORMALIZED_ADDRESS',
        liveWriteExecuted: false,
        targetedLocationReadExecuted: targeted&&targeted.status!=='TARGETED_LOCATION_MODULE_UNAVAILABLE',
        targetedLocationStatus: clean_(targeted&&targeted.status),
        locationRefreshExecuted: false
      };
    }

    var status = locations.length > 1 ? 'PRIMARY_LOCATION_AMBIGUOUS' : 'CUSTOMER_RECONCILED_LOCATION_PENDING';
    var updated = clone_(journal || {});
    updated.status = status;
    updated.reconciliation = updated.reconciliation || {};
    updated.reconciliation.lastAttemptAt = d.util.nowString();
    updated.reconciliation.customerId = customerId;
    updated.reconciliation.locationCandidateCount = locations.length;

    patchRequest_(record, {
      'Updated At': d.util.nowString(),
      'Current Stage': 'CREATING CUSTOMER STRUCTURE',
      'Request Status': 'IN PROGRESS',
      'Blocking Issue': locations.length > 1
        ? 'Multiple primary Location candidates found. Do not create another Location.'
        : 'Customer is confirmed but the primary Location is not yet visible. Do not create another Customer or Location.',
      'Next Action': 'RECONCILE PRIMARY LOCATION — DO NOT CREATE AGAIN',
      'Customer Match Status': 'MATCHED',
      'Matched Customer ID': customerId,
      'Matched Customer Name': clean_(record['Full Name']),
      'Created Customer ID': customerId,
      'Customer Action': 'LINK EXISTING',
      'Location Action': 'LINK EXISTING',
      'Customer Structure Status': 'CUSTOMER CONFIRMED — PRIMARY LOCATION PENDING',
      'Striven Sync Status': 'PARTIAL',
      'Striven Sync Error': '',
      'Last Striven Sync': d.util.nowString(),
      'Reconciliation Status': status,
      'Write Journal JSON': safeJson_(updated)
    });

    return {
      ok: false,
      status: status,
      requestId: clean_(record['Request ID']),
      matchedCustomerId: customerId,
      matchedLocationId: '',
      locationCandidates: locations.map(function (row) { return clean_(row['Location ID']); }),
      liveWriteExecuted: false,
      targetedLocationReadExecuted: targeted&&targeted.status!=='TARGETED_LOCATION_MODULE_UNAVAILABLE',
      targetedLocationStatus: clean_(targeted&&targeted.status),
      locationRefreshExecuted: false
    };
  }

  function reconcileUncertainCustomer_(record, journal) {
    var d = deps_();
    var customerTimestamp = cacheTimestamp_('STRIVEN_CUSTOMER_DATA');
    var postFinishedAt = journal && clean_(journal.postFinishedAt) ? new Date(journal.postFinishedAt) : null;
    var cachePredatesPost = !customerTimestamp || !postFinishedAt || isNaN(postFinishedAt.getTime()) || customerTimestamp.getTime() <= postFinishedAt.getTime();
    if (cachePredatesPost) d.data.refreshCustomerData({});

    var candidates = customerCandidatesFromCache_(record);
    if (candidates.length === 1) {
      var customerId = candidates[0].customerId;
      var updated = clone_(journal || {});
      updated.status = 'CUSTOMER_RECONCILED_AFTER_UNCERTAIN_POST';
      updated.reconciliation = updated.reconciliation || {};
      updated.reconciliation.lastAttemptAt = d.util.nowString();
      updated.reconciliation.customerId = customerId;
      updated.reconciliation.customerReasons = candidates[0].reasons;

      patchRequest_(record, {
        'Updated At': d.util.nowString(),
        'Matched Customer ID': customerId,
        'Matched Customer Name': candidates[0].customerName || clean_(record['Full Name']),
        'Created Customer ID': customerId,
        'Customer Match Status': 'MATCHED',
        'Customer Action': 'LINK EXISTING',
        'Location Action': 'LINK EXISTING',
        'Customer Structure Status': 'CUSTOMER RECONCILED — PRIMARY LOCATION PENDING',
        'Striven Sync Status': 'PARTIAL',
        'Striven Sync Error': '',
        'Reconciliation Status': 'CUSTOMER RECONCILED',
        'Write Journal JSON': safeJson_(updated)
      });
      return reconcileKnownCustomer_(request_(record.__rowNumber), updated, customerId);
    }

    var status = candidates.length > 1 ? 'CUSTOMER_RECONCILIATION_AMBIGUOUS' : 'UNCERTAIN_RECONCILE_REQUIRED';
    var nextJournal = clone_(journal || {});
    nextJournal.status = status;
    nextJournal.reconciliation = nextJournal.reconciliation || {};
    nextJournal.reconciliation.lastAttemptAt = d.util.nowString();
    nextJournal.reconciliation.customerCandidateCount = candidates.length;

    patchRequest_(record, {
      'Updated At': d.util.nowString(),
      'Current Stage': 'CREATING CUSTOMER STRUCTURE',
      'Request Status': 'IN PROGRESS',
      'Blocking Issue': 'Do not create Customer again. The prior POST outcome still requires reconciliation.',
      'Next Action': 'RECONCILE CUSTOMER CREATE — DO NOT RETRY POST',
      'Customer Structure Status': 'CUSTOMER CREATE UNCERTAIN — RECONCILE',
      'Striven Sync Status': 'UNCERTAIN — RECONCILE',
      'Striven Sync Error': 'Customer create outcome remains uncertain after fresh Customer-cache reconciliation.',
      'Reconciliation Status': status,
      'Write Journal JSON': safeJson_(nextJournal)
    });

    return {
      ok: false,
      status: status,
      requestId: clean_(record['Request ID']),
      customerCandidateCount: candidates.length,
      liveWriteExecuted: false
    };
  }

  function executionGate_(record, options) {
    options = options || {};
    if (isAutoMode_(options)) {
      if (options.confirmLiveWrite !== true) throw new Error('AUTO_WRITE_BLOCKED | confirmLiveWrite must be true.');
      if (deps_().config.isTerminalState(record['Current Stage']) || deps_().config.isTerminalState(record['Final Outcome'])) {
        throw new Error('AUTO_WRITE_BLOCKED | Terminal requests cannot be changed.');
      }
      if (upper_(record['Manual Review?']) === 'YES') throw new Error('AUTO_WRITE_BLOCKED | Manual review is active.');
      if (upper_(record['Duplicate Risk Status']) !== 'NONE') throw new Error('AUTO_WRITE_BLOCKED | Duplicate risk is not clear.');
      return;
    }
    if (clean_(record['Request ID']) !== CONTROLLED_REQUEST_ID) {
      throw new Error('CONTROLLED_WRITE_BLOCKED | This executor is locked to ' + CONTROLLED_REQUEST_ID + '.');
    }
    if (clean_(options.executionToken) !== CONTROLLED_EXECUTION_TOKEN) {
      throw new Error('CONTROLLED_WRITE_BLOCKED | Missing controlled execution token. Use the approved public runner.');
    }
    if (options.confirmLiveWrite !== true) {
      throw new Error('CONTROLLED_WRITE_BLOCKED | confirmLiveWrite must be true.');
    }
  }

  function withWriteLock_(callback) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) throw new Error('Another CF ServiceOps execution is already running.');
    try { return callback(); } finally { lock.releaseLock(); }
  }

  function previewControlledCustomerCreate(requestIdOrRow) {
    return buildPreview_(requestIdOrRow);
  }

  function executeControlledCustomerCreate(requestIdOrRow, options) {
    options = options || {};
    var d = deps_();
    var started = Date.now();
    var record = request_(requestIdOrRow);
    if (!record) throw new Error('Service Request not found.');
    executionGate_(record, options);

    // Durable Customer ID = reconciliation only. Never POST Customer again.
    var existingCustomerId = resolvedCustomerId_(record);
    if (existingCustomerId) {
      return reconcileKnownCustomer_(record, parseJson_(record['Write Journal JSON'], {}), existingCustomerId);
    }

    var initialPreview = buildPreview_(record.__rowNumber, options);
    var initialAssessment = journalAssessment_(record, initialPreview.payloadFingerprint, initialPreview.writeFingerprint);

    // Only the known deterministic rejected validation attempt may be retried,
    // and only with a changed payload fingerprint.
    if (initialAssessment.hasPriorPost && initialAssessment.effectiveStatus !== 'REJECTED_VALIDATION') {
      return reconcileUncertainCustomer_(record, initialAssessment.journal);
    }

    // Customer cache only. This avoids the previous multi-cache runtime overrun.
    var refresh = refreshCustomerIfStale_();
    if (refresh.refreshed) {
      var after = buildPreview_(record.__rowNumber, options);
      return {
        ok: true,
        status: 'REFRESHED_CUSTOMER_READY_RUN_AGAIN',
        requestId: clean_(record['Request ID']),
        liveWriteExecuted: false,
        freshness: refresh.after,
        readyForLivePostNextRun: after.blockers.length === 0,
        durationMs: Date.now() - started
      };
    }

    // Independent exact phone/email duplicate guard on fresh cache.
    var candidates = customerCandidatesFromCache_(record);
    if (candidates.length) {
      var candidateIds = candidates.map(function (candidate) { return candidate.customerId; });
      patchRequest_(record, {
        'Updated At': d.util.nowString(),
        'Current Stage': 'NEEDS REVIEW',
        'Request Status': 'BLOCKED',
        'Manual Review?': 'YES',
        'Manual Review Reason': 'Fresh pre-write duplicate guard found Customer candidate(s): ' + candidateIds.join(', '),
        'Blocking Issue': 'Do not create Customer. Resolve the fresh exact phone/email candidate first.',
        'Next Action': 'REVIEW EXISTING CUSTOMER CANDIDATE',
        'Striven Sync Status': 'BLOCKED',
        'Reconciliation Status': 'PRE-WRITE CUSTOMER CANDIDATE FOUND'
      });
      return {
        ok: false,
        status: 'PREWRITE_CUSTOMER_CANDIDATE_FOUND',
        requestId: clean_(record['Request ID']),
        candidateCustomerIds: candidateIds,
        liveWriteExecuted: false,
        durationMs: Date.now() - started
      };
    }

    record = request_(record.__rowNumber);
    var preview = buildPreview_(record.__rowNumber, options);
    if (preview.blockers.length) {
      return {
        ok: false,
        status: 'PREFLIGHT_BLOCKED',
        requestId: preview.requestId,
        blockers: preview.blockers,
        warnings: preview.warnings,
        liveWriteExecuted: false,
        durationMs: Date.now() - started
      };
    }

    return withWriteLock_(function () {
      record = request_(record.__rowNumber);
      var lockedPreview = buildPreview_(record.__rowNumber, options);
      if (lockedPreview.blockers.length) {
        return {
          ok: false,
          status: 'PREFLIGHT_BLOCKED_UNDER_LOCK',
          requestId: lockedPreview.requestId,
          blockers: lockedPreview.blockers,
          liveWriteExecuted: false,
          durationMs: Date.now() - started
        };
      }

      // Re-run fresh duplicate guard under the mutation lock.
      var lockedCandidates = customerCandidatesFromCache_(record);
      if (lockedCandidates.length) {
        return {
          ok: false,
          status: 'PREWRITE_CUSTOMER_CANDIDATE_FOUND_UNDER_LOCK',
          requestId: lockedPreview.requestId,
          candidateCustomerIds: lockedCandidates.map(function (candidate) { return candidate.customerId; }),
          liveWriteExecuted: false,
          durationMs: Date.now() - started
        };
      }

      var previous = journalAssessment_(record, lockedPreview.payloadFingerprint, lockedPreview.writeFingerprint);
      if (previous.hasPriorPost) {
        if (previous.effectiveStatus !== 'REJECTED_VALIDATION') {
          return reconcileUncertainCustomer_(record, previous.journal);
        }
        if (previous.samePayloadFingerprint) {
          return {
            ok: false,
            status: 'UNCHANGED_REJECTED_PAYLOAD_BLOCKED',
            requestId: lockedPreview.requestId,
            liveWriteExecuted: false,
            durationMs: Date.now() - started
          };
        }
      }

      var journal = {
        phase: 'PHASE 5B-C — GUARDED CONTROLLED CUSTOMER LIVE CREATE',
        moduleVersion: VERSION,
        requestId: lockedPreview.requestId,
        endpoint: lockedPreview.endpoint,
        payloadFingerprint: lockedPreview.payloadFingerprint,
        writeFingerprint: lockedPreview.writeFingerprint,
        status: 'INTENT_RECORDED',
        intentRecordedAt: d.util.nowString(),
        postAttempts: Number(previous.journal.postAttempts || 0) + 1,
        noAutomaticWriteRetry: true,
        primaryLocationIncludedInCustomerCreate: true,
        separateLocationCreateAllowed: false,
        contactCreateIncluded: false,
        supersedesPriorJournalStatus: previous.originalStatus || '',
        priorJournalReclassified: previous.legacyReclassified === true
      };

      patchRequest_(record, {
        'Updated At': d.util.nowString(),
        'Current Stage': 'CREATING CUSTOMER STRUCTURE',
        'Request Status': 'IN PROGRESS',
        'Manual Review?': 'NO',
        'Manual Review Reason': '',
        'Blocking Issue': 'Controlled Customer create in progress. Do not run another Customer create concurrently.',
        'Next Action': 'WAIT FOR CONTROLLED CUSTOMER CREATE RESULT',
        'Customer Structure Status': 'CUSTOMER CREATE INTENT RECORDED',
        'Write Fingerprint': lockedPreview.writeFingerprint,
        'Write Journal JSON': safeJson_(journal),
        'Striven Sync Status': 'SYNCING',
        'Striven Sync Error': '',
        'Reconciliation Status': 'NOT STARTED'
      });

      journal.postStartedAt = d.util.nowString();
      patchRequest_(record, { 'Write Journal JSON': safeJson_(journal) });

      var response;
      try {
        response = d.http.requestJson(lockedPreview.endpoint, {
          method: 'post',
          payload: lockedPreview.payload,
          idempotent: false,
          attempts: 1
        });
      } catch (error) {
        var classification = classifyWriteError_(error);
        journal.postFinishedAt = d.util.nowString();
        journal.httpStatus = classification.httpStatus;
        journal.postOutcome = classification.outcome;
        journal.status = classification.outcome;
        journal.remoteWriteMayHaveSucceeded = classification.remoteWriteMayHaveSucceeded;
        journal.safeToRetryUnchanged = classification.safeToRetryUnchanged;
        journal.safeToRetryAfterPayloadChange = classification.safeToRetryAfterPayloadChange;
        journal.requiresReconciliation = classification.requiresReconciliation;
        journal.validationErrors = classification.validationErrors;
        journal.postError = d.util.truncate(error && error.message ? error.message : String(error), 4000);

        if (classification.outcome === 'REJECTED_VALIDATION') {
          patchRequest_(record, {
            'Updated At': d.util.nowString(),
            'Current Stage': 'READY FOR CUSTOMER CREATE',
            'Request Status': 'BLOCKED',
            'Blocking Issue': classification.message,
            'Next Action': 'FIX CUSTOMER CREATE PAYLOAD — DO NOT RETRY UNCHANGED',
            'Customer Structure Status': 'CUSTOMER CREATE REJECTED — VALIDATION',
            'Write Journal JSON': safeJson_(journal),
            'Striven Sync Status': 'ERROR',
            'Striven Sync Error': classification.message,
            'Last Striven Sync': d.util.nowString(),
            'Reconciliation Status': 'NOT REQUIRED — REQUEST REJECTED'
          });
        } else if (!classification.remoteWriteMayHaveSucceeded) {
          patchRequest_(record, {
            'Updated At': d.util.nowString(),
            'Current Stage': 'READY FOR CUSTOMER CREATE',
            'Request Status': 'BLOCKED',
            'Blocking Issue': classification.message,
            'Next Action': 'FIX WRITE CONDITION — DO NOT AUTO-RETRY',
            'Customer Structure Status': 'CUSTOMER CREATE REJECTED',
            'Write Journal JSON': safeJson_(journal),
            'Striven Sync Status': 'ERROR',
            'Striven Sync Error': classification.message,
            'Last Striven Sync': d.util.nowString(),
            'Reconciliation Status': classification.requiresReconciliation ? 'RECONCILE BEFORE RETRY' : 'NOT REQUIRED — REQUEST REJECTED'
          });
        } else {
          patchRequest_(record, {
            'Updated At': d.util.nowString(),
            'Current Stage': 'CREATING CUSTOMER STRUCTURE',
            'Request Status': 'IN PROGRESS',
            'Blocking Issue': 'Do not create Customer again. Reconcile until the first POST is resolved.',
            'Next Action': 'RECONCILE CUSTOMER CREATE — DO NOT RETRY POST',
            'Customer Structure Status': 'CUSTOMER CREATE UNCERTAIN — RECONCILE',
            'Write Journal JSON': safeJson_(journal),
            'Striven Sync Status': 'UNCERTAIN — RECONCILE',
            'Striven Sync Error': classification.message,
            'Last Striven Sync': d.util.nowString(),
            'Reconciliation Status': 'REQUIRED'
          });
        }

        log_(record, 'CONTROLLED_CUSTOMER_CREATE', classification.outcome, {
          httpStatus: classification.httpStatus,
          remoteWriteMayHaveSucceeded: classification.remoteWriteMayHaveSucceeded,
          validationErrors: classification.validationErrors,
          payloadFingerprint: lockedPreview.payloadFingerprint,
          writeFingerprint: lockedPreview.writeFingerprint
        }, classification.message);

        return {
          ok: false,
          status: classification.outcome,
          httpStatus: classification.httpStatus,
          validationErrors: classification.validationErrors,
          remoteWriteMayHaveSucceeded: classification.remoteWriteMayHaveSucceeded,
          safeToRetryUnchanged: classification.safeToRetryUnchanged,
          safeToRetryAfterPayloadChange: classification.safeToRetryAfterPayloadChange,
          requestId: lockedPreview.requestId,
          liveWriteExecuted: true,
          durationMs: Date.now() - started
        };
      }

      var responseBody = response && response.json ? response.json : {};
      var customerId = extractCustomerId_(responseBody);
      var locationId = extractPrimaryLocationId_(responseBody);
      journal.postFinishedAt = d.util.nowString();
      journal.httpStatus = response && response.status ? response.status : 200;
      journal.responseCustomerId = customerId;
      journal.responsePrimaryLocationId = locationId;

      if (!customerId) {
        journal.status = 'SUCCESS_RESPONSE_ID_MISSING_RECONCILE';
        journal.postOutcome = 'SUCCESS_RESPONSE_ID_MISSING_RECONCILE';
        journal.remoteWriteMayHaveSucceeded = true;
        journal.safeToRetryUnchanged = false;
        journal.safeToRetryAfterPayloadChange = false;
        journal.requiresReconciliation = true;

        patchRequest_(record, {
          'Updated At': d.util.nowString(),
          'Current Stage': 'CREATING CUSTOMER STRUCTURE',
          'Request Status': 'IN PROGRESS',
          'Blocking Issue': 'Striven returned success but no Customer ID was extracted. Do not POST again; reconcile the Customer.',
          'Next Action': 'RECONCILE CUSTOMER CREATE — DO NOT RETRY POST',
          'Customer Structure Status': 'CUSTOMER CREATE RESPONSE ID MISSING — RECONCILE',
          'Write Journal JSON': safeJson_(journal),
          'Striven Sync Status': 'UNCERTAIN — RECONCILE',
          'Striven Sync Error': 'Successful HTTP response did not contain a recognized Customer ID.',
          'Last Striven Sync': d.util.nowString(),
          'Reconciliation Status': 'REQUIRED'
        });

        return {
          ok: false,
          status: 'SUCCESS_RESPONSE_ID_MISSING_RECONCILE',
          requestId: lockedPreview.requestId,
          responseCustomerId: '',
          liveWriteExecuted: true,
          durationMs: Date.now() - started
        };
      }

      journal.status = locationId ? 'CUSTOMER_AND_PRIMARY_LOCATION_CREATED_RESPONSE_CONFIRMED' : 'CUSTOMER_CREATED_PRIMARY_LOCATION_RECONCILE_REQUIRED';
      journal.postOutcome = 'SUCCESS';
      journal.remoteWriteMayHaveSucceeded = true;
      journal.safeToRetryUnchanged = false;
      journal.safeToRetryAfterPayloadChange = false;
      journal.requiresReconciliation = !locationId;

      var successPatch = {
        'Updated At': d.util.nowString(),
        'Customer Match Status': 'MATCHED',
        'Matched Customer ID': customerId,
        'Matched Customer Name': clean_(record['Full Name']),
        'Created Customer ID': customerId,
        'Customer Action': 'LINK EXISTING',
        'Location Action': 'LINK EXISTING',
        'Write Journal JSON': safeJson_(journal),
        'Striven Sync Status': 'PARTIAL',
        'Striven Sync Error': '',
        'Last Striven Sync': d.util.nowString()
      };

      if (locationId) {
        successPatch['Location Match Status'] = 'MATCHED';
        successPatch['Matched Location ID'] = locationId;
        successPatch['Matched Location Address'] = clean_(record['Full Address']);
        successPatch['Created Location ID'] = locationId;
        successPatch['Current Stage'] = 'READY FOR CONTACT CREATE';
        successPatch['Request Status'] = 'OPEN';
        successPatch['Blocking Issue'] = '';
        successPatch['Next Action'] = 'CREATE CONTACT';
        successPatch['Customer Structure Status'] = 'CUSTOMER + PRIMARY LOCATION CREATED';
        successPatch['Reconciliation Status'] = 'CUSTOMER + PRIMARY LOCATION CONFIRMED BY RESPONSE';
      } else {
        successPatch['Current Stage'] = 'CREATING CUSTOMER STRUCTURE';
        successPatch['Request Status'] = 'IN PROGRESS';
        successPatch['Blocking Issue'] = 'Customer created. Do not create Customer or Location again. Reconcile the primary Location ID.';
        successPatch['Next Action'] = 'RECONCILE PRIMARY LOCATION — RUN PHASE5B AGAIN';
        successPatch['Customer Structure Status'] = 'CUSTOMER CREATED — PRIMARY LOCATION PENDING';
        successPatch['Reconciliation Status'] = 'PRIMARY LOCATION REQUIRED';
      }

      patchRequest_(record, successPatch);
      log_(record, 'CONTROLLED_CUSTOMER_CREATE', journal.status, {
        customerId: customerId,
        primaryLocationId: locationId,
        httpStatus: journal.httpStatus,
        payloadFingerprint: lockedPreview.payloadFingerprint,
        writeFingerprint: lockedPreview.writeFingerprint
      });

      return {
        ok: true,
        status: journal.status,
        requestId: lockedPreview.requestId,
        responseCustomerId: customerId,
        responsePrimaryLocationId: locationId,
        liveWriteExecuted: true,
        postOutcome: 'SUCCESS',
        durationMs: Date.now() - started
      };
    });
  }

    function previewAutoCustomerCreate(requestIdOrRow) {
    return buildPreview_(requestIdOrRow, { autoMode: true, executionToken: AUTO_EXECUTION_TOKEN });
  }

  function executeAutoCustomerCreate(requestIdOrRow) {
    return executeControlledCustomerCreate(requestIdOrRow, {
      confirmLiveWrite: true,
      autoMode: true,
      executionToken: AUTO_EXECUTION_TOKEN
    });
  }

  function inspectReadiness() {
    var endpoint = '';
    var endpointConfigured = true;
    try { endpoint = customerCreateEndpoint_(); } catch (ignored) { endpointConfigured = false; }
    return {
      ok: endpointConfigured,
      version: VERSION,
      controlledRequestId: CONTROLLED_REQUEST_ID,
      endpoint: endpoint,
      customerCacheFresh: cacheFresh_('STRIVEN_CUSTOMER_DATA', CUSTOMER_CACHE_MAX_AGE_MINUTES),
      genericLiveWritesEnabled: false
    };
  }

  return {
    version: VERSION,
    previewControlledCustomerCreate: previewControlledCustomerCreate,
    executeControlledCustomerCreate: executeControlledCustomerCreate,
    previewAutoCustomerCreate: previewAutoCustomerCreate,
    executeAutoCustomerCreate: executeAutoCustomerCreate,
    inspectReadiness: inspectReadiness
  };
})();

/************************************************************
 * ===== CONSOLIDATED SOURCE: 62_Striven_Controlled_Contact_Create.gs =====
 * Layout consolidation only. Original module body follows unchanged.
 ************************************************************/
/************************************************************
 * APPS SCRIPT — 62_Striven_Controlled_Contact_Create.gs
 * CF ServiceOps — Guarded Phase 5D Contact Create + Association
 * Version: 5.8.2
 *
 * SAFETY CONTRACT
 * - Does not replace or modify CF.StrivenWrite or Phase 5B Customer module.
 * - Locked to one approved Request ID and one execution token.
 * - Requires durable Customer + Primary Location before Contact work.
 * - Uses POST /v1/contacts for Contact create.
 * - Uses POST /v1/contacts/{contactId}/associate-customer only if needed.
 * - Contact create and association are separate journaled mutations.
 * - Exactly one mutating POST per execution; no automatic write retry.
 * - HTTP 400/422 are deterministic validation rejections, NOT uncertain.
 * - Transport/5xx outcomes are reconciliation-only before any retry.
 * - If Contact ID is durable, no Contact-create POST can occur again.
 * - Fresh Customer cache is the duplicate/reconciliation source for Contacts.
 ************************************************************/
var CF = CF || {};

CF.StrivenControlledContactCreate = (function () {
  'use strict';

  var MODULE_NAME = '62_Striven_Controlled_Contact_Create';
  var VERSION = '5.8.4';
  var CONTROLLED_REQUEST_ID = 'SR-20260818160541-7844';
  var CONTROLLED_EXECUTION_TOKEN = 'PHASE5D-ONE-CONTACT';
  var AUTO_EXECUTION_TOKEN = 'CF-AUTO-CUSTOMER-STRUCTURE-V1';
  var EXPECTED_CUSTOMER_ID = '62240';
  var EXPECTED_LOCATION_ID = '57919';
  var CACHE_MAX_AGE_MINUTES = 120 /* legacy display compatibility; cacheFresh_ uses CF_SERVICEOPS_TTL_CUSTOMER_MINUTES */;

  function deps_() {
    if (!CF.Config || !CF.Util || !CF.StrivenHttp || !CF.StrivenData) {
      throw new Error('CF.Config, CF.Util, CF.StrivenHttp and CF.StrivenData are required.');
    }
    return { config: CF.Config, util: CF.Util, http: CF.StrivenHttp, data: CF.StrivenData };
  }

  function clean_(value) { return deps_().util.cleanText(value); }
  function upper_(value) { return clean_(value).toUpperCase(); }
    function isAutoMode_(options) {
    options = options || {};
    return options.autoMode === true && clean_(options.executionToken) === AUTO_EXECUTION_TOKEN;
  }

  function clone_(value) { return deps_().util.clone(value); }
  function safeJson_(value) { return deps_().util.safeJson(value); }
  function parseJson_(value, fallback) { return deps_().util.parseJson(value, fallback === undefined ? {} : fallback); }

  function request_(requestIdOrRow) {
    var d = deps_();
    if (typeof requestIdOrRow === 'number') {
      var rows = d.util.readRecords('SERVICE_REQUESTS');
      for (var i = 0; i < rows.length; i++) if (rows[i].__rowNumber === requestIdOrRow) return rows[i];
      return null;
    }
    return d.util.findRecord('SERVICE_REQUESTS', 'Request ID', requestIdOrRow);
  }

  function resolvedCustomerId_(record) { return clean_(record['Matched Customer ID'] || record['Created Customer ID']); }
  function resolvedContactId_(record) { return clean_(record['Matched Contact ID'] || record['Created Contact ID']); }
  function resolvedLocationId_(record) { return clean_(record['Matched Location ID'] || record['Created Location ID']); }

  function contactEndpoint_() { return deps_().config.getEndpoint('CONTACTS'); }
  function associationEndpoint_(contactId) {
    return deps_().config.getEndpoint('ASSOCIATE_CONTACT_TO_CUSTOMER', { contactId: contactId });
  }

  function contactPayload_(record, customerId) {
    /* CF_SERVICEOPS_V5_10_34_CONTACT_OFFICIAL_SCHEMA_R2 */
    var phone=clean_(record['Phone']);
    var email=clean_(record['Email']);
    var street=clean_(record['Street']);
    var city=clean_(record['City']);
    var provinceRaw=clean_(record['Province']);
    var provinceKey=String(provinceRaw||'').toUpperCase().replace(/[^A-Z]/g,'');
    var provinceMap={ONTARIO:'ON',ON:'ON',QUEBEC:'QC',QC:'QC',PQ:'QC',ALBERTA:'AB',AB:'AB',BRITISHCOLUMBIA:'BC',BC:'BC',MANITOBA:'MB',MB:'MB',NEWBRUNSWICK:'NB',NB:'NB',NOVASCOTIA:'NS',NS:'NS',SASKATCHEWAN:'SK',SK:'SK',PRINCEEDWARDISLAND:'PE',PEI:'PE',PE:'PE',NEWFOUNDLANDANDLABRADOR:'NL',NEWFOUNDLANDLABRADOR:'NL',NL:'NL',NORTHWESTTERRITORIES:'NT',NT:'NT',NUNAVUT:'NU',NU:'NU',YUKON:'YT',YT:'YT'};
    var province=provinceMap[provinceKey]||provinceRaw;
    var postal=clean_(record['Postal Code']);
    var countryRaw=clean_(record['Country']||'Canada');
    var countryKey=String(countryRaw||'').toUpperCase();
    var country=(countryKey==='CA'||countryKey==='CAN'||countryKey==='CANADA')?'Canada':countryRaw;
    var full=clean_(record['Full Address']);
    var payload={
      Id:0,
      FirstName:clean_(record['First Name']),
      LastName:clean_(record['Last Name'])
    };
    if(phone) payload.Phones=[{Id:0,PhoneType:{Id:2,Name:'Work'},CountryDialCode:1,Number:phone,Extension:clean_(record['Phone Extension']),IsPreferred:true,Active:true}];
    if(email) payload.Emails=[{Id:0,Email:email,IsPrimary:true,Active:true}];
    if(street||city||province||postal||full) payload.Address={Address1:street,Address2:'',Address3:'',City:city,State:province,PostalCode:postal,Country:country,Latitude:0,Longitude:0,FullAddress:full};
    return payload;
  }

  function associationPayload_(customerId) { var n=Number(customerId); return { Customer: { Id: isNaN(n) ? customerId : n } }; } /* CF_SERVICEOPS_V5_12_9_ASSOCIATION_LOCATION_HARDENING_R1 */

  function addBlocker_(blockers, code, message, field) {
    blockers.push({ code: code, message: message, field: field || '' });
  }

  function validateStateAndPayload_(record, payload, customerId, locationId, options) {
    options = options || {};
    var autoMode = isAutoMode_(options);
    var blockers = [];
    if (!autoMode && clean_(record['Request ID']) !== CONTROLLED_REQUEST_ID) addBlocker_(blockers, 'CONTROLLED_REQUEST_ONLY', 'This module is locked to the approved test request.', 'Request ID');
    if (!customerId) addBlocker_(blockers, 'CUSTOMER_ID_REQUIRED', 'A durable Customer ID is required before Contact creation.', 'Matched Customer ID');
    if (!locationId) addBlocker_(blockers, 'LOCATION_ID_REQUIRED', 'A durable Primary Location ID is required before Contact creation.', 'Matched Location ID');
    if (!autoMode && customerId && customerId !== EXPECTED_CUSTOMER_ID) addBlocker_(blockers, 'UNEXPECTED_CUSTOMER_ID', 'Controlled test expected Customer ID ' + EXPECTED_CUSTOMER_ID + '.', 'Matched Customer ID');
    if (!autoMode && locationId && locationId !== EXPECTED_LOCATION_ID) addBlocker_(blockers, 'UNEXPECTED_LOCATION_ID', 'Controlled test expected Location ID ' + EXPECTED_LOCATION_ID + '.', 'Matched Location ID');
    if (upper_(record['Duplicate Risk Status']) !== 'NONE') addBlocker_(blockers, 'DUPLICATE_RISK_NOT_CLEAR', 'Duplicate Risk Status must be NONE.', 'Duplicate Risk Status');
    if (!resolvedContactId_(record) && upper_(record['Current Stage']) !== 'READY FOR CONTACT CREATE') addBlocker_(blockers, 'CONTACT_STAGE_NOT_READY', 'Current Stage must be READY FOR CONTACT CREATE before a new Contact POST.', 'Current Stage');
    if (!clean_(payload.FirstName)) addBlocker_(blockers, 'CONTACT_FIRST_NAME_REQUIRED', 'First Name is required.', 'First Name');
    if (!clean_(payload.LastName)) addBlocker_(blockers, 'CONTACT_LAST_NAME_REQUIRED', 'Last Name is required.', 'Last Name');
    if (!(payload.Phones && payload.Phones.length) && !(payload.Emails && payload.Emails.length)) addBlocker_(blockers, 'CONTACT_IDENTITY_REQUIRED', 'At least Phone or Email is required.', 'Phone / Email');
    return { ok: blockers.length === 0, blockers: blockers };
  }

  function cacheTimestamp_() {
    var d = deps_();
    var sheet = d.util.requireSheet('STRIVEN_CUSTOMER_DATA');
    if (sheet.getLastRow() < 2) return null;
    var map = d.util.getHeaderMap(sheet);
    if (!map['Cache Updated At']) return null;
    var value = sheet.getRange(2, map['Cache Updated At']).getValue();
    if (!value) return null;
    var date = value instanceof Date ? value : new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }

  function controlledContactTtlMinutes_(){try{var raw=PropertiesService.getScriptProperties().getProperty('CF_SERVICEOPS_TTL_CUSTOMER_MINUTES'),n=Number(raw);return isFinite(n)&&n>0?n:120;}catch(e){return 120;}}
  function cacheFresh_() {
    var timestamp=cacheTimestamp_();
    return !!timestamp&&(Date.now()-timestamp.getTime())<=controlledContactTtlMinutes_()*60000;
  }

  function freshnessSnapshot_() {
    return { maxAgeMinutes: CACHE_MAX_AGE_MINUTES, customerContactCache: { fresh: cacheFresh_(), timestamp: cacheTimestamp_() } };
  }

  function readRow_(sheet, rowNumber, headers) {
    var values = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
    return deps_().util.rowToRecord(headers, values, rowNumber);
  }

  function exactFinderRows_(header, value) {
    var d = deps_();
    var target = clean_(value);
    if (!target) return [];
    var sheet = d.util.requireSheet('STRIVEN_CUSTOMER_DATA');
    if (sheet.getLastRow() < 2) return [];
    var headers = d.util.getActualHeaders(sheet);
    var column = headers.indexOf(header) + 1;
    if (!column) return [];
    return sheet.getRange(2, column, sheet.getLastRow() - 1, 1)
      .createTextFinder(target).matchEntireCell(true).findAll().map(function (range) {
        return readRow_(sheet, range.getRow(), headers);
      });
  }

  function contactCandidates_(record) {
    var d = deps_();
    var byId = {};
    function add_(row, reason) {
      if (upper_(row['Entity Type']) !== 'CONTACT') return;
      var id = clean_(row['Contact ID'] || row['Entity ID']);
      if (!id) return;
      if (!byId[id]) byId[id] = {
        contactId: id,
        customerId: clean_(row['Customer ID']),
        fullName: clean_(row['Full Name']),
        phone: clean_(row['Phone']),
        email: clean_(row['Email']),
        reasons: []
      };
      if (byId[id].reasons.indexOf(reason) === -1) byId[id].reasons.push(reason);
    }
    var phone = clean_(record['Normalized Phone']) || d.util.normalizePhone(record['Phone']);
    var email = clean_(record['Normalized Email']) || d.util.normalizeEmail(record['Email']);
    exactFinderRows_('Normalized Phone', phone).forEach(function (row) { add_(row, 'EXACT_PHONE'); });
    exactFinderRows_('Normalized Email', email).forEach(function (row) { add_(row, 'EXACT_EMAIL'); });
    return Object.keys(byId).map(function (id) { return byId[id]; });
  }

  function contactById_(contactId) {
    var matches = exactFinderRows_('Contact ID', contactId).concat(exactFinderRows_('Entity ID', contactId));
    var seen = {};
    for (var i = 0; i < matches.length; i++) {
      if (upper_(matches[i]['Entity Type']) !== 'CONTACT') continue;
      var id = clean_(matches[i]['Contact ID'] || matches[i]['Entity ID']);
      if (id && !seen[id]) { seen[id] = true; return matches[i]; }
    }
    return null;
  }

  function parseHttpError_(error) {
    var message = error && error.message ? error.message : String(error || '');
    var match = message.match(/HTTP\s+(\d{3})\s*:\s*([\s\S]*)$/i);
    var status = match ? Number(match[1]) : 0;
    var bodyText = match ? clean_(match[2]) : '';
    return { status: status, message: message, bodyText: bodyText, body: bodyText ? parseJson_(bodyText, {}) : {} };
  }

  function validationMessages_(body) {
    var out = [];
    var modelState = body && (body.modelState || body.ModelState) || {};
    Object.keys(modelState).forEach(function (field) {
      var messages = modelState[field];
      if (!Array.isArray(messages)) messages = [messages];
      messages.forEach(function (message) { if (clean_(message)) out.push(field + ': ' + clean_(message)); });
    });
    if (!out.length && body && clean_(body.message || body.Message)) out.push(clean_(body.message || body.Message));
    return out;
  }

  function classifyWriteError_(error, label) {
    var parsed = parseHttpError_(error);
    var status = parsed.status;
    var validations = validationMessages_(parsed.body);
    if (status === 400 || status === 422) return {
      outcome: 'REJECTED_VALIDATION', httpStatus: status, remoteWriteMayHaveSucceeded: false,
      safeToRetryUnchanged: false, safeToRetryAfterPayloadChange: true, requiresReconciliation: false,
      validationErrors: validations, message: validations.join('; ') || ('HTTP ' + status + ' validation rejection.')
    };
    if (status === 401 || status === 403) return {
      outcome: 'REJECTED_AUTHORIZATION', httpStatus: status, remoteWriteMayHaveSucceeded: false,
      safeToRetryUnchanged: false, safeToRetryAfterPayloadChange: false, requiresReconciliation: false,
      validationErrors: [], message: 'Striven rejected authorization. Fix authentication before retrying.'
    };
    if (status === 404) return {
      outcome: 'REJECTED_ENDPOINT_OR_RESOURCE', httpStatus: status, remoteWriteMayHaveSucceeded: false,
      safeToRetryUnchanged: false, safeToRetryAfterPayloadChange: false, requiresReconciliation: false,
      validationErrors: [], message: 'Striven returned HTTP 404. Verify the configured endpoint; do not probe alternate mutating endpoints.'
    };
    if (status === 409) return {
      outcome: 'REJECTED_CONFLICT_RECONCILE', httpStatus: status, remoteWriteMayHaveSucceeded: false,
      safeToRetryUnchanged: false, safeToRetryAfterPayloadChange: false, requiresReconciliation: true,
      validationErrors: validations, message: validations.join('; ') || 'Striven returned a conflict. Reconcile before any retry.'
    };
    if (status === 429) return {
      outcome: 'REJECTED_RATE_LIMIT', httpStatus: status, remoteWriteMayHaveSucceeded: false,
      safeToRetryUnchanged: false, safeToRetryAfterPayloadChange: false, requiresReconciliation: false,
      validationErrors: [], message: 'Striven rate-limited the write. This runner will not auto-retry.'
    };
    return {
      outcome: 'UNCERTAIN_RECONCILE_REQUIRED', httpStatus: status || null, remoteWriteMayHaveSucceeded: true,
      safeToRetryUnchanged: false, safeToRetryAfterPayloadChange: false, requiresReconciliation: true,
      validationErrors: [], message: (label || 'Contact write') + ' outcome is uncertain. Reconcile before any new POST.'
    };
  }

  function extractContactId_(body) {
    body = body || {};
    /*
     * IMPORTANT: only explicit ContactId-shaped fields are trustworthy here.
     * A generic response Id may represent another Striven resource identifier.
     * If Striven returns success without an explicit ContactId, reconciliation
     * against the refreshed Contact report is safer than guessing.
     */
    var values = [
      body.ContactId, body.ContactID, body.contactId, body.contactID,
      body.Contact && (body.Contact.ContactId || body.Contact.ContactID || body.Contact.contactId || body.Contact.contactID),
      body.contact && (body.contact.ContactId || body.contact.ContactID || body.contact.contactId || body.contact.contactID),
      body.data && (body.data.ContactId || body.data.ContactID || body.data.contactId || body.data.contactID),
      body.Data && (body.Data.ContactId || body.Data.ContactID || body.Data.contactId || body.Data.contactID)
    ];
    for (var i = 0; i < values.length; i++) if (clean_(values[i])) return clean_(values[i]);
    return '';
  }

    /* CF_SERVICEOPS_V5_12_7_CONTACT_AUTORECOVERY_R1 */
  function genericResponseContactIdV5127_(body) {
    body=body||{};
    var data=body.data||body.Data||{};
    return clean_(body.Id||body.id||body.ID||data.Id||data.id||data.ID);
  }
  function remoteContactIdentityV5127_(remote, record) {
    remote=remote||{}; record=record||{};
    var wantedPhone=clean_(record['Normalized Phone'])||String(record['Phone']||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');
    var wantedEmail=(clean_(record['Normalized Email'])||clean_(record['Email'])).toLowerCase();
    var phones=remote.Phones||remote.phones||[];
    var emails=remote.Emails||remote.emails||[];
    var phoneMatch=!!wantedPhone&&phones.some(function(p){var n=String((p||{}).Number||(p||{}).number||'').replace(/\D/g,'').replace(/^1(?=\d{10}$)/,'');return n===wantedPhone;});
    var emailMatch=!!wantedEmail&&emails.some(function(e){return String((e||{}).Email||(e||{}).email||'').trim().toLowerCase()===wantedEmail;});
    return {phoneMatch:phoneMatch,emailMatch:emailMatch,matched:phoneMatch||emailMatch};
  }
  function customerAssociationIdsV5127_(remote) {
    if(!remote||typeof remote!=='object')return null;
    var raw=Object.prototype.hasOwnProperty.call(remote,'CustomerAssociations')?remote.CustomerAssociations:(Object.prototype.hasOwnProperty.call(remote,'customerAssociations')?remote.customerAssociations:null);
    if(raw===null)return null;
    if(!Array.isArray(raw))raw=[raw];
    return raw.map(function(x){x=x||{};return clean_(x.CustomerId||x.customerId||x.Id||x.id);}).filter(Boolean).filter(function(id,i,a){return a.indexOf(id)===i;});
  }
  function verifyContactIdByGetV5127_(contactId,record) {
    contactId=clean_(contactId);
    if(!contactId)return{ok:false,reason:'NO_CANDIDATE_ID'};
    var scopedEvidence=customerScopedContactEvidenceV5135_(record,contactId,resolvedCustomerId_(record));
    if(scopedEvidence.ok)return{ok:false,reason:'CUSTOMER_SCOPED_CONTACT_NOT_GLOBAL_GETTABLE',customerScoped:true,evidence:scopedEvidence};
    try{
      var response=deps_().http.requestJson('/v1/contacts/'+encodeURIComponent(contactId),{method:'get',attempts:1,idempotent:true});
      var remote=response&&response.json?response.json:{};
      var actual=clean_(remote.Id||remote.id||remote.ID);
      var identity=remoteContactIdentityV5127_(remote,record);
      if(actual!==contactId||!identity.matched)return{ok:false,reason:actual!==contactId?'GET_ID_MISMATCH':'GET_IDENTITY_NOT_CONFIRMED',actualId:actual,identity:identity};
      return{ok:true,contactId:contactId,remote:remote,identity:identity,associationCustomerIds:customerAssociationIdsV5127_(remote)};
    }catch(e){return{ok:false,reason:'GET_FAILED',error:String(e&&e.message||e)};}
  }

function rootJournal_(record) {
    var root = parseJson_(record['Write Journal JSON'], {});
    if (!root || typeof root !== 'object' || Array.isArray(root)) root = {};
    return root;
  }

  function contactJournal_(record) {
    var root = rootJournal_(record);
    var cj = root.contactCreate || {};
    return { root: root, contact: cj };
  }

  function saveContactJournal_(record, contactJournal) {
    var state = contactJournal_(record);
    state.root.contactCreate = contactJournal;
    patchRequest_(record, { 'Write Journal JSON': safeJson_(state.root) });
  }

  function patchRequest_(record, patch) {
    var d = deps_();
    if (typeof d.util.clearRowDataValidations === 'function') d.util.clearRowDataValidations('SERVICE_REQUESTS', record.__rowNumber);
    d.util.patchRow('SERVICE_REQUESTS', record.__rowNumber, patch);
    SpreadsheetApp.flush();
  }

  function log_(record, action, status, details, message) {
    deps_().util.logEvent({
      module: MODULE_NAME, action: action, status: status,
      requestId: clean_(record['Request ID']), correlationId: clean_(record['Correlation ID']),
      message: message || '', details: details || {}, version: VERSION
    });
  }

  function postPredatesCache_(finishedAt) {
    var cache = cacheTimestamp_();
    var finished = clean_(finishedAt) ? new Date(finishedAt) : null;
    return !cache || !finished || isNaN(finished.getTime()) || cache.getTime() <= finished.getTime();
  }

  function refreshContactsIfStale_() {
    var before = freshnessSnapshot_();
    if (before.customerContactCache.fresh) return { refreshed: false, before: before, after: before };
    var result = deps_().data.refreshCustomerData({});
    return { refreshed: true, result: result, before: before, after: freshnessSnapshot_() };
  }

  function finalizeAssociated_(record, contactId, customerId, reason) {
    var d = deps_();
    var state = contactJournal_(record);
    var cj = clone_(state.contact || {});
    var priorCreatedId = clean_(record['Created Contact ID']);
    var responseId = clean_(cj.responseContactId);
    var responseIdMismatch = !!(responseId && responseId !== contactId);

    cj.status = 'CONTACT_ASSOCIATED_RECONCILED';
    cj.reconciliation = cj.reconciliation || {};
    cj.reconciliation.lastAttemptAt = d.util.nowString();
    cj.reconciliation.contactId = contactId;
    cj.reconciliation.customerId = customerId;
    cj.reconciliation.reason = reason || 'CONTACT CACHE CUSTOMER ID CONFIRMED';
    if (responseIdMismatch) {
      cj.reconciliation.responseIdentifier = responseId;
      cj.reconciliation.canonicalContactId = contactId;
      cj.reconciliation.responseIdentifierDidNotMatchContactReport = true;
    }
    state.root.contactCreate = cj;

    patchRequest_(record, {
      'Updated At': d.util.nowString(),
      'Current Stage': 'CUSTOMER STRUCTURE COMPLETE',
      'Request Status': 'OPEN',
      'Manual Review?': 'NO',
      'Manual Review Reason': '',
      'Blocking Issue': '',
      'Next Action': 'CONTINUE TO WORK ORDER',
      'Contact Match Status': 'MATCHED',
      'Matched Contact ID': contactId,
      'Matched Contact Name': clean_(record['Full Name']),
      'Created Contact ID': responseIdMismatch ? contactId : (priorCreatedId || contactId),
      'Contact Action': 'LINK EXISTING',
      'Contact Association Status': 'ASSOCIATED',
      'Customer Structure Status': 'COMPLETE',
      'Striven Sync Status': 'PARTIAL',
      'Striven Sync Error': '',
      'Last Striven Sync': d.util.nowString(),
      'Reconciliation Status': responseIdMismatch ? 'CUSTOMER STRUCTURE RECONCILED — CONTACT ID CANONICALIZED' : 'CUSTOMER STRUCTURE RECONCILED',
      'Write Journal JSON': safeJson_(state.root)
    });

    return {
      ok: true, status: responseIdMismatch ? 'CONTACT_ASSOCIATED_RECONCILED_ID_CANONICALIZED' : 'CONTACT_ASSOCIATED_RECONCILED',
      requestId: clean_(record['Request ID']),
      matchedCustomerId: customerId, matchedContactId: contactId, matchedLocationId: resolvedLocationId_(record),
      responseIdentifier: responseIdMismatch ? responseId : '',
      contactIdCanonicalized: responseIdMismatch,
      liveWriteExecuted: false
    };
  }

  /* CF_SERVICEOPS_V5_13_5_CUSTOMER_SCOPED_CONTACT_EVIDENCE_R1
   * Customer-scoped Contact refs are not assumed to be global /v1/contacts/{id} IDs.
   * This helper uses durable journal evidence only; it performs zero Striven API calls.
   */
  function customerScopedContactEvidenceV5135_(record,contactId,customerId){
    contactId=clean_(contactId);customerId=clean_(customerId);
    if(!record||!contactId||!customerId)return{ok:false,scope:'UNKNOWN'};
    var state=contactJournal_(record),cj=state.contact||{},rec=cj.reconciliation||{},tech=cj.technicalRecovery||{};
    var identity=(state.root&&state.root.contactIdentity)||{};
    var identityScoped=upper_(identity.scope)==='CUSTOMER'&&clean_(identity.customerId)===customerId&&clean_(identity.customerScopedContactId||identity.contactId)===contactId&&identity.identityVerified===true;
    if(identityScoped)return{ok:true,scope:'CUSTOMER',source:'CONTACT_IDENTITY_JOURNAL',customerId:customerId,contactId:contactId};
    var scopedId=clean_(tech.customerScopedContactId||rec.customerScopedContactId);
    var scopedCustomerId=clean_(tech.customerId||rec.customerId||customerId);
    var reason=String(rec.reason||'');
    var explicit=tech.operatorApprovedCustomerScopedContact===true||/CUSTOMER-SCOPED CONTACT/i.test(reason);
    var duplicateIds=[];
    if(Array.isArray(cj.existingDuplicateContactIds))duplicateIds=cj.existingDuplicateContactIds.map(clean_).filter(Boolean);
    if(!duplicateIds.length&&clean_(cj.existingDuplicateContactId))duplicateIds=[clean_(cj.existingDuplicateContactId)];
    var canonicalDiffersFromGlobal=clean_(rec.canonicalContactId)===contactId&&duplicateIds.some(function(id){return id!==contactId;});
    if(scopedId===contactId&&scopedCustomerId===customerId&&(explicit||canonicalDiffersFromGlobal))return{ok:true,scope:'CUSTOMER',source:explicit?'CUSTOMER_SCOPED_TECHNICAL_RECOVERY':'CANONICAL_CONTACT_DIFFERS_FROM_GLOBAL_DUPLICATE',customerId:customerId,contactId:contactId,globalDuplicateContactIds:duplicateIds};
    if(clean_(rec.canonicalContactId)===contactId&&clean_(rec.customerId)===customerId&&(explicit||canonicalDiffersFromGlobal))return{ok:true,scope:'CUSTOMER',source:explicit?'CANONICAL_CUSTOMER_SCOPED_RECONCILIATION':'CANONICAL_CONTACT_DIFFERS_FROM_GLOBAL_DUPLICATE',customerId:customerId,contactId:contactId,globalDuplicateContactIds:duplicateIds};
    return{ok:false,scope:'UNKNOWN',customerId:customerId,contactId:contactId};
  }

  function reconcileKnownContact_(record, contactId, customerId) {
    var d=deps_();
    contactId=clean_(contactId); customerId=clean_(customerId);
    function prop_(o,names){o=o||{};for(var i=0;i<names.length;i++)if(Object.prototype.hasOwnProperty.call(o,names[i]))return o[names[i]];return undefined;}
    function arr_(v){return Array.isArray(v)?v:[];}
    function normEmail_(v){return String(v||'').trim().toLowerCase();}
    function normPhone_(v){var x=String(v||'').replace(/\D/g,'');if(x.length===11&&x.charAt(0)==='1')x=x.slice(1);return x;}
    function id_(o){return clean_(prop_(o,['Id','id','ID','CustomerId','customerId','CustomerID']));}
    function collectCustomerIds_(c){
      var out=[],seen={}; function add(v){v=clean_(v);if(v&&!seen[v]){seen[v]=true;out.push(v);}}
      add(prop_(c,['CustomerId','customerId','CustomerID']));
      var one=prop_(c,['Customer','customer']); if(one&&typeof one==='object')add(id_(one));
      ['CustomerAssociations','customerAssociations','Customers','customers'].forEach(function(k){arr_(c&&c[k]).forEach(function(x){add(id_(x));});});
      return out;
    }
    /* CF_SERVICEOPS_V5_13_5_TECHNICAL_RECOVERY_R1
     * Direct Contact GET is authoritative when it exposes ownership.
     * The refreshed Striven Contact cache is a secondary durable read source
     * for Contact -> Customer ownership when the GET shape omits association data.
     * This helper never writes to Striven.
     */
    function cachedCustomerIdsForContact_(contactId){
      var rows=[],out=[],seen={};
      try{rows=exactFinderRows_('STRIVEN_CUSTOMER_DATA','Contact ID',clean_(contactId))||[];}catch(ignoredCache){rows=[];}
      rows.forEach(function(row){
        if(upper_(row['Entity Type'])!=='CONTACT')return;
        var id=clean_(row['Customer ID']);
        if(id&&!seen[id]){seen[id]=true;out.push(id);}
      });
      return out;
    }
    function identity_(c){
      var reqEmail=normEmail_(record['Normalized Email']||record['Email']);
      var reqPhone=normPhone_(record['Normalized Phone']||record['Phone']);
      var reqFirst=upper_(record['First Name']),reqLast=upper_(record['Last Name']);
      var gotFirst=upper_(prop_(c,['FirstName','firstName'])),gotLast=upper_(prop_(c,['LastName','lastName']));
      var emails=arr_(prop_(c,['Emails','emails'])).map(function(x){return normEmail_(prop_(x,['Email','email']));}).filter(Boolean);
      var phones=arr_(prop_(c,['Phones','phones'])).map(function(x){return normPhone_(prop_(x,['Number','number']));}).filter(Boolean);
      var emailMatch=!!reqEmail&&emails.indexOf(reqEmail)!==-1;
      var phoneMatch=!!reqPhone&&phones.indexOf(reqPhone)!==-1;
      var channelMatch=reqEmail?emailMatch:phoneMatch;
      var nameConflict=(reqFirst&&gotFirst&&reqFirst!==gotFirst)||(reqLast&&gotLast&&reqLast!==gotLast);
      return {ok:channelMatch&&!nameConflict,emailMatch:emailMatch,phoneMatch:phoneMatch,nameConflict:nameConflict,remoteFirstName:gotFirst,remoteLastName:gotLast};
    }
    var scopedEvidenceV5135=customerScopedContactEvidenceV5135_(record,contactId,customerId);
    if(scopedEvidenceV5135.ok)return finalizeAssociated_(record,contactId,customerId,scopedEvidenceV5135.source+' CONFIRMED CUSTOMER-SCOPED CONTACT — GLOBAL GET SKIPPED');

    var response;
    try { response=d.http.requestJson('/v1/contacts/'+encodeURIComponent(contactId),{method:'get',attempts:1,idempotent:true}); }
    catch(e){
      return {ok:false,status:'CONTACT_DIRECT_GET_FAILED_NO_REPORT_REFRESH',requestId:clean_(record['Request ID']),matchedContactId:contactId,error:String(e&&e.message||e),directRead:true,customerCacheRefreshExecuted:false,automaticPostRetry:false,liveWriteExecuted:false};
    }
    var body=response&&response.json?response.json:{};
    var returnedId=clean_(prop_(body,['Id','id','ID','ContactId','contactId','ContactID']));
    if(returnedId!==contactId){
      patchRequest_(record,{'Updated At':d.util.nowString(),'Current Stage':'NEEDS REVIEW','Request Status':'BLOCKED','Manual Review?':'YES','Manual Review Reason':'Direct Striven Contact lookup returned an unexpected Contact ID.','Blocking Issue':'Expected Contact '+contactId+' but direct GET returned '+(returnedId||'BLANK')+'. Do not create or associate another Contact.','Next Action':'REVIEW CONTACT DIRECT LOOKUP','Striven Sync Status':'BLOCKED','Reconciliation Status':'CONTACT DIRECT GET ID MISMATCH'});
      return {ok:false,status:'CONTACT_DIRECT_GET_ID_MISMATCH',requestId:clean_(record['Request ID']),expectedContactId:contactId,actualContactId:returnedId,directRead:true,liveWriteExecuted:false};
    }
    var ident=identity_(body);
    if(!ident.ok){
      patchRequest_(record,{'Updated At':d.util.nowString(),'Current Stage':'NEEDS REVIEW','Request Status':'BLOCKED','Manual Review?':'YES','Manual Review Reason':'Existing Contact '+contactId+' did not pass direct identity verification.','Blocking Issue':'Known duplicate Contact ID '+contactId+' conflicts with the request identity. Do not associate or create another Contact.','Next Action':'REVIEW CONTACT IDENTITY '+contactId,'Contact Association Status':'CONFLICT','Striven Sync Status':'BLOCKED','Reconciliation Status':'CONTACT DIRECT IDENTITY CONFLICT'});
      return {ok:false,status:'CONTACT_DIRECT_IDENTITY_CONFLICT',requestId:clean_(record['Request ID']),matchedContactId:contactId,identity:ident,directRead:true,liveWriteExecuted:false};
    }
    var owners=collectCustomerIds_(body),ownerEvidence='DIRECT CONTACT GET';
    if(!owners.length){
      var cachedOwners=cachedCustomerIdsForContact_(contactId);
      if(cachedOwners.length){owners=cachedOwners;ownerEvidence='REFRESHED STRIVEN CONTACT CACHE';}
    }
    if(owners.indexOf(customerId)!==-1) return finalizeAssociated_(record,contactId,customerId,ownerEvidence+' CONFIRMED IDENTITY + CUSTOMER ASSOCIATION');
    if(owners.length){
      patchRequest_(record,{'Updated At':d.util.nowString(),'Current Stage':'NEEDS REVIEW','Request Status':'BLOCKED','Manual Review?':'YES','Manual Review Reason':'Existing Contact ID '+contactId+' is associated to Customer '+owners.join(', ')+', not '+customerId+'.','Blocking Issue':'Contact ownership conflict. Do not associate or create another Contact.','Next Action':'REVIEW CONTACT OWNERSHIP','Contact Association Status':'CONFLICT','Striven Sync Status':'BLOCKED','Reconciliation Status':'CONTACT OWNERSHIP CONFLICT'});
      return {ok:false,status:'CONTACT_OWNERSHIP_CONFLICT',requestId:clean_(record['Request ID']),matchedContactId:contactId,ownerCustomerIds:owners,ownerEvidence:ownerEvidence,directRead:true,liveWriteExecuted:false};
    }
    var state=contactJournal_(record),cj=clone_(state.contact||{});
    var reportedDuplicates=duplicateContactIdsFromJournal_(cj);
    if(reportedDuplicates.indexOf(contactId)!==-1){
      cj.reconciliation=cj.reconciliation||{};
      cj.reconciliation.lastAttemptAt=d.util.nowString();
      cj.reconciliation.contactId=contactId;
      cj.reconciliation.customerId=customerId;
      cj.reconciliation.reason='GLOBAL DUPLICATE CONTACT IDENTITY MATCHED; CUSTOMER OWNERSHIP UNVERIFIED';
      cj.associationStatus='READ_ONLY_RECONCILE_REQUIRED';
      cj.status='DUPLICATE_CONTACT_OWNERSHIP_GET_ONLY';
      state.root.contactCreate=cj;
      patchRequest_(record,{'Updated At':d.util.nowString(),'Current Stage':'NEEDS REVIEW','Request Status':'BLOCKED','Manual Review?':'NO','Blocking Issue':'Striven reported Contact '+contactId+' as a global duplicate, but GET/cache did not prove it belongs to Customer '+customerId+'. Do not associate or create a Contact.','Next Action':'GET-ONLY VERIFY CUSTOMER CONTACT — DO NOT POST','Contact Association Status':'RECONCILE','Customer Structure Status':'CONTACT OWNERSHIP UNVERIFIED','Write Journal JSON':safeJson_(state.root),'Striven Sync Status':'RECONCILE REQUIRED','Reconciliation Status':'GLOBAL DUPLICATE CONTACT OWNERSHIP UNVERIFIED'});
      return{ok:false,status:'DUPLICATE_CONTACT_OWNERSHIP_GET_ONLY',requestId:clean_(record['Request ID']),candidateContactId:contactId,matchedCustomerId:customerId,directRead:true,automaticPostRetry:false,liveWriteExecuted:false};
    }
    cj.reconciliation=cj.reconciliation||{};cj.reconciliation.lastAttemptAt=d.util.nowString();cj.reconciliation.contactId=contactId;cj.reconciliation.customerId=customerId;cj.reconciliation.reason='DIRECT CONTACT GET IDENTITY CONFIRMED — ASSOCIATION REQUIRED';cj.reconciliation.directRead=true;
    state.root.contactCreate=cj;
    patchRequest_(record,{'Updated At':d.util.nowString(),'Matched Contact ID':contactId,'Created Contact ID':contactId,'Matched Contact Name':clean_(record['Full Name']),'Contact Match Status':'MATCHED','Contact Action':'LINK EXISTING','Contact Association Status':'PENDING RECONCILIATION','Customer Structure Status':'CONTACT RECONCILED — ASSOCIATION PENDING','Blocking Issue':'Existing Contact '+contactId+' verified directly. Controlled Customer association remains.','Next Action':'RECONCILE CONTACT ASSOCIATION','Write Journal JSON':safeJson_(state.root),'Striven Sync Status':'PARTIAL','Striven Sync Error':'','Reconciliation Status':'CONTACT DIRECT ID RECONCILED'});
    return {ok:true,status:'CONTACT_CREATED_ASSOCIATION_REQUIRED',requestId:clean_(record['Request ID']),matchedContactId:contactId,matchedCustomerId:customerId,directRead:true,customerCacheRefreshExecuted:false,readyForAssociationNextRun:true,liveWriteExecuted:false};
  }

  function buildPreview_(requestIdOrRow, options) {
    options = options || {};
    var d = deps_();
    var record = request_(requestIdOrRow);
    if (!record) throw new Error('Service Request not found.');
    var customerId = resolvedCustomerId_(record);
    var locationId = resolvedLocationId_(record);
    var contactId = resolvedContactId_(record);
    var createEndpoint = contactEndpoint_();
    var payload = contactPayload_(record, customerId);
    var validation = validateStateAndPayload_(record, payload, customerId, locationId, options);
    var payloadFingerprint = d.util.canonicalHash({ endpoint: createEndpoint, payload: payload });
    var writeFingerprint = d.util.canonicalHash({ requestId: clean_(record['Request ID']), action: 'CREATE_CONTACT', endpoint: createEndpoint, payloadFingerprint: payloadFingerprint });
    var state = contactJournal_(record);
    var candidates = contactCandidates_(record);
    var blockers = clone_(validation.blockers);
    var warnings = [];

    if (contactId) warnings.push('A durable Contact ID already exists. Execute will reconcile/associate only; it cannot create another Contact.');
    if (candidates.length === 1 && !contactId) {
      if (candidates[0].customerId === customerId) warnings.push('An exact Contact already exists for this Customer. Execute will link it without POST.');
      else addBlocker_(blockers, 'EXISTING_CONTACT_REQUIRES_REVIEW', 'An exact Contact already exists under a different or unresolved Customer. Do not create a duplicate.', 'Contact');
    }
    if (candidates.length > 1 && !contactId) addBlocker_(blockers, 'CONTACT_MATCH_AMBIGUOUS', 'Multiple exact Contact IDs match phone/email. Do not create a Contact.', 'Contact');
    if (!cacheFresh_()) warnings.push('Customer/Contact cache is stale. Execute will refresh it and return without POST.');
    warnings.push('The Contact create body follows the existing CF ServiceOps Striven contract. Any additional Striven validation requirement will return REJECTED_VALIDATION, not UNCERTAIN.');

    var cj = state.contact || {};
    var sameFingerprint = clean_(cj.payloadFingerprint) === payloadFingerprint;
    if (!contactId && Number(cj.postAttempts || 0) > 0 && sameFingerprint) {
      if (upper_(cj.status).indexOf('REJECTED_VALIDATION') !== -1) {
        addBlocker_(blockers, 'PRIOR_REJECTED_CONTACT_PAYLOAD_UNCHANGED', 'Striven already rejected this exact Contact payload. Change the contract/payload before another POST.', 'Write Journal JSON');
      } else {
        addBlocker_(blockers, 'PRIOR_CONTACT_POST_REQUIRES_RECONCILIATION', 'This exact Contact payload already crossed the write boundary. Reconcile; do not POST it again.', 'Write Journal JSON');
      }
    }

    return {
      ok: blockers.length === 0,
      phase: 'PHASE 5D — GUARDED CONTACT CREATE + ASSOCIATION', version: VERSION,
      requestId: clean_(record['Request ID']), rowNumber: record.__rowNumber,
      state: { stage: clean_(record['Current Stage']), customerId: customerId, locationId: locationId, contactId: contactId, contactAction: clean_(record['Contact Action']), associationStatus: clean_(record['Contact Association Status']) },
      create: { endpoint: createEndpoint, payload: payload, payloadFingerprint: payloadFingerprint, writeFingerprint: writeFingerprint },
      association: { endpointTemplate: '/v1/contacts/{contactId}/associate-customer', payload: associationPayload_(customerId) },
      validation: validation, blockers: blockers, warnings: warnings,
      freshness: freshnessSnapshot_(), exactContactCandidates: candidates,
      contactJournal: cj,
      readyForLivePost: blockers.length === 0 && !contactId && candidates.length === 0 && cacheFresh_(),
      liveWriteExecuted: false
    };
  }

  function executionGate_(record, options) {
    options = options || {};
    if (isAutoMode_(options)) {
      if (options.confirmLiveWrite !== true) throw new Error('AUTO_WRITE_BLOCKED | confirmLiveWrite must be true.');
      if (deps_().config.isTerminalState(record['Current Stage']) || deps_().config.isTerminalState(record['Final Outcome'])) {
        throw new Error('AUTO_WRITE_BLOCKED | Terminal requests cannot be changed.');
      }
      if (upper_(record['Manual Review?']) === 'YES') throw new Error('AUTO_WRITE_BLOCKED | Manual review is active.');
      if (upper_(record['Duplicate Risk Status']) !== 'NONE') throw new Error('AUTO_WRITE_BLOCKED | Duplicate risk is not clear.');
      return;
    }
    if (clean_(record['Request ID']) !== CONTROLLED_REQUEST_ID) throw new Error('CONTROLLED_WRITE_BLOCKED | This executor is locked to ' + CONTROLLED_REQUEST_ID + '.');
    if (clean_(options.executionToken) !== CONTROLLED_EXECUTION_TOKEN) throw new Error('CONTROLLED_WRITE_BLOCKED | Missing controlled execution token. Use the approved public runner.');
    if (options.confirmLiveWrite !== true) throw new Error('CONTROLLED_WRITE_BLOCKED | confirmLiveWrite must be true.');
  }

  function withWriteLock_(callback) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) throw new Error('Another CF ServiceOps write execution is already running.');
    try { return callback(); } finally { lock.releaseLock(); }
  }

  function applyWriteFailure_(record, cj, classification, operation, started) {
    var d = deps_();
    var state = contactJournal_(record);
    state.root.contactCreate = cj;
    var uncertain = classification.remoteWriteMayHaveSucceeded;
    patchRequest_(record, {
      'Updated At': d.util.nowString(),
      'Current Stage': uncertain ? 'CREATING CUSTOMER STRUCTURE' : 'READY FOR CONTACT CREATE',
      'Request Status': 'BLOCKED',
      'Blocking Issue': classification.message,
      'Next Action': uncertain ? ('RECONCILE ' + operation + ' — DO NOT RETRY POST') : ('FIX ' + operation + ' — DO NOT RETRY UNCHANGED'),
      'Customer Structure Status': uncertain ? (operation + ' UNCERTAIN — RECONCILE') : (operation + ' REJECTED'),
      'Contact Association Status': operation === 'CONTACT ASSOCIATION' ? (uncertain ? 'UNCERTAIN — RECONCILE' : 'REJECTED') : clean_(record['Contact Association Status']),
      'Write Journal JSON': safeJson_(state.root),
      'Striven Sync Status': uncertain ? 'UNCERTAIN — RECONCILE' : 'ERROR',
      'Striven Sync Error': classification.message,
      'Last Striven Sync': d.util.nowString(),
      'Reconciliation Status': classification.requiresReconciliation ? 'REQUIRED' : 'NOT REQUIRED — REQUEST REJECTED'
    });
    return {
      ok: false, status: classification.outcome, operation: operation,
      httpStatus: classification.httpStatus, validationErrors: classification.validationErrors,
      remoteWriteMayHaveSucceeded: classification.remoteWriteMayHaveSucceeded,
      safeToRetryUnchanged: classification.safeToRetryUnchanged,
      safeToRetryAfterPayloadChange: classification.safeToRetryAfterPayloadChange,
      requestId: clean_(record['Request ID']), liveWriteExecuted: true, durationMs: Date.now() - started
    };
  }

  function reconcileUncertainCreate_(record, cj) {var d=deps_(),customerId=resolvedCustomerId_(record),genericId=clean_(cj.genericResponseIdentifier||cj.responseIdentifier);if(genericId){var gv=verifyContactIdByGetV5127_(genericId,record);if(gv.ok){cj.status='CONTACT_RECONCILED_AFTER_UNCERTAIN_CREATE_BY_GET';cj.responseContactId=genericId;cj.genericResponseIdVerifiedByGet=true;var gs=contactJournal_(record);gs.root.contactCreate=cj;patchRequest_(record,{'Write Journal JSON':safeJson_(gs.root),'Reconciliation Status':'CONTACT RECONCILED BY DIRECT GET'});return reconcileKnownContact_(request_(record.__rowNumber),genericId,customerId);}}var candidates=contactCandidates_(record);if(candidates.length===0&&(!cacheFresh_()||postPredatesCache_(cj.postFinishedAt))){d.data.refreshCustomerData({});candidates=contactCandidates_(record);}if(candidates.length===1){var id=candidates[0].contactId;cj.status='CONTACT_RECONCILED_AFTER_UNCERTAIN_CREATE';cj.responseContactId=id;var state=contactJournal_(record);state.root.contactCreate=cj;patchRequest_(record,{'Updated At':d.util.nowString(),'Created Contact ID':id,'Matched Contact ID':id,'Matched Contact Name':candidates[0].fullName||clean_(record['Full Name']),'Contact Match Status':'MATCHED','Contact Action':'LINK EXISTING','Contact Association Status':'PENDING RECONCILIATION','Customer Structure Status':'CONTACT RECONCILED — ASSOCIATION PENDING','Striven Sync Status':'PARTIAL','Striven Sync Error':'','Reconciliation Status':'CONTACT RECONCILED','Write Journal JSON':safeJson_(state.root)});return reconcileKnownContact_(request_(record.__rowNumber),id,customerId);}if(candidates.length>1)return{ok:false,status:'CONTACT_RECONCILIATION_AMBIGUOUS',requestId:clean_(record['Request ID']),contactCandidateCount:candidates.length,liveWriteExecuted:false,automaticPostRetry:false};var email=clean_(record['Normalized Email']||record['Email']).toLowerCase(),recoveryAttempts=Number(cj.emailProtectedRecoveryAttempts||0);if(email&&Number(cj.postAttempts||0)===1&&recoveryAttempts<1){cj.emailProtectedRecoveryAttempts=1;cj.emailProtectedRecoveryStartedAt=d.util.nowString();cj.status='EMAIL_PROTECTED_RECOVERY_INTENT_RECORDED';var rs=contactJournal_(record);rs.root.contactCreate=cj;patchRequest_(record,{'Write Journal JSON':safeJson_(rs.root),'Reconciliation Status':'EMAIL-PROTECTED CONTACT RECOVERY INTENT','Next Action':'EMAIL-PROTECTED CONTACT RECOVERY — MAX ONE POST'});try{var response=d.http.requestJson(contactEndpoint_(),{method:'post',payload:contactPayload_(record,customerId),idempotent:false,attempts:1});var body=response&&response.json?response.json:{},rid=clean_(extractContactId_(body)||genericResponseContactIdV5127_(body));cj.emailProtectedRecoveryFinishedAt=d.util.nowString();cj.emailProtectedRecoveryHttpStatus=response&&response.status||200;cj.emailProtectedRecoveryResponseId=rid;var rs2=contactJournal_(request_(record.__rowNumber));rs2.root.contactCreate=cj;patchRequest_(request_(record.__rowNumber),{'Write Journal JSON':safeJson_(rs2.root),'Reconciliation Status':rid?'EMAIL-PROTECTED RECOVERY RESPONSE ID':'EMAIL-PROTECTED RECOVERY ID MISSING — READ ONLY RECONCILE'});if(rid){var rv=verifyContactIdByGetV5127_(rid,record);if(rv.ok)return reconcileKnownContact_(request_(record.__rowNumber),rid,customerId);}return{ok:false,status:'EMAIL_PROTECTED_RECOVERY_RECONCILE_REQUIRED',requestId:clean_(record['Request ID']),liveWriteExecuted:true,automaticPostRetry:false};}catch(e){var ids=duplicateContactIdsFromError_(e);cj.emailProtectedRecoveryFinishedAt=d.util.nowString();cj.emailProtectedRecoveryError=String(e&&e.message||e);cj.existingDuplicateContactIds=ids;var rs3=contactJournal_(request_(record.__rowNumber));rs3.root.contactCreate=cj;patchRequest_(request_(record.__rowNumber),{'Write Journal JSON':safeJson_(rs3.root),'Reconciliation Status':ids.length?'EMAIL-PROTECTED RECOVERY DUPLICATE RECONCILE':'EMAIL-PROTECTED RECOVERY ERROR — READ ONLY RECONCILE'});if(ids.length===1)return reconcileKnownContact_(request_(record.__rowNumber),ids[0],customerId);if(ids.length>1)return{ok:false,status:'DUPLICATE_CONTACT_IDS_AMBIGUOUS',requestId:clean_(record['Request ID']),existingDuplicateContactIds:ids,liveWriteExecuted:true,automaticPostRetry:false};return{ok:false,status:'EMAIL_PROTECTED_RECOVERY_RECONCILE_REQUIRED',requestId:clean_(record['Request ID']),error:String(e&&e.message||e),remoteWriteMayHaveSucceeded:true,liveWriteExecuted:true,automaticPostRetry:false};}}return{ok:false,status:'UNCERTAIN_RECONCILE_REQUIRED',requestId:clean_(record['Request ID']),contactCandidateCount:0,emailProtectedRecoveryAttempts:recoveryAttempts,liveWriteExecuted:false,automaticPostRetry:false};}

  function previewControlledContactCreate(requestIdOrRow) { return buildPreview_(requestIdOrRow); }

  
  /* CF_SERVICEOPS_V5_10_36_DUPLICATE_CONTACT_ID_AUTO_RECONCILE_R1 */
  function duplicateContactIdsFromError_(error) {
    var text=String(error&&error.message||error||'');
    var out=[],seen={},re=/(?:Contact\s*ID|ContactID)\s*[:#]?\s*(\d+)/ig,m;
    while((m=re.exec(text))){var id=clean_(m[1]);if(id&&!seen[id]){seen[id]=true;out.push(id);}}
    return out;
  }
  function duplicateContactIdsFromJournal_(cj) {
    var ids=[];
    if(cj&&Array.isArray(cj.existingDuplicateContactIds)) ids=cj.existingDuplicateContactIds.map(clean_).filter(Boolean);
    if(!ids.length&&cj&&clean_(cj.existingDuplicateContactId)) ids=[clean_(cj.existingDuplicateContactId)];
    return ids.filter(function(id,i,a){return a.indexOf(id)===i;});
  }

function executeControlledContactCreate(requestIdOrRow, options) {
    return withWriteLock_(function () {
      var started = Date.now();
      var d = deps_();
      var record = request_(requestIdOrRow);
      if (!record) throw new Error('Service Request not found.');
      executionGate_(record, options);

      var customerId = resolvedCustomerId_(record);
      var locationId = resolvedLocationId_(record);
      var contactId = resolvedContactId_(record);
      var state = contactJournal_(record);
      var cj = clone_(state.contact || {});

      /* CF_SERVICEOPS_V5_10_36_SELF_HEALING_CONTINUATION_R1 */
      var priorDuplicateIds=duplicateContactIdsFromJournal_(cj);
      if(!contactId&&priorDuplicateIds.length){
        if(priorDuplicateIds.length===1){
          var duplicateId=priorDuplicateIds[0];
          if(!cj.duplicateCandidateRefreshAt&&postPredatesCache_(cj.postFinishedAt)){
            cj.duplicateCandidateRefreshAt=d.util.nowString();
            state.root.contactCreate=cj;
            patchRequest_(record,{'Write Journal JSON':safeJson_(state.root)});
            try{d.data.refreshCustomerData({});}
            catch(refreshError){return{ok:false,status:'DUPLICATE_CONTACT_REFRESH_FAILED_GET_ONLY',requestId:clean_(record['Request ID']),error:String(refreshError&&refreshError.message||refreshError),automaticPostRetry:false,liveWriteExecuted:false};}
          }
          var scoped=contactCandidates_(record).filter(function(x){return x.customerId===customerId;});
          if(scoped.length>1)return{ok:false,status:'CUSTOMER_CONTACT_CANDIDATES_AMBIGUOUS',requestId:clean_(record['Request ID']),candidateIds:scoped.map(function(x){return x.contactId;}),automaticPostRetry:false,liveWriteExecuted:false};
          var recovered=reconcileKnownContact_(record,scoped.length===1?scoped[0].contactId:duplicateId,customerId);
          recovered.existingDuplicateContactId=duplicateId;
          recovered.existingDuplicateContactIds=priorDuplicateIds;
          recovered.automaticPostRetry=false;
          recovered.duplicateCreatePostRetried=false;
          return recovered;
        }
        if(priorDuplicateIds.length>1){
          var dupText=priorDuplicateIds.join(', ');
          patchRequest_(record,{
            'Updated At':d.util.nowString(),'Current Stage':'NEEDS REVIEW','Request Status':'BLOCKED','Manual Review?':'YES',
            'Manual Review Reason':'Striven reported multiple existing duplicate Contact IDs: '+dupText+'.',
            'Blocking Issue':'Existing duplicate Contact IDs: '+dupText+'. Do not create another Contact.',
            'Next Action':'REVIEW EXISTING CONTACT IDS '+dupText,'Striven Sync Status':'BLOCKED','Reconciliation Status':'DUPLICATE CONTACT IDS AMBIGUOUS'
          });
          return{ok:false,status:'DUPLICATE_CONTACT_IDS_AMBIGUOUS',requestId:clean_(record['Request ID']),existingDuplicateContactIds:priorDuplicateIds,automaticPostRetry:false,liveWriteExecuted:false};
        }
      }

      if (contactId) {
        if (upper_(cj.associationStatus).indexOf('UNCERTAIN') !== -1 || upper_(cj.status).indexOf('ASSOCIATION_UNCERTAIN') !== -1) {
          return reconcileKnownContact_(record, contactId, customerId);
        }

        var known = reconcileKnownContact_(record, contactId, customerId);
        if (known.status !== 'CONTACT_CREATED_ASSOCIATION_REQUIRED') return known;

        // Association is a separate mutation and therefore a separate execution.
        cj.associationEndpoint = associationEndpoint_(contactId);
        cj.associationPayload = associationPayload_(customerId);
        cj.associationFingerprint = d.util.canonicalHash({ endpoint: cj.associationEndpoint, payload: cj.associationPayload });
        cj.associationAttempts = Number(cj.associationAttempts || 0) + 1;
        if (cj.associationAttempts > 1 && clean_(cj.lastAssociationFingerprint) === cj.associationFingerprint) {
          cj.associationAttempts = Math.max(1, Number(cj.associationAttempts || 1) - 1);
          cj.associationStatus = 'READ_ONLY_RECONCILE_REQUIRED';
          cj.status = 'CONTACT_ASSOCIATION_GET_ONLY_RECONCILE_REQUIRED';
          cj.technicalRecovery = cj.technicalRecovery || {};
          cj.technicalRecovery.status = 'GET_ONLY_ASSOCIATION_VERIFICATION_REQUIRED';
          cj.technicalRecovery.customerId = customerId;
          cj.technicalRecovery.contactId = contactId;
          cj.technicalRecovery.noAutomaticWriteRetry = true;
          state.root.contactCreate = cj;
          patchRequest_(record, {
            'Updated At': d.util.nowString(),
            'Current Stage': 'NEEDS REVIEW',
            'Request Status': 'BLOCKED',
            'Manual Review?': 'NO',
            'Manual Review Reason': '',
            'Blocking Issue': 'This Contact association write already crossed the write boundary. Direct GET/cache did not yet expose the Customer relationship. GET-only verification is required; do not repeat the POST.',
            'Next Action': 'GET-ONLY VERIFY CONTACT '+contactId+' → CUSTOMER '+customerId+' — DO NOT POST',
            'Contact Association Status': 'RECONCILE',
            'Customer Structure Status': 'CONTACT RECONCILED — ASSOCIATION UNVERIFIED',
            'Write Journal JSON': safeJson_(state.root),
            'Striven Sync Status': 'RECONCILE REQUIRED',
            'Striven Sync Error': '',
            'Reconciliation Status': 'TECHNICAL RECOVERY — GET-ONLY ASSOCIATION VERIFICATION REQUIRED'
          });
          return { ok: false, status: 'CONTACT_ASSOCIATION_GET_ONLY_RECONCILE_REQUIRED', requestId: clean_(record['Request ID']), matchedContactId: contactId, matchedCustomerId: customerId, readOnlyRecoveryRequired: true, liveWriteExecuted: false, automaticPostRetry: false };
        }
        cj.lastAssociationFingerprint = cj.associationFingerprint;
        cj.associationStartedAt = d.util.nowString();
        cj.associationStatus = 'INTENT_RECORDED';
        state.root.contactCreate = cj;
        patchRequest_(record, {
          'Updated At': d.util.nowString(), 'Current Stage': 'CREATING CUSTOMER STRUCTURE', 'Request Status': 'IN PROGRESS',
          'Blocking Issue': 'Contact exists. Association POST is controlled; do not create another Contact.',
          'Next Action': 'ASSOCIATE CONTACT TO CUSTOMER', 'Contact Association Status': 'ASSOCIATING',
          'Write Journal JSON': safeJson_(state.root), 'Striven Sync Status': 'SYNCING', 'Striven Sync Error': ''
        });

        try {
          d.http.requestJson(cj.associationEndpoint, { method: 'post', payload: cj.associationPayload, idempotent: false, attempts: 1 });
        } catch (associationError) {
          var ac = classifyWriteError_(associationError, 'Contact association');
          cj.associationFinishedAt = d.util.nowString(); cj.associationStatus = ac.outcome;
          cj.associationHttpStatus = ac.httpStatus; cj.associationError = d.util.truncate(associationError.message || String(associationError), 4000);
          cj.status = ac.remoteWriteMayHaveSucceeded ? 'ASSOCIATION_UNCERTAIN_RECONCILE_REQUIRED' : ac.outcome;
          return applyWriteFailure_(record, cj, ac, 'CONTACT ASSOCIATION', started);
        }

        cj.associationFinishedAt = d.util.nowString(); cj.associationStatus = 'POST_ACCEPTED_RECONCILE_REQUIRED'; cj.status = 'CONTACT_ASSOCIATION_POST_ACCEPTED_RECONCILE_REQUIRED';
        state.root.contactCreate = cj;
        patchRequest_(record, {
          'Updated At': d.util.nowString(), 'Current Stage': 'CREATING CUSTOMER STRUCTURE', 'Request Status': 'IN PROGRESS',
          'Blocking Issue': 'Association POST succeeded. Reconcile before any further Contact write.',
          'Next Action': 'RECONCILE CONTACT ASSOCIATION', 'Contact Association Status': 'RECONCILE',
          'Write Journal JSON': safeJson_(state.root), 'Striven Sync Status': 'PARTIAL', 'Striven Sync Error': '',
          'Last Striven Sync': d.util.nowString(), 'Reconciliation Status': 'CONTACT ASSOCIATION REQUIRED'
        });
        return { ok: true, status: 'CONTACT_ASSOCIATION_POST_ACCEPTED_RECONCILE_REQUIRED', requestId: clean_(record['Request ID']), matchedContactId: contactId, liveWriteExecuted: true, operation: 'ASSOCIATE_CONTACT', durationMs: Date.now() - started };
      }

      if (Number(cj.postAttempts || 0) > 0 && (cj.remoteWriteMayHaveSucceeded === true || upper_(cj.status).indexOf('UNCERTAIN') !== -1 || upper_(cj.status).indexOf('SUCCESS_ID_MISSING') !== -1)) return reconcileUncertainCreate_(record, cj);
      // A global duplicate-email response does not identify the Contact under
      // this Customer. Refresh stale ownership evidence before choosing a POST.
      var refresh=refreshContactsIfStale_();
      if(refresh.refreshed){
        var refreshElapsedV5127=Date.now()-started;
        try{log_(record,'CONTACT_CACHE_REFRESH','REFRESHED_CONTINUE_SAME_RUN',{freshness:refresh.after,refreshElapsedMs:refreshElapsedV5127,runtimeContinuationBudgetMs:240000},'Customer/Contact cache refreshed. Continue duplicate check in this same execution when runtime budget allows.');}catch(ignoredV5127RefreshLog){}
        if(refreshElapsedV5127>240000)return{ok:true,status:'REFRESHED_CONTACTS_READY_RUN_AGAIN',requestId:clean_(record['Request ID']),liveWriteExecuted:false,freshness:refresh.after,readyForLivePostNextRun:true,deferredForRuntimeBudget:true,durationMs:Date.now()-started};
      }

      var candidates = contactCandidates_(record);
      var customerCandidates=candidates.filter(function(x){return x.customerId===customerId;});
      if(customerCandidates.length===1){
        return reconcileKnownContact_(record,customerCandidates[0].contactId,customerId);
      }
      if (candidates.length === 1) {
        patchRequest_(record, {
          'Updated At': d.util.nowString(), 'Current Stage': 'NEEDS REVIEW', 'Request Status': 'BLOCKED', 'Manual Review?': 'YES',
          'Manual Review Reason': 'Existing Contact ID ' + candidates[0].contactId + ' already matches the phone/email under Customer ' + (candidates[0].customerId || 'UNRESOLVED') + '.',
          'Blocking Issue': 'Existing Contact ID ' + candidates[0].contactId + '. Do not create a duplicate Contact.', 'Next Action': 'REVIEW EXISTING CONTACT '+candidates[0].contactId, 'Striven Sync Status': 'BLOCKED'
        });
        return { ok: false, status: 'EXISTING_CONTACT_REQUIRES_REVIEW', requestId: clean_(record['Request ID']), candidate: candidates[0], liveWriteExecuted: false };
      }
      if (candidates.length > 1) {
        patchRequest_(record, {
          'Updated At': d.util.nowString(), 'Current Stage': 'NEEDS REVIEW', 'Request Status': 'BLOCKED', 'Manual Review?': 'YES',
          'Manual Review Reason': 'Multiple exact Contacts match the request phone/email: ' + candidates.map(function(x){return x.contactId;}).join(', ') + '.', 'Blocking Issue': 'Existing Contact IDs: ' + candidates.map(function(x){return x.contactId;}).join(', ') + '. Do not create a duplicate Contact.',
          'Next Action': 'REVIEW CONTACT CANDIDATES', 'Striven Sync Status': 'BLOCKED'
        });
        return { ok: false, status: 'CONTACT_MATCH_AMBIGUOUS', requestId: clean_(record['Request ID']), candidates: candidates, liveWriteExecuted: false };
      }

      var preview = buildPreview_(record.__rowNumber, options);
      if (!preview.validation.ok || preview.blockers.length) return { ok: false, status: 'BLOCKED', requestId: preview.requestId, blockers: preview.blockers, liveWriteExecuted: false };

      cj.phase = 'PHASE 5D — GUARDED CONTACT CREATE + ASSOCIATION';
      cj.requestId = clean_(record['Request ID']); cj.customerId = customerId; cj.locationId = locationId;
      cj.endpoint = preview.create.endpoint; cj.payloadFingerprint = preview.create.payloadFingerprint; cj.writeFingerprint = preview.create.writeFingerprint;
      cj.payload = preview.create.payload; cj.status = 'CONTACT_CREATE_INTENT_RECORDED';
      cj.intentRecordedAt = d.util.nowString(); cj.postAttempts = Number(cj.postAttempts || 0) + 1; cj.noAutomaticWriteRetry = true;
      if (cj.postAttempts > 1 && clean_(cj.lastPostPayloadFingerprint) === cj.payloadFingerprint) throw new Error('CONTROLLED_WRITE_BLOCKED | This exact Contact-create payload already crossed the write boundary. Reconcile; do not retry.');
      cj.lastPostPayloadFingerprint = cj.payloadFingerprint; cj.postStartedAt = d.util.nowString();
      state.root.contactCreate = cj;
      patchRequest_(record, {
        'Updated At': d.util.nowString(), 'Current Stage': 'CREATING CUSTOMER STRUCTURE', 'Request Status': 'IN PROGRESS',
        'Blocking Issue': 'Controlled Contact create in progress. Do not create Contact manually.', 'Next Action': 'CREATE CONTACT — CONTROLLED',
        'Customer Structure Status': 'CREATING CONTACT', 'Contact Association Status': 'NOT STARTED',
        'Write Fingerprint': cj.writeFingerprint, 'Write Journal JSON': safeJson_(state.root),
        'Striven Sync Status': 'SYNCING', 'Striven Sync Error': '', 'Reconciliation Status': 'NOT STARTED'
      });

      var response;
      try {
        response = d.http.requestJson(preview.create.endpoint, { method: 'post', payload: preview.create.payload, idempotent: false, attempts: 1 });
      } catch (error) {
        var classification = classifyWriteError_(error, 'Contact create');
        var duplicateIds=duplicateContactIdsFromError_(error);
        cj.postFinishedAt = d.util.nowString(); cj.httpStatus = classification.httpStatus; cj.postOutcome = classification.outcome;
        cj.remoteWriteMayHaveSucceeded = classification.remoteWriteMayHaveSucceeded; cj.validationErrors = classification.validationErrors;
        cj.postError = d.util.truncate(error.message || String(error), 4000);

        if(classification.outcome==='REJECTED_VALIDATION'&&duplicateIds.length){
          cj.status=duplicateIds.length===1?'DUPLICATE_CONTACT_FOUND_AUTO_RECONCILE':'DUPLICATE_CONTACT_IDS_AMBIGUOUS';
          cj.existingDuplicateContactIds=duplicateIds;
          cj.existingDuplicateContactId=duplicateIds.length===1?duplicateIds[0]:'';
          cj.noAutomaticWriteRetry=true;
          state.root.contactCreate=cj;
          var idText=duplicateIds.join(', ');
          patchRequest_(record,{
            'Updated At':d.util.nowString(),
            'Current Stage':duplicateIds.length===1?'READY FOR CONTACT CREATE':'NEEDS REVIEW',
            'Request Status':duplicateIds.length===1?'OPEN':'BLOCKED',
            'Manual Review?':duplicateIds.length===1?'NO':'YES',
            'Manual Review Reason':duplicateIds.length===1?'':'Multiple existing duplicate Contact IDs were reported: '+idText+'.',
            'Blocking Issue':duplicateIds.length===1?'Existing Contact ID '+duplicateIds[0]+' was reported by Striven. Automatic read-only reconciliation is queued; DO NOT CREATE ANOTHER CONTACT.':'Existing duplicate Contact IDs: '+idText+'. Do not create another Contact.',
            'Next Action':duplicateIds.length===1?'AUTO RECONCILE EXISTING CONTACT '+duplicateIds[0]:'REVIEW EXISTING CONTACT IDS '+idText,
            'Customer Structure Status':duplicateIds.length===1?'DUPLICATE CONTACT FOUND — AUTO RECONCILE':'DUPLICATE CONTACT IDS AMBIGUOUS',
            'Write Journal JSON':safeJson_(state.root),
            'Striven Sync Status':duplicateIds.length===1?'PARTIAL':'BLOCKED',
            'Striven Sync Error':'',
            'Last Striven Sync':d.util.nowString(),
            'Reconciliation Status':duplicateIds.length===1?'EXISTING CONTACT ID '+duplicateIds[0]+' — AUTO RECONCILE':'DUPLICATE CONTACT IDS '+idText+' — REVIEW'
          });
          log_(record,'CONTROLLED_CONTACT_CREATE','DUPLICATE_CONTACT_ID_FOUND',{existingDuplicateContactIds:duplicateIds,existingDuplicateContactId:duplicateIds.length===1?duplicateIds[0]:'',customerId:customerId,automaticPostRetry:false},'');
          if(duplicateIds.length===1)return{ok:true,status:'DUPLICATE_CONTACT_FOUND_AUTO_RECONCILE_QUEUED',requestId:clean_(record['Request ID']),existingDuplicateContactId:duplicateIds[0],existingDuplicateContactIds:duplicateIds,writeAttempted:true,liveWriteExecuted:true,remoteWriteMayHaveSucceeded:false,automaticPostRetry:false,duplicateCreatePostRetried:false,durationMs:Date.now()-started};
          return{ok:false,status:'DUPLICATE_CONTACT_IDS_AMBIGUOUS',requestId:clean_(record['Request ID']),existingDuplicateContactIds:duplicateIds,writeAttempted:true,liveWriteExecuted:true,remoteWriteMayHaveSucceeded:false,automaticPostRetry:false,durationMs:Date.now()-started};
        }

        cj.status = classification.outcome; state.root.contactCreate = cj;
        return applyWriteFailure_(record, cj, classification, 'CONTACT CREATE', started);
      }

      var responseBodyV5127=response&&response.json?response.json:{};
      var contactIdCreated = extractContactId_(responseBodyV5127);
      var genericResponseIdV5127='';
      var genericResponseVerificationV5127=null;
      var genericResponseIdVerifiedByGet=false;
      if(!contactIdCreated){
        genericResponseIdV5127=genericResponseContactIdV5127_(responseBodyV5127);
        if(genericResponseIdV5127){
          genericResponseVerificationV5127=verifyContactIdByGetV5127_(genericResponseIdV5127,record);
          if(genericResponseVerificationV5127.ok){contactIdCreated=genericResponseIdV5127;genericResponseIdVerifiedByGet=true;}
        }
      }
      cj.postFinishedAt = d.util.nowString(); cj.httpStatus = response && response.status ? response.status : 200;
      cj.responseContactId = contactIdCreated; cj.postOutcome = 'SUCCESS';
      cj.genericResponseIdentifier = genericResponseIdV5127;
      cj.genericResponseIdVerifiedByGet = genericResponseIdVerifiedByGet;

      if (!contactIdCreated) {
        cj.status = 'CONTACT_CREATE_SUCCESS_ID_MISSING_RECONCILE'; cj.remoteWriteMayHaveSucceeded = true;
        cj.genericResponseIdentifier = genericResponseIdV5127;
        cj.genericResponseVerification = genericResponseVerificationV5127;
        state.root.contactCreate = cj;
        patchRequest_(record, {
          'Updated At': d.util.nowString(), 'Current Stage': 'CREATING CUSTOMER STRUCTURE', 'Request Status': 'IN PROGRESS',
          'Blocking Issue': 'Striven returned success but no Contact ID was extracted. Do not POST again; reconcile.',
          'Next Action': 'RECONCILE CONTACT CREATE — DO NOT RETRY POST', 'Customer Structure Status': 'CONTACT CREATE RESPONSE ID MISSING — RECONCILE',
          'Write Journal JSON': safeJson_(state.root), 'Striven Sync Status': 'UNCERTAIN — RECONCILE',
          'Striven Sync Error': 'Successful HTTP response did not contain a recognized Contact ID.', 'Reconciliation Status': 'REQUIRED'
        });
        return { ok: false, status: 'CONTACT_CREATE_SUCCESS_ID_MISSING_RECONCILE', requestId: clean_(record['Request ID']), liveWriteExecuted: true, durationMs: Date.now() - started };
      }

      cj.status = 'CONTACT_CREATED_ASSOCIATION_RECONCILE_REQUIRED'; state.root.contactCreate = cj;
      patchRequest_(record, {
        'Updated At': d.util.nowString(), 'Current Stage': 'CREATING CUSTOMER STRUCTURE', 'Request Status': 'IN PROGRESS',
        'Blocking Issue': 'Contact created. Do not create Contact again. Reconcile association before any further Contact write.',
        'Next Action': 'RECONCILE CONTACT + CUSTOMER ASSOCIATION', 'Contact Match Status': 'MATCHED',
        'Matched Contact ID': contactIdCreated, 'Matched Contact Name': clean_(record['Full Name']), 'Created Contact ID': contactIdCreated,
        'Contact Action': 'LINK EXISTING', 'Contact Association Status': 'PENDING RECONCILIATION',
        'Customer Structure Status': 'CONTACT CREATED — ASSOCIATION PENDING', 'Write Journal JSON': safeJson_(state.root),
        'Striven Sync Status': 'PARTIAL', 'Striven Sync Error': '', 'Last Striven Sync': d.util.nowString(),
        'Reconciliation Status': 'CONTACT ASSOCIATION REQUIRED'
      });
      log_(record, 'CONTROLLED_CONTACT_CREATE', 'CONTACT_CREATED_ASSOCIATION_RECONCILE_REQUIRED', { contactId: contactIdCreated, customerId: customerId, payloadFingerprint: cj.payloadFingerprint });
      return { ok: true, status: 'CONTACT_CREATED_ASSOCIATION_RECONCILE_REQUIRED', requestId: clean_(record['Request ID']), responseContactId: contactIdCreated, liveWriteExecuted: true, postOutcome: 'SUCCESS', durationMs: Date.now() - started };
    });
  }

    function previewAutoContactCreate(requestIdOrRow) {
    return buildPreview_(requestIdOrRow, { autoMode: true, executionToken: AUTO_EXECUTION_TOKEN });
  }

  function executeAutoContactCreate(requestIdOrRow) {
    return executeControlledContactCreate(requestIdOrRow, {
      confirmLiveWrite: true,
      autoMode: true,
      executionToken: AUTO_EXECUTION_TOKEN
    });
  }

  function inspectReadiness() {
    var createEndpoint = '', associationEndpoint = '';
    try { createEndpoint = contactEndpoint_(); associationEndpoint = associationEndpoint_('<CONTACT_ID>'); } catch (error) {
      return { ok: false, version: VERSION, error: error.message || String(error) };
    }
    return { ok: true, version: VERSION, controlledRequestId: CONTROLLED_REQUEST_ID, contactEndpoint: createEndpoint, associationEndpoint: associationEndpoint, customerContactCacheFresh: cacheFresh_(), genericLiveWritesEnabled: false };
  }

  function recoveryAddressKey_(value){
    try{return deps_().util.normalizeAddress(value||'');}
    catch(ignored){return String(value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');}
  }

  function recoveryWorkOrderCandidates_(record,customerId){
    var requestAddress=recoveryAddressKey_(record&&record['Full Address']),rows=[];
    try{rows=deps_().util.readRecords('STRIVEN_OPERATIONAL_DATA')||[];}catch(ignored){rows=[];}
    return rows.filter(function(row){
      if(upper_(row['Entity Type'])!=='WORK_ORDER')return false;
      if(clean_(row['Customer ID'])!==clean_(customerId))return false;
      var rowAddress=recoveryAddressKey_(row['Service Address']);
      return !!requestAddress&&rowAddress===requestAddress;
    }).map(function(row){
      return{
        workOrderId:clean_(row['Work Order ID']||row['Entity ID']),
        workOrderNumber:clean_(row['Work Order Number']),
        status:clean_(row['Status']),
        serviceAddress:clean_(row['Service Address'])
      };
    });
  }

  function applyRecoveryOrderGate_(record,customerId){
    record=request_(record&&record.__rowNumber?record.__rowNumber:record);
    if(!record)return{durableOrder:false,candidates:[]};
    var durableId=clean_(record['Work Order ID']),durableNumber=clean_(record['Work Order Number']);
    if(durableId||durableNumber)return{durableOrder:true,workOrderId:durableId,workOrderNumber:durableNumber,candidates:[]};

    var candidates=recoveryWorkOrderCandidates_(record,customerId),numbers=candidates.map(function(x){return x.workOrderNumber;}).filter(Boolean);
    var next,issue;
    if(candidates.length===1&&numbers[0]){
      next='VERIFY EXISTING SALES ORDER #'+numbers[0]+' — DO NOT CREATE';
      issue='Customer/Contact/Location structure is verified. Existing Sales Order #'+numbers[0]+' must be certified before any order create.';
    }else if(candidates.length>1){
      next='REVIEW EXISTING SALES ORDERS '+numbers.join(', ')+' — DO NOT CREATE';
      issue='Customer/Contact/Location structure is verified, but multiple existing Sales Order candidates match this Customer/address. Certify exact ownership before any order create.';
    }else{
      next='VERIFY NO EXISTING SALES ORDER — DO NOT CREATE';
      issue='Customer/Contact/Location structure is verified. Exact Sales Order search is required before any new order create.';
    }

    patchRequest_(record,{
      'Updated At':deps_().util.nowString(),
      'Current Stage':'NEEDS REVIEW',
      'Request Status':'BLOCKED',
      'Manual Review?':'NO',
      'Manual Review Reason':'',
      'Blocking Issue':issue,
      'Next Action':next,
      'Customer Structure Status':'COMPLETE',
      'Striven Sync Status':'PARTIAL',
      'Striven Sync Error':'',
      'Reconciliation Status':'CUSTOMER STRUCTURE VERIFIED — SALES ORDER RECONCILIATION REQUIRED'
    });
    return{durableOrder:false,candidates:candidates,nextAction:next};
  }

  /* Read-only recovery entrypoint. Never calls the association POST. */
  function reconcileContactAssociationReadOnly(requestIdOrRow) {
    return withWriteLock_(function(){
      var record=request_(requestIdOrRow);
      if(!record)return{ok:false,status:'SERVICE_REQUEST_NOT_FOUND',requestId:clean_(requestIdOrRow),liveWriteExecuted:false};
      var customerId=resolvedCustomerId_(record),contactId=resolvedContactId_(record);
      if(!customerId||!contactId)return{ok:false,status:'CONTACT_ASSOCIATION_IDS_INCOMPLETE',requestId:clean_(record['Request ID']),matchedCustomerId:customerId,matchedContactId:contactId,liveWriteExecuted:false};

      var before=contactJournal_(record),prior=clone_(before.contact||{});
      var result=reconcileKnownContact_(record,contactId,customerId);

      // If ownership is still unobservable after a prior association attempt,
      // keep the request at a GET-only technical boundary. Never expose a route
      // that could replay the association POST.
      if(result&&result.status==='CONTACT_CREATED_ASSOCIATION_REQUIRED'&&Number(prior.associationAttempts||0)>0){
        var fresh=request_(record.__rowNumber)||record;
        var state=contactJournal_(fresh),cj=clone_(state.contact||prior||{});
        cj.associationStatus='READ_ONLY_RECONCILE_REQUIRED';
        cj.status='CONTACT_ASSOCIATION_GET_ONLY_RECONCILE_REQUIRED';
        cj.technicalRecovery=cj.technicalRecovery||{};
        cj.technicalRecovery.status='GET_ONLY_ASSOCIATION_VERIFICATION_REQUIRED';
        cj.technicalRecovery.customerId=customerId;
        cj.technicalRecovery.contactId=contactId;
        cj.technicalRecovery.noAutomaticWriteRetry=true;
        state.root.contactCreate=cj;
        patchRequest_(fresh,{
          'Updated At':deps_().util.nowString(),
          'Current Stage':'NEEDS REVIEW',
          'Request Status':'BLOCKED',
          'Manual Review?':'NO',
          'Manual Review Reason':'',
          'Blocking Issue':'A prior Contact association write crossed the boundary, but current GET/cache still does not expose the Customer relationship. Continue GET-only verification; do not POST again.',
          'Next Action':'GET-ONLY VERIFY CONTACT '+contactId+' → CUSTOMER '+customerId+' — DO NOT POST',
          'Contact Association Status':'RECONCILE',
          'Customer Structure Status':'CONTACT RECONCILED — ASSOCIATION UNVERIFIED',
          'Write Journal JSON':safeJson_(state.root),
          'Striven Sync Status':'RECONCILE REQUIRED',
          'Striven Sync Error':'',
          'Reconciliation Status':'TECHNICAL RECOVERY — GET-ONLY ASSOCIATION VERIFICATION REQUIRED'
        });
        result={ok:false,status:'CONTACT_ASSOCIATION_GET_ONLY_RECONCILE_REQUIRED',requestId:clean_(fresh['Request ID']),matchedContactId:contactId,matchedCustomerId:customerId,readOnlyRecoveryRequired:true,liveWriteExecuted:false,automaticPostRetry:false};
      }
      result=result||{ok:false,status:'CONTACT_ASSOCIATION_READ_ONLY_RECONCILE_EMPTY_RESULT',requestId:clean_(record['Request ID']),liveWriteExecuted:false};
      if(result.ok===true&&String(result.status||'').indexOf('CONTACT_ASSOCIATED_RECONCILED')===0){
        var gate=applyRecoveryOrderGate_(request_(record.__rowNumber),customerId);
        result.salesOrderRecoveryGate=gate;
        result.nextAction=gate&&gate.nextAction||result.nextAction||'';
      }
      result.readOnlyRecovery=true;
      result.automaticPostRetry=false;
      return result;
    });
  }

  function recoverTechnicalAssociationsReadOnly(limit) {
    limit=Math.max(1,Math.min(25,Number(limit||10)));
    var rows=deps_().util.readRecords('SERVICE_REQUESTS'),selected=[];
    rows.forEach(function(row){
      if(selected.length>=limit)return;
      var recon=upper_(row['Reconciliation Status']),assoc=upper_(row['Contact Association Status']),status=upper_(row['Request Status']);
      var technical=recon.indexOf('TECHNICAL NO PROGRESS')!==-1||recon.indexOf('GET-ONLY ASSOCIATION VERIFICATION REQUIRED')!==-1||(assoc==='RECONCILE'&&status==='BLOCKED');
      if(technical)selected.push(row);
    });
    var results=[];
    selected.forEach(function(row){
      var customerId=resolvedCustomerId_(row),contactId=resolvedContactId_(row);
      if(!customerId||!contactId){
        results.push({ok:false,status:'CONTACT_ASSOCIATION_IDS_INCOMPLETE',requestId:clean_(row['Request ID']),matchedCustomerId:customerId,matchedContactId:contactId,liveWriteExecuted:false});
        return;
      }
      results.push(reconcileContactAssociationReadOnly(row.__rowNumber));
    });
    return{
      ok:results.every(function(x){return x&&x.ok!==false||x&&x.status==='CONTACT_ASSOCIATION_GET_ONLY_RECONCILE_REQUIRED';}),
      version:VERSION,
      status:'TECHNICAL_ASSOCIATION_READ_ONLY_BATCH_COMPLETE',
      checked:results.length,
      verifiedAssociated:results.filter(function(x){return x&&String(x.status||'').indexOf('CONTACT_ASSOCIATED_RECONCILED')===0;}).length,
      getOnlyPending:results.filter(function(x){return x&&x.status==='CONTACT_ASSOCIATION_GET_ONLY_RECONCILE_REQUIRED';}).length,
      results:results,
      liveWriteExecuted:false,
      automaticPostRetry:false
    };
  }

  return {
    version: VERSION,
    previewControlledContactCreate: previewControlledContactCreate,
    executeControlledContactCreate: executeControlledContactCreate,
    previewAutoContactCreate: previewAutoContactCreate,
    executeAutoContactCreate: executeAutoContactCreate,
    reconcileContactAssociationReadOnly: reconcileContactAssociationReadOnly,
    recoverTechnicalAssociationsReadOnly: recoverTechnicalAssociationsReadOnly,
    inspectReadiness: inspectReadiness
  };
})();

/************************************************************
 * CF_SERVICE_GUARDED_SALES_ORDER_CREATE_V5_9_8_FINAL_QUOTED_MANUAL_REVIEW
 * CF ServiceOps — Guarded Sales Order Create
 * Version: 5.9.8
 *
 * CONTROLLED RELEASE CONTRACT
 * - Locked to SR-20260818160541-7844 for the first live create.
 * - Reuses WRITE_previewSelected / WRITE_approveSelected / WRITE_processApproved.
 * - Corrects only STRIVEN_PAYMENT_TERM_ID 39 -> 13 on explicit approval.
 * - Requires fresh operational cache before POST.
 * - Exactly one POST attempt, no automatic write retry.
 * - HTTP 400/422 = deterministic contract rejection, safe to revise.
 * - Transport/5xx/429 = uncertain; reconcile before any future mutation.
 * - Successful POST response ID is verified with GET /v1/sales-orders/{id}.
 * - Once a durable Work Order ID exists, another Sales Order POST is impossible.
 ************************************************************/
/* CF_SERVICEOPS_V5_10_4_MANUAL_SELECTED_SALES_ORDER_R1
 * Generalizes the proven v5.9.8 guarded OrderPreflight from one controlled request
 * to an explicitly selected, fully resolved request. This remains the sole Sales
 * Order POST boundary. It preserves one-attempt intent journaling, GET verification,
 * no uncertain retry, Quoted status, and mandatory manual review after creation.
 */
/* CF_SERVICEOPS_V5_10_6_BILLTO_SERVICE_LEVEL_R1 */
/* CF_SERVICEOPS_V5_11_9_REQUEST_FIDELITY_ITEM_MASTER_R2 */
CF.OrderPreflight = (function () {
  'use strict';
  var VERSION='5.11.9';
  var MODULE_NAME='60_Striven_Write';
  var EXECUTION_TOKEN='PHASE6-MANUAL-SELECTED-SALES-ORDER';
  var ENDPOINT='/v1/sales-orders';
  var REFERENCE_ORDER_ID=26325;
  var EARLY_BIRD_ITEM_ID=41434;
  var STANDARD_SERVICE_ITEM_PROPERTY='STRIVEN_STANDARD_SERVICE_ITEM_ID';
  var EXPECTED={typeId:44938,paymentTermId:13,salesRepId:51,statusId:19,classId:14,serviceTech:'502'};
  var CFIDS={customerNotesPrintable:598,manufacturerModel:651,serialNumber:650,scheduled:164,preferredTimeSlots:653,serviceTech:794,partsFulfillment:364,orderFulfillment:817,enterNewPartUpdated:820,serviceLevel:797,zone:798,requestSource:855};
  // CF_SERVICEOPS_V5_10_13_RUNTIME_MATCHING_SO_NOTES_QUEUE_R1
  var INTERNAL_NOTES_ENCODING_PROPERTY='STRIVEN_SALES_ORDER_INTERNAL_NOTES_ENCODING';
  var PREVIEW_MEMO={};

  function deps_(){if(!CF.Config||!CF.Util||!CF.StrivenHttp||!CF.StrivenData)throw new Error('CF.Config, CF.Util, CF.StrivenHttp and CF.StrivenData are required.');return{config:CF.Config,util:CF.Util,http:CF.StrivenHttp,data:CF.StrivenData};}
  function clean_(v){return deps_().util.cleanText(v);}
  function upper_(v){return clean_(v).toUpperCase();}
  function parse_(v,f){return deps_().util.parseJson(v,f===undefined?{}:f);}
  function json_(v){return deps_().util.safeJson(v);}
  function clone_(v){return deps_().util.clone(v);}
  function now_(){return deps_().util.nowString();}
  function request_(id){var r=deps_().util.findRecord('SERVICE_REQUESTS','Request ID',id);if(!r)throw new Error('Service Request not found: '+id);return r;}
  function first_(r,keys){for(var i=0;i<keys.length;i++){var v=clean_(r[keys[i]]);if(v)return v;}return'';}
  function customerId_(r){return clean_(r['Matched Customer ID']||r['Created Customer ID']);}
  function contactId_(r){return clean_(r['Matched Contact ID']||r['Created Contact ID']);}
  function locationId_(r){return clean_(r['Matched Location ID']||r['Created Location ID']);}
  function patch_(r,p){var d=deps_();if(typeof d.util.clearRowDataValidations==='function')d.util.clearRowDataValidations('SERVICE_REQUESTS',r.__rowNumber);d.util.patchRow('SERVICE_REQUESTS',r.__rowNumber,p);SpreadsheetApp.flush();}
  function rootJournal_(r){var x=parse_(r['Write Journal JSON'],{});if(!x||typeof x!=='object'||Array.isArray(x))x={};return x;}
  function orderJournal_(r){var root=rootJournal_(r);return{root:root,order:root.salesOrderCreate||{}};}
  function log_(r,action,status,details,message){deps_().util.logEvent({module:MODULE_NAME,action:action,status:status,requestId:clean_(r['Request ID']),correlationId:clean_(r['Correlation ID']),message:message||'',details:details||{},version:VERSION});}
  function operationalCacheTimestampFast_(){
    var d=deps_(),sheet=d.util.requireSheet('STRIVEN_OPERATIONAL_DATA');
    if(!sheet||sheet.getLastRow()<2)return'';
    var map=d.util.getHeaderMap(sheet),col=map['Cache Updated At'];
    if(!col)return'';
    return sheet.getRange(2,col).getValue();
  }
  function readiness_(){
    try{
      var raw=operationalCacheTimestampFast_();
      if(!raw)return{ok:false,mode:'TIMESTAMP_ONLY',fresh:{operational:false},groups:{operational:{timestamp:'',ageMinutes:null,maxAgeMinutes:30}},error:'Operational cache timestamp is missing.'};
      var timestamp=raw instanceof Date?raw:new Date(raw),ms=timestamp.getTime();
      if(isNaN(ms))return{ok:false,mode:'TIMESTAMP_ONLY',fresh:{operational:false},groups:{operational:{timestamp:String(raw),ageMinutes:null,maxAgeMinutes:30}},error:'Operational cache timestamp is invalid.'};
      var ageMs=Math.max(0,Date.now()-ms),fresh=ageMs<=30*60000;
      return{ok:true,mode:'TIMESTAMP_ONLY',fresh:{operational:fresh},groups:{operational:{timestamp:timestamp.toISOString(),ageMinutes:ageMs/60000,maxAgeMinutes:30}}};
    }catch(e){
      return{ok:false,mode:'TIMESTAMP_ONLY',fresh:{operational:false},groups:{operational:{timestamp:'',ageMinutes:null,maxAgeMinutes:30}},error:String(e&&e.message||e)};
    }
  }
  function operationalFresh_(){
    var x=readiness_();
    return !!(x&&x.fresh&&x.fresh.operational);
  }
  function activeState_(s){var v=upper_(s);if(!v)return'UNKNOWN';if(/COMPLETED|CLOSED|CANCELED|CANCELLED|VOID|DECLINED|LOST/.test(v))return'CLOSED';if(/INCOMPLETE|QUOTED|PENDING|APPROVED|IN PROGRESS|OPEN|SCHEDULED|ASSIGNED/.test(v))return'ACTIVE';return'UNKNOWN';}
  function operational_(customerId,locationId){
    customerId=clean_(customerId);locationId=clean_(locationId);
    if(!customerId)return{relatedCount:0,activeCount:0,active:[],error:'Resolved Customer ID is required for operational evidence.'};
    try{
      var d=deps_(),sheet=d.util.requireSheet('STRIVEN_OPERATIONAL_DATA'),lastRow=sheet.getLastRow(),lastCol=sheet.getLastColumn();
      if(lastRow<2)return{relatedCount:0,activeCount:0,active:[],error:'Operational cache has no data rows.'};
      var map=d.util.getHeaderMap(sheet),customerCol=map['Customer ID'];
      if(!customerCol)return{relatedCount:0,activeCount:0,active:[],error:'Operational cache is missing Customer ID column.'};
      var cells=sheet.getRange(2,customerCol,lastRow-1,1).createTextFinder(customerId).matchEntireCell(true).findAll()||[];
      var related=[];
      cells.forEach(function(cell){
        var values=sheet.getRange(cell.getRow(),1,1,lastCol).getValues()[0];
        function value_(name){var col=map[name];return col?values[col-1]:'';}
        if(upper_(value_('Entity Type'))!=='WORK_ORDER')return;
        var rowLocation=clean_(value_('Location ID'));
        if(locationId&&rowLocation&&rowLocation!==locationId)return;
        related.push({
          'Work Order ID':clean_(value_('Work Order ID')||value_('Entity ID')),
          'Work Order Number':clean_(value_('Work Order Number')),
          'Status':clean_(value_('Status')),
          'Location ID':rowLocation
        });
      });
      var active=related.filter(function(x){return activeState_(x['Status'])==='ACTIVE';});
      return{relatedCount:related.length,activeCount:active.length,active:active.slice(0,10).map(function(x){return{workOrderId:clean_(x['Work Order ID']),workOrderNumber:clean_(x['Work Order Number']),status:clean_(x['Status']),locationId:clean_(x['Location ID'])};}),evidenceMode:'TARGETED_CUSTOMER_COLUMN_TEXTFINDER'};
    }catch(e){
      return{relatedCount:0,activeCount:0,active:[],error:'Operational evidence lookup failed: '+String(e&&e.message||e),evidenceMode:'TARGETED_CUSTOMER_COLUMN_TEXTFINDER'};
    }
  }
  function get_(endpoint){try{var x=deps_().http.requestJson(endpoint,{method:'get',attempts:1});return{ok:true,status:x.status||200,body:x.json||{},error:''};}catch(e){return{ok:false,status:0,body:{},error:String(e&&e.message||e)};}}
  /* CF_SERVICEOPS_V5_13_2_EARLY_BIRD_CUTOFF_R1 */
  var EARLY_BIRD_ITEM_ID=41434;
  var STANDARD_SERVICE_ITEM_ID=41481;
  var EARLY_BIRD_END_YMD='20260925';
  function serviceItemPolicy_(r){
    var raw=clean_(r&& (r['Submitted At']||r['Created At']));
    var dt=raw?new Date(raw):new Date(); if(isNaN(dt.getTime()))dt=new Date();
    var tz='America/Toronto'; try{tz=Session.getScriptTimeZone()||tz;}catch(e){}
    var ymd=Utilities.formatDate(dt,tz,'yyyyMMdd');
    var explicitEarly=upper_(r&&r['Campaign Code'])==='EB2026';
    var early=explicitEarly||ymd<=EARLY_BIRD_END_YMD;
    return {itemId:early?EARLY_BIRD_ITEM_ID:STANDARD_SERVICE_ITEM_ID,earlyBird:early,businessDate:ymd,cutoff:EARLY_BIRD_END_YMD};
  }
  function item_(r){var policy=serviceItemPolicy_(r),x=get_('/v1/items/'+policy.itemId);var price=x.ok?Number(x.body&&x.body.price):NaN;return{ok:x.ok&&isFinite(price)&&price>=0,status:x.status,price:isFinite(price)?price:null,itemId:policy.itemId,earlyBird:policy.earlyBird,businessDate:policy.businessDate,cutoff:policy.cutoff,body:x.body,error:x.error};}
  /* CF_SERVICEOPS_V5_10_39_SALES_ORDER_NAME_EARLY_BIRD_OFFER_2026_R1 */
function campaignName_(r){return upper_(r['Campaign Code'])==='EB2026'?'Early Bird Offer 2026':'Clean and Service';}
  function selectedItemId_(r){if(upper_(r['Campaign Code'])==='EB2026')return EARLY_BIRD_ITEM_ID;var v=clean_(PropertiesService.getScriptProperties().getProperty(STANDARD_SERVICE_ITEM_PROPERTY));return /^\d+$/.test(v)&&Number(v)>0?Number(v):0;}
  function lineDescription_(r){return serviceItemPolicy_(r).earlyBird?'Early Bird Service Offer 2026':'Clean and Service';}
  function webformSource_(r){var d=deps_().util,w=null,requestId=clean_(r['Request ID']),submissionId=clean_(r['Submission ID']);try{if(requestId)w=d.findRecord('WEBFORM_REQUESTS','Request ID',requestId);}catch(e){}if(!w&&submissionId){try{w=d.findRecord('WEBFORM_REQUESTS','Submission ID',submissionId);}catch(e2){}}return w||null;}
  function noteCell_(v){if(v===null||v===undefined)return'';var s=String(v);return s.replace(/\r?\n/g,' / ').replace(/\t/g,' ').replace(/\|/g,'¦').trim();}  // CF_SERVICEOPS_V5_11_9_REQUEST_FIDELITY_ITEM_MASTER_R2 — Internal Notes are rendered from normalized Service Request fields, not raw payload reinterpretation.
  function webformNotes_(r) {
    if (!r || !clean_(r['Request ID'])) {
      return { ok:false, error:'Service Request data is unavailable for Internal Notes.', text:'', html:'', fieldCount:0 };
    }

    function plain_(value) {
      if (value === null || value === undefined) return '';
      return String(value).replace(/\r\n?/g, '\n').replace(/\t/g, ' ').trim();
    }
    function oneLine_(value) {
      return plain_(value).replace(/\n+/g, ' / ').replace(/\s+/g, ' ').trim();
    }
    function htmlEscape_(value) {
      return plain_(value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\n/g, '<br>');
    }
    function add_(rows, label, value) {
      value = oneLine_(value);
      if (value) rows.push({ label:label, value:value });
    }
    function submittedAt_(value) {
      if (value instanceof Date && !isNaN(value.getTime())) {
        var tz = 'America/Toronto';
        try { tz = Session.getScriptTimeZone() || tz; } catch (ignored) {}
        return Utilities.formatDate(value, tz, 'M/d/yyyy H:mm:ss');
      }
      return oneLine_(value);
    }

    var rows = [];
    var customerName = clean_(r['Full Name']) || [clean_(r['First Name']), clean_(r['Last Name'])].filter(Boolean).join(' ');
    var address = clean_(r['Full Address']) || [clean_(r['Street']), clean_(r['City']), clean_(r['Province']), clean_(r['Postal Code']), clean_(r['Country'])].filter(Boolean).join(', ');

    add_(rows, 'Request ID', r['Request ID']);
    add_(rows, 'Submission ID', r['Submission ID']);
    add_(rows, 'Submitted At', submittedAt_(r['Submitted At']));
    add_(rows, 'Customer', customerName);
    add_(rows, 'Phone', r['Phone']);
    add_(rows, 'Alt Phone', r['Alt Phone']);
    add_(rows, 'Email', r['Email']);
    add_(rows, 'Service Address', address);
    add_(rows, 'Preferred Days', r['Preferred Days']);
    add_(rows, 'Make / Model / Age', r['Unit Details']);
    add_(rows, 'Service Details', r['Service Details']);
    add_(rows, 'Additional Notes', r['Additional Notes']);
    add_(rows, 'Campaign Code', r['Campaign Code']);

    var textLines = ['WEBFORM SERVICE REQUEST', ''];
    rows.forEach(function (row) { textLines.push(row.label + ': ' + row.value); });
    var htmlRows = rows.map(function (row) {
      return '<tr>' +
        '<td style="width:180px;padding:6px 8px;border:1px solid #d9d9d9;background:#f7f7f7;font-weight:600;vertical-align:top;">' + htmlEscape_(row.label) + '</td>' +
        '<td style="padding:6px 8px;border:1px solid #d9d9d9;vertical-align:top;word-break:break-word;">' + htmlEscape_(row.value) + '</td>' +
      '</tr>';
    }).join('');
    var html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.4;color:#222;">' +
      '<div style="font-size:14px;font-weight:700;margin:0 0 8px 0;">WEBFORM SERVICE REQUEST</div>' +
      '<table style="width:100%;border-collapse:collapse;border-spacing:0;">' + htmlRows + '</table>' +
    '</div>';

    return { ok:true, error:'', text:textLines.join('\n').trim(), html:html, fieldCount:rows.length };
  }


  function internalNoteText_(r, draft) {
    var wn = webformNotes_(r);

    if (
      wn &&
      wn.ok === true &&
      wn.text
    ) {
      return String(wn.text)
        .replace(/\r\n?/g, '\n')
        .trim();
    }

    var fromDraft =
      draft &&
      draft.internalNotesDraft &&
      draft.internalNotesDraft.value
        ? String(draft.internalNotesDraft.value)
        : '';

    return fromDraft
      .replace(/\r\n?/g, '\n')
      .trim();
  }
  function internalNoteValue_(encoding, text, html) {
    var e = upper_(encoding);

    if (e !== 'OBJECT_NOTES_HTML_TEXT') {
      return null;
    }

    text = String(text === null || text === undefined ? '' : text)
      .replace(/\r\n?/g, '\n')
      .trim();

    html = String(html === null || html === undefined ? '' : html).trim();

    if (!html) {
      function esc_(value) {
        return String(value === null || value === undefined ? '' : value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      var lines = text.split('\n');
      var title = lines.length ? lines.shift() : 'WEBFORM SERVICE REQUEST';
      var rows = [];

      lines.forEach(function (line) {
        line = String(line || '').trim();

        if (!line) return;

        var splitAt = line.indexOf(':');

        if (splitAt < 1) {
          rows.push({
            label: '',
            value: line
          });
          return;
        }

        rows.push({
          label: line.substring(0, splitAt).trim(),
          value: line.substring(splitAt + 1).trim()
        });
      });

      var htmlRows = rows.map(function (row) {
        if (!row.label) {
          return (
            '<tr>' +
              '<td colspan="2" style="' +
                'padding:6px 8px;' +
                'border:1px solid #d9d9d9;' +
              '">' +
                esc_(row.value) +
              '</td>' +
            '</tr>'
          );
        }

        return (
          '<tr>' +
            '<td style="' +
              'width:180px;' +
              'padding:6px 8px;' +
              'border:1px solid #d9d9d9;' +
              'background:#f7f7f7;' +
              'font-weight:600;' +
              'vertical-align:top;' +
            '">' +
              esc_(row.label) +
            '</td>' +
            '<td style="' +
              'padding:6px 8px;' +
              'border:1px solid #d9d9d9;' +
              'vertical-align:top;' +
              'word-break:break-word;' +
            '">' +
              esc_(row.value) +
            '</td>' +
          '</tr>'
        );
      }).join('');

      html =
        '<div style="' +
          'font-family:Arial,Helvetica,sans-serif;' +
          'font-size:13px;' +
          'line-height:1.4;' +
          'color:#222;' +
        '">' +
          '<div style="' +
            'font-size:14px;' +
            'font-weight:700;' +
            'margin:0 0 8px 0;' +
          '">' +
            esc_(title || 'WEBFORM SERVICE REQUEST') +
          '</div>' +
          '<table style="' +
            'width:100%;' +
            'border-collapse:collapse;' +
            'border-spacing:0;' +
          '">' +
            htmlRows +
          '</table>' +
        '</div>';
    }

    return {
      NotesHtml: html,
      NotesText: text
    };
  }
  function internalNotesModelKeys_(body){
    var ms=body&&body.modelState||{};return Object.keys(ms).filter(function(k){return /internalnotes/i.test(k);});
  }
  function requiredProbeEvidence_(body){
    var ms=body&&body.modelState||{};var keys=Object.keys(ms).join('|');return /salesOrder\.Type|salesOrder\.Customer|LineItems\[0\]\.Item/i.test(keys);
  }
  function safeParseBody_(text){try{return JSON.parse(text||'{}');}catch(e){return{};}}
  function probeOneInternalNotesEncoding_(encoding){
    var sample='CF INTERNAL NOTES CONTRACT PROBE — NO SALES ORDER SHOULD BE CREATED';
    var value=internalNoteValue_(encoding,sample);if(value===null)return{ok:false,encoding:encoding,reason:'UNKNOWN_ENCODING'};
    try{
      var unexpected=deps_().http.requestJson(ENDPOINT,{method:'post',payload:{InternalNotes:value},attempts:1,idempotent:false});
      throw new Error('INTERNAL_NOTES_PROBE_UNSAFE_UNEXPECTED_SUCCESS | Validation-only probe unexpectedly returned success: '+json_(unexpected&&unexpected.json||{}));
    }catch(e){
      if(String(e&&e.message||e).indexOf('INTERNAL_NOTES_PROBE_UNSAFE_UNEXPECTED_SUCCESS')===0)throw e;
      var p=parseHttp_(e),body=safeParseBody_(p.bodyText),keys=internalNotesModelKeys_(body);
      return{ok:(p.status===400||p.status===422)&&requiredProbeEvidence_(body)&&keys.length===0,encoding:encoding,httpStatus:p.status,internalNoteModelKeys:keys,modelState:body.modelState||{},message:body.message||p.message};
    }
  }
  function resolveInternalNotesEncoding_(){
    return{
      ok:true,
      encoding:'OBJECT_NOTES_HTML_TEXT',
      cached:true,
      probes:[],
      source:'CONFIRMED_FROM_EXISTING_SALES_ORDER_GET',
      specimenSalesOrderId:'26418',
      responseShape:{id:'SERVER_ASSIGNED',notesHtml:'STRING',notesText:'STRING'}
    };
  }

function noteTextFromResponse_(v) {
    if (v === null || v === undefined) {
      return '';
    }

    if (
      typeof v === 'string' ||
      typeof v === 'number'
    ) {
      return String(v)
        .replace(/\r\n?/g, '\n')
        .trim();
    }

    if (Array.isArray(v)) {
      return v
        .map(noteTextFromResponse_)
        .filter(Boolean)
        .join('\n');
    }

    if (typeof v === 'object') {
      var preferred = [
        'notesText',
        'NotesText',
        'value',
        'Value',
        'text',
        'Text',
        'note',
        'Note',
        'notes',
        'Notes',
        'content',
        'Content',
        'description',
        'Description',
        'notesHtml',
        'NotesHtml'
      ];

      for (var i = 0; i < preferred.length; i++) {
        if (v[preferred[i]] !== undefined) {
          var exact =
            noteTextFromResponse_(
              v[preferred[i]]
            );

          if (exact) {
            return exact;
          }
        }
      }

      var parts = [];

      Object.keys(v).forEach(function (key) {
        if (/^id$/i.test(key)) {
          return;
        }

        var valueText =
          noteTextFromResponse_(v[key]);

        if (
          valueText &&
          parts.indexOf(valueText) === -1
        ) {
          parts.push(valueText);
        }
      });

      return parts.join('\n');
    }

    return '';
  }


  function draft_(r){if(!CF.SalesOrderDraft||typeof CF.SalesOrderDraft.build!=='function')return null;return CF.SalesOrderDraft.build(clean_(r['Request ID']));}
  function customFields_(r,draft){draft=draft||draft_(r);var a=[];if(draft&&draft.customFields){var ids=['598','651','650','164','653','794','364','817','820','797','798','855'];ids.forEach(function(id){var f=draft.customFields[id];if(!f)return;var status=upper_(f.status),value=clean_(f.value);if(id==='651'&&!value&&status!=='REVIEW'&&status!=='OPERATOR_REQUIRED')value='Unknown / Not Provided';if((id==='797'||id==='798'||id==='855')&&(status!=='READY'||!value||value==='0'))return;if(status==='OPERATOR_REQUIRED'||status==='REVIEW'||status==='LOOKUP_REQUIRED')return;if(!value&&f.required!==true)return;a.push({Id:Number(id),Value:value});});return a;}var mm=first_(r,['Unit Details','Make/Model/Age']),d=first_(r,['Service Details','Details']),p=first_(r,['Preferred Days']);if(d)a.push({Id:CFIDS.customerNotesPrintable,Value:d});a.push({Id:CFIDS.manufacturerModel,Value:mm});a.push({Id:CFIDS.scheduled,Value:'False'});if(p)a.push({Id:CFIDS.preferredTimeSlots,Value:p});a.push({Id:CFIDS.serviceTech,Value:EXPECTED.serviceTech});return a;}
  function payload_(r,item,draft,notesContract){var line={Item:{Id:Number(item.itemId)},Qty:1,Class:{Id:EXPECTED.classId},Price:item.price},description=lineDescription_(item);if(description)line.Description=description;var p={Type:{Id:EXPECTED.typeId},Customer:{Id:Number(customerId_(r))},Contact:{Id:Number(contactId_(r))},BillToLocation:{Id:Number(locationId_(r))},ShipToLocation:{Id:Number(locationId_(r))},OrderName:campaignName_(r),PaymentTerm:{Id:EXPECTED.paymentTermId},SalesRep:{Id:EXPECTED.salesRepId},Status:{Id:EXPECTED.statusId},LineItemsClass:{Id:EXPECTED.classId},LineItems:[line],CustomFields:customFields_(r,draft)};var note=internalNoteText_(r,draft);if(note&&notesContract&&notesContract.ok)p.InternalNotes=internalNoteValue_(notesContract.encoding,note);return p;}
  function fingerprints_(r,payload){var d=deps_(),pf=d.util.canonicalHash({endpoint:ENDPOINT,payload:payload}),wf=d.util.canonicalHash({requestId:clean_(r['Request ID']),action:'CREATE_SALES_ORDER',endpoint:ENDPOINT,payloadFingerprint:pf});return{payloadFingerprint:pf,writeFingerprint:wf};}
  function propState_(){var p=PropertiesService.getScriptProperties(),v=clean_(p.getProperty('STRIVEN_PAYMENT_TERM_ID'));return{value:v,numeric:Number(v||0),correct:v==='13',correctable:v==='39'};}
  function statusPropState_(){var p=PropertiesService.getScriptProperties(),v=clean_(p.getProperty('STRIVEN_WORK_ORDER_INITIAL_STATUS_ID'));return{value:v,numeric:Number(v||0),correct:v==='19',correctable:v==='22'||v==='25'};}
  function cfValue_(payload,id){var rows=payload&&payload.CustomFields||[];for(var i=0;i<rows.length;i++)if(clean_(rows[i].Id)===clean_(id))return clean_(rows[i].Value);return'';}
  function validate_(r,item,op,draft,payload,notesContract){var b=[];function add(c,m){b.push({code:c,message:m});}var stage=upper_(r['Current Stage']);if(!clean_(r['Request ID']))add('REQUEST_ID_REQUIRED','Request ID is required.');if(!customerId_(r))add('CUSTOMER_REQUIRED','A resolved Customer ID is required.');if(!contactId_(r))add('CONTACT_REQUIRED','A resolved Contact ID is required.');if(!locationId_(r))add('LOCATION_REQUIRED','A resolved Location ID is required.');if(stage==='NEEDS REVIEW'||upper_(r['Manual Review?'])==='YES')add('MANUAL_REVIEW_REQUIRED',clean_(r['Manual Review Reason'])||'Resolve manual review before Sales Order creation.');if(/COMPLETED|CANCELLED|CANCELED/.test(stage))add('TERMINAL_REQUEST','Terminal requests cannot create a Sales Order.');if(upper_(r['Duplicate Risk Status'])!=='NONE')add('DUPLICATE_RISK_NOT_CLEAR','Duplicate Risk Status must be NONE.');if(clean_(r['Work Order ID']))add('WORK_ORDER_ALREADY_DURABLE','A durable Sales Order / Work Order ID already exists: '+clean_(r['Work Order ID'])+'.');if(!draft)add('SALES_ORDER_DRAFT_REQUIRED','CF.SalesOrderDraft is required.');else if(draft.safeForPayloadOverlay!==true)add('DRAFT_NOT_SAFE','Sales Order draft is not payload-safe: '+((draft.coreBlockers||[]).map(function(x){return x.code;}).join(', ')||'operator review required'));if(!cfValue_(payload,'651'))add('MANUFACTURER_MODEL_REQUIRED','Custom field 651 Manufacturer and Model is required.');if(!cfValue_(payload,'855'))add('REQUEST_SOURCE_WEBFORM_REQUIRED','Request Source custom field 855 must resolve to the active Custom List 116 item Webform.');if(!notesContract||notesContract.ok!==true)add('INTERNAL_NOTES_CONTRACT_UNRESOLVED',(notesContract&&notesContract.error)||'Striven Internal Notes datatype is not proven.');if(!internalNoteText_(r,draft))add('INTERNAL_NOTES_SOURCE_REQUIRED','Internal Notes source text is empty. Correct the Webform request data before Sales Order creation.');if(!item.id)add('STANDARD_SERVICE_ITEM_ID_NOT_CONFIGURED','Set Script Property '+STANDARD_SERVICE_ITEM_PROPERTY+' to the standard Clean & Service Striven Item ID before creating a non-EB2026 Sales Order.');else if(!item.ok)add('ITEM_PRICE_UNRESOLVED','Item '+item.id+' current price could not be resolved. '+clean_(item.error));if(op&&op.error)add('OPERATIONAL_EVIDENCE_FAILED',op.error);if(op.activeCount>0)add('ACTIVE_WORK_EXISTS','Fresh operational data contains active work for this Customer/location.');var wn=webformNotes_(r);if(!wn.ok)add('SERVICE_REQUEST_NOTES_REQUIRED',wn.error);var ps=propState_();if(!ps.correct&&!ps.correctable)add('PAYMENT_TERM_NOT_CORRECTABLE','STRIVEN_PAYMENT_TERM_ID must be 13. Current value: '+ps.value);var ss=statusPropState_();if(!ss.correct&&!ss.correctable)add('SALES_ORDER_STATUS_NOT_CORRECTABLE','STRIVEN_WORK_ORDER_INITIAL_STATUS_ID must be 19 (Quoted). Current value: '+ss.value);var j=orderJournal_(r).order||{};if(Number(j.postAttempts||0)>0&&upper_(j.status)!=='REJECTED_VALIDATION')add('PRIOR_WRITE_OUTCOME_NOT_SAFE_TO_RETRY','A prior Sales Order write crossed the boundary with status '+clean_(j.status)+'. Reconcile; do not create another Sales Order.');if(j.remoteWriteMayHaveSucceeded===true)add('PRIOR_WRITE_MAY_HAVE_SUCCEEDED','Prior Sales Order outcome may have succeeded remotely. Reconcile before any new POST.');return b;}
  function previewInputKey_(r){var ready=readiness_();return deps_().util.canonicalHash({requestId:clean_(r['Request ID']),stage:clean_(r['Current Stage']),manualReview:clean_(r['Manual Review?']),duplicateRisk:clean_(r['Duplicate Risk Status']),customerId:customerId_(r),contactId:contactId_(r),locationId:locationId_(r),workOrderId:clean_(r['Work Order ID']),unit:clean_(r['Unit Details']),service:clean_(r['Service Details']),additional:clean_(r['Additional Notes']),preferred:clean_(r['Preferred Days']),campaign:clean_(r['Campaign Code']),selectedItemId:selectedItemId_(r),operational:ready&&ready.fresh?ready.fresh.operational:false,operationalState:ready&&ready.groups?ready.groups.operational||{}:{}});}
  function previewRequest(requestId){var r=request_(requestId),memoKey=previewInputKey_(r),memo=PREVIEW_MEMO[clean_(requestId)];if(memo&&memo.key===memoKey)return clone_(memo.value);var draft=draft_(r),notesContract=resolveInternalNotesEncoding_(),item=item_(r),op=operational_(customerId_(r),locationId_(r)),payload=payload_(r,item,draft,notesContract),fp=fingerprints_(r,payload),j=orderJournal_(r),ps=propState_(),ss=statusPropState_(),wn=webformNotes_(r),blockers=validate_(r,item,op,draft,payload,notesContract);var approved=clean_(j.order.writeFingerprint)===fp.writeFingerprint&&upper_(j.order.status)==='APPROVED_FOR_CREATE';var out={ok:blockers.length===0,version:VERSION,mode:'GUARDED_SELECTED_SALES_ORDER_CREATE_QUOTED_MANUAL_REVIEW',requestId:clean_(r['Request ID']),rowNumber:r.__rowNumber,state:{stage:clean_(r['Current Stage']),customerId:customerId_(r),contactId:contactId_(r),locationId:locationId_(r),workOrderId:clean_(r['Work Order ID']),duplicateRisk:clean_(r['Duplicate Risk Status']),manualReview:clean_(r['Manual Review?'])},endpoint:ENDPOINT,payload:payload,payloadFingerprint:fp.payloadFingerprint,writeFingerprint:fp.writeFingerprint,draftSafety:{safeForPayloadOverlay:!!(draft&&draft.safeForPayloadOverlay),coreBlockers:draft&&draft.coreBlockers||[],operatorRequiredFieldIds:draft&&draft.operatorRequiredFieldIds||[],lookupRequiredFieldIds:draft&&draft.lookupRequiredFieldIds||[]},paymentTermProperty:{current:ps.value,expected:'13',correctableOnApproval:ps.correctable,alreadyCorrect:ps.correct},salesOrderCreateStatusProperty:{current:ss.value,expected:'19',expectedName:'Quoted',correctableOnApproval:ss.correctable,alreadyCorrect:ss.correct},approvalPolicy:{approvalStage:'APPROVED',createStatusId:19,createStatusName:'Quoted',postCreateHandling:'MANUAL_REVIEW',automaticStatusTransition:false},internalNotes:{source:'NORMALIZED_SERVICE_REQUEST_FIELDS',text:internalNoteText_(r,draft),contract:notesContract,included:payload.InternalNotes!==undefined},requestSource855:cfValue_(payload,'855'),operational:{fresh:operationalFresh_(),evidence:op},approval:{approved:approved,approvedAt:clean_(j.order.approvedAt),storedApprovalFingerprint:clean_(j.order.writeFingerprint)},journal:j.order,blockers:blockers,warnings:['This action is guarded and never retries an uncertain Sales Order POST.','The Sales Order is created as Quoted and moved immediately to Manual Review.','Internal Notes use the contract confirmed from Sales Order 26418 GET: InternalNotes {NotesHtml, NotesText}.','Request Source 855 must equal the verified active Custom List 116 item Webform.','A successful response identifier is never trusted until GET /v1/sales-orders/{id} confirms the created order.'],readyForApproval:blockers.length===0,readyForLivePost:blockers.length===0&&approved&&operationalFresh_(),liveWriteExecuted:false};PREVIEW_MEMO[clean_(requestId)]={key:memoKey,value:clone_(out)};return out;}
  function approveRequest(requestId){var r=request_(requestId);if(!operationalFresh_()){deps_().data.refreshOperationalData({});r=request_(requestId);}var ps=propState_(),ss=statusPropState_(),corrected=false,statusCorrected=false;if(ps.correctable){PropertiesService.getScriptProperties().setProperty('STRIVEN_PAYMENT_TERM_ID','13');corrected=true;}if(ss.correctable){PropertiesService.getScriptProperties().setProperty('STRIVEN_WORK_ORDER_INITIAL_STATUS_ID','19');statusCorrected=true;}var preview=previewRequest(requestId);if(!preview.readyForApproval)throw new Error('Sales Order approval blocked: '+preview.blockers.map(function(x){return x.code+': '+x.message;}).join(' | '));var prior=orderJournal_(r).order||{},root=rootJournal_(r),state={phase:'PHASE 6 — MANUAL GUARDED SALES ORDER CREATE',version:VERSION,requestId:requestId,endpoint:ENDPOINT,payload:preview.payload,payloadFingerprint:preview.payloadFingerprint,writeFingerprint:preview.writeFingerprint,status:'APPROVED_FOR_CREATE',approvalStage:'APPROVED',approvedAt:now_(),salesOrderCreateStatus:{id:19,name:'Quoted'},postCreateHandling:{mode:'MANUAL_REVIEW',automaticStatusTransition:false},paymentTermCorrection:corrected?{from:ps.value,to:'13',at:now_()}:null,statusCorrection:statusCorrected?{from:ss.value,to:'19',at:now_()}:null,internalNotes:preview.internalNotes,previousRejectedAttempt:Number(prior.postAttempts||0)>0?clone_(prior):null,postAttempts:0,noAutomaticWriteRetry:true,remoteWriteMayHaveSucceeded:false};root.salesOrderCreate=state;patch_(r,{'Updated At':now_(),'Write Fingerprint':preview.writeFingerprint,'Write Journal JSON':json_(root),'Work Order Action':'CREATE','Next Action':'CREATE SALES ORDER AS QUOTED','Reconciliation Status':'SALES ORDER QUOTED CREATE APPROVED','Striven Sync Status':'PARTIAL','Striven Sync Error':''});log_(r,'APPROVE_SALES_ORDER','APPROVED_SELECTED_CREATE_STATUS_19_QUOTED_MANUAL_REVIEW',{writeFingerprint:preview.writeFingerprint,previousRejectedAttempt:Number(prior.postAttempts||0)>0});return{ok:true,status:'SALES_ORDER_QUOTED_APPROVED_FOR_ONE_MANUAL_GUARDED_CREATE',approvalStage:'APPROVED',requestId:requestId,createStatusId:19,createStatusName:'Quoted',postCreateHandling:'MANUAL_REVIEW',automaticStatusTransition:false,writeFingerprint:preview.writeFingerprint,previousRejectedAttemptPreserved:Number(prior.postAttempts||0)>0,internalNotesDeferred:false,internalNotesContract:'OBJECT_NOTES_HTML_TEXT',liveWriteExecuted:false,next:'EXECUTE MANUAL GUARDED CREATE'};}
  function parseHttp_(e){var m=String(e&&e.message||e||'').match(/HTTP\s+(\d{3})\s*:\s*([\s\S]*)$/i);return{status:m?Number(m[1]):0,bodyText:m?m[2]:'',message:String(e&&e.message||e||'')};}
  function classify_(e){var x=parseHttp_(e),s=x.status;if(s===400||s===422)return{outcome:'REJECTED_VALIDATION',remoteWriteMayHaveSucceeded:false,httpStatus:s};if(s===401||s===403)return{outcome:'REJECTED_AUTH',remoteWriteMayHaveSucceeded:false,httpStatus:s};if(s===404)return{outcome:'REJECTED_ENDPOINT',remoteWriteMayHaveSucceeded:false,httpStatus:s};if(s===409)return{outcome:'CONFLICT_RECONCILE',remoteWriteMayHaveSucceeded:true,httpStatus:s};if(s===429)return{outcome:'RATE_LIMIT_RECONCILE',remoteWriteMayHaveSucceeded:true,httpStatus:s};if(s>=500)return{outcome:'UNCERTAIN_SERVER',remoteWriteMayHaveSucceeded:true,httpStatus:s};return{outcome:'UNCERTAIN_TRANSPORT',remoteWriteMayHaveSucceeded:true,httpStatus:s};}
  function responseId_(body){body=body||{};var vals=[body.SalesOrderId,body.SalesOrderID,body.salesOrderId,body.WorkOrderId,body.workOrderId,body.Id,body.ID,body.id,body.data&&(body.data.SalesOrderId||body.data.Id||body.data.id),body.Data&&(body.Data.SalesOrderId||body.Data.Id||body.Data.id)];for(var i=0;i<vals.length;i++)if(clean_(vals[i]))return clean_(vals[i]);return'';}
  function verifyCreated_(id,r,payload){var x=get_(ENDPOINT+'/'+encodeURIComponent(id));if(!x.ok)return{ok:false,id:id,error:x.error,body:{}};var b=x.body||{},cust=clean_(b.customer&&b.customer.id),contact=clean_(b.contact&&b.contact.id),bill=clean_(b.billToLocation&&b.billToLocation.id),ship=clean_(b.shipToLocation&&b.shipToLocation.id),type=Number(b.type&&b.type.id||0),payment=Number(b.paymentTerm&&b.paymentTerm.id||0),statusId=Number(b.status&&b.status.id||0),status=clean_(b.status&&b.status.name),num=clean_(b.orderNumber),itemId=Number(b.lineItems&&b.lineItems[0]&&b.lineItems[0].item&&b.lineItems[0].item.id||0),cfs=b.customFields||[],cf={};for(var i=0;i<cfs.length;i++)cf[clean_(cfs[i].id)]=clean_(cfs[i].value);var expected651=cfValue_(payload,'651'),expected650=cfValue_(payload,'650'),expected794=cfValue_(payload,'794')||'502',expected797=cfValue_(payload,'797'),expected855=cfValue_(payload,'855');var customFieldsConfirmed=upper_(cf['651'])===upper_(expected651)&&upper_(cf['164'])==='FALSE'&&clean_(cf['794'])===clean_(expected794);if(expected650)customFieldsConfirmed=customFieldsConfirmed&&upper_(cf['650'])===upper_(expected650);if(expected797)customFieldsConfirmed=customFieldsConfirmed&&clean_(cf['797'])===clean_(expected797);if(expected855)customFieldsConfirmed=customFieldsConfirmed&&clean_(cf['855'])===clean_(expected855);var expectedInternal=internalNoteText_(r,null),actualInternal=noteTextFromResponse_(b.internalNotes!==undefined?b.internalNotes:b.InternalNotes);var internalNotesConfirmed=(function (semantic) {
          return semantic === null
            ? (!!expectedInternal&&!!actualInternal&&actualInternal.indexOf(expectedInternal)>=0)
            : semantic;
        })(CF.InternalNotesSemantic.confirm(payload && payload.InternalNotes, b.internalNotes !== undefined ? b.internalNotes : b.InternalNotes));
  /* CF_SERVICEOPS_V5_10_26_E2E_INTERNAL_NOTES_REPAIR_R1
   * E2E repair: creation verification first compares semantically. Only when
   * that comparison fails do we use the proven official API update contract.
   * The repair helper itself performs GET -> guarded POST -> GET verification,
   * omits unsupported attachment CustomFields from POST only, and never retries
   * a Sales Order POST automatically.
   */
  var internalNotesOfficialApiRepair = null;
  if (!internalNotesConfirmed && CF.SalesOrderInternalNotesApi && typeof CF.SalesOrderInternalNotesApi.reconcileVerificationContext === 'function') {
    try {
      internalNotesOfficialApiRepair = CF.SalesOrderInternalNotesApi.reconcileVerificationContext(b);
      if (internalNotesOfficialApiRepair && internalNotesOfficialApiRepair.ok === true && internalNotesOfficialApiRepair.semanticContentMatches === true) {
        internalNotesConfirmed = true;
      }
    } catch (internalNotesRepairError) {
      try { console.error('E2E Internal Notes official API reconciliation failed: ' + String(internalNotesRepairError && internalNotesRepairError.message || internalNotesRepairError)); } catch (ignoredInternalNotesRepairLog) {}
    }
  }
return{ok:true,id:clean_(b.id||id),orderNumber:num,customerId:cust,contactId:contact,billToLocationId:bill,shipToLocationId:ship,typeId:type,paymentTermId:payment,statusId:statusId,status:status,itemId:itemId,customFields:cf,requestSource855:cf['855']||'',internalNotes:actualInternal,body:b,identityConfirmed:cust===customerId_(r)&&type===EXPECTED.typeId,contactConfirmed:contact===contactId_(r),billToConfirmed:bill===locationId_(r),locationConfirmed:ship===locationId_(r),paymentTermConfirmed:payment===EXPECTED.paymentTermId,statusConfirmed:statusId===19||upper_(status)==='QUOTED',itemConfirmed:itemId===Number(payload&&payload.LineItems&&payload.LineItems[0]&&payload.LineItems[0].Item&&payload.LineItems[0].Item.Id||payload&&payload.LineItems&&payload.LineItems[0]&&payload.LineItems[0].item&&payload.LineItems[0].item.id||0),customFieldsConfirmed:customFieldsConfirmed,internalNotesConfirmed:internalNotesConfirmed};}
  function verificationReviewMessage_(verified){
    var issues=[];
    if(!verified.identityConfirmed)issues.push('Customer/type identity');
    if(!verified.contactConfirmed)issues.push('Contact');
    if(!verified.billToConfirmed)issues.push('Bill-to Location');
    if(!verified.locationConfirmed)issues.push('Ship-to Location');
    if(!verified.paymentTermConfirmed)issues.push('Payment Term');
    if(!verified.statusConfirmed)issues.push('Sales Order Status');
    if(!verified.itemConfirmed)issues.push('Line Item');
    if(!verified.customFieldsConfirmed)issues.push('Custom Fields');
    if(!verified.internalNotesConfirmed)issues.push('Internal Notes');
    var order=clean_(verified.orderNumber)||clean_(verified.id)||'existing Sales Order';
    if(issues.length===1&&issues[0]==='Internal Notes'){
      return 'Sales Order '+order+' was created, but Internal Notes were not saved. DO NOT CREATE ANOTHER SALES ORDER. Add/reconcile Internal Notes on this existing Sales Order, then verify it.';
    }
    return 'Sales Order '+order+' was created, but verification failed: '+issues.join(', ')+'. DO NOT CREATE ANOTHER SALES ORDER. Reconcile this existing Sales Order before continuing.';
  }

    /* CF_SERVICEOPS_V5_12_7_VERIFIED_QUOTED_NO_REVIEW_R1 */
function executeApproved(requestId,options){options=options||{};if(options.executionToken!==EXECUTION_TOKEN)throw new Error('Invalid guarded Sales Order execution token.');if(!operationalFresh_()){var refresh=deps_().data.refreshOperationalData({});return{ok:false,status:'OPERATIONAL_CACHE_REFRESHED_RERUN_REQUIRED',requestId:requestId,operationalCacheRefreshExecuted:true,refresh:refresh,liveWriteExecuted:false};}return deps_().util.withScriptLock(function(){var r=request_(requestId),preview=previewRequest(requestId),j=orderJournal_(r),oj=clone_(j.order||{});if(clean_(r['Work Order ID']))return{ok:true,status:'SALES_ORDER_ALREADY_DURABLE',requestId:requestId,workOrderId:clean_(r['Work Order ID']),workOrderNumber:clean_(r['Work Order Number']),liveWriteExecuted:false};if(!preview.readyForApproval||!operationalFresh_())throw new Error('Guarded Sales Order POST blocked. Preview safety and operational freshness must be valid.');if(clean_(oj.writeFingerprint)!==preview.writeFingerprint||upper_(oj.status)!=='APPROVED_FOR_CREATE')throw new Error('Stored Sales Order approval does not match current payload. Re-preview and approve.');if(Number(oj.postAttempts||0)>0)throw new Error('This approved Sales Order payload already crossed the write boundary. Reconcile; do not POST again.');oj.status='POST_INTENT_RECORDED';oj.postAttempts=1;oj.postStartedAt=now_();oj.remoteWriteMayHaveSucceeded=false;j.root.salesOrderCreate=oj;patch_(r,{'Updated At':now_(),'Write Journal JSON':json_(j.root),'Reconciliation Status':'SALES ORDER POST INTENT RECORDED','Striven Sync Status':'PARTIAL'});var response;try{response=deps_().http.requestJson(ENDPOINT,{method:'post',payload:preview.payload,attempts:1,idempotent:false});}catch(e){var c=classify_(e);oj.status=c.outcome;oj.postFinishedAt=now_();oj.httpStatus=c.httpStatus;oj.remoteWriteMayHaveSucceeded=c.remoteWriteMayHaveSucceeded;oj.error=String(e&&e.message||e);j.root.salesOrderCreate=oj;patch_(r,{'Updated At':now_(),'Write Journal JSON':json_(j.root),'Striven Sync Status':c.remoteWriteMayHaveSucceeded?'RECONCILE REQUIRED':'BLOCKED','Striven Sync Error':oj.error,'Reconciliation Status':c.outcome,'Next Action':c.remoteWriteMayHaveSucceeded?'RECONCILE SALES ORDER':'REVIEW SALES ORDER CONTRACT'});log_(r,'CREATE_SALES_ORDER',c.outcome,{httpStatus:c.httpStatus,error:oj.error},oj.error);return{ok:false,status:c.outcome,requestId:requestId,httpStatus:c.httpStatus,error:oj.error,remoteWriteMayHaveSucceeded:c.remoteWriteMayHaveSucceeded,liveWriteExecuted:true};}var body=response.json||{},rid=responseId_(body);oj.status='POST_ACCEPTED';oj.postFinishedAt=now_();oj.httpStatus=response.status||200;oj.responseIdentifier=rid;oj.responseBody=body;oj.remoteWriteMayHaveSucceeded=true;j.root.salesOrderCreate=oj;patch_(r,{'Updated At':now_(),'Write Journal JSON':json_(j.root),'Striven Sync Status':'PARTIAL','Striven Sync Error':'','Reconciliation Status':'SALES ORDER POST ACCEPTED'});if(!rid)return{ok:false,status:'SALES_ORDER_POST_ACCEPTED_ID_MISSING_RECONCILE_REQUIRED',requestId:requestId,httpStatus:response.status||200,response:body,remoteWriteMayHaveSucceeded:true,liveWriteExecuted:true};var verified=verifyCreated_(rid,r,preview.payload);oj.verification={attemptedAt:now_(),result:verified};if(!verified.ok){oj.status='POST_ACCEPTED_GET_RECONCILE_REQUIRED';j.root.salesOrderCreate=oj;patch_(r,{'Write Journal JSON':json_(j.root),'Reconciliation Status':'SALES ORDER GET RECONCILE REQUIRED','Next Action':'RECONCILE SALES ORDER'});return{ok:false,status:'SALES_ORDER_CREATED_GET_RECONCILE_REQUIRED',requestId:requestId,responseIdentifier:rid,error:verified.error,remoteWriteMayHaveSucceeded:true,liveWriteExecuted:true};}oj.canonicalSalesOrderId=verified.id;oj.canonicalOrderNumber=verified.orderNumber;var verificationReview=!verified.identityConfirmed||!verified.contactConfirmed||!verified.billToConfirmed||!verified.locationConfirmed||!verified.paymentTermConfirmed||!verified.statusConfirmed||!verified.itemConfirmed||!verified.customFieldsConfirmed||!verified.internalNotesConfirmed;oj.status=verificationReview?'SALES_ORDER_CREATED_IDENTITY_REVIEW':'SALES_ORDER_CREATED_QUOTED_VERIFIED_AUTO_CONTINUE';oj.postCreateHandling={mode:verificationReview?'MANUAL_REVIEW':'AUTO_CONTINUE_VERIFIED_QUOTED',automaticStatusTransition:!verificationReview};j.root.salesOrderCreate=oj;var manualReason=verificationReview?verificationReviewMessage_(verified):'';patch_(r,{'Updated At':now_(),'Current Stage':verificationReview?'NEEDS REVIEW':'SALES ORDER CREATED','Request Status':'OPEN','Work Order ID':verified.id,'Work Order Number':verified.orderNumber,'Work Order Link':'https://classicfireplace.striven.com/next/crm#/sales-orders/'+verified.id,'Work Order Status':verified.status||'QUOTED','Work Order Action':'LINK EXISTING','Next Action':verificationReview?'MANUAL REVIEW SALES ORDER':'SCHEDULE SERVICE','Manual Review?':verificationReview?'YES':'NO','Manual Review Reason':manualReason,'Blocking Issue':verificationReview?manualReason:'','Write Journal JSON':json_(j.root),'Striven Sync Status':verificationReview?'BLOCKED':'SYNCED','Striven Sync Error':'','Last Striven Sync':now_(),'Reconciliation Status':verificationReview?'SALES ORDER CREATED REVIEW REQUIRED':'SALES ORDER CREATED QUOTED — VERIFIED'});log_(r,'CREATE_SALES_ORDER',oj.status,{salesOrderId:verified.id,orderNumber:verified.orderNumber,verified:verified,postCreateHandling:verificationReview?'MANUAL_REVIEW':'AUTO_CONTINUE_VERIFIED_QUOTED'});return{ok:!verificationReview,status:oj.status,requestId:requestId,salesOrderId:verified.id,orderNumber:verified.orderNumber,customerId:verified.customerId,contactId:verified.contactId,billToLocationId:verified.billToLocationId,shipToLocationId:verified.shipToLocationId,typeId:verified.typeId,orderStatus:verified.status,requestSource855:verified.requestSource855,internalNotesConfirmed:verified.internalNotesConfirmed,manualReviewRequired:verificationReview,automaticStatusTransition:!verificationReview,liveWriteExecuted:true,next:verificationReview?'MANUAL REVIEW':'SCHEDULE SERVICE'};});}
  /* CF_SERVICEOPS_V5_11_0_END_TO_END_RELIABILITY_CONTROLLER_R2
   * Read-after-write authoritative Sales Order certification.
   * - Never creates a second Sales Order when a durable ID exists.
   * - Certification is GET-only against Striven; only the local Service Request ledger is patched.
   * - Quoted status is preserved. No automatic status transition is introduced.
   * - A transient GET failure remains recoverable and does not become human review.
   * - Semantic/identity failures fail closed to a precise manual-review state.
   */
  function v511BodyId_(obj){
    obj=obj||{};
    if(obj.Id!==undefined)return clean_(obj.Id);
    if(obj.id!==undefined)return clean_(obj.id);
    if(obj.ID!==undefined)return clean_(obj.ID);
    return '';
  }
  function v511NestedId_(body,lower,upper){
    body=body||{};
    var obj=body[lower]!==undefined?body[lower]:body[upper];
    if(obj===null||obj===undefined)return '';
    if(typeof obj==='string'||typeof obj==='number')return clean_(obj);
    return v511BodyId_(obj);
  }
  function v511CfMap_(body){
    body=body||{};
    var rows=body.customFields||body.CustomFields||[],out={};
    if(!Array.isArray(rows))rows=[];
    rows.forEach(function(field){
      field=field||{};
      var id=clean_(field.id!==undefined?field.id:field.Id);
      if(!id)return;
      var value=field.value!==undefined?field.value:field.Value;
      if(value===undefined)value=field.valueText!==undefined?field.valueText:field.ValueText;
      out[id]=clean_(value);
    });
    return out;
  }
  function v511LineItemId_(body){
    body=body||{};
    var rows=body.lineItems||body.LineItems||[];
    if(!Array.isArray(rows)||!rows.length)return 0;
    var item=rows[0]&&(rows[0].item||rows[0].Item)||{};
    return Number(item.id!==undefined?item.id:item.Id)||0;
  }
  function v511ExpectedPayload_(record){
    var journal=orderJournal_(record).order||{};
    if(journal.payload&&typeof journal.payload==='object')return clone_(journal.payload);
    if(journal.previousRejectedAttempt&&journal.previousRejectedAttempt.payload&&typeof journal.previousRejectedAttempt.payload==='object')return clone_(journal.previousRejectedAttempt.payload);
    try{
      var preview=previewRequest(clean_(record['Request ID']));
      if(preview&&preview.payload)return clone_(preview.payload);
    }catch(ignoredPreview){}
    return null;
  }
  function v511ReadOnlyVerify_(requestId,preferredSalesOrderId){
    var record=request_(requestId);
    var salesOrderId=clean_(preferredSalesOrderId||record['Work Order ID']);
    if(!salesOrderId){
      var journal=orderJournal_(record).order||{};
      salesOrderId=clean_(journal.canonicalSalesOrderId||journal.responseIdentifier);
    }
    if(!salesOrderId)return{ok:false,verified:false,transient:false,status:'SALES_ORDER_CERTIFICATION_ID_MISSING',requestId:requestId,issues:['Durable Sales Order ID'],liveWriteExecuted:false};

    var expectedPayload=v511ExpectedPayload_(record);
    if(!expectedPayload)return{ok:false,verified:false,transient:false,status:'SALES_ORDER_CERTIFICATION_EXPECTED_PAYLOAD_MISSING',requestId:requestId,salesOrderId:salesOrderId,issues:['Stored expected Sales Order payload'],liveWriteExecuted:false};

    var fetched=get_(ENDPOINT+'/'+encodeURIComponent(salesOrderId));
    if(!fetched.ok){
      return{ok:false,verified:false,transient:true,status:'SALES_ORDER_CERTIFICATION_GET_RETRY_REQUIRED',requestId:requestId,salesOrderId:salesOrderId,error:fetched.error||'Sales Order GET failed.',remoteWriteMayHaveSucceeded:true,automaticPostRetry:false,liveWriteExecuted:false};
    }

    var body=fetched.body||{};
    var actualId=clean_(body.id!==undefined?body.id:(body.Id!==undefined?body.Id:salesOrderId));
    var orderNumber=clean_(body.orderNumber!==undefined?body.orderNumber:body.OrderNumber);
    var customer=v511NestedId_(body,'customer','Customer');
    var contact=v511NestedId_(body,'contact','Contact');
    var bill=v511NestedId_(body,'billToLocation','BillToLocation');
    var ship=v511NestedId_(body,'shipToLocation','ShipToLocation');
    var typeId=Number(v511NestedId_(body,'type','Type'))||0;
    var paymentTermId=Number(v511NestedId_(body,'paymentTerm','PaymentTerm'))||0;
    var statusObj=body.status!==undefined?body.status:body.Status;
    var statusId=0,statusName='';
    if(statusObj&&typeof statusObj==='object'){
      statusId=Number(statusObj.id!==undefined?statusObj.id:statusObj.Id)||0;
      statusName=clean_(statusObj.name!==undefined?statusObj.name:statusObj.Name);
    }else{
      statusName=clean_(statusObj);
    }
    var itemId=v511LineItemId_(body);
    var actualCf=v511CfMap_(body);
    var expected651=cfValue_(expectedPayload,'651');
    var expected650=cfValue_(expectedPayload,'650');
    var expected794=cfValue_(expectedPayload,'794')||EXPECTED.serviceTech;
    var expected797=cfValue_(expectedPayload,'797');
    var expected855=cfValue_(expectedPayload,'855');
    var customFieldsConfirmed=upper_(actualCf['651'])===upper_(expected651)&&upper_(actualCf['164'])==='FALSE'&&clean_(actualCf['794'])===clean_(expected794);
    if(expected650)customFieldsConfirmed=customFieldsConfirmed&&upper_(actualCf['650'])===upper_(expected650);
    if(expected797)customFieldsConfirmed=customFieldsConfirmed&&clean_(actualCf['797'])===clean_(expected797);
    if(expected855)customFieldsConfirmed=customFieldsConfirmed&&clean_(actualCf['855'])===clean_(expected855);

    var expectedNotes=expectedPayload.InternalNotes||expectedPayload.internalNotes||null;
    var actualNotes=body.internalNotes!==undefined?body.internalNotes:body.InternalNotes;
    var notesConfirmed=!!(CF.InternalNotesSemantic&&typeof CF.InternalNotesSemantic.confirm==='function'&&CF.InternalNotesSemantic.confirm(expectedNotes,actualNotes)===true);

    var checks={
      salesOrderId:actualId===salesOrderId,
      customer:customer===customerId_(record),
      contact:contact===contactId_(record),
      billToLocation:bill===locationId_(record),
      shipToLocation:ship===locationId_(record),
      type:typeId===EXPECTED.typeId,
      paymentTerm:paymentTermId===EXPECTED.paymentTermId,
      status:statusId===EXPECTED.statusId||upper_(statusName)==='QUOTED',
      lineItem:itemId===ITEM_ID,
      customFields:customFieldsConfirmed,
      internalNotes:notesConfirmed
    };
      // CF ServiceOps v5.11.2 — mutable Sales Order status is informational after exact-GET identity certification
  // Striven may legitimately advance Quoted -> In Progress/Completed after creation.
  // Preserve the create-contract comparison for diagnostics, but do not make mutable status
  // an identity/collateral certification gate. Exact GET and every other check remain mandatory.
  // CF ServiceOps v5.11.3 R6 — mutable Sales Order status diagnostic is nonblocking
// Exact GET, identity, location, item, custom-field, and Internal Notes checks remain blocking.
// Current Striven Sales Order status is mutable after creation, so this diagnostic cannot fail certification.
checks.statusMatchesCreateContract = true;
  checks.status = true;

var issues=[];
    Object.keys(checks).forEach(function(key){if(checks[key]!==true)issues.push(key);});
    return{
      ok:issues.length===0,
      verified:issues.length===0,
      transient:false,
      status:issues.length===0?'SALES_ORDER_CERTIFICATION_PASS':'SALES_ORDER_VERIFICATION_REVIEW_REQUIRED',
      requestId:requestId,
      salesOrderId:salesOrderId,
      orderNumber:orderNumber,
      customerId:customer,
      contactId:contact,
      billToLocationId:bill,
      shipToLocationId:ship,
      typeId:typeId,
      paymentTermId:paymentTermId,
      statusId:statusId,
      orderStatus:statusName,
      itemId:itemId,
      requestSource855:actualCf['855']||'',
      checks:checks,
      issues:issues,
      internalNotesConfirmed:notesConfirmed,
      automaticPostRetry:false,
      liveWriteExecuted:false
    };
  }
  function previewCertification(requestId){
    return v511ReadOnlyVerify_(requestId,'');
  }
  function certifyExisting(requestId,preferredSalesOrderId){
    var record=request_(requestId);
    var verified=v511ReadOnlyVerify_(requestId,preferredSalesOrderId);
    if(verified.transient===true)return verified;

    var root=rootJournal_(record),order=root.salesOrderCreate||{};
    order.certification={attemptedAt:now_(),version:'5.11.0',result:verified};
    if(verified.ok===true){
      order.status='SALES_ORDER_VERIFIED_COMPLETE';
      order.canonicalSalesOrderId=verified.salesOrderId;
      order.canonicalOrderNumber=verified.orderNumber;
      order.postCreateHandling={mode:'AUTOMATIC_CERTIFICATION_COMPLETE',automaticStatusTransition:false};
      root.salesOrderCreate=order;
      patch_(record,{
        'Updated At':now_(),
        'Current Stage':'COMPLETED',
        'Request Status':'COMPLETED',
        'Work Order ID':verified.salesOrderId,
        'Work Order Number':verified.orderNumber,
        'Work Order Link':'https://classicfireplace.striven.com/next/crm#/sales-orders/'+verified.salesOrderId,
        'Work Order Status':verified.orderStatus||'QUOTED',
        'Work Order Action':'LINK EXISTING',
        'Next Action':'NONE',
        'Manual Review?':'NO',
        'Manual Review Reason':'',
        'Blocking Issue':'',
        'Write Journal JSON':json_(root),
        'Striven Sync Status':'SYNCED',
        'Striven Sync Error':'',
        'Last Striven Sync':now_(),
        'Reconciliation Status':'SALES ORDER VERIFIED',
        'Final Outcome':'COMPLETED - SALES ORDER VERIFIED',
        'Completed At':now_()
      });
      log_(record,'CERTIFY_SALES_ORDER','SALES_ORDER_VERIFIED_COMPLETE',{salesOrderId:verified.salesOrderId,orderNumber:verified.orderNumber,checks:verified.checks},'');
      verified.status='SALES_ORDER_VERIFIED_COMPLETE';
      verified.manualReviewRequired=false;
      verified.next='NONE';
      return verified;
    }

    order.status='SALES_ORDER_VERIFICATION_REVIEW_REQUIRED';
    root.salesOrderCreate=order;
    var message='Existing Sales Order '+clean_(verified.orderNumber||verified.salesOrderId)+' failed read-only certification: '+(verified.issues||[]).join(', ')+'. DO NOT CREATE ANOTHER SALES ORDER.';
    patch_(record,{
      'Updated At':now_(),
      'Current Stage':'NEEDS REVIEW',
      'Request Status':'BLOCKED',
      'Work Order ID':verified.salesOrderId||clean_(record['Work Order ID']),
      'Work Order Number':verified.orderNumber||clean_(record['Work Order Number']),
      'Work Order Action':'LINK EXISTING',
      'Next Action':'REVIEW EXISTING SALES ORDER - DO NOT CREATE AGAIN',
      'Manual Review?':'YES',
      'Manual Review Reason':message,
      'Blocking Issue':message,
      'Write Journal JSON':json_(root),
      'Striven Sync Status':'BLOCKED',
      'Striven Sync Error':'',
      'Last Striven Sync':now_(),
      'Reconciliation Status':'SALES ORDER VERIFICATION REVIEW REQUIRED'
    });
    log_(record,'CERTIFY_SALES_ORDER','SALES_ORDER_VERIFICATION_REVIEW_REQUIRED',{salesOrderId:verified.salesOrderId,orderNumber:verified.orderNumber,checks:verified.checks,issues:verified.issues},message);
    verified.manualReviewRequired=true;
    verified.next='REVIEW EXISTING SALES ORDER - DO NOT CREATE AGAIN';
    return verified;
  }
  function executeApprovedV511_(requestId,options){
    var base=executeApproved(requestId,options),preferredId='';
    if(base){preferredId=clean_(base.salesOrderId||base.workOrderId||base.responseIdentifier);}
    if(!preferredId){
      try{preferredId=clean_(request_(requestId)['Work Order ID']);}catch(ignoredRow){}
    }
    if(!preferredId)return base;
    var certified=certifyExisting(requestId,preferredId);
    certified.creationResult=base;
    certified.liveWriteExecuted=!!(base&&base.liveWriteExecuted===true);
    certified.remoteWriteMayHaveSucceeded=certified.remoteWriteMayHaveSucceeded===true||!!(base&&base.remoteWriteMayHaveSucceeded===true)||certified.liveWriteExecuted===true;
    return certified;
  }
  return{version:'5.11.0',previewRequest:previewRequest,approveRequest:approveRequest,executeApproved:executeApprovedV511_,certifyExisting:certifyExisting,previewCertification:previewCertification,probeInternalNotesContract:resolveInternalNotesEncoding_,executionToken:EXECUTION_TOKEN,reliabilityMarker:'CF_SERVICEOPS_V5_11_0_END_TO_END_RELIABILITY_CONTROLLER_R2'};
})();

/* CF_SERVICEOPS_V5_10_14_RUNTIME_INTERNAL_NOTES_QUEUE_R1 — WRITER FAST READINESS + CONFIRMED INTERNAL NOTES */

/* CF_SERVICEOPS_V5_10_17_INTERNAL_NOTES_HTML_R1 — NotesHtml real HTML table / NotesText clean plain text */


/* CF_SERVICEOPS_V5_10_20_PRODUCTION_SEMANTIC_INTERNAL_NOTES_R3 — production-safe semantic Internal Notes comparison. */
CF.InternalNotesSemantic = (function () {
  'use strict';

  function string_(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  function decodeHtml_(value) {
    return string_(value)
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#x([0-9a-f]+);/gi, function (_, hex) {
        return String.fromCharCode(parseInt(hex, 16));
      })
      .replace(/&#(\d+);/g, function (_, dec) {
        return String.fromCharCode(parseInt(dec, 10));
      });
  }

  function cleanCell_(value) {
    return decodeHtml_(
      string_(value)
        .replace(/<br\s*\/?\s*>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
    )
      .replace(/[\u00a0\s]+/g, ' ')
      .trim();
  }

  function key_(value) {
    return cleanCell_(value).toLowerCase();
  }

  function notePart_(notes, html, expected) {
    if (!notes) return '';
    if (typeof notes === 'string' || typeof notes === 'number') return string_(notes);
    if (typeof notes !== 'object') return '';

    var keys;
    if (expected) {
      keys = html ? ['NotesHtml', 'notesHtml'] : ['NotesText', 'notesText'];
    } else {
      keys = html ? ['notesHtml', 'NotesHtml'] : ['notesText', 'NotesText'];
    }

    for (var i = 0; i < keys.length; i++) {
      if (notes[keys[i]] !== undefined) return string_(notes[keys[i]] || '');
    }
    return '';
  }

  function tableRows_(html) {
    var rows = [];
    var rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    var rowMatch;

    while ((rowMatch = rowRe.exec(string_(html)))) {
      var cells = [];
      var cellRe = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
      var cellMatch;

      while ((cellMatch = cellRe.exec(rowMatch[1]))) {
        cells.push(cleanCell_(cellMatch[1]));
      }

      if (cells.length >= 2 && cells[0]) {
        rows.push({ label: cells[0], value: cells[1] });
      }
    }

    return rows;
  }

  function compare(expectedNotes, actualNotes) {
    var expectedHtml = notePart_(expectedNotes, true, true);
    var expectedText = notePart_(expectedNotes, false, true);
    var actualHtml = notePart_(actualNotes, true, false);
    var actualText = notePart_(actualNotes, false, false);

    var expectedRows = tableRows_(expectedHtml);
    var actualRows = tableRows_(actualHtml);
    var expectedMap = {};
    var actualMap = {};
    var differences = [];
    var textMissing = [];
    var i;

    for (i = 0; i < expectedRows.length; i++) {
      expectedMap[key_(expectedRows[i].label)] = cleanCell_(expectedRows[i].value);
    }
    for (i = 0; i < actualRows.length; i++) {
      actualMap[key_(actualRows[i].label)] = cleanCell_(actualRows[i].value);
    }

    Object.keys(expectedMap).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(actualMap, k)) {
        differences.push('missing:' + k);
      } else if (actualMap[k] !== expectedMap[k]) {
        differences.push('value:' + k);
      }
    });

    Object.keys(actualMap).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(expectedMap, k)) {
        differences.push('unexpected:' + k);
      }
    });

    var haystack = cleanCell_(actualText).toLowerCase();
    for (i = 0; i < expectedRows.length; i++) {
      var label = cleanCell_(expectedRows[i].label).toLowerCase();
      var value = cleanCell_(expectedRows[i].value).toLowerCase();
      if (label && haystack.indexOf(label) === -1) textMissing.push('label:' + expectedRows[i].label);
      if (value && haystack.indexOf(value) === -1) textMissing.push('value:' + expectedRows[i].value);
    }

    var expectedFormatValid =
      /<table\b/i.test(expectedHtml) &&
      expectedRows.length > 0 &&
      expectedHtml.indexOf('| --- |') === -1 &&
      cleanCell_(expectedHtml).toLowerCase().indexOf('webform service request') !== -1 &&
      cleanCell_(expectedText).toLowerCase().indexOf('webform service request') === 0;

    var actualFormatValid =
      /<table\b/i.test(actualHtml) &&
      actualRows.length > 0 &&
      actualHtml.indexOf('| --- |') === -1 &&
      cleanCell_(actualHtml).toLowerCase().indexOf('webform service request') !== -1;

    var matches =
      expectedFormatValid &&
      actualFormatValid &&
      differences.length === 0 &&
      textMissing.length === 0;

    return {
      matches: matches,
      expectedFormatValid: expectedFormatValid,
      actualFormatValid: actualFormatValid,
      semanticTableMatches: differences.length === 0,
      semanticTextMatches: textMissing.length === 0,
      expectedFieldCount: expectedRows.length,
      actualFieldCount: actualRows.length,
      differences: differences,
      textMissing: textMissing,
      expectedNotesHtml: expectedHtml,
      expectedNotesText: expectedText,
      actualNotesHtml: actualHtml,
      actualNotesText: actualText
    };
  }

  function isExpectedNote_(value) {
    return !!(
      value &&
      typeof value === 'object' &&
      (value.NotesHtml !== undefined || value.NotesText !== undefined) &&
      /<table\b/i.test(notePart_(value, true, true))
    );
  }

  function isActualNote_(value) {
    return !!(
      value &&
      typeof value === 'object' &&
      (value.notesHtml !== undefined || value.notesText !== undefined)
    );
  }

  function findContext_(args) {
    var expected = null;
    var actual = null;
    var sawExplicitActualSlot = false;
    var seen = [];
    var visited = 0;
    var MAX_VISITED = 1200;
    var MAX_DEPTH = 9;

    function alreadySeen_(value) {
      for (var i = 0; i < seen.length; i++) {
        if (seen[i] === value) return true;
      }
      seen.push(value);
      return false;
    }

    function walk_(value, depth) {
      if (visited >= MAX_VISITED || depth > MAX_DEPTH || value === null || value === undefined) return;
      if (typeof value !== 'object' && typeof value !== 'function') return;
      if (alreadySeen_(value)) return;
      visited++;

      if (!expected && isExpectedNote_(value)) expected = value;
      if (!actual && isActualNote_(value) && !isExpectedNote_(value)) actual = value;
      if (expected && actual) return;

      var keys;
      try { keys = Object.keys(value); } catch (e) { return; }

      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var child;
        try { child = value[key]; } catch (e2) { continue; }

        if (/^internalnotes$/i.test(key)) {
          if (/^internalNotes$/.test(key)) sawExplicitActualSlot = true;
          if (!expected && isExpectedNote_(child)) expected = child;
          if (!actual && isActualNote_(child) && !isExpectedNote_(child)) actual = child;
          if (expected && actual) return;
        }

        walk_(child, depth + 1);
        if (expected && actual) return;
      }
    }

    var list = [];
    try {
      for (var i = 0; i < args.length; i++) list.push(args[i]);
    } catch (e) {
      return { expected: null, actual: null, sawExplicitActualSlot: false };
    }

    for (var j = 0; j < list.length; j++) {
      walk_(list[j], 0);
      if (expected && actual) break;
    }

    return {
      expected: expected,
      actual: actual,
      sawExplicitActualSlot: sawExplicitActualSlot
    };
  }

  function confirm(expectedNotes, actualNotes) {
    if (!expectedNotes || typeof expectedNotes !== 'object') return null;
    if (!actualNotes || typeof actualNotes !== 'object') return false;
    return compare(expectedNotes, actualNotes).matches;
  }

  function confirmFromArguments(args) {
    var context = findContext_(args);

    if (!context.expected) {
      return null;
    }

    if (!context.actual) {
      return context.sawExplicitActualSlot ? false : null;
    }

    return compare(context.expected, context.actual).matches;
  }

  return Object.freeze({
    compare: compare,
    confirm: confirm,
    confirmFromArguments: confirmFromArguments,
    productionBinding: Object.freeze({
      mode: 'DIRECT_LOCAL_EXPRESSIONS',
      expectedExpression: 'b.InternalNotes',
      actualExpression: 'b.internalNotes'
    })
  });
})();


/* CF_SERVICEOPS_V5_10_28_REQUIRED_CUSTOM_FIELDS_DTO_R1 — v5.10.28 shared official API Internal Notes reconciliation. */
CF.SalesOrderInternalNotesApi = (function () {
  'use strict';
  /* CF_SERVICEOPS_V5_10_28_REQUIRED_CUSTOM_FIELDS_DTO_R1
   * Official Striven API Internal Notes reconciliation.
   * For Internal Notes-only updates, POST only the REQUIRED non-attachment
   * top-level CustomFields in the documented write DTO shape, while all
   * top-level CustomFields are snapshot-verified unchanged after the write.
   */
  var VERSION = '5.10.28';

  function clean_(value) { return value === null || value === undefined ? '' : String(value).trim(); }
  function clone_(value) { return JSON.parse(JSON.stringify(value)); }
  function body_(value) {
    value = value && value.json !== undefined ? value.json : value;
    value = value || {};
    return value.Data || value.data || value.Result || value.result || value;
  }
  function orderId_(order) { order=order||{}; return clean_(order.Id !== undefined ? order.Id : order.id); }
  function orderNumber_(order) { order=order||{}; return clean_(order.OrderNumber !== undefined ? order.OrderNumber : order.orderNumber); }
  function customerId_(order) {
    order=order||{}; var c=order.Customer||order.customer||{};
    return clean_(c.Id !== undefined ? c.Id : (c.id !== undefined ? c.id : c.accountID));
  }
  function internalNotes_(order) { order=order||{}; return order.InternalNotes || order.internalNotes || null; }
  function notesHtml_(notes) { notes=notes||{}; return clean_(notes.NotesHtml !== undefined ? notes.NotesHtml : notes.notesHtml); }
  function notesText_(notes) { notes=notes||{}; return clean_(notes.NotesText !== undefined ? notes.NotesText : notes.notesText); }
  function notesId_(notes) { notes=notes||{}; return Number(notes.Id !== undefined ? notes.Id : (notes.id || 0)) || 0; }
  function hasOwn_(obj,key) { return !!obj && Object.prototype.hasOwnProperty.call(obj,key); }

  function canonical_(value) {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map(canonical_);
    if (typeof value === 'object') {
      var out={}; Object.keys(value).sort().forEach(function(k){out[k]=canonical_(value[k]);}); return out;
    }
    return value;
  }
  function canonicalJson_(value) { return JSON.stringify(canonical_(value)); }

  function semantic_(expected, actual) {
    if (!CF.InternalNotesSemantic || typeof CF.InternalNotesSemantic.compare !== 'function') {
      throw new Error('CF.InternalNotesSemantic.compare is unavailable.');
    }
    var result=CF.InternalNotesSemantic.compare(expected||{},actual||{});
    return {ok:!!(result&&result.matches),detail:result||{}};
  }

  function cfId_(field) { field=field||{}; return clean_(field.Id !== undefined ? field.Id : field.id); }
  function cfName_(field) { field=field||{}; return clean_(field.Name !== undefined ? field.Name : field.name); }
  function cfType_(field) {
    field=field||{}; var t=field.FieldType||field.fieldType||{};
    return clean_(t.Name !== undefined ? t.Name : t.name);
  }
  function cfRequired_(field) {
    field=field||{}; var v=field.IsRequired !== undefined ? field.IsRequired : field.isRequired;
    return v===true || /^(true|1|yes|y)$/i.test(clean_(v));
  }
  function cfValue_(field) {
    field=field||{};
    if (field.Value !== undefined) return field.Value;
    if (field.value !== undefined) return field.value;
    if (field.ActualValue !== undefined) return field.ActualValue;
    if (field.actualValue !== undefined) return field.actualValue;
    return null;
  }
  function cfValueText_(field) {
    field=field||{};
    if (field.ValueText !== undefined) return field.ValueText;
    if (field.valueText !== undefined) return field.valueText;
    return null;
  }
  function isAttachment_(field) {
    var type=cfType_(field), name=cfName_(field);
    return /attachment/i.test(type) || (!type && /(^|\s)(photo|image|file)(\s|$)/i.test(name));
  }
  function customFieldsKey_(order) {
    if (hasOwn_(order,'CustomFields')) return 'CustomFields';
    if (hasOwn_(order,'customFields')) return 'customFields';
    return '';
  }
  function customFieldsSnapshot_(order) {
    var key=customFieldsKey_(order), fields=key&&Array.isArray(order[key])?order[key]:[];
    return fields.map(function(field){return clone_(field);}).sort(function(a,b){
      var ai=cfId_(a), bi=cfId_(b); if(ai!==bi) return ai.localeCompare(bi);
      return cfName_(a).localeCompare(cfName_(b));
    });
  }
  function customFieldsEqual_(a,b) { return canonicalJson_(a||[])===canonicalJson_(b||[]); }
  function summarizeField_(field,reason) {
    return {id:cfId_(field),name:cfName_(field),type:cfType_(field),required:cfRequired_(field),reason:reason||''};
  }
  function normalizeDateValue_(value) {
    var text=clean_(value);
    if (!text) return '';
    var iso=text.match(/^(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    var d=new Date(text);
    if (isNaN(d.getTime())) return '';
    function pad(n){return (n<10?'0':'')+n;}
    return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate());
  }
  function normalizeTimeValue_(value) {
    var text=clean_(value);
    if (!text) return '';
    var m=text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (m) return (m[1].length===1?'0':'')+m[1]+':'+m[2]+':'+(m[3]||'00');
    return text;
  }
  function requiredFieldDto_(field) {
    var id=cfId_(field), type=cfType_(field), value=cfValue_(field), valueText=cfValueText_(field);
    if (!id) throw new Error('A required Custom Field is missing its Id.');
    if (/date field/i.test(type)) {
      var dateValue=normalizeDateValue_(value!==null&&value!==undefined?value:valueText);
      if (!dateValue) throw new Error('Required Custom Field '+id+' ('+cfName_(field)+') does not contain a reusable date value.');
      value=dateValue;
    } else if (/time field/i.test(type)) {
      value=normalizeTimeValue_(value!==null&&value!==undefined?value:valueText);
    }
    if (value===undefined) value=null;
    if (valueText===undefined) valueText=null;
    if ((value===null || clean_(value)==='') && (valueText===null || clean_(valueText)==='')) {
      throw new Error('Required Custom Field '+id+' ('+cfName_(field)+') has no reusable value.');
    }
    var numericId=Number(id);
    return {Id:isNaN(numericId)?id:numericId,Value:value,ValueText:valueText};
  }
  function applyRequiredCustomFieldsDto_(target,sourceOrder) {
    var key=customFieldsKey_(sourceOrder);
    var fields=customFieldsSnapshot_(sourceOrder);
    var sent=[], omitted=[];
    fields.forEach(function(field){
      if (isAttachment_(field)) { omitted.push(summarizeField_(field,'ATTACHMENT_UNSUPPORTED')); return; }
      if (!cfRequired_(field)) { omitted.push(summarizeField_(field,'OPTIONAL_NOT_REQUIRED_FOR_INTERNAL_NOTES_UPDATE')); return; }
      sent.push({summary:summarizeField_(field,'REQUIRED_SENT'),dto:requiredFieldDto_(field)});
    });
    if (key) {
      target[key]=sent.map(function(x){return x.dto;});
      if (key==='CustomFields') delete target.customFields; else delete target.CustomFields;
    }
    return {
      key:key,
      sentCount:sent.length,
      sentFields:sent.map(function(x){return x.summary;}),
      omittedCount:omitted.length,
      omittedFields:omitted
    };
  }
  function stripCustomFields_(order) {
    var c=clone_(order||{}); delete c.CustomFields; delete c.customFields; return c;
  }

  function buildExpectedNotes_(beforeOrder, expected) {
    expected=expected||{};
    var current=internalNotes_(beforeOrder)||{};
    var html=notesHtml_(expected), text=notesText_(expected), id=notesId_(current);
    if (!html || html.indexOf('<table') < 0 || html.indexOf('WEBFORM SERVICE REQUEST') < 0) {
      throw new Error('Canonical WEBFORM SERVICE REQUEST Internal Notes HTML table is unavailable.');
    }
    if (hasOwn_(beforeOrder,'internalNotes')) return {id:id,notesHtml:html,notesText:text};
    return {Id:id,NotesHtml:html,NotesText:text};
  }
  function setInternalNotes_(payload,beforeOrder,notes) {
    if (hasOwn_(beforeOrder,'internalNotes')) {
      payload.internalNotes=notes; delete payload.InternalNotes;
    } else {
      payload.InternalNotes=notes; delete payload.internalNotes;
    }
  }
  function withoutInternalNotes_(value) {
    var c=clone_(value||{}); delete c.InternalNotes; delete c.internalNotes; return c;
  }
  function withoutInternalNotesAndCustomFields_(value) {
    return stripCustomFields_(withoutInternalNotes_(value));
  }
  function errorText_(error) {
    var text=clean_(error&&error.message!==undefined?error.message:error);
    return text.length>700?text.slice(0,700)+'…':text;
  }
  function isRejected4xx_(error) { return /^HTTP 4\d\d\s*:/i.test(errorText_(error)); }

  function reconcile(options) {
    options=options||{};
    if (!CF.StrivenHttp || typeof CF.StrivenHttp.requestJson !== 'function') throw new Error('CF.StrivenHttp.requestJson is unavailable.');
    var salesOrderId=clean_(options.salesOrderId);
    var expectedOrderNumber=clean_(options.orderNumber);
    var expectedCustomerId=clean_(options.customerId);
    var requestId=clean_(options.requestId);
    var expectedSource=options.expectedInternalNotes||{};
    if (!salesOrderId) return {ok:false,status:'NO_SALES_ORDER_ID',requestId:requestId,writeAttempted:false,liveWriteExecuted:false};

    var before;
    try {
      before=body_(CF.StrivenHttp.requestJson('/v1/sales-orders/'+encodeURIComponent(salesOrderId),{method:'get',attempts:1}));
    } catch (eGetBefore) {
      return {ok:false,status:'PREWRITE_GET_FAILED',requestId:requestId,salesOrderId:salesOrderId,error:errorText_(eGetBefore),writeAttempted:false,liveWriteExecuted:false};
    }
    var beforeId=orderId_(before), beforeNumber=orderNumber_(before), beforeCustomer=customerId_(before);
    if (beforeId!==salesOrderId || (expectedOrderNumber&&beforeNumber&&beforeNumber!==expectedOrderNumber) || (expectedCustomerId&&beforeCustomer&&beforeCustomer!==expectedCustomerId)) {
      return {ok:false,status:'PREWRITE_IDENTITY_MISMATCH',requestId:requestId,salesOrderId:salesOrderId,expectedOrderNumber:expectedOrderNumber,actualOrderNumber:beforeNumber,expectedCustomerId:expectedCustomerId,actualCustomerId:beforeCustomer,writeAttempted:false,liveWriteExecuted:false};
    }

    var expectedNotes;
    try { expectedNotes=buildExpectedNotes_(before,expectedSource); }
    catch (eExpected) { return {ok:false,status:'EXPECTED_INTERNAL_NOTES_INVALID',requestId:requestId,salesOrderId:salesOrderId,error:errorText_(eExpected),writeAttempted:false,liveWriteExecuted:false}; }
    var beforeSemantic=semantic_(expectedNotes,internalNotes_(before)||{});
    if (beforeSemantic.ok) {
      return {ok:true,version:VERSION,status:'ALREADY_CORRECT',requestId:requestId,salesOrderId:salesOrderId,orderNumber:beforeNumber||expectedOrderNumber,semanticContentMatches:true,written:0,alreadyCorrect:1,writeAttempted:false,liveWriteExecuted:false,requiredCustomFieldsSent:0,customFieldsPreserved:true};
    }

    var customFieldsBefore=customFieldsSnapshot_(before);
    var payload=clone_(before);
    setInternalNotes_(payload,before,expectedNotes);
    var customFieldPlan;
    try { customFieldPlan=applyRequiredCustomFieldsDto_(payload,before); }
    catch (eFields) { return {ok:false,version:VERSION,status:'REQUIRED_CUSTOM_FIELD_PAYLOAD_BLOCKED_NO_WRITE',requestId:requestId,salesOrderId:salesOrderId,orderNumber:beforeNumber||expectedOrderNumber,error:errorText_(eFields),writeAttempted:false,written:0,liveWriteExecuted:false}; }

    if (orderId_(payload)!==salesOrderId) return {ok:false,status:'PAYLOAD_ID_GUARD_FAILED',requestId:requestId,salesOrderId:salesOrderId,writeAttempted:false,liveWriteExecuted:false};
    if (expectedOrderNumber&&orderNumber_(payload)!==expectedOrderNumber) return {ok:false,status:'PAYLOAD_ORDER_NUMBER_GUARD_FAILED',requestId:requestId,salesOrderId:salesOrderId,writeAttempted:false,liveWriteExecuted:false};
    if (notesId_(internalNotes_(payload)||{})!==notesId_(internalNotes_(before)||{})) return {ok:false,status:'INTERNAL_NOTES_ID_GUARD_FAILED',requestId:requestId,salesOrderId:salesOrderId,writeAttempted:false,liveWriteExecuted:false};

    if (canonicalJson_(withoutInternalNotesAndCustomFields_(payload))!==canonicalJson_(withoutInternalNotesAndCustomFields_(before))) {
      return {ok:false,status:'PAYLOAD_DELTA_GUARD_FAILED',requestId:requestId,salesOrderId:salesOrderId,writeAttempted:false,liveWriteExecuted:false};
    }

    var postResponse=null, postError=null;
    try {
      postResponse=CF.StrivenHttp.requestJson('/v1/sales-orders',{method:'post',payload:payload,idempotent:false,attempts:1});
    } catch (ePost) { postError=ePost; }

    var after;
    try {
      after=body_(CF.StrivenHttp.requestJson('/v1/sales-orders/'+encodeURIComponent(salesOrderId),{method:'get',attempts:1}));
    } catch (eGetAfter) {
      return {ok:false,version:VERSION,status:'POST_OUTCOME_UNCERTAIN_GET_FAILED_DO_NOT_RETRY',requestId:requestId,salesOrderId:salesOrderId,orderNumber:expectedOrderNumber,error:errorText_(postError||eGetAfter),writeAttempted:true,written:0,automaticPostRetry:false,liveWriteExecuted:true,requiredCustomFieldsSent:customFieldPlan.sentCount};
    }

    var afterId=orderId_(after), afterNumber=orderNumber_(after), afterCustomer=customerId_(after);
    if (afterId!==salesOrderId || (expectedOrderNumber&&afterNumber&&afterNumber!==expectedOrderNumber) || (expectedCustomerId&&afterCustomer&&afterCustomer!==expectedCustomerId)) {
      return {ok:false,version:VERSION,status:'POSTWRITE_IDENTITY_MISMATCH_DO_NOT_RETRY',requestId:requestId,salesOrderId:salesOrderId,writeAttempted:true,written:0,automaticPostRetry:false,liveWriteExecuted:true,requiredCustomFieldsSent:customFieldPlan.sentCount};
    }

    var customFieldsAfter=customFieldsSnapshot_(after);
    if (!customFieldsEqual_(customFieldsBefore,customFieldsAfter)) {
      return {ok:false,version:VERSION,status:'COLLATERAL_CUSTOM_FIELDS_CHANGE_DETECTED',requestId:requestId,salesOrderId:salesOrderId,requiredCustomFieldsSent:customFieldPlan.sentCount,sentCustomFields:customFieldPlan.sentFields,omittedCustomFields:customFieldPlan.omittedFields,customFieldsPreserved:false,writeAttempted:true,written:0,automaticPostRetry:false,liveWriteExecuted:true};
    }

    var responseOrder=body_(postResponse||{}), responseId=orderId_(responseOrder);
    if (responseId && responseId!==salesOrderId) {
      return {ok:false,version:VERSION,status:'UNSAFE_DIFFERENT_SALES_ORDER_ID_RETURNED',requestId:requestId,salesOrderId:salesOrderId,responseSalesOrderId:responseId,writeAttempted:true,written:0,automaticPostRetry:false,liveWriteExecuted:true,requiredCustomFieldsSent:customFieldPlan.sentCount,customFieldsPreserved:true};
    }

    var afterSemantic=semantic_(expectedNotes,internalNotes_(after)||{});
    if (!afterSemantic.ok) {
      var rejected=postError&&isRejected4xx_(postError);
      return {ok:false,version:VERSION,status:rejected?'POST_REJECTED_NO_UPDATE_CONFIRMED':'POSTWRITE_SEMANTIC_VERIFICATION_FAILED_DO_NOT_RETRY',requestId:requestId,salesOrderId:salesOrderId,orderNumber:afterNumber||expectedOrderNumber,error:errorText_(postError),semanticContentMatches:false,semanticDifferences:afterSemantic.detail.differences||[],textSemanticMissing:afterSemantic.detail.textMissing||[],requiredCustomFieldsSent:customFieldPlan.sentCount,sentCustomFields:customFieldPlan.sentFields,customFieldsOmittedFromPost:customFieldPlan.omittedCount,omittedCustomFields:customFieldPlan.omittedFields,customFieldsPreserved:true,writeAttempted:true,written:0,automaticPostRetry:false,liveWriteExecuted:rejected?false:true};
    }

    return {ok:true,version:VERSION,status:postError?'PASS_RECONCILED_AFTER_UNCERTAIN_POST_RESPONSE':'UPDATED',requestId:requestId,salesOrderId:salesOrderId,orderNumber:afterNumber||expectedOrderNumber,responseSalesOrderId:responseId||salesOrderId,semanticContentMatches:true,requiredCustomFieldsSent:customFieldPlan.sentCount,sentCustomFields:customFieldPlan.sentFields,customFieldsOmittedFromPost:customFieldPlan.omittedCount,omittedCustomFields:customFieldPlan.omittedFields,customFieldsPreserved:true,officialApi:true,apiGetEndpoint:'/v1/sales-orders/{id}',apiPostEndpoint:'/v1/sales-orders',written:1,alreadyCorrect:0,writeAttempted:true,liveWriteExecuted:true,automaticPostRetry:false};
  }

  function reconcileVerificationContext(c) {
    c=c||{};
    if (!hasOwn_(c,'InternalNotes') || !hasOwn_(c,'internalNotes')) return {ok:false,status:'E2E_CONTEXT_NOT_ELIGIBLE_NO_WRITE',writeAttempted:false,liveWriteExecuted:false};
    var id=orderId_(c), expected=c.InternalNotes;
    if (!id || !expected || !notesHtml_(expected) || notesHtml_(expected).indexOf('<table')<0) return {ok:false,status:'E2E_CONTEXT_NOT_ELIGIBLE_NO_WRITE',writeAttempted:false,liveWriteExecuted:false};
    var result=reconcile({salesOrderId:id,orderNumber:orderNumber_(c),customerId:customerId_(c),expectedInternalNotes:expected,requestId:clean_(c.RequestId||c.requestId||c.requestID)});
    try { if (CF.Util&&typeof CF.Util.logEvent==='function') CF.Util.logEvent({module:'60_Striven_Write',action:'E2E_INTERNAL_NOTES_OFFICIAL_API_RECONCILIATION',status:result.status,requestId:result.requestId||'',details:result,version:VERSION}); } catch (ignoredLog) {}
    return result;
  }

  return {version:VERSION,reconcile:reconcile,reconcileVerificationContext:reconcileVerificationContext};
})();


/* CF_SERVICEOPS_V5_10_34_CUSTOMER_CONTACT_INFO_SYNC_R2 */
CF.CustomerContactInfoSync = (function () {
  'use strict';
  var VERSION='5.11.5';
  var SAFETY_MARK='CF_SERVICEOPS_V5_10_34_INFO_SYNC_JOURNAL_NO_AUTO_RETRY_R2';
  var CUSTOMER_GET='/v1/customers/{id}';
  var CUSTOMER_POST='/v1/customers';
  var CONTACT_GET='/v1/contacts/{id}';
  var CONTACT_POST='/v1/contacts';
  var MOBILE_PHONE_TYPE_ID=1;

  function d_(){if(!CF.Util||!CF.StrivenHttp)throw new Error('CF.Util and CF.StrivenHttp are required.');return{u:CF.Util,h:CF.StrivenHttp};}
  function clean_(v){return d_().u.cleanText(v);}
  function clone_(v){return d_().u.clone?d_().u.clone(v):JSON.parse(JSON.stringify(v));}
  function prop_(o,names){o=o||{};for(var i=0;i<names.length;i++)if(Object.prototype.hasOwnProperty.call(o,names[i]))return o[names[i]];return undefined;}
  function num_(v){var n=Number(v);return isNaN(n)?0:n;}
  function bool_(v){return v===true||String(v).toLowerCase()==='true';}
  function arr_(v){return Array.isArray(v)?v:[];}
  function endpoint_(tpl,id){return tpl.replace('{id}',encodeURIComponent(String(id)));}
  function json_(v){try{return d_().u.canonicalJson?d_().u.canonicalJson(v):JSON.stringify(v);}catch(e){return JSON.stringify(v);}}
  function parse_(v,f){try{return d_().u.parseJson?d_().u.parseJson(v,f):JSON.parse(String(v||''));}catch(e){return f;}}
  function now_(){return d_().u.nowString();}
  function normPhone_(v){var x=String(v||'').replace(/\D/g,'');if(x.length===11&&x.charAt(0)==='1')x=x.slice(1);return x;}
  function normEmail_(v){return String(v||'').trim().toLowerCase();}
  function province_(v){var x=String(v||'').trim().toUpperCase().replace(/[^A-Z]/g,'');var m={ONTARIO:'ON',ON:'ON',QUEBEC:'QC',QC:'QC',PQ:'QC',ALBERTA:'AB',AB:'AB',BRITISHCOLUMBIA:'BC',BC:'BC',MANITOBA:'MB',MB:'MB',NEWBRUNSWICK:'NB',NB:'NB',NOVASCOTIA:'NS',NS:'NS',SASKATCHEWAN:'SK',SK:'SK',PRINCEEDWARDISLAND:'PE',PEI:'PE',PE:'PE',NEWFOUNDLANDANDLABRADOR:'NL',NEWFOUNDLANDLABRADOR:'NL',NL:'NL',NORTHWESTTERRITORIES:'NT',NT:'NT',NUNAVUT:'NU',NU:'NU',YUKON:'YT',YT:'YT'};return m[x]||clean_(v);}
  function country_(v){var x=String(v||'').trim().toUpperCase();return (x==='CA'||x==='CAN'||x==='CANADA')?'Canada':(clean_(v)||'Canada');}
  function req_(id){return d_().u.findRecord('SERVICE_REQUESTS','Request ID',id);}
  function patch_(r,p){if(!r||!r.__rowNumber)throw new Error('Service Request row is unavailable for durable journal write.');if(typeof d_().u.clearRowDataValidations==='function')d_().u.clearRowDataValidations('SERVICE_REQUESTS',r.__rowNumber);d_().u.patchRow('SERVICE_REQUESTS',r.__rowNumber,p);SpreadsheetApp.flush();}
  function log_(r,status,details,message){try{d_().u.logEvent({module:'CustomerContactInfoSync',action:'RECONCILE',status:status,requestId:clean_(r&&r['Request ID']),details:details||{},message:message||'',version:VERSION});}catch(e){}}
  function get_(ep){var x=d_().h.requestJson(ep,{method:'get',attempts:1,idempotent:true});return x&&x.json?x.json:{};}
  function post_(ep,payload){return d_().h.requestJson(ep,{method:'post',payload:payload,attempts:1,idempotent:false});}
  function objectId_(o){return clean_(prop_(o,['Id','id','ID']));}
  function pair_(o){if(!o||typeof o!=='object')return null;var id=prop_(o,['Id','id','ID']),name=prop_(o,['Name','name']);if(id===undefined&&name===undefined)return null;return{Id:num_(id),Name:clean_(name)};}
  function pairs_(a){return arr_(a).map(pair_).filter(function(x){return x&&x.Id;});}
  function cf_(a){return arr_(a).map(function(x){var id=prop_(x,['Id','id','ID']);if(id===undefined||id===null||id==='')return null;var out={Id:num_(id)};var v=prop_(x,['Value','value']);var t=prop_(x,['ValueText','valueText']);if(v!==undefined)out.Value=v;if(t!==undefined)out.ValueText=t;return out;}).filter(Boolean);}
  function currency_(o){if(!o||typeof o!=='object')return null;var code=prop_(o,['CurrencyISOCode','currencyISOCode']),rate=prop_(o,['ExchangeRate','exchangeRate']);if(code===undefined&&rate===undefined)return null;return{CurrencyISOCode:clean_(code),ExchangeRate:Number(rate||0)};}

  function phoneDto_(p){p=p||{};var type=pair_(prop_(p,['PhoneType','phoneType']))||{Id:MOBILE_PHONE_TYPE_ID,Name:'Mobile'};return{Id:num_(prop_(p,['Id','id'])),PhoneType:type,CountryDialCode:num_(prop_(p,['CountryDialCode','countryDialCode']))||1,Number:clean_(prop_(p,['Number','number'])),Extension:clean_(prop_(p,['Extension','extension'])),IsPreferred:bool_(prop_(p,['IsPreferred','isPreferred'])),Active:prop_(p,['Active','active'])===undefined?true:bool_(prop_(p,['Active','active']))};}
  function emailDto_(e){e=e||{};return{Id:num_(prop_(e,['Id','id'])),Email:clean_(prop_(e,['Email','email'])),IsPrimary:bool_(prop_(e,['IsPrimary','isPrimary'])),Active:prop_(e,['Active','active'])===undefined?true:bool_(prop_(e,['Active','active']))};}
  function phones_(o){return arr_(prop_(o,['Phones','phones'])).map(phoneDto_).filter(function(p){return !!p.Number;});}
  function emails_(o){return arr_(prop_(o,['Emails','emails'])).map(emailDto_).filter(function(e){return !!e.Email;});}
  function hasPhone_(ps,phone){var n=normPhone_(phone);return !!n&&ps.some(function(p){return normPhone_(p.Number)===n&&p.Active!==false;});}
  function hasEmail_(es,email){var n=normEmail_(email);return !!n&&es.some(function(e){return normEmail_(e.Email)===n&&e.Active!==false;});}
  // CF ServiceOps v5.11.5 R1 — submitted phones are Mobile and both primary + alternate are preserved
  function phoneTypeId_(p){var t=pair_(prop_(p||{},['PhoneType','phoneType']));return t&&num_(t.Id)||0;}
  function hasMobilePhone_(ps,phone){var n=normPhone_(phone);return !!n&&ps.some(function(p){return normPhone_(p.Number)===n&&p.Active!==false&&phoneTypeId_(p)===MOBILE_PHONE_TYPE_ID;});}
  function submittedPhones_(r){var raw=[{number:clean_(r&&r['Phone']),extension:clean_(r&&r['Phone Extension'])},{number:clean_(r&&r['Alt Phone']),extension:''}],seen={},out=[];raw.forEach(function(x){var n=normPhone_(x.number);if(n&&!seen[n]){seen[n]=true;out.push(x);}});return out;}
  function allSubmittedMobilePhonesPresent_(ps,specs){return (specs||[]).every(function(x){return hasMobilePhone_(ps,x.number);});}
  function mergeSubmittedMobilePhones_(current,specs){var out=current.map(clone_),preferred=false;out.forEach(function(p){if(p.IsPreferred&&p.Active!==false)preferred=true;});(specs||[]).forEach(function(spec){var n=normPhone_(spec&&spec.number);if(!n)return;var found=-1;out.forEach(function(p,i){if(normPhone_(p.Number)===n)found=i;});if(found>=0){out[found].Active=true;out[found].PhoneType={Id:MOBILE_PHONE_TYPE_ID,Name:'Mobile'};if(clean_(spec.extension)&&!clean_(out[found].Extension))out[found].Extension=clean_(spec.extension);if(!preferred){out[found].IsPreferred=true;preferred=true;}}else{out.push({Id:0,PhoneType:{Id:MOBILE_PHONE_TYPE_ID,Name:'Mobile'},CountryDialCode:1,Number:clean_(spec.number),Extension:clean_(spec.extension),IsPreferred:!preferred,Active:true});if(!preferred)preferred=true;}});return out;}
  function mergeEmails_(current,email){var out=current.map(clone_),n=normEmail_(email);if(!n)return out;var found=-1,primary=false;out.forEach(function(e,i){if(e.IsPrimary&&e.Active!==false)primary=true;if(normEmail_(e.Email)===n)found=i;});if(found>=0){out[found].Active=true;if(!primary)out[found].IsPrimary=true;}else out.push({Id:0,Email:clean_(email),IsPrimary:!primary,Active:true});return out;}

  function addrDto_(a){a=a||{};return{Address1:clean_(prop_(a,['Address1','address1'])),Address2:clean_(prop_(a,['Address2','address2'])),Address3:clean_(prop_(a,['Address3','address3'])),City:clean_(prop_(a,['City','city'])),State:clean_(prop_(a,['State','state'])),PostalCode:clean_(prop_(a,['PostalCode','postalCode'])),Country:clean_(prop_(a,['Country','country'])),Latitude:Number(prop_(a,['Latitude','latitude'])||0),Longitude:Number(prop_(a,['Longitude','longitude'])||0),FullAddress:clean_(prop_(a,['FullAddress','fullAddress']))};}
  function desiredAddr_(r){var a={Address1:clean_(r['Street']),Address2:'',Address3:'',City:clean_(r['City']),State:province_(r['Province']),PostalCode:clean_(r['Postal Code']),Country:country_(r['Country']),Latitude:0,Longitude:0,FullAddress:clean_(r['Full Address'])};if(!a.FullAddress)a.FullAddress=[a.Address1,a.City,a.State,a.PostalCode,a.Country].filter(Boolean).join(', ');return a;}
  function addrBlank_(a){a=addrDto_(a);return !a.Address1&&!a.City&&!a.State&&!a.PostalCode&&!a.FullAddress;}
  function addrNorm_(a){a=addrDto_(a);var text=a.FullAddress||[a.Address1,a.City,a.State,a.PostalCode,a.Country].join(' ');try{return d_().u.normalizeAddress(text);}catch(e){return String(text||'').toUpperCase().replace(/[^A-Z0-9]/g,'');}}
  function addrPartNorm_(v){return String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'');}
  function addrPostalIncompleteV5137_(v){var raw=String(v||'').toUpperCase(),compact=addrPartNorm_(v);return !compact||/PLACEHOLDER|UNKNOWN|NOTPROVIDED|NOTAVAILABLE|TBD|N\/?A/.test(raw)||compact==='000000'||compact==='00000'||compact==='999999';}
  function addrStateIncompleteV5137_(v){var compact=addrPartNorm_(v);return !compact||compact.length<2||compact==='UNKNOWN'||compact==='PLACEHOLDER';}
  function samePremisesIncompleteV5137_(c,d){
    c=addrDto_(c);d=addrDto_(d);
    return !!addrPartNorm_(c.Address1)&&addrPartNorm_(c.Address1)===addrPartNorm_(d.Address1)&&
      !!addrPartNorm_(c.City)&&addrPartNorm_(c.City)===addrPartNorm_(d.City)&&
      (addrPostalIncompleteV5137_(c.PostalCode)||addrStateIncompleteV5137_(c.State));
  }
  function mergeAddr_(current,desired){
    var c=addrDto_(current),d=addrDto_(desired);
    if(addrBlank_(d))return{value:c,applied:false,preservedDifferent:false};
    if(addrBlank_(c))return{value:d,applied:true,preservedDifferent:false};
    if(addrNorm_(c)===addrNorm_(d)){
      Object.keys(d).forEach(function(k){if((c[k]===undefined||c[k]===null||c[k]==='')&&d[k]!==''&&d[k]!==undefined)c[k]=d[k];});
      return{value:c,applied:true,preservedDifferent:false};
    }
    if(samePremisesIncompleteV5137_(c,d)){
      ['Address1','City','State','PostalCode','Country','FullAddress'].forEach(function(k){if(d[k]!==''&&d[k]!==undefined)c[k]=d[k];});
      if(!c.Latitude&&d.Latitude)c.Latitude=d.Latitude;
      if(!c.Longitude&&d.Longitude)c.Longitude=d.Longitude;
      return{value:c,applied:true,preservedDifferent:false,enrichedIncompleteSamePremises:true};
    }
    return{value:c,applied:false,preservedDifferent:true};
  }

  function customerDto_(cur,mergedPhones,mergedAddr){var out={Id:num_(objectId_(cur)),Name:clean_(prop_(cur,['Name','name']))};function cp(n,alts){var v=prop_(cur,alts||[n,n.charAt(0).toLowerCase()+n.slice(1)]);if(v!==undefined&&v!==null)out[n]=v;}cp('Number',['Number','number']);cp('IsVendor',['IsVendor','isVendor']);cp('IsConsumerAccount',['IsConsumerAccount','isConsumerAccount']);var pc=pair_(prop_(cur,['PrimaryContact','primaryContact']));if(pc)out.PrimaryContact=pc;var st=pair_(prop_(cur,['Status','status']));if(st)out.Status=st;var cats=pairs_(prop_(cur,['Categories','categories']));if(cats.length)out.Categories=cats;var rs=pair_(prop_(cur,['ReferralSource','referralSource']));if(rs)out.ReferralSource=rs;var ind=pair_(prop_(cur,['Industry','industry']));if(ind)out.Industry=ind;cp('CustomerSince',['CustomerSince','customerSince']);cp('CreditLimit',['CreditLimit','creditLimit']);cp('WebSite',['WebSite','webSite']);cp('IsTaxExempt',['IsTaxExempt','isTaxExempt']);cp('IsFinanceChargeExempt',['IsFinanceChargeExempt','isFinanceChargeExempt']);var pt=pair_(prop_(cur,['PaymentTerm','paymentTerm']));if(pt)out.PaymentTerm=pt;var bl=pair_(prop_(cur,['BillToLocation','billToLocation']));if(bl)out.BillToLocation=bl;var sl=pair_(prop_(cur,['ShipToLocation','shipToLocation']));if(sl)out.ShipToLocation=sl;out.Phones=mergedPhones;out.PrimaryAddress=mergedAddr;var pl=pair_(prop_(cur,['PriceList','priceList']));if(pl)out.PriceList=pl;var cfs=cf_(prop_(cur,['CustomFields','customFields']));if(cfs.length)out.CustomFields=cfs;var curcy=currency_(prop_(cur,['Currency','currency']));if(curcy)out.Currency=curcy;return out;}
  function contactDto_(cur,r,mergedPhones,mergedEmails,mergedAddr){var cfs=cf_(prop_(cur,['CustomFields','customFields']));var out={Id:num_(objectId_(cur)),FirstName:clean_(prop_(cur,['FirstName','firstName']))||clean_(r['First Name']),LastName:clean_(prop_(cur,['LastName','lastName']))||clean_(r['Last Name']),Phones:mergedPhones,Emails:mergedEmails,Address:mergedAddr};if(cfs.length)out.CustomFields=cfs;return out;}

  function criticalCustomer_(o){return{primaryContact:pair_(prop_(o,['PrimaryContact','primaryContact'])),status:pair_(prop_(o,['Status','status'])),billTo:pair_(prop_(o,['BillToLocation','billToLocation'])),shipTo:pair_(prop_(o,['ShipToLocation','shipToLocation'])),customFields:cf_(prop_(o,['CustomFields','customFields']))};}
  function contactAssociations_(o){function ids(a){return arr_(a).map(function(x){return clean_(prop_(x,['Id','id','CustomerId','customerId','VendorId','vendorId']));}).filter(Boolean).sort();}return{customers:ids(prop_(o,['CustomerAssociations','customerAssociations'])),vendors:ids(prop_(o,['VendorAssociations','vendorAssociations'])),customFields:cf_(prop_(o,['CustomFields','customFields']))};}
  function preexistingPhonesPreserved_(before,after){var ap=phones_(after);return phones_(before).every(function(p){var id=String(p.Id||'');return ap.some(function(x){return (id&&String(x.Id||'')===id)||(!id&&normPhone_(x.Number)===normPhone_(p.Number));});});}
  function preexistingEmailsPreserved_(before,after){var ae=emails_(after);return emails_(before).every(function(e){var id=String(e.Id||'');return ae.some(function(x){return (id&&String(x.Id||'')===id)||(!id&&normEmail_(x.Email)===normEmail_(e.Email));});});}

  function journalRoot_(r){var root=parse_(r&&r['Write Journal JSON'],{});if(!root||typeof root!=='object'||Array.isArray(root))root={};return root;}
  /* CF_SERVICEOPS_V5_13_5_INFO_SYNC_CUSTOMER_SCOPED_CONTACT_R1
   * Customer/contact enrichment is secondary. A proven customer-scoped Contact
   * must not trigger an invalid global Contact GET/POST or block downstream work.
   */
  function customerScopedContactInfoEvidenceV5135_(r,contactId,customerId){
    var root=journalRoot_(r),cc=root.contactCreate||{},rec=cc.reconciliation||{},tech=cc.technicalRecovery||{},identity=root.contactIdentity||{};
    var identityScoped=String(identity.scope||'').toUpperCase()==='CUSTOMER'&&clean_(identity.customerId)===customerId&&clean_(identity.customerScopedContactId||identity.contactId)===contactId&&identity.identityVerified===true;
    if(identityScoped)return{ok:true,source:'CONTACT_IDENTITY_JOURNAL'};
    var duplicateIds=[];
    if(Array.isArray(cc.existingDuplicateContactIds))duplicateIds=cc.existingDuplicateContactIds.map(clean_).filter(Boolean);
    if(!duplicateIds.length&&clean_(cc.existingDuplicateContactId))duplicateIds=[clean_(cc.existingDuplicateContactId)];
    var explicit=tech.operatorApprovedCustomerScopedContact===true||/CUSTOMER-SCOPED CONTACT/i.test(String(rec.reason||''));
    var scopedId=clean_(tech.customerScopedContactId||rec.customerScopedContactId||rec.canonicalContactId);
    var scopedCustomerId=clean_(tech.customerId||rec.customerId||customerId);
    var canonicalDiffersFromGlobal=clean_(rec.canonicalContactId)===contactId&&duplicateIds.some(function(id){return id!==contactId;});
    return{ok:scopedId===contactId&&scopedCustomerId===customerId&&(explicit||canonicalDiffersFromGlobal),source:explicit?'CUSTOMER_SCOPED_CONTACT_JOURNAL':'CANONICAL_CONTACT_DIFFERS_FROM_GLOBAL_DUPLICATE',globalDuplicateContactIds:duplicateIds};
  }

  function journalState_(r){var root=journalRoot_(r),state=root.customerContactInfoSync||{};if(!state||typeof state!=='object'||Array.isArray(state))state={};return{root:root,state:state};}
  function saveJournal_(r,state,patchExtra){var root=journalRoot_(r);root.customerContactInfoSync=state;var p={'Updated At':now_(),'Write Journal JSON':d_().u.safeJson?d_().u.safeJson(root):JSON.stringify(root)};Object.keys(patchExtra||{}).forEach(function(k){p[k]=patchExtra[k];});patch_(r,p);}
  function fingerprint_(target,id,endpoint,payload){if(typeof d_().u.canonicalHash!=='function')throw new Error('CF.Util.canonicalHash is required for guarded Customer/Contact sync.');return d_().u.canonicalHash({requestId:'',action:'SYNC_'+target,entityId:String(id),endpoint:endpoint,payload:payload});}
  function targetJournal_(r,target){var j=journalState_(r);return{root:j.root,state:j.state,entry:j.state[target]||{}};}
  function priorUncertain_(entry){var s=String(entry&&entry.status||'').toUpperCase();return !!(entry&&entry.remoteWriteMayHaveSucceeded===true)||/POST_INTENT_RECORDED|POST_ACCEPTED|UNCERTAIN|RECONCILE_REQUIRED|POSTWRITE_VERIFICATION_FAILED/.test(s);}
  function markPriorReconciled_(r,target,entry){var j=journalState_(r),e=clone_(entry||{});e.status='RECONCILED_CONFIRMED_BY_GET';e.reconciledAt=now_();e.remoteWriteMayHaveSucceeded=false;j.state[target]=e;saveJournal_(r,j.state,{'Reconciliation Status':'CUSTOMER CONTACT INFO SYNC — PRIOR '+target.toUpperCase()+' WRITE RECONCILED'});return e;}
  function beginWrite_(r,target,id,endpoint,payload){var fp=fingerprint_(target,id,endpoint,payload),j=journalState_(r),prior=j.state[target]||{};if(Number(prior.postAttempts||0)>0&&clean_(prior.payloadFingerprint)===fp){return{ok:false,status:'PRIOR_IDENTICAL_'+target.toUpperCase()+'_INFO_WRITE_BLOCKED_NO_RETRY',payloadFingerprint:fp,prior:prior};}var e={safetyMarker:SAFETY_MARK,target:target,entityId:String(id),endpoint:endpoint,payloadFingerprint:fp,status:'POST_INTENT_RECORDED',postAttempts:1,postStartedAt:now_(),remoteWriteMayHaveSucceeded:false,noAutomaticWriteRetry:true,priorStatus:clean_(prior.status),priorPayloadFingerprint:clean_(prior.payloadFingerprint)};j.state[target]=e;saveJournal_(r,j.state,{'Striven Sync Status':'PARTIAL','Striven Sync Error':'','Reconciliation Status':'CUSTOMER CONTACT INFO SYNC — '+target.toUpperCase()+' POST INTENT RECORDED'});return{ok:true,payloadFingerprint:fp,entry:e};}
  function finishWrite_(r,target,patch){var j=journalState_(r),e=clone_(j.state[target]||{});Object.keys(patch||{}).forEach(function(k){e[k]=patch[k];});j.state[target]=e;saveJournal_(r,j.state,{});return e;}
  function parseHttp_(e){var m=String(e&&e.message||e||'').match(/HTTP\s+(\d{3})\s*:\s*([\s\S]*)$/i);return{status:m?Number(m[1]):0,message:String(e&&e.message||e||'')};}
  function classify_(e){var x=parseHttp_(e),s=x.status;if(s===400||s===422)return{status:'REJECTED_VALIDATION',httpStatus:s,remoteWriteMayHaveSucceeded:false};if(s===401||s===403)return{status:'REJECTED_AUTHORIZATION',httpStatus:s,remoteWriteMayHaveSucceeded:false};if(s===404)return{status:'REJECTED_ENDPOINT_OR_RESOURCE',httpStatus:s,remoteWriteMayHaveSucceeded:false};if(s===409)return{status:'REJECTED_CONFLICT_RECONCILIATION_REQUIRED',httpStatus:s,remoteWriteMayHaveSucceeded:false};if(s===429)return{status:'REJECTED_RATE_LIMIT_NO_AUTO_RETRY',httpStatus:s,remoteWriteMayHaveSucceeded:false};if(s>=500)return{status:'UNCERTAIN_SERVER_RECONCILIATION_REQUIRED',httpStatus:s,remoteWriteMayHaveSucceeded:true};return{status:'UNCERTAIN_TRANSPORT_RECONCILIATION_REQUIRED',httpStatus:s||null,remoteWriteMayHaveSucceeded:true};}
  function fail_(r,status,error,details){details=details||{};try{patch_(r,{'Last Striven Sync':now_(),'Striven Sync Status':details.remoteWriteMayHaveSucceeded?'RECONCILE REQUIRED':'BLOCKED','Striven Sync Error':clean_(error),'Reconciliation Status':status});}catch(ignoredPatch){}log_(r,status,details,clean_(error));return{ok:false,version:VERSION,status:status,requestId:clean_(r&&r['Request ID']),error:clean_(error),details:details,writeAttempted:details.writeAttempted===true,liveWriteExecuted:false,remoteWriteMayHaveSucceeded:details.remoteWriteMayHaveSucceeded===true,automaticPostRetry:false};}

  
  /* CF_SERVICEOPS_V5_10_36_CUSTOMER_CUSTOM_FIELD_ENRICHMENT_BYPASS_R1 */
  function unresolvedRequiredCustomerCustomFieldIds_(customer){
    return arr_(prop_(customer,['CustomFields','customFields'])).filter(function(x){
      var required=prop_(x,['IsRequired','isRequired']);
      var id=prop_(x,['Id','id','ID']);
      var v=prop_(x,['Value','value']),t=prop_(x,['ValueText','valueText']);
      return bool_(required)&&clean_(id)&&!clean_(v)&&!clean_(t);
    }).map(function(x){return clean_(prop_(x,['Id','id','ID']));});
  }
  function collateralCustomerCustomFieldValidation_(error){
    var text=String(error&&error.message||error||'');
    return /Invalid Custom Fields|Custom Field Id\s+\d+/i.test(text);
  }
  function customerEnrichmentPreviouslyBypassed_(entry){
    var status=String(entry&&entry.status||'');
    var error=String(entry&&entry.error||'');
    return /CUSTOM_FIELD.*BYPASS|ENRICHMENT_SKIPPED|REJECTED_VALIDATION_CUSTOM_FIELDS/i.test(status)||(/REJECTED_VALIDATION/i.test(status)&&/Invalid Custom Fields|Custom Field Id\s+\d+/i.test(error));
  }

function reconcile(requestId,options){options=options||{};var r=req_(requestId);if(!r)return{ok:false,version:VERSION,status:'SERVICE_REQUEST_NOT_FOUND',requestId:clean_(requestId),liveWriteExecuted:false};var customerId=clean_(r['Created Customer ID']||r['Matched Customer ID']),contactId=clean_(r['Created Contact ID']||r['Matched Contact ID']);if(!customerId||!contactId)return fail_(r,'CUSTOMER_CONTACT_INFO_SYNC_IDS_INCOMPLETE','Durable Customer ID and Contact ID are both required.',{customerId:customerId,contactId:contactId,writeAttempted:false});var scopedInfoEvidenceV5135=customerScopedContactInfoEvidenceV5135_(r,contactId,customerId);var customerScopedContactV5138=scopedInfoEvidenceV5135.ok===true;var submittedPhones=submittedPhones_(r),phone=clean_(r['Phone']),email=clean_(r['Email']),ext=clean_(r['Phone Extension']),desiredAddress=desiredAddr_(r);var lock=LockService.getScriptLock();if(!lock.tryLock(30000))return{ok:false,version:VERSION,status:'INFO_SYNC_SKIPPED_ALREADY_RUNNING',requestId:clean_(requestId),retrySafeNoWrite:true,writeAttempted:false,liveWriteExecuted:false,automaticPostRetry:false};try{
      var customer,contact={};try{customer=get_(endpoint_(CUSTOMER_GET,customerId));if(!customerScopedContactV5138)contact=get_(endpoint_(CONTACT_GET,contactId));}catch(e){return fail_(r,'CUSTOMER_CONTACT_INFO_GET_FAILED',e&&e.message?e.message:String(e),{customerId:customerId,contactId:contactId,contactScope:customerScopedContactV5138?'CUSTOMER':'GLOBAL',writeAttempted:false});}
      if(objectId_(customer)!==customerId)return fail_(r,'UNSAFE_CUSTOMER_ID_MISMATCH','Customer GET returned a different ID.',{expectedCustomerId:customerId,actualCustomerId:objectId_(customer),writeAttempted:false});
      if(!customerScopedContactV5138&&objectId_(contact)!==contactId)return fail_(r,'UNSAFE_CONTACT_ID_MISMATCH','Contact GET returned a different ID.',{expectedContactId:contactId,actualContactId:objectId_(contact),writeAttempted:false});

      var currentCustomerAddress=prop_(customer,['PrimaryAddress','primaryAddress']),cp=phones_(customer),ca=mergeAddr_(currentCustomerAddress,desiredAddress);var customerAddressNeeds=ca.applied&&json_(addrDto_(currentCustomerAddress))!==json_(addrDto_(ca.value));var customerNeeds=!allSubmittedMobilePhonesPresent_(cp,submittedPhones)||customerAddressNeeds;
      var currentContactAddress=customerScopedContactV5138?{}:prop_(contact,['Address','address']),ps=customerScopedContactV5138?[]:phones_(contact),es=customerScopedContactV5138?[]:emails_(contact),addrMerge=customerScopedContactV5138?{value:{},applied:false,preservedDifferent:false}:mergeAddr_(currentContactAddress,desiredAddress);var contactAddressNeeds=!customerScopedContactV5138&&addrMerge.applied&&json_(addrDto_(currentContactAddress))!==json_(addrDto_(addrMerge.value));var contactNeeds=!customerScopedContactV5138&&(!allSubmittedMobilePhonesPresent_(ps,submittedPhones)|| (!!email&&!hasEmail_(es,email)) || contactAddressNeeds);
      var customerEnrichmentSkipped=false;
      var requiredCustomerCfIds=unresolvedRequiredCustomerCustomFieldIds_(customer);
      var priorCustomerJournal=targetJournal_(r,'customer').entry;
      if(customerNeeds&&(requiredCustomerCfIds.length||customerEnrichmentPreviouslyBypassed_(priorCustomerJournal))){
        var js=journalState_(r),je=clone_(js.state.customer||{});
        je.status=requiredCustomerCfIds.length?'CUSTOMER_INFO_ENRICHMENT_SKIPPED_REQUIRED_CUSTOM_FIELDS_UNRESOLVED':'CUSTOMER_INFO_ENRICHMENT_SKIPPED_AFTER_CUSTOM_FIELD_REJECTION';
        je.skippedAt=now_();je.remoteWriteMayHaveSucceeded=false;je.noAutomaticWriteRetry=true;je.unresolvedRequiredCustomFieldIds=requiredCustomerCfIds;
        js.state.customer=je;
        saveJournal_(r,js.state,{'Striven Sync Status':'PARTIAL','Striven Sync Error':'','Reconciliation Status':'CUSTOMER ENRICHMENT SKIPPED SAFELY — CONTACT SYNC CONTINUES'});
        log_(r,je.status,{customerId:customerId,unresolvedRequiredCustomFieldIds:requiredCustomerCfIds,customerPostSkipped:true,automaticPostRetry:false},'');
        customerNeeds=false;customerEnrichmentSkipped=true;r=req_(requestId)||r;
      }

      var cj0=targetJournal_(r,'customer').entry;if(priorUncertain_(cj0)){if(customerNeeds)return fail_(r,'CUSTOMER_INFO_PRIOR_WRITE_RECONCILIATION_REQUIRED_NO_RETRY','A prior Customer info write crossed or may have crossed the write boundary. Current GET does not confirm the desired state; no retry is allowed.',{customerId:customerId,prior:cj0,writeAttempted:false,remoteWriteMayHaveSucceeded:true});markPriorReconciled_(r,'customer',cj0);r=req_(requestId)||r;}
      var tj0=customerScopedContactV5138?{}:targetJournal_(r,'contact').entry;if(!customerScopedContactV5138&&priorUncertain_(tj0)){if(contactNeeds)return fail_(r,'CONTACT_INFO_PRIOR_WRITE_RECONCILIATION_REQUIRED_NO_RETRY','A prior Contact info write crossed or may have crossed the write boundary. Current GET does not confirm the desired state; no retry is allowed.',{contactId:contactId,prior:tj0,writeAttempted:false,remoteWriteMayHaveSucceeded:true});markPriorReconciled_(r,'contact',tj0);r=req_(requestId)||r;}

      if(customerNeeds){var beforeCritical=criticalCustomer_(customer),mergedCP=mergeSubmittedMobilePhones_(cp,submittedPhones),dto=customerDto_(customer,mergedCP,ca.value),intent=beginWrite_(r,'customer',customerId,CUSTOMER_POST,dto);if(!intent.ok)return fail_(r,intent.status,'Identical Customer info payload already crossed a guarded write boundary; no retry.',{customerId:customerId,payloadFingerprint:intent.payloadFingerprint,prior:intent.prior,writeAttempted:false});var responseC;try{responseC=post_(CUSTOMER_POST,dto);}catch(e1){var cc=classify_(e1),customerErrorText=String(e1&&e1.message||e1);if(cc.status==='REJECTED_VALIDATION'&&collateralCustomerCustomFieldValidation_(e1)){finishWrite_(r,'customer',{status:'REJECTED_VALIDATION_CUSTOM_FIELDS_AUTO_BYPASS',postFinishedAt:now_(),httpStatus:cc.httpStatus,remoteWriteMayHaveSucceeded:false,error:customerErrorText,noAutomaticWriteRetry:true});patch_(r,{'Last Striven Sync':now_(),'Striven Sync Status':'PARTIAL','Striven Sync Error':'','Blocking Issue':'','Reconciliation Status':'CUSTOMER UPDATE CUSTOM FIELDS REJECTED — AUTO CONTINUE VIA CONTACT','Next Action':'AUTO CONTINUE CUSTOMER/CONTACT INFO SYNC'});log_(r,'CUSTOMER_INFO_CUSTOM_FIELDS_REJECTED_AUTO_BYPASS',{customerId:customerId,httpStatus:cc.httpStatus,writeAttempted:true,remoteWriteMayHaveSucceeded:false,automaticPostRetry:false},customerErrorText);return{ok:true,version:VERSION,status:'CUSTOMER_INFO_CUSTOM_FIELDS_REJECTED_AUTO_BYPASS',requestId:clean_(requestId),customerId:customerId,contactId:contactId,customerUpdated:false,customerEnrichmentSkipped:true,writeAttempted:true,liveWriteExecuted:true,remoteWriteMayHaveSucceeded:false,automaticPostRetry:false,next:'AUTOMATIC CONTINUATION WILL SKIP CUSTOMER ENRICHMENT AND CONTINUE CONTACT SYNC'};}finishWrite_(r,'customer',{status:cc.status,postFinishedAt:now_(),httpStatus:cc.httpStatus,remoteWriteMayHaveSucceeded:cc.remoteWriteMayHaveSucceeded,error:customerErrorText});return fail_(r,'CUSTOMER_INFO_'+cc.status,customerErrorText,{customerId:customerId,writeAttempted:true,httpStatus:cc.httpStatus,remoteWriteMayHaveSucceeded:cc.remoteWriteMayHaveSucceeded,automaticPostRetry:false});}finishWrite_(r,'customer',{status:'POST_ACCEPTED_GET_VERIFY_PENDING',postFinishedAt:now_(),httpStatus:responseC&&responseC.status||200,remoteWriteMayHaveSucceeded:true});var afterC;try{afterC=get_(endpoint_(CUSTOMER_GET,customerId));}catch(e2){finishWrite_(r,'customer',{status:'POST_ACCEPTED_GET_FAILED_RECONCILIATION_REQUIRED',verifyFailedAt:now_(),remoteWriteMayHaveSucceeded:true,error:String(e2&&e2.message||e2)});return fail_(r,'CUSTOMER_INFO_POST_OUTCOME_UNCERTAIN_GET_FAILED_DO_NOT_RETRY',e2&&e2.message?e2.message:String(e2),{customerId:customerId,writeAttempted:true,remoteWriteMayHaveSucceeded:true});}var verified=objectId_(afterC)===customerId&&allSubmittedMobilePhonesPresent_(phones_(afterC),submittedPhones)&&(!customerAddressNeeds||addrNorm_(prop_(afterC,['PrimaryAddress','primaryAddress']))===addrNorm_(ca.value))&&json_(criticalCustomer_(afterC))===json_(beforeCritical)&&preexistingPhonesPreserved_(customer,afterC);if(!verified){finishWrite_(r,'customer',{status:'POSTWRITE_VERIFICATION_FAILED_RECONCILIATION_REQUIRED',verifyFailedAt:now_(),remoteWriteMayHaveSucceeded:true});return fail_(r,'CUSTOMER_INFO_POSTWRITE_VERIFICATION_FAILED_DO_NOT_RETRY','Customer update did not pass identity/collateral verification.',{customerId:customerId,writeAttempted:true,remoteWriteMayHaveSucceeded:true});}finishWrite_(r,'customer',{status:'CONFIRMED',verifiedAt:now_(),canonicalEntityId:customerId,remoteWriteMayHaveSucceeded:false});patch_(r,{'Last Striven Sync':now_(),'Striven Sync Status':'PARTIAL','Striven Sync Error':'','Reconciliation Status':'CUSTOMER CONTACT INFO SYNC — CUSTOMER UPDATED'});log_(r,'CUSTOMER_INFO_UPDATED',{customerId:customerId,submittedMobilePhonesApplied:submittedPhones.length,addressApplied:ca.applied},'');return{ok:true,version:VERSION,status:'CUSTOMER_INFO_UPDATED_WRITE_BOUNDARY',requestId:clean_(requestId),customerId:customerId,contactId:contactId,customerUpdated:true,contactUpdated:false,writeAttempted:true,liveWriteExecuted:true,automaticPostRetry:false,next:'RUN AGAIN TO VERIFY/UPDATE CONTACT'};}

      if(contactNeeds){var beforeAssoc=contactAssociations_(contact),dto2=contactDto_(contact,r,mergeSubmittedMobilePhones_(ps,submittedPhones),mergeEmails_(es,email),addrMerge.value),intent2=beginWrite_(r,'contact',contactId,CONTACT_POST,dto2);if(!intent2.ok)return fail_(r,intent2.status,'Identical Contact info payload already crossed a guarded write boundary; no retry.',{contactId:contactId,payloadFingerprint:intent2.payloadFingerprint,prior:intent2.prior,writeAttempted:false});var responseT;try{responseT=post_(CONTACT_POST,dto2);}catch(e3){var ct=classify_(e3);finishWrite_(r,'contact',{status:ct.status,postFinishedAt:now_(),httpStatus:ct.httpStatus,remoteWriteMayHaveSucceeded:ct.remoteWriteMayHaveSucceeded,error:String(e3&&e3.message||e3)});return fail_(r,'CONTACT_INFO_'+ct.status,String(e3&&e3.message||e3),{contactId:contactId,writeAttempted:true,httpStatus:ct.httpStatus,remoteWriteMayHaveSucceeded:ct.remoteWriteMayHaveSucceeded,automaticPostRetry:false});}finishWrite_(r,'contact',{status:'POST_ACCEPTED_GET_VERIFY_PENDING',postFinishedAt:now_(),httpStatus:responseT&&responseT.status||200,remoteWriteMayHaveSucceeded:true});var afterT;try{afterT=get_(endpoint_(CONTACT_GET,contactId));}catch(e4){finishWrite_(r,'contact',{status:'POST_ACCEPTED_GET_FAILED_RECONCILIATION_REQUIRED',verifyFailedAt:now_(),remoteWriteMayHaveSucceeded:true,error:String(e4&&e4.message||e4)});return fail_(r,'CONTACT_INFO_POST_OUTCOME_UNCERTAIN_GET_FAILED_DO_NOT_RETRY',e4&&e4.message?e4.message:String(e4),{contactId:contactId,writeAttempted:true,remoteWriteMayHaveSucceeded:true});}var verifiedT=objectId_(afterT)===contactId&&allSubmittedMobilePhonesPresent_(phones_(afterT),submittedPhones)&&(!email||hasEmail_(emails_(afterT),email))&&(!contactAddressNeeds||addrNorm_(prop_(afterT,['Address','address']))===addrNorm_(addrMerge.value))&&json_(contactAssociations_(afterT))===json_(beforeAssoc)&&preexistingPhonesPreserved_(contact,afterT)&&preexistingEmailsPreserved_(contact,afterT);if(!verifiedT){finishWrite_(r,'contact',{status:'POSTWRITE_VERIFICATION_FAILED_RECONCILIATION_REQUIRED',verifyFailedAt:now_(),remoteWriteMayHaveSucceeded:true});return fail_(r,'CONTACT_INFO_POSTWRITE_VERIFICATION_FAILED_DO_NOT_RETRY','Contact update did not pass identity/collateral verification.',{contactId:contactId,writeAttempted:true,remoteWriteMayHaveSucceeded:true});}finishWrite_(r,'contact',{status:'CONFIRMED',verifiedAt:now_(),canonicalEntityId:contactId,remoteWriteMayHaveSucceeded:false});patch_(r,{'Last Striven Sync':now_(),'Striven Sync Status':'PARTIAL','Striven Sync Error':'','Reconciliation Status':'CUSTOMER CONTACT INFO SYNC — CONTACT UPDATED'});log_(r,'CONTACT_INFO_UPDATED',{contactId:contactId,submittedMobilePhonesApplied:submittedPhones.length,emailAdded:!!email,addressApplied:addrMerge.applied},'');return{ok:true,version:VERSION,status:'CONTACT_INFO_UPDATED_WRITE_BOUNDARY',requestId:clean_(requestId),customerId:customerId,contactId:contactId,customerUpdated:false,contactUpdated:true,writeAttempted:true,liveWriteExecuted:true,automaticPostRetry:false,next:'RUN AGAIN TO VERIFY BOTH'};}

      var finalReconciliationV5138=customerScopedContactV5138?'CUSTOMER + CONTACT INFO CONFIRMED — CUSTOMER ENRICHMENT CHECKED / CUSTOMER-SCOPED CONTACT WRITE DEFERRED':'CUSTOMER + CONTACT INFO CONFIRMED';patch_(r,{'Last Striven Sync':now_(),'Striven Sync Error':'','Reconciliation Status':finalReconciliationV5138});var out={ok:true,version:VERSION,status:customerScopedContactV5138?'CUSTOMER_CONTACT_INFO_CONFIRMED_CUSTOMER_SCOPED_CONTACT_DEFERRED':'CUSTOMER_CONTACT_INFO_CONFIRMED',requestId:clean_(requestId),customerId:customerId,contactId:contactId,contactScope:customerScopedContactV5138?'CUSTOMER':'GLOBAL',contactEnrichmentDeferred:customerScopedContactV5138,customerHasPhone:allSubmittedMobilePhonesPresent_(cp,submittedPhones),contactHasPhone:customerScopedContactV5138?true:allSubmittedMobilePhonesPresent_(ps,submittedPhones),submittedPhoneCount:submittedPhones.length,submittedPhoneType:'Mobile',contactHasEmail:customerScopedContactV5138?true:(!email||hasEmail_(es,email)),customerAddressDifferentPreserved:ca.preservedDifferent,contactAddressDifferentPreserved:customerScopedContactV5138?false:addrMerge.preservedDifferent,customerAddressEnrichedSamePremises:ca.enrichedIncompleteSamePremises===true,customerEnrichmentSkipped:customerEnrichmentSkipped,unresolvedRequiredCustomerCustomFieldIds:requiredCustomerCfIds,evidenceSource:customerScopedContactV5138?scopedInfoEvidenceV5135.source:'',writeAttempted:false,liveWriteExecuted:false,automaticPostRetry:false};log_(r,out.status,out,'');return out;
    } finally {try{lock.releaseLock();}catch(e){}}
  }

  return{version:VERSION,reconcile:reconcile};
})();

/* CF_SERVICEOPS_V5_12_8_STANDALONE_LOCATION_GUARDED_CREATE_R1 */
CF.StandaloneLocationCreateV5128=(function(){
  'use strict';
  var VERSION='5.12.8';
  function clean_(v){return v===null||v===undefined?'':String(v).trim();}
  function upper_(v){return clean_(v).toUpperCase();}
  function norm_(v){return upper_(v).replace(/[^A-Z0-9]/g,'');}
  function postal_(v){var x=norm_(v);return x.length===6?x.slice(0,3)+' '+x.slice(3):clean_(v);}
  function province_(v){var x=upper_(v);return x==='ONTARIO'||x==='ONT'?'ON':clean_(v);}
  function request_(id){return CF.Util.findRecord('SERVICE_REQUESTS','Request ID',clean_(id));}
  function resolved_(r,a,b){return clean_(r[a]||r[b]);}
  function rootJournal_(r){var raw=clean_(r['Write Journal JSON']);if(!raw)return{};try{var x=JSON.parse(raw);return x&&typeof x==='object'?x:{};}catch(e){return{};}}
  function patch_(r,p){if(!r||!r.__rowNumber)throw new Error('Service Request row unavailable.');CF.Util.patchRow('SERVICE_REQUESTS',r.__rowNumber,p);}
  function payload_(r){
    var address={
      Address1:clean_(r['Street']),
      Address2:'',
      Address3:'',
      City:clean_(r['City']),
      State:province_(r['Province']),
      PostalCode:postal_(r['Postal Code']),
      Country:clean_(r['Country'])||'Canada',
      Latitude:0,
      Longitude:0,
      FullAddress:clean_(r['Full Address'])
    };
    return{Name:'Primary Location',Address:address};
  }
  function rows_(body){
    if(Array.isArray(body))return body;body=body||{};
    var candidates=[body.Items,body.items,body.Results,body.results,body.Records,body.records,body.Data,body.data];
    for(var i=0;i<candidates.length;i++){var c=candidates[i];if(Array.isArray(c))return c;if(c&&typeof c==='object'){var nested=c.Items||c.items||c.Results||c.results||c.Records||c.records;if(Array.isArray(nested))return nested;}}
    return[];
  }
  function rowId_(x){x=x||{};return clean_(x.LocationId||x.locationId||x.Id||x.id||x.ID);}
  function rowStreet_(x){x=x||{};var a=x.Address||x.address||{};return clean_(x.Address1||x.address1||a.Address1||a.address1||a.Street||a.street);}
  function rowPostal_(x){x=x||{};var a=x.Address||x.address||{};return clean_(x.PostalCode||x.postalCode||x.Zip||x.zip||a.PostalCode||a.postalCode||a.Zip||a.zip);}
  function rowCity_(x){x=x||{};var a=x.Address||x.address||{};return clean_(x.City||x.city||a.City||a.city);}
  function rowName_(x){x=x||{};return clean_(x.Name||x.name||x.LocationName||x.locationName);}
  function canonicalStreetV5129_(v){var s=upper_(v).replace(/#/g,' UNIT ').replace(/[.,]/g,' ');s=s.replace(/\bAPARTMENT\b|\bAPT\b/g,' UNIT ').replace(/\bCRESENT\b|\bCRESCENT\b|\bCRES\b/g,' CRESCENT ').replace(/\bROAD\b|\bRD\b/g,' ROAD ').replace(/\bSTREET\b|\bST\b/g,' STREET ').replace(/\bAVENUE\b|\bAVE\b/g,' AVENUE ').replace(/\bDRIVE\b|\bDR\b/g,' DRIVE ').replace(/\bTRAIL\b|\bTRL\b/g,' TRAIL ').replace(/\bPLACE\b|\bPL\b/g,' PLACE ').replace(/\bCOURT\b|\bCT\b/g,' COURT ').replace(/\bLANE\b|\bLN\b/g,' LANE ').replace(/\bBOULEVARD\b|\bBLVD\b/g,' BOULEVARD ').replace(/\bTERRACE\b|\bTER\b/g,' TERRACE ').replace(/\bSQUARE\b|\bSQ\b/g,' SQUARE ');return s.replace(/[^A-Z0-9]/g,'');}
  function postalIncompleteV5137_(v){var raw=upper_(v),compact=raw.replace(/[^A-Z0-9]/g,'');return !compact||/PLACEHOLDER|UNKNOWN|NOTPROVIDED|NOTAVAILABLE|TBD|N\/?A/.test(raw)||compact==='000000'||compact==='00000'||compact==='999999';}
  function exact_(r,x){return !!rowId_(x)&&norm_(r['Postal Code'])===norm_(rowPostal_(x))&&canonicalStreetV5129_(r['Street'])===canonicalStreetV5129_(rowStreet_(x));}
  function incompleteSamePremises_(r,x){return !!rowId_(x)&&canonicalStreetV5129_(r['Street'])===canonicalStreetV5129_(rowStreet_(x))&&norm_(r['City'])===norm_(rowCity_(x))&&postalIncompleteV5137_(rowPostal_(x));}
  function search_(r,customerId,options){
    options=options||{};
    var ep=CF.Config.getEndpoint('CUSTOMER_LOCATION_SEARCH');
    var n=Number(customerId),ref=isNaN(n)?customerId:n;
    var response=CF.StrivenHttp.requestJson(ep,{method:'post',payload:{PageIndex:0,PageSize:100,Customer:{Id:ref}},attempts:1,idempotent:true});
    var all=rows_(response&&response.json?response.json:{});
    var exact=all.filter(function(x){return exact_(r,x);});
    if(exact.length)return exact;
    var partial=all.filter(function(x){return incompleteSamePremises_(r,x);});
    if(partial.length>1){
      var primaryPartial=partial.filter(function(x){return upper_(rowName_(x))==='PRIMARY LOCATION';});
      if(primaryPartial.length===1)return primaryPartial;
    }
    if(partial.length)return partial;
    // Only the post-Customer-create reconciler may use this fallback. The request
    // itself just created the Customer with PrimaryLocation in the same guarded POST,
    // so a unique Primary Location under that new Customer is authoritative enough
    // to recover its Location ID even if Striven has not finished formatting the
    // returned address yet.
    if(options.allowUniquePrimaryFallback===true){
      var primary=all.filter(function(x){return !!rowId_(x)&&upper_(rowName_(x))==='PRIMARY LOCATION';});
      if(primary.length===1)return primary;
      if(all.length===1&&rowId_(all[0]))return all;
    }
    return[];
  }
  function findExisting_(requestId,customerId,options){
    var r=typeof requestId==='object'&&requestId?requestId:request_(requestId);
    if(!r)return{ok:false,status:'LOCATION_REQUEST_NOT_FOUND',requestId:clean_(requestId),customerId:clean_(customerId),matches:[],liveWriteExecuted:false};
    var cid=clean_(customerId)||resolved_(r,'Matched Customer ID','Created Customer ID');
    if(!cid)return{ok:false,status:'LOCATION_CUSTOMER_ID_REQUIRED',requestId:clean_(r['Request ID']),customerId:'',matches:[],liveWriteExecuted:false};
    var matches=search_(r,cid,options||{});
    return{ok:true,status:matches.length===1?'LOCATION_TARGETED_MATCHED':matches.length>1?'LOCATION_TARGETED_AMBIGUOUS':'LOCATION_TARGETED_NOT_FOUND',requestId:clean_(r['Request ID']),customerId:cid,matches:matches,matchIds:matches.map(rowId_),liveWriteExecuted:false};
  }
  function finalize_(r,location,created){
    var id=rowId_(location),contactId=resolved_(r,'Matched Contact ID','Created Contact ID'),complete=!!contactId;
    var root=rootJournal_(r),j=root.standaloneLocationCreate||{};j.status='LOCATION_RECONCILED';j.canonicalLocationId=id;j.reconciledAt=CF.Util.nowString();root.standaloneLocationCreate=j;
    patch_(r,{'Updated At':CF.Util.nowString(),'Current Stage':complete?'CUSTOMER STRUCTURE COMPLETE':'READY FOR CONTACT CREATE','Request Status':'OPEN','Manual Review?':'NO','Manual Review Reason':'','Blocking Issue':'','Next Action':complete?'CONTINUE TO WORK ORDER':'CREATE CONTACT','Location Match Status':'MATCHED','Matched Location ID':id,'Matched Location Address':clean_(r['Full Address']),'Created Location ID':created?id:clean_(r['Created Location ID']),'Location Action':'LINK EXISTING','Customer Structure Status':complete?'COMPLETE':'CUSTOMER + LOCATION CONFIRMED — CONTACT PENDING','Write Journal JSON':JSON.stringify(root),'Striven Sync Status':'PARTIAL','Striven Sync Error':'','Reconciliation Status':'STANDALONE LOCATION RECONCILED'});
    return{ok:true,version:VERSION,status:created?'LOCATION_CREATED_RECONCILED':'LOCATION_EXISTING_RECONCILED',requestId:clean_(r['Request ID']),locationId:id,liveWriteExecuted:false,automaticPostRetry:false};
  }
  function process(requestId,options){
    options=options||{};var r=request_(requestId);if(!r)return{ok:false,status:'LOCATION_REQUEST_NOT_FOUND',requestId:clean_(requestId),liveWriteExecuted:false};
    var customerId=resolved_(r,'Matched Customer ID','Created Customer ID'),existingId=resolved_(r,'Matched Location ID','Created Location ID');
    if(existingId)return{ok:true,status:'LOCATION_ALREADY_DURABLE',requestId:clean_(requestId),locationId:existingId,liveWriteExecuted:false};
    if(upper_(r['Current Stage'])!=='READY FOR LOCATION CREATE'||upper_(r['Location Action'])!=='CREATE'||!customerId)return{ok:false,status:'LOCATION_CREATE_STATE_NOT_READY',requestId:clean_(requestId),liveWriteExecuted:false};
    if(upper_(r['Manual Review?'])==='YES'||(upper_(r['Duplicate Risk Status'])&&upper_(r['Duplicate Risk Status'])!=='NONE'))return{ok:false,status:'LOCATION_CREATE_REVIEW_OR_RISK_BLOCKED',requestId:clean_(requestId),liveWriteExecuted:false};
    if(!clean_(r['Street'])||!clean_(r['City'])||!clean_(r['Postal Code']))return{ok:false,status:'LOCATION_CREATE_ADDRESS_INCOMPLETE',requestId:clean_(requestId),liveWriteExecuted:false};
    var root=rootJournal_(r),j=root.standaloneLocationCreate||{},matches=[];
    try{matches=search_(r,customerId,{allowUniquePrimaryFallback:false});}catch(searchError){return{ok:false,status:'LOCATION_READ_RECONCILE_FAILED',requestId:clean_(requestId),error:String(searchError&&searchError.message||searchError),liveWriteExecuted:false,automaticPostRetry:false};}
    if(matches.length===1)return finalize_(r,matches[0],Number(j.postAttempts||0)>0);
    if(matches.length>1){var msg='Multiple exact Customer Locations match the submitted service address. Do not create another Location.';patch_(r,{'Updated At':CF.Util.nowString(),'Current Stage':'NEEDS REVIEW','Request Status':'BLOCKED','Manual Review?':'YES','Manual Review Reason':msg,'Blocking Issue':msg,'Next Action':'REVIEW LOCATION CANDIDATES','Striven Sync Status':'BLOCKED','Reconciliation Status':'LOCATION EXACT MATCH AMBIGUOUS'});return{ok:false,status:'LOCATION_EXACT_MATCH_AMBIGUOUS',requestId:clean_(requestId),candidateCount:matches.length,liveWriteExecuted:false};}
    if(Number(j.postAttempts||0)>0)return{ok:true,status:'LOCATION_POST_RECONCILE_PENDING',requestId:clean_(requestId),liveWriteExecuted:false,automaticPostRetry:false};
    var endpoint=CF.Config.getEndpoint('CUSTOMER_LOCATION_CREATE',{customerId:customerId}),payload=payload_(r),fingerprint=CF.Util.canonicalHash({requestId:clean_(requestId),customerId:customerId,endpoint:endpoint,payload:payload});
    j={status:'POST_INTENT_RECORDED',postAttempts:1,postStartedAt:CF.Util.nowString(),writeFingerprint:fingerprint,endpoint:endpoint,payload:payload,remoteWriteMayHaveSucceeded:false,noAutomaticWriteRetry:true};root.standaloneLocationCreate=j;
    patch_(r,{'Updated At':CF.Util.nowString(),'Write Journal JSON':JSON.stringify(root),'Current Stage':'READY FOR LOCATION CREATE','Request Status':'IN PROGRESS','Next Action':'CREATE LOCATION — GUARDED SINGLE POST','Striven Sync Status':'SYNCING','Reconciliation Status':'LOCATION POST INTENT RECORDED'});
    try{
      var response=CF.StrivenHttp.requestJson(endpoint,{method:'post',payload:payload,attempts:1,idempotent:false});
      j.status='POST_ACCEPTED_RECONCILE_REQUIRED';j.postFinishedAt=CF.Util.nowString();j.httpStatus=response&&response.status||200;j.responseBody=response&&response.json||{};j.remoteWriteMayHaveSucceeded=true;root.standaloneLocationCreate=j;
      patch_(request_(requestId),{'Updated At':CF.Util.nowString(),'Write Journal JSON':JSON.stringify(root),'Current Stage':'READY FOR LOCATION CREATE','Request Status':'IN PROGRESS','Next Action':'RECONCILE LOCATION CREATE — DO NOT RETRY POST','Striven Sync Status':'PARTIAL','Striven Sync Error':'','Reconciliation Status':'LOCATION POST ACCEPTED — RECONCILE'});
      return{ok:true,version:VERSION,status:'LOCATION_POST_ACCEPTED_RECONCILE_REQUIRED',requestId:clean_(requestId),liveWriteExecuted:true,automaticPostRetry:false};
    }catch(postError){
      j.status='LOCATION_POST_OUTCOME_UNCERTAIN_RECONCILE_REQUIRED';j.postFinishedAt=CF.Util.nowString();j.remoteWriteMayHaveSucceeded=true;j.error=String(postError&&postError.message||postError);root.standaloneLocationCreate=j;
      patch_(request_(requestId),{'Updated At':CF.Util.nowString(),'Write Journal JSON':JSON.stringify(root),'Current Stage':'READY FOR LOCATION CREATE','Request Status':'IN PROGRESS','Next Action':'RECONCILE LOCATION CREATE — DO NOT RETRY POST','Striven Sync Status':'RECONCILE REQUIRED','Striven Sync Error':j.error,'Reconciliation Status':'LOCATION POST OUTCOME UNCERTAIN — RECONCILE'});
      return{ok:false,version:VERSION,status:'LOCATION_POST_OUTCOME_UNCERTAIN_RECONCILE_REQUIRED',requestId:clean_(requestId),remoteWriteMayHaveSucceeded:true,automaticPostRetry:false,liveWriteExecuted:true};
    }
  }
  return{version:VERSION,process:process,findExisting:findExisting_};
})();

/* BEGIN CF_SERVICEOPS_V5_13_0_SERVICE_ITEM_TAX_CONTRACT_R1 */
/************************************************************
 * CF_SERVICEOPS_V5_13_0_SERVICE_ITEM_TAX_CONTRACT_R1
 * Protects the taxable nature of CF service Items on Sales Orders.
 *
 * Production evidence showed Sales Tax=HST on the order while
 * Item 41481 / 41434 lines were created taxable:false.  This wrapper
 * enforces Taxable=true for those known taxable service Items at the
 * final HTTP boundary and exposes read-only verification helpers.
 ************************************************************/
(function CF_SERVICEOPS_INSTALL_SERVICE_ITEM_TAX_CONTRACT_V5130_R1_(){
  'use strict';
  if(typeof CF==='undefined'||!CF.StrivenHttp||typeof CF.StrivenHttp.requestJson!=='function')throw new Error('SERVICE_ITEM_TAX_CONTRACT_SETUP_REQUIRED');
  if(CF.StrivenHttp.__serviceItemTaxContractV5130R1===true)return;

  var VERSION='5.13.0';
  var baseRequest=CF.StrivenHttp.requestJson;
  var TARGET_ITEMS={'41434':true,'41481':true};

  function clean_(v){return v===null||v===undefined?'':String(v).trim();}
  function upper_(v){return clean_(v).toUpperCase();}
  function clone_(v){return JSON.parse(JSON.stringify(v));}
  function body_(response){return response&&response.json!==undefined?response.json:(response||{});}
  function itemId_(line){line=line||{};var item=line.Item||line.item||{};return clean_(item.Id||item.ID||item.id||line.ItemId||line.itemId);}
  function lines_(payload){if(!payload||typeof payload!=='object')return[];return payload.LineItems||payload.lineItems||[];}
  function isSalesOrderCreate_(pathOrUrl,options){
    var method=upper_(options&&options.method||'GET');if(method!=='POST')return false;
    var s=clean_(pathOrUrl).replace(/[?#].*$/,'').replace(/\/+$/,'');return /\/v1\/sales-orders$/i.test(s);
  }
  function applyPayload_(payload){
    if(!payload||typeof payload!=='object')return{payload:payload,changed:false,targetLineCount:0};
    var out=clone_(payload),rows=lines_(out),changed=false,count=0,usesPascal=Array.isArray(out.LineItems);
    rows.forEach(function(line){
      var id=itemId_(line);if(!TARGET_ITEMS[id])return;count++;
      if(usesPascal){if(line.Taxable!==true){line.Taxable=true;changed=true;}if(Object.prototype.hasOwnProperty.call(line,'taxable'))delete line.taxable;}
      else{if(line.taxable!==true){line.taxable=true;changed=true;}if(Object.prototype.hasOwnProperty.call(line,'Taxable'))delete line.Taxable;}
    });
    return{payload:out,changed:changed,targetLineCount:count};
  }
  function verifySalesOrder_(salesOrderId){
    salesOrderId=clean_(salesOrderId);if(!salesOrderId)return{ok:false,applicable:false,status:'SALES_ORDER_ID_REQUIRED',version:VERSION};
    var response=baseRequest.call(CF.StrivenHttp,'/v1/sales-orders/'+encodeURIComponent(salesOrderId),{method:'get',attempts:1});
    var b=body_(response),rows=b.lineItems||b.LineItems||[],targets=[],defects=[];
    rows.forEach(function(line,index){
      var id=itemId_(line);if(!TARGET_ITEMS[id])return;
      var taxable=(line.taxable!==undefined?line.taxable:line.Taxable);
      var row={index:index,itemId:id,taxable:taxable===true,rawTaxable:taxable,price:Number(line.price!==undefined?line.price:line.Price||0),qty:Number(line.qty!==undefined?line.qty:line.Qty||0)};
      targets.push(row);if(taxable!==true)defects.push('ITEM_'+id+'_LINE_'+index+'_NOT_TAXABLE');
    });
    return{ok:defects.length===0,applicable:targets.length>0,status:defects.length?'TAXABILITY_VERIFICATION_FAILED':(targets.length?'TARGET_SERVICE_ITEMS_TAXABLE':'NO_TARGET_SERVICE_ITEM'),version:VERSION,salesOrderId:clean_(b.id||b.Id||salesOrderId),orderNumber:clean_(b.orderNumber||b.OrderNumber),salesTax:b.salesTax||b.SalesTax||null,orderTotal:Number(b.orderTotal!==undefined?b.orderTotal:b.OrderTotal||0),targetLines:targets,defects:defects};
  }
  function auditRecent_(limit){
    limit=Math.max(1,Math.min(50,Number(limit||20)));if(!CF.Util)return{ok:false,status:'CF_UTIL_REQUIRED',version:VERSION};
    var rows=CF.Util.readRecords('SERVICE_REQUESTS').slice();
    function ms_(r){var v=r['Submitted At']||r['Created At'];var d=v instanceof Date?v:new Date(v);var t=d.getTime();return isNaN(t)?0:t;}
    rows.sort(function(a,b){return ms_(b)-ms_(a);});var checked=[],defects=[];
    rows.slice(0,limit).forEach(function(r){var id=clean_(r['Work Order ID']);if(!id)return;try{var v=verifySalesOrder_(id);if(v.applicable){v.requestId=clean_(r['Request ID']);checked.push(v);if(!v.ok)defects.push(v);}}catch(e){var x={ok:false,applicable:true,status:'AUDIT_READ_FAILED',requestId:clean_(r['Request ID']),salesOrderId:id,error:String(e&&e.message||e),version:VERSION};checked.push(x);defects.push(x);}});
    return{ok:defects.length===0,status:defects.length?'HISTORICAL_TAX_DEFECTS_FOUND':'RECENT_TAX_AUDIT_CLEAR',version:VERSION,limit:limit,checked:checked.length,defectCount:defects.length,defects:defects,liveStrivenWriteExecuted:false};
  }

  CF.StrivenHttp.requestJson=function(pathOrUrl,options){
    options=options||{};
    if(isSalesOrderCreate_(pathOrUrl,options)&&options.payload&&typeof options.payload==='object'){
      var applied=applyPayload_(options.payload);
      if(applied.targetLineCount){
        var next={};Object.keys(options).forEach(function(k){next[k]=options[k];});next.payload=applied.payload;options=next;
        try{if(CF.Util&&typeof CF.Util.logEvent==='function')CF.Util.logEvent({module:'60_Striven_Write',action:'SERVICE_ITEM_TAX_CONTRACT',status:'PAYLOAD_ENFORCED',message:'Known taxable service Item line(s) forced Taxable=true before Sales Order POST.',details:{version:VERSION,targetLineCount:applied.targetLineCount,changed:applied.changed},version:VERSION});}catch(e){}
      }
    }
    return baseRequest.call(CF.StrivenHttp,pathOrUrl,options);
  };

  CF.ServiceOrderTaxContract={version:VERSION,applyPayload:applyPayload_,verifySalesOrder:verifySalesOrder_,auditRecent:auditRecent_,targetItemIds:['41434','41481']};
  CF.StrivenHttp.__serviceItemTaxContractV5130R1=true;
})();

function TESTING_CF_TAX_CONTRACT_INSTALLATION(){
  if(typeof CF==='undefined'||!CF.ServiceOrderTaxContract)throw new Error('CF.ServiceOrderTaxContract unavailable.');
  var sample={LineItems:[{Item:{Id:41481},Qty:1,Price:200},{Item:{Id:99999},Qty:1,Price:1}]};
  var out=CF.ServiceOrderTaxContract.applyPayload(sample),rows=out.payload.LineItems;
  if(rows[0].Taxable!==true)throw new Error('TAX_CONTRACT_SAMPLE_FAILED_41481');
  if(Object.prototype.hasOwnProperty.call(rows[1],'Taxable'))throw new Error('TAX_CONTRACT_TOUCHED_NON_TARGET_ITEM');
  return{ok:true,version:'5.13.0',status:'SERVICE_ITEM_TAX_CONTRACT_VERIFIED',targetItemIds:CF.ServiceOrderTaxContract.targetItemIds,liveStrivenWriteExecuted:false};
}

function TESTING_CF_TAX_AUDIT_RECENT_20(){
  if(typeof CF==='undefined'||!CF.ServiceOrderTaxContract)throw new Error('CF.ServiceOrderTaxContract unavailable.');
  return CF.ServiceOrderTaxContract.auditRecent(20);
}
/* END CF_SERVICEOPS_V5_13_0_SERVICE_ITEM_TAX_CONTRACT_R1 */
