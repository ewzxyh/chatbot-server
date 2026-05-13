process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';
process.env.OPERATIONAL_RABBITMQ_QUEUES = '';
process.env.CREATE_INITIAL_DATA = 'false';
process.env.MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017/tiledesk-test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tiledesk-test';

var adminEmail = 'operation-admin-' + process.pid + '-' + Date.now() + '@email.com';
var secondaryAdminEmail = 'operation-secondary-admin-' + process.pid + '-' + Date.now() + '@email.com';
process.env.ADMIN_EMAIL = adminEmail;
process.env.SUPER_ADMIN_EMAILS = secondaryAdminEmail;

var chai = require('chai');
var chaiHttp = require('chai-http');
var server = require('../app');
var User = require('../models/user');
var userService = require('../services/userService');
var operationalLogger = require('../services/operationalLogger');
var OperationalEvent = require('../models/operationalEvent');
var OperationalAlert = require('../models/operationalAlert');

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

describe('OperationalRoute', function() {
  var pwd = 'Pwd1234!';

  before(async function() {
    await User.deleteOne({ email: adminEmail });
    await User.deleteOne({ email: secondaryAdminEmail });
    await userService.signup(adminEmail, pwd, 'Admin', 'Operation');
    await userService.signup(secondaryAdminEmail, pwd, 'Secondary', 'Admin');
  });

  beforeEach(async function() {
    await OperationalEvent.deleteMany({});
    await OperationalAlert.deleteMany({});
  });

  it('sanitizes sensitive operational details', function() {
    var sanitized = operationalLogger.sanitize({
      token: 'secret-token',
      webhookSecret: 'secret',
      phone: '+15551234567',
      payload: { text: 'hello' },
      mediaUrl: 'https://files.example.com/a.pdf?X-Amz-Signature=abc&X-Amz-Credential=x',
      nested: { authorization: 'Bearer abc' }
    });

    expect(sanitized.token).to.equal('[Redacted]');
    expect(sanitized.webhookSecret).to.equal('[Redacted]');
    expect(sanitized.payload).to.equal('[Redacted]');
    expect(sanitized.mediaUrl).to.equal('https://files.example.com/a.pdf?[Redacted query]');
    expect(sanitized.nested.authorization).to.equal('[Redacted]');
    expect(sanitized.phone).to.contain('4567');
    expect(sanitized.phone).to.not.contain('1555123');
  });

  it('returns operational events to super admin', function(done) {
    (async function() {
      await operationalLogger.record({
        level: 'error',
        area: 'webhook',
        channel: 'casezap',
        id_project: 'project-1',
        integrationId: 'integration-1',
        event: 'webhook.failed',
        status: 'failed',
        errorMessage: 'boom',
        details: { token: 'secret', phone: '+15551234567' }
      });

      chai.request(server)
        .get('/sadmin/operational-events?channel=casezap&level=error')
        .auth(adminEmail, pwd)
        .end(function(err, res) {
          if (err) return done(err);
          res.should.have.status(200);
          expect(res.body.data).to.have.lengthOf(1);
          expect(res.body.data[0].event).to.equal('webhook.failed');
          expect(res.body.data[0].details.token).to.equal('[Redacted]');
          done();
        });
    })().catch(done);
  });

  it('returns health summary to super admin', function(done) {
    chai.request(server)
      .get('/sadmin/health/summary')
      .auth(adminEmail, pwd)
      .end(function(err, res) {
        if (err) return done(err);
        res.should.have.status(200);
        expect(res.body).to.have.property('overallStatus');
        expect(res.body.services).to.be.an('array');
        expect(res.body.channels).to.be.an('array');
        expect(res.body.alerts).to.be.an('array');
        done();
      });
  });

  it('returns health summary to configured secondary super admin', function(done) {
    chai.request(server)
      .get('/sadmin/health/summary')
      .auth(secondaryAdminEmail, pwd)
      .end(function(err, res) {
        if (err) return done(err);
        res.should.have.status(200);
        expect(res.body).to.have.property('overallStatus');
        done();
      });
  });

  it('persists and resolves operational alerts from health summary', async function() {
    for (var i = 0; i < 3; i++) {
      await operationalLogger.record({
        level: 'error',
        area: 'webhook',
        channel: 'casezap',
        id_project: 'project-alert',
        integrationId: 'integration-alert',
        event: 'webhook.failed',
        status: 'failed',
        errorMessage: 'webhook failed'
      });
    }

    var res = await getAsSuperAdmin('/sadmin/health/summary', adminEmail, pwd);
    res.should.have.status(200);
    expect(res.body.alerts.some(function(alert) {
      return alert.key === 'webhook:casezap:integration-alert' && alert.status === 'open';
    })).to.equal(true);

    var openAlert = await OperationalAlert.findOne({ key: 'webhook:casezap:integration-alert' }).lean();
    expect(openAlert).to.exist;
    expect(openAlert.status).to.equal('open');
    expect(openAlert.occurrences).to.equal(1);
    expect(openAlert.details.failures).to.equal(3);

    var repeatedRes = await getAsSuperAdmin('/sadmin/health/summary', adminEmail, pwd);
    repeatedRes.should.have.status(200);
    var repeatedAlert = await OperationalAlert.findOne({ key: 'webhook:casezap:integration-alert' }).lean();
    expect(repeatedAlert.occurrences).to.equal(1);

    await OperationalEvent.deleteMany({ area: 'webhook' });

    var resolvedRes = await getAsSuperAdmin('/sadmin/health/summary', adminEmail, pwd);
    resolvedRes.should.have.status(200);
    var resolvedAlert = await OperationalAlert.findOne({ key: 'webhook:casezap:integration-alert' }).lean();
    expect(resolvedAlert.status).to.equal('resolved');
    expect(resolvedAlert.resolvedAt).to.exist;
  });

  it('returns operational alerts to super admin', function(done) {
    (async function() {
      await OperationalAlert.create({
        key: 'service:mongo',
        type: 'service_health',
        severity: 'critical',
        status: 'open',
        title: 'MongoDB indisponivel',
        message: 'down',
        service: 'mongo'
      });

      chai.request(server)
        .get('/sadmin/operational-alerts?status=open')
        .auth(adminEmail, pwd)
        .end(function(err, res) {
          if (err) return done(err);
          res.should.have.status(200);
          expect(res.body.data).to.have.lengthOf(1);
          expect(res.body.data[0].key).to.equal('service:mongo');
          done();
        });
    })().catch(done);
  });
});
