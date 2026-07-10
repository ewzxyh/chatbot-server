var OperationalAlert = require('../models/operationalAlert');
var operationalAlertNotifier = require('./operationalAlertNotifier');
var operationalCause = require('./operationalCause');
var operationalLogger = require('./operationalLogger');

var ALERT_EVENT_COOLDOWN_MINUTES = parseInt(process.env.OPERATIONAL_ALERT_EVENT_COOLDOWN_MINUTES || '30', 10);
if (isNaN(ALERT_EVENT_COOLDOWN_MINUTES) || ALERT_EVENT_COOLDOWN_MINUTES < 1) {
  ALERT_EVENT_COOLDOWN_MINUTES = 30;
}

var DEFAULT_PAGE = 1;
var DEFAULT_LIMIT = 100;
var MAX_LIMIT = 200;
var ALERT_STATUSES = ['open', 'resolved'];
var ALERT_SEVERITIES = ['info', 'warning', 'critical'];
var PRODUCTS = ['casezap', 'waba', 'unknown'];
var LIST_FILTERS = {
  page: true,
  limit: true,
  product: true,
  channel: true,
  status: true,
  cause: true,
  from: true,
  to: true,
  type: true,
  severity: true,
  service: true,
  project_id: true
};

function now() {
  return new Date();
}

function toDate(value, fallback) {
  var date = value ? new Date(value) : null;
  if (!date || isNaN(date.getTime())) return fallback || now();
  return date;
}

function normalizeAlert(alert) {
  var lastAt = toDate(alert.lastAt);
  var details = Object.assign({}, alert.details || {});
  if (alert.lastError) details.lastError = alert.lastError;
  return {
    key: alert.key,
    type: alert.type,
    severity: alert.severity || 'warning',
    status: 'open',
    title: alert.title,
    message: alert.message,
    service: alert.service,
    queue: alert.queue,
    channel: alert.channel,
    id_project: alert.id_project,
    integrationId: alert.integrationId,
    firstAt: toDate(alert.firstAt, lastAt),
    lastAt: lastAt,
    details: Object.keys(details).length ? details : undefined
  };
}

function alertContext(alert) {
  return {
    area: 'alert',
    channel: alert.channel || 'system',
    id_project: alert.id_project,
    integrationId: alert.integrationId,
    details: {
      alertKey: alert.key,
      alertType: alert.type,
      severity: alert.severity,
      service: alert.service,
      queue: alert.queue,
      title: alert.title,
      message: alert.message,
      occurrences: alert.occurrences
    }
  };
}

async function recordAlertEvent(eventName, level, alert) {
  var ctx = alertContext(alert);
  await operationalLogger.record({
    level: level,
    area: ctx.area,
    channel: ctx.channel,
    id_project: ctx.id_project,
    integrationId: ctx.integrationId,
    event: eventName,
    status: eventName === 'alert.resolved' ? 'resolved' : 'open',
    details: ctx.details
  });
  operationalAlertNotifier.notifySafe(eventName, alert);
}

function shouldRecordStillOpen(alert, referenceDate) {
  if (!alert.lastEventAt) return true;
  return referenceDate.getTime() - new Date(alert.lastEventAt).getTime() >= ALERT_EVENT_COOLDOWN_MINUTES * 60 * 1000;
}

