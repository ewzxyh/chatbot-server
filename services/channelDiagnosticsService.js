var axios = require('axios');
var mongoose = require('mongoose');
var { v4: uuidv4 } = require('uuid');
var Integration = require('../models/integrations');
var operationalLogger = require('./operationalLogger');

var DEFAULT_TIMEOUT_MS = parseInt(process.env.OPERATIONAL_PROVIDER_CHECK_TIMEOUT_MS || '8000', 10);
var CACHE_TTL_MINUTES = parseInt(process.env.OPERATIONAL_PROVIDER_CHECK_TTL_MINUTES || '10', 10);
var META_GRAPH_URL = process.env.META_GRAPH_URL || process.env.GRAPH_URL || 'https://graph.facebook.com/v25.0/';
if (isNaN(DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS < 1000) DEFAULT_TIMEOUT_MS = 8000;
if (isNaN(CACHE_TTL_MINUTES) || CACHE_TTL_MINUTES < 1) CACHE_TTL_MINUTES = 10;

var DOWN_WORDS = [
  'banned',
  'bannedm',
  'ban',
  'suspended',
  'blocked',
  'disabled',
  'deactivated',
  'deleted',
  'disconnected',
  'offline',
  'closed',
  'logout',
  'logged_out',
  'not_logged',
  'failed'
];

var DEGRADED_WORDS = [
  'restricted',
  'rate_limited',
  'rate limited',
  'limited',
  'flagged',
  'capped',
  'timelock',
  'pending',
  'connecting',
  'yellow',
  'red',
  'declined',
  'rejected',
  'review'
];

var OK_WORDS = [
  'active',
  'connected',
  'open',
  'ok',
  'green',
  'approved',
  'verified'
];

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

function wordsMatch(value, words) {
  var normalized = normalizeText(value);
  if (!normalized) return false;
  return words.some(function(word) {
    return normalized.indexOf(word) !== -1;
  });
}

function highestStatus(current, candidate) {
  var weight = { ok: 0, unknown: 1, degraded: 2, down: 3 };
  return weight[candidate] > weight[current] ? candidate : current;
}

function collectStatusHints(input, prefix, out) {
  out = out || [];
  if (input === null || input === undefined) return out;

  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    if (!prefix || /(status|state|quality|reason|error|code|limit|logged|connected|banned|ban|restricted)/i.test(prefix)) {
      out.push({ key: prefix || 'value', value: input });
    }
    return out;
  }

  if (Array.isArray(input)) {
    input.slice(0, 25).forEach(function(item, index) {
      collectStatusHints(item, prefix + '[' + index + ']', out);
    });
    return out;
  }

  if (typeof input === 'object') {
    Object.keys(input).forEach(function(key) {
      if (/token|secret|authorization|payload|body|message|text|caption/i.test(key)) return;
      collectStatusHints(input[key], prefix ? prefix + '.' + key : key, out);
    });
  }

  return out;
}

function firstHintValue(hints, regex) {
  for (var i = 0; i < hints.length; i++) {
    if (regex.test(hints[i].key)) return hints[i].value;
  }
  return null;
}

