var winston = require('../config/winston');
var AuditEvent = require('../models/auditEvent');

var REDACTED = '[REDACTED]';
var MAX_STRING_LENGTH = parseInt(process.env.AUDIT_MAX_STRING_LENGTH || '1000', 10);
var MAX_ARRAY_ITEMS = parseInt(process.env.AUDIT_MAX_ARRAY_ITEMS || '20', 10);
var MAX_DEPTH = parseInt(process.env.AUDIT_MAX_DEPTH || '5', 10);

var SENSITIVE_KEYS = [
  'authorization', 'cookie', 'password', 'pass', 'pwd',
  'token', 'access_token', 'refresh_token', 'id_token', 'jwt',
  'secret', 'client_secret', 'apikey', 'api_key', 'apiKey',
  'privatekey', 'private_key', 'bearer', 'webhooksecret',
  'webhook_secret', 'signature', 'x-api-key'
];

function isEnabled() {
  return process.env.AUDIT_ENABLED !== 'false';
}

function shouldRedactKey(key) {
  if (!key) return false;
  var normalized = String(key).toLowerCase().replace(/[-_\s]/g, '');
  for (var i = 0; i < SENSITIVE_KEYS.length; i++) {
    var sensitive = SENSITIVE_KEYS[i].toLowerCase().replace(/[-_\s]/g, '');
    if (normalized.indexOf(sensitive) !== -1) return true;
  }
  return false;
}

function safeObjectKey(key) {
  return String(key).replace(/\./g, '_').replace(/\$/g, '_');
}

function sanitize(value, depth) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[MAX_DEPTH]';

  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      return value.substring(0, MAX_STRING_LENGTH) + '...[TRUNCATED]';
    }
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Buffer.isBuffer(value)) {
    return '[BUFFER ' + value.length + ' bytes]';
  }

  if (Array.isArray(value)) {
    var arr = [];
    var limit = Math.min(value.length, MAX_ARRAY_ITEMS);
    for (var i = 0; i < limit; i++) {
      arr.push(sanitize(value[i], depth + 1));
    }
    if (value.length > limit) {
      arr.push('[TRUNCATED ' + (value.length - limit) + ' items]');
    }
    return arr;
  }

  if (typeof value === 'object') {
    var result = {};
    var keys = Object.keys(value);
    for (var j = 0; j < keys.length; j++) {
      var key = keys[j];
      var safeKey = safeObjectKey(key);
      if (shouldRedactKey(key)) {
        result[safeKey] = REDACTED;
      } else if (key === 'file' || key === 'files' || key === 'buffer' || key === 'rawBody') {
        result[safeKey] = '[BINARY_OR_RAW_PAYLOAD]';
      } else {
        result[safeKey] = sanitize(value[key], depth + 1);
      }
    }
    return result;
  }

  return String(value);
}

function cleanQuery(query) {
  return sanitize(query || {}, 0);
}

function cleanBody(body) {
  return sanitize(body || {}, 0);
}

function getActor(req) {
  var user = req && req.user ? req.user : {};
  return {
    id: user._id ? String(user._id) : (user.id ? String(user.id) : undefined),
    email: user.email || (user._json && user._json.email) || undefined,
    role: user.role || user.roles || undefined,
    type: user.type || undefined
  };
}

function firstValue() {
  for (var i = 0; i < arguments.length; i++) {
    if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') {
      return arguments[i];
    }
  }
  return undefined;
}

function inferAction(method, path) {
  method = (method || '').toUpperCase();
  path = path || '';

  if (path.indexOf('/sadmin') === 0 && method === 'GET') return 'admin.read';
  if (path.indexOf('/auth') === 0 && method === 'POST') return 'auth.write';
  if (method === 'POST') return 'api.create';
  if (method === 'PUT' || method === 'PATCH') return 'api.update';
  if (method === 'DELETE') return 'api.delete';
  return 'api.read';
}

function inferResource(path) {
  if (!path) return undefined;
  var clean = path.split('?')[0];
  var parts = clean.split('/').filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts[0] === 'sadmin' && parts.length > 1) return 'sadmin/' + parts[1];
  if (parts.length > 1 && /^[a-f0-9]{24}$/i.test(parts[0])) return parts[1];
  return parts[0];
}

