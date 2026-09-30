/* CF_SERVICEOPS_V5_13_7_PARTIAL_LOCATION_IDENTITY_R1 */
/************************************************************
 * APPS SCRIPT — 40_Matching_Profile.gs
 * CF ServiceOps — Automatic Customer / Contact / Location Resolution
 * Version: 5.7.1
 *
 * PURPOSE
 * - Matches Service Requests against Striven customer/contact/location caches.
 * - Customer identity prioritizes exact email/phone over household address.
 * - Exact names are secondary disambiguation evidence among existing candidates only.
 * - Treats a confident, unique match as an AUTOMATIC SYSTEM LINK.
 * - No operator click is required to link an existing Customer, Contact, or Location.
 * - Bridges Contact phone/email matches back to the owning Customer.
 * - Normalizes raw request values at runtime.
 * - Canonicalizes common address abbreviations before Location comparison.
 * - Never emits POSSIBLE MATCH; a Location is MATCHED, AMBIGUOUS, or NOT FOUND.
 * - Persists explicit operator candidate selections and continues matching downstream.
 * - Self-heals legacy/malformed Service Request linkage where safely possible.
 * - Sends only uncertain/conflicting matches, location questions, or duplicate-risk
 *   conditions to Operator Review.
 * - Creation remains a separate controlled step; this module performs no live
 *   Striven mutations.
 ************************************************************/
var CF = CF || {};

