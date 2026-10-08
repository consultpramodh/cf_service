/* CF_SERVICEOPS_V5_13_3_INTAKE_API_BRAKE_R1 */
/*******************************************************
 * APPS SCRIPT — 20_Intake_Processing.gs
 * CF ServiceOps — Fast Webhook Intake + GF Reconciliation
 * Version: 5.14.4
 *
 * DESIGN:
 * - Webhook path is intentionally short.
 * - Submission ID is the primary idempotency key.
 * - Payload Hash is only a fallback when Submission ID is absent.
 * - No Operator Queue refresh occurs inside doPost().
 * - No System Log sheet write occurs inside successful doPost().
 * - Gravity Forms REST reconciliation can backfill missing
 *   Webform Requests and/or Service Requests.
 *
 * RECONCILIATION SCRIPT PROPERTIES:
 *
 * REQUIRED:
 *   GRAVITY_FORMS_CONSUMER_KEY
 *   GRAVITY_FORMS_CONSUMER_SECRET
 *
 * OPTIONAL:
 *   GRAVITY_FORMS_BASE_URL
 *     default: https://www.classicfireplace.ca
 *
 *   GRAVITY_FORMS_SERVICE_FORM_ID
 *     default: 2
 *
 *   GRAVITY_FORMS_SERVICE_FORM_TITLE
 *     default: Service Request
 *******************************************************/

var CF = CF || {};

CF.Intake = (function () {
  'use strict';

  var MODULE_NAME = '20_Intake_Processing';
  var VERSION = '5.14.4';

  var GF_DEFAULT_BASE_URL = 'https://www.classicfireplace.ca';
  var GF_DEFAULT_FORM_ID = '2';
  var GF_DEFAULT_FORM_TITLE = 'Service Request';

  var GF_PAGE_SIZE = 100;
  var GF_MAX_PAGES = 100;

  var RECONCILE_RUNTIME_LIMIT_MS = 240000;
  var RECONCILE_MAX_WRITES = 100;

  /*******************************************************
   * WEBFORM FIELD ALIASES
   *******************************************************/

  var ALIASES = {
    SUBMISSION_ID: [
      'submission_id',
      'submissionId',
      'entry_id',
      'gf_entry_id',
      'id'
    ],

    FORM_ID: [
      'form_id',
      'formId',
      'gf_form_id'
    ],

    FORM_TITLE: [
      'form_title',
      'formTitle',
      'gf_form_title'
    ],

    FIRST_NAME: [
      'first_name',
      'firstname',
      'name.first',
      'customer.first_name',
      'First Name'
    ],

    LAST_NAME: [
      'last_name',
      'lastname',
      'name.last',
      'customer.last_name',
      'Last Name'
    ],

    FULL_NAME: [
      'full_name',
      'fullName',
      'name',
      'Full Name'
    ],

    PHONE: [
      'phone',
      'telephone',
      'phone_number',
      'Phone'
    ],

    ALT_PHONE: [
      'alt_phone',
      'alternate_phone',
      'secondary_phone',
      'Alt Phone'
    ],

    EMAIL: [
      'email',
      'email_address',
      'Email'
    ],

    STREET: [
      'street',
      'address',
      'address_1',
      'address1',
      'Street'
    ],

    CITY: [
      'city',
      'City'
    ],

    PROVINCE: [
      'province',
      'state',
      'Province'
    ],

    POSTAL: [
      'postal_code',
      'postalCode',
      'postcode',
      'zip',
      'Postal Code'
    ],

    COUNTRY: [
      'country',
      'Country'
    ],

    PREFERRED_DAYS: [
      'preferred_days',
      'preferredDays',
      'Preferred Days'
    ],

    UNIT_DETAILS: [
      'make_model_age',
      'makeModelAge',
      'Make/Model/Age',
      'unit_details'
    ],

    SERVICE_DETAILS: [
      'details',
      'service_details',
      'serviceDetails',
      'Details'
    ],

    ADDITIONAL_NOTES: [
      'anything_else',
      'anythingElse',
      'notes',
      'Anything Else'
    ],

    CAMPAIGN_CODE: [
      'campaign_code',
      'campaignCode',
      'campaign',
      'Campaign Code'
    ],

    SUBMITTED_AT: [
      'submitted_at',
      'submittedAt',
      'submission_timestamp',
      'date_created'
    ],

    CORRELATION_ID: [
      'correlation_id',
      'correlationId',
      'Correlation ID'
    ]
  };

  var ATTRIBUTION_KEYS = [
    'campaign_name',
    'campaign_year',

    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_id',
    'utm_content',
    'utm_term',

    'first_utm_source',
    'first_utm_medium',
    'first_utm_campaign',
    'first_utm_id',
    'first_utm_content',
    'first_utm_term',

    'current_utm_source',
    'current_utm_medium',
    'current_utm_campaign',
    'current_utm_id',
    'current_utm_content',
    'current_utm_term',

    'cf_campaign',
    'cf_send',
    'cf_offer',
    'cf_landing',

    'first_cf_campaign',
    'first_cf_send',
    'first_cf_offer',
    'first_cf_landing',

    'current_cf_campaign',
    'current_cf_send',
    'current_cf_offer',
    'current_cf_landing',

    'traffic_channel',
    'landing_page',
    'source_url',

    'referral_source',
    'referral_code',

    'gclid',
    'fbclid',
    'msclkid',

    'contact_consent',
    'attribution_timestamp',
    'form_version'
  ];

  /*******************************************************
   * WEBHOOK SECRET ALIASES
   *******************************************************/

  var SECRET_FIELD_NAMES = [
    'secret',
    'shared_secret',
    'webhook_secret',
    'webform_shared_secret',

    'service_webhook_secret',
    'SERVICE_WEBHOOK_SECRET',

    'serviceops_webhook_secret',
    'serviceops_secret',
    'serviceOpsSecret',

    'x_serviceops_secret',
    'x-serviceops-secret',

    'authorization',
    'token'
  ];

  /*******************************************************
   * FOUNDATION
   *******************************************************/

  function deps_() {
    if (!CF.Config || !CF.Util) {
      throw new Error(
        'CF.Config and CF.Util are required.'
      );
    }

    return {
      config: CF.Config,
      util: CF.Util
    };
  }

  function clean_(value) {
    return value === null || value === undefined
      ? ''
      : String(value).trim();
  }

  /*******************************************************
   * WEB APP REQUEST PARSING
   *******************************************************/

  function parseEvent_(event) {
    var d = deps_();

    var raw =
      event && event.postData
        ? event.postData.contents || ''
        : '';

    var payload = {};

    if (raw) {
      payload = d.util.parseJson(
        raw,
        null
      );

      if (!payload) {
        payload = {};

        raw.split('&').forEach(function (part) {
          var pieces = part.split('=');

          var key = decodeURIComponent(
            (pieces.shift() || '')
              .replace(/\+/g, ' ')
          );

          var value = decodeURIComponent(
            pieces.join('=')
              .replace(/\+/g, ' ')
          );

          if (key) {
            payload[key] = value;
          }
        });
      }
    }

    Object.keys(
      (event && event.parameter) || {}
    ).forEach(function (key) {
      if (payload[key] === undefined) {
        payload[key] =
          event.parameter[key];
      }
    });

    return {
      payload: payload || {},
      raw:
        raw ||
        d.util.safeJson(
          payload || {}
        )
    };
  }

  /*******************************************************
   * WEBHOOK AUTHENTICATION
   *******************************************************/

  function normalizeSecretFieldName_(value) {
    return String(
      value === null ||
      value === undefined
        ? ''
        : value
    )
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  function normalizeSecretValue_(value) {
    return String(
      value === null ||
      value === undefined
        ? ''
        : value
    )
      .trim()
      .replace(/^Bearer\s+/i, '')
      .trim();
  }

  function findSecretInObject_(obj) {
    var d = deps_();

    if (
      !obj ||
      typeof obj !== 'object'
    ) {
      return '';
    }

    var accepted = {};

    SECRET_FIELD_NAMES.forEach(
      function (name) {
        accepted[
          normalizeSecretFieldName_(name)
        ] = true;
      }
    );

    var flat;

    try {
      flat =
        d.util.flattenObject(
          obj || {}
        );
    } catch (error) {
      flat = obj || {};
    }

    var keys =
      Object.keys(flat || {});

    for (
      var i = 0;
      i < keys.length;
      i++
    ) {
      var key = keys[i];

      if (
        !accepted[
          normalizeSecretFieldName_(key)
        ]
      ) {
        continue;
      }

      var value = flat[key];

      if (Array.isArray(value)) {
        value =
          value.length
            ? value[0]
            : '';
      }

      value =
        normalizeSecretValue_(value);

      if (value) {
        return value;
      }
    }

    return '';
  }

  function findSuppliedSecret_(
    payload,
    event
  ) {
    var supplied =
      findSecretInObject_(
        payload
      );

    if (supplied) {
      return supplied;
    }

    if (
      event &&
      event.parameter
    ) {
      supplied =
        findSecretInObject_(
          event.parameter
        );

      if (supplied) {
        return supplied;
      }
    }

    if (
      event &&
      event.parameters
    ) {
      supplied =
        findSecretInObject_(
          event.parameters
        );

      if (supplied) {
        return supplied;
      }
    }

    return '';
  }

  function validateSecret_(
    payload,
    event
  ) {
    var d = deps_();

    var expected =
      normalizeSecretValue_(
        d.util.requireProperty(
          'WEBFORM_SHARED_SECRET',
          {
            allowDefault: false
          }
        )
      );

    var supplied =
      findSuppliedSecret_(
        payload,
        event
      );

    if (
      !supplied ||
      !expected ||
      supplied !== expected
    ) {
      throw new Error(
        'Unauthorized webhook request.'
      );
    }
  }

  function removeSensitiveFields_(
    payload
  ) {
    var copy = {};

    Object.keys(
      payload || {}
    ).forEach(function (key) {

      var normalized =
        normalizeSecretFieldName_(
          key
        );

      var sensitive =
        SECRET_FIELD_NAMES.some(
          function (name) {
            return (
              normalized ===
              normalizeSecretFieldName_(
                name
              )
            );
          }
        );

      if (!sensitive) {
        copy[key] =
          payload[key];
      }
    });

    return copy;
  }

  /*******************************************************
   * PAYLOAD FIELD HELPERS
   *******************************************************/

  function field_(
    payload,
    key,
    fallback
  ) {
    return deps_()
      .util
      .getAny(
        payload || {},
        ALIASES[key] || [],
        fallback === undefined
          ? ''
          : fallback
      );
  }

  function attribution_(payload) {
    var d = deps_();

    var flat =
      d.util.flattenObject(
        payload || {}
      );

    var out = {};

    ATTRIBUTION_KEYS.forEach(
      function (key) {

        var value = flat[key];

        if (
          value === undefined
        ) {
          value =
            flat[
              key.replace(
                /_([a-z])/g,
                function (_, c) {
                  return c.toUpperCase();
                }
              )
            ];
        }

        if (
          value !== undefined &&
          !d.util.isBlank(value)
        ) {
          out[key] = value;
        }
      }
    );

    /************************************************************
     * CF_SERVICEOPS_V5_12_4_NEWSLETTER_ATTRIBUTION_CANONICALIZATION_R1
     * Normalize newsletter attribution from explicit fields, UTM
     * fields, and the source URL. This is deliberately generic for
     * Email 01 / Email 02 / Email 03 and future emailNN sends.
     * No new spreadsheet columns are required; canonical values stay
     * inside the existing Attribution JSON.
     ************************************************************/
    (function () {
      function text_(value) {
        return String(value === null || value === undefined ? '' : value).trim();
      }
      function lower_(value) {
        return text_(value).toLowerCase();
      }
      function query_(url) {
        var result = {};
        var raw = text_(url).replace(/&amp;/gi, '&');
        var q = raw.indexOf('?');
        if (q < 0) return result;
        var fragment = raw.slice(q + 1).split('#')[0];
        fragment.split('&').forEach(function (part) {
          if (!part) return;
          var eq = part.indexOf('=');
          var k = eq < 0 ? part : part.slice(0, eq);
          var v = eq < 0 ? '' : part.slice(eq + 1);
          try { k = decodeURIComponent(k.replace(/\+/g, ' ')); } catch (ignored1) {}
          try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (ignored2) {}
          k = lower_(k);
          if (k && result[k] === undefined) result[k] = v;
        });
        return result;
      }
      function first_(keys, query) {
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          var direct = flat[key];
          if (direct === undefined) direct = out[key];
          if (direct !== undefined && text_(direct)) return text_(direct);
          if (query && query[key] !== undefined && text_(query[key])) return text_(query[key]);
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

      var sourceUrl = first_(['source_url'], null);
      var parsed = query_(sourceUrl);
      var utmId = first_(['utm_id', 'current_utm_id', 'first_utm_id'], parsed);
      var utmContent = first_(['utm_content', 'current_utm_content', 'first_utm_content'], parsed);
      var utmTerm = first_(['utm_term', 'current_utm_term', 'first_utm_term'], parsed);
      var explicitSend = first_(['send_id', 'current_send_id', 'cf_send', 'current_cf_send', 'first_send_id', 'first_cf_send'], parsed);
      var explicitVariant = first_(['message_variant', 'current_message_variant', 'first_message_variant'], parsed);
      var content = contentParts_(utmContent);
      var sendId = normalizeSend_(explicitSend) || normalizeSend_(utmId) || content.send || normalizeSend_(utmTerm);
      var variant = lower_(explicitVariant) || content.variant;
      var placement = content.placement;

      if (utmId && !text_(out.utm_id)) out.utm_id = utmId;
      if (sendId) {
        out.send_id = sendId;
        out.cf_send = sendId;
        var numberMatch = sendId.match(/^email(\d{2})/);
        if (numberMatch) out.newsletter_number = numberMatch[1];
      }
      if (variant) out.message_variant = variant;
      if (placement) out.cta_placement = placement;

      // Email 02 values are authoritative from the supplied Newsletter 2 HTML.
      // Fill values lost when the landing-page source_url is truncated.
      if (sendId === 'email02_followup') {
        if (!text_(out.utm_source)) out.utm_source = 'Klaviyo';
        if (!text_(out.utm_medium)) out.utm_medium = 'email';
        if (!text_(out.utm_campaign)) out.utm_campaign = 'early_bird_2026_fireplace_service';
        if (!text_(out.utm_id)) out.utm_id = 'eb26_email02_followup';
        if (!text_(out.cf_campaign)) out.cf_campaign = 'eb26';
        if (!text_(out.cf_offer)) out.cf_offer = '200_hst_included';
        if (!text_(out.cf_landing)) out.cf_landing = 'service_maintenance_page';
        if (!text_(out.referral_source)) out.referral_source = 'klaviyo_email';
        if (!text_(out.message_variant) && /^email02_followup_a_(hero|final)$/.test(lower_(utmContent))) {
          out.message_variant = 'email02_followup_a';
        }
      }

      // Future Email 03+ sends work generically when their send/UTM naming uses
      // emailNN_* or eb26_emailNN_*. We deliberately do not invent an Email 03
      // offer or creative name before that newsletter exists.
      if (/^email\d{2}_/.test(sendId) && !text_(out.cf_campaign) && /^eb26_/.test(lower_(utmId))) {
        out.cf_campaign = 'eb26';
      }
    })();

    return out;
  }

  function splitName_(payload) {
    var d = deps_();

    var first =
      d.util.cleanText(
        field_(
          payload,
          'FIRST_NAME'
        )
      );

    var last =
      d.util.cleanText(
        field_(
          payload,
          'LAST_NAME'
        )
      );

    var full =
      d.util.cleanText(
        field_(
          payload,
          'FULL_NAME'
        )
      );

    if (
      (!first || !last) &&
      full
    ) {
      var parts =
        full.split(/\s+/);

      if (!first) {
        first =
          parts.shift() || '';
      }

      if (!last) {
        last =
          parts.join(' ');
      }
    }

    first =
      d.util.toParagraphCase(
        first
      );

    last =
      d.util.toParagraphCase(
        last
      );

    return {
      first: first,
      last: last,
      full:
        d.util.buildFullName(
          first,
          last
        )
    };
  }

  /*******************************************************
   * BUILD CANONICAL RECORDS
   *******************************************************/


  
  function normalizeRealtimeSubmittedAtToronto_(rawValue,receivedAt,sourceSystem) {
    /* CF_SERVICEOPS_V5_10_35_TORONTO_SUBMITTED_AT_R1 */
    var d=deps_();
    var raw=d.util.cleanText(rawValue);
    if(!raw) return receivedAt;
    if(String(sourceSystem||'WEBFORM').toUpperCase()!=='WEBFORM') return raw;
    var m=String(raw).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
    if(!m) return raw;
    var utc=new Date(Date.UTC(Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4]),Number(m[5]),Number(m[6])));
    if(isNaN(utc.getTime())) return raw;
    var local=Utilities.formatDate(utc,'America/Toronto','yyyy-MM-dd H:mm:ss');
    function wallMs_(value){
      var x=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2}):(\d{2})$/);
      return x?Date.UTC(Number(x[1]),Number(x[2])-1,Number(x[3]),Number(x[4]),Number(x[5]),Number(x[6])):NaN;
    }
    var convertedMs=wallMs_(local),receivedMs=wallMs_(receivedAt);
    // Realtime webhooks should arrive close to form submission. This plausibility
    // guard prevents a future/local-time source contract change from being shifted.
    if(isFinite(convertedMs)&&isFinite(receivedMs)&&Math.abs(convertedMs-receivedMs)<=30*60*1000) return local;
    return raw;
  }

