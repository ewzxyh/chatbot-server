var axios = require('axios');
var emailService = require('./emailService');
var operationalLogger = require('./operationalLogger');
var superAdminService = require('./superAdminService');
var winston = require('../config/winston');

var DEFAULT_EVENTS = 'alert.opened,alert.reopened,alert.still_open';
var DEFAULT_EMAIL_EVENTS = 'alert.opened,alert.reopened';
var DEFAULT_TIMEOUT_MS = 5000;
var MAX_TEXT_LENGTH = 500;
var SEVERITY_RANK = {
  info: 1,
  warning: 2,
  critical: 3
};

function parseList(value) {
  return String(value || '')
    .split(/[,\s;]+/)
    .map(function(item) {
      return item.trim();
    })
    .filter(Boolean);
}

function isTrue(value) {
  return value === true || value === 'true' || value === '1' || value === 'yes';
}

function normalizeSeverity(severity) {
  severity = String(severity || 'info').toLowerCase();
  return SEVERITY_RANK[severity] ? severity : 'info';
}

function getMinSeverity(env) {
  var configured = normalizeSeverity(env.OPERATIONAL_ALERT_MIN_SEVERITY || 'critical');
  return configured;
}

function passesSeverity(alert, env) {
  var alertSeverity = normalizeSeverity(alert && alert.severity);
  var minSeverity = getMinSeverity(env);
  return SEVERITY_RANK[alertSeverity] >= SEVERITY_RANK[minSeverity];
}

function isEventEnabled(eventName, envKey, env) {
  var fallbackEvents = envKey === 'OPERATIONAL_ALERT_EMAIL_EVENTS' ? DEFAULT_EMAIL_EVENTS : DEFAULT_EVENTS;
  var configuredEvents = env[envKey];
  if (!configuredEvents && envKey !== 'OPERATIONAL_ALERT_EMAIL_EVENTS') {
    configuredEvents = env.OPERATIONAL_ALERT_EVENTS;
  }
  var events = parseList(configuredEvents || fallbackEvents);
  return events.indexOf('*') !== -1 || events.indexOf(eventName) !== -1;
}

function shouldNotifyTarget(eventName, alert, target, env) {
  env = env || process.env;
  if (!eventName || !alert) return false;
  if (eventName === 'alert.resolved' && !isTrue(env.OPERATIONAL_ALERT_NOTIFY_RESOLVED)) return false;
  if (!passesSeverity(alert, env)) return false;
  if (target === 'webhook') return Boolean(env.OPERATIONAL_ALERT_WEBHOOK_URL) && isEventEnabled(eventName, 'OPERATIONAL_ALERT_WEBHOOK_EVENTS', env);
  if (target === 'email') return isTrue(env.OPERATIONAL_ALERT_EMAIL_ENABLED) && isEventEnabled(eventName, 'OPERATIONAL_ALERT_EMAIL_EVENTS', env);
  return false;
}

function truncate(value) {
  if (value === undefined || value === null) return value;
  var text = String(value);
  if (text.length <= MAX_TEXT_LENGTH) return text;
  return text.substring(0, MAX_TEXT_LENGTH) + '...';
}

