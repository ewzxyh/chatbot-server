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

const WEBHOOK_SECRET = process.env.CASEPAY_WEBHOOK_SECRET;

function verifyWebhookSignature(req) {
  if (!WEBHOOK_SECRET) return true;

  const rawSignature = req.headers['x-webhook-signature'] || req.headers['x-signature'];
  if (!rawSignature) {
    winston.warn('CasePay webhook: no signature header found');
    return false;
  }

  const signature = rawSignature.replace(/^sha256=/, '');
  const payload = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');

  return signature === expected;
}
var { getPlan, getAllPlans } = require('./plans');

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

      if (!projectId || !planKey) {
        return res.status(400).json({ error: 'projectId and planKey are required' });
      }

      const plan = getPlan(planKey);
      if (!plan) {
        return res.status(400).json({ error: 'Invalid plan' });
      }

      const PLAN_PRICES = {
        starter: 97.00,
        pro: 197.00,
        business: 497.00
      };

      const amount = PLAN_PRICES[planKey.toLowerCase()];
      if (!amount) {
        return res.status(400).json({ error: 'Free plan does not require payment' });
      }

      const project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      const mandate = await casepay.createMandate({
        planName: plan.name,
        amount,
        description: `${plan.name} - ${project.name}`
      });

      const mandateId = mandate.mandate_id;
      const authorizeUrl = mandate.authorize_url;

      await Project.findByIdAndUpdate(projectId, {
        'profile.mandateId': mandateId,
        'profile.pendingPlan': planKey.toLowerCase(),
        'profile.paymentProvider': 'casepay'
      });

      await SubscriptionPayment.create({
        mandate_id: mandateId,
        project_id: projectId,
        user_id: req.user._id,
        plan_name: planKey,
        event_type: 'mandate_created',
        status: 'created',
        amount
      });

      winston.info(`CasePay mandate created for project ${projectId}: ${mandateId}`);

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

      await casepay.cancelMandate(project.profile.mandateId);

      const freePlan = getPlan('free');
      await Project.findByIdAndUpdate(projectId, {
        'profile.name': freePlan.name,
        'profile.type': freePlan.type,
        'profile.agents': freePlan.agents,
        'profile.quotes': freePlan.quotes,
        'profile.customization': freePlan.customization,
        'profile.mandateId': null,
        'profile.pendingPlan': null
      });

      await SubscriptionPayment.create({
        mandate_id: project.profile.mandateId,
        project_id: projectId,
        user_id: req.user._id,
        plan_name: 'free',
        event_type: 'mandate_canceled',
        status: 'canceled'
      });

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

      const response = {
        plan: project.profile.name,
        type: project.profile.type,
        mandateId: project.profile.mandateId || null,
        isActive: project.isActiveSubscription,
        trialExpired: project.trialExpired,
        trialDaysLeft: project.trialDaysLeft
      };

      if (project.profile.mandateId) {
        try {
          const mandate = await casepay.getMandate(project.profile.mandateId);
          response.mandateStatus = mandate.status;
          response.payments = mandate.pluggy_automatic_pix_payments || [];
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

    await SubscriptionPayment.create({
      mandate_id: paymentRequestId,
      project_id: project._id,
      plan_name: project.profile.pendingPlan || project.profile.name,
      event_type: event,
      event_id: eventId,
      status,
      amount,
      object: req.body
    });

    if (event === 'payment_request/updated') {
      if (status === 'AUTHORIZED' || status === 'active') {
        const planKey = project.profile.pendingPlan || 'starter';
        const plan = getPlan(planKey);
        const now = new Date();
        const subEnd = new Date(now);
        subEnd.setMonth(subEnd.getMonth() + 1);
        subEnd.setDate(subEnd.getDate() + 3);

        await Project.findByIdAndUpdate(project._id, {
          'profile.name': plan.name,
          'profile.type': plan.type,
          'profile.agents': plan.agents,
          'profile.quotes': plan.quotes,
          'profile.customization': plan.customization,
          'profile.subStart': now,
          'profile.subEnd': subEnd,
          'profile.pendingPlan': null
        });

        winston.info(`CasePay: project ${project._id} upgraded to ${plan.name}`);
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
          'profile.pendingPlan': null
        });

        winston.info(`CasePay: project ${project._id} downgraded to Free`);
      }
    }

    if (event === 'automatic_pix_payment/completed') {
      const subEnd = new Date();
      subEnd.setMonth(subEnd.getMonth() + 1);
      subEnd.setDate(subEnd.getDate() + 3);

      await Project.findByIdAndUpdate(project._id, {
        'profile.subEnd': subEnd,
        'profile.last_payment_at': new Date()
      });

      winston.info(`CasePay: payment confirmed for project ${project._id}, extended to ${subEnd}`);
    }

    if (event === 'automatic_pix_payment/error') {
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

module.exports = router;
