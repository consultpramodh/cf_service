/************************************************************
 * APPS SCRIPT — 75_Customer_360_AI.gs
 * CF ServiceOps — Optional Customer 360 OpenAI Enrichment
 * Version: 5.14.4
 *
 * SAFETY
 * - Runs only after deterministic Customer 360 creation.
 * - Sends a minimized, sanitized factual payload.
 * - Never sends phone, email, full address, credentials or raw rows.
 * - Never establishes or changes authoritative relationships.
 * - Never calculates or invents financial values.
 * - AI failures never block factual Customer 360 output.
 ************************************************************/
var CF = CF || {};

CF.Customer360AI = (function () {
  'use strict';

  var MODULE_NAME = '75_Customer_360_AI';
  var VERSION = '5.14.4';
  var API_URL = 'https://api.openai.com/v1/responses';
  var EXPECTED_KEYS = [
    'customerOverview',
    'serviceHistorySummary',
    'equipmentSummary',
    'openWorkSummary',
    'recommendedOperatorReview',
    'missingDataCategories',
    'contradictions',
    'confidence'
  ];

  function deps_() {
    if (!CF.Config || !CF.Util || !CF.Customer360) {
      throw new Error('CF.Config, CF.Util and CF.Customer360 are required.');
    }
    return { config: CF.Config, util: CF.Util, customer360: CF.Customer360 };
  }

  function clean_(value) {
    return deps_().util.cleanText(value);
  }

  function configuration_() {
    var d = deps_();
    var properties = PropertiesService.getScriptProperties();
    var key = properties.getProperty('ServiceOps_OpenAI_API_Key') || '';
    var enabled = d.util.toBoolean(properties.getProperty('ServiceOps_OpenAI_Enabled'), false);
    var model = clean_(properties.getProperty('ServiceOps_OpenAI_Model'));
    var maxProfiles = Math.max(1, Number(properties.getProperty('ServiceOps_OpenAI_Max_Profiles_Per_Run') || d.config.getDefault('OPENAI_MAX_PROFILES_PER_RUN') || 25));
    var maxInputCharacters = Math.max(1000, Number(properties.getProperty('ServiceOps_OpenAI_Max_Input_Characters') || d.config.getDefault('OPENAI_MAX_INPUT_CHARACTERS') || 12000));
    var timeoutMs = Math.max(1000, Number(properties.getProperty('ServiceOps_OpenAI_Timeout_Ms') || d.config.getDefault('OPENAI_TIMEOUT_MS') || 120000));
    return {
      key: key,
      configured: Boolean(key),
      enabled: enabled,
      model: model,
      maxProfiles: maxProfiles,
      maxInputCharacters: maxInputCharacters,
      timeoutMs: timeoutMs
    };
  }

  function sanitizeText_(value, maximumLength) {
    var text = clean_(value);
    if (!text) return '';
    text = text
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL REMOVED]')
      .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[PHONE REMOVED]')
      .replace(/\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b/gi, '[POSTAL REMOVED]')
      .replace(/\bSerial(?: Number| #)?\s*[:#-]?\s*[A-Z0-9-]+/gi, '[SERIAL REMOVED]')
      .replace(/\b(?:Customer|Location|Asset|Work Order|WO|Task|Invoice|Opportunity)\s*(?:ID|#)?\s*[:#-]?\s*[A-Z0-9-]+/gi, '[IDENTIFIER REMOVED]');
    if (maximumLength && text.length > maximumLength) text = text.substring(0, maximumLength);
    return text;
  }

  function sanitizedInput_(profile, maxCharacters) {
    var d = deps_();
    var payload = {
      profileKey: clean_(profile['Profile Key']),
      customerDisplayName: sanitizeText_(profile['Customer Name'], 200),
      customerStatus: sanitizeText_(profile['Customer Status'], 100),
      assetSummary: sanitizeText_(profile['Assets Summary'], 2500),
      serviceHistory: sanitizeText_(profile['Service History Summary'], 4000),
      openWork: sanitizeText_(profile['Existing Work Summary'], 2500),
      opportunitySummary: sanitizeText_(profile['Opportunity Summary'], 1500),
      currentRequestContext: {
        stage: sanitizeText_(profile['Latest Request Stage'], 120),
        status: sanitizeText_(profile['Latest Request Status'], 120),
        nextAction: sanitizeText_(profile['Latest Next Action'], 300)
      },
      missingDataCategories: clean_(profile['Missing Data Categories']).split(',').map(clean_).filter(Boolean),
      relationshipStatus: clean_(profile['Relationship Status']),
      relationshipWarnings: sanitizeText_(profile['Relationship Warnings'], 1000)
    };
    var json = d.util.canonicalJson(payload);
    if (json.length <= maxCharacters) return payload;

    var fieldsToTrim = ['serviceHistory', 'openWork', 'assetSummary', 'opportunitySummary'];
    var remaining = maxCharacters;
    fieldsToTrim.forEach(function (field) {
      var current = clean_(payload[field]);
      var allowance = Math.max(300, Math.floor(remaining / Math.max(1, fieldsToTrim.length)));
      payload[field] = current.substring(0, allowance);
      remaining -= payload[field].length;
    });
    return payload;
  }

  function inputFingerprint_(payload) {
    return deps_().util.fingerprint(payload);
  }

  function eligibility_(profile, config) {
    var payload = sanitizedInput_(profile, config.maxInputCharacters);
    var fingerprint = inputFingerprint_(payload);
    if (!clean_(profile['Profile Key']) || !clean_(profile['Factual Profile Fingerprint'])) {
      return { eligible: false, reason: 'MISSING FACTUAL FINGERPRINT', payload: payload, fingerprint: fingerprint };
    }
    if (clean_(profile['Relationship Status']) !== 'CONFIRMED') {
      return { eligible: false, reason: 'UNRESOLVED RELATIONSHIP', payload: payload, fingerprint: fingerprint };
    }
    if (clean_(profile['AI Enrichment Status']) === 'GENERATED' && clean_(profile['AI Input Fingerprint']) === fingerprint) {
      return { eligible: false, reason: 'UNCHANGED', payload: payload, fingerprint: fingerprint };
    }
    return { eligible: true, reason: 'READY', payload: payload, fingerprint: fingerprint };
  }

  function previewAIEnrichment() {
    var config = configuration_();
    var profiles = deps_().customer360.getProfilesForAI();
    var eligible = 0;
    var unchanged = 0;
    var alreadyEnriched = 0;
    var blocked = 0;
    var estimatedCharacters = 0;

    profiles.forEach(function (profile) {
      var e = eligibility_(profile, config);
      if (clean_(profile['AI Enrichment Status']) === 'GENERATED') alreadyEnriched++;
      if (e.eligible) {
        eligible++;
        estimatedCharacters += deps_().util.canonicalJson(e.payload).length;
      } else if (e.reason === 'UNCHANGED') unchanged++;
      else blocked++;
    });

    var missingConfiguration = [];
    var blockingErrors = [];
    var warnings = [];
    if (!config.configured) missingConfiguration.push('ServiceOps_OpenAI_API_Key');
    if (config.enabled && !config.model) missingConfiguration.push('ServiceOps_OpenAI_Model');
    if (config.enabled && !config.configured) blockingErrors.push('AI enrichment is enabled but the API key is missing.');
    if (config.enabled && !config.model) blockingErrors.push('AI enrichment is enabled but no model is configured.');
    if (!config.enabled) warnings.push('AI enrichment is disabled.');
    if (eligible > config.maxProfiles) warnings.push('Eligible profiles exceed the per-run cap; only the configured maximum will be processed.');

    return {
      ok: blockingErrors.length === 0,
      version: VERSION,
      openAIConfigured: config.configured ? 'YES' : 'NO',
      aiEnrichmentEnabled: config.enabled ? 'YES' : 'NO',
      selectedModel: config.model,
      profilesEligible: eligible,
      profilesUnchanged: unchanged,
      profilesAlreadyEnriched: alreadyEnriched,
      profilesBlockedByDeterministicValidation: blocked,
      estimatedRequestCount: Math.min(eligible, config.maxProfiles),
      estimatedSanitizedInputCharacters: estimatedCharacters,
      configuredMaxProfilesPerRun: config.maxProfiles,
      configuredMaxInputCharacters: config.maxInputCharacters,
      configuredTimeoutMs: config.timeoutMs,
      missingConfiguration: missingConfiguration,
      blockingErrors: blockingErrors,
      warnings: warnings
    };
  }

  function schema_() {
    return {
      type: 'object',
      additionalProperties: false,
      required: EXPECTED_KEYS.slice(),
      properties: {
        customerOverview: { type: 'string' },
        serviceHistorySummary: { type: 'string' },
        equipmentSummary: { type: 'string' },
        openWorkSummary: { type: 'string' },
        recommendedOperatorReview: { type: 'string' },
        missingDataCategories: { type: 'array', items: { type: 'string' } },
        contradictions: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] }
      }
    };
  }

  function requestPayload_(config, sanitizedInput) {
    return {
      model: config.model,
      store: false,
      instructions: [
        'Summarize only the supplied deterministic facts for an internal service operator.',
        'Do not establish relationships, invent identifiers, invent dates, invent amounts, calculate finances, or recommend creating or writing records.',
        'Do not repeat phone, email, postal code, street address, credentials, URLs, or other personal identifiers.',
        'Treat unresolved or missing facts as missing. Return only the required JSON schema.'
      ].join(' '),
      input: deps_().util.canonicalJson(sanitizedInput),
      text: {
        format: {
          type: 'json_schema',
          name: 'customer_360_enrichment',
          strict: true,
          schema: schema_()
        }
      }
    };
  }

  function extractOutputText_(body) {
    if (!body) return '';
    if (typeof body.output_text === 'string') return body.output_text;
    var output = body.output || [];
    for (var i = 0; i < output.length; i++) {
      var content = output[i] && output[i].content ? output[i].content : [];
      for (var j = 0; j < content.length; j++) {
        if (typeof content[j].text === 'string') return content[j].text;
        if (content[j].text && typeof content[j].text.value === 'string') return content[j].text.value;
      }
    }
    return '';
  }

  function errorCategory_(status, text) {
    if (status === 401 || status === 403) return 'AUTHENTICATION';
    if (status === 408 || status === 504) return 'TIMEOUT';
    if (status === 429) return 'RATE_LIMIT';
    if (status >= 500) return 'REMOTE_SERVER';
    if (/json/i.test(text || '')) return 'RESPONSE_JSON';
    return 'REQUEST_FAILED';
  }

  function validateOutput_(output) {
    var d = deps_();
    var errors = [];
    if (!output || typeof output !== 'object' || Array.isArray(output)) return { ok: false, errors: ['NOT AN OBJECT'] };
    var keys = Object.keys(output).sort();
    if (d.util.canonicalJson(keys) !== d.util.canonicalJson(EXPECTED_KEYS.slice().sort())) errors.push('UNEXPECTED OR MISSING FIELDS');
    ['customerOverview', 'serviceHistorySummary', 'equipmentSummary', 'openWorkSummary', 'recommendedOperatorReview'].forEach(function (key) {
      if (typeof output[key] !== 'string') errors.push(key + ' MUST BE STRING');
    });
    ['missingDataCategories', 'contradictions'].forEach(function (key) {
      if (!Array.isArray(output[key]) || output[key].some(function (item) { return typeof item !== 'string'; })) errors.push(key + ' MUST BE STRING ARRAY');
    });
    if (['HIGH', 'MEDIUM', 'LOW'].indexOf(output.confidence) === -1) errors.push('INVALID CONFIDENCE');

    var combined = EXPECTED_KEYS.map(function (key) {
      return Array.isArray(output[key]) ? output[key].join(' ') : clean_(output[key]);
    }).join(' ');
    if (/[$€£]|\b(?:USD|CAD|dollars?|revenue|invoice total|amount paid)\s*[:=]?\s*\d/i.test(combined)) errors.push('FINANCIAL VALUE DETECTED');
    if (/\b(?:customer|work order|task|invoice|asset)\s*(?:id|#)\s*[:#-]?\s*[A-Z0-9-]+/i.test(combined)) errors.push('IDENTIFIER DETECTED');
    if (/\b(?:create|approve|write|delete|merge)\s+(?:a\s+)?(?:customer|contact|location|asset|opportunity|work order|task|invoice|record)/i.test(combined)) errors.push('PROHIBITED ACTION INSTRUCTION');
    if (combined.length > 12000) errors.push('OUTPUT TOO LONG');
    return { ok: errors.length === 0, errors: errors };
  }

  function callOpenAI_(config, sanitizedInput) {
    var payload = requestPayload_(config, sanitizedInput);
    var response = UrlFetchApp.fetch(API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + config.key, Accept: 'application/json' },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var status = response.getResponseCode();
    var text = response.getContentText();
    if (status < 200 || status >= 300) {
      var requestError = new Error(errorCategory_(status, text));
      requestError.category = errorCategory_(status, text);
      throw requestError;
    }
    var body = deps_().util.parseJson(text, null);
    if (!body) {
      var jsonError = new Error('RESPONSE_JSON');
      jsonError.category = 'RESPONSE_JSON';
      throw jsonError;
    }
    var outputText = extractOutputText_(body);
    var output = deps_().util.parseJson(outputText, null);
    if (!output) {
      var outputError = new Error('OUTPUT_JSON');
      outputError.category = 'OUTPUT_JSON';
      throw outputError;
    }
    return output;
  }

  function applyOutput_(profile, output, config, fingerprint) {
    profile['AI Customer Overview'] = clean_(output.customerOverview);
    profile['AI Service History Summary'] = clean_(output.serviceHistorySummary);
    profile['AI Equipment Summary'] = clean_(output.equipmentSummary);
    profile['AI Open Work Summary'] = clean_(output.openWorkSummary);
    profile['AI Review Recommendation'] = clean_(output.recommendedOperatorReview);
    profile['AI Missing Data Categories'] = (output.missingDataCategories || []).map(clean_).filter(Boolean).join(', ');
    profile['AI Contradictions'] = (output.contradictions || []).map(clean_).filter(Boolean).join('\n');
    profile['AI Confidence'] = output.confidence;
    profile['AI Model'] = config.model;
    profile['AI Generated At'] = deps_().util.nowString();
    profile['AI Input Fingerprint'] = fingerprint;
    profile['AI Enrichment Status'] = 'GENERATED';
    profile['AI Enrichment Error'] = '';
  }

  function setFailure_(profile, status, category, fingerprint, model) {
    profile['AI Model'] = model || '';
    profile['AI Input Fingerprint'] = fingerprint || '';
    profile['AI Enrichment Status'] = status;
    profile['AI Enrichment Error'] = category || '';
  }

  function writeAIColumns_(profiles) {
    var d = deps_();
    var sheet = d.util.requireSheet('CUSTOMER_360');
    var map = d.util.getActualHeaderMap(sheet);
    var headers = d.customer360.getAIHeaders();
    var start = map[headers[0]];
    if (!start || !headers.every(function (header, index) { return map[header] === start + index; })) {
      throw new Error('Customer 360 AI columns are missing or not contiguous.');
    }
    if (!profiles.length) return { rows: 0, columns: headers.length };
    var values = profiles.map(function (profile) {
      return headers.map(function (header) { return profile[header] || ''; });
    });
    sheet.getRange(2, start, values.length, headers.length).setValues(values);
    return { rows: values.length, columns: headers.length };
  }

  function enrichPendingProfiles(options) {
    options = options || {};
    var d = deps_();
    return d.util.withScriptLock(function () {
      var config = configuration_();
      var preview = previewAIEnrichment();
      if (!config.enabled) return { ok: false, status: 'NOT REQUESTED', preview: preview, processed: 0 };
      if (!config.configured || !config.model) return { ok: false, status: 'NOT CONFIGURED', preview: preview, processed: 0 };
      var factualValidation = d.customer360.validate();
      if (!factualValidation.ok) return { ok: false, status: 'BLOCKED', preview: preview, factualValidation: factualValidation, processed: 0 };

      var profiles = d.customer360.getProfilesForAI();
      var processed = 0;
      var generated = 0;
      var skipped = 0;
      var rejected = 0;
      var errors = 0;
      var resultDetails = [];

      for (var i = 0; i < profiles.length; i++) {
        var profile = profiles[i];
        var e = eligibility_(profile, config);
        if (!e.eligible) {
          skipped++;
          if (e.reason !== 'UNCHANGED') setFailure_(profile, 'SKIPPED', e.reason, e.fingerprint, config.model);
          continue;
        }
        if (processed >= config.maxProfiles) {
          setFailure_(profile, 'READY', '', e.fingerprint, config.model);
          continue;
        }
        processed++;
        try {
          var output = callOpenAI_(config, e.payload);
          var validation = validateOutput_(output);
          if (!validation.ok) {
            rejected++;
            setFailure_(profile, 'REJECTED', validation.errors.join('; '), e.fingerprint, config.model);
            resultDetails.push({ profileKey: clean_(profile['Profile Key']), status: 'REJECTED', category: 'OUTPUT_VALIDATION' });
          } else {
            applyOutput_(profile, output, config, e.fingerprint);
            generated++;
            resultDetails.push({ profileKey: clean_(profile['Profile Key']), status: 'GENERATED' });
          }
        } catch (error) {
          errors++;
          setFailure_(profile, 'ERROR', error.category || 'REQUEST_FAILED', e.fingerprint, config.model);
          resultDetails.push({ profileKey: clean_(profile['Profile Key']), status: 'ERROR', category: error.category || 'REQUEST_FAILED' });
        }
      }

      var write = writeAIColumns_(profiles);
      var validationAfter = validateAIEnrichment();
      var result = {
        ok: errors === 0 && rejected === 0,
        version: VERSION,
        processed: processed,
        generated: generated,
        skipped: skipped,
        rejected: rejected,
        errors: errors,
        write: write,
        validation: validationAfter,
        details: resultDetails,
        completedAt: d.util.nowString()
      };
      d.util.safeLogEvent({
        module: MODULE_NAME,
        eventType: 'CUSTOMER_360_AI_ENRICHMENT',
        decision: result.ok ? 'PASS' : 'REVIEW',
        reason: 'Optional Customer 360 AI enrichment completed.',
        metadata: { processed: processed, generated: generated, skipped: skipped, rejected: rejected, errors: errors, model: config.model }
      });
      return result;
    }, options.lockTimeoutMs);
  }

  function validateAIEnrichment() {
    var d = deps_();
    var profiles = d.customer360.getProfilesForAI();
    var errors = [];
    var warnings = [];
    var generated = 0;
    profiles.forEach(function (profile) {
      var key = clean_(profile['Profile Key']);
      var status = clean_(profile['AI Enrichment Status']);
      if (status === 'GENERATED') {
        generated++;
        if (!clean_(profile['AI Input Fingerprint'])) errors.push(key + ': generated output has no input fingerprint.');
        if (!clean_(profile['AI Model'])) errors.push(key + ': generated output has no model.');
        if (!clean_(profile['AI Generated At'])) errors.push(key + ': generated output has no timestamp.');
        if (clean_(profile['Relationship Status']) !== 'CONFIRMED') errors.push(key + ': generated output exists for an unresolved relationship.');
        if (clean_(profile['AI Enrichment Error'])) errors.push(key + ': generated output also has an error.');
      }
      if (status === 'ERROR' || status === 'REJECTED') warnings.push(key + ': ' + status + ' — ' + clean_(profile['AI Enrichment Error']));
    });
    return {
      ok: errors.length === 0,
      version: VERSION,
      profiles: profiles.length,
      generated: generated,
      errors: errors,
      warnings: warnings
    };
  }

  return {
    moduleName: MODULE_NAME,
    version: VERSION,
    previewAIEnrichment: previewAIEnrichment,
    enrichPendingProfiles: enrichPendingProfiles,
    validateAIEnrichment: validateAIEnrichment,
    validateStructuredOutput: validateOutput_,
    buildSanitizedInput: function (profile) {
      var config = configuration_();
      return sanitizedInput_(profile || {}, config.maxInputCharacters);
    }
  };
})();
