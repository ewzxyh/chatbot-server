var express = require('express');
var router = express.Router();
var crypto = require('crypto');
var winston = require('../../config/winston');
var passport = require('passport');
var validtoken = require('../../middleware/valid-token');
var roleChecker = require('../../middleware/has-role');

var User = require('../../models/user');
var Project = require('../../models/project');
var SubscriptionPayment = require('./models/subscription-payment');
var casepay = require('./casepay');
var Lead = require('../../models/lead');
var LeadConstants = require('../../models/leadConstants');
var Project_user = require('../../models/project_user');
var emailService = require('../../services/emailService');
var platformUsageService = require('../../services/platformUsageService');
var billingLifecycleService = require('../../services/billingLifecycleService');

const WEBHOOK_SECRET = process.env.CASEPAY_WEBHOOK_SECRET;

function verifyWebhookSignature(req) {
  if (!WEBHOOK_SECRET) return true;

  const rawSignature = req.headers['x-webhook-signature'] || req.headers['x-signature'];
  if (!rawSignature) {
    winston.warn('CasePay webhook: no signature header found');
    return false;
  }

  const signature = (Array.isArray(rawSignature) ? rawSignature[0] : rawSignature).replace(/^sha256=/, '');
  if (!/^[a-f0-9]+$/i.test(signature)) return false;

  const payload = req.rawBody || JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  const signatureBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  if (signatureBuffer.length !== expectedBuffer.length) return false;

  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}
var { getPlan, getAllPlans } = require('./plans');

function buildBillingPeriodDates(startDate, billingPeriod) {
  var periodStart = startDate || new Date();
  var periodEnd = new Date(periodStart);
  var isAnnual = billingPeriod === 'annual';
  periodEnd.setMonth(periodEnd.getMonth() + (isAnnual ? 12 : 1));
  var accessEnd = new Date(periodEnd);
  accessEnd.setDate(accessEnd.getDate() + 3);

  return {
    periodStart: periodStart,
    periodEnd: periodEnd,
    accessEnd: accessEnd
  };
}

// GET /modules/payments/casepay/plans
router.get('/plans', function (req, res) {
  res.json(getAllPlans());
});

// POST /modules/payments/casepay/subscribe
router.post('/subscribe',
  [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken],
  async function (req, res) {
    try {
      var userId = req.user._id || req.user.id;
      var freshUser = await User.findById(userId).select('emailverified').lean();
      if (!freshUser || !freshUser.emailverified) {
        return res.status(403).json({
          error: 'email_not_verified',
          message: 'Verifique seu email antes de assinar um plano.'
        });
      }

      const { projectId, planKey } = req.body;
      const billingPeriod = req.body.billingPeriod === 'annual' ? 'annual' : 'monthly';

      if (!projectId || !planKey) {
        return res.status(400).json({ error: 'projectId and planKey are required' });
      }

      const plan = getPlan(planKey);
      if (!plan || plan.type === 'free') {
        return res.status(400).json({ error: 'Free plan does not require payment' });
      }

      const project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      var projectUser = await Project_user.findOne({ id_project: projectId, id_user: userId, status: 'active' });
      if (!projectUser || (projectUser.role !== 'owner' && projectUser.role !== 'admin')) {
        return res.status(403).json({ error: 'Not authorized to manage billing for this project' });
      }

      // Idempotency: if a pending mandate already exists for this project, return it
      if (project.profile.pendingPlan && project.profile.mandateId) {
        try {
          const existing = await casepay.getMandate(project.profile.mandateId);
          if (existing.authorize_url) {
            return res.json({
              mandateId: project.profile.mandateId,
              authorizeUrl: existing.authorize_url,
              status: existing.status
            });
          }
        } catch (e) {
          winston.warn(`CasePay: failed to fetch pending mandate ${project.profile.mandateId}, creating new one`);
        }
      }

      // Upgrade flow: cancel old mandate before creating a new one
      if (project.profile.mandateId && !project.profile.pendingPlan) {
        try {
          await casepay.cancelMandate(project.profile.mandateId);
          winston.info(`CasePay: canceled old mandate ${project.profile.mandateId} for upgrade`);
        } catch (e) {
          winston.warn(`CasePay: failed to cancel old mandate ${project.profile.mandateId}`, e);
        }
      }

      const amount = billingPeriod === 'annual' ? plan.annualPrice : plan.monthlyPrice;
      const interval = billingPeriod === 'annual' ? 'YEARLY' : 'MONTHLY';

      const mandate = await casepay.createMandate({
        planName: plan.displayName || plan.name,
        amount,
        interval,
        description: `${plan.displayName || plan.name} - ${project.name}`
      });

      const mandateId = mandate.mandate_id;
      const authorizeUrl = mandate.authorize_url;

      await Project.findByIdAndUpdate(projectId, {
        'profile.mandateId': mandateId,
        'profile.pendingPlan': planKey.toLowerCase(),
        'profile.paymentProvider': 'casepay',
        'profile.billingPeriod': billingPeriod,
        'profile.type': 'payment',
        'profile.billingStatus': 'pending_authorization',
        'profile.billingStatusReason': 'casepay_mandate_created',
        'profile.billingStatusChangedAt': new Date(),
        'profile.billingStatusChangedBy': String(req.user._id || req.user.id),
        'profile.paymentFailureCount': 0,
        'profile.lastBillingEventAt': new Date()
      });

      await SubscriptionPayment.create({
        mandate_id: mandateId,
        project_id: projectId,
        user_id: req.user._id,
        plan_name: planKey,
        event_type: 'mandate_created',
        status: 'created',
        amount,
        provider: 'casepay',
        external_status: mandate.status,
        payment_url: authorizeUrl
      });

      winston.info(`CasePay mandate created for project ${projectId}: ${mandateId} (${billingPeriod})`);

      res.json({
        mandateId,
        authorizeUrl,
        status: mandate.status
      });

    } catch (err) {
      winston.error('CasePay subscribe error', err);
      res.status(500).json({ error: 'Payment creation failed' });
    }
  }
);