function inferEntity(req) {
  var params = req.params || {};
  var body = req.body || {};
  var query = req.query || {};
  var path = req.originalUrl || req.url || '';
  var resource = inferResource(path);
  var parts = path.split('?')[0].split('/').filter(Boolean);

  var idProject = firstValue(
    params.projectid,
    params.id_project,
    params.project_id,
    params.projectId,
    body.id_project,
    body.project_id,
    body.projectId,
    query.project_id,
    query.projectId,
    (parts.length > 0 && /^[a-f0-9]{24}$/i.test(parts[0])) ? parts[0] : undefined
  );

  var entityType = resource;
  if (resource === 'sadmin/projects') entityType = 'project';
  if (resource === 'requests') entityType = 'request';
  if (resource === 'leads') entityType = 'lead';
  if (resource === 'messages') entityType = 'message';
  if (resource === 'integration' || resource === 'integrations') entityType = 'integration';

  var entityId = firstValue(
    params.id,
    params.requestid,
    params.request_id,
    params.leadid,
    params.integration_id,
    params.integrationid,
    body._id,
    body.id,
    body.request_id,
    body.lead_id,
    body.integration_id
  );

  return {
    id_project: idProject ? String(idProject) : undefined,
    entityType: entityType,
    entityId: entityId ? String(entityId) : undefined,
    resource: resource
  };
}

function shouldAuditRequest(req) {
  if (!isEnabled()) return false;
  if (!req) return false;

  var method = (req.method || '').toUpperCase();
  var path = req.originalUrl || req.url || '';

  if (path.indexOf('/sadmin/audit-events') === 0) return false;
  if (path.indexOf('/images') === 0 || path.indexOf('/files') === 0 || path.indexOf('/public') === 0) return false;
  if (path.indexOf('/webhook') === 0 && process.env.AUDIT_WEBHOOK_PAYLOADS !== 'true') return false;

  if (['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(method) !== -1) return true;
  if (method === 'GET' && path.indexOf('/sadmin') === 0) return true;
  return false;
}

function buildSummary(event) {
  var pieces = [];
  if (event.method) pieces.push(event.method);
  if (event.path) pieces.push(event.path.split('?')[0]);
  if (event.statusCode) pieces.push(String(event.statusCode));
  return pieces.join(' ');
}

async function record(event) {
  if (!isEnabled()) return null;
  try {
    event = event || {};
    event.timestamp = event.timestamp || new Date();
    event.action = event.action || 'audit.event';
    event.summary = event.summary || buildSummary(event);
    event.before = sanitize(event.before, 0);
    event.after = sanitize(event.after, 0);
    event.changes = sanitize(event.changes, 0);
    event.metadata = sanitize(event.metadata, 0);
    return await AuditEvent.create(event);
  } catch (err) {
    winston.warn('auditService record error: ' + err.message);
    return null;
  }
}

function middleware() {
  return function auditMiddleware(req, res, next) {
    if (!shouldAuditRequest(req)) return next();

    var startedAt = Date.now();
    res.on('finish', function() {
      var entity = inferEntity(req);
      record({
        action: inferAction(req.method, req.originalUrl || req.url),
        method: req.method,
        path: req.originalUrl || req.url,
        route: req.route && req.route.path ? String(req.route.path) : undefined,
        statusCode: res.statusCode,
        success: res.statusCode < 400,
        durationMs: Date.now() - startedAt,
        id_project: entity.id_project,
        entityType: entity.entityType,
        entityId: entity.entityId,
        resource: entity.resource,
        actor: getActor(req),
        ip: req.ip,
        userAgent: req.get ? req.get('user-agent') : undefined,
        metadata: {
          query: cleanQuery(req.query),
          body: cleanBody(req.body)
        }
      });
    });

    next();
  };
}

module.exports = {
  isEnabled: isEnabled,
  sanitize: function(value) { return sanitize(value, 0); },
  record: record,
  middleware: middleware,
  getActor: getActor
};