function normalizeProviderHealth(input, options) {
  options = options || {};
  var hints = collectStatusHints(input, '', []);
  var status = 'unknown';
  var reason = options.defaultReason || 'provider_status_unknown';
  var providerStatus = firstHintValue(hints, /(instance\.status|data\.state|^status$|\.status$|phone_status|connection)/i);
  var providerCode = firstHintValue(hints, /(error_key|error\.code|code|reason)/i);

  hints.forEach(function(hint) {
    var value = hint.value;
    if (wordsMatch(value, DOWN_WORDS)) {
      status = highestStatus(status, 'down');
      reason = 'provider_status_' + normalizeText(value).replace(/\s+/g, '_');
      if (!providerStatus) providerStatus = value;
      return;
    }
    if (wordsMatch(value, DEGRADED_WORDS)) {
      status = highestStatus(status, 'degraded');
      reason = 'provider_status_' + normalizeText(value).replace(/\s+/g, '_');
      if (!providerStatus) providerStatus = value;
      return;
    }
    if (wordsMatch(value, OK_WORDS)) {
      status = highestStatus(status, 'ok');
      if (reason === 'provider_status_unknown') reason = 'provider_status_ok';
      if (!providerStatus) providerStatus = value;
    }
  });

  if (input && input.status) {
    if (input.status.connected === false || input.status.loggedIn === false) {
      status = highestStatus(status, 'down');
      if (reason === 'provider_status_unknown' || reason === 'provider_status_ok') {
        reason = input.status.connected === false ? 'provider_not_connected' : 'provider_not_logged_in';
      }
      providerStatus = providerStatus || 'disconnected';
    }
    if (input.status.connected === true && input.status.loggedIn !== false && status === 'unknown') {
      status = 'ok';
      reason = 'provider_status_ok';
      providerStatus = providerStatus || 'connected';
    }
  }

  if (input && input.can_send_new_messages === false) {
    status = highestStatus(status, 'degraded');
    reason = input.error_key || 'provider_cannot_send_new_messages';
    providerCode = input.error_key || providerCode;
  }

  if (input && input.new_chat_message_capping && input.new_chat_message_capping.status) {
    if (normalizeText(input.new_chat_message_capping.status) !== 'available') {
      status = highestStatus(status, 'degraded');
      reason = 'provider_message_capping_' + normalizeText(input.new_chat_message_capping.status);
    }
  }

  if (input && input.reachout_timelock && input.reachout_timelock.active === true) {
    status = highestStatus(status, 'degraded');
    reason = input.reachout_timelock.enforcement_type || 'provider_reachout_timelock';
  }

  if (input && input.quality_rating) {
    var quality = normalizeText(input.quality_rating);
    if (quality === 'red' || quality === 'low') {
      status = highestStatus(status, 'degraded');
      reason = 'provider_quality_red';
    } else if (quality === 'yellow' || quality === 'medium') {
      status = highestStatus(status, 'degraded');
      reason = 'provider_quality_yellow';
    } else if ((quality === 'green' || quality === 'high') && status === 'unknown') {
      status = 'ok';
      reason = 'provider_status_ok';
    }
  }

  if (options.connectedFallback === true && status === 'unknown') {
    status = 'ok';
    reason = 'provider_status_ok';
  }

  return {
    status: status,
    providerStatus: providerStatus ? String(providerStatus) : null,
    providerCode: providerCode ? String(providerCode) : null,
    reason: reason
  };
}

function buildCaseZapBaseUrl(integration) {
  var value = integration.value || {};
  return value.domain || value.baseUrl || value.url || value.endpoint || null;
}

function getCaseZapToken(integration) {
  var value = integration.value || {};
  return value.token || value.apiToken || value.apikey || value.api_key || null;
}

function publicApiBaseUrl(options) {
  options = options || {};
  var baseUrl = options.baseUrl || process.env.EXTERNAL_BASE_URL || process.env.API_URL || '';
  return String(baseUrl).replace(/\/+$/, '') + '/api';
}

function ensureTrailingSlash(url) {
  if (!url) return url;
  return url.charAt(url.length - 1) === '/' ? url : url + '/';
}

function graphUrl() {
  var url = process.env.META_GRAPH_URL || process.env.GRAPH_URL || META_GRAPH_URL;
  return ensureTrailingSlash(url);
}

function isValidObjectId(value) {
  return value && mongoose.Types.ObjectId.isValid(String(value));
}

function objectId(value) {
  return mongoose.Types.ObjectId(String(value));
}

function kvstoreCollection() {
  return mongoose.connection.collection('kvstore');
}

function isKvstoreIntegration(integration) {
  return integration && integration._source === 'kvstore';
}

function buildKvstoreWabaIntegration(row) {
  if (!row) return null;
  var value = row.value || {};
  return {
    _id: row._id,
    _kvstoreId: row._id,
    _kvstoreKey: row.key,
    _source: 'kvstore',
    name: 'whatsapp',
    id_project: row.project_id || value.id_project || value.project_id,
    value: Object.assign({}, value, {
      operational: value.operational || {},
      verified_name: value.verified_name || value.business_name || value.name || value.display_phone_number || value.phone_number
    })
  };
}

function kvstoreWabaSearchClauses(identifier) {
  var value = String(identifier || '');
  var clauses = [
    { key: value },
    { 'value.waba_id': value },
    { 'value.phone_number_id': value }
  ];

  if (isValidObjectId(value)) {
    clauses.unshift({ _id: objectId(value) });
  }

  return clauses;
}