function sanitizeText(value) {
  if (value === undefined || value === null) return value;
  return truncate(String(value)
    .replace(/:\/\/([^:@/\s]+):([^@/\s]+)@/g, '://[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/([?&](?:signature|token|access|auth|key|credential|expires|policy|x-amz|x-goog)[^=]*=)[^&\s]+/ig, '$1[redacted]'));
}

function toIso(value) {
  if (!value) return undefined;
  try {
    return new Date(value).toISOString();
  } catch (err) {
    return undefined;
  }
}

function plainAlert(alert) {
  if (alert && typeof alert.toJSON === 'function') return alert.toJSON();
  return alert || {};
}

function buildPayload(eventName, alert) {
  var data = plainAlert(alert);
  return {
    source: process.env.BRAND_NAME || 'ChatCase',
    event: eventName,
    status: eventName === 'alert.resolved' ? 'resolved' : 'open',
    key: sanitizeText(data.key),
    type: sanitizeText(data.type),
    severity: normalizeSeverity(data.severity),
    title: sanitizeText(data.title),
    message: sanitizeText(data.message),
    service: sanitizeText(data.service),
    queue: sanitizeText(data.queue),
    channel: sanitizeText(data.channel || 'system'),
    id_project: data.id_project ? sanitizeText(String(data.id_project)) : undefined,
    integrationId: data.integrationId ? sanitizeText(String(data.integrationId)) : undefined,
    firstAt: toIso(data.firstAt),
    lastAt: toIso(data.lastAt),
    resolvedAt: toIso(data.resolvedAt),
    occurrences: data.occurrences || 0,
    details: operationalLogger.sanitize(data.details || {})
  };
}

function getTimeout(env) {
  var timeout = parseInt(env.OPERATIONAL_ALERT_WEBHOOK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS, 10);
  if (isNaN(timeout) || timeout < 1000) return DEFAULT_TIMEOUT_MS;
  return timeout;
}

async function sendWebhook(payload, deps) {
  deps = deps || {};
  var env = deps.env || process.env;
  var httpClient = deps.httpClient || axios;
  var response = await httpClient.post(env.OPERATIONAL_ALERT_WEBHOOK_URL, payload, {
    timeout: getTimeout(env),
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'ChatCase-Operational-Alerts/1.0'
    }
  });
  return {
    status: 'sent',
    httpStatus: response && response.status
  };
}

function getEmailRecipients(env) {
  var configured = parseList(env.OPERATIONAL_ALERT_EMAIL_TO);
  if (configured.length) return configured;
  return superAdminService.getSuperAdminEmails();
}

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmail(payload, env) {
  var brand = env.BRAND_NAME || 'ChatCase';
  var subject = '[' + brand + '] Alerta operacional ' + payload.severity + ': ' + (payload.title || payload.key || payload.type || 'sem titulo');
  var lines = [
    'Evento: ' + payload.event,
    'Severidade: ' + payload.severity,
    'Titulo: ' + (payload.title || ''),
    'Mensagem: ' + (payload.message || ''),
    'Servico: ' + (payload.service || payload.channel || 'system'),
    'Projeto: ' + (payload.id_project || ''),
    'Integracao: ' + (payload.integrationId || ''),
    'Ocorrencias: ' + payload.occurrences,
    'Ultima ocorrencia: ' + (payload.lastAt || '')
  ];
  var htmlRows = lines.map(function(line) {
    return '<li>' + escapeHtml(line) + '</li>';
  }).join('');
  return {
    subject: subject,
    text: lines.join('\n'),
    html: '<h2>' + escapeHtml(subject) + '</h2><ul>' + htmlRows + '</ul>'
  };
}

async function sendEmail(payload, deps) {
  deps = deps || {};
  var env = deps.env || process.env;
  var service = deps.emailService || emailService;
  var recipients = getEmailRecipients(env);
  if (!recipients.length) {
    return { status: 'skipped', reason: 'no_recipients' };
  }
  if (!deps.emailService && service && service.enabled === false) {
    return { status: 'skipped', reason: 'email_service_disabled' };
  }
  var email = buildEmail(payload, env);
  await service.send({
    to: recipients.join(','),
    subject: email.subject,
    text: email.text,
    html: email.html
  });
  return {
    status: 'sent',
    recipients: recipients
  };
}

async function notify(eventName, alert, deps) {
  deps = deps || {};
  var env = deps.env || process.env;
  var payload = buildPayload(eventName, alert);
  var results = {
    ok: true,
    payload: payload,
    webhook: { status: 'disabled' },
    email: { status: 'disabled' }
  };
  var errors = [];

  if (shouldNotifyTarget(eventName, alert, 'webhook', env)) {
    try {
      results.webhook = await sendWebhook(payload, deps);
    } catch (err) {
      results.webhook = { status: 'failed', error: err.message };
      errors.push({ target: 'webhook', error: err });
    }
  }

  if (shouldNotifyTarget(eventName, alert, 'email', env)) {
    try {
      results.email = await sendEmail(payload, deps);
    } catch (err) {
      results.email = { status: 'failed', error: err.message };
      errors.push({ target: 'email', error: err });
    }
  }

  if (errors.length) {
    var error = new Error('Operational alert notification failed: ' + errors.map(function(item) {
      return item.target + ': ' + item.error.message;
    }).join('; '));
    error.results = results;
    error.errors = errors;
    throw error;
  }

  return results;
}

async function notifySafe(eventName, alert, deps) {
  deps = deps || {};
  try {
    return await notify(eventName, alert, deps);
  } catch (err) {
    var logger = deps.logger || operationalLogger;
    var log = deps.winston || winston;
    var data = plainAlert(alert);
    log.warn('[operation] operational alert notification failed: ' + err.message);
    logger.recordSafe({
      level: 'warn',
      area: 'alert',
      channel: data.channel || 'system',
      id_project: data.id_project,
      integrationId: data.integrationId,
      event: 'operational.alert_notification.failed',
      status: 'failed',
      error: err,
      details: {
        alertKey: data.key,
        alertType: data.type,
        severity: data.severity,
        notificationResults: err.results
      }
    });
    return {
      ok: false,
      error: err.message,
      results: err.results
    };
  }
}

module.exports = {
  notify: notify,
  notifySafe: notifySafe,
  buildPayload: buildPayload,
  shouldNotifyTarget: shouldNotifyTarget,
  parseList: parseList,
  buildEmail: buildEmail
};
