var mongoose = require('mongoose');
var amqp = require('amqplib/callback_api');
var pjson = require('../package.json');
var Integration = require('../models/integrations');
var OperationalEvent = require('../models/operationalEvent');
var operationalAlertService = require('./operationalAlertService');
var channelDiagnosticsService = require('./channelDiagnosticsService');

var WEBHOOK_FAILURE_WINDOW_MINUTES = parseInt(process.env.OPERATIONAL_WEBHOOK_FAILURE_WINDOW_MINUTES || '15', 10);
var WEBHOOK_FAILURE_THRESHOLD = parseInt(process.env.OPERATIONAL_WEBHOOK_FAILURE_THRESHOLD || '3', 10);
var QUEUE_READY_ALERT_THRESHOLD = parseInt(process.env.OPERATIONAL_QUEUE_READY_ALERT_THRESHOLD || '100', 10);
var PROVIDER_CHECK_CONCURRENCY = parseInt(process.env.OPERATIONAL_PROVIDER_CHECK_CONCURRENCY || '10', 10);
if (isNaN(PROVIDER_CHECK_CONCURRENCY) || PROVIDER_CHECK_CONCURRENCY < 1) PROVIDER_CHECK_CONCURRENCY = 10;

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
            error: err.message
          });
        }
        resolve({
          name: queueName,
          status: ok.consumerCount === 0 && ok.messageCount > 0 ? 'degraded' : 'ok',
          messagesReady: ok.messageCount,
          consumers: ok.consumerCount
        });
      });
    });
  });
}

async function checkRabbit() {
  var startedAt = Date.now();
  var url = getRabbitUrl();
  var queueNames = getQueueNames();
  if (!url) {
    return service('rabbitmq', 'RabbitMQ', 'unknown', null, {
      reason: 'not_configured',
      queues: queueNames
    });
  }

  var conn;
  try {
    conn = await connectRabbit(url);
    var queues = [];
    for (var i = 0; i < queueNames.length; i++) {
      queues.push(await checkQueue(conn, queueNames[i]));
    }
    try { conn.close(); } catch (closeErr) {}
    var status = queues.length ? mergeOverall(queues) : 'ok';
    return service('rabbitmq', 'RabbitMQ', status, Date.now() - startedAt, { queues: queues });
  } catch (err) {
    try { if (conn) conn.close(); } catch (closeErr2) {}
    return service('rabbitmq', 'RabbitMQ', 'down', Date.now() - startedAt, { error: err.message });
  }
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
    checkRabbit()
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
  return integration.value && (integration.value.waba_id || integration.value.phone_number_id || String(integration._id));
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
  var wabaEvents = await getLastEventMap('waba');
  var casezapEvents = await getLastEventMap('casezap');

  return mapLimit(integrations, PROVIDER_CHECK_CONCURRENCY, async function(integration) {
    var channel = integration.name === 'casezap' ? 'casezap' : 'waba';
    var key = integrationOperationalKey(integration);
    var eventInfo = channel === 'casezap' ? casezapEvents[key] : wabaEvents[key];
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
    if (queue.consumers === 0 && queue.messagesReady > 0) {
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
    var reason = channel.providerReason || channel.lastError || channel.providerStatus || channel.status;
    return {
      key: ['channel', channel.channel, channel.integrationDocId || channel.integrationId || 'unknown'].join(':'),
      type: 'channel_health',
      severity: channel.status === 'down' ? 'critical' : 'warning',
      status: 'open',
      title: providerLabel + ' ' + (channel.status === 'down' ? 'indisponivel' : 'degradado'),
      message: reason,
      channel: channel.channel,
      id_project: channel.id_project,
      integrationId: channel.integrationDocId || channel.integrationId,
      lastAt: channel.providerCheckedAt || channel.lastErrorAt || nowIso(),
      lastError: channel.providerError || channel.lastError,
      details: {
        providerStatus: channel.providerStatus,
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

async function getSummary(app) {
  var tdCache = app && app.get ? app.get('redis_client') : null;
  var services = await getServices(tdCache);
  var channels = await getChannels();
  var dynamicAlerts = await getAlerts(services, channels);
  var alerts = dynamicAlerts;
  try {
    alerts = await operationalAlertService.syncAlerts(dynamicAlerts);
  } catch (err) {
    alerts = dynamicAlerts.map(function(alert) {
      alert.persistenceError = err.message;
      return alert;
    });
  }
  var overallStatus = mergeOverall(services.concat(channels));
  if (alerts.some(function(alert) { return alert.severity === 'critical'; })) {
    overallStatus = 'down';
  } else if (alerts.length && overallStatus === 'ok') {
    overallStatus = 'degraded';
  }

  return {
    generatedAt: nowIso(),
    overallStatus: overallStatus,
    services: services,
    channels: channels,
    queues: services.find(function(item) { return item.name === 'rabbitmq'; }),
    alerts: alerts
  };
}

module.exports = {
  getSummary: getSummary,
  getServices: getServices,
  getChannels: getChannels,
  getAlerts: getAlerts,
  testChannelConnection: channelDiagnosticsService.testChannelConnection,
  checkMongo: checkMongo,
  checkRedis: checkRedis,
  checkRabbit: checkRabbit
};
