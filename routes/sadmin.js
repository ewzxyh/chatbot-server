var express = require('express');
var router = express.Router();
var passport = require('passport');
var jwt = require('jsonwebtoken');
var validtoken = require('../middleware/valid-token');
var superAdminCheck = require('../middleware/super-admin-check');
var winston = require('../config/winston');
var config = require('../config/database');
var uuidv4 = require('uuid/v4');

var Project = require('../models/project');
var User = require('../models/user');
var Project_user = require('../models/project_user');
var Lead = require('../models/lead');
var LeadConstants = require('../models/leadConstants');
var Integration = require('../models/integrations');
var SubscriptionPayment = require('../pubmodules/billing/models/subscription-payment');
var { getPlan, getAllPlans } = require('../pubmodules/billing/plans');
var OperationalEvent = require('../models/operationalEvent');
var AuditEvent = require('../models/auditEvent');
var operationalHealthService = require('../services/operationalHealthService');
var operationalMonitorService = require('../services/operationalMonitorService');
var operationalAlertService = require('../services/operationalAlertService');
var operationalAlertNotifier = require('../services/operationalAlertNotifier');
var operationalLogger = require('../services/operationalLogger');
var operationalMetricsService = require('../services/operationalMetricsService');
var sentryService = require('../services/sentryService');
var usageMeteringService = require('../services/usageMeteringService');
var usageMeteringSnapshotService = require('../services/usageMeteringSnapshotService');
var billingLifecycleService = require('../services/billingLifecycleService');
var auditService = require('../services/auditService');
var superAdminService = require('../services/superAdminService');
var userService = require('../services/userService');
var authEvent = require('../event/authEvent');
var privacyService = require('../services/privacyService');
var privacyRetentionService = require('../services/privacyRetentionService');
var chat21GroupRepairService = require('../services/chat21GroupRepairService');
var { check, validationResult } = require('express-validator');

var auth = [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken, superAdminCheck];

var configSecret = process.env.GLOBAL_SECRET || config.secret;
var privateKey = process.env.GLOBAL_SECRET_OR_PRIVATE_KEY;
if (privateKey) {
  configSecret = REDACTED_SECRET(/\\n/g, '\n');
}

var IMPERSONATION_USER_FIELDS = [
  '_id', 'email', 'firstname', 'lastname', 'emailverified', 'description',
  'public_email', 'public_website', 'status', 'sessionVersion', 'createdAt', 'updatedAt'
];
var IMPERSONATION_USER_SELECT = IMPERSONATION_USER_FIELDS.join(' ');

function buildImpersonationUser(user) {
  var result = {};
  for (var i = 0; i < IMPERSONATION_USER_FIELDS.length; i++) {
    var field = IMPERSONATION_USER_FIELDS[i];
    if (user[field] !== undefined) {
      result[field] = field === '_id' ? String(user[field]) : user[field];
    }
  }
  return result;
}

var CHANNEL_NAMES = ['whatsapp', 'telegram', 'messenger', 'sms', 'voice', 'voice_twilio', 'casezap'];

var LEGACY_PLAN_MAP = {
  'Sandbox': 'free', 'Basic': 'starter', 'Premium': 'pro', 'Team': 'business',
  'Free': 'free', 'Starter': 'starter', 'Pro': 'pro', 'Business': 'business', 'Custom': 'custom'
};

var VALID_PLAN_KEYS = ['free', 'starter', 'pro', 'business'];