CF.Matching = (function () {
  'use strict';

  var MODULE_NAME = '40_Matching_Profile';
  var VERSION = '5.10.5';

  function deps_() {
    if (!CF.Config || !CF.Util || !CF.StrivenData) {
      throw new Error('CF.Config, CF.Util and CF.StrivenData are required.');
    }
    return { config: CF.Config, util: CF.Util, data: CF.StrivenData };
  }

  function clean_(value) {
    return deps_().util.cleanText(value);
  }

  function upper_(value) {
    return clean_(value).toUpperCase();
  }

  function cloneRecord_(row) {
    var out = {};
    Object.keys(row || {}).forEach(function (key) { out[key] = row[key]; });
    return out;
  }

  function uniqueById_(rows, idHeader) {
    var map = {};
    (rows || []).forEach(function (row) {
      var id = String(row[idHeader] || '');
      if (id) map[id] = row;
    });
    return Object.keys(map).map(function (id) { return map[id]; });
  }

  /************************************************************
   * RUNTIME REQUEST NORMALIZATION
   ************************************************************/

  function postalFromAddress_(value) {
    var match = String(value || '').toUpperCase().match(/\b([A-Z]\d[A-Z])\s?(\d[A-Z]\d)\b/);
    return match ? match[1] + ' ' + match[2] : '';
  }

  function canonicalAddress_(value) {
    var text = upper_(value);
    if (!text) return '';

    // CF_SERVICEOPS_V5_10_1_MATCHING_TIERS_R1
    // Unit designators are identity-bearing: preserve the unit number while
    // making Suite / Apt / # / Unit equivalent.
    text = text.replace(/#/g, ' UNIT ');
    text = text.replace(/\b(APARTMENT|APT|SUITE|STE|UNIT)\s*[-:#]?\s*([A-Z0-9-]+)/g, ' UNIT $2 ');
    text = text.replace(/\bPENTHOUSE\b/g, ' PH ');

    // Canonicalize Canadian country suffixes without changing a street/body
    // occurrence of CA. This fixes request "..., Ca" versus cache "..., Canada".
    text = text.replace(/\b(CANADA|CAN|CA)\b\s*$/g, ' CANADA ');

    var replacements = [
      [/\bSTREET\b/g, ' ST '],
      [/\bAVENUE\b/g, ' AVE '],
      [/\bROAD\b/g, ' RD '],
      [/\bBOULEVARD\b/g, ' BLVD '],
      [/\bCRESCENT\b/g, ' CRES '],
      [/\bCOURT\b/g, ' CT '],
      [/\bDRIVE\b/g, ' DR '],
      [/\bLANE\b/g, ' LN '],
      [/\bTRAIL\b/g, ' TRL '],
      [/\bPLACE\b/g, ' PL '],
      [/\bTERRACE\b/g, ' TER '],
      [/\bCIRCLE\b/g, ' CIR '],
      [/\bHIGHWAY\b/g, ' HWY '],
      [/\bPARKWAY\b/g, ' PKWY '],
      [/\bGARDENS\b/g, ' GDNS '],
      [/\bHEIGHTS\b/g, ' HTS '],
      [/\bMOUNT\b/g, ' MT '],
      [/\bCENTRE\b/g, ' CTR '],
      [/\bCENTER\b/g, ' CTR '],
      [/\bNORTH\b/g, ' N '],
      [/\bSOUTH\b/g, ' S '],
      [/\bEAST\b/g, ' E '],
      [/\bWEST\b/g, ' W '],
      [/\bONTARIO\b/g, ' ON ']
    ];
    replacements.forEach(function (pair) { text = text.replace(pair[0], pair[1]); });
    return text.replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, '');
  }

  function streetText_(row) {
    var raw = clean_(row && (row['Street'] || row['Full Address']) || '');
    if (!raw) return '';

    var parts = raw.split(',').map(function (part) { return clean_(part); }).filter(Boolean);
    if (!parts.length) return raw;

    var street = parts[0];
    // Preserve a unit/suite if it is the next comma-delimited segment, but
    // discard accidental city/province/postal text embedded in Street.
    if (parts.length > 1 && /^(#|UNIT\b|SUITE\b|STE\b|APT\b|APARTMENT\b|PH\b|PENTHOUSE\b)/i.test(parts[1])) {
      street += ' ' + parts[1];
    }
    return street;
  }

  function canonicalStreet_(row) {
    return canonicalAddress_(streetText_(row));
  }

  function prepareRequest_(request) {
    var d = deps_();
    var row = cloneRecord_(request || {});

    row['Full Name'] = clean_(row['Full Name']) || d.util.buildFullName(row['First Name'], row['Last Name']);
    row['Full Address'] = clean_(row['Full Address']) || d.util.buildFullAddress(
      row['Street'], row['City'], row['Province'], row['Postal Code'], row['Country']
    );

    if (!clean_(row['Postal Code']) && clean_(row['Full Address'])) {
      row['Postal Code'] = postalFromAddress_(row['Full Address']);
    }

    var parsedPhone = d.util.parsePhone(row['Phone']);
    row['Phone Extension'] = clean_(row['Phone Extension']) || parsedPhone.extension || '';
    row['Normalized Phone'] = d.util.normalizePhone(row['Phone']);
    row['Normalized Alt Phone'] = d.util.normalizePhone(row['Alt Phone']);
    row['Normalized Email'] = d.util.normalizeEmail(row['Email']);
    row['Normalized Postal'] = d.util.normalizePostal(row['Postal Code']);
    row['Normalized Address'] = canonicalAddress_(row['Full Address']);

    return row;
  }

  function normalizationPatch_(request) {
    return {
      'Full Name': request['Full Name'] || '',
      'Full Address': request['Full Address'] || '',
      'Phone Extension': request['Phone Extension'] || '',
      'Postal Code': request['Postal Code'] || '',
      'Normalized Phone': request['Normalized Phone'] || '',
      'Normalized Alt Phone': request['Normalized Alt Phone'] || '',
      'Normalized Email': request['Normalized Email'] || '',
      'Normalized Postal': request['Normalized Postal'] || '',
      'Normalized Address': request['Normalized Address'] || ''
    };
  }

  /************************************************************
   * LEGACY INTAKE LINKAGE REPAIR
   ************************************************************/

  function dateMs_(value) {
    if (!value) return Number.MAX_SAFE_INTEGER;
    var date = new Date(value);
    return isNaN(date.getTime()) ? Number.MAX_SAFE_INTEGER : date.getTime();
  }

  function webformScore_(request, webform) {
    var d = deps_();
    var score = 0;
    var reasons = [];

    var reqEmail = request['Normalized Email'] || d.util.normalizeEmail(request['Email']);
    var webEmail = d.util.normalizeEmail(webform['Email']);
    var reqPhone = request['Normalized Phone'] || d.util.normalizePhone(request['Phone']);
    var webPhone = d.util.normalizePhone(webform['Phone']);
    var reqAddress = request['Normalized Address'] || canonicalAddress_(request['Full Address']);
    var webAddress = canonicalAddress_(webform['Full Address']);

    // Names are deliberately excluded from identity matching. Legacy linkage
    // requires two exact non-name identity signals before it is inferred.
    if (reqEmail && reqEmail === webEmail) { score += 50; reasons.push('EMAIL'); }
    if (reqPhone && reqPhone === webPhone) { score += 45; reasons.push('PHONE'); }
    if (reqAddress && reqAddress === webAddress) { score += 30; reasons.push('ADDRESS'); }

    var requestTime = dateMs_(request['Submitted At']);
    var webTime = dateMs_(webform['Received At']);
    var delta = requestTime === Number.MAX_SAFE_INTEGER || webTime === Number.MAX_SAFE_INTEGER
      ? Number.MAX_SAFE_INTEGER
      : Math.abs(requestTime - webTime);

    return { row: webform, score: score, reasons: reasons, dateDeltaMs: delta };
  }

  function findUniqueWebform_(request, webforms) {
    var candidates = (webforms || []).map(function (row) {
      return webformScore_(request, row);
    }).filter(function (candidate) {
      return candidate.score >= 75;
    }).sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.dateDeltaMs - b.dateDeltaMs;
    });

    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];

    var top = candidates[0];
    var second = candidates[1];

    // If identity score ties, use submission timing only when it clearly
    // distinguishes the rows. Otherwise do not guess the source submission.
    if (top.score === second.score &&
        top.dateDeltaMs !== Number.MAX_SAFE_INTEGER &&
        second.dateDeltaMs !== Number.MAX_SAFE_INTEGER &&
        second.dateDeltaMs - top.dateDeltaMs >= 60000) {
      return top;
    }

    if (top.score > second.score) return top;
    return null;
  }

  function payloadValue_(payload, key) {
    if (!payload || typeof payload !== 'object') return '';
    return payload[key] === null || payload[key] === undefined ? '' : payload[key];
  }

  function fillBlank_(patch, request, header, value) {
    if (!clean_(request[header]) && clean_(value)) patch[header] = value;
  }

  function repairRequestIdentity_(request, webforms, persist) {
    var d = deps_();
    var existingRequestId = clean_(request['Request ID']);
    var needsLinkage = !existingRequestId ||
      !clean_(request['Submission ID']) ||
      !clean_(request['Payload Hash']) ||
      !clean_(request['Source Row ID']);

    if (!needsLinkage) return { repaired: false, request: request, webform: null };

    var match = findUniqueWebform_(request, webforms);
    var webform = match ? match.row : null;
    var patch = {};
    var requestId = existingRequestId;

    if (!requestId) {
      requestId = webform && clean_(webform['Request ID'])
        ? clean_(webform['Request ID'])
        : d.util.generateId('SR');
      patch['Request ID'] = requestId;
    }

    if (webform) {
      var raw = d.util.parseJson(webform['Raw Payload'], {});

      fillBlank_(patch, request, 'Created At', webform['Received At'] || d.util.nowString());
      fillBlank_(patch, request, 'Schema Version', d.config.getSchemaVersion());
      fillBlank_(patch, request, 'Correlation ID', webform['Correlation ID']);
      fillBlank_(patch, request, 'Source System', webform['Source System'] || 'GRAVITY_FORMS');
      fillBlank_(patch, request, 'Source Row ID', webform.__rowNumber);
      fillBlank_(patch, request, 'Submission ID', webform['Submission ID']);
      fillBlank_(patch, request, 'Payload Hash', webform['Payload Hash']);
      fillBlank_(patch, request, 'Campaign Code', webform['Campaign Code']);
      fillBlank_(patch, request, 'Attribution JSON', webform['Attribution JSON']);
      fillBlank_(patch, request, 'Submitted At', payloadValue_(raw, 'submitted_at') || webform['Received At']);

      fillBlank_(patch, request, 'First Name', payloadValue_(raw, 'first_name'));
      fillBlank_(patch, request, 'Last Name', payloadValue_(raw, 'last_name'));
      fillBlank_(patch, request, 'Phone', payloadValue_(raw, 'phone'));
      fillBlank_(patch, request, 'Alt Phone', payloadValue_(raw, 'alt_phone'));
      fillBlank_(patch, request, 'Email', payloadValue_(raw, 'email'));
      fillBlank_(patch, request, 'Street', payloadValue_(raw, 'street'));
      fillBlank_(patch, request, 'City', payloadValue_(raw, 'city'));
      fillBlank_(patch, request, 'Province', payloadValue_(raw, 'province'));
      fillBlank_(patch, request, 'Postal Code', payloadValue_(raw, 'postal_code'));
      fillBlank_(patch, request, 'Country', payloadValue_(raw, 'country'));
      fillBlank_(patch, request, 'Preferred Days', payloadValue_(raw, 'preferred_days'));
      fillBlank_(patch, request, 'Unit Details', payloadValue_(raw, 'make_model_age'));
      fillBlank_(patch, request, 'Service Details', payloadValue_(raw, 'details'));
      fillBlank_(patch, request, 'Additional Notes', payloadValue_(raw, 'anything_else'));
    }

    patch['Updated At'] = d.util.nowString();

    Object.keys(patch).forEach(function (key) { request[key] = patch[key]; });

    if (persist === true && request.__rowNumber) {
      d.util.patchRow('SERVICE_REQUESTS', request.__rowNumber, patch);

      if (webform && webform.__rowNumber) {
        var webPatch = {
          'Request ID': requestId,
          'Updated At': d.util.nowString()
        };
        if (!clean_(webform['Processed At'])) webPatch['Processed At'] = d.util.nowString();
        d.util.patchRow('WEBFORM_REQUESTS', webform.__rowNumber, webPatch);
      }

      d.util.logEvent({
        module: MODULE_NAME,
        action: 'REPAIR REQUEST LINKAGE',
        status: webform ? 'COMPLETE' : 'PARTIAL',
        requestId: requestId,
        message: webform
          ? 'Legacy Service Request linkage repaired from a unique Webform Request.'
          : 'A Request ID was generated, but no unique Webform Request linkage was inferred.',
        details: {
          serviceRow: request.__rowNumber,
          webformRow: webform ? webform.__rowNumber : '',
          submissionId: webform ? webform['Submission ID'] : '',
          matchScore: match ? match.score : 0,
          matchReasons: match ? match.reasons : []
        },
        version: VERSION
      });
    }

    return { repaired: Object.keys(patch).length > 1, request: request, webform: webform };
  }

  /************************************************************
   * CUSTOMER MATCHING — DETERMINISTIC IDENTITY ONLY
   *
   * Match keys:
   * - Exact email
   * - Exact primary phone
   * - Exact alternate phone
   * - Exact normalized address
   *
   * Names NEVER contribute to matching or scoring.
   ************************************************************/

  function normalizedCachePhone_(row) {
    var d = deps_();
    return d.util.normalizePhone(row && (row['Phone'] || row['Normalized Phone']) || '');
  }

  function normalizedCacheEmail_(row) {
    var d = deps_();
    return d.util.normalizeEmail(row && (row['Email'] || row['Normalized Email']) || '');
  }

  function normalizedCachePostal_(row) {
    var d = deps_();
    return d.util.normalizePostal(row && (row['Postal Code'] || row['Normalized Postal']) || '');
  }

  function normalizedCacheAddress_(row) {
    var d = deps_();
    return canonicalAddress_(row && (row['Full Address'] || row['Normalized Address']) || '');
  }

  function addIndex_(map, key, row) {
    key = String(key || '');
    if (!key) return;
    if (!map[key]) map[key] = [];
    map[key].push(row);
  }

  function ensureIdentityIndexes_(maps) {
    if (maps.__identityIndexesReady === true) return maps;

    maps.identityCustomersByPhone = {};
    maps.identityCustomersByEmail = {};
    maps.identityCustomersByAddress = {};
    maps.identityContactsByPhone = {};
    maps.identityContactsByEmail = {};
    maps.identityLocationsByAddress = {};

    (maps.customers || []).forEach(function (row) {
      addIndex_(maps.identityCustomersByPhone, normalizedCachePhone_(row), row);
      addIndex_(maps.identityCustomersByEmail, normalizedCacheEmail_(row), row);
      addIndex_(maps.identityCustomersByAddress, normalizedCacheAddress_(row), row);
    });

    (maps.contacts || []).forEach(function (row) {
      addIndex_(maps.identityContactsByPhone, normalizedCachePhone_(row), row);
      addIndex_(maps.identityContactsByEmail, normalizedCacheEmail_(row), row);
    });

    (maps.locations || []).forEach(function (row) {
      addIndex_(maps.identityLocationsByAddress, normalizedCacheAddress_(row), row);
    });

    maps.__identityIndexesReady = true;
    return maps;
  }

  function customerIdsFromRows_(rows, idHeader) {
    var ids = {};
    (rows || []).forEach(function (row) {
      var id = String(row[idHeader] || row['Customer ID'] || '');
      if (id) ids[id] = true;
    });
    return Object.keys(ids);
  }

  function mergeIds_(target, ids) {
    (ids || []).forEach(function (id) { target[String(id)] = true; });
  }

  function intersectIds_(left, right) {
    var rightMap = {};
    (right || []).forEach(function (id) { rightMap[String(id)] = true; });
    return (left || []).filter(function (id) { return rightMap[String(id)] === true; });
  }

  function signal_(label, weight, ids) {
    var unique = {};
    (ids || []).forEach(function (id) { if (id) unique[String(id)] = true; });
    return { label: label, weight: weight, ids: Object.keys(unique) };
  }

  function contactBridgeCustomers_(request, maps) {
    ensureIdentityIndexes_(maps);

    var customerIds = {};

    if (request['Normalized Email']) {
      mergeIds_(
        customerIds,
        customerIdsFromRows_(
          maps.identityContactsByEmail[request['Normalized Email']] || [],
          'Customer ID'
        )
      );
    }

    if (request['Normalized Phone']) {
      mergeIds_(
        customerIds,
        customerIdsFromRows_(
          maps.identityContactsByPhone[request['Normalized Phone']] || [],
          'Customer ID'
        )
      );
    }

    if (request['Normalized Alt Phone']) {
      mergeIds_(
        customerIds,
        customerIdsFromRows_(
          maps.identityContactsByPhone[request['Normalized Alt Phone']] || [],
          'Customer ID'
        )
      );
    }

    return Object.keys(customerIds).map(function (customerId) {
      return maps.customersById[String(customerId)] || { 'Customer ID': customerId };
    });
  }

  function customerSignals_(request, maps) {
    ensureIdentityIndexes_(maps);
    var signals = [];

    if (request['Normalized Email']) {
      var emailIds = {};
      mergeIds_(emailIds, customerIdsFromRows_(maps.identityCustomersByEmail[request['Normalized Email']] || [], 'Customer ID'));
      mergeIds_(emailIds, customerIdsFromRows_(maps.identityContactsByEmail[request['Normalized Email']] || [], 'Customer ID'));
      signals.push(signal_('EMAIL', 50, Object.keys(emailIds)));
    }

    if (request['Normalized Phone']) {
      var phoneIds = {};
      mergeIds_(phoneIds, customerIdsFromRows_(maps.identityCustomersByPhone[request['Normalized Phone']] || [], 'Customer ID'));
      mergeIds_(phoneIds, customerIdsFromRows_(maps.identityContactsByPhone[request['Normalized Phone']] || [], 'Customer ID'));
      signals.push(signal_('PRIMARY PHONE', 45, Object.keys(phoneIds)));
    }

    if (request['Normalized Alt Phone']) {
      var altPhoneIds = {};
      mergeIds_(altPhoneIds, customerIdsFromRows_(maps.identityCustomersByPhone[request['Normalized Alt Phone']] || [], 'Customer ID'));
      mergeIds_(altPhoneIds, customerIdsFromRows_(maps.identityContactsByPhone[request['Normalized Alt Phone']] || [], 'Customer ID'));
      signals.push(signal_('ALT PHONE', 35, Object.keys(altPhoneIds)));
    }

    if (request['Normalized Address']) {
      var addressIds = {};
      mergeIds_(addressIds, customerIdsFromRows_(maps.identityCustomersByAddress[request['Normalized Address']] || [], 'Customer ID'));
      mergeIds_(addressIds, customerIdsFromRows_(maps.identityLocationsByAddress[request['Normalized Address']] || [], 'Customer ID'));
      signals.push(signal_('ADDRESS', 40, Object.keys(addressIds)));
    }

    return signals;
  }

  function candidateEvidence_(customerId, signals) {
    var reasons = [];
    var score = 0;
    (signals || []).forEach(function (sig) {
      if (sig.ids.indexOf(String(customerId)) !== -1) {
        reasons.push(sig.label);
        score += sig.weight;
      }
    });
    return { reasons: reasons, score: Math.min(100, score) };
  }

  function customerCandidateRows_(ids, signals, maps, request) {
    return (ids || []).map(function (id) {
      var row = maps.customersById[String(id)] || {};
      var evidence = candidateEvidence_(id, signals);
      return {
        row: row,
        score: evidence.score,
        reasons: evidence.reasons,
        conflicts: [],
        contactEvidence: [],
        nameEvidence: request ? customerNameEvidence_(request, id, maps) : {}
      };
    }).sort(function (a, b) { return b.score - a.score; });
  }

  // HOUSEHOLD_AWARE_NAME_DISAMBIGUATION_V1
  // Name is a SECONDARY person-level disambiguator. It never generates a
  // global Customer candidate by itself. Email/phone identify a person/account;
  // address identifies a household/location.
  function canonicalPersonName_(value) {
    var text = upper_(value);
    if (!text) return '';
    try { text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (ignored) {}
    text = text.replace(/\b(MR|MRS|MS|MISS|DR|PROF)\.?\b/g, ' ');
    return text.replace(/[^A-Z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }

  function personNameParts_(value) {
    var full = canonicalPersonName_(value);
    var tokens = full ? full.split(' ').filter(Boolean) : [];
    return {
      full: full,
      first: tokens.length ? tokens[0] : '',
      last: tokens.length > 1 ? tokens[tokens.length - 1] : ''
    };
  }

    // CF_SERVICEOPS_V5_10_5_HOUSEHOLD_MEMBER_NAMES_R1
  // Expand household-style display names into person candidates without
  // weakening the primary email/phone identity requirements. Examples:
  //   Kelly & Terry Bradley -> Kelly Bradley, Terry Bradley
  //   Kevin Hydal And Joanne Bedard -> Kevin Hydal, Joanne Bedard
  function householdPersonNames_(value) {
    var raw = clean_(value);
    var canonical = canonicalPersonName_(raw);
    if (!canonical) return [];

    var upperRaw = upper_(raw);
    var hasHouseholdSeparator = /(?:\s&\s|\bAND\b)/.test(upperRaw);
    if (!hasHouseholdSeparator) return [canonical];

    var pieces = upperRaw
      .replace(/\bAND\b/g, ' & ')
      .split(/\s*&\s*/g)
      .map(function (part) { return canonicalPersonName_(part); })
      .filter(Boolean);
    if (pieces.length < 2) return [canonical];

    // When one side omits the shared surname, infer it from the last explicit
    // multi-token person. This is deliberately limited to household-separated
    // names and never creates a global identity candidate by itself.
    var sharedLast = '';
    for (var i = pieces.length - 1; i >= 0; i--) {
      var p = personNameParts_(pieces[i]);
      if (p.first && p.last && p.first !== p.last) { sharedLast = p.last; break; }
    }

    var out = [];
    function add_(name) {
      name = canonicalPersonName_(name);
      if (!name) return;
      var parts = personNameParts_(name);
      if (!parts.first || !parts.last || parts.first === parts.last) return;
      if (out.indexOf(parts.full) === -1) out.push(parts.full);
    }

    pieces.forEach(function (piece) {
      var tokens = piece.split(' ').filter(Boolean);
      if (tokens.length === 1 && sharedLast) add_(tokens[0] + ' ' + sharedLast);
      else add_(piece);
    });

    return out;
  }

  function simplePersonNameEqualV5105_(left, right) {
    var a = personNameParts_(left);
    var b = personNameParts_(right);
    if (!a.full || !b.full) return false;
    if (a.full === b.full) return true;
    if (a.first && a.last && b.first && b.last) {
      if (a.first === b.first && a.last === b.last) return true;
      if (a.first === b.last && a.last === b.first) return true;
    }
    return false;
  }

function samePersonName_(left, right) {
    var leftNames = householdPersonNames_(left);
    var rightNames = householdPersonNames_(right);
    if (!leftNames.length || !rightNames.length) return false;
    for (var i = 0; i < leftNames.length; i++) {
      for (var j = 0; j < rightNames.length; j++) {
        if (simplePersonNameEqualV5105_(leftNames[i], rightNames[j])) return true;
      }
    }
    return false;
  }

  function requestPersonName_(request) {
    return clean_(request && request['Full Name']) ||
      [clean_(request && request['First Name']), clean_(request && request['Last Name'])].filter(Boolean).join(' ');
  }

  function rowPersonNames_(row, includeCustomerName) {
    row = row || {};
    var values = [];
    function add_(value) {
      value = clean_(value);
      if (value && values.indexOf(value) === -1) values.push(value);
    }
    add_(row['Full Name']);
    if (includeCustomerName) add_(row['Customer Name']);
    add_([clean_(row['First Name']), clean_(row['Last Name'])].filter(Boolean).join(' '));
    return values;
  }

  function customerNameEvidence_(request, customerId, maps) {
    var requestName = requestPersonName_(request);
    var hits = [];
    if (!requestName) return { matched: false, requestName: '', hits: [] };

    var customer = maps.customersById[String(customerId)] || {};
    rowPersonNames_(customer, true).forEach(function (name) {
      if (samePersonName_(requestName, name)) hits.push({ source: 'CUSTOMER', name: name });
    });

    (maps.contactsByCustomer[String(customerId)] || []).forEach(function (contact) {
      rowPersonNames_(contact, false).forEach(function (name) {
        if (samePersonName_(requestName, name)) {
          hits.push({ source: 'CONTACT', contactId: String(contact['Contact ID'] || ''), name: name });
        }
      });
    });

    return { matched: hits.length > 0, requestName: requestName, hits: hits };
  }

  function idsFromSignals_(signals) {
    var ids = {};
    (signals || []).forEach(function (sig) { mergeIds_(ids, sig.ids); });
    return Object.keys(ids);
  }

  function deterministicIdFromSignals_(signals) {
    signals = signals || [];
    if (!signals.length) return '';

    var intersection = signals[0].ids.slice();
    for (var i = 1; i < signals.length; i++) intersection = intersectIds_(intersection, signals[i].ids);
    if (intersection.length === 1) return String(intersection[0]);

    if (signals.length === 1 && signals[0].ids.length === 1) return String(signals[0].ids[0]);

    var unionIds = idsFromSignals_(signals);
    var supportedByAll = unionIds.filter(function (id) {
      return signals.every(function (sig) { return sig.ids.indexOf(String(id)) !== -1; });
    });
    return supportedByAll.length === 1 ? String(supportedByAll[0]) : '';
  }

  function nameMatchedCustomerIds_(request, ids, maps) {
    return (ids || []).filter(function (id) {
      return customerNameEvidence_(request, id, maps).matched;
    });
  }

  function matchedCustomer_(id, evidenceSignals, allSignals, allIds, request, maps, method, nameWeight) {
    id = String(id);
    var evidence = candidateEvidence_(id, evidenceSignals || []);
    var nameEvidence = customerNameEvidence_(request, id, maps);
    var reasons = evidence.reasons.slice();
    if (nameEvidence.matched && reasons.indexOf('NAME') === -1) reasons.push('NAME');
    var score = Math.min(100, evidence.score + (nameEvidence.matched ? Number(nameWeight || 10) : 0));
    return {
      status: 'MATCHED',
      id: id,
      row: maps.customersById[id] || {},
      confidence: score >= 80 ? 'HIGH' : 'MEDIUM',
      score: score,
      method: method || reasons.join(' + '),
      reasons: reasons,
      conflicts: [],
      candidates: customerCandidateRows_(allIds || [id], allSignals || evidenceSignals || [], maps, request),
      nameEvidence: nameEvidence
    };
  }

  function ambiguousCustomer_(request, ids, signals, maps, reason, conflictCode, method) {
    return {
      status: 'AMBIGUOUS',
      id: '',
      row: {},
      confidence: 'NONE',
      score: 0,
      method: method || (signals || []).map(function (sig) { return sig.label; }).join(' + '),
      reasons: (signals || []).map(function (sig) { return sig.label; }),
      conflicts: [conflictCode || 'IDENTITY SIGNALS RESOLVE TO MULTIPLE CUSTOMERS'],
      candidates: customerCandidateRows_(ids, signals, maps, request),
      reviewReason: reason || 'Customer resolution requires operator review.',
      nameEvidence: {}
    };
  }

    /************************************************************
   * CUSTOMER MATCHING TIERS — v5.10.1
   * PRIMARY   exact email / phone identity (Customer or Contact)
   * SECONDARY exact address identity + exact person name
   * TERTIARY  name-only / address-only evidence; review only
   ************************************************************/
  function canonicalName_(value) {
    return upper_(value).replace(/[^A-Z0-9]+/g, '');
  }

  function streetPostalKey_(row) {
    var street = canonicalStreet_(row || {});
    var postal = normalizedCachePostal_(row || {});
    return street && postal ? street + '|' + postal : '';
  }

  // CF_SERVICEOPS_V5_10_13_RUNTIME_MATCHING_SO_NOTES_QUEUE_R1
  // Secondary household identity fallback for incomplete Striven addresses.
  // It is NEVER sufficient alone to auto-link a Customer; resolveCustomer_
  // still requires exact person-name corroboration and uniqueness.
  function postalMissingOrPlaceholderV5137_(row) {
    var raw=clean_(row&&row['Postal Code']);
    var norm=normalizedCachePostal_(row);
    var compact=String(raw||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(!norm)return true;
    return /PLACEHOLDER|UNKNOWN|NOTPROVIDED|NOTAVAILABLE|TBD|N\/?A/i.test(String(raw||'')) ||
      compact==='000000' || compact==='00000' || compact==='999999';
  }

  function canonicalCity_(row) {
    return upper_(row && row['City']).replace(/[^A-Z0-9]+/g, '');
  }

  function streetCityKey_(row) {
    var street = canonicalStreet_(row || {});
    var city = canonicalCity_(row || {});
    return street && city ? street + '|' + city : '';
  }

  function ensureTierIndexes_(maps) {
    ensureIdentityIndexes_(maps);
    if (maps.__tierIndexesReady === true) return maps;

    maps.identityCustomersByName = {};
    maps.identityContactsByName = {};
    maps.identityCustomersByStreetPostal = {};
    maps.identityLocationsByStreetPostal = {};
    maps.identityCustomersByStreetCity = {};
    maps.identityLocationsByStreetCity = {};

    (maps.customers || []).forEach(function (row) {
      addIndex_(maps.identityCustomersByName, canonicalName_(row['Customer Name'] || row['Full Name']), row);
      addIndex_(maps.identityCustomersByStreetPostal, streetPostalKey_(row), row);
      addIndex_(maps.identityCustomersByStreetCity, streetCityKey_(row), row);
    });
    (maps.contacts || []).forEach(function (row) {
      addIndex_(maps.identityContactsByName, canonicalName_(row['Full Name'] || row['Customer Name']), row);
    });
    (maps.locations || []).forEach(function (row) {
      addIndex_(maps.identityLocationsByStreetPostal, streetPostalKey_(row), row);
      addIndex_(maps.identityLocationsByStreetCity, streetCityKey_(row), row);
    });

    maps.__tierIndexesReady = true;
    return maps;
  }

  function primarySignalsV5101_(request, maps) {
    ensureTierIndexes_(maps);
    var signals = [];
    if (request['Normalized Email']) {
      var emailIds = {};
      mergeIds_(emailIds, customerIdsFromRows_(maps.identityCustomersByEmail[request['Normalized Email']] || [], 'Customer ID'));
      mergeIds_(emailIds, customerIdsFromRows_(maps.identityContactsByEmail[request['Normalized Email']] || [], 'Customer ID'));
      signals.push(signal_('PRIMARY EMAIL', 60, Object.keys(emailIds)));
    }
    if (request['Normalized Phone']) {
      var phoneIds = {};
      mergeIds_(phoneIds, customerIdsFromRows_(maps.identityCustomersByPhone[request['Normalized Phone']] || [], 'Customer ID'));
      mergeIds_(phoneIds, customerIdsFromRows_(maps.identityContactsByPhone[request['Normalized Phone']] || [], 'Customer ID'));
      signals.push(signal_('PRIMARY PHONE', 55, Object.keys(phoneIds)));
    }
    if (request['Normalized Alt Phone']) {
      var altIds = {};
      mergeIds_(altIds, customerIdsFromRows_(maps.identityCustomersByPhone[request['Normalized Alt Phone']] || [], 'Customer ID'));
      mergeIds_(altIds, customerIdsFromRows_(maps.identityContactsByPhone[request['Normalized Alt Phone']] || [], 'Customer ID'));
      signals.push(signal_('PRIMARY ALT PHONE', 45, Object.keys(altIds)));
    }
    return signals;
  }

  function addressCustomerIdsV5101_(request, maps) {
    ensureTierIndexes_(maps);
    var ids = {};
    var address = request['Normalized Address'] || canonicalAddress_(request['Full Address']);
    if (address) {
      mergeIds_(ids, customerIdsFromRows_(maps.identityCustomersByAddress[address] || [], 'Customer ID'));
      mergeIds_(ids, customerIdsFromRows_(maps.identityLocationsByAddress[address] || [], 'Customer ID'));
    }
    var key = streetPostalKey_(request);
    if (key) {
      mergeIds_(ids, customerIdsFromRows_(maps.identityCustomersByStreetPostal[key] || [], 'Customer ID'));
      mergeIds_(ids, customerIdsFromRows_(maps.identityLocationsByStreetPostal[key] || [], 'Customer ID'));
    }

    // If Striven omitted postal information, preserve address evidence using
    // exact canonical street + exact city. This remains SECONDARY evidence and
    // only auto-links when exact person name intersects to one Customer.
    var streetCity = streetCityKey_(request);
    if (streetCity) {
      mergeIds_(ids, customerIdsFromRows_(maps.identityCustomersByStreetCity[streetCity] || [], 'Customer ID'));
      mergeIds_(ids, customerIdsFromRows_(maps.identityLocationsByStreetCity[streetCity] || [], 'Customer ID'));
    }
    return Object.keys(ids);
  }

  /* CF_SERVICEOPS_V5_12_5_HOUSEHOLD_IDENTITY_POLICY_R1 */
  function strongHouseholdAddressCustomerIdsV5125_(request, maps) {
    ensureTierIndexes_(maps);
    var ids = {};
    var address = request['Normalized Address'] || canonicalAddress_(request['Full Address']);
    if (address) {
      mergeIds_(ids, customerIdsFromRows_(maps.identityCustomersByAddress[address] || [], 'Customer ID'));
      mergeIds_(ids, customerIdsFromRows_(maps.identityLocationsByAddress[address] || [], 'Customer ID'));
    }
    var key = streetPostalKey_(request);
    if (key) {
      mergeIds_(ids, customerIdsFromRows_(maps.identityCustomersByStreetPostal[key] || [], 'Customer ID'));
      mergeIds_(ids, customerIdsFromRows_(maps.identityLocationsByStreetPostal[key] || [], 'Customer ID'));
    }
    return Object.keys(ids);
  }

  function requestLastNameV5125_(request) {
    var p = personNameParts_(requestPersonName_(request));
    return p && p.last ? p.last : '';
  }

  function customerSupportsHouseholdSurnameV5125_(customerId, lastName, maps) {
    lastName = clean_(lastName);
    if (!lastName) return false;
    var names = [];
    function add_(value) {
      householdPersonNames_(value).forEach(function (name) { if (names.indexOf(name) === -1) names.push(name); });
    }
    rowPersonNames_(maps.customersById[String(customerId)] || {}, true).forEach(add_);
    (maps.contactsByCustomer[String(customerId)] || []).forEach(function (contact) {
      rowPersonNames_(contact, false).forEach(add_);
    });
    return names.some(function (name) {
      var p = personNameParts_(name);
      return p && p.last === lastName;
    });
  }

  function householdAddressSurnameIdsV5125_(request, maps) {
    var lastName = requestLastNameV5125_(request);
    if (!lastName) return [];
    return strongHouseholdAddressCustomerIdsV5125_(request, maps).filter(function (id) {
      return customerSupportsHouseholdSurnameV5125_(id, lastName, maps);
    });
  }

  function editDistanceAtMostOneV5125_(left, right) {
    left = clean_(left); right = clean_(right);
    if (left === right) return true;
    if (Math.abs(left.length - right.length) > 1) return false;
    var i = 0, j = 0, edits = 0;
    while (i < left.length && j < right.length) {
      if (left.charAt(i) === right.charAt(j)) { i++; j++; continue; }
      edits++;
      if (edits > 1) return false;
      if (left.length > right.length) i++;
      else if (right.length > left.length) j++;
      else { i++; j++; }
    }
    if (i < left.length || j < right.length) edits++;
    return edits <= 1;
  }

  function minorPersonNameVariantV5125_(left, right) {
    var leftNames = householdPersonNames_(left);
    var rightNames = householdPersonNames_(right);
    for (var i = 0; i < leftNames.length; i++) {
      for (var j = 0; j < rightNames.length; j++) {
        var a = personNameParts_(leftNames[i]);
        var b = personNameParts_(rightNames[j]);
        if (!a.first || !a.last || !b.first || !b.last) continue;
        if (a.last !== b.last || a.first === b.first) continue;
        if (editDistanceAtMostOneV5125_(a.first, b.first)) return true;
      }
    }
    return false;
  }

  function nameCustomerIdsV5101_(request, maps) {
    ensureTierIndexes_(maps);
    var name = canonicalName_(request['Full Name']);
    if (!name) return [];
    var ids = {};
    mergeIds_(ids, customerIdsFromRows_(maps.identityCustomersByName[name] || [], 'Customer ID'));
    mergeIds_(ids, customerIdsFromRows_(maps.identityContactsByName[name] || [], 'Customer ID'));
    return Object.keys(ids);
  }

  function tierCandidateRowsV5101_(ids, signals, maps) {
    return customerCandidateRows_(ids || [], signals || [], maps).slice(0, 10);
  }

  function matchedCustomerV5101_(id, tier, method, score, reasons, candidates, maps) {
    return {
      status: 'MATCHED', id: String(id), row: maps.customersById[String(id)] || {},
      confidence: tier === 'PRIMARY' ? 'HIGH' : 'MEDIUM', score: score,
      method: tier + ' — ' + method, tier: tier, reasons: reasons || [], conflicts: [],
      candidates: candidates || [], contactEvidence: []
    };
  }

  function ambiguousCustomerV5101_(method, reasons, conflicts, candidates) {
    candidates = candidates || [];
    var candidateText = candidates.slice(0, 5).map(function (row) {
      var id = clean_(row && (row['Customer ID'] || row['Entity ID']));
      var name = clean_(row && (row['Customer Name'] || row['Full Name']));
      return [id, name].filter(Boolean).join(' — ');
    }).filter(Boolean).join(' | ');
    var why = (conflicts || []).join('; ') || method || 'Customer evidence is not unique.';
    return {
      status: 'AMBIGUOUS', id: '', row: {}, confidence: 'NONE', score: 0,
      method: method, tier: 'REVIEW', reasons: reasons || [], conflicts: conflicts || [],
      candidates: candidates, contactEvidence: [],
      reviewReason: 'Blocked customer match. Why: ' + why +
        (candidateText ? ' Candidates: ' + candidateText + '.' : '') +
        ' Correct: verify the submitted phone/email/address against Striven, or select the correct Customer before continuing.'
    };
  }

function resolveCustomer_(request, maps, selectedCustomerId) {
    ensureTierIndexes_(maps);

    selectedCustomerId = clean_(selectedCustomerId);
    if (selectedCustomerId) {
      var selectedCustomer = maps.customersById[String(selectedCustomerId)] || {};
      if (!selectedCustomer['Customer ID']) {
        throw new Error('Selected Customer ID is not present in the fresh Striven cache: ' + selectedCustomerId);
      }
      return {
        status: 'MATCHED', id: String(selectedCustomerId), row: selectedCustomer,
        confidence: 'HIGH', score: 100, method: 'OPERATOR SELECTED CUSTOMER', tier: 'OPERATOR',
        reasons: ['OPERATOR SELECTED CUSTOMER'], conflicts: [], candidates: [], contactEvidence: []
      };
    }

    var hasIdentity = request['Normalized Email'] || request['Normalized Phone'] ||
      request['Normalized Alt Phone'] || request['Normalized Address'] || request['Full Name'];
    if (!hasIdentity) {
      return {
        status: 'MISSING INFORMATION', id: '', row: {}, confidence: 'NONE', score: 0,
        method: '', tier: '', reasons: [], conflicts: [], candidates: [], contactEvidence: []
      };
    }

    // PRIMARY — exact email/phone identity, bridged through Contact to Customer.
    var primarySignals = primarySignalsV5101_(request, maps);
    var matchedPrimary = primarySignals.filter(function (sig) { return sig.ids.length > 0; });
    var primarySet = [];
    var primaryConflict = false;
    if (matchedPrimary.length) {
      primarySet = matchedPrimary[0].ids.slice();
      for (var p = 1; p < matchedPrimary.length; p++) primarySet = intersectIds_(primarySet, matchedPrimary[p].ids);
      if (!primarySet.length && matchedPrimary.length > 1) primaryConflict = true;
    }

    // SECONDARY — address identity PLUS exact person name. Either signal by
    // itself remains TERTIARY and cannot auto-link.
    var addressIds = addressCustomerIdsV5101_(request, maps);
    var nameIds = nameCustomerIdsV5101_(request, maps);
    var secondaryIds = intersectIds_(addressIds, nameIds);
    var secondarySignals = [
      signal_('SECONDARY ADDRESS', 45, addressIds),
      signal_('SECONDARY NAME', 35, nameIds)
    ];

    if (primaryConflict) {
      var primaryUnion = {};
      matchedPrimary.forEach(function (sig) { mergeIds_(primaryUnion, sig.ids); });
      return ambiguousCustomerV5101_(
        'PRIMARY — CONFLICTING EMAIL / PHONE IDENTITY',
        matchedPrimary.map(function (sig) { return sig.label; }),
        ['PRIMARY IDENTITY SIGNALS RESOLVE TO DIFFERENT CUSTOMERS'],
        tierCandidateRowsV5101_(Object.keys(primaryUnion), matchedPrimary, maps)
      );
    }

    if (matchedPrimary.length) {
      // One Customer supported by every matched Primary signal: Primary wins,
      // unless the strong Secondary pair points to a different Customer.
      if (primarySet.length === 1) {
        var primaryId = String(primarySet[0]);
        if (secondaryIds.length === 1 && String(secondaryIds[0]) !== primaryId) {
          return ambiguousCustomerV5101_(
            'PRIMARY / SECONDARY CONFLICT',
            matchedPrimary.map(function (sig) { return sig.label; }).concat(['SECONDARY ADDRESS + NAME']),
            ['PRIMARY IDENTITY AND SECONDARY ADDRESS+NAME RESOLVE TO DIFFERENT CUSTOMERS'],
            tierCandidateRowsV5101_([primaryId, String(secondaryIds[0])], matchedPrimary.concat(secondarySignals), maps)
          );
        }
        var ev = candidateEvidence_(primaryId, matchedPrimary);
        return matchedCustomerV5101_(
          primaryId, 'PRIMARY', ev.reasons.join(' + '), Math.max(95, ev.score), ev.reasons,
          tierCandidateRowsV5101_(primarySet, matchedPrimary, maps), maps
        );
      }

      // A shared Primary identifier (for example a household email) is not
      // enough by itself. Secondary may safely narrow it only when the exact
      // address+name Customer is inside every matched Primary candidate set.
      if (primarySet.length > 1 && secondaryIds.length === 1 && primarySet.indexOf(String(secondaryIds[0])) !== -1) {
        return matchedCustomerV5101_(
          String(secondaryIds[0]), 'SECONDARY', 'ADDRESS + NAME (RESOLVES SHARED PRIMARY IDENTITY)', 90,
          ['SECONDARY ADDRESS', 'SECONDARY NAME'].concat(matchedPrimary.map(function (sig) { return sig.label; })),
          tierCandidateRowsV5101_(primarySet, matchedPrimary.concat(secondarySignals), maps), maps
        );
      }

      return ambiguousCustomerV5101_(
        'PRIMARY — SHARED / AMBIGUOUS IDENTITY',
        matchedPrimary.map(function (sig) { return sig.label; }),
        ['PRIMARY IDENTITY IS NOT UNIQUE; SECONDARY DID NOT SAFELY RESOLVE IT'],
        tierCandidateRowsV5101_(primarySet.length ? primarySet : matchedPrimary[0].ids, matchedPrimary.concat(secondarySignals), maps)
      );
    }

    // No Primary identity matched. A unique exact address + exact person name
    // is sufficiently corroborated to link the existing Customer.
    if (secondaryIds.length === 1) {
      return matchedCustomerV5101_(
        String(secondaryIds[0]), 'SECONDARY', 'ADDRESS + NAME', 80,
        ['SECONDARY ADDRESS', 'SECONDARY NAME'],
        tierCandidateRowsV5101_(secondaryIds, secondarySignals, maps), maps
      );
    }
    if (secondaryIds.length > 1) {
      return ambiguousCustomerV5101_(
        'SECONDARY — MULTIPLE ADDRESS + NAME CUSTOMERS',
        ['SECONDARY ADDRESS', 'SECONDARY NAME'],
        ['SECONDARY MATCH IS NOT UNIQUE'],
        tierCandidateRowsV5101_(secondaryIds, secondarySignals, maps)
      );
    }

    // HOUSEHOLD — exact service address + exact surname is sufficient to reuse
    // a unique household Customer when no Primary email/phone identity matched.
    // Surname alone is never sufficient, and multiple household candidates review.
    var householdIdsV5125 = householdAddressSurnameIdsV5125_(request, maps);
    if (householdIdsV5125.length === 1) {
      return matchedCustomerV5101_(
        String(householdIdsV5125[0]), 'SECONDARY', 'HOUSEHOLD ADDRESS + SURNAME', 78,
        ['STRONG HOUSEHOLD ADDRESS', 'HOUSEHOLD SURNAME'],
        tierCandidateRowsV5101_(householdIdsV5125, [signal_('STRONG HOUSEHOLD ADDRESS', 50, householdIdsV5125)], maps), maps
      );
    }
    if (householdIdsV5125.length > 1) {
      return ambiguousCustomerV5101_(
        'HOUSEHOLD — MULTIPLE ADDRESS + SURNAME CUSTOMERS',
        ['STRONG HOUSEHOLD ADDRESS', 'HOUSEHOLD SURNAME'],
        ['HOUSEHOLD ADDRESS + SURNAME MATCH IS NOT UNIQUE'],
        tierCandidateRowsV5101_(householdIdsV5125, [signal_('STRONG HOUSEHOLD ADDRESS', 50, householdIdsV5125)], maps)
      );
    }
    /* CF_SERVICEOPS_V5_12_7_AUTONOMOUS_TERTIARY_SAFE_CREATE_R1 */
    // TERTIARY evidence is diagnostic only. A same-name or address-only collision
    // does not prove identity and therefore must not block safe creation of a new
    // Customer. Strong primary/secondary/household evidence above still governs
    // linking, and genuine competing corroborated identity still reviews.
    var tertiaryUnion = {};
    mergeIds_(tertiaryUnion, addressIds);
    mergeIds_(tertiaryUnion, nameIds);
    var tertiaryIds = Object.keys(tertiaryUnion);
    if (tertiaryIds.length) {
      var tertiarySignals = [
        signal_('TERTIARY ADDRESS ONLY', 40, addressIds),
        signal_('TERTIARY NAME ONLY', 25, nameIds)
      ];
      return {
        status: 'NOT FOUND', id: '', row: {}, confidence: 'NONE', score: 0,
        method: 'TERTIARY ONLY — SAFE CREATE NEW CUSTOMER', tier: 'TERTIARY_INFORMATIONAL',
        reasons: tertiarySignals.filter(function (sig) { return sig.ids.length; }).map(function (sig) { return sig.label; }),
        conflicts: [],
        candidates: tierCandidateRowsV5101_(tertiaryIds, tertiarySignals, maps),
        contactEvidence: []
      };
    }

    return {
      status: 'NOT FOUND', id: '', row: {}, confidence: 'NONE', score: 0,
      method: 'NO PRIMARY, SECONDARY OR TERTIARY CUSTOMER EVIDENCE', tier: 'NONE',
      reasons: [], conflicts: [], candidates: [], contactEvidence: []
    };
  }

  /************************************************************
   * CONTACT MATCHING — WITHIN RESOLVED CUSTOMER ONLY
   ************************************************************/

  function contactSignal_(label, contacts) {
    return {
      label: label,
      ids: uniqueById_(contacts || [], 'Contact ID').map(function (row) { return String(row['Contact ID']); }),
      rows: uniqueById_(contacts || [], 'Contact ID')
    };
  }

    // CF_SERVICEOPS_V5_10_5_CONTACT_HOUSEHOLD_MEMBER_NAMES_R2
function contactNameCandidates_(request, contacts) {
    var requestName = requestPersonName_(request);
    if (!requestName) return [];
    return uniqueById_((contacts || []).filter(function (row) {
      return rowPersonNames_(row, false).some(function (name) { return samePersonName_(requestName, name); });
    }), 'Contact ID');
  }

    function resolveContact_(request, customerId, maps, selectedContactId) {
    if (!customerId) {
      return { status: 'NOT CHECKED', id: '', row: {}, action: 'CREATE', method: '', candidates: [] };
    }

    var contacts = maps.contactsByCustomer[String(customerId)] || [];
    var nameCandidates = contactNameCandidates_(request, contacts);

    selectedContactId = clean_(selectedContactId);
    if (selectedContactId) {
      var selectedContact = contacts.filter(function (row) {
        return String(row['Contact ID']) === String(selectedContactId);
      })[0] || {};
      if (!selectedContact['Contact ID']) {
        throw new Error('Selected Contact ' + selectedContactId + ' does not belong to Customer ' + customerId + '.');
      }
      return {
        status: 'MATCHED', id: String(selectedContactId), row: selectedContact, action: 'LINK EXISTING',
        method: 'OPERATOR SELECTED CONTACT', candidates: []
      };
    }

    function matchedContact_(row, method) {
      return {
        status: 'MATCHED', id: String(row['Contact ID']), row: row, action: 'LINK EXISTING',
        method: method, candidates: []
      };
    }

    function resultForSignal_(label, rows) {
      var uniqueRows = uniqueById_(rows || [], 'Contact ID');
      if (!uniqueRows.length) return null;

      var namedWithinSignal = contactNameCandidates_(request, uniqueRows);
      if (namedWithinSignal.length === 1) return matchedContact_(namedWithinSignal[0], label + ' + NAME');

      if (uniqueRows.length === 1) {
        var only = uniqueRows[0];
        /* CF_SERVICEOPS_V5_14_3_CONTACT_IDENTIFIER_REUSE_R1
         * An exact submitted identifier on a Contact already under the
         * resolved Customer is durable person evidence. Phone, Alt Phone,
         * and Email are all submitted identifiers. Changed/new identifiers
         * are enrichment targets, not automatic reasons to create a new Contact.
         */
        var requestEmailV5128=clean_(request['Normalized Email']);
        var requestPhoneV5128=clean_(request['Normalized Phone']);
        var onlyEmailV5128=normalizedCacheEmail_(only);
        var onlyPhoneV5128=normalizedCachePhone_(only);
        if(requestEmailV5128&&requestPhoneV5128&&requestEmailV5128===onlyEmailV5128&&requestPhoneV5128===onlyPhoneV5128){return matchedContact_(only,label+' + DUAL EXACT EMAIL PHONE WITHIN RESOLVED CUSTOMER');}
        var householdNameCompatibleV5143_=function(a,b){
          var an=householdPersonNames_(a),bn=householdPersonNames_(b);
          for(var ai=0;ai<an.length;ai++){
            for(var bi=0;bi<bn.length;bi++){
              if(simplePersonNameEqualV5105_(an[ai],bn[bi]))return true;
              if(minorPersonNameVariantV5125_(an[ai],bn[bi]))return true;
            }
          }
          return false;
        };
        if(householdNameCompatibleV5143_(requestPersonName_(request),clean_(only['Full Name']||only['Customer Name']))){
          return matchedContact_(only,label+' + EXACT SUBMITTED IDENTIFIER + HOUSEHOLD/PERSON NAME');
        }
        if (!requestPersonName_(request) || rowPersonNames_(only, false).some(function (name) {
          return samePersonName_(requestPersonName_(request), name);
        })) {
          return matchedContact_(only, label);
        }

        if (requestPersonName_(request) && rowPersonNames_(only, false).some(function (name) {
          return minorPersonNameVariantV5125_(requestPersonName_(request), name);
        })) {
          return matchedContact_(only, label + ' + MINOR NAME VARIANT');
        }

        if (nameCandidates.length === 1) {
          return matchedContact_(nameCandidates[0], 'NAME WITHIN RESOLVED CUSTOMER');
        }

        return {
          status: 'AMBIGUOUS', id: '', row: {}, action: 'REVIEW', method: label + ' + NAME CONFLICT',
          candidates: uniqueRows,
          reviewReason: 'Possible household Contact: the submitted ' + label.toLowerCase() +
            ' belongs to another Contact on this Customer, but the submitted name is different. Confirm existing Contact versus create a new Contact.'
        };
      }

      if (namedWithinSignal.length > 1) {
        return {
          status: 'AMBIGUOUS', id: '', row: {}, action: 'REVIEW', method: label + ' + MULTIPLE NAME MATCHES',
          candidates: namedWithinSignal,
          reviewReason: 'Multiple Contacts on the resolved Customer share the submitted identity and name.'
        };
      }

      return {
        status: 'AMBIGUOUS', id: '', row: {}, action: 'REVIEW', method: label, candidates: uniqueRows,
        reviewReason: 'Multiple Contacts matched the submitted ' + label.toLowerCase() + '.'
      };
    }

    if (request['Normalized Email']) {
      var emailResult = resultForSignal_('EMAIL', contacts.filter(function (row) {
        return request['Normalized Email'] === normalizedCacheEmail_(row);
      }));
      if (emailResult) return emailResult;
    }

    if (request['Normalized Phone']) {
      var primaryPhoneResult = resultForSignal_('PRIMARY PHONE', contacts.filter(function (row) {
        return request['Normalized Phone'] === normalizedCachePhone_(row);
      }));
      if (primaryPhoneResult) return primaryPhoneResult;
    }

    if (request['Normalized Alt Phone']) {
      var altPhoneResult = resultForSignal_('ALT PHONE', contacts.filter(function (row) {
        return request['Normalized Alt Phone'] === normalizedCachePhone_(row);
      }));
      if (altPhoneResult) return altPhoneResult;
    }

    // Within an already-resolved Customer, an exact person/household member
    // name is a safe fallback. Any newly submitted phone/email is subsequently
    // merged onto that same Contact by CustomerContactInfoSync.
    if (nameCandidates.length === 1) return matchedContact_(nameCandidates[0], 'NAME WITHIN RESOLVED CUSTOMER');
    if (nameCandidates.length > 1) {
      return {
        status: 'AMBIGUOUS', id: '', row: {}, action: 'REVIEW', method: 'MULTIPLE CONTACT NAME MATCHES',
        candidates: nameCandidates, reviewReason: 'Multiple Contacts on the resolved Customer have the submitted name.'
      };
    }

    return { status: 'NOT FOUND', id: '', row: {}, action: 'CREATE', method: '', candidates: [] };
  }

  /************************************************************
   * LOCATION MATCHING
   ************************************************************/

  function resolveLocation_(request, customerId, maps, selectedLocationId) {
    if (!customerId) return { status: 'NOT CHECKED', id: '', row: {}, action: 'CREATE' };

    var locations = maps.locationsByCustomer[String(customerId)] || [];
    selectedLocationId = clean_(selectedLocationId);
    if (selectedLocationId) {
      var selectedLocation = locations.filter(function (row) {
        return String(row['Location ID']) === String(selectedLocationId);
      })[0] || {};
      if (!selectedLocation['Location ID']) {
        throw new Error('Selected Location ' + selectedLocationId + ' does not belong to Customer ' + customerId + '.');
      }
      return {
        status: 'MATCHED', id: String(selectedLocationId), row: selectedLocation,
        action: 'LINK EXISTING', method: 'OPERATOR SELECTED LOCATION', candidates: []
      };
    }
    var requestAddress = request['Normalized Address'] || canonicalAddress_(request['Full Address']);

    // Rule 1: exact canonical full-address identity.
    var exact = locations.filter(function (row) {
      return requestAddress && requestAddress === normalizedCacheAddress_(row);
    });

    if (exact.length === 1) {
      return { status: 'MATCHED', id: String(exact[0]['Location ID']), row: exact[0], action: 'LINK EXISTING', method: 'CANONICAL ADDRESS' };
    }
    if (exact.length > 1) {
      return { status: 'AMBIGUOUS', id: '', row: {}, action: 'REVIEW', method: 'MULTIPLE CANONICAL ADDRESSES', candidates: exact };
    }

    // Rule 2: exact canonical street + exact postal code. This is still an
    // address identity match, not a fuzzy/possible match. It handles harmless
    // differences such as Avenue/Ave, Ontario/ON, punctuation and casing.
    var requestStreet = canonicalStreet_(request);
    var requestPostal = request['Normalized Postal'];
    var structured = locations.filter(function (row) {
      return requestStreet && requestPostal &&
        requestStreet === canonicalStreet_(row) &&
        requestPostal === normalizedCachePostal_(row);
    });

    if (structured.length === 1) {
      return { status: 'MATCHED', id: String(structured[0]['Location ID']), row: structured[0], action: 'LINK EXISTING', method: 'STREET + POSTAL' };
    }
    if (structured.length > 1) {
      return {
        status: 'AMBIGUOUS', id: '', row: {}, action: 'REVIEW', method: 'MULTIPLE EXACT ADDRESS IDENTITIES', candidates: structured,
        reviewReason: 'Blocked location match. Why: multiple Locations on the resolved Customer have the same street/postal identity. Correct: select the exact service Location.'
      };
    }

    // Rule 3: same resolved Customer + exact street/city may safely reuse an
    // incomplete historical Location. Blank and obvious placeholder postals are
    // incomplete data, not a conflicting address. A real conflicting postal is
    // never ignored.
    var requestCity = canonicalCity_(request);
    var streetCityIncompletePostal = locations.filter(function (row) {
      return requestStreet && requestCity &&
        requestStreet === canonicalStreet_(row) &&
        requestCity === canonicalCity_(row) &&
        postalMissingOrPlaceholderV5137_(row);
    });
    if (streetCityIncompletePostal.length === 1) {
      return {
        status: 'MATCHED', id: String(streetCityIncompletePostal[0]['Location ID']), row: streetCityIncompletePostal[0],
        action: 'LINK EXISTING', method: 'STREET + CITY (STRIVEN POSTAL INCOMPLETE)'
      };
    }
    if (streetCityIncompletePostal.length > 1) {
      var primaryNamed = streetCityIncompletePostal.filter(function (row) {
        return clean_(row['Location Name']).toUpperCase() === 'PRIMARY LOCATION';
      });
      if (primaryNamed.length === 1) {
        return {
          status: 'MATCHED', id: String(primaryNamed[0]['Location ID']), row: primaryNamed[0],
          action: 'LINK EXISTING', method: 'STREET + CITY + PRIMARY LOCATION (STRIVEN POSTAL INCOMPLETE)'
        };
      }
      return {
        status: 'AMBIGUOUS', id: '', row: {}, action: 'REVIEW', method: 'MULTIPLE STREET + CITY LOCATIONS WITH INCOMPLETE POSTAL',
        candidates: streetCityIncompletePostal,
        reviewReason: 'Multiple same-premises Locations have incomplete postal data and no unique Primary Location. Select the correct service Location; do not create another one.'
      };
    }

    // IMPORTANT: no POSTAL-ONLY and no fuzzy location link. If exact address
    // identity and the safe missing-postal fallback both fail, create/review a
    // new Location according to the existing workflow.
    return { status: 'NOT FOUND', id: '', row: {}, action: 'CREATE', method: 'NO EXACT ADDRESS IDENTITY' };
  }

  /************************************************************
   * HISTORY / DUPLICATE RISK
   ************************************************************/

  function statusState_(status) {
    var clean = clean_(status).toUpperCase();
    if (!clean) return 'UNKNOWN';
    if (/COMPLETED|CLOSED|CANCELLED|VOID|INVOICED/.test(clean)) return 'CLOSED';
    if (/APPROVED|IN PROGRESS|OPEN|SCHEDULED|ASSIGNED|QUOTED|PENDING/.test(clean)) return 'ACTIVE';
    return 'UNKNOWN';
  }

  function sameLocation_(row, location, request) {
    var d = deps_();
    if (location.id && row['Location ID']) return String(location.id) === String(row['Location ID']);
    if (row['Service Address'] && request['Normalized Address']) {
      return canonicalAddress_(row['Service Address']) === request['Normalized Address'];
    }
    return false;
  }

  function history_(request, customerId, location, maps) {
    var rows = customerId ? (maps.operationalByCustomer[String(customerId)] || []) : [];
    var assets = rows.filter(function (row) { return row['Entity Type'] === 'ASSET'; });
    var workOrders = rows.filter(function (row) { return row['Entity Type'] === 'WORK_ORDER'; });
    var tasks = rows.filter(function (row) {
      return row['Entity Type'] === 'TASK_RELATIONSHIP' || row['Entity Type'] === 'TASK';
    });
    var activeRows = rows.filter(function (row) {
      return (row['Entity Type'] === 'WORK_ORDER' || row['Entity Type'] === 'TASK_RELATIONSHIP' || row['Entity Type'] === 'TASK') &&
        statusState_(row['Status']) === 'ACTIVE';
    });
    var sameLocationActive = activeRows.filter(function (row) {
      return sameLocation_(row, location, request);
    });

    var risk = 'NONE';
    var reason = '';
    // IDENTITY_FIRST_CREATE_BY_DEFAULT_V1
    //
    // Customer-wide active work is not a duplicate blocker.
    // Only active work tied to the SAME service location/address blocks.
    //
    // If the Customer exists but the submitted address does not match one
    // of that Customer's cached Locations, workflow treats the address as
    // a new Location and proceeds to READY FOR LOCATION CREATE.
    if (sameLocationActive.length) {
      risk = 'HIGH';
      reason = 'Existing active Work Order or Task found at the service location.';
    }

    var serviceRows = workOrders.concat(tasks).sort(function (a, b) {
      return new Date(b['Completed At'] || b['Scheduled Date'] || b['Created At'] || 0).getTime() -
        new Date(a['Completed At'] || a['Scheduled Date'] || a['Created At'] || 0).getTime();
    });

    var last = serviceRows[0] || {};
    return {
      rows: rows,
      assets: assets,
      workOrders: workOrders,
      tasks: tasks,
      activeRows: activeRows,
      sameLocationActive: sameLocationActive,
      duplicateRisk: risk,
      duplicateReason: reason,
      last: last
    };
  }

  /************************************************************
   * PLAN / PATCH
   ************************************************************/

  function buildPlan_(customer, contact, location, history) {
    var reviewReasons = [];

    if (customer.status === 'AMBIGUOUS' ||
        customer.status === 'MISSING INFORMATION') {
      reviewReasons.push(customer.reviewReason || 'Customer resolution requires operator review.');
    }
    if (contact.status === 'AMBIGUOUS') reviewReasons.push(contact.reviewReason || 'Contact resolution requires operator review.');
    if (location.status === 'AMBIGUOUS') {
      reviewReasons.push(location.reviewReason || 'Location resolution requires operator review. Correct: verify/select the service Location.');
    }
    // Only a same-location HIGH duplicate risk blocks the workflow.
    // Customer-wide activity elsewhere is informational and must not force review.
    if (history.duplicateRisk === 'HIGH') reviewReasons.push(history.duplicateReason);

    // IMPORTANT: LINK EXISTING below is a SYSTEM RESOLUTION OUTCOME, not an
    // operator action. MATCHED IDs are immediately written to Service Requests.
    var customerAction = customer.status === 'MATCHED'
      ? 'LINK EXISTING'
      : (customer.status === 'NOT FOUND' ? 'CREATE' : 'REVIEW');
    var contactAction = customerAction === 'CREATE' ? 'CREATE' : contact.action;
    var locationAction = customerAction === 'CREATE' ? 'CREATE' : location.action;

    return {
      customerAction: customerAction,
      contactAction: contactAction,
      locationAction: locationAction,
      workOrderAction: reviewReasons.length ? 'REVIEW' : 'CREATE',
      requiresReview: reviewReasons.length > 0,
      reviewReasons: reviewReasons,
      duplicateRisk: history.duplicateRisk,
      duplicateReason: history.duplicateReason
    };
  }

  function nextAction_(customer, contact, location, history, plan) {
    if (customer.status === 'AMBIGUOUS' || customer.status === 'MISSING INFORMATION') {
      return 'REVIEW CUSTOMER MATCH';
    }
    if (contact.status === 'AMBIGUOUS') return 'REVIEW CONTACT MATCH';
    if (location.status === 'AMBIGUOUS') return 'REVIEW LOCATION MATCH';
    if (history.duplicateRisk === 'HIGH') return 'REVIEW ACTIVE WORK / DUPLICATE RISK';

    if (plan.customerAction === 'CREATE') return 'APPROVE PROPOSED ACTION — CREATE CUSTOMER';
    if (plan.contactAction === 'CREATE') return 'APPROVE PROPOSED ACTION — CREATE CONTACT';
    if (plan.locationAction === 'CREATE') return 'APPROVE PROPOSED ACTION — CREATE LOCATION';

    return 'CUSTOMER STRUCTURE RESOLVED';
  }

  function manualSelections_(request) {
    var evidence = deps_().util.parseJson(request && request['Match Evidence JSON'], {});
    var selections = evidence.manualSelections || {};
    return {
      customerId: clean_(selections.customerId),
      contactId: clean_(selections.contactId),
      locationId: clean_(selections.locationId)
    };
  }

  function evaluate_(request, maps, selections) {
    selections = selections || manualSelections_(request);
    var customer = resolveCustomer_(request, maps, selections.customerId);
    var contact = resolveContact_(request, customer.id, maps, selections.contactId);
    var location = resolveLocation_(request, customer.id, maps, selections.locationId);
    var history = history_(request, customer.id, location, maps);
    var plan = buildPlan_(customer, contact, location, history);
    return {
      request: request,
      customer: customer,
      contact: contact,
      location: location,
      history: history,
      plan: plan,
      manualSelections: selections
    };
  }

  function reviewCorrection_(customer, contact, location, history) {
    if (customer.status === 'AMBIGUOUS' || customer.status === 'MISSING INFORMATION') {
      return 'Correct customer identity: verify phone/email/address, or select the correct existing Customer.';
    }
    if (contact.status === 'AMBIGUOUS') {
      return 'Correct contact identity under the resolved Customer: select the existing Contact or confirm that a new Contact should be created.';
    }
    if (location.status === 'AMBIGUOUS') {
      return 'Correct the service address or select the exact existing Location under the resolved Customer.';
    }
    if (history.duplicateRisk === 'HIGH') {
      return 'Review the existing active work at this service Location; link/use the existing work if it is the same request, otherwise confirm it is separate.';
    }
    return 'Review the evidence shown and correct the blocking field before continuing.';
  }

  function patch_(evaluation) {
    var d = deps_();
    var customer = evaluation.customer;
    var contact = evaluation.contact;
    var location = evaluation.location;
    var history = evaluation.history;
    var plan = evaluation.plan;

    var stage = plan.requiresReview ? 'NEEDS REVIEW' :
      (plan.customerAction === 'CREATE' ? 'READY FOR CUSTOMER CREATE' :
        (plan.contactAction === 'CREATE' ? 'READY FOR CONTACT CREATE' :
          (plan.locationAction === 'CREATE' ? 'READY FOR LOCATION CREATE' : 'CUSTOMER RESOLVED')));

    var reviewReason = plan.reviewReasons.join('; ');

    return {
      'Updated At': d.util.nowString(),
      'Current Stage': stage,
      'Request Status': plan.requiresReview ? 'BLOCKED' : 'OPEN',
      'Manual Review?': plan.requiresReview ? 'YES' : 'NO',
      'Manual Review Reason': reviewReason,
      'Blocking Issue': plan.requiresReview ? reviewCorrection_(customer, contact, location, history) : '',
      'Duplicate Risk Status': plan.duplicateRisk,
      'Duplicate Risk Reason': plan.duplicateReason,
      'Next Action': nextAction_(customer, contact, location, history, plan),
      // Confident matches are system-linked automatically. Clear any stale
      // LINK EXISTING / approval selection left from the old manual workflow.
      'Operator Action': '',

      'Customer Match Status': customer.status,
      'Matched Customer ID': customer.id,
      'Matched Customer Name': customer.row['Customer Name'] || customer.row['Full Name'] || '',

      'Contact Match Status': contact.status,
      'Matched Contact ID': contact.id,
      'Matched Contact Name': contact.row['Full Name'] || '',

      'Location Match Status': location.status,
      'Matched Location ID': location.status === 'MATCHED' ? location.id : '',
      'Matched Location Address': location.row['Full Address'] || '',

      'Match Confidence': customer.confidence,
      'Match Score': customer.score,
      'Match Method': [customer.method, contact.method, location.method].filter(Boolean).join(' + '),
      'Match Evidence JSON': d.util.safeJson({
        customerCandidates: customer.candidates,
        customerReasons: customer.reasons,
        customerConflicts: customer.conflicts,
        customerContactEvidence: customer.contactEvidence || [],
        customerNameEvidence: customer.nameEvidence || {},
        contactCandidates: contact.candidates || [],
        locationCandidates: location.candidates || [],
        manualSelections: evaluation.manualSelections || {}
      }),

      'History Enrichment Status': history.rows.length ? 'READY' : 'NO HISTORY',
      'Purchased From Us?': customer.id ? (history.assets.length ? 'YES' : 'NO') : '',
      'Customer Asset Count': history.assets.length,
      'Customer Assets Summary': history.assets.map(function (row) {
        return [row['Asset Make'], row['Asset Model'], row['Serial Number']].filter(Boolean).join(' ');
      }).filter(Boolean).join(' | '),
      'Last Service Date': history.last['Completed At'] || history.last['Scheduled Date'] || history.last['Created At'] || '',
      'Last Service Technician': history.last['Technician'] || '',
      'Last Service Summary': history.last['Description'] || history.last['Task Name'] || history.last['Work Order Name'] || '',
      'Active Work Summary': history.sameLocationActive.map(function (row) {
        return [row['Work Order Number'], row['Task Name'], row['Status']].filter(Boolean).join(' · ');
      }).join(' | '),
      'Active Work JSON': d.util.safeJson({
        activeAtLocation: history.sameLocationActive,
        activeForCustomer: history.activeRows
      }),

      'Customer Action': plan.customerAction,
      'Contact Action': plan.contactAction,
      'Location Action': plan.locationAction,
      'Work Order Action': plan.workOrderAction,
      'Customer Structure Status': (!plan.requiresReview &&
        plan.customerAction === 'LINK EXISTING' &&
        plan.contactAction === 'LINK EXISTING' &&
        plan.locationAction === 'LINK EXISTING') ? 'RESOLVED' :
        ((customer.id || contact.id || location.id) ? 'IN PROGRESS' : 'NOT STARTED'),
      'Transaction Plan JSON': d.util.safeJson(plan),
      'Transaction Fingerprint': d.util.canonicalHash(plan),
      'Striven Sync Status': 'NOT SYNCED',
      'Reconciliation Status': 'NOT STARTED'
    };
  }

  function mergePatch_(base, extra) {
    var out = {};
    Object.keys(base || {}).forEach(function (key) { out[key] = base[key]; });
    Object.keys(extra || {}).forEach(function (key) { out[key] = extra[key]; });
    return out;
  }

  function compact_(evaluation, patch, repaired) {
    return {
      requestId: evaluation.request['Request ID'],
      rowNumber: evaluation.request.__rowNumber,
      repairedLegacyLinkage: repaired === true,
      stage: patch['Current Stage'],
      manualReview: patch['Manual Review?'],
      customer: {
        status: evaluation.customer.status,
        id: evaluation.customer.id,
        action: evaluation.plan.customerAction
      },
      contact: {
        status: evaluation.contact.status,
        id: evaluation.contact.id,
        action: evaluation.plan.contactAction
      },
      location: {
        status: evaluation.location.status,
        id: evaluation.location.id,
        action: evaluation.plan.locationAction
      },
      score: evaluation.customer.score,
      method: evaluation.customer.method,
      duplicateRisk: evaluation.plan.duplicateRisk,
      reason: patch['Manual Review Reason'],
      autoLinked: {
        customer: evaluation.customer.status === 'MATCHED' && !!evaluation.customer.id,
        contact: evaluation.contact.status === 'MATCHED' && !!evaluation.contact.id,
        location: evaluation.location.status === 'MATCHED' && !!evaluation.location.id
      }
    };
  }

  function evidenceCandidateIds_(row, entityType) {
    var d = deps_();
    var evidence = d.util.parseJson(row && row['Match Evidence JSON'], {});
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

  function resolveCandidate(requestId, entityType, entityId) {
    var d = deps_();
    entityType = clean_(entityType).toLowerCase();
    entityId = clean_(entityId);
    if (['customer','contact','location'].indexOf(entityType) === -1) throw new Error('Unsupported candidate entity: ' + entityType);
    if (!entityId) throw new Error('Candidate ID is required.');

    return d.util.withScriptLock(function () {
      var readiness = d.data.inspectReadiness();
      if (!readiness.ok) throw new Error('Striven matching caches are not ready.');

      var row = d.util.findRecord('SERVICE_REQUESTS', 'Request ID', requestId);
      if (!row) throw new Error('Service Request not found: ' + requestId);
      if (terminal_(row)) throw new Error('Terminal requests cannot be changed.');

      var statusField = entityType === 'customer' ? 'Customer Match Status' :
        (entityType === 'contact' ? 'Contact Match Status' : 'Location Match Status');
      if (upper_(row[statusField]) !== 'AMBIGUOUS') {
        throw new Error('The ' + entityType + ' is no longer ambiguous. Refresh the Operator Queue.');
      }

      var allowedIds = evidenceCandidateIds_(row, entityType);
      if (allowedIds.indexOf(entityId) === -1) {
        throw new Error('Candidate ' + entityId + ' is not one of the current ' + entityType + ' candidates.');
      }

      var evidence = d.util.parseJson(row['Match Evidence JSON'], {});
      var selections = evidence.manualSelections || {};
      if (entityType === 'customer') {
        if (clean_(selections.customerId) !== entityId) {
          selections.contactId = '';
          selections.locationId = '';
        }
        selections.customerId = entityId;
      } else if (entityType === 'contact') {
        selections.contactId = entityId;
      } else {
        selections.locationId = entityId;
      }

      var maps = d.data.getLookupMaps();
      ensureIdentityIndexes_(maps);
      var request = prepareRequest_(row);
      var evaluation = evaluate_(request, maps, selections);
      var patch = mergePatch_(normalizationPatch_(request), patch_(evaluation));
      d.util.patchRow('SERVICE_REQUESTS', row.__rowNumber, patch);

      d.util.logEvent({
        module: MODULE_NAME,
        action: 'RESOLVE_AMBIGUOUS_CANDIDATE',
        status: 'COMPLETE',
        requestId: requestId,
        details: { entityType: entityType, entityId: entityId, resultingStage: patch['Current Stage'] },
        version: VERSION
      });

      if (CF.OperatorQueue && typeof CF.OperatorQueue.refresh === 'function') CF.OperatorQueue.refresh();

      return {
        ok: true,
        version: VERSION,
        requestId: requestId,
        selectedEntity: entityType.toUpperCase(),
        selectedId: entityId,
        stage: patch['Current Stage'],
        customer: { status: evaluation.customer.status, id: evaluation.customer.id },
        contact: { status: evaluation.contact.status, id: evaluation.contact.id },
        location: { status: evaluation.location.status, id: evaluation.location.id },
        nextAction: patch['Next Action'],
        manualReview: patch['Manual Review?']
      };
    });
  }

  /************************************************************
   * ROW SELECTION
   ************************************************************/

  function terminal_(row) {
    var d = deps_();
    return d.config.isTerminalState(row['Final Outcome']) || d.config.isTerminalState(row['Current Stage']);
  }

  function manualOverride_(row) {
    var action = upper_(row['Operator Action']);
    if (!action) return false;

    // These are legacy selections from the old manual-link workflow. They do
    // not block automatic matching and will be cleared by patch_().
    if (action === 'LINK EXISTING CUSTOMER' ||
        action === 'LINK EXISTING CONTACT' ||
        action === 'LINK EXISTING LOCATION' ||
        action === 'APPROVE PROPOSED ACTION') return false;

    // Explicit exception decisions such as CREATE / CANCEL / DUPLICATE should
    // not be silently overwritten by the matcher.
    return true;
  }

  function correctiveContactBridgeEligible_(row, maps) {
    if (terminal_(row)) return false;

    var stage = upper_(row['Current Stage']);
    var customerStatus = upper_(row['Customer Match Status']);

    if (stage !== 'READY FOR CUSTOMER CREATE' || customerStatus !== 'NOT FOUND') return false;
    if (clean_(row['Created Customer ID'])) return false;

    var prepared = prepareRequest_(row);
    return contactBridgeCustomers_(prepared, maps).length > 0;
  }

  function malformedEligible_(row) {
    if (terminal_(row)) return false;

    var stage = upper_(row['Current Stage']);
    var customerStatus = upper_(row['Customer Match Status']);
    var hasIdentity = clean_(row['Phone']) || clean_(row['Alt Phone']) || clean_(row['Email']) ||
      clean_(row['Full Address']) || clean_(row['Street']);

    if (!hasIdentity) return false;
    if (!customerStatus || customerStatus === 'NOT CHECKED') return true;
    if (!clean_(row['Request ID']) && customerStatus !== 'MATCHED') return true;
    if (!stage) return true;

    return false;
  }

  function autoMatchEligible_(row, maps, options) {
    options = options || {};

    if (terminal_(row)) return false;
    if (manualOverride_(row)) return false;
    if (clean_(row['Approved By']) || clean_(row['Approved At'])) return false;

    var stage = upper_(row['Current Stage']);
    var customerStatus = upper_(row['Customer Match Status']);
    var contactStatus = upper_(row['Contact Match Status']);
    var locationStatus = upper_(row['Location Match Status']);
    var hasIdentity = clean_(row['Phone']) || clean_(row['Alt Phone']) || clean_(row['Email']) ||
      clean_(row['Full Address']) || clean_(row['Street']);

    if (!hasIdentity) return false;

    if (options.onlyReview === true) return stage === 'NEEDS REVIEW';

    // Always evaluate new intake and review rows. A review row can become fully
    // resolved automatically after better normalization/cache evidence appears.
    if (stage === 'NEW INTAKE' || stage === 'NEEDS REVIEW' || !stage) return true;

    // Repair legacy rows with missing matching state/linkage.
    if (malformedEligible_(row)) return true;

    // Re-check a false NEW classification only when Contact evidence points to
    // an existing Striven Customer. Legitimate new Customers are left alone.
    if (correctiveContactBridgeEligible_(row, maps)) return true;

    // Continue the automatic chain for existing Customers when Contact or
    // Location has not yet been resolved.
    if (customerStatus === 'MATCHED') {
      if (!contactStatus || contactStatus === 'NOT CHECKED') return true;
      if (!locationStatus || locationStatus === 'NOT CHECKED') return true;
      if (stage === 'READY FOR CONTACT CREATE' && !clean_(row['Created Contact ID'])) return true;
      if (stage === 'READY FOR LOCATION CREATE' && !clean_(row['Created Location ID'])) return true;
      if (stage === 'CUSTOMER RESOLVED' &&
          (contactStatus !== 'MATCHED' || locationStatus !== 'MATCHED')) return true;
    }

    return false;
  }

  function selectRows_(allRows, options, maps) {
    options = options || {};
    /* CF_SERVICEOPS_V5_10_30_TARGETED_MATCHING_R1 — existing targeted implementation retained */
    /* CF_SERVICEOPS_V5_10_29_TARGETED_MATCHING_FAST_PATH_R4 */
    var targetedRequestIdsProvided = Array.isArray(options.requestIds);
    var targetedRequestIds = {};
    (options.requestIds || []).forEach(function (requestId) {
      var id = clean_(requestId);
      if (id) targetedRequestIds[id] = true;
    });

    return (allRows || []).filter(function (row) {
      if (targetedRequestIdsProvided && !targetedRequestIds[clean_(row['Request ID'])]) return false;
      return autoMatchEligible_(row, maps, options);
    }).sort(function (a, b) {
      // Newest submissions first, consistent with Operator Queue.
      var aTime = dateMs_(a['Submitted At']);
      var bTime = dateMs_(b['Submitted At']);
      return bTime - aTime;
    });
  }

  /************************************************************
   * RUNNER
   ************************************************************/

  function run(options) {
    options = options || {};
    var d = deps_();

    return d.util.withScriptLock(function () {
      var started = Date.now();
      var readiness = d.data.inspectReadiness();

      if (!readiness.ok) {
        return {
          ok: false,
          status: 'BLOCKED',
          blockers: ['Striven matching caches are not ready.'],
          readiness: readiness
        };
      }

      var maps = d.data.getLookupMaps();
      ensureIdentityIndexes_(maps);
      var allRows = d.util.readRecords('SERVICE_REQUESTS');
      var webforms = d.util.readRecords('WEBFORM_REQUESTS');
      var rows = selectRows_(allRows, options, maps);
      var selected = [];

      for (var i = 0; i < rows.length; i++) {
        if (Date.now() - started > Number(d.config.getDefault('MAX_RUNTIME_MS'))) break;

        var request = prepareRequest_(rows[i]);
        var repair = repairRequestIdentity_(request, webforms, options.preview !== true);
        request = prepareRequest_(repair.request);

        var evaluation = evaluate_(request, maps);
        var patch = mergePatch_(normalizationPatch_(request), patch_(evaluation));

        if (options.preview !== true) {
          d.util.patchRow('SERVICE_REQUESTS', request.__rowNumber, patch);
        }

        selected.push(compact_(evaluation, patch, repair.repaired));
      }

      if (options.preview !== true && selected.length && options.refreshQueue !== false && CF.OperatorQueue && typeof CF.OperatorQueue.refresh === 'function') {
        CF.OperatorQueue.refresh();
      }

      var summary = {
        stages: {},
        manualReview: 0,
        duplicateRisks: {},
        repairedLegacyLinkage: 0,
        autoLinkedCustomers: 0,
        autoLinkedContacts: 0,
        autoLinkedLocations: 0
      };
      selected.forEach(function (row) {
        summary.stages[row.stage] = (summary.stages[row.stage] || 0) + 1;
        summary.duplicateRisks[row.duplicateRisk] = (summary.duplicateRisks[row.duplicateRisk] || 0) + 1;
        if (row.manualReview === 'YES') summary.manualReview++;
        if (row.repairedLegacyLinkage) summary.repairedLegacyLinkage++;
        if (row.autoLinked && row.autoLinked.customer) summary.autoLinkedCustomers++;
        if (row.autoLinked && row.autoLinked.contact) summary.autoLinkedContacts++;
        if (row.autoLinked && row.autoLinked.location) summary.autoLinkedLocations++;
      });

      var result = {
        ok: true,
        status: 'COMPLETE',
        preview: options.preview === true,
        eligibleRowsFound: rows.length,
        selected: selected.length,
        remaining: Math.max(0, rows.length - selected.length),
        summary: summary,
        performance: {
          algorithm: 'PERSON_FIRST_HOUSEHOLD_AWARE_NAME_DISAMBIGUATION',
          cacheSheetsRead: 3,
          lookupMapsBuilt: 1,
          totalMs: Date.now() - started
        },
        results: selected
      };

      d.util.logEvent({
        module: MODULE_NAME,
        action: options.preview === true ? 'PREVIEW' : 'PROCESS',
        status: 'COMPLETE',
        details: {
          selected: result.selected,
          remaining: result.remaining,
          summary: summary
        },
        durationMs: result.performance.totalMs,
        version: VERSION
      });

      return result;
    });
  }

  // PHASE5B_CONTROLLED_CUSTOMER_PREFLIGHT_V1
  function recheckRequest(requestIdOrRow, options) {
    options = options || {};

    var d = deps_();
    var record = null;

    if (
      typeof requestIdOrRow ===
      'number'
    ) {
      var allRows =
        d.util.readRecords(
          'SERVICE_REQUESTS'
        );

      for (
        var i = 0;
        i < allRows.length;
        i++
      ) {
        if (
          allRows[i].__rowNumber ===
          requestIdOrRow
        ) {
          record = allRows[i];
          break;
        }
      }
    } else {
      record =
        d.util.findRecord(
          'SERVICE_REQUESTS',
          'Request ID',
          requestIdOrRow
        );
    }

    if (!record) {
      throw new Error(
        'Service Request not found for matching recheck.'
      );
    }

    var readiness =
      d.data.inspectReadiness();

    if (!readiness.ok) {
      return {
        ok: false,
        status: 'BLOCKED',
        requestId:
          record['Request ID'],
        reason:
          'Striven matching caches are not ready.',
        readiness:
          readiness
      };
    }

    var maps =
      d.data.getLookupMaps();

    var evaluation =
      evaluate_(
        record,
        maps
      );

    var patch =
      patch_(
        evaluation
      );

    if (
      options.persist !==
      false
    ) {
      d.util.patchRow(
        'SERVICE_REQUESTS',
        record.__rowNumber,
        patch
      );
    }

    return {
      ok: true,
      status:
        'RECHECK_COMPLETE',
      preview:
        options.persist ===
        false,
      requestId:
        record['Request ID'],
      rowNumber:
        record.__rowNumber,
      result:
        compact_(
          evaluation,
          patch
        ),
      patch:
        patch
    };
  }

  function inspectState() {
    var d = deps_();
    var rows = d.util.readRecords('SERVICE_REQUESTS');
    var stages = {};
    var malformed = 0;

    rows.forEach(function (row) {
      var stage = row['Current Stage'] || 'BLANK';
      stages[stage] = (stages[stage] || 0) + 1;
      if (malformedEligible_(row)) malformed++;
    });

    return {
      ok: true,
      version: VERSION,
      serviceRequestRows: rows.length,
      stageCounts: stages,
      pendingNewIntake: stages['NEW INTAKE'] || 0,
      needsReview: stages['NEEDS REVIEW'] || 0,
      malformedUnmatchedRows: malformed
    };
  }

  return {
    version: VERSION,
    previewAll: function () { return run({ preview: true, repairMalformed: true }); },
    processRequestIds: function (requestIds, options) {
      options = options || {};
      var targeted = Array.isArray(requestIds) ? requestIds.slice() : [];
      var runOptions = {};
      Object.keys(options).forEach(function (key) { runOptions[key] = options[key]; });
      runOptions.preview = false;
      runOptions.repairMalformed = true;
      runOptions.requestIds = targeted;
      runOptions.refreshQueue = false;
      return run(runOptions);
    },
    processAll: function () { return run({ preview: false, repairMalformed: true }); },
    processReview: function () { return run({ preview: false, onlyReview: true, repairMalformed: true }); },
    resolveCandidate: resolveCandidate,
    recheckRequest: recheckRequest,
    inspectState: inspectState
  };
})();
