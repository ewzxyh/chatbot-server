var OperationalEvent = require('../models/operationalEvent');
var OperationalAlert = require('../models/operationalAlert');

var RANGE_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '14d': 14 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
};

function normalizeRange(value) {
  return RANGE_MS[value] ? value : '24h';
}

function normalizeBucket(value, range) {
  if (value === 'hour' || value === 'day') return value;
  return range === '24h' ? 'hour' : 'day';
}

function bucketFormat(bucket) {
  if (bucket === 'day') return '%Y-%m-%dT00:00:00.000Z';
  return '%Y-%m-%dT%H:00:00.000Z';
}

function roundBucket(date, bucket) {
  var rounded = new Date(date);
  rounded.setUTCSeconds(0, 0);
  if (bucket === 'day') {
    rounded.setUTCHours(0, 0, 0, 0);
  } else {
    rounded.setUTCMinutes(0, 0, 0);
  }
  return rounded;
}

function addBucket(date, bucket) {
  var next = new Date(date);
  if (bucket === 'day') {
    next.setUTCDate(next.getUTCDate() + 1);
  } else {
    next.setUTCHours(next.getUTCHours() + 1);
  }
  return next;
}

function bucketKey(date, bucket) {
  var rounded = roundBucket(date, bucket);
  if (bucket === 'day') {
    return rounded.toISOString().substring(0, 10) + 'T00:00:00.000Z';
  }
  return rounded.toISOString().substring(0, 13) + ':00:00.000Z';
}

function buildEmptyBuckets(from, to, bucket, template) {
  var rows = [];
  var cursor = roundBucket(from, bucket);
  var end = roundBucket(to, bucket);
  while (cursor <= end) {
    rows.push(Object.assign({ bucketStart: bucketKey(cursor, bucket) }, template));
    cursor = addBucket(cursor, bucket);
  }
  return rows;
}

function mergeBuckets(emptyRows, aggregateRows) {
  var byKey = {};
  aggregateRows.forEach(function(row) {
    byKey[row.bucketStart] = row;
  });
  return emptyRows.map(function(row) {
    return Object.assign({}, row, byKey[row.bucketStart] || {});
  });
}

function objectFromRows(rows) {
  return rows.reduce(function(result, row) {
    var key = row._id || 'unknown';
    result[key] = row.count;
    return result;
  }, {});
}

function commonMatch(filters, dateField, from, to) {
  var match = {};
  match[dateField] = { $gte: from, $lte: to };
  if (filters.project_id) match.id_project = String(filters.project_id);
  if (filters.channel) match.channel = String(filters.channel);
  if (filters.integrationId) match.integrationId = String(filters.integrationId);
  return match;
}

function eventMatch(filters, from, to) {
  var match = commonMatch(filters, 'timestamp', from, to);
  if (filters.level) match.level = String(filters.level);
  if (filters.area) match.area = String(filters.area);
  return match;
}

function alertMatch(filters, from, to) {
  var match = commonMatch(filters, 'lastAt', from, to);
  if (filters.severity) match.severity = String(filters.severity);
  if (filters.status) match.status = String(filters.status);
  if (filters.type) match.type = String(filters.type);
  if (filters.service) match.service = String(filters.service);
  return match;
}

function alertOpenMatch(filters) {
  var match = {};
  if (filters.project_id) match.id_project = String(filters.project_id);
  if (filters.channel) match.channel = String(filters.channel);
  if (filters.integrationId) match.integrationId = String(filters.integrationId);
  if (filters.severity) match.severity = String(filters.severity);
  if (filters.type) match.type = String(filters.type);
  if (filters.service) match.service = String(filters.service);
  match.status = 'open';
  return match;
}

async function aggregateByField(Model, match, field, limit) {
  var rows = await Model.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $ifNull: ['$' + field, 'unknown'] },
        count: { $sum: 1 }
      }
    },
    { $sort: { count: -1, _id: 1 } },
    { $limit: limit || 12 }
  ]);
  return objectFromRows(rows);
}

