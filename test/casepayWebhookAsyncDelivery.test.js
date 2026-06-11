process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';
process.env.CASEPAY_WEBHOOK_SECRET = 'REDACTED_SECRET';

var assert = require('assert');
var crypto = require('crypto');
var billingRouter = require('../pubmodules/billing');
var Project = require('../models/project');
var Project_user = require('../models/project_user');
var SubscriptionPayment = require('../pubmodules/billing/models/subscription-payment');

function getWebhookHandler() {
  var layer = billingRouter.stack.find(function(item) {
    return item.route && item.route.path === '/webhook';
  });

  return layer.route.stack[0].handle;
}

function signedRequest(body) {
  var rawBody = JSON.stringify(body);
  var signature = crypto
    .createHmac('sha256', process.env.CASEPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  return {
    headers: {
      'x-webhook-signature': 'sha256=' + signature
    },
    rawBody: rawBody,
    body: body
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status: function(code) {
      this.statusCode = code;
      return this;
    },
    json: function(body) {
      this.body = body;
      return this;
    }
  };
}

describe('CasePay webhook async delivery', function() {
  var originalProjectFindOne;
  var originalProjectFindById;
  var originalProjectFindByIdAndUpdate;
  var originalProjectUserFindOne;
  var originalPaymentFindOne;
  var originalPaymentCreate;

  beforeEach(function() {
    originalProjectFindOne = Project.findOne;
    originalProjectFindById = Project.findById;
    originalProjectFindByIdAndUpdate = Project.findByIdAndUpdate;
    originalProjectUserFindOne = Project_user.findOne;
    originalPaymentFindOne = SubscriptionPayment.findOne;
    originalPaymentCreate = SubscriptionPayment.create;
  });

  afterEach(function() {
    Project.findOne = originalProjectFindOne;
    Project.findById = originalProjectFindById;
    Project.findByIdAndUpdate = originalProjectFindByIdAndUpdate;
    Project_user.findOne = originalProjectUserFindOne;
    SubscriptionPayment.findOne = originalPaymentFindOne;
    SubscriptionPayment.create = originalPaymentCreate;
  });

  it('acknowledges duplicate-key races as already processed retries', async function() {
    var body = {
      event: 'automatic_pix_payment/completed',
      eventId: 'evt-async-duplicate',
      paymentRequestId: 'mandate-async-1',
      status: 'completed',
      amount: 279
    };
    var req = signedRequest(body);
    var res = responseRecorder();
    var duplicateError = new Error('E11000 duplicate key error collection');
    duplicateError.code = 11000;

    Project.findOne = async function() {
      return {
        _id: 'project-1',
        name: 'Async Project',
        profile: {
          name: 'Starter',
          mandateId: body.paymentRequestId,
          billingPeriod: 'monthly'
        }
      };
    };
    SubscriptionPayment.findOne = async function() {
      return null;
    };
    SubscriptionPayment.create = async function() {
      throw duplicateError;
    };

    await getWebhookHandler()(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true, duplicate: true });
  });

  it('applies an authorized mandate when the webhook is delayed', async function() {
    var body = {
      event: 'payment_request/updated',
      eventId: 'evt-delayed-authorized',
      paymentRequestId: 'mandate-reconcile-1',
      status: 'AUTHORIZED',
      amount: 279
    };
    var project = {
      _id: 'project-reconcile-1',
      name: 'Reconcile Project',
      profile: {
        name: 'Free',
        pendingPlan: 'starter',
        mandateId: 'mandate-reconcile-1',
        billingPeriod: 'monthly',
        billingStatus: 'pending_authorization'
      }
    };
    var req = signedRequest(body);
    var res = responseRecorder();
    var update;

    Project.findOne = async function(query) {
      assert.deepStrictEqual(query, { 'profile.mandateId': body.paymentRequestId });
      return project;
    };
    Project.findByIdAndUpdate = async function(id, nextUpdate) {
      assert.strictEqual(String(id), project._id);
      update = nextUpdate;
    };
    Project_user.findOne = async function() {
      return null;
    };
    SubscriptionPayment.findOne = async function() {
      return null;
    };
    SubscriptionPayment.create = async function(payment) {
      assert.strictEqual(payment.event_id, body.eventId);
      return payment;
    };

    await getWebhookHandler()(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true });
    assert.strictEqual(update['profile.name'], 'Starter');
    assert.strictEqual(update['profile.pendingPlan'], null);
    assert.strictEqual(update['profile.billingStatus'], 'active');
    assert.strictEqual(update['profile.billingStatusReason'], 'casepay_authorized');
  });

  it('uses the starter plan fallback for authorized mandates without pendingPlan', async function() {
    var body = {
      event: 'payment_request/updated',
      eventId: 'evt-authorized-starter-fallback',
      paymentRequestId: 'mandate-reconcile-starter-fallback',
      status: 'AUTHORIZED',
      amount: 279
    };
    var project = {
      _id: 'project-reconcile-starter-fallback',
      name: 'Starter Fallback Project',
      profile: {
        name: 'Free',
        mandateId: 'mandate-reconcile-starter-fallback',
        billingPeriod: 'monthly',
        billingStatus: 'pending_authorization'
      }
    };
    var req = signedRequest(body);
    var res = responseRecorder();
    var update;

    Project.findOne = async function() {
      return project;
    };
    Project.findByIdAndUpdate = async function(id, nextUpdate) {
      assert.strictEqual(String(id), project._id);
      update = nextUpdate;
    };
    Project_user.findOne = async function() {
      return null;
    };
    SubscriptionPayment.findOne = async function() {
      return null;
    };
    SubscriptionPayment.create = async function(payment) {
      assert.strictEqual(payment.event_id, body.eventId);
      return payment;
    };

    await getWebhookHandler()(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true });
    assert.strictEqual(update['profile.name'], 'Starter');
    assert.strictEqual(update['profile.billingStatus'], 'active');
  });
});
