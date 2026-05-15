var winston = require('../config/winston');
var backgroundWorkers = require('../utils/backgroundWorkers');
var operationalHealthService = require('./operationalHealthService');
var operationalLogger = require('./operationalLogger');

var DEFAULT_INTERVAL_SECONDS = 300;
var DEFAULT_START_DELAY_SECONDS = 60;

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
  var startedAt = Date.now();

  state.running = true;
  state.lastRunAt = new Date().toISOString();
  state.lastError = null;

  try {
    var summary = await healthService.getSummary(options.app);
    state.lastSuccessAt = new Date().toISOString();
    state.lastStatus = summary && summary.overallStatus ? summary.overallStatus : 'unknown';
    state.runCount += 1;
    winston.info('Operational monitor completed with status: ' + state.lastStatus);
    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      summary: summary
    };
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
    state.running = false;
  }
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
  status: status
};
