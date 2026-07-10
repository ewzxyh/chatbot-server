var crypto = require('crypto');
var winston = require('../config/winston');
var backgroundWorkers = require('../utils/backgroundWorkers');
var operationalHealthService = require('./operationalHealthService');
var operationalLogger = require('./operationalLogger');
var Integration = require('../models/integrations');
var OperationalHealthSnapshot = require('../models/operationalHealthSnapshot');

var DEFAULT_INTERVAL_SECONDS = 300;
var DEFAULT_START_DELAY_SECONDS = 60;
var DEFAULT_LEASE_SECONDS = 300;
var DEFAULT_LEASE_OWNER = process.pid + '-' + crypto.randomBytes(8).toString('hex');

var state = {
  started: false,
  running: false,
  timer: null,
  startTimer: null,
  intervalMs: null,
  startDelayMs: null,
  lastRunAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastStatus: null,
  lastError: null,
  runCount: 0,
  skippedCount: 0
};

function boolEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  return process.env[name] === true || process.env[name] === 'true';
}

function parsePositiveInt(value, fallback) {
  var parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed < 1 ? fallback : parsed;
}

function getIntervalMs(options) {
  if (options && options.intervalMs) return options.intervalMs;
  return parsePositiveInt(process.env.OPERATIONAL_MONITOR_INTERVAL_SECONDS || DEFAULT_INTERVAL_SECONDS, DEFAULT_INTERVAL_SECONDS) * 1000;
}

function getStartDelayMs(options) {
  if (options && options.startDelayMs !== undefined) return options.startDelayMs;
  return parsePositiveInt(process.env.OPERATIONAL_MONITOR_START_DELAY_SECONDS || DEFAULT_START_DELAY_SECONDS, DEFAULT_START_DELAY_SECONDS) * 1000;
}

function disabledReason(options) {
  options = options || {};
  if (options.force) return null;
  if (!boolEnv('OPERATIONAL_MONITOR_ENABLED', true)) return 'env_disabled';
  if (backgroundWorkers.disabled()) return 'background_workers_disabled';
  return null;
}

function safeUnref(timer) {
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

function plainSnapshot(snapshot) {
  if (snapshot && typeof snapshot.toObject === 'function') snapshot = snapshot.toObject();
  if (!snapshot) return snapshot;
  var output = Object.assign({}, snapshot);
  delete output._id;
  delete output.createdAt;
  delete output.updatedAt;
  return output;
}

function runDate(value) {
  if (typeof value === 'function') value = value();
  var date = value ? new Date(value) : new Date();
  return isNaN(date.getTime()) ? new Date() : date;
}

function leaseDurationMs(options) {
  if (options && options.leaseDurationMs > 0) return options.leaseDurationMs;
  return parsePositiveInt(process.env.OPERATIONAL_MONITOR_LEASE_SECONDS || DEFAULT_LEASE_SECONDS, DEFAULT_LEASE_SECONDS) * 1000;
}

function leaseFilter(owner, now) {
  return {
    _id: 'singleton',
    $or: [
      { 'monitorLease.expiresAt': { $lte: now } },
      { 'monitorLease.expiresAt': { $exists: false } },
      { 'monitorLease.owner': owner }
    ]
  };
}

function hasDuplicateKeyError(error) {
  return error && (error.code === 11000 || /duplicate key/i.test(error.message || ''));
}

async function acquireLease(snapshotModel, owner, now, durationMs) {
  var expiresAt = new Date(now.getTime() + durationMs);
  var result;
  try {
    result = await snapshotModel.findOneAndUpdate(
      leaseFilter(owner, now),
      { $set: { monitorLease: { owner: owner, expiresAt: expiresAt } } },
      { upsert: true, new: true, setDefaultsOnInsert: false }
    );
  } catch (err) {
    if (hasDuplicateKeyError(err)) return null;
    throw err;
  }

  if (!result) return null;
  var lease = result.monitorLease;
  if (!lease && typeof result.toObject === 'function') lease = result.toObject().monitorLease;
  return lease && lease.owner === owner ? { owner: owner, expiresAt: expiresAt } : null;
}

async function releaseLease(snapshotModel, owner) {
  return snapshotModel.findOneAndUpdate(
    { _id: 'singleton', 'monitorLease.owner': owner },
    { $unset: { monitorLease: '' } },
    { new: true }
  );
}

async function persistSnapshot(snapshotModel, owner, snapshot, now) {
  var stored = await snapshotModel.findOneAndUpdate(
    {
      _id: 'singleton',
      'monitorLease.owner': owner,
      'monitorLease.expiresAt': { $gt: now }
    },
    { $set: snapshot, $unset: { monitorLease: '' } },
    { new: true }
  );
  if (!stored) {
    var lost = new Error('Operational monitor lease lost');
    lost.code = 'operational_monitor_lease_lost';
    throw lost;
  }
  return plainSnapshot(stored) || snapshot;
}

async function collectInput(healthService, app) {
  if (typeof healthService.collectSnapshotInput === 'function') {
    return healthService.collectSnapshotInput(app);
  }
  if (typeof healthService.getProbeInput === 'function') {
    return healthService.getProbeInput(app);
  }
  if (typeof healthService.getSummary === 'function') {
    return healthService.getSummary(app);
  }
  throw new Error('Operational health probe collector is unavailable');
}

async function runOnce(options) {
  options = options || {};
  if (state.running) {
    state.skippedCount += 1;
    return {
      ok: false,
      skipped: true,
      reason: 'already_running'
    };
  }

  var healthService = options.healthService || operationalHealthService;
  var logger = options.logger || operationalLogger;
  var snapshotModel = options.snapshotModel || OperationalHealthSnapshot;
  var now = runDate(options.now);
  var owner = options.leaseOwner || DEFAULT_LEASE_OWNER;
  var leaseAcquired = false;
  var startedAt = Date.now();

  state.running = true;
  state.lastRunAt = new Date().toISOString();
  state.lastError = null;

  try {
    var lease = await acquireLease(snapshotModel, owner, now, leaseDurationMs(options));
    if (!lease) {
      state.lastStatus = 'lease_occupied';
      state.skippedCount += 1;
      return {
        ok: false,
        skipped: true,
        reason: 'lease_occupied'
      };
    }
    leaseAcquired = true;
    var input = await collectInput(healthService, options.app);
    var buildSnapshot = healthService.buildSnapshot || operationalHealthService.buildSnapshot;
    var snapshot = buildSnapshot(input, now);
    snapshot = await persistSnapshot(snapshotModel, owner, snapshot, runDate(options.now));
    leaseAcquired = false;
    state.lastSuccessAt = new Date().toISOString();
    state.lastStatus = snapshot && snapshot.overallStatus ? snapshot.overallStatus : 'unknown';
    state.runCount += 1;
    winston.info('Operational monitor completed with status: ' + state.lastStatus);
    return snapshot;
  } catch (err) {
    state.lastFailureAt = new Date().toISOString();
    state.lastStatus = 'failed';
    state.lastError = err.message;
    state.runCount += 1;
    winston.warn('Operational monitor failed: ' + err.message);
    logger.recordSafe({
      level: 'error',
      area: 'monitor',
      channel: 'system',
      event: 'operational.monitor.failed',
      status: 'failed',
      error: err
    });
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: err.message
    };
  } finally {
    if (leaseAcquired) {
      try {
        await releaseLease(snapshotModel, owner);
      } catch (releaseErr) {
        logger.recordSafe({
          level: 'warn',
          area: 'monitor',
          channel: 'system',
          event: 'operational.monitor.lease_release_failed',
          status: 'failed',
          error: releaseErr
        });
      }
    }
    state.running = false;
  }
}