// POST /modules/payments/casepay/cancel
router.post('/cancel',
  [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken],
  async function (req, res) {
    try {
      const { projectId } = req.body;
      const project = await Project.findById(projectId);

      if (!project || !project.profile.mandateId) {
        return res.status(404).json({ error: 'No active subscription' });
      }

      var cancelUserId = req.user._id || req.user.id;
      var projectUser = await Project_user.findOne({ id_project: projectId, id_user: cancelUserId, status: 'active' });
      if (!projectUser || (projectUser.role !== 'owner' && projectUser.role !== 'admin')) {
        return res.status(403).json({ error: 'Not authorized to manage billing for this project' });
      }

      await casepay.cancelMandate(project.profile.mandateId);

      const freePlan = getPlan('free');
      await Project.findByIdAndUpdate(projectId, {
        'profile.name': freePlan.name,
        'profile.type': freePlan.type,
        'profile.agents': freePlan.agents,
        'profile.quotes': freePlan.quotes,
        'profile.customization': freePlan.customization,
        'profile.mandateId': null,
        'profile.pendingPlan': null,
        'profile.billingPeriod': null,
        'profile.subStart': null,
        'profile.subEnd': null,
        'profile.currentPeriodStart': null,
        'profile.currentPeriodEnd': null,
        'profile.billingStatus': 'free',
        'profile.billingStatusReason': 'casepay_cancel',
        'profile.billingStatusChangedAt': new Date(),
        'profile.billingStatusChangedBy': String(req.user._id || req.user.id),
        'profile.suspendedAt': null,
        'profile.paymentFailureCount': 0,
        'profile.lastBillingEventAt': new Date()
      });

      await SubscriptionPayment.create({
        mandate_id: project.profile.mandateId,
        project_id: projectId,
        user_id: req.user._id,
        plan_name: 'free',
        event_type: 'mandate_canceled',
        status: 'canceled',
        provider: 'casepay'
      });

      var ownerPU = await Project_user.findOne({ id_project: projectId, role: 'owner', status: 'active' });
      if (ownerPU) {
        var owner = await User.findById(ownerPU.id_user);
        if (owner && owner.email) {
          emailService.sendPlanCanceledEmail(owner.email, owner, project.name);
        }
      }

      winston.info(`CasePay subscription canceled for project ${projectId}`);
      res.json({ status: 'canceled' });

    } catch (err) {
      winston.error('CasePay cancel error', err);
      res.status(500).json({ error: 'Cancellation failed' });
    }
  }
);

