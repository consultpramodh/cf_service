/************************************************************
 * CF ServiceOps — V2 Shadow Resolver Foundation
 * Version: 0.1.0-shadow
 * Date: 2026-09-17
 *
 * PURPOSE
 * - Read-only canonical business-fact resolver for Service Requests.
 * - Resolves durable Customer / Contact / Location / Sales Order facts.
 * - Verifies Customer + Contact phone/email requirements without mutation.
 * - Uses direct Striven GET for known Customer / Contact IDs.
 * - Treats cache / worksheet state as evidence, not canonical remote truth.
 * - Produces one nextRequiredFact from current verified facts.
 *
 * SAFETY CONTRACT
 * - NO Striven POST / PUT / PATCH / DELETE.
 * - NO Service Request row mutation.
 * - NO Sales Order mutation.
 * - NO Contact association mutation.
 * - Direct GET only through CF.StrivenHttp.requestJson.
 ************************************************************/
var CF = CF || {};

CF.V2ShadowResolver = (function () {
  'use strict';

  var VERSION = '0.1.1-shadow';
  var MODULE_NAME = 'CF.V2ShadowResolver';

  function deps_() {
    if (!CF.Util || !CF.StrivenHttp) {
      throw new Error('CF.Util and CF.StrivenHttp are required.');
    }
    return { util: CF.Util, http: CF.StrivenHttp };
  }

  function clean_(v) {
    return v === null || v === undefined ? '' : String(v).trim();
  }

  function upper_(v) {
    return clean_(v).toUpperCase();
  }

  function arr_(v) {
    return Array.isArray(v) ? v : [];
  }

  function prop_(o, names) {
    o = o || {};
    for (var i = 0; i < names.length; i++) {
      if (Object.prototype.hasOwnProperty.call(o, names[i])) return o[names[i]];
    }
    return undefined;
  }

  function normPhone_(v) {
    var x = String(v || '').replace(/\D/g, '');
    if (x.length === 11 && x.charAt(0) === '1') x = x.slice(1);
    return x;
  }

  function normEmail_(v) {
    return String(v || '').trim().toLowerCase();
  }

  function normalizeIds_(values) {
    var seen = {};
    return (values || []).map(clean_).filter(function (v) {
      if (!v || seen[v]) return false;
      seen[v] = true;
      return true;
    });
  }

  function request_(requestIdOrRow) {
    var u = deps_().util;
    if (requestIdOrRow && typeof requestIdOrRow === 'object' && requestIdOrRow['Request ID']) {
      return requestIdOrRow;
    }
    if (typeof requestIdOrRow === 'number') {
      var rows = typeof u.readRecords === 'function'
        ? u.readRecords('SERVICE_REQUESTS')
        : u.readObjects('SERVICE_REQUESTS');
      for (var i = 0; i < rows.length; i++) {
        if (Number(rows[i].__rowNumber) === Number(requestIdOrRow)) return rows[i];
      }
      return null;
    }
    return u.findRecord('SERVICE_REQUESTS', 'Request ID', clean_(requestIdOrRow));
  }

  function canonicalId_(record, matchedField, createdField, label) {
    var matched = clean_(record[matchedField]);
    var created = clean_(record[createdField]);
    if (matched && created && matched !== created) {
      return {
        ok: false,
        id: '',
        status: 'ID_CONFLICT',
        label: label,
        matchedId: matched,
        createdId: created
      };
    }
    return {
      ok: true,
      id: matched || created,
      status: matched || created ? 'DURABLE_ID_PRESENT' : 'MISSING',
      label: label,
      matchedId: matched,
      createdId: created
    };
  }

  function responseBody_(response) {
    if (!response) return {};
    if (response.json && typeof response.json === 'object') return response.json;
    if (response.data && typeof response.data === 'object') return response.data;
    return typeof response === 'object' ? response : {};
  }

  function getEntity_(type, id) {
    id = clean_(id);
    if (!id) return { ok: false, status: 'NO_ID', body: null };
    var path = type === 'CUSTOMER'
      ? '/v1/customers/' + encodeURIComponent(id)
      : '/v1/contacts/' + encodeURIComponent(id);
    try {
      var response = deps_().http.requestJson(path, {
        method: 'get',
        attempts: 1,
        idempotent: true
      });
      var body = responseBody_(response);
      var actualId = clean_(prop_(body, ['Id', 'id', 'ID', type === 'CUSTOMER' ? 'CustomerId' : 'ContactId']));
      return {
        ok: actualId === id,
        status: actualId === id ? 'GET_CONFIRMED' : 'GET_ID_MISMATCH',
        expectedId: id,
        actualId: actualId,
        body: body
      };
    } catch (e) {
      return {
        ok: false,
        status: 'GET_FAILED',
        expectedId: id,
        error: String(e && e.message || e),
        body: null
      };
    }
  }

  function phoneValues_(entity) {
    return normalizeIds_(arr_(prop_(entity, ['Phones', 'phones'])).map(function (p) {
      return normPhone_(prop_(p || {}, ['Number', 'number']));
    }));
  }

  function emailValues_(entity) {
    var out = [];
    arr_(prop_(entity, ['Emails', 'emails'])).forEach(function (e) {
      var value = normEmail_(prop_(e || {}, ['Email', 'email', 'EmailAddress', 'emailAddress']));
      if (value) out.push(value);
    });
    var scalar = normEmail_(prop_(entity, ['Email', 'email', 'EmailAddress', 'emailAddress', 'PrimaryEmail', 'primaryEmail']));
    if (scalar) out.push(scalar);
    return normalizeIds_(out);
  }

  function customerEmailShape_(entity) {
    if (!entity || typeof entity !== 'object') return 'UNAVAILABLE';
    if (Object.prototype.hasOwnProperty.call(entity, 'Emails') ||
        Object.prototype.hasOwnProperty.call(entity, 'emails')) return 'EMAILS_ARRAY';
    if (['Email', 'email', 'EmailAddress', 'emailAddress', 'PrimaryEmail', 'primaryEmail'].some(function (k) {
      return Object.prototype.hasOwnProperty.call(entity, k);
    })) return 'SCALAR_EMAIL';
    return 'NOT_EXPOSED_BY_GET';
  }

  function desiredCustomerPhones_(record) {
    return normalizeIds_([
      normPhone_(record['Normalized Phone'] || record['Phone'])
    ]);
  }

  function desiredContactPhones_(record) {
    return normalizeIds_([
      normPhone_(record['Normalized Phone'] || record['Phone']),
      normPhone_(record['Normalized Alt Phone'] || record['Alt Phone'])
    ]);
  }

  function desiredEmail_(record) {
    return normEmail_(record['Normalized Email'] || record['Email']);
  }

  function channelFact_(wanted, actualValues, unresolvedWhenUnobservable) {
    if (!wanted || !wanted.length) {
      return { status: 'NOT_PROVIDED', confirmed: true, wanted: wanted, actual: actualValues || [] };
    }
    if (unresolvedWhenUnobservable) {
      return { status: 'API_FIELD_UNRESOLVED', confirmed: false, wanted: wanted, actual: actualValues || [] };
    }
    var actual = actualValues || [];
    var missing = wanted.filter(function (v) { return actual.indexOf(v) === -1; });
    return {
      status: missing.length ? 'MISSING' : 'CONFIRMED',
      confirmed: missing.length === 0,
      wanted: wanted,
      actual: actual,
      missing: missing
    };
  }

  function identityFact_(record, remote, type) {
    if (!remote) return { status: 'UNAVAILABLE', confirmed: false };
    var reqFirst = upper_(record['First Name']);
    var reqLast = upper_(record['Last Name']);
    var reqFull = upper_(record['Full Name']);
    var gotFirst = upper_(prop_(remote, ['FirstName', 'firstName']));
    var gotLast = upper_(prop_(remote, ['LastName', 'lastName']));
    var gotName = upper_(prop_(remote, type === 'CUSTOMER' ? ['Name', 'name', 'CustomerName', 'customerName'] : ['FullName', 'fullName', 'Name', 'name']));
    var nameConflict = false;
    if (reqFirst && gotFirst && reqFirst !== gotFirst) nameConflict = true;
    if (reqLast && gotLast && reqLast !== gotLast) nameConflict = true;
    if (!gotFirst && !gotLast && reqFull && gotName && reqFull !== gotName) nameConflict = true;
    return {
      status: nameConflict ? 'CONFLICT' : 'CONFIRMED',
      confirmed: !nameConflict,
      requestedName: clean_(record['Full Name']),
      remoteName: clean_(prop_(remote, type === 'CUSTOMER' ? ['Name', 'name', 'CustomerName', 'customerName'] : ['FullName', 'fullName', 'Name', 'name'])),
      remoteFirstName: clean_(prop_(remote, ['FirstName', 'firstName'])),
      remoteLastName: clean_(prop_(remote, ['LastName', 'lastName']))
    };
  }

  function contactCustomerIds_(contact) {
    if (!contact || typeof contact !== 'object') return { observable: false, ids: [] };
    var out = [];
    function add_(v) { v = clean_(v); if (v) out.push(v); }
    add_(prop_(contact, ['CustomerId', 'customerId', 'CustomerID']));
    var direct = prop_(contact, ['Customer', 'customer']);
    if (direct && typeof direct === 'object') add_(prop_(direct, ['Id', 'id', 'CustomerId', 'customerId']));
    var keys = ['CustomerAssociations', 'customerAssociations', 'Customers', 'customers'];
    var observable = keys.some(function (k) { return Object.prototype.hasOwnProperty.call(contact, k); }) || !!direct || !!prop_(contact, ['CustomerId', 'customerId', 'CustomerID']);
    keys.forEach(function (k) {
      arr_(contact[k]).forEach(function (x) {
        add_(prop_(x || {}, ['CustomerId', 'customerId', 'CustomerID', 'Id', 'id']));
      });
    });
    return { observable: observable, ids: normalizeIds_(out) };
  }

  function relationshipFact_(customerId, contact) {
    if (!customerId) return { status: 'CUSTOMER_ID_MISSING', confirmed: false, customerIds: [] };
    if (!contact) return { status: 'CONTACT_REMOTE_UNAVAILABLE', confirmed: false, customerIds: [] };
    var owners = contactCustomerIds_(contact);
    if (!owners.observable) return { status: 'API_FIELD_UNRESOLVED', confirmed: false, customerIds: [] };
    if (owners.ids.indexOf(customerId) !== -1) {
      return { status: 'CONFIRMED', confirmed: true, customerIds: owners.ids };
    }
    if (owners.ids.length) {
      return { status: 'CONFLICT', confirmed: false, customerIds: owners.ids };
    }
    return { status: 'MISSING', confirmed: false, customerIds: [] };
  }

  function locationFact_(record, locationIdState) {
    if (!locationIdState.ok) {
      return { status: 'ID_CONFLICT', confirmed: false, id: '', evidence: locationIdState };
    }
    if (!locationIdState.id) {
      return { status: 'MISSING', confirmed: false, id: '' };
    }
    var matchedStatus = upper_(record['Location Match Status']);
    var structure = upper_(record['Customer Structure Status']);
    var evidence = upper_(record['Reconciliation Status']);
    var confirmed = matchedStatus === 'MATCHED' || structure.indexOf('LOCATION') !== -1 || structure === 'COMPLETE' || evidence.indexOf('LOCATION') !== -1 || !!clean_(record['Matched Location ID']);
    return {
      status: confirmed ? 'CONFIRMED_FROM_DURABLE_REQUEST_STATE' : 'DURABLE_ID_PRESENT_UNVERIFIED',
      confirmed: confirmed,
      id: locationIdState.id
    };
  }

  function salesOrderFact_(record) {
    var id = clean_(record['Work Order ID']);
    var number = clean_(record['Work Order Number']);
    var reconciliation = upper_(record['Reconciliation Status']);
    var stage = upper_(record['Current Stage']);
    var status = upper_(record['Work Order Status']);
    if (!id && !number) return { status: 'MISSING', confirmed: false, id: '', number: '' };
    var verified = reconciliation.indexOf('SALES ORDER') !== -1 &&
      (reconciliation.indexOf('VERIFIED') !== -1 || reconciliation.indexOf('RECONCILED') !== -1);
    if (!verified && stage.indexOf('SALES ORDER CREATED') !== -1 && status) verified = true;
    return {
      status: verified ? 'CONFIRMED_FROM_REQUEST_EVIDENCE' : 'PRESENT_UNVERIFIED',
      confirmed: verified,
      id: id,
      number: number,
      statusName: clean_(record['Work Order Status'])
    };
  }

  function nextRequiredFact_(facts) {
    var ordered = [
      ['CUSTOMER_CONFIRMED', facts.customer.identity.confirmed && facts.customer.remoteConfirmed],
      ['CUSTOMER_PHONE_CONFIRMED', facts.customer.phone.confirmed],
      ['LOCATION_CONFIRMED', facts.location.confirmed],
      ['CONTACT_CONFIRMED', facts.contact.identity.confirmed && facts.contact.remoteConfirmed],
      ['CONTACT_PHONE_CONFIRMED', facts.contact.phone.confirmed],
      ['CONTACT_EMAIL_CONFIRMED', facts.contact.email.confirmed],
      ['RELATIONSHIP_CONFIRMED', facts.relationship.confirmed],
      ['SALES_ORDER_CONFIRMED', facts.salesOrder.confirmed]
    ];
    for (var i = 0; i < ordered.length; i++) {
      if (!ordered[i][1]) return ordered[i][0];
    }
    return 'COMPLETE';
  }

  function inspectRequest(requestIdOrRow, options) {
    options = options || {};
    var record = request_(requestIdOrRow);
    if (!record) {
      return { ok: false, version: VERSION, status: 'SERVICE_REQUEST_NOT_FOUND', liveWriteExecuted: false };
    }

    var customerIdState = canonicalId_(record, 'Matched Customer ID', 'Created Customer ID', 'CUSTOMER');
    var contactIdState = canonicalId_(record, 'Matched Contact ID', 'Created Contact ID', 'CONTACT');
    var locationIdState = canonicalId_(record, 'Matched Location ID', 'Created Location ID', 'LOCATION');

    var customerGet = customerIdState.ok && customerIdState.id ? getEntity_('CUSTOMER', customerIdState.id) : { ok: false, status: customerIdState.status, body: null };
    var contactGet = contactIdState.ok && contactIdState.id ? getEntity_('CONTACT', contactIdState.id) : { ok: false, status: contactIdState.status, body: null };

    var wantedCustomerPhones = desiredCustomerPhones_(record);
    var wantedContactPhones = desiredContactPhones_(record);
    var wantedEmail = desiredEmail_(record);
    var customerEmails = customerGet.body ? emailValues_(customerGet.body) : [];
    var customerEmailShape = customerGet.body ? customerEmailShape_(customerGet.body) : 'UNAVAILABLE';

    var facts = {
      requestId: clean_(record['Request ID']),
      customer: {
        id: customerIdState.id,
        idState: customerIdState,
        remoteConfirmed: customerGet.ok,
        remoteReadStatus: customerGet.status,
        identity: customerGet.ok ? identityFact_(record, customerGet.body, 'CUSTOMER') : { status: customerGet.status, confirmed: false },
        phone: customerGet.ok ? channelFact_(wantedCustomerPhones, phoneValues_(customerGet.body), false) : { status: customerGet.status, confirmed: false, wanted: wantedCustomerPhones, actual: [] },
        email: customerGet.ok ? channelFact_([wantedEmail].filter(Boolean), customerEmails, customerEmailShape === 'NOT_EXPOSED_BY_GET') : { status: customerGet.status, confirmed: false, wanted: [wantedEmail].filter(Boolean), actual: [] },
        emailApiShape: customerEmailShape
      },
      contact: {
        id: contactIdState.id,
        idState: contactIdState,
        remoteConfirmed: contactGet.ok,
        remoteReadStatus: contactGet.status,
        identity: contactGet.ok ? identityFact_(record, contactGet.body, 'CONTACT') : { status: contactGet.status, confirmed: false },
        phone: contactGet.ok ? channelFact_(wantedContactPhones, phoneValues_(contactGet.body), false) : { status: contactGet.status, confirmed: false, wanted: wantedContactPhones, actual: [] },
        email: contactGet.ok ? channelFact_([wantedEmail].filter(Boolean), emailValues_(contactGet.body), false) : { status: contactGet.status, confirmed: false, wanted: [wantedEmail].filter(Boolean), actual: [] }
      },
      location: locationFact_(record, locationIdState),
      relationship: relationshipFact_(customerIdState.id, contactGet.ok ? contactGet.body : null),
      salesOrder: salesOrderFact_(record)
    };

    var next = nextRequiredFact_(facts);
    var out = {
      ok: true,
      version: VERSION,
      module: MODULE_NAME,
      mode: 'READ_ONLY_SHADOW',
      requestId: facts.requestId,
      facts: facts,
      nextRequiredFact: next,
      complete: next === 'COMPLETE',
      safety: {
        strivenMutationExecuted: false,
        serviceRequestMutationExecuted: false,
        salesOrderMutationExecuted: false,
        contactAssociationMutationExecuted: false
      },
      liveWriteExecuted: false
    };

    if (options.includeRemoteBodies === true) {
      out.remote = { customer: customerGet.body, contact: contactGet.body };
    }
    return out;
  }

  function inspectRegressionSet(requestIds) {
    var ids = requestIds || [
      'SR-20260914115146-4379',
      'SR-20260916091328-7075',
      'SR-20260915113954-1418',
      'SR-20260917102650-2098',
      'SR-20260916162619-7013',
      'SR-20260916120406-8654',
      'SR-20260916103156-1138',
      'SR-20260915185727-2152',
      'SR-20260908093552-3155'
    ];
    return ids.map(function (id) {
      var result = inspectRequest(id, {});
      return {
        requestId: id,
        ok: result.ok,
        nextRequiredFact: result.nextRequiredFact || '',
        complete: result.complete === true,
        customerId: result.facts && result.facts.customer && result.facts.customer.id || '',
        contactId: result.facts && result.facts.contact && result.facts.contact.id || '',
        locationId: result.facts && result.facts.location && result.facts.location.id || '',
        salesOrderId: result.facts && result.facts.salesOrder && result.facts.salesOrder.id || '',
        customerPhone: result.facts && result.facts.customer && result.facts.customer.phone.status || '',
        customerEmail: result.facts && result.facts.customer && result.facts.customer.email.status || '',
        contactPhone: result.facts && result.facts.contact && result.facts.contact.phone.status || '',
        contactEmail: result.facts && result.facts.contact && result.facts.contact.email.status || '',
        relationship: result.facts && result.facts.relationship && result.facts.relationship.status || '',
        liveWriteExecuted: false
      };
    });
  }

  return {
    moduleName: MODULE_NAME,
    version: VERSION,
    inspectRequest: inspectRequest,
    inspectRegressionSet: inspectRegressionSet
  };
})();