async function upsertOpenAlert(rawAlert) {
  var incoming = normalizeAlert(rawAlert);
  var referenceDate = now();
  var existing = await OperationalAlert.findOne({ key: incoming.key });

  if (!existing) {
    var created = await OperationalAlert.create(Object.assign({}, incoming, {
      firstAt: incoming.firstAt || referenceDate,
      lastAt: incoming.lastAt || referenceDate,
      lastEventAt: referenceDate,
      occurrences: 1
    }));
    await recordAlertEvent('alert.opened', created.severity === 'critical' ? 'error' : 'warn', created);
    return created;
  }

  var wasResolved = existing.status === 'resolved';
  var shouldRecord = wasResolved || shouldRecordStillOpen(existing, referenceDate);

  existing.type = incoming.type;
  existing.severity = incoming.severity;
  existing.status = 'open';
  existing.title = incoming.title;
  existing.message = incoming.message;
  existing.service = incoming.service;
  existing.queue = incoming.queue;
  existing.channel = incoming.channel;
  existing.id_project = incoming.id_project;
  existing.integrationId = incoming.integrationId;
  existing.lastAt = incoming.lastAt || referenceDate;
  existing.resolvedAt = undefined;
  existing.details = incoming.details;
  if (wasResolved) {
    existing.firstAt = referenceDate;
    existing.occurrences = 1;
  } else if (shouldRecord) {
    existing.occurrences = (existing.occurrences || 1) + 1;
  }
  if (shouldRecord) {
    existing.lastEventAt = referenceDate;
  }

  await existing.save();

  if (wasResolved) {
    await recordAlertEvent('alert.reopened', existing.severity === 'critical' ? 'error' : 'warn', existing);
  } else if (shouldRecord) {
    await recordAlertEvent('alert.still_open', existing.severity === 'critical' ? 'error' : 'warn', existing);
  }

  return existing;
}

async function resolveMissingAlerts(activeKeys) {
  var referenceDate = now();
  var query = { status: 'open' };
  if (activeKeys.length > 0) {
    query.key = { $nin: activeKeys };
  }

  var alerts = await OperationalAlert.find(query);
  for (var i = 0; i < alerts.length; i++) {
    alerts[i].status = 'resolved';
    alerts[i].resolvedAt = referenceDate;
    alerts[i].lastAt = referenceDate;
    alerts[i].lastEventAt = referenceDate;
    await alerts[i].save();
    await recordAlertEvent('alert.resolved', 'info', alerts[i]);
  }
}

function sortOpenAlerts(alerts) {
  return alerts.sort(function(a, b) {
    var severityA = a.severity === 'critical' ? 2 : a.severity === 'warning' ? 1 : 0;
    var severityB = b.severity === 'critical' ? 2 : b.severity === 'warning' ? 1 : 0;
    if (severityA !== severityB) return severityB - severityA;
    return new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime();
  });
}

function invalidFilter(field) {
  var error = new Error('Invalid operational filter: ' + field);
  error.code = 'invalid_operational_filter';
  error.field = field;
  error.statusCode = 400;
  return error;
}

function stringFilter(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalidFilter(field);
  var normalized = value.trim();
  if (!normalized || normalized.length > 200) throw invalidFilter(field);
  return normalized;
}

function integerFilter(value, field, fallback, max) {
  if (value === undefined) return fallback;
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) {
    throw invalidFilter(field);
  }
  var parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw invalidFilter(field);
  return parsed;
}

function dateFilter(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' && !(value instanceof Date)) throw invalidFilter(field);
  var date = new Date(value);
  if (isNaN(date.getTime())) throw invalidFilter(field);
  return date;
}

function validateListFilters(filters) {
  filters = filters || {};
  Object.keys(filters).forEach(function(field) {
    if (!LIST_FILTERS[field]) throw invalidFilter(field);
  });

  var normalized = {
    page: integerFilter(filters.page, 'page', DEFAULT_PAGE, Number.MAX_SAFE_INTEGER),
    limit: integerFilter(filters.limit, 'limit', DEFAULT_LIMIT, MAX_LIMIT)
  };
  var status = stringFilter(filters.status, 'status');
  if (status && ALERT_STATUSES.indexOf(status) === -1) throw invalidFilter('status');
  normalized.status = status;

  var severity = stringFilter(filters.severity, 'severity');
  if (severity && ALERT_SEVERITIES.indexOf(severity) === -1) throw invalidFilter('severity');
  normalized.severity = severity;

  var product = stringFilter(filters.product, 'product');
  if (product && PRODUCTS.indexOf(product) === -1) throw invalidFilter('product');
  normalized.product = product;

  if (filters.cause !== undefined) {
    stringFilter(filters.cause, 'cause');
    normalized.cause = operationalCause.normalize(filters.cause);
    if (!normalized.cause) throw invalidFilter('cause');
  }

  normalized.channel = stringFilter(filters.channel, 'channel');
  normalized.type = stringFilter(filters.type, 'type');
  normalized.service = stringFilter(filters.service, 'service');
  normalized.project_id = stringFilter(filters.project_id, 'project_id');
  normalized.from = dateFilter(filters.from, 'from');
  normalized.to = dateFilter(filters.to, 'to');
  if (normalized.from && normalized.to && normalized.from > normalized.to) throw invalidFilter('range');
  return normalized;
}

