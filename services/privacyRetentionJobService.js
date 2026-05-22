var winston = require('../config/winston');
var backgroundWorkers = require('../utils/backgroundWorkers');
var operationalLogger = require('./operationalLogger');
var privacyRetentionService = require('./privacyRetentionService');
var privacyService = require('./privacyService');

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

function disabledReason(options) {
  options = options || {};
  if (options.force) return null;
  if (!boolEnv('PRIVACY_RETENTION_JOB_ENABLED', false)) return 'env_disabled';
  if (backgroundWorkers.disabled()) return 'background_workers_disabled';
  return null;
}

function safeUnref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
}

async function runOnce(options) {
  options = options || {};
  if (state.running) {
    state.skippedCount += 1;
    return { ok: false, skipped: true, reason: 'already_running' };
  }

  var startedAt = Date.now();
  var config = privacyService.getRetentionConfig();
  var dryRun = options.dryRun !== undefined ? options.dryRun : config.retentionJobDryRun;

  state.running = true;
  state.lastRunAt = new Date().toISOString();
  state.lastError = null;

  try {
    var result = await privacyRetentionService.runRetention({
      dryRun: dryRun,
      source: 'job'
    });
    state.lastSuccessAt = new Date().toISOString();
    state.lastStatus = dryRun ? 'dry_run' : 'completed';
    state.runCount += 1;
    winston.info('Privacy retention job completed with status: ' + state.lastStatus);
    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      result: result
    };
  } catch (err) {
    state.lastFailureAt = new Date().toISOString();
    state.lastStatus = 'failed';
    state.lastError = err.message;
    state.runCount += 1;
    winston.warn('Privacy retention job failed: ' + err.message);
    operationalLogger.recordSafe({
      level: 'error',
      area: 'privacy',
      channel: 'system',
      event: 'privacy.retention_job.failed',
      status: 'failed',
      error: err
    });
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: err.message
    };
  } finally {
    state.running = false;
  }
}

function scheduleRun(options) {
  runOnce(options).catch(function(err) {
    winston.warn('Privacy retention job unhandled error: ' + err.message);
  });
}

function start(options) {
  options = options || {};
  if (state.started) {
    return Object.assign({ started: true, alreadyStarted: true }, status());
  }

  var reason = disabledReason(options);
  if (reason) {
    winston.info('Privacy retention job disabled: ' + reason);
    return { started: false, reason: reason };
  }

  var config = privacyService.getRetentionConfig();
  var setIntervalFn = options.setIntervalFn || setInterval;
  var setTimeoutFn = options.setTimeoutFn || setTimeout;
  var intervalMs = options.intervalMs || config.retentionJobIntervalHours * 60 * 60 * 1000;
  var startDelayMs = options.startDelayMs !== undefined ? options.startDelayMs : config.retentionJobStartDelaySeconds * 1000;

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

  winston.info('Privacy retention job scheduled every ' + intervalMs + 'ms after ' + startDelayMs + 'ms');
  return Object.assign({ started: true }, status());
}

function stop(options) {
  options = options || {};
  var clearIntervalFn = options.clearIntervalFn || clearInterval;
  var clearTimeoutFn = options.clearTimeoutFn || clearTimeout;

  if (state.timer) clearIntervalFn(state.timer);
  if (state.startTimer) clearTimeoutFn(state.startTimer);

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
  status: status
};