// GET /modules/payments/casepay/status/:projectId
router.get('/status/:projectId',
  [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken],
  async function (req, res) {
    try {
      const project = await Project.findById(req.params.projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      var statusUserId = req.user._id || req.user.id;
      var projectUser = await Project_user.findOne({ id_project: req.params.projectId, id_user: statusUserId, status: 'active' });
      if (!projectUser) {
        return res.status(403).json({ error: 'Not authorized to view billing for this project' });
      }

      const plan = getPlan(project.profile.name || 'free');

      const [contactsCount, platformsCount, agentsCount] = await Promise.all([
        Lead.countDocuments({ id_project: req.params.projectId, status: LeadConstants.NORMAL }),
        platformUsageService.countConnectedPlatforms(req.params.projectId),
        Project_user.countDocuments({ id_project: req.params.projectId, status: 'active', id_user: { $exists: true, $ne: null } })
      ]);

      const contactsLimit = (project.profile.quotes && project.profile.quotes.contacts) || plan.quotes.contacts || 200;
      const platformsLimit = (project.profile.quotes && project.profile.quotes.platforms) || plan.quotes.platforms || 1;
      const agentsLimit = project.profile.agents || plan.agents || 1;
      const lifecycle = billingLifecycleService.createBillingLifecycleService().summarizeProject(project);

      const response = {
        plan: project.profile.name,
        displayName: plan.displayName || project.profile.name,
        type: project.profile.type,
        lifecycleStatus: lifecycle.status,
        canUsePaidFeatures: lifecycle.canUsePaidFeatures,
        billingPeriod: project.profile.billingPeriod || null,
        currentPeriodStart: lifecycle.subStart,
        currentPeriodEnd: lifecycle.subEnd,
        accessEndsAt: lifecycle.accessEndsAt,
        paymentFailureCount: lifecycle.paymentFailureCount,
        billingStatusReason: lifecycle.billingStatusReason,
        usage: {
          contacts: { current: contactsCount, limit: contactsLimit },
          platforms: { current: platformsCount, limit: platformsLimit },
          agents: { current: agentsCount, limit: agentsLimit }
        },
        mandateId: project.profile.mandateId || null,
        trialExpired: project.trialExpired,
        trialDaysLeft: project.trialDaysLeft
      };

      if (project.profile.mandateId) {
        try {
          const mandate = await casepay.getMandate(project.profile.mandateId);
          response.mandateStatus = mandate.status;
        } catch (e) {
          response.mandateStatus = 'unknown';
        }
      }

      res.json(response);

    } catch (err) {
      winston.error('CasePay status error', err);
      res.status(500).json({ error: 'Status check failed' });
    }
  }
);

// POST /modules/payments/casepay/webhook
router.post('/webhook', async function (req, res) {
  try {
    if (!verifyWebhookSignature(req)) {
      winston.warn('CasePay webhook: invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { event, eventId, paymentRequestId, status, amount } = req.body;

    if (!eventId) {
      winston.warn('CasePay webhook: missing eventId, rejecting');
      return res.status(400).json({ error: 'missing_event_id' });
    }

    winston.info(`CasePay webhook received: ${event} for ${paymentRequestId}`);

    const existing = await SubscriptionPayment.findOne({ event_id: eventId });
    if (existing) {
      winston.info(`CasePay webhook already processed: ${eventId}`);
      return res.status(200).json({ ok: true, duplicate: true });
    }

    const project = await Project.findOne({ 'profile.mandateId': paymentRequestId });
    if (!project) {
      winston.warn(`CasePay webhook: no project found for mandate ${paymentRequestId}`);
      return res.status(200).json({ ok: true, ignored: true });
    }

    try {
      await SubscriptionPayment.create({
        mandate_id: paymentRequestId,
        project_id: project._id,
        plan_name: project.profile.pendingPlan || project.profile.name,
        event_type: event,
        event_id: eventId,
        status,
        amount,
        provider: 'casepay',
        external_status: status,
        object: req.body
      });
    } catch (err) {
      if (err && err.code === 11000) {
        winston.info(`CasePay webhook already processed during concurrent delivery: ${eventId}`);
        return res.status(200).json({ ok: true, duplicate: true });
      }
      throw err;
    }

    if (event === 'payment_request/updated') {
      if (status === 'AUTHORIZED' || status === 'active') {
        const planKey = project.profile.pendingPlan || 'starter';
        const plan = getPlan(planKey);
        const now = new Date();
        const period = buildBillingPeriodDates(now, project.profile.billingPeriod || 'monthly');

        await Project.findByIdAndUpdate(project._id, {
          'profile.name': plan.name,
          'profile.type': plan.type,
          'profile.agents': plan.agents,
          'profile.quotes': plan.quotes,
          'profile.customization': plan.customization,
          'profile.subStart': period.periodStart,
          'profile.subEnd': period.accessEnd,
          'profile.currentPeriodStart': period.periodStart,
          'profile.currentPeriodEnd': period.periodEnd,
          'profile.pendingPlan': null,
          'profile.billingPeriod': project.profile.billingPeriod || 'monthly',
          'profile.billingStatus': 'active',
          'profile.billingStatusReason': 'casepay_authorized',
          'profile.billingStatusChangedAt': now,
          'profile.paymentFailureCount': 0,
          'profile.lastBillingEventAt': now
        });

        winston.info(`CasePay: project ${project._id} upgraded to ${plan.name}`);

        var ownerPU = await Project_user.findOne({ id_project: project._id, role: 'owner', status: 'active' });
        if (ownerPU) {
          var owner = await User.findById(ownerPU.id_user);
          if (owner && owner.email) {
            emailService.sendPaymentConfirmedEmail(owner.email, owner, project.name, plan.displayName || plan.name, amount, project.profile.billingPeriod || 'monthly');
          }
        }
      }

      if (status === 'canceled' || status === 'expired') {
        const freePlan = getPlan('free');
        await Project.findByIdAndUpdate(project._id, {
          'profile.name': freePlan.name,
          'profile.type': freePlan.type,
          'profile.agents': freePlan.agents,
          'profile.quotes': freePlan.quotes,
          'profile.customization': freePlan.customization,
          'profile.mandateId': null,
          'profile.pendingPlan': null,
          'profile.billingPeriod': null,
          'profile.subStart': null,
          'profile.subEnd': null,
          'profile.currentPeriodStart': null,
          'profile.currentPeriodEnd': null,
          'profile.billingStatus': 'free',
          'profile.billingStatusReason': 'casepay_' + status,
          'profile.billingStatusChangedAt': new Date(),
          'profile.suspendedAt': null,
          'profile.paymentFailureCount': 0,
          'profile.lastBillingEventAt': new Date()
        });

        winston.info(`CasePay: project ${project._id} downgraded to Free`);
      }
    }

    if (event === 'automatic_pix_payment/completed') {
      const now = new Date();
      const period = buildBillingPeriodDates(now, project.profile.billingPeriod || 'monthly');

      await Project.findByIdAndUpdate(project._id, {
        'profile.subStart': period.periodStart,
        'profile.subEnd': period.accessEnd,
        'profile.currentPeriodStart': period.periodStart,
        'profile.currentPeriodEnd': period.periodEnd,
        'profile.last_payment_at': now,
        'profile.billingStatus': 'active',
        'profile.billingStatusReason': 'casepay_payment_completed',
        'profile.billingStatusChangedAt': now,
        'profile.paymentFailureCount': 0,
        'profile.lastBillingEventAt': now
      });

      winston.info(`CasePay: payment confirmed for project ${project._id}, extended to ${period.accessEnd}`);
    }

    if (event === 'automatic_pix_payment/error') {
      await Project.findByIdAndUpdate(project._id, {
        $set: {
          'profile.billingStatus': 'past_due',
          'profile.billingStatusReason': status || 'casepay_payment_error',
          'profile.billingStatusChangedAt': new Date(),
          'profile.lastBillingEventAt': new Date()
        },
        $inc: { 'profile.paymentFailureCount': 1 }
      });
      winston.warn(`CasePay: payment FAILED for project ${project._id}`);
    }

    res.status(200).json({ ok: true });

  } catch (err) {
    winston.error('CasePay webhook processing error', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// GET /modules/payments/casepay/history/:projectId
router.get('/history/:projectId',
  [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken],
  async function (req, res) {
    try {
      const payments = await SubscriptionPayment
        .find({ project_id: req.params.projectId })
        .sort({ createdAt: -1 })
        .limit(50);

      res.json(payments);
    } catch (err) {
      winston.error('CasePay history error', err);
      res.status(500).json({ error: 'Failed to fetch history' });
    }
  }
);

router._verifyWebhookSignature = verifyWebhookSignature;

module.exports = router;