function alertCause(alert) {
  var details = alert.details || {};
  return operationalCause.normalize(details.cause) || operationalCause.normalize(details.providerReason) || operationalCause.normalize(alert.type);
}

function buildListQuery(filters) {
  var clauses = [];
  if (filters.status) clauses.push({ status: filters.status });
  if (filters.type) clauses.push({ type: filters.type });
  if (filters.severity) clauses.push({ severity: filters.severity });
  if (filters.channel) clauses.push({ channel: filters.channel });
  if (filters.service) clauses.push({ service: filters.service });
  if (filters.project_id) clauses.push({ id_project: filters.project_id });

  if (filters.product) {
    clauses.push({ $or: [{ channel: filters.product }, { 'details.product': filters.product }] });
  }

  if (filters.cause) {
    clauses.push({
      $or: [{ type: filters.cause }, { 'details.cause': filters.cause }, { 'details.providerReason': filters.cause }]
    });
  }

  if (filters.from || filters.to) {
    var range = {};
    if (filters.from) range.$gte = filters.from;
    if (filters.to) range.$lte = filters.to;
    clauses.push({ lastAt: range });
  }

  return clauses.length ? { $and: clauses } : {};
}

function alertResponse(alert) {
  var details = alert.details || {};
  var product = PRODUCTS.indexOf(details.product) !== -1
    ? details.product
    : (['casezap', 'waba'].indexOf(alert.channel) !== -1 ? alert.channel : null);
  return {
    id: alert._id ? String(alert._id) : undefined,
    key: alert.key,
    type: alert.type,
    product: product,
    severity: alert.severity,
    status: alert.status,
    cause: alertCause(alert),
    title: alert.title,
    service: alert.service,
    queue: alert.queue,
    channel: alert.channel,
    id_project: alert.id_project,
    integrationId: alert.integrationId,
    firstAt: alert.firstAt ? new Date(alert.firstAt).toISOString() : null,
    lastAt: alert.lastAt ? new Date(alert.lastAt).toISOString() : null,
    resolvedAt: alert.resolvedAt ? new Date(alert.resolvedAt).toISOString() : null,
    occurrences: alert.occurrences
  };
}

async function list(filters) {
  filters = validateListFilters(filters);
  var page = filters.page;
  var limit = filters.limit;
  var query = buildListQuery(filters);
  var count = await OperationalAlert.countDocuments(query);
  var alerts = await OperationalAlert.find(query)
    .sort({ status: 1, lastAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  return {
    data: alerts.map(alertResponse),
    count: count,
    page: page,
    limit: limit
  };
}

async function syncAlerts(rawAlerts) {
  var activeKeys = [];
  var openAlerts = [];
  for (var i = 0; i < (rawAlerts || []).length; i++) {
    if (!rawAlerts[i] || !rawAlerts[i].key) continue;
    activeKeys.push(rawAlerts[i].key);
    openAlerts.push(await upsertOpenAlert(rawAlerts[i]));
  }

  await resolveMissingAlerts(activeKeys);
  return sortOpenAlerts(openAlerts.map(function(alert) {
    return alert.toObject ? alert.toObject() : alert;
  }));
}

async function listAlerts(filters) {
  var result = await list(filters);
  return result.data;
}

module.exports = {
  syncAlerts: syncAlerts,
  list: list,
  listAlerts: listAlerts,
  normalizeAlert: normalizeAlert
};
