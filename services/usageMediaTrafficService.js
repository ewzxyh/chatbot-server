var UsageMediaTrafficDaily = require('../models/usageMediaTrafficDaily');
var winston = require('../config/winston');

function dayStart(date) {
  var day = new Date(date);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

function normalizeBytes(value) {
  var bytes = Number(value);
  if (isNaN(bytes) || bytes < 0) return 0;
  return Math.round(bytes);
}

function inferProjectIdFromPath(path) {
  var match = String(path || '').match(/^uploads\/projects\/([^/]+)/);
  return match ? match[1] : null;
}

function isEnabled() {
  return process.env.USAGE_MEDIA_TRAFFIC_ENABLED !== 'false';
}

function createUsageMediaTrafficService(deps) {
  deps = deps || {};
  var Model = deps.UsageMediaTrafficDaily || UsageMediaTrafficDaily;
  var nowFn = deps.now || function() { return new Date(); };

  async function recordServedFile(data) {
    if (!isEnabled()) {
      return { status: 'skipped', reason: 'disabled' };
    }

    data = data || {};
    var path = String(data.path || '').trim();
    var bytes = normalizeBytes(data.bytes);
    var projectId = data.projectId || data.id_project || inferProjectIdFromPath(path);

    if (!projectId) {
      return { status: 'skipped', reason: 'missing_project' };
    }
    if (!path || bytes <= 0) {
      return { status: 'skipped', reason: 'invalid_file' };
    }

    var now = nowFn();
    await Model.updateOne(
      {
        day: dayStart(now),
        id_project: String(projectId),
        path: path,
        endpoint: String(data.endpoint || 'files.inline')
      },
      {
        $setOnInsert: {
          firstAt: now
        },
        $set: {
          lastAt: now
        },
        $inc: {
          requests: 1,
          bytes: bytes
        }
      },
      { upsert: true }
    );

    return { status: 'recorded' };
  }

  function recordServedFileAsync(data) {
    recordServedFile(data).catch(function(err) {
      winston.warn('usage media traffic record failed', err);
    });
  }

  return {
    recordServedFile: recordServedFile,
    recordServedFileAsync: recordServedFileAsync
  };
}

module.exports = {
  createUsageMediaTrafficService: createUsageMediaTrafficService,
  dayStart: dayStart,
  inferProjectIdFromPath: inferProjectIdFromPath
};