function buildRecords_(
    payload,
    raw,
    options
  ) {
    options = options || {};

    var d = deps_();

    var cleanPayload =
      removeSensitiveFields_(
        payload || {}
      );

    var names =
      splitName_(
        cleanPayload
      );

    var phone =
      d.util.parsePhone(
        field_(
          cleanPayload,
          'PHONE'
        )
      );

    var altPhone =
      d.util.parsePhone(
        field_(
          cleanPayload,
          'ALT_PHONE'
        )
      );

    var province =
      d.util.cleanText(
        field_(
          cleanPayload,
          'PROVINCE',
          d.config.getDefault(
            'DEFAULT_PROVINCE'
          )
        )
      ).toUpperCase();

    var country =
      d.util.toParagraphCase(
        field_(
          cleanPayload,
          'COUNTRY',
          d.config.getDefault(
            'DEFAULT_COUNTRY'
          )
        )
      );

    var fullAddress =
      d.util.buildFullAddress(
        field_(
          cleanPayload,
          'STREET'
        ),
        field_(
          cleanPayload,
          'CITY'
        ),
        province,
        field_(
          cleanPayload,
          'POSTAL'
        ),
        country
      );

    /* CF_SERVICEOPS_V5_11_6_LANDING_CAMPAIGN_CODE_AUTHORITY_R2
     Campaign Code is authoritative only when explicitly submitted by the landing/form contract.
     Never infer or default it from UTM, cf_campaign, campaign name, or DEFAULT_CAMPAIGN_CODE. */
    var campaignCode = d.util.cleanText(cleanPayload && cleanPayload.campaign_code);

    var correlationId =
      d.util.cleanText(
        field_(
          cleanPayload,
          'CORRELATION_ID'
        )
      ) ||
      d.util.generateId(
        'CORR'
      );

    /*
     * Gravity Forms Entry ID is our
     * primary idempotency identity.
     */
    var suppliedSubmissionId =
      d.util.cleanText(
        field_(
          cleanPayload,
          'SUBMISSION_ID'
        )
      );

    var submissionId =
      suppliedSubmissionId ||
      d.util.generateId(
        'SUB'
      );

    var requestId =
      options.requestId ||
      d.util.generateId(
        'SR'
      );

    var receivedAt =
      options.receivedAt ||
      d.util.nowString();

    var submittedAt = normalizeRealtimeSubmittedAtToronto_(d.util.cleanText(field_(cleanPayload, 'SUBMITTED_AT')), receivedAt, options.sourceSystem || 'WEBFORM');

    var sanitizedRaw =
      raw ||
      d.util.safeJson(
        cleanPayload
      );

    /*
     * Secret/query authentication fields are
     * deliberately excluded from the hash.
     */
    var payloadHash =
      d.util.canonicalHash(
        cleanPayload
      );

    var attribution =
      attribution_(
        cleanPayload
      );

    var campaign =
      d.config.getCampaign(
        campaignCode
      );

    if (
      !attribution.campaign_name
    ) {
      attribution.campaign_name =
        campaign.name;
    }

    if (
      !attribution.campaign_year
    ) {
      attribution.campaign_year =
        campaign.year;
    }

    if (
      !attribution.traffic_channel
    ) {
      attribution.traffic_channel =
        campaign.trafficChannel;
    }

    /***************************************************
     * 01 WEBFORM REQUESTS
     ***************************************************/

    var webform =
      d.util.makeBlankRecord(
        'WEBFORM_REQUESTS'
      );

    webform['Received At'] =
      receivedAt;

    webform['Updated At'] =
      receivedAt;

    webform['Submission ID'] =
      submissionId;

    webform['Request ID'] =
      requestId;

    webform['Source Row ID'] =
      options.sourceRowId || '';

    webform['Correlation ID'] =
      correlationId;

    webform['Source System'] =
      options.sourceSystem ||
      'WEBFORM';

    webform['Form ID'] =
      field_(
        cleanPayload,
        'FORM_ID'
      );

    webform['Form Title'] =
      field_(
        cleanPayload,
        'FORM_TITLE'
      );

    webform['Full Name'] =
      names.full;

    webform['Phone'] =
      field_(
        cleanPayload,
        'PHONE'
      );

    webform['Email'] =
      d.util.normalizeEmail(
        field_(
          cleanPayload,
          'EMAIL'
        )
      );

    webform['Full Address'] =
      fullAddress;

    webform['Campaign Code'] =
      campaignCode;

    webform['Attribution JSON'] =
      d.util.safeJson(
        attribution
      );

    webform['Raw Payload'] =
      d.util.truncate(
        sanitizedRaw,
45000
      );

    webform['Payload Hash'] =
      payloadHash;

    webform['Processing Status'] =
      'PROCESSED';

    webform['Processing Error'] =
      '';

    webform['Processed At'] =
      receivedAt;

    /***************************************************
     * 02 SERVICE REQUESTS
     ***************************************************/

    var service =
      d.util.makeBlankRecord(
        'SERVICE_REQUESTS'
      );

    service['Request ID'] =
      requestId;

    service['Created At'] =
      receivedAt;

    service['Updated At'] =
      receivedAt;

    service['Schema Version'] =
      d.config.getSchemaVersion();

    service['Correlation ID'] =
      correlationId;

    service['Source System'] =
      options.sourceSystem ||
      'WEBFORM';

    service['Source Row ID'] =
      options.sourceRowId || '';

    service['Submission ID'] =
      submissionId;

    service['Payload Hash'] =
      payloadHash;

    service['Submitted At'] =
      submittedAt;

    service['Campaign Code'] =
      campaignCode;

    service['Attribution JSON'] =
      d.util.safeJson(
        attribution
      );

    service['First Name'] =
      names.first;

    service['Last Name'] =
      names.last;

    service['Full Name'] =
      names.full;

    service['Phone'] =
      field_(
        cleanPayload,
        'PHONE'
      );

    service['Phone Extension'] =
      phone.extension;

    service['Alt Phone'] =
      field_(
        cleanPayload,
        'ALT_PHONE'
      );

    service['Normalized Phone'] =
      phone.number;

    service['Normalized Alt Phone'] =
      altPhone.number;

    service['Email'] =
      field_(
        cleanPayload,
        'EMAIL'
      );

    service['Normalized Email'] =
      d.util.normalizeEmail(
        field_(
          cleanPayload,
          'EMAIL'
        )
      );

    service['Street'] =
      d.util.toParagraphCase(
        field_(
          cleanPayload,
          'STREET'
        )
      );

    service['City'] =
      d.util.toParagraphCase(
        field_(
          cleanPayload,
          'CITY'
        )
      );

    service['Province'] =
      province;

    service['Postal Code'] =
      d.util.cleanText(
        field_(
          cleanPayload,
          'POSTAL'
        )
      ).toUpperCase();

    service['Normalized Postal'] =
      d.util.normalizePostal(
        field_(
          cleanPayload,
          'POSTAL'
        )
      );

    service['Country'] =
      country;

    service['Full Address'] =
      fullAddress;

    service['Normalized Address'] =
      d.util.normalizeAddress(
        fullAddress
      );

    service['Preferred Days'] =
      d.util.cleanText(
        field_(
          cleanPayload,
          'PREFERRED_DAYS'
        )
      );

    service['Unit Details'] =
      d.util.cleanText(
        field_(
          cleanPayload,
          'UNIT_DETAILS'
        )
      );

    service['Service Details'] =
      d.util.cleanText(
        field_(
          cleanPayload,
          'SERVICE_DETAILS'
        )
      );

    service['Additional Notes'] =
      d.util.cleanText(
        field_(
          cleanPayload,
          'ADDITIONAL_NOTES'
        )
      );

    service['Current Stage'] =
      d.config.getDefault(
        'INITIAL_STAGE'
      );

    service['Request Status'] =
      d.config.getDefault(
        'INITIAL_REQUEST_STATUS'
      );

    service['Manual Review?'] =
      d.config.getDefault(
        'INITIAL_MANUAL_REVIEW'
      );

    service['Duplicate Risk Status'] =
      'NONE';

    service['Next Action'] =
      'RUN MATCHING';

    service['Customer Match Status'] =
      d.config.getDefault(
        'INITIAL_MATCH_STATUS'
      );

    service['Contact Match Status'] =
      d.config.getDefault(
        'INITIAL_MATCH_STATUS'
      );

    service['Location Match Status'] =
      d.config.getDefault(
        'INITIAL_MATCH_STATUS'
      );

    service['Match Confidence'] =
      'NONE';

    service['Match Score'] =
      0;

    service['History Enrichment Status'] =
      'NOT CHECKED';

    service['Customer Action'] =
      'NONE';

    service['Contact Action'] =
      'NONE';

    service['Location Action'] =
      'NONE';

    service['Work Order Action'] =
      'NONE';

    service['Customer Structure Status'] =
      'NOT STARTED';

    service['Contact Association Status'] =
      'NOT STARTED';

    service['Striven Sync Status'] =
      d.config.getDefault(
        'INITIAL_SYNC_STATUS'
      );

    service['Reconciliation Status'] =
      'NOT STARTED';

    return {
      webform: webform,
      service: service,

      requestId: requestId,
      submissionId: submissionId,

      suppliedSubmissionId:
        suppliedSubmissionId,

      payloadHash:
        payloadHash,

      correlationId:
        correlationId
    };
  }

  /*******************************************************
   * FAST EXACT ID LOOKUP
   *******************************************************/

  function findExactRecord_(
    keyOrName,
    header,
    value
  ) {
    var d = deps_();

    var target =
      d.util.cleanText(
        value
      );

    if (!target) {
      return null;
    }

    var sheet =
      d.util.requireSheet(
        keyOrName
      );

    var lastRow =
      sheet.getLastRow();

    if (lastRow < 2) {
      return null;
    }

    var map =
      d.util.getHeaderMap(
        sheet
      );

    var column =
      map[header];

    if (!column) {
      return null;
    }

    /*
     * Do not read the whole 92-column Service Request table
     * for webhook duplicate checks.
     */
    var found =
      sheet
        .getRange(
          2,
          column,
          lastRow - 1,
1
        )
        .createTextFinder(
          target
        )
        .matchEntireCell(true)
        .findNext();

    if (!found) {
      return null;
    }

    var rowNumber =
      found.getRow();

    var headers =
      d.util.getActualHeaders(
        sheet
      );

    var row =
      sheet
        .getRange(
          rowNumber,
          1,
          1,
          headers.length
        )
        .getValues()[0];

    return d.util.rowToRecord(
      headers,
      row,
      rowNumber
    );
  }

  /*******************************************************
   * IDEMPOTENCY
   *
   * Gravity Forms Submission ID wins.
   *
   * Payload Hash is only used if no real submission ID
   * was supplied. This prevents two legitimate GF entries
   * containing identical answers from being collapsed.
   *******************************************************/

  function findExistingByIdentity_(
    keyOrName,
    submissionId,
    payloadHash
  ) {
    var submission =
      clean_(
        submissionId
      );

    if (submission) {
      return findExactRecord_(
        keyOrName,
        'Submission ID',
        submission
      );
    }

    return payloadHash
      ? findExactRecord_(
          keyOrName,
          'Payload Hash',
          payloadHash
        )
      : null;
  }

  /*******************************************************
   * DURABLE INTAKE ORDER
   *
   * Keeps both durable intake ledgers globally newest-first
   * after any create/repair that adds a missing ledger row.
   *
   * Webform Requests: Received At DESC
   * Service Requests: Submitted At DESC
   *
   * Source Row ID is rebuilt after sorting from stable
   * Submission ID / Request ID identity.
   *******************************************************/

  function sortDurableIntakeLedgersNewestFirst_() {
    var d = deps_();

    var webformSheet =
      d.util.requireSheet(
        'WEBFORM_REQUESTS'
      );

    var serviceSheet =
      d.util.requireSheet(
        'SERVICE_REQUESTS'
      );

    var webformHeaderMap =
      d.util.getHeaderMap(
        webformSheet
      );

    var serviceHeaderMap =
      d.util.getHeaderMap(
        serviceSheet
      );

    var webformLastRow =
      webformSheet.getLastRow();

    var serviceLastRow =
      serviceSheet.getLastRow();

    if (
      webformLastRow > 2 &&
      webformHeaderMap[
        'Received At'
      ]
    ) {
      webformSheet
        .getRange(
          2,
          1,
          webformLastRow - 1,
          webformSheet.getLastColumn()
        )
        .sort({
          column:
            webformHeaderMap[
              'Received At'
            ],
          ascending: false
        });
    }

    if (
      serviceLastRow > 2 &&
      serviceHeaderMap[
        'Submitted At'
      ]
    ) {
      serviceSheet
        .getRange(
          2,
          1,
          serviceLastRow - 1,
          serviceSheet.getLastColumn()
        )
        .sort({
          column:
            serviceHeaderMap[
              'Submitted At'
            ],
          ascending: false
        });
    }

    /*
     * Sorting changes physical row numbers, so rebuild
     * Source Row ID using stable ledger identity.
     */
    var webformRows =
      d.util.readObjects(
        'WEBFORM_REQUESTS',
        {
          includeRowNumber: true
        }
      );

    var webformBySubmissionId = {};
    var webformByRequestId = {};

    webformRows.forEach(
      function (row) {
        var submissionId =
          clean_(
            row[
              'Submission ID'
            ]
          );

        var requestId =
          clean_(
            row[
              'Request ID'
            ]
          );

        if (
          submissionId &&
          webformBySubmissionId[
            submissionId
          ] === undefined
        ) {
          webformBySubmissionId[
            submissionId
          ] =
            row.__rowNumber;
        }

        if (
          requestId &&
          webformByRequestId[
            requestId
          ] === undefined
        ) {
          webformByRequestId[
            requestId
          ] =
            row.__rowNumber;
        }
      }
    );

    if (
      webformHeaderMap[
        'Source Row ID'
      ] &&
      webformRows.length
    ) {
      webformSheet
        .getRange(
          2,
          webformHeaderMap[
            'Source Row ID'
          ],
          webformRows.length,
1
        )
        .setValues(
          webformRows.map(
            function (row) {
              return [
                row.__rowNumber
              ];
            }
          )
        );
    }

    var serviceRows =
      d.util.readObjects(
        'SERVICE_REQUESTS',
        {
          includeRowNumber: true
        }
      );

    if (
      serviceHeaderMap[
        'Source Row ID'
      ] &&
      serviceRows.length
    ) {
      serviceSheet
        .getRange(
          2,
          serviceHeaderMap[
            'Source Row ID'
          ],
          serviceRows.length,
1
        )
        .setValues(
          serviceRows.map(
            function (row) {
              var submissionId =
                clean_(
                  row[
                    'Submission ID'
                  ]
                );

              var requestId =
                clean_(
                  row[
                    'Request ID'
                  ]
                );

              var sourceRow =
                (
                  submissionId &&
                  webformBySubmissionId[
                    submissionId
                  ]
                ) ||
                (
                  requestId &&
                  webformByRequestId[
                    requestId
                  ]
                ) ||
                '';

              return [
                sourceRow
              ];
            }
          )
        );
    }

    return {
      ok: true,
      webformRows:
        webformRows.length,
      serviceRows:
        serviceRows.length
    };
  }

  /*******************************************************
   * INTAKE_PREPEND_NEWEST_FIRST_V2
   * DURABLE INTAKE ORDER CONTRACT
   *
   * Real-time brand-new submissions:
   *   - insert at row 2 in both durable ledgers.
   *
   * Reconciliation / one-sided repair:
   *   - append safely, then globally sort newest-first.
   *
   * Source Row ID is always rebuilt from stable identity
   * after physical rows move.
   *******************************************************/

  function insertRecordAtTop_(keyOrName, record) {
    var d = deps_();
    var sheet = d.util.requireSheet(keyOrName);
    var row = d.util.recordToRow(keyOrName, record);

    d.util.ensureGridSize(
      sheet,
      Math.max(2, sheet.getMaxRows()),
      Math.max(1, row.length)
    );

    sheet.insertRowBefore(2);

    sheet
      .getRange(
        2,
        1,
        1,
        row.length
      )
      .setValues([row]);

    return 2;
  }

  function reindexDurableIntakeSourceRows_() {
    var d = deps_();

    var webformSheet =
      d.util.requireSheet(
        'WEBFORM_REQUESTS'
      );

    var serviceSheet =
      d.util.requireSheet(
        'SERVICE_REQUESTS'
      );

    var webformHeaderMap =
      d.util.getHeaderMap(
        webformSheet
      );

    var serviceHeaderMap =
      d.util.getHeaderMap(
        serviceSheet
      );

    var webformRows =
      d.util.readRecords(
        'WEBFORM_REQUESTS'
      );

    var webformBySubmissionId = {};
    var webformByRequestId = {};

    webformRows.forEach(
      function (row) {
        var submissionId =
          clean_(
            row[
              'Submission ID'
            ]
          );

        var requestId =
          clean_(
            row[
              'Request ID'
            ]
          );

        if (
          submissionId &&
          webformBySubmissionId[
            submissionId
          ] === undefined
        ) {
          webformBySubmissionId[
            submissionId
          ] =
            row.__rowNumber;
        }

        if (
          requestId &&
          webformByRequestId[
            requestId
          ] === undefined
        ) {
          webformByRequestId[
            requestId
          ] =
            row.__rowNumber;
        }
      }
    );

    if (
      webformHeaderMap[
        'Source Row ID'
      ] &&
      webformRows.length
    ) {
      webformSheet
        .getRange(
          2,
          webformHeaderMap[
            'Source Row ID'
          ],
          webformRows.length,
1
        )
        .setValues(
          webformRows.map(
            function (row) {
              return [
                row.__rowNumber
              ];
            }
          )
        );
    }

    var serviceRows =
      d.util.readRecords(
        'SERVICE_REQUESTS'
      );

    if (
      serviceHeaderMap[
        'Source Row ID'
      ] &&
      serviceRows.length
    ) {
      serviceSheet
        .getRange(
          2,
          serviceHeaderMap[
            'Source Row ID'
          ],
          serviceRows.length,
1
        )
        .setValues(
          serviceRows.map(
            function (row) {
              var submissionId =
                clean_(
                  row[
                    'Submission ID'
                  ]
                );

              var requestId =
                clean_(
                  row[
                    'Request ID'
                  ]
                );

              var matchedRow =
                (
                  submissionId &&
                  webformBySubmissionId[
                    submissionId
                  ]
                ) ||
                (
                  requestId &&
                  webformByRequestId[
                    requestId
                  ]
                ) ||
                '';

              /*
               * Preserve any non-Webform/manual source-row value
               * when no durable Webform identity exists.
               */
              return [
                matchedRow ||
                row[
                  'Source Row ID'
                ] ||
                ''
              ];
            }
          )
        );
    }

    return {
      ok: true,
      webformRows:
        webformRows.length,
      serviceRows:
        serviceRows.length
    };
  }

  function sortDurableIntakeLedgersNewestFirst_() {
    var d = deps_();

    var webformSheet =
      d.util.requireSheet(
        'WEBFORM_REQUESTS'
      );

    var serviceSheet =
      d.util.requireSheet(
        'SERVICE_REQUESTS'
      );

    var webformHeaderMap =
      d.util.getHeaderMap(
        webformSheet
      );

    var serviceHeaderMap =
      d.util.getHeaderMap(
        serviceSheet
      );

    var webformLastRow =
      webformSheet.getLastRow();

    var serviceLastRow =
      serviceSheet.getLastRow();

    if (
      webformLastRow > 2 &&
      webformHeaderMap[
        'Received At'
      ]
    ) {
      webformSheet
        .getRange(
          2,
          1,
          webformLastRow - 1,
          webformSheet.getLastColumn()
        )
        .sort({
          column:
            webformHeaderMap[
              'Received At'
            ],
          ascending: false
        });
    }

    if (
      serviceLastRow > 2 &&
      serviceHeaderMap[
        'Submitted At'
      ]
    ) {
      serviceSheet
        .getRange(
          2,
          1,
          serviceLastRow - 1,
          serviceSheet.getLastColumn()
        )
        .sort({
          column:
            serviceHeaderMap[
              'Submitted At'
            ],
          ascending: false
        });
    }

    return reindexDurableIntakeSourceRows_();
  }

  /*******************************************************
   * RECEIVE / REPAIR ONE PAYLOAD
   *******************************************************/

  function receivePayload(
    payload,
    options
  ) {
    options = options || {};

    var d = deps_();

    return d.util.withScriptLock(
      function () {

        var cleanPayload =
          removeSensitiveFields_(
            payload || {}
          );

        /*
         * Build once to establish identity.
         */
        var firstBuild =
          buildRecords_(
            cleanPayload,
            options.raw ||
              d.util.safeJson(
                cleanPayload
              ),
            {
              receivedAt:
                options.receivedAt ||
                d.util.nowString(),

              requestId:
                options.requestId ||
                '',

              sourceSystem:
                options.sourceSystem ||
                'WEBFORM'
            }
          );

        var existingWebform =
          findExistingByIdentity_(
            'WEBFORM_REQUESTS',
            firstBuild
              .suppliedSubmissionId,
            firstBuild.payloadHash
          );

        var existingService =
          findExistingByIdentity_(
            'SERVICE_REQUESTS',
            firstBuild
              .suppliedSubmissionId,
            firstBuild.payloadHash
          );

        /*
         * Reuse an existing Request ID if either ledger
         * already contains this Gravity Forms submission.
         */
        var requestId =
          clean_(
            (
              existingWebform &&
              existingWebform[
                'Request ID'
              ]
            ) ||
            (
              existingService &&
              existingService[
                'Request ID'
              ]
            ) ||
            firstBuild.requestId
          );

        /*
         * Both sides already exist.
         * Safe webhook retry.
         */
        if (
          existingWebform &&
          existingService
        ) {
          return {
            ok: true,
            duplicate: true,
            repaired: false,

            requestId:
              requestId,

            submissionId:
              firstBuild
                .submissionId,

            webformRow:
              existingWebform
                .__rowNumber,

            serviceRow:
              existingService
                .__rowNumber
          };
        }

        /*
         * Pre-calculate the Webform row while holding the
         * script lock. This removes the extra patch write
         * that previously cost webhook response time.
         */
        var webformRow =
          existingWebform
            ? existingWebform
                .__rowNumber
            : 0;

        if (!webformRow) {
          webformRow =
            d.util
              .requireSheet(
                'WEBFORM_REQUESTS'
              )
              .getLastRow() + 1;
        }

        /*
         * Rebuild with the final Request ID and
         * Source Row ID.
         */
        var records =
          buildRecords_(
            cleanPayload,
            options.raw ||
              d.util.safeJson(
                cleanPayload
              ),
            {
              receivedAt:
                firstBuild
                  .webform[
                    'Received At'
                  ],

              requestId:
                requestId,

              sourceSystem:
                options.sourceSystem ||
                'WEBFORM',

              sourceRowId:
                webformRow
            }
          );
        /*
         * Only a truly brand-new real-time submission can
         * safely use the fast row-2 insertion path.
         *
         * Reconciliation and one-sided repair may introduce
         * older records, so those paths append then sort.
         */
        var brandNewRealtime =
          options.reconciliation !== true &&
          !existingWebform &&
          !existingService;



        var createdWebform =
          false;

        var createdService =
          false;

        /***********************************************
         * REPAIR / CREATE WEBFORM SIDE
         ***********************************************/

        if (!existingWebform) {
          webformRow =
            brandNewRealtime
              ? insertRecordAtTop_(
                  'WEBFORM_REQUESTS',
                  records.webform
                )
              : d.util.appendRecord(
                  'WEBFORM_REQUESTS',
                  records.webform
                );

          createdWebform =
            true;

        } else if (
          !clean_(
            existingWebform[
              'Request ID'
            ]
          ) &&
          requestId
        ) {
          d.util.patchRow(
            'WEBFORM_REQUESTS',
            existingWebform
              .__rowNumber,
            {
              'Request ID':
                requestId,

              'Source Row ID':
                existingWebform
                  .__rowNumber,

              'Updated At':
                d.util.nowString()
            }
          );
        }

        /***********************************************
         * REPAIR / CREATE SERVICE REQUEST SIDE
         ***********************************************/

        var serviceRow =
          existingService
            ? existingService
                .__rowNumber
            : 0;

        if (!existingService) {
          records.service[
            'Source Row ID'
          ] = webformRow;

          serviceRow =
            brandNewRealtime
              ? insertRecordAtTop_(
                  'SERVICE_REQUESTS',
                  records.service
                )
              : d.util.appendRecord(
                  'SERVICE_REQUESTS',
                  records.service
                );

          createdService =
            true;
        }

        /*
         * Keep both durable ledgers globally newest-first.
         * This also repairs Source Row ID after physical rows move.
         */
        if (
          createdWebform ||
          createdService
        ) {
          sortDurableIntakeLedgersNewestFirst_();

          var sortedWebform =
            findExistingByIdentity_(
              'WEBFORM_REQUESTS',
              records.submissionId,
              records.payloadHash
            );

          var sortedService =
            findExistingByIdentity_(
              'SERVICE_REQUESTS',
              records.submissionId,
              records.payloadHash
            );

          if (sortedWebform) {
            webformRow =
              sortedWebform
                .__rowNumber;
          }

          if (sortedService) {
            serviceRow =
              sortedService
                .__rowNumber;
          }
        }

        /*
         * Physical row movement must never leave Source Row ID stale.
         *
         * Brand-new real-time submissions were inserted directly at row 2,
         * so only re-indexing is required.
         *
         * Reconciliation / one-sided repairs may be older than current data,
         * so globally sort those paths before rebuilding row linkage.
         */
        if (
          createdWebform ||
          createdService
        ) {
          if (
            brandNewRealtime
          ) {
            reindexDurableIntakeSourceRows_();
          } else {
            sortDurableIntakeLedgersNewestFirst_();
          }

          var orderedWebform =
            findExistingByIdentity_(
              'WEBFORM_REQUESTS',
              records
                .suppliedSubmissionId,
              records.payloadHash
            );

          var orderedService =
            findExistingByIdentity_(
              'SERVICE_REQUESTS',
              records
                .suppliedSubmissionId,
              records.payloadHash
            );

          if (
            orderedWebform
          ) {
            webformRow =
              orderedWebform
                .__rowNumber;
          }

          if (
            orderedService
          ) {
            serviceRow =
              orderedService
                .__rowNumber;
          }
        }

        /*
         * Fast webhook calls skip the System Log write.
         *
         * The Webform Request + Service Request rows are
         * the durable receipt records.
         *
         * Reconciliation/manual operations may log.
         */
        if (
          options.fast !== true
        ) {
          d.util.logEvent({
            module:
              MODULE_NAME,

            action:
              options.reconciliation
                ? 'RECONCILE_ENTRY'
                : 'RECEIVE',

            status:
              (
                createdWebform ||
                createdService
              )
                ? 'PROCESSED'
                : 'DUPLICATE',

            requestId:
              requestId,

            correlationId:
              records.correlationId,

            row:
              serviceRow,

            sheet:
              d.config.getSheetName(
                'SERVICE_REQUESTS'
              ),

            details: {
              submissionId:
                records.submissionId,

              createdWebform:
                createdWebform,

              createdService:
                createdService,

              repaired:
                (
                  !!existingWebform !==
                  !!existingService
                )
            },

            version:
              VERSION
          });
        }

        return {
          ok: true,
          duplicate: false,

          repaired:
            (
              !!existingWebform !==
              !!existingService
            ),

          createdWebform:
            createdWebform,

          createdService:
            createdService,

          requestId:
            requestId,

          submissionId:
            records.submissionId,

          payloadHash:
            records.payloadHash,

          webformRow:
            webformRow,

          serviceRow:
            serviceRow
        };
      },
30000
    );
  }

  
  /*******************************************************
   * CF_SERVICEOPS_V5_10_0_DEFERRED_POST_INTAKE
   *
   * PURPOSE
   * - NEVER runs inside doPost(). The Gravity Forms ACK stays fast.
   * - Restores newest-first Webform / Service Request ledgers.
   * - Repairs Source Row ID after physical row movement.
   * - Runs existing matching only when NEW INTAKE remains.
   * - Refreshes existing Operator Queue + Dashboard counts.
   *******************************************************/

  function intakeHeaderMap_(sheet) {
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    var map = {};
    headers.forEach(function (header, index) {
      var key = String(header || '').trim();
      if (key) map[key] = index + 1;
    });
    return map;
  }

  function intakeDateMs_(value) {
    if (value instanceof Date && !isNaN(value.getTime())) return value.getTime();
    var text = String(value || '').trim();
    if (!text) return 0;
    var normalized = text.replace(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2}):(\d{2})$/, '$1/$2/$3 $4:$5:$6');
    var parsed = new Date(normalized);
    return isNaN(parsed.getTime()) ? 0 : parsed.getTime();
  }

  function assertUniqueIntakeIds_(values, label) {
    var seen = {};
    (values || []).forEach(function (value) {
      var id = String(value || '').trim();
      if (!id) return;
      if (seen[id]) throw new Error('INTAKE_ORDER_SAFETY_STOP | Duplicate ' + label + ': ' + id);
      seen[id] = true;
    });
  }

  function reorderWebformNewestFirst_() {
    var d = deps_();
    var sheet = d.util.requireSheet('WEBFORM_REQUESTS');
    var lastRow = sheet.getLastRow();
    if (lastRow < 3) return { moved: 0, rows: Math.max(0, lastRow - 1) };
    var map = intakeHeaderMap_(sheet);
    if (!map['Request ID'] || !map['Received At']) throw new Error('INTAKE_ORDER_SAFETY_STOP | Webform headers Request ID / Received At are required.');
    var width = sheet.getLastColumn();
    var values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
    var items = values.map(function (row, index) {
      var id = String(row[map['Request ID'] - 1] || '').trim();
      return { key: id || ('__WEBFORM_ROW_' + (index + 2)), id: id, ms: intakeDateMs_(row[map['Received At'] - 1]), original: index };
    });
    assertUniqueIntakeIds_(items.map(function (x) { return x.id; }), 'Webform Request ID');
    var desired = items.slice().sort(function (a, b) { return b.ms - a.ms || a.original - b.original; });
    var current = items.map(function (x) { return x.key; });
    var moved = 0;
    desired.forEach(function (item, targetIndex) {
      var currentIndex = current.indexOf(item.key);
      if (currentIndex < 0 || currentIndex === targetIndex) return;
      if (currentIndex < targetIndex) throw new Error('INTAKE_ORDER_SAFETY_STOP | Webform reorder invariant failed.');
      sheet.moveRows(sheet.getRange(currentIndex + 2, 1, 1, width), targetIndex + 2);
      current.splice(currentIndex, 1);
      current.splice(targetIndex, 0, item.key);
      moved++;
    });
    return { moved: moved, rows: items.length };
  }

  function currentWebformOrder_() {
    var d = deps_();
    var sheet = d.util.requireSheet('WEBFORM_REQUESTS');
    var lastRow = sheet.getLastRow();
    var map = intakeHeaderMap_(sheet);
    if (!map['Request ID']) throw new Error('INTAKE_ORDER_SAFETY_STOP | Webform Request ID header is required.');
    if (lastRow < 2) return [];
    var ids = sheet.getRange(2, map['Request ID'], lastRow - 1, 1).getDisplayValues().map(function (row) { return String(row[0] || '').trim(); }).filter(Boolean);
    assertUniqueIntakeIds_(ids, 'Webform Request ID');
    return ids;
  }

  function syncServiceRequestOrder_() {
    var d = deps_();
    var desiredIds = currentWebformOrder_();
    var sheet = d.util.requireSheet('SERVICE_REQUESTS');
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { moved: 0, linked: 0, rows: 0 };
    var map = intakeHeaderMap_(sheet);
    if (!map['Request ID']) throw new Error('INTAKE_ORDER_SAFETY_STOP | Service Request ID header is required.');
    var width = sheet.getLastColumn();
    var ids = sheet.getRange(2, map['Request ID'], lastRow - 1, 1).getDisplayValues().map(function (row) { return String(row[0] || '').trim(); });
    assertUniqueIntakeIds_(ids, 'Service Request ID');
    var current = ids.slice();
    var targetIndex = 0;
    var moved = 0;
    desiredIds.forEach(function (id) {
      var currentIndex = current.indexOf(id);
      if (currentIndex < 0) return;
      if (currentIndex !== targetIndex) {
        if (currentIndex < targetIndex) throw new Error('INTAKE_ORDER_SAFETY_STOP | Service Request reorder invariant failed.');
        sheet.moveRows(sheet.getRange(currentIndex + 2, 1, 1, width), targetIndex + 2);
        current.splice(currentIndex, 1);
        current.splice(targetIndex, 0, id);
        moved++;
      }
      targetIndex++;
    });
    return { moved: moved, linked: targetIndex, rows: ids.length };
  }

  function refreshSourceRowReferences_() {
    var d = deps_();
    var webformSheet = d.util.requireSheet('WEBFORM_REQUESTS');
    var serviceSheet = d.util.requireSheet('SERVICE_REQUESTS');
    var wfMap = intakeHeaderMap_(webformSheet);
    var srMap = intakeHeaderMap_(serviceSheet);
    ['Request ID','Submission ID','Source Row ID'].forEach(function (header) {
      if (!wfMap[header]) throw new Error('INTAKE_LINKAGE_SAFETY_STOP | Webform header missing: ' + header);
      if (!srMap[header]) throw new Error('INTAKE_LINKAGE_SAFETY_STOP | Service Request header missing: ' + header);
    });
    var requestRows = {}, submissionRows = {};
    var wfLast = webformSheet.getLastRow();
    if (wfLast >= 2) {
      var wfValues = webformSheet.getRange(2, 1, wfLast - 1, webformSheet.getLastColumn()).getDisplayValues();
      var wfSourceValues = [];
      wfValues.forEach(function (row, index) {
        var sheetRow = index + 2;
        var requestId = String(row[wfMap['Request ID'] - 1] || '').trim();
        var submissionId = String(row[wfMap['Submission ID'] - 1] || '').trim();
        if (requestId) { if (requestRows[requestId]) throw new Error('INTAKE_LINKAGE_SAFETY_STOP | Duplicate Webform Request ID: ' + requestId); requestRows[requestId] = sheetRow; }
        if (submissionId) { if (submissionRows[submissionId]) throw new Error('INTAKE_LINKAGE_SAFETY_STOP | Duplicate Webform Submission ID: ' + submissionId); submissionRows[submissionId] = sheetRow; }
        wfSourceValues.push([sheetRow]);
      });
      webformSheet.getRange(2, wfMap['Source Row ID'], wfSourceValues.length, 1).setValues(wfSourceValues);
    }
    var srLast = serviceSheet.getLastRow(), linked = 0;
    if (srLast >= 2) {
      var srValues = serviceSheet.getRange(2, 1, srLast - 1, serviceSheet.getLastColumn()).getDisplayValues();
      var currentSources = serviceSheet.getRange(2, srMap['Source Row ID'], srLast - 1, 1).getValues();
      var srSourceValues = srValues.map(function (row, index) {
        var requestId = String(row[srMap['Request ID'] - 1] || '').trim();
        var submissionId = String(row[srMap['Submission ID'] - 1] || '').trim();
        var sourceRow = requestRows[requestId] || submissionRows[submissionId] || currentSources[index][0] || '';
        if (requestRows[requestId] || submissionRows[submissionId]) linked++;
        return [sourceRow];
      });
      serviceSheet.getRange(2, srMap['Source Row ID'], srSourceValues.length, 1).setValues(srSourceValues);
    }
    return { webformRows: Math.max(0, wfLast - 1), serviceRows: Math.max(0, srLast - 1), linkedServiceRows: linked };
  }

  function repairIntakeOrderAndLinkage_() {
    var webform = reorderWebformNewestFirst_();
    var service = syncServiceRequestOrder_();
    var linkage = refreshSourceRowReferences_();
    return { ok: true, webform: webform, service: service, linkage: linkage };
  }

  function pendingIntakeCount_() {
    var rows = deps_().util.readRecords('SERVICE_REQUESTS');
    return rows.filter(function (row) {
      var stage = String(row['Current Stage'] || '').trim().toUpperCase();
      var customer = String(row['Customer Match Status'] || '').trim().toUpperCase();
      return stage === 'NEW INTAKE' || customer === 'NOT CHECKED';
    }).length;
  }

  function postProcessPending() {
    var d = deps_();
    var started = Date.now();
    var ordering = repairIntakeOrderAndLinkage_();
    var pendingBefore = pendingIntakeCount_();
    if (pendingBefore < 1) {
      if ((ordering.webform.moved || 0) + (ordering.service.moved || 0) > 0 && CF.OperatorQueue && typeof CF.OperatorQueue.refresh === 'function') CF.OperatorQueue.refresh();
      return { ok: true, version: VERSION, skipped: true, processedIntake: false, pendingBefore: 0, ordering: ordering, durationMs: Date.now() - started };
    }
    if (!CF.Matching || typeof CF.Matching.processAll !== 'function') throw new Error('POST_INTAKE_SETUP_REQUIRED | CF.Matching.processAll is unavailable.');
    var matching = CF.Matching.processAll();
    if (!matching || matching.ok !== true) throw new Error('POST_INTAKE_MATCHING_FAILED | Existing matching module did not complete successfully.');
    if (!CF.OperatorQueue || typeof CF.OperatorQueue.refresh !== 'function') throw new Error('POST_INTAKE_SETUP_REQUIRED | CF.OperatorQueue.refresh is unavailable.');
    var queue = CF.OperatorQueue.refresh();
    var pendingAfter = pendingIntakeCount_();
    var result = { ok: true, version: VERSION, skipped: false, processedIntake: true, pendingBefore: pendingBefore, pendingAfter: pendingAfter, ordering: ordering, matching: matching, queue: queue, durationMs: Date.now() - started };
    try { d.util.logEvent({ module: MODULE_NAME, action: 'POST_INTAKE_PROCESS', status: 'COMPLETE', details: { pendingBefore: pendingBefore, pendingAfter: pendingAfter, processed: matching.processed || matching.selected || 0, activeRequests: queue && queue.activeRequests }, durationMs: result.durationMs, version: VERSION }); } catch (ignored) {}
    return result;
  }

