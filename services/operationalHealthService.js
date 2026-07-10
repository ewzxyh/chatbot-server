var mongoose = require('mongoose');
var amqp = require('amqplib/callback_api');
var crypto = require('crypto');
var http = require('http');
var https = require('https');
var pjson = require('../package.json');
var Integration = require('../models/integrations');
var OperationalEvent = require('../models/operationalEvent');
var OperationalHealthSnapshot = require('../models/operationalHealthSnapshot');
var operationalAlertService = require('./operationalAlertService');
var operationalLogger = require('./operationalLogger');
var channelDiagnosticsService = require('./channelDiagnosticsService');
var fileStorageFactory = require('./fileStorageServiceFactory');
var R2FileService = require('./r2FileService');

var WEBHOOK_FAILURE_WINDOW_MINUTES = parseInt(process.env.OPERATIONAL_WEBHOOK_FAILURE_WINDOW_MINUTES || '15', 10);
var WEBHOOK_FAILURE_THRESHOLD = parseInt(process.env.OPERATIONAL_WEBHOOK_FAILURE_THRESHOLD || '3', 10);
var QUEUE_READY_ALERT_THRESHOLD = parseInt(process.env.OPERATIONAL_QUEUE_READY_ALERT_THRESHOLD || '100', 10);
var QUEUE_UNACKED_ALERT_THRESHOLD = parseInt(process.env.OPERATIONAL_QUEUE_UNACKED_ALERT_THRESHOLD || '100', 10);
var PROVIDER_CHECK_CONCURRENCY = parseInt(process.env.OPERATIONAL_PROVIDER_CHECK_CONCURRENCY || '10', 10);
if (isNaN(PROVIDER_CHECK_CONCURRENCY) || PROVIDER_CHECK_CONCURRENCY < 1) PROVIDER_CHECK_CONCURRENCY = 10;

var SNAPSHOT_ID = 'singleton';
var DEFAULT_SNAPSHOT_TTL_SECONDS = 300;
var DEFAULT_SERVICE_NAMES = ['server', 'mongo', 'redis', 'rabbitmq', 'storage'];
var SNAPSHOT_STATUSES = ['ok', 'degraded', 'down', 'unknown'];

var storageHealthCache = {
  expiresAt: 0,
  value: null
};

function nowIso() {
  return new Date().toISOString();
}

function service(name, label, status, latencyMs, details) {
  return {
    name: name,
    label: label,
    status: status,
    latencyMs: latencyMs,
    details: details || {}
  };
}

function boolEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  return process.env[name] === true || process.env[name] === 'true';
}

function parsePositiveInt(value, fallback) {
  var parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed < 1 ? fallback : parsed;
}

function statusWeight(status) {
  if (status === 'down') return 3;
  if (status === 'degraded') return 2;
  if (status === 'unknown') return 1;
  return 0;
}

function highestStatus(current, candidate) {
  return statusWeight(candidate) > statusWeight(current) ? candidate : current;
}

function mergeOverall(items) {
  var max = 0;
  (items || []).forEach(function(item) {
    max = Math.max(max, statusWeight(item.status));
  });
  if (max >= 3) return 'down';
  if (max >= 2) return 'degraded';
  if (max >= 1) return 'unknown';
  return 'ok';
}

function toIso(value, fallback) {
  var date = value ? new Date(value) : null;
  if (!date || isNaN(date.getTime())) date = fallback instanceof Date ? fallback : new Date(fallback);
  return date.toISOString();
}

function normalizeStatus(status) {
  return SNAPSHOT_STATUSES.indexOf(status) !== -1 ? status : 'unknown';
}

function firstValue(values) {
  for (var i = 0; i < values.length; i++) {
    if (values[i] !== undefined && values[i] !== null && values[i] !== '') return values[i];
  }
  return null;
}

function normalizeCause(item) {
  item = item || {};
  var details = item.details || {};
  var cause = firstValue([
    item.cause,
    item.providerReason,
    item.reason,
    item.providerCode,
    details.cause,
    details.reason,
    item.providerError,
    item.lastError,
    details.error
  ]);
  return cause === null ? null : String(cause);
}

function normalizeSnapshotItem(item, now, fallbackName) {
  item = item || {};
  var details = item.details || {};
  return {
    name: String(item.name || item.queue || item.channel || item.integrationId || fallbackName || 'unknown'),
    status: normalizeStatus(item.status || item.providerHealth),
    cause: normalizeCause(item),
    checkedAt: toIso(item.checkedAt || item.providerCheckedAt || item.lastAt || details.checkedAt, now)
  };
}

function namesFrom(input, key, envName, fallback) {
  if (Array.isArray(input[key])) return input[key].map(String).filter(Boolean);
  if (process.env[envName] !== undefined) {
    return process.env[envName].split(',').map(function(item) {
      return item.trim();
    }).filter(Boolean);
  }
  return fallback || [];
}

function boundedItems(items, names, maxItems) {
  items = Array.isArray(items) ? items : [];
  if (names.length) {
    return items.filter(function(item) {
      var name = item && (item.name || item.queue || item.channel);
      return names.indexOf(String(name)) !== -1;
    }).slice(0, names.length);
  }
  return items.slice(0, maxItems);
}