async function findKvstoreWabaIntegration(identifier) {
  if (!identifier) return null;
  var row = await kvstoreCollection().findOne({ $or: kvstoreWabaSearchClauses(identifier) });
  return buildKvstoreWabaIntegration(row);
}

async function listKvstoreWabaIntegrations() {
  var rows = await kvstoreCollection().find({
    $or: [
      { key: /^whatsapp-/ },
      { 'value.waba_id': { $exists: true } },
      { 'value.phone_number_id': { $exists: true } }
    ]
  }).toArray();

  return rows.map(buildKvstoreWabaIntegration).filter(function(integration) {
    var value = integration && integration.value ? integration.value : {};
    return integration && integration.id_project && (value.waba_id || value.phone_number_id || value.wab_token || value.access_token);
  });
}

async function findChannelIntegration(channel, integrationId) {
  var names = channel === 'casezap' ? ['casezap'] : ['whatsapp'];
  var integration = null;

  if (isValidObjectId(integrationId)) {
    integration = await Integration.findOne({ _id: integrationId, name: { $in: names } });
  }

  if (!integration && channel !== 'casezap') {
    integration = await findKvstoreWabaIntegration(integrationId);
  }

  return integration;
}

function requestHeaders(token) {
  return {
    token: token,
    Authorization: 'Bearer ' + token
  };
}

function compactError(err) {
  if (!err) return null;
  return {
    message: operationalLogger.extractErrorMessage(err),
    code: operationalLogger.extractErrorCode(err),
    status: err.response && err.response.status
  };
}

function isCacheFresh(integration) {
  var operational = integration.value && integration.value.operational;
  if (!operational || !operational.lastProviderCheckAt) return false;
  var checkedAt = new Date(operational.lastProviderCheckAt).getTime();
  if (!checkedAt) return false;
  return Date.now() - checkedAt < CACHE_TTL_MINUTES * 60 * 1000;
}

function cachedResult(integration) {
  var value = integration.value || {};
  var operational = value.operational || {};
  return {
    status: operational.lastProviderHealth || 'unknown',
    providerHealth: operational.lastProviderHealth || 'unknown',
    providerStatus: operational.lastProviderStatus || value.status || null,
    providerCode: operational.lastProviderCode || null,
    providerReason: operational.lastProviderReason || null,
    providerCheckedAt: operational.lastProviderCheckAt || null,
    providerLatencyMs: operational.lastProviderLatencyMs,
    providerError: operational.lastProviderError || null,
    qualityRating: operational.qualityRating,
    nameStatus: operational.nameStatus,
    canSendNewMessages: operational.canSendNewMessages,
    cached: true
  };
}

async function updateIntegrationOperational(integration, result, extra) {
  if (!integration || !integration._id) return;
  var set = {
    'value.operational.lastProviderCheckAt': result.providerCheckedAt,
    'value.operational.lastProviderHealth': result.providerHealth,
    'value.operational.lastProviderStatus': result.providerStatus,
    'value.operational.lastProviderCode': result.providerCode,
    'value.operational.lastProviderReason': result.providerReason,
    'value.operational.lastProviderLatencyMs': result.providerLatencyMs,
    'value.operational.lastProviderError': result.providerError || null
  };

  Object.keys(extra || {}).forEach(function(key) {
    set['value.operational.' + key] = extra[key];
  });

  if (integration.name === 'casezap') {
    if (result.providerHealth === 'ok') {
      set['value.status'] = 'active';
    } else if (result.providerHealth === 'down') {
      set['value.status'] = 'disconnected';
    }
  }

  if (isKvstoreIntegration(integration)) {
    await kvstoreCollection().updateOne({ _id: integration._kvstoreId || integration._id }, { $set: set });
    return;
  }

  await Integration.findByIdAndUpdate(integration._id, { $set: set });
}