/*******************************************************
   * FAST WEBHOOK ENTRYPOINT
   *
   * IMPORTANT:
   * - No Queue refresh
   * - No Dashboard refresh
   * - No matching
   * - No Striven call
   * - No successful System Log write
   *******************************************************/

  function handlePost(event) {
    var d = deps_();

    try {
      var parsed =
        parseEvent_(
          event
        );

      validateSecret_(
        parsed.payload,
        event
      );

      var result =
        receivePayload(
          parsed.payload,
          {
            raw:
              parsed.raw,

            sourceSystem:
              'WEBFORM',

            fast:
              true
          }
        );

      /* CF_SERVICEOPS_V5_10_8_HANDLEPOST_EVENT_KICK_R1 */
      if (result && result.ok === true && result.duplicate !== true && CF.EventDrivenServiceAutomation && typeof CF.EventDrivenServiceAutomation.kick === 'function') {
        try {
          result.automationKick = CF.EventDrivenServiceAutomation.kick(result.requestId);
        } catch (automationError) {
          result.automationKick = { ok:false, scheduled:false, error:automationError && automationError.message ? automationError.message : String(automationError), liveWriteExecuted:false };
          try { console.error('CF ServiceOps event automation kick failed: ' + result.automationKick.error); } catch (ignoredAutomationConsole) {}
        }
      }

      return ContentService
        .createTextOutput(
          d.util.safeJson(
            result
          )
        )
        .setMimeType(
          ContentService
            .MimeType
            .JSON
        );

    } catch (error) {

      /*
       * Console logging does not add another Google Sheet
       * write to the HTTP response path.
       */
      console.error(
        MODULE_NAME +
          ' webhook error',
        error &&
        error.stack
          ? error.stack
          : error
      );

      return ContentService
        .createTextOutput(
          d.util.safeJson({
            ok: false,

            error:
              error &&
              error.message
                ? error.message
                : String(error)
          })
        )
        .setMimeType(
          ContentService
            .MimeType
            .JSON
        );
    }
  }

  /*******************************************************
   * LOCAL INTAKE AUDIT
   *******************************************************/

  function repeatedNonBlankCount_(
    records,
    header
  ) {
    var d = deps_();

    var counts = {};

    (records || []).forEach(
      function (record) {

        var value =
          d.util.cleanText(
            record[header]
          );

        if (value) {
          counts[value] =
            (
              counts[value] ||
0
            ) + 1;
        }
      }
    );

    return Object
      .keys(counts)
      .filter(
        function (key) {
          return (
            counts[key] > 1
          );
        }
      )
      .length;
  }

  function repairNewestFirst() {
    var d = deps_();

    return d.util.withScriptLock(
      function () {
        var result =
          sortDurableIntakeLedgersNewestFirst_();

        return {
          ok: true,
          version: VERSION,
          webformRows:
            result.webformRows,
          serviceRequestRows:
            result.serviceRows,
          newestWebformRow:
            d.util.readRecords(
              'WEBFORM_REQUESTS'
            )[0] || null,
          newestServiceRequestRow:
            d.util.readRecords(
              'SERVICE_REQUESTS'
            )[0] || null
        };
      },
30000
    );
  }

  function inspectState() {
    var d = deps_();

    var webforms =
      d.util.readRecords(
        'WEBFORM_REQUESTS'
      );

    var requests =
      d.util.readRecords(
        'SERVICE_REQUESTS'
      );

    var webformBySubmission =
      {};

    var serviceBySubmission =
      {};

    webforms.forEach(
      function (row) {
        var id =
          d.util.cleanText(
            row[
              'Submission ID'
            ]
          );

        if (id) {
          webformBySubmission[
            id
          ] = true;
        }
      }
    );

    requests.forEach(
      function (row) {
        var id =
          d.util.cleanText(
            row[
              'Submission ID'
            ]
          );

        if (id) {
          serviceBySubmission[
            id
          ] = true;
        }
      }
    );

    var missingServiceForWebform =
      Object
        .keys(
          webformBySubmission
        )
        .filter(
          function (id) {
            return (
              !serviceBySubmission[
                id
              ]
            );
          }
        )
        .length;

    var missingWebformForService =
      Object
        .keys(
          serviceBySubmission
        )
        .filter(
          function (id) {
            return (
              !webformBySubmission[
                id
              ]
            );
          }
        )
        .length;

    return {
      ok: true,
      version: VERSION,

      webformRows:
        webforms.length,

      serviceRequestRows:
        requests.length,

      duplicateSubmissionIds:
        repeatedNonBlankCount_(
          webforms,
          'Submission ID'
        ),

      duplicatePayloadHashes:
        repeatedNonBlankCount_(
          webforms,
          'Payload Hash'
        ),

      duplicateServiceSubmissionIds:
        repeatedNonBlankCount_(
          requests,
          'Submission ID'
        ),

      duplicateServicePayloadHashes:
        repeatedNonBlankCount_(
          requests,
          'Payload Hash'
        ),

      missingServiceForWebform:
        missingServiceForWebform,

      missingWebformForService:
        missingWebformForService
    };
  }