function statusCounts() {
  return { ok: 0, degraded: 0, down: 0, unknown: 0 };
}

function addStatus(counts, status) {
  counts[normalizeStatus(status)] += 1;
}

function topCauses(items) {
  var counts = {};
  (items || []).forEach(function(item) {
    if (!item.cause) return;
    counts[item.cause] = (counts[item.cause] || 0) + 1;
  });
  return Object.keys(counts).map(function(cause) {
    return { cause: cause, count: counts[cause] };
  }).sort(function(left, right) {
    return right.count - left.count || left.cause.localeCompare(right.cause);
  }).slice(0, 5);
}

function productName(channel) {
  var value = channel && (channel.product || channel.channel);
  if (value === 'whatsapp') return 'waba';
  return value ? String(value) : 'unknown';
}

function alertStatus(alert) {
  if (SNAPSHOT_STATUSES.indexOf(alert.status) !== -1) return alert.status;
  if (alert.status === 'resolved') return 'ok';
  if (alert.severity === 'critical') return 'down';
  if (alert.severity === 'warning') return 'degraded';
  return 'unknown';
}

function queueItems(input) {
  if (Array.isArray(input.queues)) return input.queues;
  if (input.queues && input.queues.details && Array.isArray(input.queues.details.queues)) {
    return input.queues.details.queues;
  }
  var rabbit = (input.services || []).find(function(item) {
    return item && item.name === 'rabbitmq';
  });
  return rabbit && rabbit.details && Array.isArray(rabbit.details.queues) ? rabbit.details.queues : [];
}

function snapshotTtlMs() {
  return parsePositiveInt(process.env.OPERATIONAL_HEALTH_SNAPSHOT_TTL_SECONDS ||
    process.env.OPERATIONAL_MONITOR_INTERVAL_SECONDS || String(DEFAULT_SNAPSHOT_TTL_SECONDS), DEFAULT_SNAPSHOT_TTL_SECONDS) * 1000;
}

function buildSnapshot(input, now) {
  input = input || {};
  now = now ? new Date(now) : new Date();
  if (isNaN(now.getTime())) now = new Date();

  var serviceNames = namesFrom(input, 'serviceNames', 'OPERATIONAL_HEALTH_SERVICES', DEFAULT_SERVICE_NAMES);
  var queueNames = namesFrom(input, 'queueNames', 'OPERATIONAL_RABBITMQ_QUEUES', []);
  var services = boundedItems(input.services, serviceNames, DEFAULT_SERVICE_NAMES.length).map(function(item) {
    return normalizeSnapshotItem(item, now);
  });
  var queues = boundedItems(queueItems(input), queueNames, 50).map(function(item) {
    return normalizeSnapshotItem(item, now);
  });
  var channels = Array.isArray(input.channels) ? input.channels : [];
  var normalizedChannels = channels.map(function(item) {
    var normalized = normalizeSnapshotItem(item, now);
    normalized.product = productName(item);
    return normalized;
  });
  var alerts = Array.isArray(input.alerts) ? input.alerts : [];
  var normalizedAlerts = alerts.map(function(item) {
    var normalized = normalizeSnapshotItem(item, now, item.type || 'alert');
    normalized.status = alertStatus(item);
    return normalized;
  });

  var channelByStatus = statusCounts();
  var channelByProduct = {
    casezap: statusCounts(),
    waba: statusCounts()
  };
  normalizedChannels.forEach(function(item) {
    addStatus(channelByStatus, item.status);
    if (!channelByProduct[item.product]) channelByProduct[item.product] = statusCounts();
    addStatus(channelByProduct[item.product], item.status);
  });

  var alertByStatus = statusCounts();
  normalizedAlerts.forEach(function(item) {
    addStatus(alertByStatus, item.status);
  });

  var overallItems = services.concat(queues).concat(normalizedChannels).concat(normalizedAlerts);
  return {
    version: 2,
    overallStatus: mergeOverall(overallItems),
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + snapshotTtlMs()).toISOString(),
    services: services,
    queues: queues,
    channels: {
      count: normalizedChannels.length,
      byStatus: channelByStatus,
      byProduct: channelByProduct,
      topCauses: topCauses(normalizedChannels)
    },
    alerts: {
      count: normalizedAlerts.length,
      byStatus: alertByStatus,
      topCauses: topCauses(normalizedAlerts)
    }
  };
}

function deriveSnapshotState(snapshot, now) {
  if (!snapshot) return 'missing';
  var expiresAt = new Date(snapshot.expiresAt).getTime();
  var timestamp = now ? new Date(now).getTime() : Date.now();
  return expiresAt > timestamp ? 'fresh' : 'stale';
}

function emptyAggregate() {
  return {
    count: 0,
    byStatus: statusCounts(),
    topCauses: []
  };
}

function emptySnapshot() {
  return {
    version: 2,
    overallStatus: 'unknown',
    snapshotState: 'missing',
    generatedAt: null,
    expiresAt: null,
    services: [],
    queues: [],
    channels: Object.assign({ byProduct: { casezap: statusCounts(), waba: statusCounts() } }, emptyAggregate()),
    alerts: emptyAggregate()
  };
}

