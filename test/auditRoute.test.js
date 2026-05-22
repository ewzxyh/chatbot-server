process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';
process.env.DISABLE_BACKGROUND_WORKERS = 'true';
process.env.CREATE_INITIAL_DATA = 'false';
process.env.AUDIT_ENABLED = 'true';
process.env.MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017/tiledesk-test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tiledesk-test';

var defaultAdminEmail = 'audit-admin-' + process.pid + '-' + Date.now() + '@email.com';
if (!process.env.ADMIN_EMAIL) {
  process.env.ADMIN_EMAIL = defaultAdminEmail;
}

var chai = require('chai');
var chaiHttp = require('chai-http');
var server = require('../app');
var User = require('../models/user');
var Project = require('../models/project');
var AuditEvent = require('../models/auditEvent');
var auditService = require('../services/auditService');
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

function putAsSuperAdmin(path, email, password, body) {
  return new Promise(function(resolve, reject) {
    chai.request(server)
      .put(path)
      .auth(email, password)
      .send(body || {})
      .end(function(err, res) {
        if (err) return reject(err);
        resolve(res);
      });
  });
}

describe('AuditRoute', function() {
  var pwd = 'Pwd1234!';
  var adminEmail;

  before(async function() {
    adminEmail = process.env.ADMIN_EMAIL || defaultAdminEmail;
    await User.deleteOne({ email: adminEmail });
    await userService.signup(adminEmail, pwd, 'Audit', 'Admin');
  });

  beforeEach(async function() {
    await Project.deleteMany({ createdBy: 'audit-route-test' });
    await AuditEvent.deleteMany({ $or: [{ 'actor.email': adminEmail }, { action: /^test\./ }] });
  });

  it('records superadmin project changes and exposes them in the audit API', async function() {
    var project = await Project.create({
      name: 'Audit Route Project',
      createdBy: 'audit-route-test',
      profile: {
        name: 'Free',
        type: 'free',
        trialDays: 14,
        agents: 1,
        quotes: { contacts: 100, platforms: 1 }
      }
    });

    var updateRes = await putAsSuperAdmin('/sadmin/projects/' + project._id + '/trial', adminEmail, pwd, {
      trialDays: 30
    });

    expect(updateRes).to.have.status(200);
    expect(updateRes.body.trialDays).to.equal(30);

    var event = await AuditEvent.findOne({
      action: 'admin.project_trial_update',
      id_project: String(project._id),
      'actor.email': adminEmail
    }).lean();

    expect(event).to.exist;
    expect(event.changes.profile_trialDays).to.equal(30);
    expect(event.before.profile.trialDays).to.equal(14);
    expect(event.after.profile.trialDays).to.equal(30);

    var listRes = await getAsSuperAdmin('/sadmin/audit-events?action=admin.project_trial_update&project_id=' + project._id, adminEmail, pwd);
    expect(listRes).to.have.status(200);
    expect(listRes.body.count).to.be.at.least(1);
    expect(listRes.body.data[0].action).to.equal('admin.project_trial_update');

    var summaryRes = await getAsSuperAdmin('/sadmin/audit-events/summary?range=24h&project_id=' + project._id, adminEmail, pwd);
    expect(summaryRes).to.have.status(200);
    expect(summaryRes.body.total).to.be.at.least(1);
  });

  it('redacts sensitive fields before persisting audit metadata', async function() {
    await auditService.record({
      action: 'test.audit_redaction',
      metadata: {
        body: {
          password: 'secret',
          token: 'abc',
          nested: {
            apiKey: 'key'
          },
          visible: 'ok'
        }
      }
    });

    var event = await AuditEvent.findOne({ action: 'test.audit_redaction' }).lean();
    expect(event).to.exist;
    expect(event.metadata.body.password).to.equal('[REDACTED]');
    expect(event.metadata.body.token).to.equal('[REDACTED]');
    expect(event.metadata.body.nested.apiKey).to.equal('[REDACTED]');
    expect(event.metadata.body.visible).to.equal('ok');
  });

  after(async function() {
    await User.deleteOne({ email: adminEmail });
    await Project.deleteMany({ createdBy: 'audit-route-test' });
    await AuditEvent.deleteMany({ $or: [{ 'actor.email': adminEmail }, { action: /^test\./ }] });
  });
});
