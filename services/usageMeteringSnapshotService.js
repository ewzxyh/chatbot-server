var UsageMeteringSnapshot = require('../models/usageMeteringSnapshot');
var usageMeteringService = require('./usageMeteringService');

var CSV_COLUMNS = [
  'period_key',
  'project_name',
  'plan',
  'period_start',
  'period_end',
  'contacts',
  'conversations',
  'messages',
  'attachments_count',
  'attachments_bytes',
  'media_traffic_requests',
  'media_traffic_bytes',
  'tokens',
  'email',
  'estimated_cost_monthly'
];

function periodKey(date) {
  return new Date(date).toISOString().substring(0, 7);
}

function numberOrZero(value) {
  var parsed = Number(value);
  return isNaN(parsed) ? 0 : parsed;
}

function getNested(object, path) {
  return String(path || '').split('.').reduce(function(value, part) {
    return value == null ? undefined : value[part];
  }, object);
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  var text = String(value);
  if (/[",\r\n]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

function snapshotToCsvRow(snapshot) {
  var metrics = snapshot.metrics || {};
  return [
    snapshot.periodKey,
    snapshot.projectName,
    snapshot.plan,
    snapshot.periodStart && new Date(snapshot.periodStart).toISOString(),
    snapshot.periodEnd && new Date(snapshot.periodEnd).toISOString(),
    numberOrZero(getNested(metrics, 'contacts.current')),
    numberOrZero(getNested(metrics, 'conversations.current')),
    numberOrZero(getNested(metrics, 'messages.total')),
    numberOrZero(getNested(metrics, 'attachments.count')),
    numberOrZero(getNested(metrics, 'attachments.bytes')),
    numberOrZero(getNested(metrics, 'mediaTraffic.requests')),
    numberOrZero(getNested(metrics, 'mediaTraffic.bytes')),
    numberOrZero(getNested(metrics, 'tokens.current')),
    numberOrZero(getNested(metrics, 'email.current')),
    numberOrZero(getNested(metrics, 'costEstimate.estimatedCostMonthly'))
  ].map(csvEscape).join(',');
}

function createUsageMeteringSnapshotService(deps) {
  deps = deps || {};
  var Snapshot = deps.UsageMeteringSnapshot || UsageMeteringSnapshot;
  var meteringService = deps.usageMeteringService || usageMeteringService.createUsageMeteringService(deps);

  async function saveProjectSnapshot(projectId, options) {
    options = options || {};
    var usage = await meteringService.getProjectUsage(projectId, {
      from: options.from,
      to: options.to,
      includeStorage: options.includeStorage !== false,
      fileHeadLimit: options.fileHeadLimit,
      quoteManager: options.quoteManager
    });

    var key = periodKey(usage.period.start);
    return Snapshot.findOneAndUpdate(
      { id_project: String(projectId), periodKey: key },
      {
        $set: {
          id_project: String(projectId),
          projectName: usage.project && usage.project.name,
          plan: usage.project && usage.project.plan,
          planType: usage.project && usage.project.planType,
          periodKey: key,
          periodStart: new Date(usage.period.start),
          periodEnd: new Date(usage.period.end),
          source: options.source || 'manual',
          generatedAt: new Date(usage.generatedAt),
          metrics: usage
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  function buildFindQuery(projectId, options) {
    options = options || {};
    var query = { id_project: String(projectId) };
    if (options.from || options.to) {
      query.periodStart = {};
      if (options.from) query.periodStart.$gte = new Date(options.from);
      if (options.to) query.periodStart.$lt = new Date(options.to);
    }
    return query;
  }

  async function listProjectSnapshots(projectId, options) {
    options = options || {};
    var limit = parseInt(options.limit || 24, 10);
    if (isNaN(limit) || limit < 1) limit = 24;
    if (limit > 60) limit = 60;
    return Snapshot.find(buildFindQuery(projectId, options))
      .sort({ periodStart: -1 })
      .limit(limit)
      .lean();
  }

  async function exportProjectSnapshotsCsv(projectId, options) {
    var rows = await listProjectSnapshots(projectId, options);
    var ordered = rows.slice().sort(function(a, b) {
      return new Date(a.periodStart).getTime() - new Date(b.periodStart).getTime();
    });
    return [CSV_COLUMNS.join(',')]
      .concat(ordered.map(snapshotToCsvRow))
      .join('\n') + '\n';
  }

  return {
    saveProjectSnapshot: saveProjectSnapshot,
    listProjectSnapshots: listProjectSnapshots,
    exportProjectSnapshotsCsv: exportProjectSnapshotsCsv
  };
}

module.exports = {
  CSV_COLUMNS: CSV_COLUMNS,
  createUsageMeteringSnapshotService: createUsageMeteringSnapshotService,
  periodKey: periodKey,
  snapshotToCsvRow: snapshotToCsvRow
};