async function integrationChannel(integrationId) {
  if (!/^[0-9a-f]{24}$/i.test(String(integrationId))) return 'waba';
  var query = Integration.findById(integrationId).select('name');
  var integration = query && typeof query.lean === 'function' ? await query.lean() : await query;
  return integration && integration.name === 'casezap' ? 'casezap' : 'waba';
}

async function testIntegration(integrationId, options) {
  options = options || {};
  var healthService = options.healthService || operationalHealthService;
  if (typeof healthService.testIntegration === 'function') {
    return healthService.testIntegration(integrationId);
  }
  if (typeof healthService.testChannelConnection !== 'function') {
    throw new Error('Operational integration tester is unavailable');
  }
  var channel = options.channel || await integrationChannel(integrationId);
  return healthService.testChannelConnection(channel, integrationId);
}

function scheduleRun(options) {
  runOnce(options).catch(function(err) {
    winston.warn('Operational monitor unhandled error: ' + err.message);
  });
}

function start(options) {
  options = options || {};
  if (state.started) {
    return Object.assign({ started: true, alreadyStarted: true }, status());
  }

  var reason = disabledReason(options);
  if (reason) {
    winston.info('Operational monitor disabled: ' + reason);
    return { started: false, reason: reason };
  }

  var setIntervalFn = options.setIntervalFn || setInterval;
  var setTimeoutFn = options.setTimeoutFn || setTimeout;
  var intervalMs = getIntervalMs(options);
  var startDelayMs = getStartDelayMs(options);

  state.started = true;
  state.intervalMs = intervalMs;
  state.startDelayMs = startDelayMs;
  state.timer = setIntervalFn(function() {
    scheduleRun(options);
  }, intervalMs);
  safeUnref(state.timer);

  state.startTimer = setTimeoutFn(function() {
    state.startTimer = null;
    scheduleRun(options);
  }, startDelayMs);
  safeUnref(state.startTimer);

  winston.info('Operational monitor scheduled every ' + intervalMs + 'ms after ' + startDelayMs + 'ms');
  return Object.assign({ started: true }, status());
}

function stop(options) {
  options = options || {};
  var clearIntervalFn = options.clearIntervalFn || clearInterval;
  var clearTimeoutFn = options.clearTimeoutFn || clearTimeout;

  if (state.timer) {
    clearIntervalFn(state.timer);
  }
  if (state.startTimer) {
    clearTimeoutFn(state.startTimer);
  }

  state.started = false;
  state.running = false;
  state.timer = null;
  state.startTimer = null;
  state.intervalMs = null;
  state.startDelayMs = null;
}

function status() {
  return {
    started: state.started,
    running: state.running,
    intervalMs: state.intervalMs,
    startDelayMs: state.startDelayMs,
    lastRunAt: state.lastRunAt,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    lastStatus: state.lastStatus,
    lastError: state.lastError,
    runCount: state.runCount,
    skippedCount: state.skippedCount
  };
}

module.exports = {
  start: start,
  stop: stop,
  runOnce: runOnce,
  testIntegration: testIntegration,
  status: status
};
