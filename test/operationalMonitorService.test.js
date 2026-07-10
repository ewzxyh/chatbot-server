process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

var chai = require('chai');
var expect = chai.expect;
var operationalHealthService = require('../services/operationalHealthService');
var operationalMonitorService = require('../services/operationalMonitorService');
var OperationalHealthSnapshot = require('../models/operationalHealthSnapshot');

function inputWithSixCauses() {
  return {
    services: [{ name: 'server', status: 'ok' }],
    channels: [1, 2, 3, 4, 5, 6].map(function(index) {
      return {
        channel: 'casezap',
        status: 'degraded',
        providerReason: 'channel_cause_' + index
      };
    }),
    alerts: [1, 2, 3, 4, 5, 6].map(function(index) {
      return {
        severity: 'warning',
        status: 'open',
        details: { cause: 'alert_cause_' + index }
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
    var result = await operationalMonitorService.runOnce({
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
          expect(filter).to.deep.equal({ _id: 'singleton' });
          expect(update.$set.version).to.equal(2);
          expect(options.upsert).to.equal(true);
          expect(options.new).to.equal(true);
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

  it('keeps the snapshot bounded', function() {
    var snapshot = operationalHealthService.buildSnapshot(inputWithSixCauses(), new Date('2026-07-10T12:00:00.000Z'));

    expect(snapshot.version).to.equal(2);
    expect(snapshot.channels.topCauses).to.have.lengthOf(5);
    expect(snapshot.alerts.topCauses).to.have.lengthOf(5);
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
            channels: { count: 0, byStatus: {}, byProduct: {}, topCauses: [] },
            alerts: { count: 0, byStatus: {}, topCauses: [] }
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
