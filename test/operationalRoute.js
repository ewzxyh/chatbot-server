process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';
process.env.DISABLE_BACKGROUND_WORKERS = 'true';
process.env.OPERATIONAL_RABBITMQ_QUEUES = '';
process.env.CREATE_INITIAL_DATA = 'false';
process.env.MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017/tiledesk-test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tiledesk-test';
process.env.DASHBOARD_BASE_URL = process.env.DASHBOARD_BASE_URL || 'http://localhost:4200/dashboard';
process.env.EMAIL_BASEURL = process.env.EMAIL_BASEURL || 'http://localhost:4200/dashboard';
process.env.META_GRAPH_URL = process.env.META_GRAPH_URL || 'https://graph.facebook.com/v25.0/';
process.env.FB_APP_ID = process.env.FB_APP_ID || 'test-fb-app';
process.env.FB_APP_SECRET = process.env.FB_APP_SECRET || 'test-fb-secret';
process.env.MESSENGER_VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || 'test-verify-token';

var adminEmail = 'operation-admin-' + process.pid + '-' + Date.now() + '@email.com';
var secondaryAdminEmail = 'operation-secondary-admin-' + process.pid + '-' + Date.now() + '@email.com';
process.env.ADMIN_EMAIL = adminEmail;
process.env.SUPER_ADMIN_EMAILS = secondaryAdminEmail;

var chai = require('chai');
var chaiHttp = require('chai-http');
var mongoose = require('mongoose');
var nock = require('nock');
var server = require('../app');
var User = require('../models/user');
var userService = require('../services/userService');
var operationalLogger = require('../services/operationalLogger');
var operationalHealthService = require('../services/operationalHealthService');
var OperationalEvent = require('../models/operationalEvent');
var OperationalAlert = require('../models/operationalAlert');
var Integration = require('../models/integrations');

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