function parseLimit(value, fallback, max) {
  var parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function parsePage(value) {
  var parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

function sendSnapshotError(res, err) {
  if (err && err.code === 'health_snapshot_unavailable') {
    res.status(503).json({
      error: {
        code: 'health_snapshot_unavailable',
        message: 'Operational health snapshot unavailable'
      }
    });
    return true;
  }
  return false;
}

function sendOperationalFilterError(res, err) {
  if (err && err.code === 'invalid_operational_filter') {
    res.status(400).json({
      error: {
        code: err.code,
        field: err.field,
        message: err.message
      }
    });
    return true;
  }
  return false;
}

function integrationTestResponse(result, integrationId) {
  result = result || {};
  return {
    status: result.status,
    channel: result.channel,
    integrationId: result.integrationId || integrationId,
    id_project: result.id_project,
    providerHealth: result.providerHealth,
    providerStatus: result.providerStatus,
    providerCode: result.providerCode,
    providerReason: result.providerReason,
    providerCheckedAt: result.providerCheckedAt,
    providerLatencyMs: result.providerLatencyMs,
    qualityRating: result.qualityRating,
    nameStatus: result.nameStatus,
    canSendNewMessages: result.canSendNewMessages,
    cached: result.cached
  };
}

function parseDateFilter(value) {
  if (!value) return null;
  var parsed = new Date(value);
  if (isNaN(parsed.getTime())) return null;
  return parsed;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getRequestUserEmail(req) {
  if (req && req.user && req.user.email) return req.user.email;
  if (req && req.user && req.user._json && req.user._json.email) return req.user._json.email;
  return 'superadmin';
}

function getProjectProfileSnapshot(project) {
  if (!project || !project.profile) return {};
  return {
    name: project.profile.name,
    type: project.profile.type,
    agents: project.profile.agents,
    quotes: project.profile.quotes,
    trialDays: project.profile.trialDays,
    billingStatus: project.profile.billingStatus,
    subStart: project.profile.subStart,
    subEnd: project.profile.subEnd,
    billingPeriod: project.profile.billingPeriod
  };
}

function getNotificationResultStatus(result) {
  if (!result) return 'failed';
  if ((result.webhook && result.webhook.status === 'failed') ||
      (result.email && result.email.status === 'failed')) {
    return 'failed';
  }
  if ((result.webhook && result.webhook.status === 'sent') ||
      (result.email && result.email.status === 'sent')) {
    return 'sent';
  }
  return 'skipped';
}

function buildNotificationTestAlert(req) {
  var now = new Date();
  var triggeredBy = getRequestUserEmail(req);
  return {
    key: 'manual_test:operational_alert_notification',
    type: 'manual_test',
    severity: 'critical',
    status: 'open',
    title: 'Teste manual de alertas operacionais',
    message: 'Teste disparado pelo painel Superadmin para validar webhook/e-mail operacional.',
    service: 'operation',
    channel: 'system',
    firstAt: now,
    lastAt: now,
    occurrences: 1,
    details: {
      triggeredBy: triggeredBy,
      purpose: 'notification_test'
    }
  };
}

function normalizeSentryTestValue(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback;
  var trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, maxLength);
}

function buildSentryTestOptions(req) {
  var body = req.body || {};
  var title = normalizeSentryTestValue(body.title, 'ChatCase manual Sentry test event', 160);
  var fingerprint = normalizeSentryTestValue(body.fingerprint, 'chatcase-manual-sentry-test', 120);
  return {
    title: title,
    fingerprint: fingerprint
  };
}

async function recordNotificationTest(status, result, error, req) {
  await operationalLogger.record({
    level: status === 'failed' ? 'warn' : 'info',
    area: 'alert',
    channel: 'system',
    event: 'operational.alert_notification.test',
    status: status,
    error: error,
    details: {
      triggeredBy: getRequestUserEmail(req),
      notificationStatus: status,
      notificationResults: result
    }
  });
}

router.get('/stats', auth, async function (req, res) {
  try {
    var totalProjects = await Project.countDocuments();
    var totalUsers = await User.countDocuments({ status: 100 });

    var planAgg = await Project.aggregate([
      { $group: { _id: '$profile.name', count: { $sum: 1 } } }
    ]);

    var planDistribution = { free: 0, starter: 0, pro: 0, business: 0, custom: 0, other: 0 };

    for (var i = 0; i < planAgg.length; i++) {
      var item = planAgg[i];
      var mapped = LEGACY_PLAN_MAP[item._id] || 'other';
      if (planDistribution[mapped] !== undefined) {
        planDistribution[mapped] += item.count;
      } else {
        planDistribution.other += item.count;
      }
    }

    var paidProjects = await Project.find({ 'profile.type': 'payment' }).select('profile').lean();
    var monthlyRevenue = 0;
    for (var j = 0; j < paidProjects.length; j++) {
      var proj = paidProjects[j];
      var plan = getPlan(proj.profile.name || 'free');
      if (proj.profile.billingPeriod === 'annual') {
        monthlyRevenue += (plan.annualPrice || 0) / 12;
      } else {
        monthlyRevenue += plan.monthlyPrice || 0;
      }
    }

    res.json({
      totalProjects: totalProjects,
      totalUsers: totalUsers,
      monthlyRevenue: Math.round(monthlyRevenue * 100) / 100,
      planDistribution: planDistribution
    });
  } catch (err) {
    winston.error('sadmin stats error', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.get('/projects', auth, async function (req, res) {
  try {
    var page = parseInt(req.query.page) || 0;
    var limit = parseInt(req.query.limit) || 20;
    var sortField = req.query.sortField || 'createdAt';
    var direction = parseInt(req.query.direction) || -1;

    var match = {};
    if (req.query.planName) match['profile.name'] = req.query.planName;
    if (req.query.planType) match['profile.type'] = req.query.planType;

    var sort = {};
    sort[sortField] = direction;

    var data = await Project.find(match)
      .sort(sort)
      .skip(page * limit)
      .limit(limit)
      .lean();

    var count = await Project.countDocuments(match);

    var mongoose = require('mongoose');
    for (var i = 0; i < data.length; i++) {
      var projectOid = typeof data[i]._id === 'string' ? new mongoose.Types.ObjectId(data[i]._id) : data[i]._id;
      var ownerPU = await Project_user.findOne({ id_project: projectOid, role: 'owner', status: 'active' }).lean();
      if (ownerPU && ownerPU.id_user) {
        var ownerUser = await User.findById(ownerPU.id_user).select('email').lean();
        data[i].ownerEmail = ownerUser ? ownerUser.email : 'N/A';
      } else {
        data[i].ownerEmail = 'N/A';
      }
    }

    res.json({ data: data, count: count, page: page, limit: limit });
  } catch (err) {
    winston.error('sadmin projects error', err);
    res.status(500).json({ error: 'Failed to fetch projects' });
  }
});

router.get('/users', auth, async function (req, res) {
  try {
    var page = parseInt(req.query.page) || 0;
    var limit = parseInt(req.query.limit) || 20;
    var search = req.query.search || '';

    var filter = { status: 100 };
    if (search) {
      var regex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ email: regex }, { firstname: regex }, { lastname: regex }];
    }

    var data = await User.find(filter)
      .select('email firstname lastname emailverified status createdAt')
      .sort({ createdAt: -1 })
      .skip(page * limit)
      .limit(limit)
      .lean();

    var count = await User.countDocuments(filter);

    for (var i = 0; i < data.length; i++) {
      var projectCount = await Project_user.countDocuments({
        $or: [{ id_user: data[i]._id }, { uuid_user: String(data[i]._id) }]
      });
      data[i].projectCount = projectCount;
    }

    res.json({ data: data, count: count, page: page, limit: limit });
  } catch (err) {
    winston.error('sadmin users error', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.post('/users', auth, [
  check('email').isString().bail().trim().isLength({ min: 3, max: 254 }).bail().isEmail()
    .customSanitizer(function(value) { return value.toLowerCase(); }),
  check('firstname').isString().bail().trim().isLength({ min: 1, max: 100 }),
  check('lastname').optional({ nullable: true }).isString().bail().trim().isLength({ max: 100 }),
  check('password').isString().bail().isLength({ min: 8, max: 72 }).bail()
    .custom(function(password) { return Buffer.byteLength(password, 'utf8') <= 72; })
], async function (req, res) {
  var errors = validationResult(req).array().map(function(error) {
    return { msg: error.msg, param: error.param, location: error.location };
  });
  if (errors.length > 0) {
    return res.status(400).json({ errors: errors });
  }

  try {
    var duplicate = await User.exists({ email: req.body.email });
    if (duplicate) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    var savedUser = await userService.signup(
      req.body.email,
      req.body.password,
      req.body.firstname,
      req.body.lastname,
      true
    );

    return res.status(201).json(buildImpersonationUser(savedUser.toObject()));
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    winston.error('sadmin user creation error');
    return res.status(500).json({ error: 'Failed to create user' });
  }
});

router.delete('/users/:id', auth, async function (req, res) {
  if (!/^[a-f0-9]{24}$/i.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid user id' });
  }

  try {
    var user = await User.findById(req.params.id).exec();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (String(user._id) === String(req.user._id) || superAdminService.isSuperAdminEmail(user.email)) {
      return res.status(409).json({ error: 'Protected user cannot be deleted' });
    }

    var projectMembershipFilter = {
      $or: [{ id_user: user._id }, { uuid_user: String(user._id) }]
    };
    var linkedProjectUser = await Project_user.exists(projectMembershipFilter);
    if (linkedProjectUser) {
      return res.status(409).json({ error: 'User has project memberships' });
    }

    user.status = 0;
    user.email = uuidv4() + '@deleted.invalid';
    user.firstname = 'anonymized';
    user.lastname = 'anonymized';
    user.emailverified = false;
    user.password = uuidv4() + uuidv4();
    user.phone = undefined;
    user.description = undefined;
    user.public_email = undefined;
    user.public_website = undefined;
    user.authUrl = undefined;
    user.attributes = undefined;
    user.signedInAt = undefined;
    user.resetpswrequestid = undefined;
    user.resetpswrequestexpires = undefined;
    await user.save();
    authEvent.emit('user.cache.invalidate', { userId: String(user._id) });

    return res.status(200).json({ success: true });
  } catch (err) {
    winston.error('sadmin user deletion error');
    return res.status(500).json({ error: 'Failed to delete user' });
  }
});

router.post('/impersonation', auth, async function (req, res) {
  try {
    var body = req.body || {};
    var targetType = body.targetType;
    var targetId = body.targetId;

    if (['user', 'project'].indexOf(targetType) === -1 ||
        typeof targetId !== 'string' ||
        !/^[a-f0-9]{24}$/i.test(targetId)) {
      return res.status(400).json({ error: 'Valid targetType and targetId are required' });
    }

    var targetUser;
    var projectId;
    var role;

    if (targetType === 'user') {
      targetUser = await User.findOne({ _id: targetId, status: 100 })
        .select(IMPERSONATION_USER_SELECT)
        .lean();
      if (!targetUser) {
        return res.status(404).json({ error: 'Active target user not found' });
      }
    } else {
      var project = await Project.findOne({ _id: targetId, status: 100 }).select('_id').lean();
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      var owners = await Project_user.find({
        id_project: project._id,
        role: 'owner',
        status: 'active'
      }).select('id_user').sort({ id_user: 1, _id: 1 }).lean();
      var ownerIds = owners.map(function(owner) { return owner.id_user; }).filter(Boolean);
      if (ownerIds.length === 0) {
        return res.status(409).json({ error: 'Active project owner unavailable' });
      }

      var ownerUsers = await User.find({ _id: { $in: ownerIds }, status: 100 })
        .select(IMPERSONATION_USER_SELECT)
        .lean();
      var ownerUsersById = {};
      for (var ownerUserIndex = 0; ownerUserIndex < ownerUsers.length; ownerUserIndex++) {
        ownerUsersById[String(ownerUsers[ownerUserIndex]._id)] = ownerUsers[ownerUserIndex];
      }
      for (var ownerIndex = 0; ownerIndex < owners.length; ownerIndex++) {
        var ownerUser = ownerUsersById[String(owners[ownerIndex].id_user)];
        if (ownerUser &&
            String(ownerUser._id) !== String(req.user._id) &&
            !superAdminService.isSuperAdminEmail(ownerUser.email)) {
          targetUser = ownerUser;
          break;
        }
      }
      if (!targetUser) {
        return res.status(409).json({ error: 'Active project owner unavailable' });
      }

      projectId = String(project._id);
      role = 'owner';
    }

    if (String(targetUser._id) === String(req.user._id) ||
        superAdminService.isSuperAdminEmail(targetUser.email)) {
      return res.status(403).json({ error: 'Superadmins cannot be impersonated' });
    }

    var userJson = buildImpersonationUser(targetUser);

    var impersonation = {
      adminId: String(req.user._id),
      adminEmail: req.user.email,
      targetType: targetType,
      targetId: targetId,
      userId: String(targetUser._id)
    };

    var tokenPayload = Object.assign({}, userJson, {
      token_use: 'impersonation',
      impersonation: impersonation
    });
    if (projectId) {
      tokenPayload.id_project = projectId;
      tokenPayload.projectId = projectId;
      tokenPayload.role = role;
      impersonation.projectId = projectId;
    }

    var signOptions = {
      issuer: 'https://tiledesk.com',
      subject: 'user',
      audience: 'https://tiledesk.com',
      expiresIn: '15m',
      jwtid: uuidv4()
    };
    if (process.env.GLOBAL_SECRET_ALGORITHM) {
      signOptions.algorithm = process.env.GLOBAL_SECRET_ALGORITHM;
    }

    var token = jwt.sign(tokenPayload, configSecret, signOptions);

    var response = { success: true, token: 'JWT ' + token, user: userJson, expiresIn: 900 };
    if (projectId) {
      response.projectId = projectId;
      response.role = role;
    }
    return res.json(response);
  } catch (err) {
    winston.error('sadmin impersonation error', err);
    return res.status(500).json({ error: 'Failed to create impersonation' });
  }
});

router.get('/payments', auth, async function (req, res) {
  try {
    var page = parseInt(req.query.page) || 0;
    var limit = parseInt(req.query.limit) || 20;

    var filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.project_id) filter.project_id = req.query.project_id;

    var data = await SubscriptionPayment
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(page * limit)
      .limit(limit)
      .lean();

    var count = await SubscriptionPayment.countDocuments(filter);

    for (var i = 0; i < data.length; i++) {
      if (data[i].project_id) {
        var proj = await Project.findById(data[i].project_id).select('name').lean();
        data[i].projectName = proj ? proj.name : 'Deleted';
      }
    }

    res.json({ data: data, count: count, page: page, limit: limit });
  } catch (err) {
    winston.error('sadmin payments error', err);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

router.get('/health/summary', auth, async function (req, res) {
  try {
    var summary = await operationalHealthService.getSummary(req.app);
    res.json(summary);
  } catch (err) {
    if (sendSnapshotError(res, err)) return;
    winston.error('sadmin health summary error', err);
    res.status(500).json({ error: 'Failed to fetch health summary' });
  }
});

router.get('/health/services', auth, async function (req, res) {
  try {
    var summary = await operationalHealthService.getSummary();
    res.json({ generatedAt: summary.generatedAt, services: summary.services });
  } catch (err) {
    if (sendSnapshotError(res, err)) return;
    winston.error('sadmin health services error', err);
    res.status(500).json({ error: 'Failed to fetch service health' });
  }
});

router.get('/health/channels', auth, async function (req, res) {
  try {
    var channels = await operationalHealthService.listChannels(req.query);
    res.json(channels);
  } catch (err) {
    if (sendOperationalFilterError(res, err)) return;
    winston.error('sadmin health channels error', err);
    res.status(500).json({ error: 'Failed to fetch channel health' });
  }
});

router.post('/health/channels/test', auth, async function (req, res) {
  try {
    var integrationId = req.body && req.body.integrationId;
    if (typeof integrationId !== 'string' || !integrationId.trim()) {
      return res.status(400).json({
        error: {
          code: 'invalid_integration_id',
          field: 'integrationId',
          message: 'integrationId must be a non-empty string'
        }
      });
    }
    integrationId = integrationId.trim();

    var result = await operationalMonitorService.testIntegration(integrationId);
    res.json({ generatedAt: new Date().toISOString(), result: integrationTestResponse(result, integrationId) });
  } catch (err) {
    winston.error('sadmin health channel test error', err);
    res.status(err.statusCode || 500).json({
      error: {
        code: 'integration_test_failed',
        message: 'Failed to test channel health'
      }
    });
  }
});

router.post('/health/channels/webhook/register', auth, async function (req, res) {
  try {
    var channel = req.body && req.body.channel;
    var integrationId = req.body && req.body.integrationId;
    if (['waba', 'casezap'].indexOf(channel) === -1 || !integrationId) {
      return res.status(400).json({ error: 'channel and integrationId are required' });
    }

    var externalUrl = process.env.EXTERNAL_BASE_URL || (req.protocol + '://' + req.get('host'));
    var result = await operationalHealthService.registerChannelWebhook(channel, integrationId, {
      baseUrl: externalUrl
    });
    res.json({ generatedAt: new Date().toISOString(), result: result });
  } catch (err) {
    winston.error('sadmin health channel webhook register error', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to register channel webhook' });
  }
});

router.get('/health/queues', auth, async function (req, res) {
  try {
    var summary = await operationalHealthService.getSummary();
    var queueStatus = summary.queues.length ? 'ok' : 'unknown';
    for (var i = 0; i < summary.queues.length; i++) {
      if (summary.queues[i].status === 'down') {
        queueStatus = 'down';
        break;
      }
      if (summary.queues[i].status === 'degraded') queueStatus = 'degraded';
      if (summary.queues[i].status === 'unknown' && queueStatus === 'ok') queueStatus = 'unknown';
    }
    res.json({
      generatedAt: summary.generatedAt,
      queueService: {
        name: 'rabbitmq',
        label: 'RabbitMQ',
        status: queueStatus,
        latencyMs: null,
        details: { queues: summary.queues, queueSource: 'snapshot', source: 'snapshot' }
      }
    });
  } catch (err) {
    if (sendSnapshotError(res, err)) return;
    winston.error('sadmin health queues error', err);
    res.status(500).json({ error: 'Failed to fetch queue health' });
  }
});

router.post('/health/storage/test', auth, async function (req, res) {
  try {
    var result = await operationalHealthService.testStorageConnection();
    res.json({ generatedAt: new Date().toISOString(), result: result });
  } catch (err) {
    winston.error('sadmin health storage test error', err);
    res.status(500).json({ error: 'Failed to test storage health' });
  }
});

router.post('/chat21/groups/repair', auth, async function (req, res) {
  try {
    var body = req.body || {};
    var service = chat21GroupRepairService.createChat21GroupRepairService();
    var result = await service.repairRequestGroup({
      request_id: body.request_id,
      id_project: body.id_project || body.project_id,
      dryRun: body.dryRun === true,
      reconcileExisting: body.reconcileExisting !== false
    });

    res.json({ generatedAt: new Date().toISOString(), result: result });
  } catch (err) {
    winston.error('sadmin chat21 group repair error', err);
    res.status(err.status || err.statusCode || 500).json({
      error: err.message || 'Failed to repair Chat21 group'
    });
  }
});

router.get('/operational-events', auth, async function (req, res) {
  try {
    var query = {};
    if (req.query.project_id) query.id_project = req.query.project_id;
    if (req.query.channel) query.channel = req.query.channel;
    if (req.query.level) query.level = req.query.level;
    if (req.query.area) query.area = req.query.area;
    if (req.query.integrationId) query.integrationId = req.query.integrationId;

    var limit = parseLimit(req.query.limit, 50, 200);
    var events = await OperationalEvent.find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    res.json({ data: events, count: events.length, limit: limit });
  } catch (err) {
    winston.error('sadmin operational events error', err);
    res.status(500).json({ error: 'Failed to fetch operational events' });
  }
});

router.get('/audit-events', auth, async function (req, res) {
  try {
    var query = {};
    var and = [];

    if (req.query.project_id) query.id_project = req.query.project_id;
    if (req.query.action) query.action = req.query.action;
    if (req.query.method) query.method = String(req.query.method).toUpperCase();
    if (req.query.entityType) query.entityType = req.query.entityType;
    if (req.query.entityId) query.entityId = req.query.entityId;
    if (req.query.resource) query.resource = req.query.resource;
    if (req.query.success === 'true') query.success = true;
    if (req.query.success === 'false') query.success = false;
    if (req.query.actor) query['actor.email'] = new RegExp(escapeRegex(req.query.actor), 'i');

    var from = parseDateFilter(req.query.from);
    var to = parseDateFilter(req.query.to);
    if (from || to) {
      query.timestamp = {};
      if (from) query.timestamp.$gte = from;
      if (to) query.timestamp.$lte = to;
    }

    if (req.query.search) {
      var search = new RegExp(escapeRegex(req.query.search), 'i');
      and.push({
        $or: [
          { summary: search },
          { path: search },
          { action: search },
          { entityType: search },
          { entityId: search },
          { id_project: search },
          { 'actor.email': search }
        ]
      });
    }

    if (and.length > 0) query.$and = and;

    var limit = parseLimit(req.query.limit, 50, 200);
    var page = parsePage(req.query.page);
    var count = await AuditEvent.countDocuments(query);
    var events = await AuditEvent.find(query)
      .sort({ timestamp: -1 })
      .skip(page * limit)
      .limit(limit)
      .lean();

    res.json({ data: events, count: count, page: page, limit: limit });
  } catch (err) {
    winston.error('sadmin audit events error', err);
    res.status(500).json({ error: 'Failed to fetch audit events' });
  }
});

router.get('/audit-events/summary', auth, async function (req, res) {
  try {
    var now = new Date();
    var from = parseDateFilter(req.query.from);
    var to = parseDateFilter(req.query.to) || now;
    if (!from) {
      var range = req.query.range || '24h';
      var hours = range === '7d' ? 24 * 7 : (range === '30d' ? 24 * 30 : 24);
      from = new Date(now.getTime() - hours * 60 * 60 * 1000);
    }

    var match = { timestamp: { $gte: from, $lte: to } };
    if (req.query.project_id) match.id_project = req.query.project_id;

    var totals = await AuditEvent.aggregate([
      { $match: match },
      {
        $facet: {
          byAction: [
            { $group: { _id: '$action', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
          ],
          byEntity: [
            { $group: { _id: '$entityType', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
          ],
          byActor: [
            { $group: { _id: '$actor.email', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ],
          bySuccess: [
            { $group: { _id: '$success', count: { $sum: 1 } } }
          ],
          total: [
            { $count: 'count' }
          ]
        }
      }
    ]);

    var summary = totals && totals[0] ? totals[0] : {};
    var total = summary.total && summary.total[0] ? summary.total[0].count : 0;
    var failures = 0;
    if (summary.bySuccess) {
      for (var i = 0; i < summary.bySuccess.length; i++) {
        if (summary.bySuccess[i]._id === false) failures = summary.bySuccess[i].count;
      }
    }

    res.json({
      generatedAt: new Date().toISOString(),
      range: { from: from, to: to },
      total: total,
      failures: failures,
      byAction: summary.byAction || [],
      byEntity: summary.byEntity || [],
      byActor: summary.byActor || []
    });
  } catch (err) {
    winston.error('sadmin audit summary error', err);
    res.status(500).json({ error: 'Failed to fetch audit summary' });
  }
});

router.get('/privacy/config', auth, async function (req, res) {
  try {
    res.json({
      generatedAt: new Date().toISOString(),
      config: privacyService.getRetentionConfig()
    });
  } catch (err) {
    winston.error('sadmin privacy config error', err);
    res.status(500).json({ error: 'Failed to fetch privacy config' });
  }
});

router.get('/privacy/retention/status', auth, async function (req, res) {
  try {
    var job = req.app && req.app.get ? req.app.get('privacy_retention_job') : null;
    var status = await privacyRetentionService.getStatus({
      projectId: req.query.project_id,
      jobStatus: job && job.status ? job.status() : null
    });
    res.json(status);
  } catch (err) {
    winston.error('sadmin privacy retention status error', err);
    res.status(500).json({ error: 'Failed to fetch privacy retention status' });
  }
});

router.post('/privacy/retention/run', auth, async function (req, res) {
  var projectId = req.body && (req.body.project_id || req.body.projectId);
  var dryRun = !(req.body && req.body.dryRun === false);
  try {
    if (!dryRun && (!req.body || req.body.confirm !== true)) {
      return res.status(400).json({ error: 'confirm must be true to run destructive privacy retention' });
    }

    var result = await privacyRetentionService.runRetention({
      dryRun: dryRun,
      projectId: projectId,
      limit: req.body && req.body.limit ? parseLimit(req.body.limit, 500, 5000) : undefined,
      attachmentLimit: req.body && req.body.attachmentLimit ? parseLimit(req.body.attachmentLimit, 500, 5000) : undefined,
      scopes: req.body && req.body.scopes ? req.body.scopes : undefined,
      source: 'manual'
    });

    await auditService.record({
      action: dryRun ? 'admin.privacy_retention_simulate' : 'admin.privacy_retention_run',
      method: 'POST',
      path: req.originalUrl || req.url,
      statusCode: 200,
      success: true,
      id_project: projectId ? String(projectId) : undefined,
      entityType: 'privacy_retention',
      entityId: projectId ? String(projectId) : 'global',
      resource: 'sadmin/privacy',
      actor: auditService.getActor(req),
      ip: req.ip,
      userAgent: req.get ? req.get('user-agent') : undefined,
      summary: dryRun ? 'Superadmin simulated LGPD retention policy' : 'Superadmin executed LGPD retention policy',
      changes: result.counts,
      metadata: {
        dryRun: dryRun,
        project_id: projectId ? String(projectId) : null,
        cutoffs: result.cutoffs,
        scopes: result.scopes
      }
    });

    res.json(result);
  } catch (err) {
    winston.error('sadmin privacy retention run error', err);
    var statusCode = err.statusCode || 500;
    await auditService.record({
      action: dryRun ? 'admin.privacy_retention_simulate' : 'admin.privacy_retention_run',
      method: 'POST',
      path: req.originalUrl || req.url,
      statusCode: statusCode,
      success: false,
      id_project: projectId ? String(projectId) : undefined,
      entityType: 'privacy_retention',
      entityId: projectId ? String(projectId) : 'global',
      resource: 'sadmin/privacy',
      actor: auditService.getActor(req),
      ip: req.ip,
      userAgent: req.get ? req.get('user-agent') : undefined,
      summary: 'Superadmin LGPD retention policy failed',
      metadata: {
        dryRun: dryRun,
        project_id: projectId ? String(projectId) : null,
        error: err.message
      }
    });
    res.status(statusCode).json({ error: err.message || 'Failed to run privacy retention' });
  }
});

router.post('/privacy/contact-export', auth, async function (req, res) {
  var projectId = req.body && (req.body.project_id || req.body.projectId);
  var identifier = req.body && req.body.identifier;
  try {
    if (!projectId || !identifier) {
      return res.status(400).json({ error: 'project_id and identifier are required' });
    }

    var result = await privacyService.exportContact(projectId, identifier);
    await auditService.record({
      action: 'admin.privacy_contact_export',
      method: 'POST',
      path: req.originalUrl || req.url,
      statusCode: 200,
      success: true,
      id_project: String(projectId),
      entityType: 'privacy_contact',
      entityId: result.identifier,
      resource: 'sadmin/privacy',
      actor: auditService.getActor(req),
      ip: req.ip,
      userAgent: req.get ? req.get('user-agent') : undefined,
      summary: 'Superadmin exported LGPD contact data',
      metadata: {
        identifier: result.identifier,
        matched: result.matched
      }
    });
    res.json(result);
  } catch (err) {
    winston.error('sadmin privacy contact export error', err);
    var status = err.statusCode || 500;
    await auditService.record({
      action: 'admin.privacy_contact_export',
      method: 'POST',
      path: req.originalUrl || req.url,
      statusCode: status,
      success: false,
      id_project: projectId ? String(projectId) : undefined,
      entityType: 'privacy_contact',
      entityId: identifier ? privacyService.maskIdentifier(identifier) : undefined,
      resource: 'sadmin/privacy',
      actor: auditService.getActor(req),
      ip: req.ip,
      userAgent: req.get ? req.get('user-agent') : undefined,
      summary: 'Superadmin LGPD contact export failed',
      metadata: {
        identifier: identifier ? privacyService.maskIdentifier(identifier) : undefined,
        error: err.message
      }
    });
    res.status(status).json({ error: err.message || 'Failed to export contact data' });
  }
});

router.post('/privacy/contact-anonymize', auth, async function (req, res) {
  var projectId = req.body && (req.body.project_id || req.body.projectId);
  var identifier = req.body && req.body.identifier;
  try {
    if (!projectId || !identifier) {
      return res.status(400).json({ error: 'project_id and identifier are required' });
    }
    if (req.body.confirm !== true) {
      return res.status(400).json({ error: 'confirm must be true to anonymize contact data' });
    }

    var result = await privacyService.anonymizeContact(projectId, identifier, {
      actorEmail: getRequestUserEmail(req),
      reason: req.body.reason
    });

    await auditService.record({
      action: 'admin.privacy_contact_anonymize',
      method: 'POST',
      path: req.originalUrl || req.url,
      statusCode: 200,
      success: true,
      id_project: String(projectId),
      entityType: 'privacy_contact',
      entityId: result.identifier,
      resource: 'sadmin/privacy',
      actor: auditService.getActor(req),
      ip: req.ip,
      userAgent: req.get ? req.get('user-agent') : undefined,
      summary: 'Superadmin anonymized contact data for LGPD',
      changes: result.counts,
      metadata: {
        identifier: result.identifier,
        reason: req.body.reason || null
      }
    });
    res.json(result);
  } catch (err) {
    winston.error('sadmin privacy contact anonymize error', err);
    var status = err.statusCode || 500;
    await auditService.record({
      action: 'admin.privacy_contact_anonymize',
      method: 'POST',
      path: req.originalUrl || req.url,
      statusCode: status,
      success: false,
      id_project: projectId ? String(projectId) : undefined,
      entityType: 'privacy_contact',
      entityId: identifier ? privacyService.maskIdentifier(identifier) : undefined,
      resource: 'sadmin/privacy',
      actor: auditService.getActor(req),
      ip: req.ip,
      userAgent: req.get ? req.get('user-agent') : undefined,
      summary: 'Superadmin LGPD contact anonymization failed',
      metadata: {
        identifier: identifier ? privacyService.maskIdentifier(identifier) : undefined,
        reason: req.body && req.body.reason ? req.body.reason : null,
        error: err.message
      }
    });
    res.status(status).json({ error: err.message || 'Failed to anonymize contact data' });
  }
});

router.get('/operational-alerts', auth, async function (req, res) {
  try {
    var alerts = await operationalAlertService.list(req.query);
    res.json(alerts);
  } catch (err) {
    if (sendOperationalFilterError(res, err)) return;
    winston.error('sadmin operational alerts error', err);
    res.status(500).json({ error: 'Failed to fetch operational alerts' });
  }
});

router.post('/operational-alerts/test-notification', auth, async function (req, res) {
  var alert = buildNotificationTestAlert(req);
  try {
    var result = await operationalAlertNotifier.notify('alert.opened', alert);
    var status = getNotificationResultStatus(result);
    result.status = status;
    result.ok = status !== 'failed';
    await recordNotificationTest(status, result, null, req);
    res.json({ generatedAt: new Date().toISOString(), result: result });
  } catch (err) {
    var failedResult = err.results || {};
    failedResult.status = 'failed';
    failedResult.ok = false;
    failedResult.error = err.message;
    await recordNotificationTest('failed', failedResult, err, req);
    res.json({ generatedAt: new Date().toISOString(), result: failedResult });
  }
});

router.post('/sentry/test', auth, async function (req, res) {
  var sentryMetadata = sentryService.metadata ? sentryService.metadata() : {};
  var testOptions = buildSentryTestOptions(req);
  if (!sentryService.isInitialized()) {
    return res.json({
      generatedAt: new Date().toISOString(),
      result: Object.assign({
        status: 'skipped',
        enabled: sentryService.isEnabled(),
        initialized: false,
        reason: 'sentry_not_configured',
        title: testOptions.title,
        fingerprint: testOptions.fingerprint
      }, sentryMetadata)
    });
  }

  var err = new Error(testOptions.title);
  sentryService.captureException(err, {
    tags: {
      area: 'operation',
      channel: 'system',
      source: 'superadmin_manual_test'
    },
    fingerprint: [testOptions.fingerprint]
  });
  var flushed = await sentryService.flush(2000);

  res.json({
    generatedAt: new Date().toISOString(),
    result: {
      status: flushed ? 'sent' : 'queued',
      enabled: true,
      initialized: true,
      flushed: flushed,
      environment: sentryMetadata.environment,
      release: sentryMetadata.release,
      serverName: sentryMetadata.serverName,
      title: testOptions.title,
      fingerprint: testOptions.fingerprint
    }
  });
});

router.get('/operational-metrics', auth, async function (req, res) {
  try {
    var metrics = await operationalMetricsService.getMetrics({
      range: req.query.range,
      bucket: req.query.bucket,
      from: req.query.from,
      to: req.query.to,
      project_id: req.query.project_id,
      channel: req.query.channel,
      integrationId: req.query.integrationId,
      level: req.query.level,
      area: req.query.area,
      severity: req.query.severity,
      status: req.query.status,
      type: req.query.type,
      service: req.query.service
    });

    res.json(metrics);
  } catch (err) {
    winston.error('sadmin operational metrics error', err);
    res.status(500).json({ error: 'Failed to fetch operational metrics' });
  }
});

router.post('/usage-metering/projects/:id/snapshots', auth, async function (req, res) {
  try {
    var service = usageMeteringSnapshotService.createUsageMeteringSnapshotService({
      quoteManager: req.app.get('quote_manager')
    });

    var snapshot = await service.saveProjectSnapshot(req.params.id, {
      from: req.query.from,
      to: req.query.to,
      includeStorage: req.query.includeStorage !== 'false',
      fileHeadLimit: parseLimit(req.query.fileHeadLimit, 500, 5000),
      source: req.body && req.body.source ? req.body.source : 'manual',
      quoteManager: req.app.get('quote_manager')
    });

    res.status(201).json(snapshot);
  } catch (err) {
    if (err && err.status === 404) {
      return res.status(404).json({ error: 'Project not found' });
    }
    winston.error('sadmin usage snapshot save error', err);
    res.status(500).json({ error: 'Failed to save usage snapshot' });
  }
});

router.get('/usage-metering/projects/:id/snapshots', auth, async function (req, res) {
  try {
    var service = usageMeteringSnapshotService.createUsageMeteringSnapshotService();
    var snapshots = await service.listProjectSnapshots(req.params.id, {
      from: req.query.from,
      to: req.query.to,
      limit: parseLimit(req.query.limit, 24, 60)
    });

    res.json({ data: snapshots, count: snapshots.length });
  } catch (err) {
    winston.error('sadmin usage snapshots list error', err);
    res.status(500).json({ error: 'Failed to fetch usage snapshots' });
  }
});

router.get('/usage-metering/projects/:id/report.csv', auth, async function (req, res) {
  try {
    var service = usageMeteringSnapshotService.createUsageMeteringSnapshotService();
    var csv = await service.exportProjectSnapshotsCsv(req.params.id, {
      from: req.query.from,
      to: req.query.to,
      limit: parseLimit(req.query.limit, 24, 60)
    });

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="usage-metering-' + req.params.id + '.csv"');
    res.status(200).send(csv);
  } catch (err) {
    winston.error('sadmin usage snapshots export error', err);
    res.status(500).json({ error: 'Failed to export usage snapshots' });
  }
});

router.get('/usage-metering/projects/:id', auth, async function (req, res) {
  try {
    var service = usageMeteringService.createUsageMeteringService({
      quoteManager: req.app.get('quote_manager')
    });

    var usage = await service.getProjectUsage(req.params.id, {
      from: req.query.from,
      to: req.query.to,
      includeStorage: req.query.includeStorage !== 'false',
      fileHeadLimit: parseLimit(req.query.fileHeadLimit, 500, 5000)
    });

    res.json(usage);
  } catch (err) {
    if (err && err.status === 404) {
      return res.status(404).json({ error: 'Project not found' });
    }
    winston.error('sadmin usage metering error', err);
    res.status(500).json({ error: 'Failed to fetch usage metering' });
  }
});

router.get('/projects/:id/billing-lifecycle', auth, async function (req, res) {
  try {
    var service = billingLifecycleService.createBillingLifecycleService();
    var lifecycle = await service.getProjectLifecycle(req.params.id, {
      limit: parseLimit(req.query.limit, 50, 200)
    });

    res.json({
      generatedAt: new Date().toISOString(),
      summary: lifecycle.summary,
      events: lifecycle.events
    });
  } catch (err) {
    if (err && err.status === 404) {
      return res.status(404).json({ error: 'Project not found' });
    }
    winston.error('sadmin billing lifecycle error', err);
    res.status(500).json({ error: 'Failed to fetch billing lifecycle' });
  }
});

router.post('/projects/:id/billing-lifecycle/actions', auth, async function (req, res) {
  try {
    var projectBefore = await Project.findById(req.params.id).lean();
    var service = billingLifecycleService.createBillingLifecycleService();
    var result = await service.applyAction(req.params.id, {
      action: req.body && req.body.action,
      reason: req.body && req.body.reason,
      userId: getRequestUserEmail(req)
    });
    var projectAfter = await Project.findById(req.params.id).lean();

    await auditService.record({
      action: 'admin.billing_lifecycle_action',
      method: req.method,
      path: req.originalUrl,
      statusCode: 200,
      success: true,
      id_project: String(req.params.id),
      entityType: 'project',
      entityId: String(req.params.id),
      resource: 'sadmin/projects',
      actor: auditService.getActor(req),
      summary: 'Superadmin applied billing lifecycle action ' + (req.body && req.body.action),
      before: { profile: getProjectProfileSnapshot(projectBefore) },
      after: { profile: getProjectProfileSnapshot(projectAfter) },
      changes: { action: req.body && req.body.action, reason: req.body && req.body.reason }
    });

    res.json({
      generatedAt: new Date().toISOString(),
      summary: result.summary,
      updated: result.updated
    });
  } catch (err) {
    if (err && err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    if (err && err.status === 404) {
      return res.status(404).json({ error: 'Project not found' });
    }
    winston.error('sadmin billing lifecycle action error', err);
    res.status(500).json({ error: 'Failed to apply billing lifecycle action' });
  }
});

router.get('/billing-lifecycle/job/status', auth, async function (req, res) {
  try {
    var job = req.app && req.app.get ? req.app.get('billing_lifecycle_job') : null;
    res.json({
      generatedAt: new Date().toISOString(),
      job: job && job.status ? job.status() : null,
      config: billingLifecycleService.getLifecycleConfig()
    });
  } catch (err) {
    winston.error('sadmin billing lifecycle job status error', err);
    res.status(500).json({ error: 'Failed to fetch billing lifecycle job status' });
  }
});

router.post('/billing-lifecycle/job/run', auth, async function (req, res) {
  var dryRun = !(req.body && req.body.dryRun === false);
  try {
    if (!dryRun && (!req.body || req.body.confirm !== true)) {
      return res.status(400).json({ error: 'confirm must be true to execute billing lifecycle changes' });
    }

    var job = req.app && req.app.get ? req.app.get('billing_lifecycle_job') : null;
    var runOptions = {
      force: true,
      dryRun: dryRun,
      userId: getRequestUserEmail(req),
      limit: req.body && req.body.limit ? parseLimit(req.body.limit, 100, 1000) : undefined,
      suspendAfterDays: req.body && req.body.suspendAfterDays,
      downgradeAfterDays: req.body && req.body.downgradeAfterDays,
      noticeIntervalHours: req.body && req.body.noticeIntervalHours,
      expiringNoticeDays: req.body && req.body.expiringNoticeDays,
      emailEnabled: req.body && req.body.emailEnabled !== undefined ? req.body.emailEnabled : undefined
    };

    var output = job && job.runOnce
      ? await job.runOnce(runOptions)
      : { ok: true, result: await billingLifecycleService.createBillingLifecycleService().runLifecycleSweep(runOptions) };
    var result = output.result || output;

    await auditService.record({
      action: dryRun ? 'admin.billing_lifecycle_simulate' : 'admin.billing_lifecycle_run',
      method: 'POST',
      path: req.originalUrl || req.url,
      statusCode: 200,
      success: true,
      entityType: 'billing_lifecycle',
      entityId: 'global',
      resource: 'sadmin/billing-lifecycle',
      actor: auditService.getActor(req),
      ip: req.ip,
      userAgent: req.get ? req.get('user-agent') : undefined,
      summary: dryRun ? 'Superadmin simulated billing lifecycle sweep' : 'Superadmin executed billing lifecycle sweep',
      changes: {
        dryRun: dryRun,
        scanned: result.scanned,
        actions: result.actions,
        notices: result.notices,
        skipped: result.skipped,
        errors: result.errors
      }
    });

    res.json(Object.assign({
      generatedAt: new Date().toISOString(),
      job: job && job.status ? job.status() : null
    }, output));
  } catch (err) {
    winston.error('sadmin billing lifecycle job run error', err);
    await auditService.record({
      action: dryRun ? 'admin.billing_lifecycle_simulate' : 'admin.billing_lifecycle_run',
      method: 'POST',
      path: req.originalUrl || req.url,
      statusCode: err.statusCode || 500,
      success: false,
      entityType: 'billing_lifecycle',
      entityId: 'global',
      resource: 'sadmin/billing-lifecycle',
      actor: auditService.getActor(req),
      ip: req.ip,
      userAgent: req.get ? req.get('user-agent') : undefined,
      summary: 'Superadmin billing lifecycle sweep failed',
      metadata: { dryRun: dryRun, error: err.message }
    });
    res.status(500).json({ error: 'Failed to run billing lifecycle job' });
  }
});

router.put('/projects/:id/plan', auth, async function (req, res) {
  try {
    var planKey = req.body.planKey;
    if (!planKey || VALID_PLAN_KEYS.indexOf(planKey) === -1) {
      return res.status(400).json({ error: 'Invalid plan key. Must be one of: ' + VALID_PLAN_KEYS.join(', ') });
    }

    var project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    var plan = getPlan(planKey);
    var update = {
      'profile.name': plan.name,
      'profile.type': plan.type,
      'profile.agents': plan.agents,
      'profile.quotes': plan.quotes,
      'profile.customization': plan.customization
    };

    if (planKey === 'free') {
      update['profile.mandateId'] = null;
      update['profile.pendingPlan'] = null;
      update['profile.billingPeriod'] = null;
      update['profile.subEnd'] = null;
      update['profile.subStart'] = null;
      update['profile.currentPeriodStart'] = null;
      update['profile.currentPeriodEnd'] = null;
      update['profile.billingStatus'] = 'free';
      update['profile.paymentFailureCount'] = 0;
      update['profile.suspendedAt'] = null;
    } else if (plan.type === 'payment') {
      if (!project.profile.subEnd) {
        update['profile.subEnd'] = new Date('2099-12-31T23:59:59.999Z');
        update['profile.subStart'] = new Date();
      }
      update['profile.billingStatus'] = 'active';
      update['profile.suspendedAt'] = null;
    }

    update['profile.billingStatusReason'] = 'superadmin_plan_change';
    update['profile.billingStatusChangedAt'] = new Date();
    update['profile.billingStatusChangedBy'] = getRequestUserEmail(req);
    update['profile.lastBillingEventAt'] = new Date();

    await Project.findByIdAndUpdate(req.params.id, { $set: update });
    var projectAfter = await Project.findById(req.params.id).lean();

    var response = { success: true, plan: plan.name };
    if (project.profile.mandateId && planKey !== 'free') {
      response.warning = 'Project has active CasePay mandate. The mandate will continue billing at the previous amount. Consider canceling the mandate.';
    }

    await auditService.record({
      action: 'admin.project_plan_update',
      method: req.method,
      path: req.originalUrl,
      statusCode: 200,
      success: true,
      id_project: String(req.params.id),
      entityType: 'project',
      entityId: String(req.params.id),
      resource: 'sadmin/projects',
      actor: auditService.getActor(req),
      summary: 'Superadmin changed project plan to ' + plan.name,
      before: { profile: getProjectProfileSnapshot(project) },
      after: { profile: getProjectProfileSnapshot(projectAfter) },
      changes: update
    });

    winston.info('sadmin: project ' + req.params.id + ' plan changed to ' + plan.name);
    res.json(response);
  } catch (err) {
    winston.error('sadmin plan change error', err);
    res.status(500).json({ error: 'Failed to change plan' });
  }
});

router.put('/projects/:id/trial', auth, async function (req, res) {
  try {
    var trialDays = parseInt(req.body.trialDays);
    if (!trialDays || trialDays < 1 || trialDays > 365) {
      return res.status(400).json({ error: 'trialDays must be between 1 and 365' });
    }

    var project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    await Project.findByIdAndUpdate(req.params.id, { $set: { 'profile.trialDays': trialDays } });
    var projectAfter = await Project.findById(req.params.id).lean();

    var response = { success: true, trialDays: trialDays };
    if (project.profile.type === 'payment') {
      response.warning = 'Project has active payment. Trial extension has no effect on paid plans.';
    }

    await auditService.record({
      action: 'admin.project_trial_update',
      method: req.method,
      path: req.originalUrl,
      statusCode: 200,
      success: true,
      id_project: String(req.params.id),
      entityType: 'project',
      entityId: String(req.params.id),
      resource: 'sadmin/projects',
      actor: auditService.getActor(req),
      summary: 'Superadmin changed project trial to ' + trialDays + ' days',
      before: { profile: getProjectProfileSnapshot(project) },
      after: { profile: getProjectProfileSnapshot(projectAfter) },
      changes: { 'profile.trialDays': trialDays }
    });

    winston.info('sadmin: project ' + req.params.id + ' trial extended to ' + trialDays + ' days');
    res.json(response);
  } catch (err) {
    winston.error('sadmin trial extend error', err);
    res.status(500).json({ error: 'Failed to extend trial' });
  }
});

router.put('/projects/:id/quotas', auth, async function (req, res) {
  try {
    var project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    var BOUNDS = { contacts: [0, 1000000], platforms: [0, 100], agents: [0, 10000], chatbots: [0, 10000], kbs: [0, 10000] };
    var update = {};

    var keys = Object.keys(req.body);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var val = req.body[key];
      if (BOUNDS[key] && typeof val === 'number' && val >= BOUNDS[key][0] && val <= BOUNDS[key][1]) {
        if (key === 'agents') {
          update['profile.agents'] = val;
        } else {
          update['profile.quotes.' + key] = val;
        }
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid quota fields provided' });
    }

    await Project.findByIdAndUpdate(req.params.id, { $set: update });
    var projectAfter = await Project.findById(req.params.id).lean();

    await auditService.record({
      action: 'admin.project_quotas_update',
      method: req.method,
      path: req.originalUrl,
      statusCode: 200,
      success: true,
      id_project: String(req.params.id),
      entityType: 'project',
      entityId: String(req.params.id),
      resource: 'sadmin/projects',
      actor: auditService.getActor(req),
      summary: 'Superadmin updated project quotas',
      before: { profile: getProjectProfileSnapshot(project) },
      after: { profile: getProjectProfileSnapshot(projectAfter) },
      changes: update
    });

    winston.info('sadmin: project ' + req.params.id + ' quotas updated: ' + JSON.stringify(update));
    res.json({ success: true, updated: update });
  } catch (err) {
    winston.error('sadmin quotas update error', err);
    res.status(500).json({ error: 'Failed to update quotas' });
  }
});

module.exports = router;