/*******************************************************
 * GRAVITY FORMS REST CONFIGURATION
 *
 * Required Script Properties:
 *   GRAVITY_FORMS_CONSUMER_KEY
 *   GRAVITY_FORMS_CONSUMER_SECRET
 *
 * Optional:
 *   GRAVITY_FORMS_BASE_URL
 *   GRAVITY_FORMS_SERVICE_FORM_ID
 *******************************************************/

function rawProperty_(candidates, defaultValue) {
  var props = PropertiesService
    .getScriptProperties()
    .getProperties();

  for (var i = 0; i < candidates.length; i++) {
    var value = clean_(props[candidates[i]]);

    if (value) {
      return value;
    }
  }

  return defaultValue === undefined
    ? ''
    : String(defaultValue);
}


function gfConfig_() {
  var baseUrl = rawProperty_(
    ['GRAVITY_FORMS_BASE_URL'],
    'https://www.classicfireplace.ca'
  ).replace(/\/+$/, '');

  var consumerKey = rawProperty_(
    [
      'GRAVITY_FORMS_CONSUMER_KEY',
      'GF_REST_CONSUMER_KEY'
    ],
    ''
  );

  var consumerSecret = rawProperty_(
    [
      'GRAVITY_FORMS_CONSUMER_SECRET',
      'GF_REST_CONSUMER_SECRET'
    ],
    ''
  );

  var formId = rawProperty_(
    [
      'GRAVITY_FORMS_SERVICE_FORM_ID',
      'GF_SERVICE_FORM_ID'
    ],
    '2'
  );

  if (!consumerKey || !consumerSecret) {
    throw new Error(
      'GRAVITY_FORMS_REST_NOT_CONFIGURED | ' +
      'Gravity Forms REST API credentials are not stored yet. ' +
      'Required properties: GRAVITY_FORMS_CONSUMER_KEY and ' +
      'GRAVITY_FORMS_CONSUMER_SECRET.'
    );
  }

  return {
    baseUrl: baseUrl,
    consumerKey: consumerKey,
    consumerSecret: consumerSecret,
    formId: formId,
    formTitle: 'Service Request'
  };
}


