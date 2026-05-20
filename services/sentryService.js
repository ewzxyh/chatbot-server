var crypto = require('crypto');

var Sentry = null;
try {
  Sentry = require('@sentry/node');
} catch (err) {
  Sentry = null;
}

var initialized = false;

var SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'cookies',
  'set-cookie',
  'password',
  'pass',
  'token',
  'jwt',
  'secret',
  'webhooksecret',
  'apikey',
  'api_key',
  'accesskey',
  'access_key',
  'accesstoken',
  'access_token',
  'refresh_token',
  'phone',
  'email',
  'message',
  'text',
  'body',
  'content',
  'src',
  'url',
  'signedurl'
];

function isEnabled() {
  return Boolean(process.env.SENTRY_DSN) && process.env.SENTRY_ENABLED !== 'false';
}

function parseSampleRate(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  var parsed = Number(value);
  if (Number.isNaN(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

function release() {
  return process.env.SENTRY_RELEASE || process.env.RELEASE || process.env.npm_package_version || undefined;
}

function environment() {
  return process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development';
}

function normalizeKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function isSensitiveKey(key) {
  var normalized = normalizeKey(key);
  return SENSITIVE_KEYS.some(function (sensitive) {
    return normalized.indexOf(sensitive) !== -1;
  });
}

function redactString(value) {
  if (!value) return value;
  return String(value)
    .replace(/https?:\/\/[^?\s]+(\?[^)\]\s]+)?/gi, function (match) {
      return match.split('?')[0];
    })
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/JWT\s+[A-Za-z0-9._~+/=-]+/gi, 'JWT [redacted]')
    .replace(/(token|secret|password|api[_-]?key|access[_-]?key)=([^&\s]+)/gi, '$1=[redacted]');
}

function scrubValue(value, seen) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;

  seen = seen || [];
  if (seen.indexOf(value) !== -1) return '[circular]';
  seen.push(value);

  if (Array.isArray(value)) {
    return value.slice(0, 20).map(function (item) {
      return scrubValue(item, seen);
    });
  }

  var output = {};
  Object.keys(value).forEach(function (key) {
    if (isSensitiveKey(key)) {
      output[key] = '[redacted]';
      return;
    }
    output[key] = scrubValue(value[key], seen);
  });
  return output;
}

function sanitizeRequest(request) {
  if (!request) return request;
  var sanitized = scrubValue(request);
  if (request.url) sanitized.url = redactString(request.url);
  if (sanitized.query_string) sanitized.query_string = '[redacted]';
  sanitized.data = undefined;
  sanitized.cookies = undefined;
  if (sanitized.headers) {
    Object.keys(sanitized.headers).forEach(function (key) {
      if (isSensitiveKey(key)) sanitized.headers[key] = '[redacted]';
    });
  }
  return sanitized;
}

function beforeSend(event) {
  var topLevelMessage = event && typeof event.message === 'string' ? event.message : undefined;
  var sanitized = scrubValue(event || {});
  if (topLevelMessage) sanitized.message = redactString(topLevelMessage);
  sanitized.request = sanitizeRequest(event && event.request ? event.request : sanitized.request);
  sanitized.user = undefined;

  if (sanitized.extra) sanitized.extra = scrubValue(sanitized.extra);
  if (sanitized.contexts) sanitized.contexts = scrubValue(sanitized.contexts);
  if (sanitized.breadcrumbs) {
    sanitized.breadcrumbs = sanitized.breadcrumbs.slice(-20).map(function (breadcrumb) {
      return scrubValue(breadcrumb);
    });
  }

  return sanitized;
}

function tracesSampler(samplingContext) {
  var name = samplingContext && samplingContext.name ? samplingContext.name : '';
  if (name.indexOf('/sadmin/health') !== -1 || name === 'GET /') return 0;
  return parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0);
}

function init() {
  if (initialized || !isEnabled()) return false;
  if (!Sentry) {
    console.warn('Sentry SDK is not installed; skipping Sentry initialization');
    return false;
  }

  try {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: environment(),
      release: release(),
      sendDefaultPii: false,
      tracesSampler: tracesSampler,
      beforeSend: beforeSend,
      serverName: process.env.SENTRY_SERVER_NAME || undefined,
      initialScope: {
        tags: {
          service: 'tiledesk-server',
          app: 'chatcase'
        }
      }
    });
    initialized = true;
    return true;
  } catch (err) {
    console.warn('Sentry initialization failed: ' + err.message);
    return false;
  }
}

function setupExpressErrorHandler(app) {
  if (!initialized || !Sentry || !app) return false;
  Sentry.setupExpressErrorHandler(app);
  return true;
}

function isInitialized() {
  return initialized;
}

function captureException(err, context) {
  if (!initialized || !Sentry || !err) return;
  Sentry.withScope(function (scope) {
    if (context && context.tags) {
      Object.keys(context.tags).forEach(function (key) {
        scope.setTag(key, context.tags[key]);
      });
    }
    if (context && context.fingerprint) {
      scope.setFingerprint(context.fingerprint);
    } else if (err.message) {
      scope.setFingerprint([crypto.createHash('sha1').update(err.message).digest('hex')]);
    }
    Sentry.captureException(err);
  });
}

function flush(timeoutMs) {
  if (!initialized || !Sentry) return Promise.resolve(false);
  return Sentry.flush(timeoutMs || 2000);
}

function metadata() {
  return {
    environment: environment(),
    release: release() || null,
    serverName: process.env.SENTRY_SERVER_NAME || null
  };
}

module.exports = {
  init: init,
  isEnabled: isEnabled,
  isInitialized: isInitialized,
  setupExpressErrorHandler: setupExpressErrorHandler,
  captureException: captureException,
  flush: flush,
  metadata: metadata,
  _private: {
    beforeSend: beforeSend,
    scrubValue: scrubValue,
    redactString: redactString,
    parseSampleRate: parseSampleRate
  }
};
