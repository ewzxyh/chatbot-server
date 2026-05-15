process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

var chai = require('chai');
var expect = chai.expect;
var operationalMonitorService = require('../services/operationalMonitorService');

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
    var app = { get: function() {} };
    var result = await operationalMonitorService.runOnce({
      app: app,
      healthService: {
        getSummary: async function(appArg) {
          calls += 1;
          expect(appArg).to.equal(app);
          return {
            generatedAt: '2026-05-15T00:00:00.000Z',
            overallStatus: 'ok',
            alerts: []
          };
        }
      }
    });

    expect(result.ok).to.equal(true);
    expect(result.summary.overallStatus).to.equal('ok');
    expect(calls).to.equal(1);
    expect(operationalMonitorService.status().lastStatus).to.equal('ok');
  });

  it('skips a cycle when a previous cycle is still running', async function() {
    var release;
    var running = operationalMonitorService.runOnce({
      app: {},
      healthService: {
        getSummary: function() {
          return new Promise(function(resolve) {
            release = function() {
              resolve({ overallStatus: 'ok', alerts: [] });
            };
          });
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
        getSummary: async function() {
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
});