function gfGetJson_(path, params) {
  var d = deps_();
  var cfg = gfConfig_();

  var url =
    cfg.baseUrl +
    '/wp-json/gf/v2/' +
    String(path || '').replace(/^\/+/, '');

  var qs = queryString_(params || {});

  if (qs) {
    url += '?' + qs;
  }

  /*
   * Gravity Forms REST API v2 supports Basic Auth over HTTPS
   * using the Consumer Key as username and Consumer Secret
   * as password.
   */
  var auth = Utilities.base64Encode(
    cfg.consumerKey +
    ':' +
    cfg.consumerSecret
  );

  var response = d.util.httpRequest(
    url,
    {
      method: 'get',

      headers: {
        Authorization: 'Basic ' + auth,
        Accept: 'application/json'
      },

      attempts: 3
    }
  );

  return response.json || {};
}

function gfReconciliationStartDate_() {
  var value = rawProperty_(
    ['GRAVITY_FORMS_RECONCILIATION_START_DATE'],
    '2026-07-01 00:00:00'
  );

  value = clean_(value);

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    value += ' 00:00:00';
  }

  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    throw new Error(
      'GRAVITY_FORMS_RECONCILIATION_START_DATE_INVALID | ' +
      'Use YYYY-MM-DD or YYYY-MM-DD HH:mm:ss.'
    );
  }

  return value;
}