async function updateWebhookRegistration(integration, status, details) {
  if (!integration || !integration._id) return;
  details = details || {};
  var set = {
    'value.operational.lastWebhookRegistrationAt': nowIso(),
    'value.operational.lastWebhookRegistrationStatus': status,
    'value.operational.lastWebhookRegistrationError': details.error || null
  };

  if (details.webhookSecret) set['value.webhookSecret'] = details.webhookSecret;
  if (details.webhookUrl) set['value.operational.lastWebhookRegistrationUrl'] = details.webhookUrl;

  if (isKvstoreIntegration(integration)) {
    await kvstoreCollection().updateOne({ _id: integration._kvstoreId || integration._id }, { $set: set });
    return;
  }

  await Integration.findByIdAndUpdate(integration._id, { $set: set });
}

function baseResult(integration, health, startedAt, extra) {
  extra = extra || {};
  return Object.assign({
    channel: integration.name === 'casezap' ? 'casezap' : 'waba',
    integrationId: String(integration._id),
    id_project: integration.id_project,
    status: health.status,
    providerHealth: health.status,
    providerStatus: health.providerStatus,
    providerCode: health.providerCode,
    providerReason: health.reason,
    providerCheckedAt: nowIso(),
    providerLatencyMs: Date.now() - startedAt,
    providerError: null
  }, extra);
}

async function checkCaseZapIntegration(integration, options) {
  options = options || {};
  if (!options.force && isCacheFresh(integration)) return cachedResult(integration);

  var startedAt = Date.now();
  var baseUrl = buildCaseZapBaseUrl(integration);
  var token = getCaseZapToken(integration);
  if (!baseUrl || !token) {
    var missing = baseResult(integration, {
      status: 'unknown',
      providerStatus: null,
      providerCode: 'missing_config',
      reason: !baseUrl ? 'missing_casezap_domain' : 'missing_casezap_token'
    }, startedAt);
    await updateIntegrationOperational(integration, missing);
    return missing;
  }

  try {
    var statusRes = await axios.get(ensureTrailingSlash(baseUrl) + 'instance/status', {
      headers: requestHeaders(token),
      timeout: DEFAULT_TIMEOUT_MS
    });

    var limitsBody = null;
    var limitsError = null;
    try {
      var limitsRes = await axios.get(ensureTrailingSlash(baseUrl) + 'instance/wa_messages_limits', {
        headers: requestHeaders(token),
        timeout: DEFAULT_TIMEOUT_MS
      });
      limitsBody = limitsRes.data || {};
    } catch (err) {
      limitsError = compactError(err);
    }

    var statusBody = statusRes.data || {};
    var combined = Object.assign({}, statusBody, {
      limits: limitsBody,
      can_send_new_messages: limitsBody && limitsBody.can_send_new_messages,
      error_key: limitsBody && limitsBody.error_key,
      new_chat_message_capping: limitsBody && limitsBody.new_chat_message_capping,
      reachout_timelock: limitsBody && limitsBody.reachout_timelock
    });
    var health = normalizeProviderHealth(combined);
    var result = baseResult(integration, health, startedAt, {
      canSendNewMessages: limitsBody ? limitsBody.can_send_new_messages : undefined,
      limitsError: limitsError
    });
    await updateIntegrationOperational(integration, result, {
      canSendNewMessages: result.canSendNewMessages,
      limitsError: limitsError
    });
    return result;
  } catch (err) {
    var error = compactError(err);
    var failed = baseResult(integration, {
      status: 'down',
      providerStatus: 'unreachable',
      providerCode: error && error.code,
      reason: 'provider_unreachable'
    }, startedAt, {
      providerError: error && error.message
    });
    await updateIntegrationOperational(integration, failed);
    return failed;
  }
}

async function findWhatsappSettings(integration) {
  var value = integration.value || {};
  var collection = kvstoreCollection();
  var clauses = [];

  if (isKvstoreIntegration(integration)) {
    if (integration._kvstoreId) clauses.push({ _id: integration._kvstoreId });
    if (integration._kvstoreKey) clauses.push({ key: integration._kvstoreKey });
  }

  if (value.waba_id) clauses.push({ key: 'whatsapp-' + value.waba_id });
  if (value.phone_number_id) clauses.push({ 'value.phone_number_id': value.phone_number_id });
  if (value.waba_id) clauses.push({ 'value.waba_id': value.waba_id });
  if (integration.id_project) clauses.push({ key: 'whatsapp-' + integration.id_project });
  if (integration.id_project) clauses.push({ project_id: integration.id_project });

  if (!clauses.length) return null;
  return collection.findOne({ $or: clauses });
}

