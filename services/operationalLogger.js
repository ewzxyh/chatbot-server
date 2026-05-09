var winston = require('../config/winston');
var OperationalEvent = require('../models/operationalEvent');

var MAX_STRING_LENGTH = 500;
var MAX_ARRAY_ITEMS = 20;
var MAX_DEPTH = 5;

var SENSITIVE_KEY_REGEX = /(token|secret|password|authorization|jwt|cookie|rawbody|payload|webhooksecret|apikey|api_key|access_token|refresh_token)/i;
var CONTENT_KEY_REGEX = /^(text|body|message|content|caption|json_message|whatsappBody)$/i;
var PHONE_KEY_REGEX = /(phone|from|to|recipient|sender|number)/i;
var URL_KEY_REGEX = /(url|uri|link|href)/i;
var SENSITIVE_URL_PARAM_REGEX = /(signature|token|access|auth|key|credential|expires|policy|x-amz|x-goog)/i;

function truncateString(value) {
  if (value.length <= MAX_STRING_LENGTH) return value;
  return value.substring(0, MAX_STRING_LENGTH) + '...';
}

function maskDigits(value) {
  if (typeof value !== 'string') return value;
  var digitCount = (value.match(/\d/g) || []).length;
  if (digitCount < 8) return truncateString(value);
  return truncateString(value.replace(/\d(?=(?:\D*\d){4})/g, '*'));
}

function sanitizeUrl(value, key) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return value;
  try {
    var parsed = new URL(value);
    var hasSensitiveQuery = Array.from(parsed.searchParams.keys()).some(function(param) {
      return SENSITIVE_URL_PARAM_REGEX.test(param);
    });
    if (URL_KEY_REGEX.test(key || '') || hasSensitiveQuery) {
      return truncateString(parsed.origin + parsed.pathname + (parsed.search ? '?[Redacted query]' : ''));
    }
  } catch (err) {}
  return truncateString(value);
}

function sanitizeValue(value, key, depth) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[Truncated]';

  if (SENSITIVE_KEY_REGEX.test(key || '')) {
    return '[Redacted]';
  }

  if (CONTENT_KEY_REGEX.test(key || '')) {
    return '[Redacted content]';
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(value.message || ''),
      code: value.code,
      status: value.response && value.response.status
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map(function(item) {
      return sanitizeValue(item, key, depth + 1);
    });
  }

  if (typeof value === 'object') {
    var sanitized = {};
    Object.keys(value).forEach(function(childKey) {
      sanitized[childKey] = sanitizeValue(value[childKey], childKey, depth + 1);
    });
    return sanitized;
  }

  if (typeof value === 'string') {
    var sanitizedUrl = sanitizeUrl(value, key);
    if (sanitizedUrl !== value) return sanitizedUrl;
    if (PHONE_KEY_REGEX.test(key || '')) return maskDigits(value);
    return truncateString(value);
  }

  return value;
}

function sanitize(input) {
  return sanitizeValue(input || {}, '', 0);
}

function extractErrorMessage(err) {
  if (!err) return undefined;
  if (err.response && err.response.data) {
    if (typeof err.response.data === 'string') return truncateString(err.response.data);
    if (err.response.data.error) return truncateString(String(err.response.data.error));
    if (err.response.data.message) return truncateString(String(err.response.data.message));
  }
  return truncateString(err.message || String(err));
}

function extractErrorCode(err) {
  if (!err) return undefined;
  return err.code || (err.response && err.response.status ? String(err.response.status) : undefined);
}

function normalizeEvent(event) {
  event = event || {};
  var level = event.level || 'info';
  if (['debug', 'info', 'warn', 'error'].indexOf(level) === -1) {
    level = 'info';
  }

  return {
    timestamp: event.timestamp || new Date(),
    level: level,
    area: event.area || 'system',
    channel: event.channel || 'system',
    id_project: event.id_project ? String(event.id_project) : undefined,
    integrationId: event.integrationId ? String(event.integrationId) : undefined,
    requestId: event.requestId ? String(event.requestId) : undefined,
    messageId: event.messageId ? String(event.messageId) : undefined,
    event: event.event || 'operation.event',
    status: event.status || 'success',
    latencyMs: typeof event.latencyMs === 'number' ? event.latencyMs : undefined,
    errorCode: event.errorCode || extractErrorCode(event.error),
    errorMessage: event.errorMessage || extractErrorMessage(event.error),
    details: sanitize(event.details || {})
  };
}

async function record(event) {
  var doc = normalizeEvent(event);
  var logPayload = Object.assign({}, doc);
  delete logPayload.details;
  if (doc.details && Object.keys(doc.details).length) {
    logPayload.details = doc.details;
  }

  try {
    winston[doc.level]('[operation] ' + JSON.stringify(logPayload));
  } catch (logErr) {
    winston.warn('[operation] unable to serialize log payload: ' + logErr.message);
  }

  try {
    return await OperationalEvent.create(doc);
  } catch (err) {
    winston.warn('[operation] unable to save operational event: ' + err.message);
    return doc;
  }
}

function recordSafe(event) {
  record(event).catch(function(err) {
    winston.warn('[operation] recordSafe failed: ' + err.message);
  });
}

module.exports = {
  record: record,
  recordSafe: recordSafe,
  sanitize: sanitize,
  normalizeEvent: normalizeEvent,
  extractErrorMessage: extractErrorMessage,
  extractErrorCode: extractErrorCode
};
