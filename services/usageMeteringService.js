var moment = require('moment');

var Project = require('../models/project');
var Request = require('../models/request');
var Message = require('../models/message');
var Lead = require('../models/lead');
var LeadConstants = require('../models/leadConstants');
var ProjectUser = require('../models/project_user');
var platformUsageService = require('./platformUsageService');
var fileStorageServiceFactory = require('./fileStorageServiceFactory');
var { getPlan } = require('../pubmodules/billing/plans');

function toIso(date) {
  return new Date(date).toISOString();
}

function numberOrZero(value) {
  var parsed = Number(value);
  return isNaN(parsed) ? 0 : parsed;
}

function normalizeLimit(value) {
  if (value === undefined || value === null) return null;
  var parsed = Number(value);
  if (isNaN(parsed) || parsed <= 0) return null;
  return parsed;
}

function percent(current, limit) {
  if (!limit) return null;
  return Math.round((numberOrZero(current) / limit) * 10000) / 100;
}

function usageMetric(current, limit, extra) {
  var metric = Object.assign({
    current: numberOrZero(current),
    limit: normalizeLimit(limit)
  }, extra || {});
  metric.percent = percent(metric.current, metric.limit);
  return metric;
}

function getNested(object, path) {
  return String(path || '').split('.').reduce(function(value, part) {
    return value == null ? undefined : value[part];
  }, object);
}

function resolvePeriod(project, options, now) {
  options = options || {};
  if (options.from && options.to) {
    var customStart = new Date(options.from);
    var customEnd = new Date(options.to);
    if (!isNaN(customStart.getTime()) && !isNaN(customEnd.getTime()) && customStart < customEnd) {
      return { start: customStart, end: customEnd, source: 'custom' };
    }
  }

  var profile = project.profile || {};
  var anchor = project.createdAt || now;

  var isActiveSubscription = project.isActiveSubscription === true;
  if (isActiveSubscription !== true && profile.type === 'payment' && profile.subEnd) {
    var subEnd = new Date(profile.subEnd);
    if (!isNaN(subEnd.getTime())) {
      var graceEnd = subEnd.getTime() + 259200000;
      isActiveSubscription = now.getTime() <= graceEnd;
    }
  }

  if (isActiveSubscription === true && profile.subStart) {
    anchor = profile.subStart;
  } else if (profile.subEnd) {
    anchor = profile.subEnd;
  }

  var anchorMoment = moment.utc(anchor).startOf('day');
  var nowMoment = moment.utc(now);
  var diffInMonths = nowMoment.diff(anchorMoment, 'months');
  var start = anchorMoment.clone().add(diffInMonths, 'months');

  if (start.isAfter(nowMoment)) {
    start.subtract(1, 'month');
  }

  var end = start.clone().add(1, 'month');
  return { start: start.toDate(), end: end.toDate(), source: 'billing_cycle' };
}

function queryForPeriod(projectId, period) {
  return {
    id_project: String(projectId),
    createdAt: { $gte: period.start, $lt: period.end }
  };
}

function rowsToObject(rows) {
  return (rows || []).reduce(function(result, row) {
    var key = row._id || 'unknown';
    result[key] = row.count || 0;
    return result;
  }, {});
}

async function aggregateByField(Model, match, field) {
  var rows = await Model.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $ifNull: ['$' + field, 'unknown'] },
        count: { $sum: 1 }
      }
    },
    { $sort: { count: -1, _id: 1 } }
  ]);
  return rowsToObject(rows);
}

function decodeMaybe(value) {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return value;
  }
}