function fetchAllGravityEntries_() {
  var cfg = gfConfig_();
  var startDate = gfReconciliationStartDate_();

  var eligible = [];
  var totalCount = null;
  var pagesFetched = 0;
  var crossedCutoff = false;
  var previousDate = null;

  for (
    var page = 1;
    page <= GF_MAX_PAGES;
    page++
  ) {
    var body = gfGetJson_(
      'forms/' +
        encodeURIComponent(cfg.formId) +
        '/entries',
      {
        '_labels': 1,
        'paging[page_size]': GF_PAGE_SIZE,
        'paging[current_page]': page,
        'sorting[key]': 'date_created',
        'sorting[direction]': 'DESC',
        'sorting[is_numeric]': 'false'
      }
    );

    var entries = Array.isArray(body.entries)
      ? body.entries
      : [];

    pagesFetched++;

    if (
      body.total_count !== undefined &&
      body.total_count !== null
    ) {
      totalCount = Number(body.total_count);
    }

    if (!entries.length) {
      break;
    }

    for (
      var i = 0;
      i < entries.length;
      i++
    ) {
      var entry = entries[i];
      var created = clean_(entry.date_created);

      if (!created) {
        throw new Error(
          'GRAVITY_FORMS_RECONCILIATION_DATE_MISSING | ' +
          'Entry ' + clean_(entry.id) + ' has no date_created.'
        );
      }

      if (
        previousDate !== null &&
        created > previousDate
      ) {
        throw new Error(
          'GRAVITY_FORMS_RECONCILIATION_SORT_GUARD | ' +
          'Gravity Forms entries were not returned newest-first. ' +
          'Reconciliation stopped without writing.'
        );
      }

      previousDate = created;

      if (created < startDate) {
        crossedCutoff = true;
        continue;
      }

      eligible.push(entry);
    }

    if (crossedCutoff) {
      break;
    }

    if (entries.length < GF_PAGE_SIZE) {
      break;
    }
  }

  eligible.sort(
    function (a, b) {
      var aDate = clean_(a.date_created);
      var bDate = clean_(b.date_created);

      if (aDate < bDate) {
        return -1;
      }
      if (aDate > bDate) {
        return 1;
      }

      return Number(a.id || 0) - Number(b.id || 0);
    }
  );

  return {
    entries: eligible,
    totalCount:
      totalCount === null
        ? eligible.length
        : totalCount,
    reconciliationStartDate: startDate,
    pagesFetched: pagesFetched
  };
}

  /*******************************************************
   * GRAVITY FORMS ENTRY LABEL MAPPING
   *******************************************************/

  function normalizeLabel_(value) {
    return String(
      value === null ||
      value === undefined
        ? ''
        : value
    )
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(
        /[^a-z0-9]+/g,
        ' '
      )
      .replace(
        /\s+/g,
        ' '
      )
      .trim();
  }

  function labelText_(value) {
    if (
      value === null ||
      value === undefined
    ) {
      return '';
    }

    if (
      typeof value === 'string' ||
      typeof value === 'number'
    ) {
      return String(value);
    }

    if (
      typeof value === 'object'
    ) {
      return (
        value.label ||
        value.name ||
        value.text ||
        ''
      );
    }

    return String(value);
  }

  function fetchGravityEntryById_(entryId) {
    var id = clean_(entryId);

    if (!id) {
      throw new Error(
        'GRAVITY_FORMS_ENTRY_ID_REQUIRED | ' +
        'A Gravity Forms entry ID is required.'
      );
    }

    var entry = gfGetJson_(
      'entries/' + encodeURIComponent(id),
      { '_labels': 1 }
    );

    if (
      !entry ||
      clean_(entry.id) !== id
    ) {
      throw new Error(
        'GRAVITY_FORMS_ENTRY_FETCH_MISMATCH | ' +
        'Requested entry ' + id + ' but received a different response.'
      );
    }

    return entry;
  }

  function gfUtcToLocalString_(value) {
    var d = deps_();
    var text = clean_(value);

    if (!text) {
      return '';
    }

    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
      return text;
    }

    var instant = new Date(
      text.replace(' ', 'T') + 'Z'
    );

    if (isNaN(instant.getTime())) {
      return text;
    }

    return d.util.formatDate(
      instant,
      'yyyy-MM-dd HH:mm:ss'
    );
  }

  function gravityLabelItems_(entry) {
    var labels =
      entry &&
      entry._labels &&
      typeof entry._labels === 'object'
        ? entry._labels
        : {};

    var items = [];

    Object.keys(labels).forEach(
      function (parentKey) {
        var raw = labels[parentKey];

        if (
          raw &&
          typeof raw === 'object' &&
          !Array.isArray(raw)
        ) {
          var parentLabel =
            labelText_(raw[parentKey]) ||
            labelText_(raw.label) ||
            labelText_(raw.name) ||
            '';

          if (parentLabel) {
            items.push({
              key: String(parentKey),
              parentKey: String(parentKey),
              label: parentLabel,
              shortLabel: parentLabel,
              isParent: true
            });
          }

          Object.keys(raw).forEach(
            function (childKey) {
              if (
                String(childKey) ===
                String(parentKey)
              ) {
                return;
              }

              var childLabel =
                labelText_(raw[childKey]);

              if (!childLabel) {
                return;
              }

              items.push({
                key: String(childKey),
                parentKey: String(parentKey),
                label: [
                  parentLabel,
                  childLabel
                ].filter(Boolean).join(' '),
                shortLabel: childLabel,
                isParent: false
              });
            }
          );

          return;
        }

        var scalarLabel =
          labelText_(raw);

        if (scalarLabel) {
          items.push({
            key: String(parentKey),
            parentKey: String(parentKey),
            label: scalarLabel,
            shortLabel: scalarLabel,
            isParent: true
          });
        }
      }
    );

    return items;
  }

  function gravityEntryValue_(entry, item, allItems) {
    var direct =
      entry[item.key] === undefined ||
      entry[item.key] === null
        ? ''
        : entry[item.key];

    if (clean_(direct)) {
      return direct;
    }

    /*
     * Checkbox and other multi-input fields can have a
     * parent label but store selected values only under
     * child input IDs. If the parent itself is blank,
     * aggregate the nonblank children in input order.
     */
    if (item.isParent) {
      var values = [];

      (allItems || []).forEach(
        function (candidate) {
          if (
            candidate.isParent ||
            candidate.parentKey !==
              item.parentKey
          ) {
            return;
          }

          var value =
            entry[candidate.key];

          if (clean_(value)) {
            values.push(
              clean_(value)
            );
          }
        }
      );

      if (values.length) {
        return values.join(', ');
      }
    }

    return '';
  }

  function gravityPayloadContentScore_(payload) {
    var keys = [
      'first_name',
      'last_name',
      'phone',
      'alt_phone',
      'email',
      'street',
      'city',
      'postal_code',
      'preferred_days',
      'make_model_age',
      'details',
      'anything_else'
    ];

    return keys.reduce(
      function (count, key) {
        return count +
          (clean_(payload && payload[key])
            ? 1
            : 0);
      },
0
    );
  }

  function webformContentScore_(row) {
    var keys = [
      'Full Name',
      'Phone',
      'Email',
      'Full Address'
    ];

    return keys.reduce(
      function (count, key) {
        var value = clean_(row && row[key]);
        if (
          key === 'Full Address' &&
          /^(ON|ONTARIO),? CANADA$/i.test(value)
        ) {
          value = '';
        }
        return count + (value ? 1 : 0);
      },
0
    );
  }

  function serviceContentScore_(row) {
    var keys = [
      'First Name',
      'Last Name',
      'Phone',
      'Alt Phone',
      'Email',
      'Street',
      'City',
      'Postal Code',
      'Preferred Days',
      'Unit Details',
      'Service Details',
      'Additional Notes'
    ];

    return keys.reduce(
      function (count, key) {
        return count +
          (clean_(row && row[key])
            ? 1
            : 0);
      },
0
    );
  }

  function localWebformPayload_(row) {
    var d = deps_();
    var parsed = d.util.parseJson(
      row && row['Raw Payload'],
      null
    );

    if (
      !parsed ||
      typeof parsed !== 'object'
    ) {
      return null;
    }

    return parsed;
  }

  function localPairNeedsHydration_(webformRow, serviceRow) {
    if (!webformRow || !serviceRow) {
      return false;
    }

    /*
     * The bad reconciliation created shells whose Service
     * Request contained no customer/request content. A score
     * <= 1 is intentionally conservative. Remote data must
     * still pass the content-score guard before any repair.
     */
    return serviceContentScore_(serviceRow) <= 1;
  }

  function payloadForRepair_(entryId, localWebformRow) {
    var localPayload =
      localWebformPayload_(
        localWebformRow
      );

    if (
      localPayload &&
      clean_(localPayload.submission_id) ===
        clean_(entryId) &&
      gravityPayloadContentScore_(
        localPayload
      ) >= 2
    ) {
      return {
        payload: localPayload,
        source: 'LOCAL_WEBFORM_PAYLOAD',
        mappedFieldCount:
          gravityPayloadContentScore_(
            localPayload
          )
      };
    }

    var detailedEntry =
      fetchGravityEntryById_(
        entryId
      );

    var payload =
      gravityEntryToPayload_(
        detailedEntry
      );

    return {
      payload: payload,
      source: 'GRAVITY_FORMS_ENTRY',
      mappedFieldCount:
        gravityPayloadContentScore_(
          payload
        )
    };
  }

    function chooseCampaignCode_(existingValue, payload, rebuiltValue) {
    /* CF_SERVICEOPS_V5_11_6_LANDING_CAMPAIGN_CODE_AUTHORITY_R2 — reconciliation also trusts only explicit payload.campaign_code. */
    var explicit = clean_(payload && payload.campaign_code);
    return explicit ? rebuiltValue : '';
  }

  function rehydrateExistingSubmission_(item) {
    var d = deps_();

    return d.util.withScriptLock(
      function () {
        var submissionId =
          clean_(item.submissionId);

        var webform =
          d.util.findRecord(
            'WEBFORM_REQUESTS',
            'Submission ID',
            submissionId
          );

        var service =
          d.util.findRecord(
            'SERVICE_REQUESTS',
            'Submission ID',
            submissionId
          );

        if (!webform || !service) {
          throw new Error(
            'REHYDRATION_TARGET_MISSING | ' +
            'Submission ' + submissionId +
            ' no longer has both local rows.'
          );
        }

        var requestId =
          clean_(
            webform['Request ID'] ||
            service['Request ID']
          );

        if (!requestId) {
          throw new Error(
            'REHYDRATION_REQUEST_ID_MISSING | ' +
            'Submission ' + submissionId +
            ' has no Request ID to preserve.'
          );
        }

        var payload = {};
        Object.keys(item.payload || {}).forEach(
          function (key) {
            payload[key] =
              item.payload[key];
          }
        );

        var existingCorrelation =
          clean_(
            webform['Correlation ID'] ||
            service['Correlation ID']
          );

        if (existingCorrelation) {
          payload.correlation_id =
            existingCorrelation;
        }

        var receivedAt =
          item.receivedAt ||
          gfUtcToLocalString_(
            payload.submitted_at
          ) ||
          clean_(webform['Received At']) ||
          clean_(service['Created At']) ||
          d.util.nowString();

        var records =
          buildRecords_(
            payload,
            d.util.safeJson(
              payload
            ),
            {
              receivedAt:
                receivedAt,
              requestId:
                requestId,
              sourceSystem:
                clean_(
                  webform['Source System'] ||
                  service['Source System']
                ) || 'WEBFORM',
              sourceRowId:
                webform.__rowNumber
            }
          );

        var now =
          d.util.nowString();

        var webformWasSparse =
          webformContentScore_(
            webform
          ) <= 1 ||
          gravityPayloadContentScore_(
            localWebformPayload_(webform)
          ) <= 1;

        if (webformWasSparse) {
          d.util.patchRow(
            'WEBFORM_REQUESTS',
            webform.__rowNumber,
            {
              'Received At':
                receivedAt,
              'Updated At':
                now,
              'Request ID':
                requestId,
              'Source Row ID':
                webform.__rowNumber,
              'Form ID':
                records.webform['Form ID'],
              'Form Title':
                records.webform['Form Title'],
              'Full Name':
                records.webform['Full Name'],
              'Phone':
                records.webform['Phone'],
              'Email':
                records.webform['Email'],
              'Full Address':
                records.webform['Full Address'],
              'Campaign Code':
                chooseCampaignCode_(
                  webform['Campaign Code'],
                  payload,
                  records.webform['Campaign Code']
                ),
              'Attribution JSON':
                records.webform['Attribution JSON'],
              'Raw Payload':
                records.webform['Raw Payload'],
              'Payload Hash':
                records.webform['Payload Hash'],
              'Processing Status':
                'PROCESSED',
              'Processing Error':
                ''
            }
          );
        }

        d.util.patchRow(
          'SERVICE_REQUESTS',
          service.__rowNumber,
          {
            'Created At':
              receivedAt,
            'Updated At':
              now,
            'Source Row ID':
              webform.__rowNumber,
            'Payload Hash':
              records.service['Payload Hash'],
            'Submitted At':
              records.service['Submitted At'],
            'Campaign Code':
              chooseCampaignCode_(
                service['Campaign Code'],
                payload,
                records.service['Campaign Code']
              ),
            'Attribution JSON':
              records.service['Attribution JSON'],
            'First Name':
              records.service['First Name'],
            'Last Name':
              records.service['Last Name'],
            'Full Name':
              records.service['Full Name'],
            'Phone':
              records.service['Phone'],
            'Phone Extension':
              records.service['Phone Extension'],
            'Alt Phone':
              records.service['Alt Phone'],
            'Normalized Phone':
              records.service['Normalized Phone'],
            'Normalized Alt Phone':
              records.service['Normalized Alt Phone'],
            'Email':
              records.service['Email'],
            'Normalized Email':
              records.service['Normalized Email'],
            'Street':
              records.service['Street'],
            'City':
              records.service['City'],
            'Province':
              records.service['Province'],
            'Postal Code':
              records.service['Postal Code'],
            'Normalized Postal':
              records.service['Normalized Postal'],
            'Country':
              records.service['Country'],
            'Full Address':
              records.service['Full Address'],
            'Normalized Address':
              records.service['Normalized Address'],
            'Preferred Days':
              records.service['Preferred Days'],
            'Unit Details':
              records.service['Unit Details'],
            'Service Details':
              records.service['Service Details'],
            'Additional Notes':
              records.service['Additional Notes']
          }
        );

        return {
          ok: true,
          repaired: true,
          submissionId:
            submissionId,
          requestId:
            requestId,
          webformRow:
            webform.__rowNumber,
          serviceRow:
            service.__rowNumber,
          webformUpdated:
            webformWasSparse,
          mappedFieldCount:
            item.mappedFieldCount,
          mappingSource:
            item.mappingSource
        };
      },
30000
    );
  }

  function entryValueByLabels_(
    entry,
    aliases
  ) {
    var items =
      gravityLabelItems_(
        entry
      );

    var wanted =
      (aliases || [])
        .map(
          normalizeLabel_
        )
        .filter(Boolean);

    var i;
    var j;

    /*
     * Exact label match first. For compound fields we test
     * both the parent-qualified label (e.g. Name First)
     * and the short input label (e.g. First).
     */
    for (
      i = 0;
      i < items.length;
      i++
    ) {
      var exactCandidates = [
        normalizeLabel_(
          items[i].label
        ),
        normalizeLabel_(
          items[i].shortLabel
        )
      ];

      for (
        j = 0;
        j < wanted.length;
        j++
      ) {
        if (
          exactCandidates.indexOf(
            wanted[j]
          ) !== -1
        ) {
          var exactValue =
            gravityEntryValue_(
              entry,
              items[i],
              items
            );

          if (clean_(exactValue)) {
            return exactValue;
          }
        }
      }
    }

    /*
     * Then allow distinctive partial labels such as
     * "Address Street Address" or "Service Details".
     */
    for (
      i = 0;
      i < items.length;
      i++
    ) {
      var label =
        normalizeLabel_(
          items[i].label
        );

      for (
        j = 0;
        j < wanted.length;
        j++
      ) {
        if (
          wanted[j].length >= 5 &&
          label.indexOf(
            wanted[j]
          ) !== -1
        ) {
          var partialValue =
            gravityEntryValue_(
              entry,
              items[i],
              items
            );

          if (clean_(partialValue)) {
            return partialValue;
          }
        }
      }
    }

    return '';
  }

  /*******************************************************
   * GF ENTRY → EXISTING WEBHOOK CONTRACT
   *******************************************************/

  function gravityEntryToPayload_(
    entry
  ) {
    var cfg =
      gfConfig_();

    var created =
      clean_(
        entry.date_created
      );

    var year =
      created &&
      /^\d{4}/.test(
        created
      )
        ? created.slice(
            0,
4
          )
        : '';

    return {
      submission_id:
        clean_(entry.id),
      form_id:
        clean_(
          entry.form_id ||
          cfg.formId
        ),
      form_title:
        cfg.formTitle,
      submitted_at:
        created,
      source_url:
        clean_(entry.source_url),

      first_name:
        entryValueByLabels_(
          entry,
          [
            'Name First',
            'First Name',
            'First'
          ]
        ),
      last_name:
        entryValueByLabels_(
          entry,
          [
            'Name Last',
            'Last Name',
            'Last'
          ]
        ),
      phone:
        entryValueByLabels_(
          entry,
          [
            'Phone',
            'Phone Number',
            'Telephone',
            'Telephone Number',
            'Mobile Phone'
          ]
        ),
      alt_phone:
        entryValueByLabels_(
          entry,
          [
            'Alternative Phone',
            'Alternate Phone',
            'Alt Phone',
            'Secondary Phone'
          ]
        ),
      email:
        entryValueByLabels_(
          entry,
          [
            'Email',
            'Email Address'
          ]
        ),
      street:
        entryValueByLabels_(
          entry,
          [
            'Address Street Address',
            'Street Address',
            'Service Address',
            'Address Line 1'
          ]
        ),
      city:
        entryValueByLabels_(
          entry,
          [
            'Address City',
            'City',
            'Town',
            'Service City'
          ]
        ),
      province:
        entryValueByLabels_(
          entry,
          [
            'Address State Province',
            'State Province',
            'Province',
            'State',
            'Region'
          ]
        ),
      postal_code:
        entryValueByLabels_(
          entry,
          [
            'Address Zip Postal Code',
            'Zip Postal Code',
            'Postal Code',
            'Postcode',
            'Zip Code',
            'Zip'
          ]
        ),
      country:
        entryValueByLabels_(
          entry,
          [
            'Address Country',
            'Country'
          ]
        ),
      campaign_code:
        entryValueByLabels_(
          entry,
          ['Campaign Code']
        ),
      campaign_name:
        entryValueByLabels_(
          entry,
          ['Campaign Name']
        ),
      campaign_year:
        entryValueByLabels_(
          entry,
          ['Campaign Year']
        ) || year,
      utm_source:
        entryValueByLabels_(
          entry,
          [
            'Campaign Source',
            'UTM Source'
          ]
        ),
      utm_medium:
        entryValueByLabels_(
          entry,
          [
            'Campaign Medium',
            'UTM Medium'
          ]
        ),
      utm_campaign:
        entryValueByLabels_(
          entry,
          [
            'UTM Campaign',
            'Campaign Name'
          ]
        ),
      utm_content:
        entryValueByLabels_(
          entry,
          [
            'Campaign Content',
            'UTM Content'
          ]
        ),
      referral_source:
        entryValueByLabels_(
          entry,
          ['Referral Source']
        ),
      referral_code:
        entryValueByLabels_(
          entry,
          ['Referral Code']
        ),
      landing_page:
        entryValueByLabels_(
          entry,
          ['Landing Page']
        ),
      attribution_timestamp:
        entryValueByLabels_(
          entry,
          ['Attribution Timestamp']
        ),
      preferred_days:
        entryValueByLabels_(
          entry,
          [
            'Preferred Days',
            'Preferred Days Selected',
            'Preferred Day',
            'Preferred Dates',
            'Availability',
            'Service Availability'
          ]
        ),
      make_model_age:
        entryValueByLabels_(
          entry,
          [
            'Make Model Age',
            'Make/Model/Age',
            'Make Model Age of Fireplace',
            'Fireplace Details',
            'Manufacturer Model Age'
          ]
        ),
      details:
        entryValueByLabels_(
          entry,
          [
            'Details',
            'Service Details',
            'Problem Details',
            'Description',
            'Service Request'
          ]
        ),
      anything_else:
        entryValueByLabels_(
          entry,
          [
            'Anything Else',
            'Additional Notes',
            'Comments',
            'Other Information'
          ]
        )
    };
  }

  /*******************************************************
   * LOCAL SUBMISSION INDEX
   *******************************************************/

  function localSubmissionIndex_(
    keyOrName
  ) {
    var d = deps_();

    var index = {};

    d.util
      .readRecords(
        keyOrName
      )
      .forEach(
        function (row) {

          var id =
            d.util.cleanText(
              row[
                'Submission ID'
              ]
            );

          if (!id) {
            return;
          }

          if (!index[id]) {
            index[id] = [];
          }

          index[id].push(
            row
          );
        }
      );

    return index;
  }

  /*******************************************************
   * RECONCILIATION PLAN
   *******************************************************/

  function buildReconciliationPlan_() {
    var d = deps_();

    var remote =
      fetchAllGravityEntries_();

    var webforms =
      localSubmissionIndex_(
        'WEBFORM_REQUESTS'
      );

    var services =
      localSubmissionIndex_(
        'SERVICE_REQUESTS'
      );

    var plan = [];

    var counts = {
      gravityEntries:
        remote.entries.length,
      alreadyComplete:
        0,
      missingWebformOnly:
        0,
      missingServiceOnly:
        0,
      missingBoth:
        0,
      incompleteLocalData:
        0,
      mappingFailed:
        0,
      duplicateWebformSubmissionIds:
        0,
      duplicateServiceSubmissionIds:
0
    };

    Object.keys(webforms).forEach(
      function (id) {
        if (webforms[id].length > 1) {
          counts.duplicateWebformSubmissionIds++;
        }
      }
    );

    Object.keys(services).forEach(
      function (id) {
        if (services[id].length > 1) {
          counts.duplicateServiceSubmissionIds++;
        }
      }
    );

    remote.entries.forEach(
      function (entry) {
        var id =
          d.util.cleanText(
            entry.id
          );

        if (!id) {
          return;
        }

        var webformRows =
          webforms[id] || [];
        var serviceRows =
          services[id] || [];

        var hasWebform =
          webformRows.length > 0;
        var hasService =
          serviceRows.length > 0;

        var status = '';
        var repairPayload = null;
        var mappingSource = '';
        var mappedFieldCount = 0;
        var mappingError = '';

        if (
          webformRows.length > 1 ||
          serviceRows.length > 1
        ) {
          status =
            'LOCAL_DUPLICATE_CONFLICT';
          mappingError =
            'Duplicate local Submission ID; automatic repair blocked.';
          counts.mappingFailed++;

        } else if (
          hasWebform &&
          hasService
        ) {
          if (
            localPairNeedsHydration_(
              webformRows[0],
              serviceRows[0]
            )
          ) {
            try {
              var repair =
                payloadForRepair_(
                  id,
                  webformRows[0]
                );

              repairPayload =
                repair.payload;
              mappingSource =
                repair.source;
              mappedFieldCount =
                repair.mappedFieldCount;

              if (
                mappedFieldCount >= 2
              ) {
                status =
                  'INCOMPLETE_LOCAL_DATA';
                counts.incompleteLocalData++;
              } else {
                status =
                  'MAPPING_FAILED';
                mappingError =
                  'Gravity Forms entry was fetched but fewer than two request fields could be mapped.';
                counts.mappingFailed++;
              }
            } catch (error) {
              status =
                'MAPPING_FAILED';
              mappingError =
                error && error.message
                  ? error.message
                  : String(error);
              counts.mappingFailed++;
            }
          } else {
            status =
              'COMPLETE';
            counts.alreadyComplete++;
          }

        } else {
          if (
            !hasWebform &&
            hasService
          ) {
            status =
              'MISSING_WEBFORM';
            counts.missingWebformOnly++;
          } else if (
            hasWebform &&
            !hasService
          ) {
            status =
              'MISSING_SERVICE';
            counts.missingServiceOnly++;
          } else {
            status =
              'MISSING_BOTH';
            counts.missingBoth++;
          }

          try {
            var mapped =
              payloadForRepair_(
                id,
                hasWebform
                  ? webformRows[0]
                  : null
              );

            repairPayload =
              mapped.payload;
            mappingSource =
              mapped.source;
            mappedFieldCount =
              mapped.mappedFieldCount;

            if (
              mappedFieldCount < 2
            ) {
              mappingError =
                'Gravity Forms entry was fetched but fewer than two request fields could be mapped.';
              counts.mappingFailed++;
              status =
                'MAPPING_FAILED';
            }
          } catch (error) {
            mappingError =
              error && error.message
                ? error.message
                : String(error);
            counts.mappingFailed++;
            status =
              'MAPPING_FAILED';
          }
        }

        if (
          status !== 'COMPLETE'
        ) {
          plan.push({
            submissionId:
              id,
            status:
              status,
            dateCreated:
              clean_(entry.date_created),
            receivedAt:
              gfUtcToLocalString_(
                entry.date_created
              ),
            payload:
              repairPayload,
            mappingSource:
              mappingSource,
            mappedFieldCount:
              mappedFieldCount,
            mappingError:
              mappingError
          });
        }
      }
    );

    return {
      ok: true,
      version: VERSION,
      totalCountReportedByGravityForms:
        remote.totalCount,
      reconciliationWindow: {
        startDate:
          remote.reconciliationStartDate,
        eligibleEntries:
          remote.entries.length,
        pagesFetched:
          remote.pagesFetched
      },
      counts:
        counts,
      missingCount:
        plan.length,
      plan:
        plan
    };
  }

  /*******************************************************
   * DRY-RUN RECONCILIATION
   *******************************************************/

  function previewGravityFormsReconciliation() {
    return buildReconciliationPlan_();
  }

  /*******************************************************
   * EXECUTE RECONCILIATION
   *******************************************************/

  function reconcileGravityForms(
    options
  ) {
    options = options || {};

    var d = deps_();
    var started = Date.now();
    var preview =
      buildReconciliationPlan_();
    var results = [];

    var maxWrites =
      Number(
        options.maxWrites ||
        RECONCILE_MAX_WRITES
      );

    for (
      var i = 0;
      i < preview.plan.length;
      i++
    ) {
      if (
        results.length >=
        maxWrites
      ) {
        break;
      }

      if (
        Date.now() - started >=
        RECONCILE_RUNTIME_LIMIT_MS
      ) {
        break;
      }

      var item =
        preview.plan[i];

      try {
        if (
          item.status ===
            'MAPPING_FAILED' ||
          item.status ===
            'LOCAL_DUPLICATE_CONFLICT' ||
          !item.payload ||
          item.mappedFieldCount < 2
        ) {
          throw new Error(
            item.mappingError ||
            'Gravity Forms entry did not pass the mapping safety guard.'
          );
        }

        var result;

        if (
          item.status ===
            'INCOMPLETE_LOCAL_DATA'
        ) {
          result =
            rehydrateExistingSubmission_(
              item
            );
        } else {
          result =
            receivePayload(
              item.payload,
              {
                raw:
                  d.util.safeJson(
                    item.payload
                  ),
                sourceSystem:
                  'WEBFORM',
                reconciliation:
                  true,
                fast:
                  false,
                receivedAt:
                  item.receivedAt
              }
            );
        }

        results.push({
          ok: true,
          submissionId:
            item.submissionId,
          priorStatus:
            item.status,
          mappedFieldCount:
            item.mappedFieldCount,
          mappingSource:
            item.mappingSource,
          result:
            result
        });

      } catch (error) {
        results.push({
          ok: false,
          submissionId:
            item.submissionId,
          priorStatus:
            item.status,
          mappedFieldCount:
            item.mappedFieldCount,
          mappingSource:
            item.mappingSource,
          error:
            error && error.message
              ? error.message
              : String(error)
        });
      }
    }

    var after =
      buildReconciliationPlan_();

    var summary = {
      ok:
        results.every(
          function (item) {
            return item.ok;
          }
        ) &&
        after.missingCount === 0,
      version:
        VERSION,
      processed:
        results.length,
      succeeded:
        results.filter(
          function (item) {
            return item.ok;
          }
        ).length,
      failed:
        results.filter(
          function (item) {
            return !item.ok;
          }
        ).length,
      remaining:
        after.missingCount,
      before:
        preview.counts,
      after:
        after.counts,
      durationMs:
        Date.now() - started,
      results:
        results
    };

    d.util.logEvent({
      module:
        MODULE_NAME,
      action:
        'GRAVITY_FORMS_RECONCILIATION',
      status:
        summary.ok
          ? 'COMPLETE'
          : (
              summary.failed
                ? 'PARTIAL_WITH_ERRORS'
                : 'PARTIAL'
            ),
      message:
        summary.ok
          ? 'Gravity Forms reconciliation completed.'
          : 'Gravity Forms reconciliation requires another pass or review.',
      details: {
        processed:
          summary.processed,
        succeeded:
          summary.succeeded,
        failed:
          summary.failed,
        remaining:
          summary.remaining,
        before:
          summary.before,
        after:
          summary.after
      },
      durationMs:
        summary.durationMs,
      version:
        VERSION
    });

    return summary;
  }

  /*******************************************************
   * RECENT GRAVITY FORMS BACKSTOP
   *
   * Lightweight production safety net for a missed webhook.
   * Reads only the newest Gravity Forms page and writes only
   * genuinely missing/incomplete local submissions.
   *******************************************************/
  function reconcileRecentGravityForms(options) {
    options = options || {};
    var d = deps_();
    var started = Date.now();
    var maxWrites = Math.max(1, Math.min(10, Number(options.maxWrites || 5)));
    var pageSize = Math.max(10, Math.min(50, Number(options.pageSize || 25)));
    var runtimeLimitMs = Math.max(15000, Math.min(90000, Number(options.runtimeLimitMs || 60000)));
    var cfg = gfConfig_();

    var body = gfGetJson_(
      'forms/' + encodeURIComponent(cfg.formId) + '/entries',
      {
        '_labels': 1,
        'paging[page_size]': pageSize,
        'paging[current_page]': 1,
        'sorting[key]': 'date_created',
        'sorting[direction]': 'DESC',
        'sorting[is_numeric]': 'false'
      }
    );

    var entries = Array.isArray(body.entries) ? body.entries : [];
    var webforms = localSubmissionIndex_('WEBFORM_REQUESTS');
    var services = localSubmissionIndex_('SERVICE_REQUESTS');
    var candidates = [];
    var results = [];

    entries.forEach(function(entry) {
      var id = clean_(entry && entry.id);
      if (!id) return;
      var wf = webforms[id] || [];
      var sr = services[id] || [];
      if (wf.length > 1 || sr.length > 1) {
        candidates.push({submissionId:id,status:'LOCAL_DUPLICATE_CONFLICT'});
        return;
      }
      if (wf.length && sr.length && !localPairNeedsHydration_(wf[0], sr[0])) {
        if (clean_(sr[0]['Current Stage']).toUpperCase() === 'NEW INTAKE' && clean_(sr[0]['Request ID'])) {
          candidates.push({
            submissionId:id,
            status:'LOCAL_REQUEST_PENDING',
            entry:entry,
            webformRow:wf[0],
            serviceRow:sr[0],
            requestId:clean_(sr[0]['Request ID'])
          });
        }
        return;
      }
      candidates.push({
        submissionId:id,
        status: wf.length && sr.length ? 'INCOMPLETE_LOCAL_DATA'
          : (!wf.length && !sr.length ? 'MISSING_BOTH'
            : (!wf.length ? 'MISSING_WEBFORM' : 'MISSING_SERVICE')),
        entry:entry,
        webformRow:wf.length ? wf[0] : null,
        serviceRow:sr.length ? sr[0] : null
      });
    });

    for (var i = 0; i < candidates.length; i++) {
      if (results.length >= maxWrites || Date.now() - started >= runtimeLimitMs) break;
      var item = candidates[i];
      if (item.status === 'LOCAL_DUPLICATE_CONFLICT') {
        results.push({ok:false,submissionId:item.submissionId,status:item.status,error:'Duplicate local Submission ID; automatic recovery blocked.'});
        continue;
      }
      try {
        if (item.status === 'LOCAL_REQUEST_PENDING') {
          var pendingKick = CF.EventDrivenServiceAutomation && typeof CF.EventDrivenServiceAutomation.kick === 'function'
            ? CF.EventDrivenServiceAutomation.kick(item.requestId)
            : {ok:false,status:'CANONICAL_AUTOMATION_KICK_UNAVAILABLE',scheduled:false};
          results.push({
            ok:pendingKick && pendingKick.ok !== false,
            submissionId:item.submissionId,
            priorStatus:item.status,
            requestId:item.requestId,
            resultStatus:'EXISTING_NEW_INTAKE_KICKED',
            automationKickStatus:clean_(pendingKick && pendingKick.status)
          });
          continue;
        }

        var mapped = null;
        var localPayload = localWebformPayload_(item.webformRow);
        if (localPayload &&
            clean_(localPayload.submission_id) === item.submissionId &&
            gravityPayloadContentScore_(localPayload) >= 2) {
          mapped = {payload:localPayload,source:'LOCAL_WEBFORM_PAYLOAD'};
        } else {
          var payload = gravityEntryToPayload_(item.entry);
          var mappingSource = 'GRAVITY_FORMS_RECENT_PAGE';
          if (gravityPayloadContentScore_(payload) < 2) {
            // Collection entries can lack the labels needed by the webhook mapper.
            // Reuse the ID-verified individual-entry recovery path before stopping.
            var repair = payloadForRepair_(item.submissionId, item.webformRow);
            payload = repair.payload;
            mappingSource = repair.source;
          }
          if (gravityPayloadContentScore_(payload) < 2) {
            throw new Error('RECENT_GF_MAPPING_INSUFFICIENT | fewer than two request fields mapped.');
          }
          mapped = {payload:payload,source:mappingSource};
        }

        var out = item.status === 'INCOMPLETE_LOCAL_DATA'
          ? rehydrateExistingSubmission_({
              submissionId:item.submissionId,
              status:item.status,
              payload:mapped.payload,
              receivedAt:gfUtcToLocalString_(item.entry.date_created)
            })
          : receivePayload(mapped.payload, {
              raw:d.util.safeJson(mapped.payload),
              sourceSystem:'WEBFORM',
              reconciliation:true,
              fast:true,
              receivedAt:gfUtcToLocalString_(item.entry.date_created)
            });

        var recoveredRequestId=clean_(out && out.requestId);
        var automationKick = recoveredRequestId && CF.EventDrivenServiceAutomation && typeof CF.EventDrivenServiceAutomation.kick === 'function'
          ? CF.EventDrivenServiceAutomation.kick(recoveredRequestId)
          : {ok:false,status:recoveredRequestId?'CANONICAL_AUTOMATION_KICK_UNAVAILABLE':'REQUEST_ID_UNAVAILABLE',scheduled:false};

        results.push({
          ok:true,
          submissionId:item.submissionId,
          priorStatus:item.status,
          mappingSource:mapped.source,
          requestId:recoveredRequestId,
          resultStatus:clean_(out && out.status),
          automationKickStatus:clean_(automationKick && automationKick.status)
        });
      } catch (error) {
        results.push({
          ok:false,
          submissionId:item.submissionId,
          priorStatus:item.status,
          error:error && error.message ? error.message : String(error)
        });
      }
    }

    var recoveredRequestIds = results.filter(function(x){return x.ok && x.requestId;}).map(function(x){return x.requestId;});
    var summary = {
      ok:results.every(function(x){return x.ok;}),
      version:VERSION,
      status:results.length ? 'RECENT_GF_BACKSTOP_PROCESSED' : 'RECENT_GF_BACKSTOP_NO_GAPS',
      newestRemoteSubmissionId:entries.length ? clean_(entries[0].id) : '',
      recentEntriesChecked:entries.length,
      candidateCount:candidates.length,
      processed:results.length,
      recoveredRequestIds:recoveredRequestIds,
      results:results,
      durationMs:Date.now()-started,
      liveStrivenWriteExecuted:false
    };

    try {
      if (results.length) d.util.logEvent({
        module:MODULE_NAME,
        action:'RECENT_GF_BACKSTOP',
        status:summary.ok ? 'COMPLETE' : 'PARTIAL',
        details:summary,
        durationMs:summary.durationMs,
        version:VERSION
      });
    } catch (ignored) {}

    return summary;
  }

  /*******************************************************
   * MODULE API
   *******************************************************/

  return {
    postProcessPending: postProcessPending,
    version:
      VERSION,

    receivePayload:
      receivePayload,

    handlePost:
      handlePost,

    repairNewestFirst: repairNewestFirst,
    inspectState:
      inspectState,

    previewGravityFormsReconciliation:
      previewGravityFormsReconciliation,

    reconcileGravityForms:
      reconcileGravityForms,

    reconcileRecentGravityForms:
      reconcileRecentGravityForms,

    inspectGravityEntryMapping: function(entryId) {
      var id = clean_(entryId);
      if (!/^\d+$/.test(id)) throw new Error('GRAVITY_FORMS_ENTRY_ID_REQUIRED');
      var cfg = gfConfig_();
      var entry = fetchGravityEntryById_(id);
      if (clean_(entry.form_id) !== clean_(cfg.formId)) throw new Error('GRAVITY_FORMS_ENTRY_FORM_MISMATCH');
      var payload = gravityEntryToPayload_(entry);
      var webforms = localSubmissionIndex_('WEBFORM_REQUESTS');
      var services = localSubmissionIndex_('SERVICE_REQUESTS');
      var readiness = CF.StrivenData.inspectReadiness();
      var requestIds = (services[id]||[]).map(function(r){return clean_(r['Request ID']);});
      var logUtil = deps_().util;
      var logSheet = logUtil.requireSheet('SYSTEM_LOG');
      var logHeaders = logUtil.getActualHeaders(logSheet);
      var logLastRow = logSheet.getLastRow();
      var logStartRow = Math.max(2, logLastRow - 99);
      var logRows = logLastRow >= 2 ? logSheet.getRange(logStartRow, 1, logLastRow - logStartRow + 1, logHeaders.length).getValues().map(function(row){return logUtil.rowToRecord(logHeaders, row, 0);}) : [];
      var trace = logRows.filter(function(r){return requestIds.indexOf(clean_(r['Request ID'])) !== -1;}).slice(-12).map(function(r){
        var details = deps_().util.parseJson(r['Details JSON'], {}) || {};
        return {at:clean_(r['Timestamp']),action:clean_(r['Action']),status:clean_(r['Status']),durationMs:r['Duration Ms'],stepLabel:details.stepLabel||'',resultStatus:details.resultStatus||'',fromStage:details.fromStage||'',toStage:details.toStage||''};
      });
      return {
        ok:true,
        submissionId:id,
        formId:clean_(entry.form_id),
        mappedFieldCount:gravityPayloadContentScore_(payload),
        labels:gravityLabelItems_(entry).map(function(x){return {key:x.key,label:x.label};}),
        populatedInputIds:Object.keys(entry).filter(function(k){return /^\d+(\.\d+)?$/.test(k) && !!clean_(entry[k]);}),
        populatedPayloadKeys:Object.keys(payload).filter(function(k){return !!clean_(payload[k]);}),
        webformRowCount:(webforms[id]||[]).length,
        serviceRows:(services[id]||[]).map(function(r){return {requestId:clean_(r['Request ID']),stage:clean_(r['Current Stage']),status:clean_(r['Request Status']),nextAction:clean_(r['Next Action'])};}),
        matchingReadiness:{ok:readiness.ok,counts:readiness.counts,fresh:readiness.fresh,requiredMissing:readiness.requiredMissing},
        automation:CF.EventDrivenServiceAutomation.inspect(),
        trace:trace,
        liveWriteExecuted:false
      };
    }
  };
})();