function isSnapshotValid(snapshot) {
  return snapshot && snapshot.version === 2 && Array.isArray(snapshot.services) &&
    Array.isArray(snapshot.queues) && snapshot.channels && snapshot.alerts &&
    !isNaN(new Date(snapshot.generatedAt).getTime()) && !isNaN(new Date(snapshot.expiresAt).getTime());
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

async function collectSnapshotInput(app) {
  var tdCache = app && app.get ? app.get('redis_client') : null;
  var results = await Promise.all([getServices(tdCache), getChannels()]);
  var services = results[0];
  var channels = results[1];
  var alerts = await getAlerts(services, channels);

  try {
    await operationalAlertService.syncAlerts(alerts);
  } catch (err) {
    operationalLogger.recordSafe({
      level: 'warn',
      area: 'monitor',
      channel: 'system',
      event: 'operational.alerts.sync_failed',
      status: 'failed',
      error: err
    });
  }

  return { services: services, channels: channels, alerts: alerts };
}

async function checkMongo() {
  var startedAt = Date.now();
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    return service('mongo', 'MongoDB', 'down', null, { readyState: mongoose.connection.readyState });
  }

  try {
    await mongoose.connection.db.admin().ping();
    return service('mongo', 'MongoDB', 'ok', Date.now() - startedAt, {
      host: mongoose.connection.host,
      name: mongoose.connection.name
    });
  } catch (err) {
    return service('mongo', 'MongoDB', 'down', Date.now() - startedAt, { error: err.message });
  }
}