function normalizeUploadPath(value) {
  if (!value) return null;
  var text = String(value).trim();
  if (!text) return null;

  if (text.indexOf('uploads/') === 0) {
    return text;
  }

  var pathMatch = text.match(/[?&]path=([^&#\s)]+)/);
  if (pathMatch && pathMatch[1]) {
    var decoded = decodeMaybe(pathMatch[1]);
    if (decoded.indexOf('uploads/') === 0) return decoded;
  }

  var uploadMatch = text.match(/(uploads\/[^\s)'"]+)/);
  if (uploadMatch && uploadMatch[1]) {
    return decodeMaybe(uploadMatch[1]);
  }

  return null;
}

function collectFilePathsFromValue(value, paths) {
  if (!value) return;
  if (typeof value !== 'string') return;

  var direct = normalizeUploadPath(value);
  if (direct) paths.add(direct);

  var pathRegex = /[?&]path=([^&#\s)]+)/g;
  var match;
  while ((match = pathRegex.exec(value)) !== null) {
    var decoded = decodeMaybe(match[1]);
    if (decoded.indexOf('uploads/') === 0) paths.add(decoded);
  }
}

function extractFilePathsFromMessage(message) {
  var paths = new Set();
  var metadata = message.metadata || {};
  [
    'src',
    'url',
    'file',
    'downloadUrl',
    'downloadURL',
    'thumbnail',
    'thumbnailUrl',
    'thumbnailURL'
  ].forEach(function(key) {
    collectFilePathsFromValue(metadata[key], paths);
  });

  collectFilePathsFromValue(message.text, paths);
  return Array.from(paths);
}

async function findFileInServices(path, fileServices) {
  var lastError;
  for (var i = 0; i < fileServices.length; i++) {
    try {
      return await fileServices[i].find(path);
    } catch (err) {
      lastError = err;
      if (!(err && (err.code === 'ENOENT' || err.msg === 'File not found'))) {
        throw err;
      }
    }
  }
  throw lastError || { code: 'ENOENT' };
}

function defaultFileServices() {
  return [
    fileStorageServiceFactory.createPrimaryFileService('files'),
    fileStorageServiceFactory.createPrimaryFileService('images')
  ];
}

async function measureFilePaths(paths, fileServices, limit) {
  var unique = Array.from(new Set(paths || []));
  var headLimit = limit || parseInt(process.env.USAGE_METERING_FILE_HEAD_LIMIT || '500', 10);
  if (isNaN(headLimit) || headLimit < 1) headLimit = 500;

  var selected = unique.slice(0, headLimit);
  var bytes = 0;
  var measured = 0;
  var missing = 0;

  for (var i = 0; i < selected.length; i++) {
    try {
      var file = await findFileInServices(selected[i], fileServices);
      bytes += numberOrZero(file && file.length);
      measured += 1;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.msg === 'File not found')) {
        missing += 1;
      } else {
        throw err;
      }
    }
  }

  return {
    paths: unique,
    count: unique.length,
    measuredCount: measured,
    missingCount: missing,
    bytes: bytes,
    truncated: unique.length > selected.length,
    headLimit: headLimit
  };
}

async function getQuoteUsage(project, quoteManager, now) {
  if (!quoteManager) {
    return { tokens: usageMetric(0, null), email: usageMetric(0, null), quoteSource: 'unavailable' };
  }

  var object = { createdAt: now };
  var quotes = await quoteManager.getAllQuotes(project, object);
  var limits = await quoteManager.getPlanLimits(project);

  return {
    tokens: usageMetric(quotes.tokens && quotes.tokens.quote, limits.tokens),
    email: usageMetric(quotes.email && quotes.email.quote, limits.email),
    quoteSource: 'quote_manager'
  };
}

function createUsageMeteringService(deps) {
  deps = deps || {};

  var models = {
    Project: deps.Project || Project,
    Request: deps.Request || Request,
    Message: deps.Message || Message,
    Lead: deps.Lead || Lead,
    ProjectUser: deps.ProjectUser || ProjectUser
  };
  var platformService = deps.platformUsageService || platformUsageService;
  var nowFn = deps.now || function() { return new Date(); };
  var leadNormalStatus = deps.leadNormalStatus || LeadConstants.NORMAL;

  async function getProjectUsage(projectId, options) {
    options = options || {};
    var now = nowFn();
    var project = await models.Project.findById(projectId).lean();
    if (!project) {
      var notFound = new Error('Project not found');
      notFound.status = 404;
      throw notFound;
    }

    var period = resolvePeriod(project, options, now);
    var baseMatch = queryForPeriod(projectId, period);
    var plan = getPlan((project.profile && project.profile.name) || 'free');
    var profileQuotes = (project.profile && project.profile.quotes) || {};
    var agentsLimit = (project.profile && project.profile.agents) || plan.agents;

    var fileServices = deps.fileServices;
    if (!fileServices && options.includeStorage !== false) {
      fileServices = defaultFileServices();
    }

    var contactsQuery = { id_project: String(projectId), status: leadNormalStatus };
    var newContactsQuery = Object.assign({}, contactsQuery, { createdAt: baseMatch.createdAt });
    var memberQuery = {
      id_project: String(projectId),
      status: 'active',
      id_user: { $exists: true, $ne: null }
    };

    var quoteManager = options.quoteManager || deps.quoteManager;

    var [
      contactsCount,
      newContactsCount,
      membersCount,
      platformsCount,
      conversationsCount,
      messagesTotal,
      messagesByChannel,
      messagesByType,
      quoteUsage,
      attachmentMessages
    ] = await Promise.all([
      models.Lead.countDocuments(contactsQuery),
      models.Lead.countDocuments(newContactsQuery),
      models.ProjectUser.countDocuments(memberQuery),
      platformService.countConnectedPlatforms(projectId),
      models.Request.countDocuments(baseMatch),
      models.Message.countDocuments(baseMatch),
      aggregateByField(models.Message, baseMatch, 'channel.name'),
      aggregateByField(models.Message, baseMatch, 'type'),
      getQuoteUsage(project, quoteManager, now),
      models.Message.find(baseMatch).select('metadata text type').lean()
    ]);

    var attachmentPaths = [];
    attachmentMessages.forEach(function(message) {
      attachmentPaths = attachmentPaths.concat(extractFilePathsFromMessage(message));
    });

    var attachments = options.includeStorage === false
      ? { paths: Array.from(new Set(attachmentPaths)), count: Array.from(new Set(attachmentPaths)).length, measuredCount: 0, missingCount: 0, bytes: null, truncated: false, headLimit: 0 }
      : await measureFilePaths(attachmentPaths, fileServices, options.fileHeadLimit);

    return {
      generatedAt: toIso(now),
      project: {
        id: String(project._id),
        name: project.name || null,
        plan: project.profile && project.profile.name,
        planType: project.profile && project.profile.type
      },
      period: {
        start: toIso(period.start),
        end: toIso(period.end),
        source: period.source
      },
      contacts: usageMetric(contactsCount, profileQuotes.contacts || plan.quotes.contacts, { newInPeriod: newContactsCount }),
      members: usageMetric(membersCount, profileQuotes.members || agentsLimit),
      platforms: usageMetric(platformsCount, profileQuotes.platforms || plan.quotes.platforms),
      conversations: usageMetric(conversationsCount, profileQuotes.requests),
      messages: {
        total: numberOrZero(messagesTotal),
        limit: null,
        byChannel: messagesByChannel,
        byType: messagesByType
      },
      attachments: attachments,
      tokens: quoteUsage.tokens,
      email: quoteUsage.email,
      quoteSource: quoteUsage.quoteSource
    };
  }

  return {
    getProjectUsage: getProjectUsage
  };
}

module.exports = {
  createUsageMeteringService: createUsageMeteringService,
  resolvePeriod: resolvePeriod,
  extractFilePathsFromMessage: extractFilePathsFromMessage,
  measureFilePaths: measureFilePaths
};