/*******************************************************
 * INTENTIONAL PUBLIC RUNNERS
 *
 * Only two new dropdown functions are added.
 *******************************************************/

function GF_previewReconciliation() {
  var result = CF.Intake
    .previewGravityFormsReconciliation();

  var compact = {
    ok: result.ok,
    version: result.version,
    totalCountReportedByGravityForms:
      result.totalCountReportedByGravityForms,
    reconciliationWindow:
      result.reconciliationWindow,
    counts: result.counts,
    missingCount: result.missingCount,
    plan: (result.plan || []).map(
      function (item) {
        return {
          submissionId:
            item.submissionId,
          status:
            item.status,
          dateCreated:
            item.dateCreated,
          receivedAt:
            item.receivedAt,
          mappingSource:
            item.mappingSource,
          mappedFieldCount:
            item.mappedFieldCount,
          mappingError:
            item.mappingError || ''
        };
      }
    )
  };

  console.log(
    'Gravity Forms reconciliation preview: ' +
    JSON.stringify(compact, null, 2)
  );

  return result;
}


function GF_reconcileAllEntries() {
  var result = CF.Intake
    .reconcileGravityForms();

  var compact = {
    ok: result.ok,
    version: result.version,
    processed: result.processed,
    succeeded: result.succeeded,
    failed: result.failed,
    remaining: result.remaining,
    before: result.before,
    after: result.after,
    durationMs: result.durationMs,
    failures: (result.results || [])
      .filter(
        function (item) {
          return !item.ok;
        }
      )
      .map(
        function (item) {
          return {
            submissionId: item.submissionId,
            priorStatus: item.priorStatus,
            error: item.error
          };
        }
      )
  };

  console.log(
    'Gravity Forms reconciliation result: ' +
    JSON.stringify(compact, null, 2)
  );

  return result;
}



