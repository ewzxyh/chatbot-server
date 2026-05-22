var winston = require('../config/winston');
var backgroundWorkers = require('../utils/backgroundWorkers');
var billingLifecycleService = require('./billingLifecycleService');
var operationalLogger = require('./operationalLogger');

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

function disabledReason(options) {
  options = options || {};
  if (options.force) return null;
  if (!boolEnv('BILLING_LIFECYCLE_JOB_ENABLED', false)) return 'env_disabled';
  if (backgroundWorkers.disabled()) return 'background_workers_disabled';
  return null;
}

function safeUnref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
}

function getIntervalMs(options) {
  if (options && options.intervalMs) return options.intervalMs;
  return parsePositiveInt(process.env.BILLING_LIFECYCLE_JOB_INTERVAL_HOURS || '24', 24) * 60 * 60 * 1000;
}

function getStartDelayMs(options) {
  if (options && options.startDelayMs !== undefined) return options.startDelayMs;
  return parsePositiveInt(process.env.BILLING_LIFECYCLE_JOB_START_DELAY_SECONDS || '300', 300) * 1000;
}

async function runOnce(options) {
  options = options || {};
  if (state.running) {
    state.skippedCount += 1;
    return { ok: false, skipped: true, reason: 'already_running' };
  }

  var startedAt = Date.now();
  var service = options.service || billingLifecycleService.createBillingLifecycleService();
  var dryRun = options.dryRun !== undefined ? options.dryRun : boolEnv('BILLING_LIFECYCLE_JOB_DRY_RUN', true);

  state.running = true;
  state.lastRunAt = new Date().toISOString();
  state.lastError = null;

  try {
    var result = await service.runLifecycleSweep(Object.assign({}, options, {
      dryRun: dryRun,
      userId: options.userId || 'billing-lifecycle-job'
    }));
    state.lastSuccessAt = new Date().toISOString();
    state.lastStatus = dryRun ? 'dry_run' : (result.errors ? 'partial' : 'completed');
    state.runCount += 1;
    winston.info('Billing lifecycle job completed with status: ' + state.lastStatus);
    return {
      ok: result.errors === 0,
      durationMs: Date.now() - startedAt,
      result: result
    };
  } catch (err) {
    state.lastFailureAt = new Date().toISOString();
    state.lastStatus = 'failed';
    state.lastError = err.message;
    state.runCount += 1;
    winston.warn('Billing lifecycle job failed: ' + err.message);
    operationalLogger.recordSafe({
      level: 'error',
      area: 'billing',
      channel: 'system',
      event: 'billing.lifecycle_job.failed',
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
    winston.warn('Billing lifecycle job unhandled error: ' + err.message);
  });
}

function start(options) {
  options = options || {};
  if (state.started) {
    return Object.assign({ started: true, alreadyStarted: true }, status());
  }

  var reason = disabledReason(options);
  if (reason) {
    winston.info('Billing lifecycle job disabled: ' + reason);
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

  winston.info('Billing lifecycle job scheduled every ' + intervalMs + 'ms after ' + startDelayMs + 'ms');
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
  var defaultDryRun = boolEnv('BILLING_LIFECYCLE_JOB_DRY_RUN', true);
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
    skippedCount: state.skippedCount,
    defaultDryRun: defaultDryRun,
    config: billingLifecycleService.getLifecycleConfig({ dryRun: defaultDryRun })
  };
}

module.exports = {
  start: start,
  stop: stop,
  runOnce: runOnce,
  status: status
};