function pingRedisClient(client) {
  return new Promise(function(resolve, reject) {
    client.ping(function(err, result) {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

function redisDetails(tdCache, details) {
  var output = details || {};
  if (tdCache && tdCache.redis_host) output.host = tdCache.redis_host;
  if (tdCache && tdCache.redis_port) output.port = String(tdCache.redis_port);
  if (tdCache && tdCache.readyAt) output.readyAt = tdCache.readyAt;
  if (tdCache && tdCache.lastError && tdCache.lastError.message && !output.error) {
    output.error = tdCache.lastError.message;
  }
  return output;
}

async function checkRedis(tdCache) {
  var startedAt = Date.now();
  var client = tdCache && tdCache.client ? tdCache.client : null;
  if (!client) {
    return service('redis', 'Redis', 'unknown', null, redisDetails(tdCache, { reason: 'not_configured' }));
  }

  if (client.ready !== true && client.connected !== true) {
    return service('redis', 'Redis', 'down', null, redisDetails(tdCache, { reason: 'not_ready' }));
  }

  try {
    var response = await pingRedisClient(client);
    return service('redis', 'Redis', response === 'PONG' ? 'ok' : 'degraded', Date.now() - startedAt, redisDetails(tdCache, {
      response: response
    }));
  } catch (err) {
    return service('redis', 'Redis', 'down', Date.now() - startedAt, redisDetails(tdCache, { error: err.message }));
  }
}

function getRabbitUrl() {
  return process.env.CLOUDAMQP_URL ||
    process.env.AMQP_URL ||
    process.env.RABBITMQ_URL ||
    process.env.AMQP_MANAGER_URL ||
    process.env.RABBITMQ_URI ||
    null;
}

function withHeartbeat(url) {
  if (!url) return url;
  return url + (url.indexOf('?') === -1 ? '?heartbeat=10' : '&heartbeat=10');
}

function getQueueNames() {
  var raw = process.env.OPERATIONAL_RABBITMQ_QUEUES || process.env.QUEUE_NAME || '';
  return raw.split(',').map(function(item) {
    return item.trim();
  }).filter(Boolean);
}

function toNumber(value, fallback) {
  var parsed = Number(value);
  return isNaN(parsed) ? fallback : parsed;
}

function queueStatus(queue) {
  if (queue.error) return 'down';
  if (queue.state && queue.state !== 'running') return 'degraded';
  var ready = toNumber(queue.messagesReady, 0);
  var unacked = toNumber(queue.messagesUnacknowledged, 0);
  var consumers = toNumber(queue.consumers, 0);
  if (consumers === 0 && (ready > 0 || unacked > 0)) return 'degraded';
  if (ready >= QUEUE_READY_ALERT_THRESHOLD) return 'degraded';
  if (unacked >= QUEUE_UNACKED_ALERT_THRESHOLD) return 'degraded';
  return 'ok';
}

function connectRabbit(url) {
  return new Promise(function(resolve, reject) {
    amqp.connect(withHeartbeat(url), function(err, conn) {
      if (err) return reject(err);
      resolve(conn);
    });
  });
}

function checkQueue(conn, queueName) {
  return new Promise(function(resolve) {
    conn.createChannel(function(channelErr, channel) {
      if (channelErr) {
        return resolve({
          name: queueName,
          status: 'down',
          error: channelErr.message
        });
      }

      channel.checkQueue(queueName, function(err, ok) {
        try { channel.close(); } catch (closeErr) {}
        if (err) {
          return resolve({
            name: queueName,
            status: 'down',
            error: err.message,
            source: 'amqp'
          });
        }
        var queue = {
          name: queueName,
          messagesReady: toNumber(ok.messageCount, 0),
          messagesUnacknowledged: null,
          messagesTotal: toNumber(ok.messageCount, 0),
          consumers: toNumber(ok.consumerCount, 0),
          source: 'amqp'
        };
        queue.status = queueStatus(queue);
        resolve(queue);
      });
    });
  });
}

function normalizeManagementUrl(value) {
  if (!value) return null;
  var normalized = String(value).replace(/\/+$/g, '');
  if (!/\/api$/.test(normalized)) normalized += '/api';
  return normalized;
}

function rabbitTokenFromAmqpUrl(value) {
  if (!value) return null;
  try {
    var parsed = new URL(value);
    return parsed.password || null;
  } catch (err) {
    return null;
  }
}

function getRabbitManagementConfig(options) {
  options = options || {};
  if (options.managementClient) {
    return {
      client: options.managementClient,
      vhost: options.managementVhost || process.env.OPERATIONAL_RABBITMQ_VHOST || '/',
      source: 'injected'
    };
  }

  var rawUrl = options.managementUrl ||
    process.env.OPERATIONAL_RABBITMQ_MANAGEMENT_URL ||
    process.env.RABBITMQ_MANAGEMENT_URL ||
    null;
  var url = normalizeManagementUrl(rawUrl);
  if (!url) return null;

  var parsed = new URL(url);
  var username = options.managementUsername ||
    process.env.OPERATIONAL_RABBITMQ_MANAGEMENT_USERNAME ||
    process.env.RABBITMQ_MANAGEMENT_USERNAME ||
    decodeURIComponent(parsed.username || '');
  var password = REDACTED_SECRET ||
    process.env.OPERATIONAL_RABBITMQ_MANAGEMENT_PASSWORD ||
    process.env.RABBITMQ_MANAGEMENT_PASSWORD ||
    decodeURIComponent(parsed.password || '');
  var token = options.managementToken ||
    process.env.OPERATIONAL_RABBITMQ_MANAGEMENT_TOKEN ||
    process.env.RABBITMQ_MANAGEMENT_TOKEN ||
    rabbitTokenFromAmqpUrl(process.env.RABBITMQ_ADMIN_URI) ||
    null;

  parsed.username = '';
  parsed.password = '';

  return {
    url: parsed.toString().replace(/\/+$/g, ''),
    username: username || null,
    password: password || null,
    token: token || null,
    vhost: options.managementVhost || process.env.OPERATIONAL_RABBITMQ_VHOST || '/',
    timeoutMs: parsePositiveInt(process.env.OPERATIONAL_RABBITMQ_MANAGEMENT_TIMEOUT_MS || '5000', 5000),
    source: 'http'
  };
}

function managementAuthHeaders(config) {
  if (config.username && config.password) {
    return {
      authorization: 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64')
    };
  }
  if (config.token) {
    return { authorization: 'Bearer ' + config.token };
  }
  return {};
}

function requestJson(url, headers, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var parsed = new URL(url);
    var client = parsed.protocol === 'https:' ? https : http;
    var req = client.request({
      method: 'GET',
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: headers || {}
    }, function(res) {
      var chunks = [];
      res.on('data', function(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('error', reject);
      res.on('end', function() {
        var body = Buffer.concat(chunks).toString();
        if (res.statusCode >= 300) {
          return reject(new Error('RabbitMQ management API returned HTTP ' + res.statusCode));
        }
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(new Error('RabbitMQ management API returned invalid JSON'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, function() {
      req.destroy(new Error('RabbitMQ management API request timed out'));
    });
    req.end();
  });
}

async function getManagementQueue(config, queueName) {
  if (config.client && typeof config.client.getQueue === 'function') {
    return config.client.getQueue(queueName, config.vhost);
  }

  var url = config.url + '/queues/' + encodeURIComponent(config.vhost) + '/' + encodeURIComponent(queueName);
  return requestJson(url, managementAuthHeaders(config), config.timeoutMs);
}

function normalizeManagementQueue(row, queueName) {
  var ready = toNumber(row.messages_ready, 0);
  var unacked = toNumber(row.messages_unacknowledged, 0);
  var total = toNumber(row.messages, ready + unacked);
  var queue = {
    name: row.name || queueName,
    status: 'ok',
    state: row.state || null,
    messagesReady: ready,
    messagesUnacknowledged: unacked,
    messagesTotal: total,
    consumers: toNumber(row.consumers, 0),
    source: 'management'
  };
  queue.status = queueStatus(queue);
  return queue;
}

async function checkQueueViaManagement(config, queueName) {
  try {
    return normalizeManagementQueue(await getManagementQueue(config, queueName), queueName);
  } catch (err) {
    return {
      name: queueName,
      status: 'down',
      error: err.message,
      source: 'management'
    };
  }
}

async function checkRabbit(options) {
  options = options || {};
  var startedAt = Date.now();
  var url = Object.prototype.hasOwnProperty.call(options, 'url') ? options.url : getRabbitUrl();
  var queueNames = options.queueNames || getQueueNames();
  var managementConfig = getRabbitManagementConfig(options);
  if (!url && !managementConfig) {
    return service('rabbitmq', 'RabbitMQ', 'unknown', null, {
      reason: 'not_configured',
      queues: queueNames
    });
  }

  var conn;
  try {
    var queues = [];
    var amqpConnected = false;

    if (url) {
      var connectRabbitFn = options.connectRabbit || connectRabbit;
      conn = await connectRabbitFn(url);
      amqpConnected = true;
    }

    if (managementConfig) {
      for (var i = 0; i < queueNames.length; i++) {
        queues.push(await checkQueueViaManagement(managementConfig, queueNames[i]));
      }
    } else if (conn) {
      var checkQueueFn = options.checkQueue || checkQueue;
      for (var j = 0; j < queueNames.length; j++) {
        queues.push(await checkQueueFn(conn, queueNames[j]));
      }
    }

    try { conn.close(); } catch (closeErr) {}
    var status = queues.length ? mergeOverall(queues) : 'ok';
    return service('rabbitmq', 'RabbitMQ', status, Date.now() - startedAt, {
      queues: queues,
      queueSource: managementConfig ? 'management' : 'amqp',
      amqpConnected: amqpConnected,
      managementApi: Boolean(managementConfig)
    });
  } catch (err) {
    try { if (conn) conn.close(); } catch (closeErr2) {}
    return service('rabbitmq', 'RabbitMQ', 'down', Date.now() - startedAt, { error: err.message });
  }
}

function collectStream(stream) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    stream.on('error', reject);
    stream.on('data', function(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', function() {
      resolve(Buffer.concat(chunks));
    });
  });
}

function createGridFsProbeService(bucketName) {
  var bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: bucketName });
  return {
    createFile: function(filename, data, path, contentType, options) {
      return new Promise(function(resolve, reject) {
        var stream = bucket.openUploadStream(filename, {
          contentType: contentType,
          metadata: options && options.metadata ? options.metadata : {}
        });
        stream.on('error', reject);
        stream.on('finish', function() {
          resolve({ filename: filename, _id: stream.id, length: data.length, contentType: contentType });
        });
        stream.end(data);
      });
    },
    getFileDataAsBuffer: function(filename) {
      return collectStream(bucket.openDownloadStreamByName(filename));
    },
    deleteFile: async function(filename) {
      var files = await bucket.find({ filename: filename }).toArray();
      if (!files.length) {
        var error = new Error('File not found');
        error.code = 'ENOENT';
        throw error;
      }
      return new Promise(function(resolve, reject) {
        bucket.delete(files[0]._id, function(err) {
          if (err) return reject(err);
          resolve(files[0]);
        });
      });
    }
  };
}

async function performStorageProbe(fileService, filename, payload, contentType) {
  var created = false;
  var deleted = false;
  try {
    await fileService.createFile(filename, payload, undefined, contentType, {
      metadata: {
        purpose: 'operational-health',
        createdAt: nowIso()
      }
    });
    created = true;

    var stored = await fileService.getFileDataAsBuffer(filename);
    if (!Buffer.isBuffer(stored) || !stored.equals(payload)) {
      throw new Error('storage read verification failed');
    }

    await fileService.deleteFile(filename);
    deleted = true;

    return {
      filename: filename,
      bytes: payload.length,
      created: created,
      read: true,
      deleted: deleted
    };
  } catch (err) {
    if (created && !deleted) {
      try { await fileService.deleteFile(filename); } catch (cleanupErr) {}
    }
    throw err;
  }
}

function storageDetails(driver, details) {
  var output = details || {};
  output.driver = driver;
  if (driver === 'r2') {
    output.bucket = process.env.R2_BUCKET || process.env.CLOUDFLARE_R2_BUCKET || null;
    output.keyPrefix = process.env.R2_KEY_PREFIX || process.env.CLOUDFLARE_R2_KEY_PREFIX || null;
  } else {
    output.bucket = 'files';
    output.database = mongoose.connection && mongoose.connection.name ? mongoose.connection.name : null;
  }
  return output;
}

async function checkStorage(options) {
  options = options || {};
  var force = options.force === true;
  var cacheEnabled = options.cache !== false && !options.fileService;
  var ttlSeconds = parsePositiveInt(process.env.OPERATIONAL_STORAGE_CHECK_TTL_SECONDS || '300', 300);

  var startedAt = Date.now();
  var driver = options.driver || (fileStorageFactory.isObjectStorageEnabled() ? 'r2' : 'gridfs');

  if (!boolEnv('OPERATIONAL_STORAGE_CHECK_ENABLED', true)) {
    return service('storage', 'Storage', 'skipped', null, storageDetails(driver, { reason: 'disabled' }));
  }

  if (cacheEnabled && !force && storageHealthCache.value && Date.now() < storageHealthCache.expiresAt) {
    return storageHealthCache.value;
  }

  try {
    if (driver === 'gridfs' && (mongoose.connection.readyState !== 1 || !mongoose.connection.db)) {
      return service('storage', 'Storage', 'down', null, storageDetails(driver, { reason: 'mongo_not_ready' }));
    }

    var fileService = options.fileService;
    if (!fileService) {
      fileService = driver === 'r2'
        ? fileStorageFactory.createPrimaryFileService('files')
        : createGridFsProbeService('files');
    }

    var random = crypto.randomBytes(8).toString('hex');
    var filename = options.filename || ('healthchecks/storage/' + process.pid + '-' + Date.now() + '-' + random + '.txt');
    var payload = options.payload || Buffer.from('chatcase-storage-health:' + nowIso());
    var probe = await performStorageProbe(fileService, filename, payload, 'text/plain');
    var result = service('storage', 'Storage', 'ok', Date.now() - startedAt, storageDetails(driver, {
      checkedAt: nowIso(),
      bytes: probe.bytes,
      keyPrefix: driver === 'r2' ? (process.env.R2_KEY_PREFIX || process.env.CLOUDFLARE_R2_KEY_PREFIX || null) : undefined,
      cacheTtlSeconds: ttlSeconds
    }));

    if (cacheEnabled) {
      storageHealthCache = {
        expiresAt: Date.now() + ttlSeconds * 1000,
        value: result
      };
    }
    return result;
  } catch (err) {
    var errorResult = service('storage', 'Storage', 'down', Date.now() - startedAt, storageDetails(driver, {
      error: err.message,
      checkedAt: nowIso(),
      configured: driver === 'r2' ? R2FileService.isConfigured() : true
    }));
    if (cacheEnabled) {
      storageHealthCache = {
        expiresAt: Date.now() + ttlSeconds * 1000,
        value: errorResult
      };
    }
    return errorResult;
  }
}

async function testStorageConnection() {
  var result = await checkStorage({ force: true });
  await operationalLogger.record({
    level: result.status === 'down' ? 'error' : (result.status === 'skipped' ? 'warn' : 'info'),
    area: 'storage',
    channel: 'system',
    event: 'storage.health_check',
    status: result.status === 'ok' ? 'success' : result.status,
    latencyMs: result.latencyMs,
    errorMessage: result.status === 'ok' ? undefined : ((result.details && (result.details.error || result.details.reason)) || result.status),
    details: result.details || {}
  });
  return result;
}

function checkServer() {
  return service('server', 'Server', 'ok', null, {
    version: pjson.version,
    uptimeSeconds: Math.round(process.uptime()),
    memory: process.memoryUsage()
  });
}

async function getServices(tdCache) {
  var results = await Promise.all([
    checkMongo(),
    checkRedis(tdCache),
    checkRabbit(),
    checkStorage()
  ]);
  results.unshift(checkServer());
  return results;
}

function integrationDisplayName(integration) {
  if (!integration || !integration.value) return 'N/A';
  return integration.value.instanceName ||
    integration.value.verified_name ||
    integration.value.phone_number ||
    integration.value.number ||
    integration.name;
}

function integrationOperationalKey(integration) {
  if (integration.name === 'casezap') return String(integration._id);
  return integration.value && (
    integration.value.phone_number_id ||
    integration.value.waba_id ||
    integration.value.business_account_id ||
    integration.value.whatsapp_business_account_id ||
    String(integration._id)
  );
}

function wabaDedupeKeys(integration) {
  var value = integration.value || {};
  var projectId = integration.id_project || 'unknown';
  var keys = [];

  if (value.phone_number_id) {
    keys.push(projectId + ':phone:' + value.phone_number_id);
    return keys;
  }

  if (value.waba_id) keys.push(projectId + ':waba:' + value.waba_id);
  if (value.business_account_id) keys.push(projectId + ':business:' + value.business_account_id);
  if (value.whatsapp_business_account_id) keys.push(projectId + ':business:' + value.whatsapp_business_account_id);
  return keys;
}

function mergeKvstoreWabaIntegrations(integrations, kvstoreWabas) {
  var seen = {};
  integrations.forEach(function(integration) {
    if (integration.name !== 'whatsapp') return;
    wabaDedupeKeys(integration).forEach(function(key) {
      seen[key] = true;
    });
  });

  kvstoreWabas.forEach(function(integration) {
    var keys = wabaDedupeKeys(integration);
    var exists = keys.some(function(key) {
      return seen[key];
    });
    if (exists) return;

    keys.forEach(function(key) {
      seen[key] = true;
    });
    integrations.push(integration);
  });

  return integrations;
}

async function getLastEventMap(channel) {
  var rows = await OperationalEvent.find({ channel: channel })
    .sort({ timestamp: -1 })
    .limit(500)
    .lean();

  var map = {};
  rows.forEach(function(row) {
    var key = row.integrationId || 'unknown';
    if (!map[key]) {
      map[key] = {};
    }
    if (!map[key].lastEvent) map[key].lastEvent = row;
    if (!map[key].lastWebhook && row.area === 'webhook') map[key].lastWebhook = row;
    if (!map[key].lastError && row.level === 'error') map[key].lastError = row;
  });
  return map;
}

async function mapLimit(items, limit, iterator) {
  var results = new Array(items.length);
  var nextIndex = 0;
  var workers = [];
  var workerCount = Math.max(1, Math.min(limit || 1, items.length));

  async function runWorker() {
    while (nextIndex < items.length) {
      var index = nextIndex++;
      results[index] = await iterator(items[index], index);
    }
  }

  for (var i = 0; i < workerCount; i++) {
    workers.push(runWorker());
  }

  await Promise.all(workers);
  return results;
}

async function getChannels() {
  var integrations = await Integration.find({ name: { $in: ['whatsapp', 'casezap'] } }).lean();
  var kvstoreWabas = await channelDiagnosticsService.listKvstoreWabaIntegrations();
  integrations = mergeKvstoreWabaIntegrations(integrations, kvstoreWabas);
  var wabaEvents = await getLastEventMap('waba');
  var casezapEvents = await getLastEventMap('casezap');

  return mapLimit(integrations, PROVIDER_CHECK_CONCURRENCY, async function(integration) {
    var channel = integration.name === 'casezap' ? 'casezap' : 'waba';
    var key = integrationOperationalKey(integration);
    var docKey = String(integration._id);
    var channelEvents = channel === 'casezap' ? casezapEvents : wabaEvents;
    var eventInfo = channelEvents[key] || channelEvents[docKey];
    eventInfo = eventInfo || {};
    var diagnostics = null;
    try {
      diagnostics = await channelDiagnosticsService.checkIntegration(integration, { force: false });
    } catch (err) {
      diagnostics = {
        providerHealth: 'unknown',
        providerStatus: integration.value && integration.value.status,
        providerReason: 'provider_check_failed',
        providerError: err.message
      };
    }

    var status = 'ok';
    if (integration.value && integration.value.status === 'disconnected') {
      status = 'down';
    } else if (eventInfo.lastError) {
      var ageMs = Date.now() - new Date(eventInfo.lastError.timestamp).getTime();
      status = ageMs <= WEBHOOK_FAILURE_WINDOW_MINUTES * 60 * 1000 ? 'degraded' : 'ok';
    }
    if (diagnostics && diagnostics.providerHealth) {
      status = highestStatus(status, diagnostics.providerHealth);
    }

    return {
      channel: channel,
      integrationId: key,
      integrationDocId: String(integration._id),
      integrationSource: integration._source || 'integration',
      id_project: integration.id_project,
      name: integrationDisplayName(integration),
      status: status,
      providerStatus: diagnostics && diagnostics.providerStatus ? diagnostics.providerStatus : (integration.value && integration.value.status),
      providerHealth: diagnostics && diagnostics.providerHealth,
      providerReason: diagnostics && diagnostics.providerReason,
      providerCode: diagnostics && diagnostics.providerCode,
      providerCheckedAt: diagnostics && diagnostics.providerCheckedAt,
      providerLatencyMs: diagnostics && diagnostics.providerLatencyMs,
      providerError: diagnostics && diagnostics.providerError,
      qualityRating: diagnostics && diagnostics.qualityRating,
      nameStatus: diagnostics && diagnostics.nameStatus,
      canSendNewMessages: diagnostics && diagnostics.canSendNewMessages,
      lastWebhookRegistrationAt: integration.value && integration.value.operational ? integration.value.operational.lastWebhookRegistrationAt : null,
      lastWebhookRegistrationStatus: integration.value && integration.value.operational ? integration.value.operational.lastWebhookRegistrationStatus : null,
      lastWebhookRegistrationError: integration.value && integration.value.operational ? integration.value.operational.lastWebhookRegistrationError : null,
      lastWebhookAt: eventInfo.lastWebhook ? eventInfo.lastWebhook.timestamp : null,
      lastEvent: eventInfo.lastEvent ? eventInfo.lastEvent.event : null,
      lastErrorAt: eventInfo.lastError ? eventInfo.lastError.timestamp : null,
      lastError: eventInfo.lastError ? eventInfo.lastError.errorMessage : null
    };
  });
}

async function getWebhookFailureAlerts() {
  var since = new Date(Date.now() - WEBHOOK_FAILURE_WINDOW_MINUTES * 60 * 1000);
  var rows = await OperationalEvent.aggregate([
    {
      $match: {
        timestamp: { $gte: since },
        area: 'webhook',
        status: 'failed'
      }
    },
    {
      $group: {
        _id: {
          channel: '$channel',
          id_project: '$id_project',
          integrationId: '$integrationId'
        },
        count: { $sum: 1 },
        lastAt: { $max: '$timestamp' },
        lastError: { $last: '$errorMessage' }
      }
    }
  ]);

  return rows.filter(function(row) {
    return row.count >= WEBHOOK_FAILURE_THRESHOLD;
  }).map(function(row) {
    return {
      key: ['webhook', row._id.channel, row._id.integrationId || row._id.id_project || 'unknown'].join(':'),
      type: 'webhook_failure',
      severity: 'critical',
      status: 'open',
      title: 'Webhook falhando',
      message: row.count + ' falhas em ' + WEBHOOK_FAILURE_WINDOW_MINUTES + ' minutos',
      channel: row._id.channel,
      id_project: row._id.id_project,
      integrationId: row._id.integrationId,
      lastAt: row.lastAt,
      lastError: row.lastError,
      details: {
        failures: row.count,
        windowMinutes: WEBHOOK_FAILURE_WINDOW_MINUTES,
        lastError: row.lastError
      }
    };
  });
}

function getServiceAlerts(services) {
  return services.filter(function(item) {
    return item.status === 'down' || item.status === 'degraded';
  }).map(function(item) {
    return {
      key: 'service:' + item.name,
      type: 'service_health',
      severity: item.status === 'down' ? 'critical' : 'warning',
      status: 'open',
      title: item.label + ' ' + (item.status === 'down' ? 'indisponivel' : 'degradado'),
      message: item.details && item.details.error ? item.details.error : item.status,
      service: item.name,
      lastAt: nowIso(),
      details: item.details
    };
  });
}

function getQueueAlerts(services) {
  var rabbit = services.find(function(item) { return item.name === 'rabbitmq'; });
  if (!rabbit || !rabbit.details || !rabbit.details.queues) return [];
  var alerts = [];
  rabbit.details.queues.forEach(function(queue) {
    if (queue.messagesReady >= QUEUE_READY_ALERT_THRESHOLD) {
      alerts.push({
        key: 'queue_backlog:' + queue.name,
        type: 'queue_backlog',
        severity: 'warning',
        status: 'open',
        title: 'Fila acumulando',
        message: queue.name + ' com ' + queue.messagesReady + ' mensagens prontas',
        queue: queue.name,
        lastAt: nowIso(),
        details: queue
      });
    }
    if (queue.messagesUnacknowledged >= QUEUE_UNACKED_ALERT_THRESHOLD) {
      alerts.push({
        key: 'queue_unacked:' + queue.name,
        type: 'queue_unacked',
        severity: 'warning',
        status: 'open',
        title: 'Fila com mensagens em processamento',
        message: queue.name + ' com ' + queue.messagesUnacknowledged + ' mensagens unacked',
        queue: queue.name,
        lastAt: nowIso(),
        details: queue
      });
    }
    if (queue.consumers === 0 && ((queue.messagesReady || 0) > 0 || (queue.messagesUnacknowledged || 0) > 0)) {
      alerts.push({
        key: 'queue_no_consumers:' + queue.name,
        type: 'queue_no_consumers',
        severity: 'critical',
        status: 'open',
        title: 'Fila sem consumers',
        message: queue.name + ' tem mensagens e nenhum consumer',
        queue: queue.name,
        lastAt: nowIso(),
        details: queue
      });
    }
  });
  return alerts;
}

function getChannelAlerts(channels) {
  return (channels || []).filter(function(channel) {
    return channel.status === 'down' || channel.status === 'degraded';
  }).map(function(channel) {
    var providerLabel = channel.channel === 'casezap' ? 'CaseZap' : 'WABA';
    var integrationLabel = channel.name ? ' (' + channel.name + ')' : '';
    var reason = channel.providerReason || channel.lastError || channel.providerStatus || channel.status;
    return {
      key: ['channel', channel.channel, channel.integrationDocId || channel.integrationId || 'unknown'].join(':'),
      type: 'channel_health',
      severity: channel.status === 'down' ? 'critical' : 'warning',
      status: 'open',
      title: providerLabel + integrationLabel + ' ' + (channel.status === 'down' ? 'indisponivel' : 'degradado'),
      message: reason,
      channel: channel.channel,
      id_project: channel.id_project,
      integrationId: channel.integrationDocId || channel.integrationId,
      lastAt: channel.providerCheckedAt || channel.lastErrorAt || nowIso(),
      lastError: channel.providerError || channel.lastError,
      details: {
        providerStatus: channel.providerStatus,
        name: channel.name,
        providerHealth: channel.providerHealth,
        providerReason: channel.providerReason,
        providerCode: channel.providerCode,
        qualityRating: channel.qualityRating,
        nameStatus: channel.nameStatus,
        canSendNewMessages: channel.canSendNewMessages
      }
    };
  });
}

async function getAlerts(services, channels) {
  var webhookAlerts = await getWebhookFailureAlerts();
  return getServiceAlerts(services).concat(getQueueAlerts(services)).concat(getChannelAlerts(channels)).concat(webhookAlerts);
}

async function getSummary() {
  var query = OperationalHealthSnapshot.findOne({ _id: SNAPSHOT_ID });
  var snapshot = query && typeof query.lean === 'function' ? await query.lean() : await query;
  if (!snapshot) return emptySnapshot();
  if (!isSnapshotValid(snapshot)) {
    var invalid = new Error('Operational health snapshot unavailable');
    invalid.code = 'health_snapshot_unavailable';
    throw invalid;
  }

  var summary = plainSnapshot(snapshot);
  summary.snapshotState = deriveSnapshotState(summary);
  return summary;
}

module.exports = {
  buildSnapshot: buildSnapshot,
  deriveSnapshotState: deriveSnapshotState,
  collectSnapshotInput: collectSnapshotInput,
  getSummary: getSummary,
  getServices: getServices,
  getChannels: getChannels,
  getAlerts: getAlerts,
  testChannelConnection: channelDiagnosticsService.testChannelConnection,
  registerChannelWebhook: channelDiagnosticsService.registerChannelWebhook,
  checkMongo: checkMongo,
  checkRedis: checkRedis,
  checkRabbit: checkRabbit,
  checkStorage: checkStorage,
  testStorageConnection: testStorageConnection,
  performStorageProbe: performStorageProbe
};