function GF_saveRestApiCredentials() {
  var ui = SpreadsheetApp.getUi();

  var keyResponse = ui.prompt(
    'Gravity Forms REST API',
    'Paste the Consumer Key:',
    ui.ButtonSet.OK_CANCEL
  );

  if (
    keyResponse.getSelectedButton() !==
    ui.Button.OK
  ) {
    return {
      ok: false,
      status: 'CANCELLED'
    };
  }

  var secretResponse = ui.prompt(
    'Gravity Forms REST API',
    'Paste the Consumer Secret:',
    ui.ButtonSet.OK_CANCEL
  );

  if (
    secretResponse.getSelectedButton() !==
    ui.Button.OK
  ) {
    return {
      ok: false,
      status: 'CANCELLED'
    };
  }

  var consumerKey =
    String(
      keyResponse.getResponseText() || ''
    ).trim();

  var consumerSecret =
    String(
      secretResponse.getResponseText() || ''
    ).trim();

  if (
    !consumerKey ||
    !consumerSecret
  ) {
    throw new Error(
      'Consumer Key and Consumer Secret are required.'
    );
  }

  PropertiesService
    .getScriptProperties()
    .setProperties({
      GRAVITY_FORMS_BASE_URL:
        'https://www.classicfireplace.ca',

      GRAVITY_FORMS_SERVICE_FORM_ID:
        '2',

      GRAVITY_FORMS_CONSUMER_KEY:
        consumerKey,

      GRAVITY_FORMS_CONSUMER_SECRET:
        consumerSecret
    });

  return {
    ok: true,
    status: 'GRAVITY_FORMS_REST_CONFIGURED',
    baseUrl:
      'https://www.classicfireplace.ca',
    formId: '2'
  };
}


function queryString_(params) {
  if (!params || typeof params !== 'object') {
    return '';
  }

  var parts = [];

  Object.keys(params).forEach(function(key) {
    var value = params[key];

    if (value === undefined || value === null) {
      return;
    }

    var values = Array.isArray(value) ? value : [value];

    values.forEach(function(item) {
      if (item === undefined || item === null) {
        return;
      }

      parts.push(
        encodeURIComponent(String(key)) +
        '=' +
        encodeURIComponent(String(item))
      );
    });
  });

  return parts.join('&');
}

/* CF_SERVICEOPS_V5_14_1_CANONICAL_INTAKE_R1
 * Intake owns only durable receipt/normalization and the request-scoped kick.
 * It does not refresh Striven reports or run batch matching.
 * The webhook's existing CF.EventDrivenServiceAutomation.kick(requestId) call
 * hands the durable request to AUTO_FINAL_ServiceOps.
 */


/* CF_SERVICEOPS_V5_14_4_RECENT_GF_BACKSTOP_R1 */
function AUTO_00_GF_Intake_Backstop() {
  if (!CF || !CF.Intake || typeof CF.Intake.reconcileRecentGravityForms !== 'function') {
    throw new Error('RECENT_GF_BACKSTOP_UNAVAILABLE');
  }
  return CF.Intake.reconcileRecentGravityForms({maxWrites:5,pageSize:25,runtimeLimitMs:60000});
}

