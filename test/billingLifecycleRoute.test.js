process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';
process.env.DISABLE_BACKGROUND_WORKERS = 'true';
process.env.CREATE_INITIAL_DATA = 'false';
process.env.MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017/tiledesk-test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tiledesk-test';

var adminEmail = 'billing-admin-' + process.pid + '-' + Date.now() + '@email.com';
process.env.ADMIN_EMAIL = adminEmail;

var chai = require('chai');
var chaiHttp = require('chai-http');
var mongoose = require('mongoose');
var server = require('../app');
var User = require('../models/user');
var Project = require('../models/project');
var SubscriptionPayment = require('../pubmodules/billing/models/subscription-payment');
var userService = require('../services/userService');

chai.use(chaiHttp);
chai.should();
var expect = chai.expect;

function getAsSuperAdmin(path, email, password) {
  return new Promise(function(resolve, reject) {
    chai.request(server)
      .get(path)
      .auth(email, password)
      .end(function(err, res) {
        if (err) return reject(err);
        resolve(res);
      });
  });
}

function postAsSuperAdmin(path, email, password, body) {
  return new Promise(function(resolve, reject) {
    chai.request(server)
      .post(path)
      .auth(email, password)
      .send(body || {})
      .end(function(err, res) {
        if (err) return reject(err);
        resolve(res);
      });
  });
}

describe('BillingLifecycleRoute', function() {
  var pwd = 'Pwd1234!';

  before(async function() {
    await User.deleteOne({ email: adminEmail });
    await userService.signup(adminEmail, pwd, 'Billing', 'Admin');
  });

  beforeEach(async function() {
    await Project.deleteMany({ createdBy: 'billing-lifecycle-test' });
    await SubscriptionPayment.deleteMany({ event_type: /^billing\.lifecycle\./ });
  });

  it('returns lifecycle summary and lets superadmin suspend a paid project', async function() {
    var projectId = new mongoose.Types.ObjectId();
    var project = await Project.create({
      _id: projectId,
      name: 'Billing Lifecycle API',
      createdBy: 'billing-lifecycle-test',
      profile: {
        name: 'Business',
        type: 'payment',
        agents: 10,
        quotes: {
          contacts: 50000,
          platforms: 5,
          members: 10,
          tokens: 10000000,
          email: 200
        },
        subStart: new Date('2026-05-01T00:00:00.000Z'),
        subEnd: new Date('2099-12-31T23:59:59.999Z'),
        billingStatus: 'active'
      }
    });

    var getRes = await getAsSuperAdmin('/sadmin/projects/' + project._id + '/billing-lifecycle', adminEmail, pwd);
    expect(getRes).to.have.status(200);
    expect(getRes.body.summary.status).to.equal('active');
    expect(getRes.body.summary.canUsePaidFeatures).to.equal(true);

    var suspendRes = await postAsSuperAdmin('/sadmin/projects/' + project._id + '/billing-lifecycle/actions', adminEmail, pwd, {
      action: 'suspend',
      reason: 'manual review'
    });
    expect(suspendRes).to.have.status(200);
    expect(suspendRes.body.summary.status).to.equal('suspended');

    var saved = await Project.findById(project._id).lean();
    expect(saved.profile.billingStatus).to.equal('suspended');
    expect(saved.profile.billingStatusReason).to.equal('manual review');

    var events = await SubscriptionPayment.find({ project_id: String(project._id) }).lean();
    expect(events).to.have.length(1);
    expect(events[0].event_type).to.equal('billing.lifecycle.suspended');
    expect(events[0].provider).to.equal('chatcase');
  });

  after(async function() {
    await User.deleteOne({ email: adminEmail });
    await Project.deleteMany({ createdBy: 'billing-lifecycle-test' });
    await SubscriptionPayment.deleteMany({ event_type: /^billing\.lifecycle\./ });
  });
});