async function aggregateEventsByBucket(match, bucket) {
  var rows = await OperationalEvent.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          $dateToString: {
            format: bucketFormat(bucket),
            date: '$timestamp',
            timezone: 'UTC'
          }
        },
        count: { $sum: 1 },
        errors: { $sum: { $cond: [{ $eq: ['$level', 'error'] }, 1, 0] } },
        warnings: { $sum: { $cond: [{ $eq: ['$level', 'warn'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  return rows.map(function(row) {
    return {
      bucketStart: row._id,
      count: row.count,
      errors: row.errors,
      warnings: row.warnings,
      failed: row.failed
    };
  });
}

async function aggregateAlertsByBucket(match, bucket) {
  var rows = await OperationalAlert.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          $dateToString: {
            format: bucketFormat(bucket),
            date: '$lastAt',
            timezone: 'UTC'
          }
        },
        count: { $sum: 1 },
        critical: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
        warning: { $sum: { $cond: [{ $eq: ['$severity', 'warning'] }, 1, 0] } },
        open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
        resolved: { $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] } }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  return rows.map(function(row) {
    return {
      bucketStart: row._id,
      count: row.count,
      critical: row.critical,
      warning: row.warning,
      open: row.open,
      resolved: row.resolved
    };
  });
}

async function getMetrics(filters) {
  filters = filters || {};
  var range = normalizeRange(filters.range);
  var bucket = normalizeBucket(filters.bucket, range);
  var to = filters.to ? new Date(filters.to) : new Date();
  if (isNaN(to.getTime())) to = new Date();
  var from = filters.from ? new Date(filters.from) : new Date(to.getTime() - RANGE_MS[range]);
  if (isNaN(from.getTime()) || from >= to) from = new Date(to.getTime() - RANGE_MS[range]);

  var eventQuery = eventMatch(filters, from, to);
  var alertQuery = alertMatch(filters, from, to);
  var openAlertQuery = alertOpenMatch(filters);
  var criticalOpenAlertQuery = Object.assign({}, openAlertQuery, { severity: 'critical' });

  var eventBuckets = await aggregateEventsByBucket(eventQuery, bucket);
  var alertBuckets = await aggregateAlertsByBucket(alertQuery, bucket);

  var emptyEventBuckets = buildEmptyBuckets(from, to, bucket, {
    count: 0,
    errors: 0,
    warnings: 0,
    failed: 0
  });
  var emptyAlertBuckets = buildEmptyBuckets(from, to, bucket, {
    count: 0,
    critical: 0,
    warning: 0,
    open: 0,
    resolved: 0
  });

  var eventsTotal = await OperationalEvent.countDocuments(eventQuery);
  var alertsTotal = await OperationalAlert.countDocuments(alertQuery);
  var openCount = await OperationalAlert.countDocuments(openAlertQuery);
  var criticalOpenCount = await OperationalAlert.countDocuments(criticalOpenAlertQuery);

  return {
    generatedAt: new Date().toISOString(),
    range: range,
    bucket: bucket,
    from: from.toISOString(),
    to: to.toISOString(),
    events: {
      total: eventsTotal,
      byBucket: mergeBuckets(emptyEventBuckets, eventBuckets),
      byLevel: await aggregateByField(OperationalEvent, eventQuery, 'level', 8),
      byStatus: await aggregateByField(OperationalEvent, eventQuery, 'status', 10),
      byChannel: await aggregateByField(OperationalEvent, eventQuery, 'channel', 10),
      byArea: await aggregateByField(OperationalEvent, eventQuery, 'area', 10),
      byEvent: await aggregateByField(OperationalEvent, eventQuery, 'event', 12)
    },
    alerts: {
      total: alertsTotal,
      openCount: openCount,
      criticalOpenCount: criticalOpenCount,
      byBucket: mergeBuckets(emptyAlertBuckets, alertBuckets),
      bySeverity: await aggregateByField(OperationalAlert, alertQuery, 'severity', 8),
      byStatus: await aggregateByField(OperationalAlert, alertQuery, 'status', 8),
      byType: await aggregateByField(OperationalAlert, alertQuery, 'type', 12),
      byChannel: await aggregateByField(OperationalAlert, alertQuery, 'channel', 10),
      byService: await aggregateByField(OperationalAlert, alertQuery, 'service', 10)
    }
  };
}

module.exports = {
  getMetrics: getMetrics,
  normalizeRange: normalizeRange,
  normalizeBucket: normalizeBucket
};
