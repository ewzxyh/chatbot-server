process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

var chai = require('chai');
var expect = chai.expect;
var operationalHealthService = require('../services/operationalHealthService');
var operationalMonitorService = require('../services/operationalMonitorService');
var OperationalHealthSnapshot = require('../models/operationalHealthSnapshot');

var stableCauses = [
  'provider_timeout',
  'queue_backlog',
  'queue_unacked',
  'queue_no_consumers',
  'mongo_unavailable',
  'storage_unavailable'
];

function inputWithSixCauses() {
  return {
    services: [{ name: 'server', status: 'ok' }],
    channels: stableCauses.map(function(cause) {
      return {
        channel: 'casezap',
        status: 'degraded',
        providerReason: cause
      };
    }),
    alerts: stableCauses.map(function(cause) {
      return {
        severity: 'warning',
        status: 'open',
        details: { cause: cause }
      };
    })
  };
}

describe('OperationalMonitorService', function() {
  var originalDisableBackgroundWorkers;
  var originalMonitorEnabled;

  beforeEach(function() {
    originalDisableBackgroundWorkers = process.env.DISABLE_BACKGROUND_WORKERS;
    originalMonitorEnabled = process.env.OPERATIONAL_MONITOR_ENABLED;
    operationalMonitorService.stop();
  });

  afterEach(function() {
    operationalMonitorService.stop();
    if (originalDisableBackgroundWorkers === undefined) {
      delete process.env.DISABLE_BACKGROUND_WORKERS;
    } else {
      process.env.DISABLE_BACKGROUND_WORKERS = originalDisableBackgroundWorkers;
    }
    if (originalMonitorEnabled === undefined) {
      delete process.env.OPERATIONAL_MONITOR_ENABLED;
    } else {
      process.env.OPERATIONAL_MONITOR_ENABLED = originalMonitorEnabled;
    }
  });

  it('does not start when background workers are disabled', function() {
    process.env.DISABLE_BACKGROUND_WORKERS = 'true';

    var result = operationalMonitorService.start({
      app: {},
      healthService: {
        getSummary: async function() {
          throw new Error('should not run');
        }
      }
    });

    expect(result.started).to.equal(false);
    expect(result.reason).to.equal('background_workers_disabled');
    expect(operationalMonitorService.status().started).to.equal(false);
  });

  it('runs one monitoring cycle and returns the generated summary', async function() {
    var calls = 0;
    var leaseOwner = 'test-owner';
    var now = new Date('2026-07-10T12:00:00.000Z');
    var result = await operationalMonitorService.runOnce({
      leaseOwner: leaseOwner,
      now: now,
      healthService: {
        collectSnapshotInput: async function() {
          calls += 1;
          return {
            services: [{ name: 'server', status: 'ok' }],
            channels: [],
            alerts: []
          };
        }
      },
      snapshotModel: {
        findOneAndUpdate: async function(filter, update, options) {
          if (update.$set.monitorLease) {
            expect(filter._id).to.equal('singleton');
            expect(filter.$or).to.be.an('array');
            expect(update.$set.monitorLease.owner).to.equal(leaseOwner);
            expect(options.upsert).to.equal(true);
            expect(options.new).to.equal(true);
            expect(options.setDefaultsOnInsert).to.equal(false);
            expect(update.$setOnInsert).to.equal(undefined);
            return { monitorLease: update.$set.monitorLease };
          }
          expect(filter._id).to.equal('singleton');
          expect(filter['monitorLease.owner']).to.equal(leaseOwner);
          expect(filter['monitorLease.expiresAt']).to.deep.equal({ $gt: now });
          expect(update.$set.version).to.equal(2);
          expect(update.$unset).to.deep.equal({ monitorLease: '' });
          return update.$set;
        }
      }
    });

    expect(result.version).to.equal(2);
    expect(result.overallStatus).to.equal('ok');
    expect(calls).to.equal(1);
    expect(operationalMonitorService.status().lastStatus).to.equal('ok');
  });

  it('skips a cycle when a previous cycle is still running', async function() {
    var release;
    var running = operationalMonitorService.runOnce({
      app: {},
      healthService: {
        collectSnapshotInput: function() {
          return new Promise(function(resolve) {
            release = function() {
              resolve({
                services: [{ name: 'server', status: 'ok' }],
                channels: [],
                alerts: []
              });
            };
          });
        }
      },
      snapshotModel: {
        findOneAndUpdate: async function(filter, update) {
          if (update.$set && update.$set.monitorLease) {
            return { monitorLease: update.$set.monitorLease };
          }
          return update.$set;
        }
      }
    });

    var skipped = await operationalMonitorService.runOnce({
      app: {},
      healthService: {
        getSummary: async function() {
          throw new Error('should be skipped');
        }
      }
    });

    expect(skipped.skipped).to.equal(true);
    expect(skipped.reason).to.equal('already_running');

    await new Promise(function(resolve) { setImmediate(resolve); });
    release();
    await running;
  });

  it('records a sanitized failure event when a cycle fails', async function() {
    var recorded = [];
    var result = await operationalMonitorService.runOnce({
      app: {},
      healthService: {
        collectSnapshotInput: async function() {
          throw new Error('monitor failed');
        }
      },
      snapshotModel: {
        findOneAndUpdate: async function(filter, update) {
          if (update.$set && update.$set.monitorLease) {
            return { monitorLease: update.$set.monitorLease };
          }
          return null;
        }
      },
      logger: {
        recordSafe: function(event) {
          recorded.push(event);
        }
      }
    });

    expect(result.ok).to.equal(false);
    expect(result.error).to.equal('monitor failed');
    expect(recorded).to.have.lengthOf(1);
    expect(recorded[0].event).to.equal('operational.monitor.failed');
    expect(recorded[0].status).to.equal('failed');
  });

  it('builds a v2 snapshot with valid statuses, severity, and product aggregates', function() {
    var snapshot = operationalHealthService.buildSnapshot({
      services: [
        { name: 'server', status: 'ok' },
        { name: 'mongo', status: 'down', details: { reason: 'mongo_unavailable' } }
      ],
      queues: [{ name: 'jobs', status: 'degraded', cause: 'queue_backlog' }],
      channels: [
        { channel: 'casezap', status: 'degraded', providerReason: 'provider_timeout' },
        { channel: 'whatsapp', status: 'ok' }
      ],
      alerts: [{ severity: 'warning', status: 'open', details: { cause: 'provider_timeout' } }]
    }, new Date('2026-07-10T12:00:00.000Z'));

    expect(snapshot.version).to.equal(2);
    expect(snapshot.overallStatus).to.equal('down');
    expect(snapshot.services[1].cause).to.equal('mongo_unavailable');
    expect(snapshot.channels.byProduct.casezap.degraded).to.equal(1);
    expect(snapshot.channels.byProduct.waba.ok).to.equal(1);
    expect(snapshot.alerts.byStatus.degraded).to.equal(1);
  });

  it('preserves only allowlisted queue metrics in the snapshot', function() {
    var secret = 'REDACTED_SECRET';
    var snapshot = operationalHealthService.buildSnapshot({
      services: [],
      queues: [{
        name: 'webhooks',
        status: 'degraded',
        cause: 'queue_backlog',
        messagesReady: 101,
        messagesUnacknowledged: 7,
        messagesTotal: 108,
        consumers: 2,
        providerPayload: { token: secret },
        error: secret
      }],
      channels: [],
      alerts: []
    }, new Date('2026-07-10T12:00:00.000Z'));

    expect(snapshot.queues[0]).to.include({
      name: 'webhooks',
      status: 'degraded',
      cause: 'queue_backlog',
      messagesReady: 101,
      messagesUnacknowledged: 7,
      messagesTotal: 108,
      consumers: 2
    });
    expect(JSON.stringify(snapshot)).to.not.contain(secret);

    var persisted = new OperationalHealthSnapshot(snapshot);
    expect(persisted.validateSync()).to.equal(undefined);
    expect(persisted.queues[0].messagesReady).to.equal(101);
    expect(persisted.queues[0].messagesUnacknowledged).to.equal(7);
    expect(persisted.queues[0].messagesTotal).to.equal(108);
    expect(persisted.queues[0].consumers).to.equal(2);
  });

  it('keeps the snapshot bounded', function() {
    var snapshot = operationalHealthService.buildSnapshot(inputWithSixCauses(), new Date('2026-07-10T12:00:00.000Z'));

    expect(snapshot.version).to.equal(2);
    expect(snapshot.channels.topCauses).to.have.lengthOf(5);
    expect(snapshot.alerts.topCauses).to.have.lengthOf(5);
  });

  it('normalizes unknown products into the bounded unknown bucket', function() {
    var snapshot = operationalHealthService.buildSnapshot({
      services: [],
      channels: ['casezap', 'waba'].concat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function(index) {
        return 'product-' + index;
      })).map(function(product) {
        return { product: product, status: 'ok' };
      }),
      alerts: []
    }, new Date('2026-07-10T12:00:00.000Z'));

    expect(Object.keys(snapshot.channels.byProduct).sort()).to.deep.equal(['casezap', 'unknown', 'waba']);
    expect(snapshot.channels.byProduct.unknown.ok).to.equal(10);
  });

  it('enforces the singleton id in the snapshot model', function() {
    var error = new OperationalHealthSnapshot({ _id: 'another-id' }).validateSync();

    expect(error).to.exist;
    expect(error.errors._id).to.exist;
  });

  it('does not persist raw provider errors as causes', function() {
    var secret = 'Authorization Bearer super-secret-token';
    var snapshot = operationalHealthService.buildSnapshot({
      services: [{
        name: 'mongo',
        status: 'down',
        providerError: secret,
        lastError: 'database password=' + secret,
        details: { error: secret }
      }],
      channels: [{
        product: 'casezap',
        status: 'down',
        providerError: secret,
        lastError: secret,
        details: { error: secret }
      }],
      alerts: [{
        status: 'open',
        severity: 'critical',
        details: { error: secret }
      }]
    }, new Date('2026-07-10T12:00:00.000Z'));

    expect(JSON.stringify(snapshot)).to.not.contain(secret);
    expect(snapshot.services[0].cause).to.equal(null);
    expect(snapshot.channels.topCauses).to.deep.equal([]);
    expect(snapshot.alerts.topCauses).to.deep.equal([]);
  });

  it('maps allowlisted alert types to stable top causes without leaking messages', function() {
    var secret = 'Bearer secret-alert-token';
    var snapshot = operationalHealthService.buildSnapshot({
      services: [],
      channels: [],
      alerts: [
        { type: 'webhook_failure', status: 'open', severity: 'critical', message: secret, details: { error: secret } },
        { type: 'queue_backlog', status: 'open', severity: 'warning', message: secret },
        { type: 'queue_unacked', status: 'open', severity: 'warning', lastError: secret },
        { type: 'queue_no_consumers', status: 'open', severity: 'critical', providerError: secret },
        { type: 'unsafe_' + secret, status: 'open', severity: 'warning', details: { error: secret } }
      ]
    }, new Date('2026-07-10T12:00:00.000Z'));

    expect(snapshot.alerts.topCauses.map(function(item) { return item.cause; })).to.have.members([
      'webhook_failure',
      'queue_backlog',
      'queue_unacked',
      'queue_no_consumers'
    ]);
    expect(snapshot.alerts.topCauses).to.have.lengthOf(4);
    expect(JSON.stringify(snapshot)).to.not.contain(secret);
  });

  it('maps allowlisted channel provider reasons without leaking arbitrary values', function() {
    var secret = 'REDACTED_SECRET';
    var snapshot = operationalHealthService.buildSnapshot({
      services: [],
      channels: [],
      alerts: [
        {
          type: 'channel_health',
          status: 'open',
          severity: 'warning',
          details: { reason: secret, providerReason: 'provider_timeout', error: secret }
        },
        {
          type: 'channel_health',
          status: 'open',
          severity: 'warning',
          details: { providerReason: secret, error: secret }
        }
      ]
    }, new Date('2026-07-10T12:00:00.000Z'));

    expect(snapshot.alerts.topCauses).to.deep.equal([{ cause: 'provider_timeout', count: 1 }]);
    expect(JSON.stringify(snapshot)).to.not.contain(secret);
  });

  it('derives fresh, stale, and missing snapshot states without writing', function() {
    var now = new Date('2026-07-10T12:00:00.000Z');
    var fresh = { generatedAt: '2026-07-10T11:59:00.000Z', expiresAt: '2026-07-10T12:05:00.000Z' };
    var stale = { generatedAt: '2026-07-10T11:50:00.000Z', expiresAt: '2026-07-10T11:55:00.000Z' };

    expect(operationalHealthService.deriveSnapshotState(fresh, now)).to.equal('fresh');
    expect(operationalHealthService.deriveSnapshotState(stale, now)).to.equal('stale');
    expect(operationalHealthService.deriveSnapshotState(null, now)).to.equal('missing');
  });

  it('reads only the singleton snapshot for the summary', async function() {
    var originalFindOne = OperationalHealthSnapshot.findOne;
    var filter;
    OperationalHealthSnapshot.findOne = function(query) {
      filter = query;
      return {
        lean: async function() {
          return {
            _id: 'singleton',
            version: 2,
            overallStatus: 'ok',
            generatedAt: '2026-07-10T11:59:00.000Z',
            expiresAt: '2026-07-10T12:05:00.000Z',
            services: [],
            queues: [],
            channels: {
              count: 0,
              byStatus: { ok: 0, degraded: 0, down: 0, unknown: 0 },
              byProduct: {
                casezap: { ok: 0, degraded: 0, down: 0, unknown: 0 },
                waba: { ok: 0, degraded: 0, down: 0, unknown: 0 },
                unknown: { ok: 0, degraded: 0, down: 0, unknown: 0 }
              },
              topCauses: []
            },
            alerts: {
              count: 0,
              byStatus: { ok: 0, degraded: 0, down: 0, unknown: 0 },
              topCauses: []
            }
          };
        }
      };
    };

    try {
      var summary = await operationalHealthService.getSummary();
      expect(filter).to.deep.equal({ _id: 'singleton' });
      expect(summary.snapshotState).to.equal('fresh');
      expect(summary._id).to.equal(undefined);
    } finally {
      OperationalHealthSnapshot.findOne = originalFindOne;
    }
  });

  it('returns an explicit summary contract without lean document extras', async function() {
    var originalFindOne = OperationalHealthSnapshot.findOne;
    var secret = 'REDACTED_SECRET';
    var persistedSnapshot = operationalHealthService.buildSnapshot({
      services: [{ name: 'server', status: 'ok' }],
      queues: [{ name: 'jobs', status: 'ok' }],
      channels: [{ product: 'casezap', status: 'degraded', cause: 'provider_timeout' }],
      alerts: [{ type: 'webhook_failure', status: 'down' }]
    }, new Date('2026-07-10T12:00:00.000Z'));
    persistedSnapshot.rootSecret = secret;
    persistedSnapshot.services[0].secret = secret;
    persistedSnapshot.queues[0].secret = secret;
    persistedSnapshot.channels.secret = secret;
    persistedSnapshot.channels.byStatus.secret = secret;
    persistedSnapshot.channels.byProduct.casezap.secret = secret;
    persistedSnapshot.channels.topCauses[0].secret = secret;
    persistedSnapshot.alerts.secret = secret;
    persistedSnapshot.alerts.byStatus.secret = secret;
    persistedSnapshot.alerts.topCauses[0].secret = secret;
    OperationalHealthSnapshot.findOne = function() {
      return { lean: async function() { return persistedSnapshot; } };
    };

    try {
      var summary = await operationalHealthService.getSummary();
      expect(JSON.stringify(summary)).to.not.contain(secret);
      expect(Object.keys(summary).sort()).to.deep.equal([
        'alerts',
        'channels',
        'expiresAt',
        'generatedAt',
        'overallStatus',
        'queues',
        'services',
        'snapshotState',
        'version'
      ]);
      expect(Object.keys(summary.services[0])).to.deep.equal(['name', 'status', 'cause', 'checkedAt']);
      expect(Object.keys(summary.channels.topCauses[0])).to.deep.equal(['cause', 'count']);
      expect(Object.keys(summary.alerts.topCauses[0])).to.deep.equal(['cause', 'count']);
    } finally {
      OperationalHealthSnapshot.findOne = originalFindOne;
    }
  });

  it('rejects a structurally invalid persisted snapshot with a typed error', async function() {
    var originalFindOne = OperationalHealthSnapshot.findOne;
    OperationalHealthSnapshot.findOne = function() {
      return {
        lean: async function() {
          return {
            _id: 'singleton',
            version: 2,
            overallStatus: 'ok',
            generatedAt: '2026-07-10T11:59:00.000Z',
            expiresAt: '2026-07-10T12:05:00.000Z',
            services: [],
            queues: [],
            channels: {},
            alerts: {}
          };
        }
      };
    };

    try {
      await operationalHealthService.getSummary();
      throw new Error('expected snapshot validation to fail');
    } catch (err) {
      expect(err.name).to.equal('OperationalHealthSnapshotUnavailableError');
      expect(err.code).to.equal('health_snapshot_unavailable');
    } finally {
      OperationalHealthSnapshot.findOne = originalFindOne;
    }
  });

  it('rejects null, empty, and non-string top causes', async function() {
    var originalFindOne = OperationalHealthSnapshot.findOne;
    var persistedSnapshot;
    OperationalHealthSnapshot.findOne = function() {
      return { lean: async function() { return persistedSnapshot; } };
    };

    try {
      var invalidCauses = [null, '', 42];
      for (var i = 0; i < invalidCauses.length; i++) {
        persistedSnapshot = operationalHealthService.buildSnapshot({ services: [], channels: [], alerts: [] }, new Date('2026-07-10T12:00:00.000Z'));
        persistedSnapshot.alerts.topCauses = [{ cause: invalidCauses[i], count: 1 }];
        try {
          await operationalHealthService.getSummary();
          throw new Error('expected top cause validation to fail');
        } catch (err) {
          expect(err.code).to.equal('health_snapshot_unavailable');
        }
      }
    } finally {
      OperationalHealthSnapshot.findOne = originalFindOne;
    }
  });

  it('rejects channel product sums inconsistent with count and byStatus', async function() {
    var originalFindOne = OperationalHealthSnapshot.findOne;
    var persistedSnapshot = operationalHealthService.buildSnapshot({
      services: [],
      channels: [
        { product: 'casezap', status: 'ok' },
        { product: 'waba', status: 'degraded' }
      ],
      alerts: []
    }, new Date('2026-07-10T12:00:00.000Z'));
    persistedSnapshot.channels.byProduct.casezap.ok = 0;
    OperationalHealthSnapshot.findOne = function() {
      return { lean: async function() { return persistedSnapshot; } };
    };

    try {
      await operationalHealthService.getSummary();
      throw new Error('expected product aggregate validation to fail');
    } catch (err) {
      expect(err.code).to.equal('health_snapshot_unavailable');
    } finally {
      OperationalHealthSnapshot.findOne = originalFindOne;
    }
  });

  it('rejects overall status inconsistent with component severity', async function() {
    var originalFindOne = OperationalHealthSnapshot.findOne;
    var persistedSnapshot = operationalHealthService.buildSnapshot({
      services: [{ name: 'server', status: 'down' }],
      channels: [],
      alerts: []
    }, new Date('2026-07-10T12:00:00.000Z'));
    persistedSnapshot.overallStatus = 'ok';
    OperationalHealthSnapshot.findOne = function() {
      return { lean: async function() { return persistedSnapshot; } };
    };

    try {
      await operationalHealthService.getSummary();
      throw new Error('expected overall status validation to fail');
    } catch (err) {
      expect(err.code).to.equal('health_snapshot_unavailable');
    } finally {
      OperationalHealthSnapshot.findOne = originalFindOne;
    }
  });

  it('accepts coherent ok, degraded, down, and unknown overall statuses', async function() {
    var originalFindOne = OperationalHealthSnapshot.findOne;
    var persistedSnapshot;
    var cases = [{
      expected: 'ok',
      input: { services: [{ name: 'server', status: 'ok' }], channels: [], alerts: [] }
    }, {
      expected: 'degraded',
      input: { services: [], channels: [{ product: 'casezap', status: 'degraded' }], alerts: [] }
    }, {
      expected: 'down',
      input: { services: [], channels: [], alerts: [{ type: 'webhook_failure', status: 'down' }] }
    }, {
      expected: 'unknown',
      input: { services: [], queues: [{ name: 'jobs', status: 'unknown' }], channels: [], alerts: [] }
    }];
    OperationalHealthSnapshot.findOne = function() {
      return { lean: async function() { return persistedSnapshot; } };
    };

    try {
      for (var i = 0; i < cases.length; i++) {
        persistedSnapshot = operationalHealthService.buildSnapshot(cases[i].input, new Date('2026-07-10T12:00:00.000Z'));
        var summary = await operationalHealthService.getSummary();
        expect(summary.overallStatus).to.equal(cases[i].expected);
      }
    } finally {
      OperationalHealthSnapshot.findOne = originalFindOne;
    }
  });

  it('keeps summary missing when the first monitored probe fails', async function() {
    var originalFindOne = OperationalHealthSnapshot.findOne;
    var document = null;
    var snapshotModel = {
      findOneAndUpdate: async function(filter, update) {
        if (!document) {
          document = Object.assign({ _id: 'singleton' }, update.$setOnInsert || {});
        }
        if (update.$set && update.$set.monitorLease) document.monitorLease = update.$set.monitorLease;
        if (update.$unset && update.$unset.monitorLease) delete document.monitorLease;
        return document;
      }
    };
    OperationalHealthSnapshot.findOne = function() {
      return { lean: async function() { return document; } };
    };

    try {
      var result = await operationalMonitorService.runOnce({
        now: new Date('2030-07-10T12:00:00.000Z'),
        leaseOwner: 'first-probe-owner',
        snapshotModel: snapshotModel,
        healthService: {
          collectSnapshotInput: async function() { throw new Error('first probe failed'); }
        },
        logger: { recordSafe: function() {} }
      });
      var summary = await operationalHealthService.getSummary();

      expect(result.error).to.equal('first probe failed');
      expect(summary.snapshotState).to.equal('missing');
      expect(summary.overallStatus).to.equal('unknown');
    } finally {
      OperationalHealthSnapshot.findOne = originalFindOne;
    }
  });

  it('preserves an existing snapshot when a monitored probe fails', async function() {
    var originalFindOne = OperationalHealthSnapshot.findOne;
    var document = operationalHealthService.buildSnapshot({
      services: [{ name: 'server', status: 'ok' }], channels: [], alerts: []
    }, new Date('2030-07-10T12:00:00.000Z'));
    document._id = 'singleton';
    var generatedAt = document.generatedAt;
    var snapshotModel = {
      findOneAndUpdate: async function(filter, update) {
        if (update.$set && update.$set.monitorLease) document.monitorLease = update.$set.monitorLease;
        if (update.$unset && update.$unset.monitorLease) delete document.monitorLease;
        return document;
      }
    };
    OperationalHealthSnapshot.findOne = function() {
      return { lean: async function() { return document; } };
    };

    try {
      await operationalMonitorService.runOnce({
        now: new Date('2030-07-10T12:01:00.000Z'),
        leaseOwner: 'existing-snapshot-owner',
        snapshotModel: snapshotModel,
        healthService: {
          collectSnapshotInput: async function() { throw new Error('probe failed'); }
        },
        logger: { recordSafe: function() {} }
      });
      var summary = await operationalHealthService.getSummary();

      expect(summary.generatedAt).to.equal(generatedAt);
      expect(summary.overallStatus).to.equal('ok');
      expect(summary.snapshotState).to.equal('fresh');
    } finally {
      OperationalHealthSnapshot.findOne = originalFindOne;
    }
  });

  it('acquires and releases the persisted lease with ownership', async function() {
    var owner = 'owner-a';
    var calls = [];
    var result = await operationalMonitorService.runOnce({
      leaseOwner: owner,
      now: new Date('2026-07-10T12:00:00.000Z'),
      healthService: {
        collectSnapshotInput: async function() {
          return { services: [{ name: 'server', status: 'ok' }], channels: [], alerts: [] };
        }
      },
      snapshotModel: {
        findOneAndUpdate: async function(filter, update) {
          calls.push({ filter: filter, update: update });
          if (calls.length === 1) return { monitorLease: update.$set.monitorLease };
          return update.$set;
        }
      }
    });

    expect(result.version).to.equal(2);
    expect(calls).to.have.lengthOf(2);
    expect(calls[0].filter.$or).to.deep.include({ 'monitorLease.expiresAt': { $exists: false } });
    expect(calls[0].update.$set.monitorLease.owner).to.equal(owner);
    expect(calls[1].filter).to.deep.equal({
      _id: 'singleton',
      'monitorLease.owner': owner,
      'monitorLease.expiresAt': { $gt: new Date('2026-07-10T12:00:00.000Z') }
    });
    expect(calls[1].update.$unset).to.deep.equal({ monitorLease: '' });
  });

  it('skips the periodic probe when another process owns the lease', async function() {
    var probes = 0;
    var result = await operationalMonitorService.runOnce({
      healthService: {
        collectSnapshotInput: async function() {
          probes += 1;
          return { services: [], channels: [], alerts: [] };
        }
      },
      snapshotModel: {
        findOneAndUpdate: async function() {
          return null;
        }
      }
    });

    expect(result.skipped).to.equal(true);
    expect(result.reason).to.equal('lease_occupied');
    expect(probes).to.equal(0);
  });

  it('acquires an expired lease', async function() {
    var now = new Date('2026-07-10T12:00:00.000Z');
    var calls = [];
    await operationalMonitorService.runOnce({
      leaseOwner: 'owner-b',
      now: now,
      healthService: {
        collectSnapshotInput: async function() {
          return { services: [], channels: [], alerts: [] };
        }
      },
      snapshotModel: {
        findOneAndUpdate: async function(filter, update) {
          calls.push({ filter: filter, update: update });
          if (calls.length === 1) return { monitorLease: update.$set.monitorLease };
          return update.$set;
        }
      }
    });

    expect(calls[0].filter.$or[0]).to.deep.equal({ 'monitorLease.expiresAt': { $lte: now } });
  });

  it('refuses to persist after the acquired lease expires', async function() {
    var times = [
      new Date('2026-07-10T12:00:00.000Z'),
      new Date('2026-07-10T12:02:00.000Z')
    ];
    var calls = [];
    var acquiredLease;
    var result = await operationalMonitorService.runOnce({
      leaseOwner: 'owner-expired',
      leaseDurationMs: 60 * 1000,
      now: function() { return times.shift(); },
      healthService: {
        collectSnapshotInput: async function() {
          return { services: [{ name: 'server', status: 'ok' }], channels: [], alerts: [] };
        }
      },
      snapshotModel: {
        findOneAndUpdate: async function(filter, update) {
          calls.push({ filter: filter, update: update });
          if (calls.length === 1) {
            acquiredLease = update.$set.monitorLease;
            return { monitorLease: acquiredLease };
          }
          if (update.$set) {
            return acquiredLease.expiresAt > filter['monitorLease.expiresAt'].$gt ? update.$set : null;
          }
          return null;
        }
      },
      logger: { recordSafe: function() {} }
    });

    expect(result.error).to.equal('Operational monitor lease lost');
    expect(result.version).to.equal(undefined);
    expect(operationalMonitorService.status().lastStatus).to.equal('failed');
    expect(calls[1].filter).to.deep.equal({
      _id: 'singleton',
      'monitorLease.owner': 'owner-expired',
      'monitorLease.expiresAt': { $gt: new Date('2026-07-10T12:02:00.000Z') }
    });
  });

  it('refuses to persist after lease ownership changes', async function() {
    var calls = [];
    var activeOwner = 'owner-original';
    var result = await operationalMonitorService.runOnce({
      leaseOwner: 'owner-original',
      now: new Date('2026-07-10T12:00:00.000Z'),
      healthService: {
        collectSnapshotInput: async function() {
          return { services: [{ name: 'server', status: 'ok' }], channels: [], alerts: [] };
        }
      },
      snapshotModel: {
        findOneAndUpdate: async function(filter, update) {
          calls.push({ filter: filter, update: update });
          if (calls.length === 1) {
            activeOwner = 'owner-replacement';
            return { monitorLease: update.$set.monitorLease };
          }
          if (update.$set) {
            return filter['monitorLease.owner'] === activeOwner ? update.$set : null;
          }
          return null;
        }
      },
      logger: { recordSafe: function() {} }
    });

    expect(result.error).to.equal('Operational monitor lease lost');
    expect(calls[1].filter['monitorLease.owner']).to.equal('owner-original');
    expect(calls[1].filter['monitorLease.expiresAt']).to.deep.equal({ $gt: new Date('2026-07-10T12:00:00.000Z') });
  });

  it('releases a failed lease only when it still owns it', async function() {
    var owner = 'owner-c';
    var calls = [];
    var result = await operationalMonitorService.runOnce({
      leaseOwner: owner,
      healthService: {
        collectSnapshotInput: async function() {
          throw new Error('probe failed');
        }
      },
      snapshotModel: {
        findOneAndUpdate: async function(filter, update) {
          calls.push({ filter: filter, update: update });
          if (calls.length === 1) return { monitorLease: update.$set.monitorLease };
          return null;
        }
      },
      logger: { recordSafe: function() {} }
    });

    expect(result.error).to.equal('probe failed');
    expect(calls[1].filter).to.deep.equal({ _id: 'singleton', 'monitorLease.owner': owner });
    expect(calls[1].update.$unset).to.deep.equal({ monitorLease: '' });
  });

  it('tests only the requested integration', async function() {
    var calls = [];
    var result = await operationalMonitorService.testIntegration('integration-1', {
      healthService: {
        testIntegration: async function(integrationId) {
          calls.push(integrationId);
          return { integrationId: integrationId, providerHealth: 'ok' };
        },
        collectSnapshotInput: async function() {
          throw new Error('full monitoring cycle should not run');
        }
      }
    });

    expect(result.providerHealth).to.equal('ok');
    expect(calls).to.deep.equal(['integration-1']);
  });
});
