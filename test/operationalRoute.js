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
var operationalMonitorService = require('../services/operationalMonitorService');
var OperationalEvent = require('../models/operationalEvent');
var OperationalAlert = require('../models/operationalAlert');
var OperationalHealthSnapshot = require('../models/operationalHealthSnapshot');
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
    await OperationalHealthSnapshot.deleteMany({});
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

  it('returns an empty read-only health summary when the snapshot is missing', async function() {
    var res = await getAsSuperAdmin('/sadmin/health/summary', adminEmail, pwd);

    res.should.have.status(200);
    expect(res.body).to.include({
      overallStatus: 'unknown',
      snapshotState: 'missing'
    });
    expect(res.body.services).to.deep.equal([]);
    expect(res.body.queues).to.deep.equal([]);
    expect(res.body.channels.count).to.equal(0);
    expect(res.body.alerts.count).to.equal(0);
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

  it('returns 503 with the stable error when the snapshot is invalid or unavailable', async function() {
    var originalFindOne = OperationalHealthSnapshot.findOne;

    try {
      OperationalHealthSnapshot.findOne = function() {
        return { lean: async function() { return { _id: 'singleton', version: 2 }; } };
      };

      var invalidRes = await getAsSuperAdmin('/sadmin/health/summary', adminEmail, pwd);
      invalidRes.should.have.status(503);
      expect(invalidRes.body).to.deep.equal({
        error: {
          code: 'health_snapshot_unavailable',
          message: 'Operational health snapshot unavailable'
        }
      });

      OperationalHealthSnapshot.findOne = function() {
        return { lean: async function() { throw new Error('database unavailable'); } };
      };

      var unavailableRes = await getAsSuperAdmin('/sadmin/health/summary', adminEmail, pwd);
      unavailableRes.should.have.status(503);
      expect(unavailableRes.body.error.code).to.equal('health_snapshot_unavailable');
    } finally {
      OperationalHealthSnapshot.findOne = originalFindOne;
    }
  });

  it('keeps all health GETs read-only and free of infrastructure probes', async function() {
    var originalGetServices = operationalHealthService.getServices;
    var originalGetChannels = operationalHealthService.getChannels;
    var originalCheckRabbit = operationalHealthService.checkRabbit;

    try {
      operationalHealthService.getServices = function() {
        throw new Error('GET /health/services executed a probe');
      };
      operationalHealthService.getChannels = function() {
        throw new Error('GET /health/channels executed a probe');
      };
      operationalHealthService.checkRabbit = function() {
        throw new Error('GET /health/queues executed a probe');
      };

      var summary = await getAsSuperAdmin('/sadmin/health/summary', adminEmail, pwd);
      var services = await getAsSuperAdmin('/sadmin/health/services', adminEmail, pwd);
      var channels = await getAsSuperAdmin('/sadmin/health/channels', adminEmail, pwd);
      var queues = await getAsSuperAdmin('/sadmin/health/queues', adminEmail, pwd);

      summary.should.have.status(200);
      services.should.have.status(200);
      channels.should.have.status(200);
      queues.should.have.status(200);
    } finally {
      operationalHealthService.getServices = originalGetServices;
      operationalHealthService.getChannels = originalGetChannels;
      operationalHealthService.checkRabbit = originalCheckRabbit;
    }
  });

  it('returns allowlisted queue metrics from the snapshot without probing RabbitMQ', async function() {
    await OperationalHealthSnapshot.create(operationalHealthService.buildSnapshot({
      services: [],
      queues: [{
        name: 'webhooks',
        status: 'degraded',
        cause: 'queue_backlog',
        messagesReady: 101,
        messagesUnacknowledged: 7,
        messagesTotal: 108,
        consumers: 2,
        providerPayload: { token: 'queue-secret' }
      }],
      channels: [],
      alerts: []
    }, new Date('2026-07-10T12:00:00.000Z')));

    var originalCheckRabbit = operationalHealthService.checkRabbit;
    operationalHealthService.checkRabbit = function() {
      throw new Error('queue GET executed a probe');
    };

    try {
      var res = await getAsSuperAdmin('/sadmin/health/queues', adminEmail, pwd);
      res.should.have.status(200);
      expect(res.body.queueService.details.queues[0]).to.include({
        name: 'webhooks',
        messagesReady: 101,
        messagesUnacknowledged: 7,
        messagesTotal: 108,
        consumers: 2
      });
      expect(JSON.stringify(res.body)).to.not.contain('queue-secret');
    } finally {
      operationalHealthService.checkRabbit = originalCheckRabbit;
    }
  });

  it('returns paginated persisted channels with filters and total count', async function() {
    var first = await Integration.create({
      id_project: 'operation-channel-first',
      name: 'casezap',
      value: {
        token: 'channel-secret-first',
        instanceName: 'First',
        operational: {
          lastProviderHealth: 'degraded',
          lastProviderReason: 'upstream_timeout',
          lastProviderCheckAt: '2026-07-10T11:00:00.000Z'
        }
      }
    });
    await Integration.create({
      id_project: 'operation-channel-second',
      name: 'casezap',
      value: {
        token: 'channel-secret-second',
        instanceName: 'Second',
        operational: {
          lastProviderHealth: 'degraded',
          lastProviderReason: 'provider_check_failed',
          lastProviderError: 'raw-provider-error-must-not-leak',
          lastProviderCheckAt: '2026-07-10T11:05:00.000Z'
        }
      }
    });
    await Integration.create({
      id_project: 'operation-channel-ok',
      name: 'whatsapp',
      value: {
        access_token: 'waba-secret',
        phone_number_id: 'phone-1',
        operational: {
          lastProviderHealth: 'ok',
          lastProviderReason: 'provider_status_ok',
          lastProviderCheckAt: '2026-07-10T11:10:00.000Z'
        }
      }
    });

    var res = await getAsSuperAdmin(
      '/sadmin/health/channels?page=2&limit=1&product=casezap&channel=casezap&status=degraded&from=2026-07-10T10:00:00.000Z&to=2026-07-10T12:00:00.000Z',
      adminEmail,
      pwd
    );

    res.should.have.status(200);
    expect(Object.keys(res.body)).to.deep.equal(['data', 'count', 'page', 'limit']);
    expect(res.body.count).to.equal(2);
    expect(res.body.page).to.equal(2);
    expect(res.body.limit).to.equal(1);
    expect(res.body.data).to.have.lengthOf(1);
    expect(res.body.data[0]).to.include({
      product: 'casezap',
      channel: 'casezap',
      status: 'degraded'
    });
    expect(res.body.data[0].id).to.equal(String(first._id));
    expect(res.body.data[0].cause).to.equal('upstream_timeout');
    expect(JSON.stringify(res.body)).to.not.contain('channel-secret');
    expect(JSON.stringify(res.body)).to.not.contain('raw-provider-error-must-not-leak');

    var causeRes = await getAsSuperAdmin(
      '/sadmin/health/channels?cause=provider_check_failed',
      adminEmail,
      pwd
    );
    causeRes.should.have.status(200);
    expect(causeRes.body.count).to.equal(1);
    expect(causeRes.body.data[0].cause).to.equal('provider_check_failed');
  });

  it('returns an empty paginated channel result for unmatched filters', async function() {
    var res = await getAsSuperAdmin('/sadmin/health/channels?page=3&limit=25&product=unknown', adminEmail, pwd);

    res.should.have.status(200);
    expect(res.body).to.deep.equal({ data: [], count: 0, page: 3, limit: 25 });
  });

  it('rejects non-canonical and unknown channel query filters with a typed 400', async function() {
    this.timeout(10000);
    var invalidFilters = [
      { query: 'unknown=1', field: 'unknown' },
      { query: 'from=not-a-date', field: 'from' },
      { query: 'to=not-a-date', field: 'to' },
      { query: 'from=2026-02-30', field: 'from' },
      { query: 'to=2026-02-30', field: 'to' },
      { query: 'from=2026-13-01', field: 'from' },
      { query: 'from=2026-01-00', field: 'from' },
      { query: 'from=2027-02-29', field: 'from' },
      { query: 'from=2026-01-01T24:00:00.000Z', field: 'from' },
      { query: 'page=0', field: 'page' },
      { query: 'limit=0', field: 'limit' },
      { query: 'page=1.5', field: 'page' },
      { query: 'limit=1.5', field: 'limit' },
      { query: 'page=-1', field: 'page' },
      { query: 'page=NaN', field: 'page' },
      { query: 'page=1mixed', field: 'page' },
      { query: 'page=01', field: 'page' },
      { query: 'limit=201', field: 'limit' },
      { query: 'from=2026-07-11T00:00:00.000Z&to=2026-07-10T00:00:00.000Z', field: 'range' },
      { query: 'product=telegram', field: 'product' },
      { query: 'channel=telegram', field: 'channel' },
      { query: 'status=invalid', field: 'status' },
      { query: 'cause=arbitrary_provider_text', field: 'cause' }
    ];
    var results = [];

    for (var i = 0; i < invalidFilters.length; i++) {
      results.push({
        expected: invalidFilters[i],
        response: await getAsSuperAdmin('/sadmin/health/channels?' + invalidFilters[i].query, adminEmail, pwd)
      });
    }

    expect(results.map(function(result) { return result.response.status; })).to.deep.equal(
      invalidFilters.map(function() { return 400; })
    );
    results.forEach(function(result) {
      expect(result.response.body.error.code).to.equal('invalid_operational_filter');
      expect(result.response.body.error.field).to.equal(result.expected.field);
    });
  });

  it('preserves the stable missing WABA phone cause without accepting arbitrary text', async function() {
    var stable = await Integration.create({
      id_project: 'operation-channel-missing-phone',
      name: 'whatsapp',
      value: {
        verified_name: 'WABA missing phone',
        operational: {
          channel: 'webhook',
          lastProviderHealth: 'unknown',
          lastProviderReason: 'missing_waba_phone_number_id',
          lastProviderCheckAt: '2026-07-10T11:00:00.000Z'
        }
      }
    });
    var arbitrary = await Integration.create({
      id_project: 'operation-channel-arbitrary-cause',
      name: 'whatsapp',
      value: {
        verified_name: 'WABA arbitrary cause',
        operational: {
          channel: 'webhook',
          lastProviderHealth: 'unknown',
          lastProviderReason: 'provider_returned_arbitrary_text',
          lastProviderCheckAt: '2026-07-10T10:00:00.000Z'
        }
      }
    });

    var allRes = await getAsSuperAdmin('/sadmin/health/channels?channel=webhook', adminEmail, pwd);
    allRes.should.have.status(200);
    expect(allRes.body.page).to.equal(1);
    expect(allRes.body.limit).to.equal(100);
    var stableDto = allRes.body.data.find(function(item) { return item.id === String(stable._id); });
    var arbitraryDto = allRes.body.data.find(function(item) { return item.id === String(arbitrary._id); });
    expect(stableDto.cause).to.equal('missing_waba_phone_number_id');
    expect(arbitraryDto.cause).to.equal(null);

    var filteredRes = await getAsSuperAdmin(
      '/sadmin/health/channels?cause=missing_waba_phone_number_id',
      adminEmail,
      pwd
    );
    filteredRes.should.have.status(200);
    expect(filteredRes.body.count).to.equal(1);
    expect(filteredRes.body.data[0].id).to.equal(String(stable._id));
  });

  it('accepts strict calendar dates for channel and alert filters', async function() {
    this.timeout(10000);
    var validQueries = [
      'from=2026-07-10',
      'from=2026-07-10T10:00:00Z&to=2026-07-10T12:00:00Z',
      'from=2026-07-10T10:00:00.000Z&to=2026-07-10T12:00:00.000Z',
      'from=2028-02-29&to=2028-03-01'
    ];
    var endpoints = ['/sadmin/health/channels?', '/sadmin/operational-alerts?'];

    for (var i = 0; i < endpoints.length; i++) {
      for (var j = 0; j < validQueries.length; j++) {
        var res = await getAsSuperAdmin(endpoints[i] + validQueries[j], adminEmail, pwd);
        res.should.have.status(200);
      }
    }
  });

  it('applies date-only end bounds inclusively to channels and alerts', async function() {
    await Integration.create({
      id_project: 'operation-date-channel',
      name: 'whatsapp',
      value: {
        phone_number_id: 'operation-date-phone',
        operational: {
          channel: 'waba',
          lastProviderHealth: 'ok',
          lastProviderCheckAt: '2026-07-10T23:59:59.999Z'
        }
      }
    });
    await OperationalAlert.create([
      {
        key: 'operation-date-alert-midday',
        type: 'queue_backlog',
        severity: 'warning',
        status: 'open',
        lastAt: '2026-07-10T12:00:00.000Z'
      },
      {
        key: 'operation-date-alert-end',
        type: 'queue_backlog',
        severity: 'warning',
        status: 'open',
        lastAt: '2026-07-10T23:59:59.999Z'
      },
      {
        key: 'operation-date-alert-next-day',
        type: 'queue_backlog',
        severity: 'warning',
        status: 'open',
        lastAt: '2026-07-11T00:00:00.000Z'
      }
    ]);

    var channels = await getAsSuperAdmin('/sadmin/health/channels?from=2026-07-10&to=2026-07-10', adminEmail, pwd);
    var alerts = await getAsSuperAdmin('/sadmin/operational-alerts?from=2026-07-10&to=2026-07-10', adminEmail, pwd);
    var range = await getAsSuperAdmin(
      '/sadmin/operational-alerts?from=2026-07-10T12:00:00.001Z&to=2026-07-10T23:59:59.999Z',
      adminEmail,
      pwd
    );

    channels.should.have.status(200);
    alerts.should.have.status(200);
    range.should.have.status(200);
    expect(channels.body.count).to.equal(1);
    expect(alerts.body.count).to.equal(2);
    expect(range.body.count).to.equal(1);
    expect(range.body.data[0].key).to.equal('operation-date-alert-end');
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

  it('does not write operational alerts from a health summary GET', async function() {
    await OperationalAlert.create({
      key: 'webhook:casezap:integration-alert',
      type: 'webhook_failure',
      severity: 'critical',
      status: 'open',
      title: 'Webhook falhando',
      message: 'webhook failed',
      occurrences: 1
    });

    var res = await getAsSuperAdmin('/sadmin/health/summary', adminEmail, pwd);
    res.should.have.status(200);
    expect(res.body.snapshotState).to.equal('missing');
    expect(res.body.alerts.count).to.equal(0);

    var alert = await OperationalAlert.findOne({ key: 'webhook:casezap:integration-alert' }).lean();
    expect(alert.status).to.equal('open');
    expect(alert.occurrences).to.equal(1);
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

  it('returns paginated persisted alerts with cause filters and redaction', async function() {
    await OperationalAlert.create([
      {
        key: 'operation-alert-first',
        type: 'channel_health',
        severity: 'warning',
        status: 'open',
        channel: 'waba',
        firstAt: '2026-07-10T11:00:00.000Z',
        lastAt: '2026-07-10T11:00:00.000Z',
        details: { providerReason: 'provider_timeout', token: 'alert-secret-first' }
      },
      {
        key: 'operation-alert-second',
        type: 'channel_health',
        severity: 'warning',
        status: 'open',
        channel: 'waba',
        firstAt: '2026-07-10T11:05:00.000Z',
        lastAt: '2026-07-10T11:05:00.000Z',
        details: { providerReason: 'provider_timeout', token: 'alert-secret-second' }
      },
      {
        key: 'operation-alert-resolved',
        type: 'channel_health',
        severity: 'warning',
        status: 'resolved',
        channel: 'waba',
        firstAt: '2026-07-10T11:10:00.000Z',
        lastAt: '2026-07-10T11:10:00.000Z',
        details: { providerReason: 'provider_timeout' }
      }
    ]);

    var res = await getAsSuperAdmin(
      '/sadmin/operational-alerts?page=2&limit=1&status=open&channel=waba&cause=provider_timeout&from=2026-07-10T10:00:00.000Z&to=2026-07-10T12:00:00.000Z',
      adminEmail,
      pwd
    );

    res.should.have.status(200);
    expect(Object.keys(res.body)).to.deep.equal(['data', 'count', 'page', 'limit']);
    expect(res.body.count).to.equal(2);
    expect(res.body.page).to.equal(2);
    expect(res.body.limit).to.equal(1);
    expect(res.body.data).to.have.lengthOf(1);
    expect(res.body.data[0].cause).to.equal('provider_timeout');
    expect(JSON.stringify(res.body)).to.not.contain('alert-secret');
  });

  it('rejects invalid operational alert filters with a typed 400', async function() {
    this.timeout(10000);
    await OperationalAlert.create({
      key: 'operation-alert-filter-guard',
      type: 'channel_health',
      severity: 'warning',
      status: 'open',
      channel: 'waba'
    });

    var invalidFilters = [
      { query: 'status=invalid', field: 'status' },
      { query: 'cause=not_a_stable_cause', field: 'cause' },
      { query: 'product=telegram', field: 'product' },
      { query: 'from=not-a-date', field: 'from' },
      { query: 'to=not-a-date', field: 'to' },
      { query: 'from=2026-02-30', field: 'from' },
      { query: 'to=2026-02-30', field: 'to' },
      { query: 'from=2026-13-01', field: 'from' },
      { query: 'from=2026-01-00', field: 'from' },
      { query: 'from=2027-02-29', field: 'from' },
      { query: 'from=2026-01-01T24:00:00.000Z', field: 'from' },
      { query: 'from=2026-07-11T00:00:00.000Z&to=2026-07-10T00:00:00.000Z', field: 'range' },
      { query: 'channel=waba&channel=casezap', field: 'channel' },
      { query: 'queue=', field: 'queue' },
      { query: 'queue=%20%20', field: 'queue' },
      { query: 'queue=jobs&queue=other', field: 'queue' },
      { query: 'queue%5B%24ne%5D=jobs', field: 'queue' },
      { query: 'page=0', field: 'page' },
      { query: 'limit=201', field: 'limit' }
    ];

    for (var i = 0; i < invalidFilters.length; i++) {
      var res = await getAsSuperAdmin('/sadmin/operational-alerts?' + invalidFilters[i].query, adminEmail, pwd);
      res.should.have.status(400);
      expect(res.body.error.code).to.equal('invalid_operational_filter');
      expect(res.body.error.field).to.equal(invalidFilters[i].field);
    }
  });

  it('filters alerts by persisted queue before pagination and includes the date-only end', async function() {
    await OperationalAlert.create([
      {
        key: 'operation-alert-queue-midday',
        type: 'queue_backlog',
        severity: 'warning',
        status: 'open',
        queue: 'jobs',
        lastAt: '2026-07-10T12:00:00.000Z',
        details: { queue: 'other', token: 'queue-alert-secret' }
      },
      {
        key: 'operation-alert-queue-end',
        type: 'queue_backlog',
        severity: 'warning',
        status: 'open',
        queue: 'jobs',
        lastAt: '2026-07-10T23:59:59.999Z'
      },
      {
        key: 'operation-alert-queue-next-day',
        type: 'queue_backlog',
        severity: 'warning',
        status: 'open',
        queue: 'jobs',
        lastAt: '2026-07-11T00:00:00.000Z'
      },
      {
        key: 'operation-alert-queue-other',
        type: 'queue_backlog',
        severity: 'warning',
        status: 'open',
        queue: 'other',
        lastAt: '2026-07-10T13:00:00.000Z'
      }
    ]);

    var res = await getAsSuperAdmin(
      '/sadmin/operational-alerts?page=2&limit=1&queue=%20jobs%20&to=2026-07-10',
      adminEmail,
      pwd
    );

    res.should.have.status(200);
    expect(res.body.count).to.equal(2);
    expect(res.body.data).to.have.lengthOf(1);
    expect(res.body.data[0].key).to.equal('operation-alert-queue-midday');
    expect(JSON.stringify(res.body)).to.not.contain('queue-alert-secret');
  });

  it('returns an allowlisted alert DTO without raw provider data', async function() {
    var secret = 'REDACTED_SECRET';
    await OperationalAlert.collection.insertOne({
      key: 'operation-alert-dto-secret',
      type: 'channel_health',
      severity: 'critical',
      status: 'open',
      title: 'Provider unavailable',
      message: secret,
      channel: 'waba',
      firstAt: new Date('2026-07-10T11:00:00.000Z'),
      lastAt: new Date('2026-07-10T11:05:00.000Z'),
      lastError: secret,
      stack: secret,
      providerPayload: { authorization: secret },
      details: {
        product: 'waba',
        providerReason: 'provider_timeout',
        token: secret,
        lastError: secret,
        stack: secret,
        providerPayload: { authorization: secret }
      }
    });
    await OperationalAlert.collection.insertOne({
      key: 'operation-alert-dto-unstable-cause',
      type: 'channel_health',
      severity: 'warning',
      status: 'open',
      firstAt: new Date('2026-07-10T10:00:00.000Z'),
      lastAt: new Date('2026-07-10T10:00:00.000Z'),
      details: { providerReason: 'not_a_stable_cause' }
    });

    var res = await getAsSuperAdmin('/sadmin/operational-alerts?status=open', adminEmail, pwd);
    res.should.have.status(200);
    var secured = res.body.data.find(function(alert) {
      return alert.key === 'operation-alert-dto-secret';
    });
    var unstable = res.body.data.find(function(alert) {
      return alert.key === 'operation-alert-dto-unstable-cause';
    });

    expect(secured.cause).to.equal('provider_timeout');
    expect(secured).to.not.have.property('message');
    expect(secured).to.not.have.property('details');
    expect(secured).to.not.have.property('lastError');
    expect(secured).to.not.have.property('stack');
    expect(secured).to.not.have.property('providerPayload');
    expect(unstable.cause).to.equal(null);
    expect(JSON.stringify(res.body)).to.not.contain(secret);
  });

  it('requires a superadmin and routes one channel test through the monitor', async function() {
    var unauthenticated = await new Promise(function(resolve, reject) {
      chai.request(server).get('/sadmin/health/channels').end(function(err, res) {
        if (err) return reject(err);
        resolve(res);
      });
    });
    expect(unauthenticated.status).to.be.oneOf([401, 403]);

    var missingIntegration = await postAsSuperAdmin('/sadmin/health/channels/test', adminEmail, pwd, {});
    missingIntegration.should.have.status(400);

    var originalTestIntegration = operationalMonitorService.testIntegration;
    var testedIntegrationId;
    operationalMonitorService.testIntegration = async function(integrationId) {
      testedIntegrationId = integrationId;
      return { status: 'ok', integrationId: integrationId };
    };

    try {
      var res = await postAsSuperAdmin('/sadmin/health/channels/test', adminEmail, pwd, {
        integrationId: 'integration-only'
      });

      res.should.have.status(200);
      expect(testedIntegrationId).to.equal('integration-only');
      expect(res.body.result.status).to.equal('ok');
    } finally {
      operationalMonitorService.testIntegration = originalTestIntegration;
    }
  });

  it('validates and sanitizes a single integration test result', async function() {
    var invalidBodies = [{}, { integrationId: '' }, { integrationId: '   ' }, { integrationId: 42 }];
    for (var i = 0; i < invalidBodies.length; i++) {
      var invalidRes = await postAsSuperAdmin('/sadmin/health/channels/test', adminEmail, pwd, invalidBodies[i]);
      invalidRes.should.have.status(400);
      expect(invalidRes.body.error.code).to.equal('invalid_integration_id');
    }

    var secret = 'REDACTED_SECRET';
    var originalTestIntegration = operationalMonitorService.testIntegration;
    var testedIntegrationId;
    operationalMonitorService.testIntegration = async function(integrationId) {
      testedIntegrationId = integrationId;
      return {
        status: 'down',
        channel: 'casezap',
        integrationId: integrationId,
        providerHealth: 'down',
        providerStatus: 'unreachable',
        providerReason: 'provider_unreachable',
        providerError: secret,
        stack: secret,
        providerPayload: { token: secret },
        details: { authorization: secret }
      };
    };

    try {
      var res = await postAsSuperAdmin('/sadmin/health/channels/test', adminEmail, pwd, {
        integrationId: '  integration-secret-test  '
      });

      res.should.have.status(200);
      expect(testedIntegrationId).to.equal('integration-secret-test');
      expect(res.body.result).to.include({
        status: 'down',
        channel: 'casezap',
        integrationId: 'integration-secret-test',
        providerHealth: 'down',
        providerReason: 'provider_unreachable'
      });
      expect(res.body.result).to.not.have.property('providerError');
      expect(res.body.result).to.not.have.property('details');
      expect(res.body.result).to.not.have.property('providerPayload');
      expect(res.body.result).to.not.have.property('stack');
      expect(JSON.stringify(res.body)).to.not.contain(secret);
    } finally {
      operationalMonitorService.testIntegration = originalTestIntegration;
    }
  });

  it('does not expose a thrown provider error from an integration test', async function() {
    var secret = 'REDACTED_SECRET';
    var originalTestIntegration = operationalMonitorService.testIntegration;
    operationalMonitorService.testIntegration = async function() {
      var error = new Error('provider failed with token ' + secret);
      error.statusCode = 502;
      throw error;
    };

    try {
      var res = await postAsSuperAdmin('/sadmin/health/channels/test', adminEmail, pwd, {
        integrationId: 'integration-error-test'
      });

      res.should.have.status(502);
      expect(res.body).to.deep.equal({
        error: {
          code: 'integration_test_failed',
          message: 'Failed to test channel health'
        }
      });
      expect(JSON.stringify(res.body)).to.not.contain(secret);
    } finally {
      operationalMonitorService.testIntegration = originalTestIntegration;
    }
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
        phone_number_id: 'phone-kvstore',
        operational: {
          lastProviderHealth: 'ok',
          lastProviderReason: 'provider_status_ok',
          lastProviderCheckAt: '2026-07-10T11:00:00.000Z'
        }
      }
    });

    var res = await getAsSuperAdmin('/sadmin/health/channels', adminEmail, pwd);

    res.should.have.status(200);
    var channel = res.body.data.find(function(item) {
      return item.id === String(inserted.insertedId);
    });
    expect(channel).to.exist;
    expect(channel.channel).to.equal('waba');
    expect(channel.status).to.equal('ok');
    expect(channel.cause).to.equal('provider_status_ok');
  });

  it('does not list a kvstore WABA without persisted operational diagnostics', async function() {
    var inserted = await mongoose.connection.collection('kvstore').insertOne({
      key: 'whatsapp-waba-kvstore-without-operational',
      project_id: 'operation-waba-kvstore-without-operational',
      value: {
        verified_name: 'WABA without diagnostics',
        wab_token: 'meta-token',
        waba_id: 'waba-without-operational',
        phone_number_id: 'phone-without-operational'
      }
    });

    var res = await getAsSuperAdmin('/sadmin/health/channels', adminEmail, pwd);

    res.should.have.status(200);
    expect(res.body.data.some(function(item) {
      return item.id === String(inserted.insertedId);
    })).to.equal(false);
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
    var channel = channelsRes.body.data.find(function(item) {
      return item.id === String(inserted.insertedId);
    });
    expect(channel).to.exist;
    expect(channel.status).to.equal('ok');
    expect(channel.cause).to.equal('provider_status_ok');
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
    var channel = res.body.data.find(function(item) {
      return item.id === String(inserted.insertedId);
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

  it('returns the persisted channel aggregation without probing from summary', async function() {
    await OperationalHealthSnapshot.create(operationalHealthService.buildSnapshot({
      services: [],
      queues: [],
      channels: [{
        product: 'casezap',
        channel: 'casezap',
        status: 'down',
        cause: 'provider_check_failed'
      }],
      alerts: []
    }, new Date('2026-07-10T12:00:00.000Z')));

    var res = await getAsSuperAdmin('/sadmin/health/summary', adminEmail, pwd);
    res.should.have.status(200);
    expect(res.body.channels.count).to.equal(1);
    expect(res.body.channels.byProduct.casezap.down).to.equal(1);
    expect(res.body.channels.topCauses).to.deep.equal([{ cause: 'provider_check_failed', count: 1 }]);
  });
});