async function requestMetaPhoneInfo(phoneNumberId, token) {
  var url = graphUrl() + phoneNumberId;
  var fields = 'display_phone_number,verified_name,quality_rating,platform_type,status,name_status,is_official_business_account,code_verification_status,messaging_limit_tier,throughput';
  try {
    var res = await axios.get(url, {
      params: {
        fields: fields,
        access_token: token
      },
      timeout: DEFAULT_TIMEOUT_MS
    });
    return res.data || {};
  } catch (err) {
    if (err.response && err.response.status === 400) {
      var fallback = await axios.get(url, {
        params: {
          fields: 'display_phone_number,verified_name,quality_rating,status,name_status',
          access_token: token
        },
        timeout: DEFAULT_TIMEOUT_MS
      });
      return fallback.data || {};
    }
    throw err;
  }
}

async function checkWabaIntegration(integration, options) {
  options = options || {};
  if (!options.force && isCacheFresh(integration)) return cachedResult(integration);

  var startedAt = Date.now();
  var settings = await findWhatsappSettings(integration);
  var settingsValue = settings && settings.value ? settings.value : {};
  var integrationValue = integration.value || {};
  var token = settingsValue.wab_token || settingsValue.access_token;
  var phoneNumberId = settingsValue.phone_number_id || integrationValue.phone_number_id;

  if (!token || !phoneNumberId) {
    var missing = baseResult(integration, {
      status: 'unknown',
      providerStatus: null,
      providerCode: 'missing_config',
      reason: !phoneNumberId ? 'missing_waba_phone_number_id' : 'missing_waba_token'
    }, startedAt);
    await updateIntegrationOperational(integration, missing);
    return missing;
  }

  try {
    var info = await requestMetaPhoneInfo(phoneNumberId, token);
    var health = normalizeProviderHealth(info, { connectedFallback: true });
    var providerStatus = info.status || health.providerStatus || 'connected';
    var result = baseResult(integration, {
      status: health.status,
      providerStatus: providerStatus,
      providerCode: health.providerCode,
      reason: health.reason
    }, startedAt, {
      qualityRating: info.quality_rating,
      nameStatus: info.name_status,
      platformType: info.platform_type,
      messagingLimitTier: info.messaging_limit_tier
    });
    await updateIntegrationOperational(integration, result, {
      qualityRating: info.quality_rating,
      nameStatus: info.name_status,
      platformType: info.platform_type,
      messagingLimitTier: info.messaging_limit_tier
    });
    return result;
  } catch (err) {
    var error = compactError(err);
    var failed = baseResult(integration, {
      status: 'down',
      providerStatus: 'unreachable',
      providerCode: error && error.code,
      reason: 'provider_unreachable'
    }, startedAt, {
      providerError: error && error.message
    });
    await updateIntegrationOperational(integration, failed);
    return failed;
  }
}

async function checkIntegration(integration, options) {
  if (!integration || (integration.name !== 'casezap' && integration.name !== 'whatsapp')) {
    return {
      status: 'unknown',
      providerHealth: 'unknown',
      providerReason: 'unsupported_channel'
    };
  }
  if (integration.name === 'casezap') return checkCaseZapIntegration(integration, options);
  return checkWabaIntegration(integration, options);
}

async function testChannelConnection(channel, integrationId) {
  var integration = await findChannelIntegration(channel, integrationId);
  if (!integration) {
    var err = new Error('Integration not found');
    err.statusCode = 404;
    throw err;
  }

  var result = await checkIntegration(integration, { force: true });
  await operationalLogger.record({
    level: result.providerHealth === 'down' ? 'error' : (result.providerHealth === 'degraded' ? 'warn' : 'info'),
    area: 'provider_check',
    channel: result.channel,
    id_project: result.id_project,
    integrationId: result.integrationId,
    event: 'channel.provider_check',
    status: result.providerHealth === 'ok' ? 'success' : 'failed',
    latencyMs: result.providerLatencyMs,
    errorCode: result.providerCode,
    errorMessage: result.providerHealth === 'ok' ? undefined : result.providerReason,
    details: {
      providerStatus: result.providerStatus,
      providerHealth: result.providerHealth,
      providerReason: result.providerReason,
      qualityRating: result.qualityRating,
      nameStatus: result.nameStatus,
      canSendNewMessages: result.canSendNewMessages
    }
  });
  return result;
}