describe('OperationalRoute', function() {
  var pwd = 'Pwd1234!';

  before(async function() {
    await User.deleteOne({ email: adminEmail });
    await User.deleteOne({ email: secondaryAdminEmail });
    await userService.signup(adminEmail, pwd, 'Admin', 'Operation');
    await userService.signup(secondaryAdminEmail, pwd, 'Secondary', 'Admin');
  });

  beforeEach(async function() {
    nock.cleanAll();
    await OperationalEvent.deleteMany({});
    await OperationalAlert.deleteMany({});
    await Integration.deleteMany({ id_project: /^operation-/ });
    await mongoose.connection.collection('kvstore').deleteMany({ project_id: /^operation-/ });
  });

  afterEach(function() {
    nock.cleanAll();
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

  it('reports Redis health without exposing the password', async function() {
    var secret = 'REDACTED_SECRET';
    var result = await operationalHealthService.checkRedis({
      redis_host: 'redis',
      redis_port: '6379',
      redis_password: secret,
      readyAt: '2026-05-15T00:00:00.000Z',
      client: {
        ready: true,
        ping: function(callback) {
          callback(null, 'PONG');
        }
      }
    });

    expect(result.status).to.equal('ok');
    expect(result.latencyMs).to.be.a('number');
    expect(result.details.host).to.equal('redis');
    expect(result.details.port).to.equal('6379');
    expect(JSON.stringify(result)).to.not.contain(secret);
  });

  it('adds a Redis service alert when Redis is down', async function() {
    var alerts = await operationalHealthService.getAlerts([{
      name: 'redis',
      label: 'Redis',
      status: 'down',
      latencyMs: null,
      details: { reason: 'not_ready' }
    }], []);

    expect(alerts.some(function(alert) {
      return alert.key === 'service:redis' &&
        alert.type === 'service_health' &&
        alert.severity === 'critical';
    })).to.equal(true);
  });

  it('reports RabbitMQ queue metrics from the management API', async function() {
    var result = await operationalHealthService.checkRabbit({
      url: null,
      queueNames: ['webhooks'],
      managementClient: {
        getQueue: async function(queueName) {
          return {
            name: queueName,
            state: 'running',
            messages: 108,
            messages_ready: 101,
            messages_unacknowledged: 7,
            consumers: 2
          };
        }
      }
    });

    expect(result.status).to.equal('degraded');
    expect(result.details.queueSource).to.equal('management');
    expect(result.details.queues).to.have.lengthOf(1);
    expect(result.details.queues[0].name).to.equal('webhooks');
    expect(result.details.queues[0].messagesReady).to.equal(101);
    expect(result.details.queues[0].messagesUnacknowledged).to.equal(7);
    expect(result.details.queues[0].messagesTotal).to.equal(108);
    expect(result.details.queues[0].consumers).to.equal(2);
  });

  it('adds RabbitMQ queue alerts for ready backlog, unacked backlog, and missing consumers', async function() {
    var alerts = await operationalHealthService.getAlerts([{
      name: 'rabbitmq',
      label: 'RabbitMQ',
      status: 'degraded',
      latencyMs: null,
      details: {
        queues: [{
          name: 'ready-queue',
          status: 'degraded',
          messagesReady: 101,
          messagesUnacknowledged: 0,
          consumers: 1
        }, {
          name: 'unacked-queue',
          status: 'degraded',
          messagesReady: 0,
          messagesUnacknowledged: 101,
          consumers: 1
        }, {
          name: 'orphan-queue',
          status: 'degraded',
          messagesReady: 1,
          messagesUnacknowledged: 0,
          consumers: 0
        }]
      }
    }], []);

    expect(alerts.some(function(alert) {
      return alert.key === 'queue_backlog:ready-queue' && alert.type === 'queue_backlog';
    })).to.equal(true);
    expect(alerts.some(function(alert) {
      return alert.key === 'queue_unacked:unacked-queue' && alert.type === 'queue_unacked';
    })).to.equal(true);
    expect(alerts.some(function(alert) {
      return alert.key === 'queue_no_consumers:orphan-queue' && alert.type === 'queue_no_consumers';
    })).to.equal(true);
  });

  it('reports Storage health with a write/read/delete probe', async function() {
    var secret = 'REDACTED_SECRET';
    var originalSecret = process.env.R2_SECRET_ACCESS_KEY;
    process.env.R2_SECRET_ACCESS_KEY = secret;

    var stored = {};
    var calls = [];
    var payload = Buffer.from('storage-ok');

    try {
      var result = await operationalHealthService.checkStorage({
        cache: false,
        driver: 'r2',
        filename: 'healthchecks/storage/test-storage-ok.txt',
        payload: payload,
        fileService: {
          createFile: async function(filename, data) {
            calls.push('create');
            stored[filename] = Buffer.from(data);
          },
          getFileDataAsBuffer: async function(filename) {
            calls.push('read');
            return stored[filename];
          },
          deleteFile: async function(filename) {
            calls.push('delete');
            delete stored[filename];
          }
        }
      });

      expect(result.status).to.equal('ok');
      expect(result.name).to.equal('storage');
      expect(result.details.driver).to.equal('r2');
      expect(result.details.bytes).to.equal(payload.length);
      expect(calls).to.deep.equal(['create', 'read', 'delete']);
      expect(JSON.stringify(result)).to.not.contain(secret);
    } finally {
      if (originalSecret === undefined) {
        delete process.env.R2_SECRET_ACCESS_KEY;
      } else {
        process.env.R2_SECRET_ACCESS_KEY = originalSecret;
      }
    }
  });

  it('reports Storage down when the readback verification fails', async function() {
    var result = await operationalHealthService.checkStorage({
      cache: false,
      driver: 'r2',
      filename: 'healthchecks/storage/test-storage-fail.txt',
      payload: Buffer.from('expected-storage-data'),
      fileService: {
        createFile: async function() {},
        getFileDataAsBuffer: async function() {
          return Buffer.from('wrong-storage-data');
        },
        deleteFile: async function() {}
      }
    });

    expect(result.status).to.equal('down');
    expect(result.details.driver).to.equal('r2');
    expect(result.details.error).to.contain('storage read verification failed');
  });

  it('adds a Storage service alert when Storage is down', async function() {
    var alerts = await operationalHealthService.getAlerts([{
      name: 'storage',
      label: 'Storage',
      status: 'down',
      latencyMs: null,
      details: { driver: 'r2', error: 'storage read verification failed' }
    }], []);

    expect(alerts.some(function(alert) {
      return alert.key === 'service:storage' &&
        alert.type === 'service_health' &&
        alert.severity === 'critical';
    })).to.equal(true);
  });

  it('forces a fresh Storage health probe from the super admin route', async function() {
    var res = await new Promise(function(resolve, reject) {
      chai.request(server)
        .post('/sadmin/health/storage/test')
        .auth(adminEmail, pwd)
        .end(function(err, response) {
          if (err) return reject(err);
          resolve(response);
        });
    });

    res.should.have.status(200);
    expect(res.body).to.have.property('generatedAt');
    expect(res.body.result.name).to.equal('storage');
    expect(['ok', 'down', 'skipped']).to.contain(res.body.result.status);

    var event = await OperationalEvent.findOne({ event: 'storage.health_check' }).sort({ timestamp: -1 }).lean();
    expect(event).to.exist;
    expect(event.area).to.equal('storage');
    expect(event.channel).to.equal('system');
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

  it('sends a manual operational alert notification test from the super admin route', async function() {
    var originalWebhookUrl = process.env.OPERATIONAL_ALERT_WEBHOOK_URL;
    var originalWebhookEvents = process.env.OPERATIONAL_ALERT_WEBHOOK_EVENTS;
    var originalMinSeverity = process.env.OPERATIONAL_ALERT_MIN_SEVERITY;

    process.env.OPERATIONAL_ALERT_WEBHOOK_URL = 'https://alerts-route.test/hook';
    process.env.OPERATIONAL_ALERT_WEBHOOK_EVENTS = 'alert.opened';
    process.env.OPERATIONAL_ALERT_MIN_SEVERITY = 'critical';

    try {
      var scope = nock('https://alerts-route.test')
        .post('/hook', function(body) {
          expect(body.event).to.equal('alert.opened');
          expect(body.type).to.equal('manual_test');
          expect(body.severity).to.equal('critical');
          expect(body.title).to.equal('Teste manual de alertas operacionais');
          return true;
        })
        .reply(202, { ok: true });

      var res = await postAsSuperAdmin('/sadmin/operational-alerts/test-notification', adminEmail, pwd);

      res.should.have.status(200);
      expect(res.body.result.status).to.equal('sent');
      expect(res.body.result.ok).to.equal(true);
      expect(res.body.result.webhook.status).to.equal('sent');
      expect(res.body.result.webhook.httpStatus).to.equal(202);
      expect(scope.isDone()).to.equal(true);

      var event = await OperationalEvent.findOne({ event: 'operational.alert_notification.test' }).lean();
      expect(event).to.exist;
      expect(event.status).to.equal('sent');
      expect(event.details.notificationStatus).to.equal('sent');
      expect(event.details.triggeredBy).to.contain('@email.com');
      expect(event.details.notificationResults.webhook.status).to.equal('sent');
    } finally {
      if (originalWebhookUrl === undefined) {
        delete process.env.OPERATIONAL_ALERT_WEBHOOK_URL;
      } else {
        process.env.OPERATIONAL_ALERT_WEBHOOK_URL = originalWebhookUrl;
      }
      if (originalWebhookEvents === undefined) {
        delete process.env.OPERATIONAL_ALERT_WEBHOOK_EVENTS;
      } else {
        process.env.OPERATIONAL_ALERT_WEBHOOK_EVENTS = originalWebhookEvents;
      }
      if (originalMinSeverity === undefined) {
        delete process.env.OPERATIONAL_ALERT_MIN_SEVERITY;
      } else {
        process.env.OPERATIONAL_ALERT_MIN_SEVERITY = originalMinSeverity;
      }
    }
  });

  it('returns operational metrics history to super admin', async function() {
    var now = new Date();
    var oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    var twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    await OperationalEvent.create([
      {
        timestamp: oneHourAgo,
        level: 'error',
        area: 'webhook',
        channel: 'casezap',
        id_project: 'operation-metrics',
        event: 'webhook.failed',
        status: 'failed',
        errorMessage: 'boom'
      },
      {
        timestamp: twoHoursAgo,
        level: 'warn',
        area: 'queue',
        channel: 'system',
        event: 'queue.backlog',
        status: 'open'
      }
    ]);

    await OperationalAlert.create([
      {
        key: 'metrics:casezap',
        type: 'webhook_failure',
        severity: 'critical',
        status: 'open',
        title: 'Webhook falhando',
        message: 'casezap failing',
        channel: 'casezap',
        id_project: 'operation-metrics',
        lastAt: oneHourAgo
      },
      {
        key: 'metrics:queue',
        type: 'queue_backlog',
        severity: 'warning',
        status: 'resolved',
        title: 'Fila acumulando',
        message: 'queue backlog',
        service: 'rabbitmq',
        lastAt: twoHoursAgo,
        resolvedAt: oneHourAgo
      }
    ]);

    var res = await getAsSuperAdmin('/sadmin/operational-metrics?range=24h&bucket=hour', adminEmail, pwd);

    res.should.have.status(200);
    expect(res.body.range).to.equal('24h');
    expect(res.body.bucket).to.equal('hour');
    expect(res.body.events.total).to.equal(2);
    expect(res.body.events.byLevel.error).to.equal(1);
    expect(res.body.events.byLevel.warn).to.equal(1);
    expect(res.body.events.byChannel.casezap).to.equal(1);
    expect(res.body.alerts.total).to.equal(2);
    expect(res.body.alerts.openCount).to.equal(1);
    expect(res.body.alerts.criticalOpenCount).to.equal(1);
    expect(res.body.alerts.bySeverity.critical).to.equal(1);
    expect(res.body.alerts.byStatus.resolved).to.equal(1);
    expect(res.body.events.byBucket).to.be.an('array');
    expect(res.body.events.byBucket.some(function(bucket) { return bucket.count > 0; })).to.equal(true);
  });

  it('detects CaseZap banned-like provider status', async function() {
    var integration = await Integration.create({
      id_project: 'operation-casezap-banned',
      name: 'casezap',
      value: {
        instanceName: 'CaseZap banned',
        domain: 'https://casezap-status.test',
        token: 'cz-token'
      }
    });

    nock('https://casezap-status.test')
      .get('/instance/status')
      .reply(200, {
        instance: { status: 'bannedm' },
        status: { connected: false, loggedIn: false }
      });
    nock('https://casezap-status.test')
      .get('/instance/wa_messages_limits')
      .reply(200, { can_send_new_messages: true });

    var res = await new Promise(function(resolve, reject) {
      chai.request(server)
        .post('/sadmin/health/channels/test')
        .auth(adminEmail, pwd)
        .send({ channel: 'casezap', integrationId: String(integration._id) })
        .end(function(err, response) {
          if (err) return reject(err);
          resolve(response);
        });
    });

    res.should.have.status(200);
    expect(res.body.result.providerHealth).to.equal('down');
    expect(res.body.result.providerReason).to.contain('bannedm');

    var updated = await Integration.findById(integration._id).lean();
    expect(updated.value.status).to.equal('disconnected');
    expect(updated.value.operational.lastProviderHealth).to.equal('down');
  });

  it('detects CaseZap message restrictions as degraded', async function() {
    var integration = await Integration.create({
      id_project: 'operation-casezap-limited',
      name: 'casezap',
      value: {
        instanceName: 'CaseZap limited',
        domain: 'https://casezap-limited.test',
        token: 'cz-token'
      }
    });

    nock('https://casezap-limited.test')
      .get('/instance/status')
      .reply(200, {
        instance: { status: 'connected' },
        status: { connected: true, loggedIn: true }
      });
    nock('https://casezap-limited.test')
      .get('/instance/wa_messages_limits')
      .reply(200, {
        can_send_new_messages: false,
        error_key: 'WHATSAPP_REACHOUT_TIMELOCK',
        new_chat_message_capping: { status: 'CAPPED' }
      });

    var res = await new Promise(function(resolve, reject) {
      chai.request(server)
        .post('/sadmin/health/channels/test')
        .auth(adminEmail, pwd)
        .send({ channel: 'casezap', integrationId: String(integration._id) })
        .end(function(err, response) {
          if (err) return reject(err);
          resolve(response);
        });
    });

    res.should.have.status(200);
    expect(res.body.result.providerHealth).to.equal('degraded');
    expect(res.body.result.providerCode).to.equal('WHATSAPP_REACHOUT_TIMELOCK');
  });

  it('detects WABA restricted or red quality status', async function() {
    var integration = await Integration.create({
      id_project: 'operation-waba-restricted',
      name: 'whatsapp',
      value: {
        verified_name: 'Restricted WABA',
        waba_id: 'waba-restricted',
        phone_number_id: 'phone-restricted'
      }
    });

    await mongoose.connection.collection('kvstore').insertOne({
      key: 'whatsapp-waba-restricted',
      project_id: 'operation-waba-restricted',
      value: {
        wab_token: 'meta-token',
        waba_id: 'waba-restricted',
        phone_number_id: 'phone-restricted'
      }
    });

    nock('https://graph.facebook.com')
      .get('/v25.0/phone-restricted')
      .query(true)
      .reply(200, {
        id: 'phone-restricted',
        display_phone_number: '+15550000000',
        verified_name: 'Restricted WABA',
        status: 'RESTRICTED',
        quality_rating: 'RED',
        name_status: 'APPROVED'
      });

    var res = await new Promise(function(resolve, reject) {
      chai.request(server)
        .post('/sadmin/health/channels/test')
        .auth(adminEmail, pwd)
        .send({ channel: 'waba', integrationId: String(integration._id) })
        .end(function(err, response) {
          if (err) return reject(err);
          resolve(response);
        });
    });

    res.should.have.status(200);
    expect(res.body.result.providerHealth).to.equal('degraded');
    expect(res.body.result.providerStatus).to.equal('RESTRICTED');
    expect(res.body.result.qualityRating).to.equal('RED');
  });

  it('lists WABA channels stored only in kvstore', async function() {
    var inserted = await mongoose.connection.collection('kvstore').insertOne({
      key: 'whatsapp-waba-kvstore',
      project_id: 'operation-waba-kvstore',
      value: {
        verified_name: 'WABA kvstore',
        wab_token: 'meta-token',
        waba_id: 'waba-kvstore',
        phone_number_id: 'phone-kvstore'
      }
    });

    nock('https://graph.facebook.com')
      .get('/v25.0/phone-kvstore')
      .query(true)
      .reply(200, {
        id: 'phone-kvstore',
        display_phone_number: '+15550000001',
        verified_name: 'WABA kvstore',
        status: 'CONNECTED',
        quality_rating: 'GREEN',
        name_status: 'APPROVED'
      });

    var res = await getAsSuperAdmin('/sadmin/health/channels', adminEmail, pwd);

    res.should.have.status(200);
    var channel = res.body.channels.find(function(item) {
      return item.integrationDocId === String(inserted.insertedId);
    });
    expect(channel).to.exist;
    expect(channel.channel).to.equal('waba');
    expect(channel.integrationSource).to.equal('kvstore');
    expect(channel.integrationId).to.equal('phone-kvstore');
    expect(channel.providerHealth).to.equal('ok');

    var updated = await mongoose.connection.collection('kvstore').findOne({ _id: inserted.insertedId });
    expect(updated.value.operational.lastProviderHealth).to.equal('ok');
  });

  it('tests WABA connections stored only in kvstore', async function() {
    var inserted = await mongoose.connection.collection('kvstore').insertOne({
      key: 'whatsapp-waba-kvstore-test',
      project_id: 'operation-waba-kvstore-test',
      value: {
        verified_name: 'WABA kvstore test',
        wab_token: 'meta-token',
        waba_id: 'waba-kvstore-test',
        phone_number_id: 'phone-kvstore-test'
      }
    });

    nock('https://graph.facebook.com')
      .get('/v25.0/phone-kvstore-test')
      .query(true)
      .reply(200, {
        id: 'phone-kvstore-test',
        display_phone_number: '+15550000002',
        verified_name: 'WABA kvstore test',
        status: 'CONNECTED',
        quality_rating: 'GREEN',
        name_status: 'APPROVED'
      });

    var res = await postAsSuperAdmin('/sadmin/health/channels/test', adminEmail, pwd, {
      channel: 'waba',
      integrationId: String(inserted.insertedId)
    });

    res.should.have.status(200);
    expect(res.body.result.channel).to.equal('waba');
    expect(res.body.result.providerHealth).to.equal('ok');

    var event = await OperationalEvent.findOne({
      channel: 'waba',
      integrationId: String(inserted.insertedId),
      event: 'channel.provider_check'
    }).lean();
    expect(event).to.exist;
    expect(event.status).to.equal('success');

    var channelsRes = await getAsSuperAdmin('/sadmin/health/channels', adminEmail, pwd);
    channelsRes.should.have.status(200);
    var channel = channelsRes.body.channels.find(function(item) {
      return item.integrationDocId === String(inserted.insertedId);
    });
    expect(channel).to.exist;
    expect(channel.lastEvent).to.equal('channel.provider_check');
  });

  it('tests the exact WABA kvstore row when a project has multiple WABAs', async function() {
    await mongoose.connection.collection('kvstore').insertOne({
      key: 'whatsapp-waba-kvstore-a',
      project_id: 'operation-waba-kvstore-shared',
      value: {
        verified_name: 'WABA kvstore A',
        wab_token: 'meta-token-a',
        waba_id: 'waba-kvstore-a',
        phone_number_id: 'phone-kvstore-a'
      }
    });

    var inserted = await mongoose.connection.collection('kvstore').insertOne({
      key: 'whatsapp-waba-kvstore-b',
      project_id: 'operation-waba-kvstore-shared',
      value: {
        verified_name: 'WABA kvstore B',
        wab_token: 'meta-token-b',
        waba_id: 'waba-kvstore-b',
        phone_number_id: 'phone-kvstore-b'
      }
    });

    nock('https://graph.facebook.com')
      .get('/v25.0/phone-kvstore-b')
      .query(function(query) {
        return query.access_token === 'meta-token-b';
      })
      .reply(200, {
        id: 'phone-kvstore-b',
        display_phone_number: '+15550000003',
        verified_name: 'WABA kvstore B',
        status: 'CONNECTED',
        quality_rating: 'GREEN',
        name_status: 'APPROVED'
      });

    var res = await postAsSuperAdmin('/sadmin/health/channels/test', adminEmail, pwd, {
      channel: 'waba',
      integrationId: String(inserted.insertedId)
    });

    res.should.have.status(200);
    expect(res.body.result.providerHealth).to.equal('ok');
    expect(res.body.result.integrationId).to.equal(String(inserted.insertedId));

    var stale = await mongoose.connection.collection('kvstore').findOne({ key: 'whatsapp-waba-kvstore-a' });
    var updated = await mongoose.connection.collection('kvstore').findOne({ _id: inserted.insertedId });
    expect(stale.value.operational).to.equal(undefined);
    expect(updated.value.operational.lastProviderHealth).to.equal('ok');
  });

  it('does not list WABA kvstore rows marked as trashed', async function() {
    var inserted = await mongoose.connection.collection('kvstore').insertOne({
      key: 'whatsapp-waba-kvstore-trashed',
      project_id: 'operation-waba-kvstore-trashed',
      value: {
        verified_name: 'WABA kvstore trashed',
        wab_token: 'meta-token',
        waba_id: 'waba-kvstore-trashed',
        phone_number_id: 'phone-kvstore-trashed',
        trashed: true
      }
    });

    var res = await getAsSuperAdmin('/sadmin/health/channels', adminEmail, pwd);

    res.should.have.status(200);
    var channel = res.body.channels.find(function(item) {
      return item.integrationDocId === String(inserted.insertedId);
    });
    expect(channel).to.equal(undefined);
  });

  it('manually re-registers a CaseZap webhook and records the operation', async function() {
    var originalExternalBaseUrl = process.env.EXTERNAL_BASE_URL;
    process.env.EXTERNAL_BASE_URL = 'https://chatcase.example.com';
    try {
      var integration = await Integration.create({
        id_project: 'operation-casezap-register',
        name: 'casezap',
        value: {
          instanceName: 'CaseZap register',
          domain: 'https://casezap-register.test',
          token: 'cz-token'
        }
      });

      nock('https://casezap-register.test')
        .post('/webhook', function(body) {
          return body &&
            body.enabled === true &&
            body.url.indexOf('/api/modules/casezap/webhook/' + String(integration._id)) !== -1 &&
            body.url.indexOf('secret=') !== -1;
        })
        .reply(200, { ok: true });

      var res = await postAsSuperAdmin('/sadmin/health/channels/webhook/register', adminEmail, pwd, {
        channel: 'casezap',
        integrationId: String(integration._id)
      });

      res.should.have.status(200);
      expect(res.body.result.status).to.equal('registered');
      expect(res.body.result.channel).to.equal('casezap');

      var updated = await Integration.findById(integration._id).lean();
      expect(updated.value.webhookSecret).to.be.a('string');
      expect(updated.value.operational.lastWebhookRegistrationStatus).to.equal('success');

      var event = await OperationalEvent.findOne({
        channel: 'casezap',
        integrationId: String(integration._id),
        event: 'channel.webhook_registered'
      }).lean();
      expect(event).to.exist;
      expect(event.status).to.equal('success');
    } finally {
      if (originalExternalBaseUrl === undefined) {
        delete process.env.EXTERNAL_BASE_URL;
      } else {
        process.env.EXTERNAL_BASE_URL = originalExternalBaseUrl;
      }
    }
  });

  it('manually re-registers a WABA subscribed app and records the operation', async function() {
    var integration = await Integration.create({
      id_project: 'operation-waba-register',
      name: 'whatsapp',
      value: {
        verified_name: 'WABA register',
        waba_id: 'waba-register',
        phone_number_id: 'phone-register'
      }
    });

    await mongoose.connection.collection('kvstore').insertOne({
      key: 'whatsapp-waba-register',
      project_id: 'operation-waba-register',
      value: {
        wab_token: 'meta-token',
        waba_id: 'waba-register',
        phone_number_id: 'phone-register'
      }
    });

    nock('https://graph.facebook.com')
      .post('/v25.0/waba-register/subscribed_apps')
      .query({ access_token: 'meta-token' })
      .reply(200, { success: true });

    var res = await postAsSuperAdmin('/sadmin/health/channels/webhook/register', adminEmail, pwd, {
      channel: 'waba',
      integrationId: String(integration._id)
    });

    res.should.have.status(200);
    expect(res.body.result.status).to.equal('registered');
    expect(res.body.result.channel).to.equal('waba');

    var updated = await Integration.findById(integration._id).lean();
    expect(updated.value.operational.lastWebhookRegistrationStatus).to.equal('success');

    var event = await OperationalEvent.findOne({
      channel: 'waba',
      integrationId: String(integration._id),
      event: 'channel.webhook_registered'
    }).lean();
    expect(event).to.exist;
    expect(event.status).to.equal('success');
  });

  it('manually re-registers a WABA subscribed app stored only in kvstore', async function() {
    var inserted = await mongoose.connection.collection('kvstore').insertOne({
      key: 'whatsapp-waba-kvstore-register',
      project_id: 'operation-waba-kvstore-register',
      value: {
        verified_name: 'WABA kvstore register',
        wab_token: 'meta-token',
        waba_id: 'waba-kvstore-register',
        phone_number_id: 'phone-kvstore-register'
      }
    });

    nock('https://graph.facebook.com')
      .post('/v25.0/waba-kvstore-register/subscribed_apps')
      .query({ access_token: 'meta-token' })
      .reply(200, { success: true });

    var res = await postAsSuperAdmin('/sadmin/health/channels/webhook/register', adminEmail, pwd, {
      channel: 'waba',
      integrationId: String(inserted.insertedId)
    });

    res.should.have.status(200);
    expect(res.body.result.status).to.equal('registered');
    expect(res.body.result.channel).to.equal('waba');

    var updated = await mongoose.connection.collection('kvstore').findOne({ _id: inserted.insertedId });
    expect(updated.value.operational.lastWebhookRegistrationStatus).to.equal('success');

    var event = await OperationalEvent.findOne({
      channel: 'waba',
      integrationId: String(inserted.insertedId),
      event: 'channel.webhook_registered'
    }).lean();
    expect(event).to.exist;
    expect(event.status).to.equal('success');
  });

  it('manually re-registers a WABA subscribed app stored with business account id only', async function() {
    var inserted = await mongoose.connection.collection('kvstore').insertOne({
      key: 'whatsapp-waba-kvstore-business-register',
      project_id: 'operation-waba-kvstore-business-register',
      value: {
        verified_name: 'WABA kvstore business register',
        wab_token: 'meta-token',
        business_account_id: 'business-kvstore-register',
        phone_number_id: 'phone-business-register'
      }
    });

    nock('https://graph.facebook.com')
      .post('/v25.0/business-kvstore-register/subscribed_apps')
      .query({ access_token: 'meta-token' })
      .reply(200, { success: true });

    var res = await postAsSuperAdmin('/sadmin/health/channels/webhook/register', adminEmail, pwd, {
      channel: 'waba',
      integrationId: String(inserted.insertedId)
    });

    res.should.have.status(200);
    expect(res.body.result.status).to.equal('registered');
    expect(res.body.result.channel).to.equal('waba');

    var updated = await mongoose.connection.collection('kvstore').findOne({ _id: inserted.insertedId });
    expect(updated.value.operational.lastWebhookRegistrationStatus).to.equal('success');
  });

  it('includes Sentry environment metadata in the manual Sentry test response', async function() {
    var res = await postAsSuperAdmin('/sadmin/sentry/test', adminEmail, pwd);
    res.should.have.status(200);
    expect(res.body.result).to.have.property('environment');
    expect(res.body.result).to.have.property('release');
  });

  it('accepts a custom manual Sentry test title and fingerprint', async function() {
    var res = await postAsSuperAdmin('/sadmin/sentry/test', adminEmail, pwd, {
      title: 'ChatCase manual Sentry custom validation',
      fingerprint: 'chatcase-custom-sentry-validation'
    });

    res.should.have.status(200);
    expect(res.body.result.title).to.equal('ChatCase manual Sentry custom validation');
    expect(res.body.result.fingerprint).to.equal('chatcase-custom-sentry-validation');
  });

  it('adds channel health alerts to summary', async function() {
    var integration = await Integration.create({
      id_project: 'operation-casezap-summary',
      name: 'casezap',
      value: {
        instanceName: 'CaseZap summary',
        domain: 'https://casezap-summary.test',
        token: 'cz-token'
      }
    });

    nock('https://casezap-summary.test')
      .get('/instance/status')
      .reply(200, {
        instance: { status: 'bannedm' },
        status: { connected: false, loggedIn: false }
      });
    nock('https://casezap-summary.test')
      .get('/instance/wa_messages_limits')
      .reply(200, { can_send_new_messages: true });

    var res = await getAsSuperAdmin('/sadmin/health/summary', adminEmail, pwd);
    res.should.have.status(200);
    expect(res.body.alerts.some(function(alert) {
      return alert.key === 'channel:casezap:' + String(integration._id) && alert.severity === 'critical';
    })).to.equal(true);
  });
});
