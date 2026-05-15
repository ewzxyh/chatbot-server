var express = require('express');
var router = express.Router();
var passport = require('passport');
var validtoken = require('../middleware/valid-token');
var superAdminCheck = require('../middleware/super-admin-check');
var winston = require('../config/winston');

var Project = require('../models/project');
var User = require('../models/user');
var Project_user = require('../models/project_user');
var Lead = require('../models/lead');
var LeadConstants = require('../models/leadConstants');
var Integration = require('../models/integrations');
var SubscriptionPayment = require('../pubmodules/billing/models/subscription-payment');
var { getPlan, getAllPlans } = require('../pubmodules/billing/plans');
var OperationalEvent = require('../models/operationalEvent');
var operationalHealthService = require('../services/operationalHealthService');
var operationalAlertService = require('../services/operationalAlertService');
var operationalMetricsService = require('../services/operationalMetricsService');

var auth = [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken, superAdminCheck];

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
      var regex = new RegExp(search, 'i');
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
      var projectCount = await Project_user.countDocuments({ id_user: data[i]._id, status: 'active' });
      data[i].projectCount = projectCount;
    }

    res.json({ data: data, count: count, page: page, limit: limit });
  } catch (err) {
    winston.error('sadmin users error', err);
    res.status(500).json({ error: 'Failed to fetch users' });
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
    winston.error('sadmin health summary error', err);
    res.status(500).json({ error: 'Failed to fetch health summary' });
  }
});

router.get('/health/services', auth, async function (req, res) {
  try {
    var services = await operationalHealthService.getServices(req.app.get('redis_client'));
    res.json({ generatedAt: new Date().toISOString(), services: services });
  } catch (err) {
    winston.error('sadmin health services error', err);
    res.status(500).json({ error: 'Failed to fetch service health' });
  }
});

router.get('/health/channels', auth, async function (req, res) {
  try {
    var channels = await operationalHealthService.getChannels();
    res.json({ generatedAt: new Date().toISOString(), channels: channels });
  } catch (err) {
    winston.error('sadmin health channels error', err);
    res.status(500).json({ error: 'Failed to fetch channel health' });
  }
});

router.post('/health/channels/test', auth, async function (req, res) {
  try {
    var channel = req.body && req.body.channel;
    var integrationId = req.body && req.body.integrationId;
    if (['waba', 'casezap'].indexOf(channel) === -1 || !integrationId) {
      return res.status(400).json({ error: 'channel and integrationId are required' });
    }

    var result = await operationalHealthService.testChannelConnection(channel, integrationId);
    res.json({ generatedAt: new Date().toISOString(), result: result });
  } catch (err) {
    winston.error('sadmin health channel test error', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Failed to test channel health' });
  }
});

router.get('/health/queues', auth, async function (req, res) {
  try {
    var rabbit = await operationalHealthService.checkRabbit();
    res.json({ generatedAt: new Date().toISOString(), queueService: rabbit });
  } catch (err) {
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

router.get('/operational-alerts', auth, async function (req, res) {
  try {
    var limit = parseLimit(req.query.limit, 100, 200);
    var alerts = await operationalAlertService.listAlerts({
      status: req.query.status,
      type: req.query.type,
      severity: req.query.severity,
      channel: req.query.channel,
      service: req.query.service,
      project_id: req.query.project_id,
      limit: limit
    });

    res.json({ data: alerts, count: alerts.length, limit: limit });
  } catch (err) {
    winston.error('sadmin operational alerts error', err);
    res.status(500).json({ error: 'Failed to fetch operational alerts' });
  }
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
    } else if (plan.type === 'payment') {
      if (!project.profile.subEnd) {
        update['profile.subEnd'] = new Date('2099-12-31T23:59:59.999Z');
        update['profile.subStart'] = new Date();
      }
    }

    await Project.findByIdAndUpdate(req.params.id, { $set: update });

    var response = { success: true, plan: plan.name };
    if (project.profile.mandateId && planKey !== 'free') {
      response.warning = 'Project has active CasePay mandate. The mandate will continue billing at the previous amount. Consider canceling the mandate.';
    }

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

    var response = { success: true, trialDays: trialDays };
    if (project.profile.type === 'payment') {
      response.warning = 'Project has active payment. Trial extension has no effect on paid plans.';
    }

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

    winston.info('sadmin: project ' + req.params.id + ' quotas updated: ' + JSON.stringify(update));
    res.json({ success: true, updated: update });
  } catch (err) {
    winston.error('sadmin quotas update error', err);
    res.status(500).json({ error: 'Failed to update quotas' });
  }
});

module.exports = router;