async function registerCaseZapWebhook(integration, options) {
  var startedAt = Date.now();
  var baseUrl = buildCaseZapBaseUrl(integration);
  var token = getCaseZapToken(integration);

  if (!baseUrl || !token) {
    var missing = new Error(!baseUrl ? 'missing_casezap_domain' : 'missing_casezap_token');
    missing.statusCode = 400;
    throw missing;
  }

  var webhookSecret = REDACTED_SECRET || uuidv4();
  var webhookUrl = publicApiBaseUrl(options) + '/modules/casezap/webhook/' + integration._id + '?secret=' + webhookSecret;
  var body = {
    url: webhookUrl,
    enabled: true,
    events: ['messages', 'messages_update', 'connection'],
    excludeMessages: ['wasSentByApi', 'isGroupYes']
  };

  await axios.post(ensureTrailingSlash(baseUrl) + 'webhook', body, {
    headers: { token: token, 'Content-Type': 'application/json' },
    timeout: DEFAULT_TIMEOUT_MS
  });

  await updateWebhookRegistration(integration, 'success', {
    webhookSecret: webhookSecret,
    webhookUrl: webhookUrl
  });

  return {
    status: 'registered',
    channel: 'casezap',
    integrationId: String(integration._id),
    id_project: integration.id_project,
    providerLatencyMs: Date.now() - startedAt,
    webhookUrl: webhookUrl.replace(/\?.*$/, '?[redacted]')
  };
}

async function registerWabaWebhook(integration) {
  var startedAt = Date.now();
  var settings = await findWhatsappSettings(integration);
  var value = settings && settings.value ? settings.value : {};
  var token = value.wab_token || value.access_token;
  var wabaId = value.waba_id || (integration.value && integration.value.waba_id);

  if (!token || !wabaId) {
    var missing = new Error(!wabaId ? 'missing_waba_id' : 'missing_waba_token');
    missing.statusCode = 400;
    throw missing;
  }

  await axios.post(graphUrl() + wabaId + '/subscribed_apps', {}, {
    params: { access_token: token },
    timeout: DEFAULT_TIMEOUT_MS
  });

  await updateWebhookRegistration(integration, 'success');

  return {
    status: 'registered',
    channel: 'waba',
    integrationId: String(integration._id),
    providerIntegrationId: wabaId,
    id_project: integration.id_project,
    providerLatencyMs: Date.now() - startedAt
  };
}

async function registerChannelWebhook(channel, integrationId, options) {
  var integration = await findChannelIntegration(channel, integrationId);
  if (!integration) {
    var notFound = new Error('Integration not found');
    notFound.statusCode = 404;
    throw notFound;
  }

  try {
    var result = channel === 'casezap'
      ? await registerCaseZapWebhook(integration, options)
      : await registerWabaWebhook(integration);

    await operationalLogger.record({
      level: 'info',
      area: 'webhook',
      channel: result.channel,
      id_project: result.id_project,
      integrationId: result.integrationId,
      event: 'channel.webhook_registered',
      status: 'success',
      latencyMs: result.providerLatencyMs,
      details: {
        providerIntegrationId: result.providerIntegrationId,
        webhookUrl: result.webhookUrl
      }
    });

    return result;
  } catch (err) {
    await updateWebhookRegistration(integration, 'failed', {
      error: operationalLogger.extractErrorMessage(err)
    });
    await operationalLogger.record({
      level: 'error',
      area: 'webhook',
      channel: channel,
      id_project: integration.id_project,
      integrationId: String(integration._id),
      event: 'channel.webhook_register_failed',
      status: 'failed',
      error: err
    });
    throw err;
  }
}

module.exports = {
  checkIntegration: checkIntegration,
  checkCaseZapIntegration: checkCaseZapIntegration,
  checkWabaIntegration: checkWabaIntegration,
  testChannelConnection: testChannelConnection,
  registerChannelWebhook: registerChannelWebhook,
  listKvstoreWabaIntegrations: listKvstoreWabaIntegrations,
  normalizeProviderHealth: normalizeProviderHealth
};
