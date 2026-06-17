var express = require('express');
var router = express.Router();
var winston = require('../../config/winston');
var axios = require('axios');
var LRU = require('lru-cache');
var mongoose = require('mongoose');
var { v4: uuidv4 } = require('uuid');
var passport = require('passport');
var validtoken = require('../../middleware/valid-token');
var messageMapper = require('./messageMapper');
var Integration = require('../../models/integrations');
var ChannelConstants = require('../../models/channelConstants');
var MessageConstants = require('../../models/messageConstants');
var Message = require('../../models/message');
var Request = require('../../models/request');
var Department = require('../../models/department');
var User = require('../../models/user');
var leadService = require('../../services/leadService');
var requestService = require('../../services/requestService');
var messageService = require('../../services/messageService');
var departmentService = require('../../services/departmentService');
var chat21GroupRepairService = require('../../services/chat21GroupRepairService');
var messageEvent = require('../../event/messageEvent');
var integrationEvent = require('../../event/integrationEvent');
var mediaStorage = require('./mediaStorage');
var operationalLogger = require('../../services/operationalLogger');
var chat21 = require('../../channels/chat21/chat21Client');
var chat21Config = require('../../channels/chat21/chat21Config');

var DEDUP_TTL = 3600;
var DEDUP_PREFIX = 'czdedup:';
var localCache = new LRU({ max: 10000, maxAge: 1000 * 60 * 60 });
var chat21GroupReadyCache = new LRU({ max: 10000, maxAge: 1000 * 60 * 30 });
var tdCache = null;
var chat21AdminToken = process.env.CHAT21_ADMIN_TOKEN || chat21Config.adminToken;
var chat21MessagesConnection = null;
var Chat21Message = null;
var defaultChat21GroupRepair = chat21GroupRepairService.createChat21GroupRepairService();

function setRedisClient(redisClient) {
  tdCache = redisClient;
  winston.info('CaseZap dedup using Redis');
}

async function checkAndMarkProcessed(messageId) {
  if (tdCache) {
    try {
      var wasSet = await tdCache.setNX(DEDUP_PREFIX + messageId, '1', DEDUP_TTL);
      return !wasSet;
    } catch (err) {
      winston.warn('CaseZap Redis dedup failed, falling back to LRU: ' + err.message);
    }
  }
  if (localCache.has(messageId)) return true;
  localCache.set(messageId, true);
  return false;
}

async function hasStoredCaseZapMessage(projectId, messageId, model) {
  if (!messageId) return false;
  model = model || Message;
  var existing = await model.findOne({
    id_project: projectId,
    'attributes.casezapMessageId': messageId
  }).select('_id').lean();
  return Boolean(existing);
}
var casezapProjects = new Map();
var casezapEnabled = process.env.CASEZAP_ENABLED !== 'false';

function recordOperation(event) {
  operationalLogger.recordSafe(Object.assign({
    area: 'webhook',
    channel: 'casezap'
  }, event));
}

function firstParticipantId(request) {
  if (!request || !request.participants || !request.participants.length) {
    return null;
  }
  return request.participants[0] ? String(request.participants[0]) : null;
}

function userFullname(user) {
  if (!user) return '';
  var fullname = [user.firstname, user.lastname].filter(Boolean).join(' ').trim();
  return fullname || user.fullname || user.email || '';
}

async function ensureCaseZapChat21Group(requestId, projectId, context, services) {
  var cacheKey = projectId + ':' + requestId;
  if (chat21GroupReadyCache.has(cacheKey)) {
    return { status: 'cached' };
  }

  var repairService = services && services.chat21GroupRepair ? services.chat21GroupRepair : defaultChat21GroupRepair;
  try {
    var result = await repairService.repairRequestGroup({
      request_id: requestId,
      id_project: projectId
    });

    chat21GroupReadyCache.set(cacheKey, true);

    recordOperation({
      id_project: projectId,
      integrationId: context && context.integrationId,
      requestId: requestId,
      messageId: context && context.messageId,
      event: 'webhook.chat21_group_ready',
      status: 'success',
      details: { repairStatus: result && result.status }
    });

    return result;
  } catch (err) {
    recordOperation({
      level: 'error',
      id_project: projectId,
      integrationId: context && context.integrationId,
      requestId: requestId,
      messageId: context && context.messageId,
      event: 'webhook.chat21_group_ready',
      status: 'failed',
      errorMessage: err.message
    });
    throw err;
  }
}

function plainMessage(message) {
  if (!message) return null;
  if (typeof message.toObject === 'function') return message.toObject();
  if (typeof message.toJSON === 'function') return message.toJSON();
  return message;
}

async function syncCaseZapChat21LastMessage(requestId, projectId, message, context, services) {
  if (!requestId || !message) {
    return { status: 'skipped' };
  }

  var chatClient = services && services.chat21 ? services.chat21 : chat21;
  if (!chatClient || !chatClient.groups || typeof chatClient.groups.updateAttributes !== 'function') {
    return { status: 'skipped' };
  }

  try {
    if (chatClient.auth && typeof chatClient.auth.setAdminToken === 'function') {
      chatClient.auth.setAdminToken(chat21AdminToken);
    }

    var result = await chatClient.groups.updateAttributes({
      last_message: plainMessage(message)
    }, requestId);

    recordOperation({
      id_project: projectId,
      integrationId: context && context.integrationId,
      requestId: requestId,
      messageId: context && context.messageId,
      event: 'webhook.chat21_last_message_synced',
      status: 'success'
    });

    return { status: 'updated', result: result };
  } catch (err) {
    winston.warn('CaseZap Chat21 last message sync failed: ' + err.message);
    recordOperation({
      level: 'error',
      id_project: projectId,
      integrationId: context && context.integrationId,
      requestId: requestId,
      messageId: context && context.messageId,
      event: 'webhook.chat21_last_message_synced',
      status: 'failed',
      errorMessage: err.message
    });
    return { status: 'failed', error: err.message };
  }
}

async function syncCaseZapChat21TranscriptMessage(requestId, projectId, message, request, context, services) {
  if (!requestId || !message) {
    return { status: 'skipped' };
  }

  var messagePlain = plainMessage(message);
  if (!messagePlain) {
    return { status: 'skipped' };
  }

  var Chat21MessageModel = services && services.chat21MessageModel ? services.chat21MessageModel : getChat21MessageModel();
  if (!Chat21MessageModel) {
    return { status: 'skipped' };
  }

  try {
    var existingCount = 0;
    if (typeof Chat21MessageModel.countDocuments === 'function') {
      existingCount = await Chat21MessageModel.countDocuments({
        'attributes.tiledesk_message_id': String(messagePlain._id),
        recipient: requestId
      });
    }
    if (existingCount > 0) {
      return { status: 'exists' };
    }

    var attributes = Object.assign({}, messagePlain.attributes || {});
    attributes.tiledesk_message_id = String(messagePlain._id);
    attributes.projectId = projectId;
    if (messagePlain.channel && messagePlain.channel.name) {
      attributes.channel = messagePlain.channel.name;
    }
    if (request && request.channel && request.channel.name) {
      attributes.request_channel = request.channel.name;
    }

    var recipientFullname = 'Guest';
    if (request && request.lead && request.lead.fullname) {
      recipientFullname = request.lead.fullname;
    }
    if (request && request.subject) {
      recipientFullname = request.subject;
    }

    var timestamp = attributes.clienttimestamp || (messagePlain.createdAt ? new Date(messagePlain.createdAt).getTime() : Date.now());
    var timelineIds = [requestId, messagePlain.sender, 'system'];
    if (request && Array.isArray(request.participants)) {
      timelineIds = timelineIds.concat(request.participants);
    }
    var messageId = uuidv4();
    var docs = Array.from(new Set(timelineIds.filter(Boolean).map(String))).map(function(timelineOf) {
      var doc = {
        message_id: messageId,
        timelineOf: timelineOf,
        app_id: process.env.CHAT21_APPID || chat21Config.appid,
        attributes: Object.assign({}, attributes),
        channel_type: 'group',
        conversWith: requestId,
        recipient: requestId,
        recipient_fullname: recipientFullname,
        sender: messagePlain.sender,
        sender_fullname: messagePlain.senderFullname || messagePlain.sender_fullname || messagePlain.sender || 'CaseZap',
        status: timelineOf === requestId ? 100 : 150,
        text: messagePlain.text,
        timestamp: timestamp,
        type: messagePlain.type || 'text'
      };
      if (messagePlain.metadata !== undefined) {
        doc.metadata = messagePlain.metadata;
      }
      return doc;
    });

    await Chat21MessageModel.create(docs);

    var statusService = services && services.messageService ? services.messageService : messageService;
    if (statusService && typeof statusService.changeStatus === 'function' && messagePlain._id) {
      await statusService.changeStatus(messagePlain._id, MessageConstants.CHAT_MESSAGE_STATUS.DELIVERED);
    }

    recordOperation({
      id_project: projectId,
      integrationId: context && context.integrationId,
      requestId: requestId,
      messageId: context && context.messageId,
      event: 'webhook.chat21_message_synced',
      status: 'success',
      details: { insertedCount: docs.length }
    });

    return { status: 'inserted', insertedCount: docs.length };
  } catch (err) {
    winston.warn('CaseZap Chat21 message sync failed: ' + err.message);
    recordOperation({
      level: 'error',
      id_project: projectId,
      integrationId: context && context.integrationId,
      requestId: requestId,
      messageId: context && context.messageId,
      event: 'webhook.chat21_message_synced',
      status: 'failed',
      errorMessage: err.message
    });
    return { status: 'failed', error: err.message };
  }
}

async function syncCaseZapRequestLastMessage(requestId, projectId, message, context, services) {
  if (!requestId || !projectId || !message) {
    return { status: 'skipped' };
  }

  var requestModel = services && services.requestModel ? services.requestModel : Request;
  var lastMessage = plainMessage(message);
  if (!lastMessage) {
    return { status: 'skipped' };
  }
  var lastMessageDate = lastMessage.updatedAt || lastMessage.createdAt || new Date();

  try {
    var result = await requestModel.findOneAndUpdate(
      { request_id: requestId, id_project: projectId },
      {
        $set: {
          'attributes.last_message': lastMessage,
          updatedAt: lastMessageDate
        }
      },
      { new: false, upsert: false }
    );

    recordOperation({
      id_project: projectId,
      integrationId: context && context.integrationId,
      requestId: requestId,
      messageId: context && context.messageId,
      event: 'webhook.request_last_message_synced',
      status: result ? 'success' : 'skipped'
    });

    return { status: result ? 'updated' : 'skipped' };
  } catch (err) {
    winston.warn('CaseZap request last message sync failed: ' + err.message);
    recordOperation({
      level: 'error',
      id_project: projectId,
      integrationId: context && context.integrationId,
      requestId: requestId,
      messageId: context && context.messageId,
      event: 'webhook.request_last_message_synced',
      status: 'failed',
      errorMessage: err.message
    });
    return { status: 'failed', error: err.message };
  }
}

async function resolveExternalFromMeSender(integration, request) {
  var participantId = firstParticipantId(request);
  if (participantId) {
    try {
      var user = await User.findById(participantId);
      return {
        sender: participantId,
        fullname: userFullname(user) || (integration.value && integration.value.instanceName) || 'CaseZap'
      };
    } catch (err) {
      winston.warn('CaseZap fromMe sender lookup failed: ' + err.message);
      return {
        sender: participantId,
        fullname: (integration.value && integration.value.instanceName) || 'CaseZap'
      };
    }
  }

  return {
    sender: 'casezap-' + integration._id.toString() + '-fromme',
    fullname: (integration.value && (integration.value.instanceName || integration.value.number)) || 'CaseZap'
  };
}

function isTypingPresence(presence) {
  var value = presence ? String(presence).toLowerCase() : '';
  return value === 'composing' || value === 'recording';
}

function shouldSkipCaseZapDepartmentBot(boundDepartment) {
  return !(boundDepartment && boundDepartment.id_bot);
}

function buildLegacyWebhookIntegrationQuery(projectId, secret) {
  return {
    id_project: projectId,
    name: 'casezap',
    'value.webhookSecret': secret
  };
}

async function emitPresenceTyping(integration, body) {
  if (!isTypingPresence(body && body.presence)) {
    return false;
  }

  var chatid = body.chatid || body.chatId || body.jid || '';
  var phone = messageMapper.extractPhone(chatid);
  if (!phone) {
    return false;
  }

  var integrationId = integration._id.toString();
  var leadId = 'casezap-' + integrationId + '-' + phone;
  try {
    var request = await Request.findOne({
      id_project: integration.id_project,
      'channel.name': ChannelConstants.CASEZAP,
      status: { $lt: 1000 },
      $or: [
        { 'attributes.casezapPhone': phone },
        { createdBy: leadId }
      ]
    }).sort({ createdAt: -1 });

    if (!request) {
      return false;
    }

    chat21.auth.setAdminToken(chat21AdminToken);
    await chat21.conversations.typing(request.request_id, leadId, body.presence, new Date());
    return true;
  } catch (err) {
    winston.warn('CaseZap presence typing forward failed: ' + err.message);
    return false;
  }
}

function chat21MongoUri() {
  if (process.env.CHAT21_MONGODB_URI || process.env.CHAT21_MONGODB_URL || process.env.CHAT21_DATABASE_URI) {
    return process.env.CHAT21_MONGODB_URI || process.env.CHAT21_MONGODB_URL || process.env.CHAT21_DATABASE_URI;
  }
  var tiledeskUri = process.env.DATABASE_URI || process.env.MONGODB_URI;
  if (!tiledeskUri) {
    return null;
  }
  return tiledeskUri.replace(/\/[^/?]+(\?|$)/, '/chat21$1');
}

function getChat21MessageModel() {
  if (Chat21Message) {
    return Chat21Message;
  }
  var uri = chat21MongoUri();
  if (!uri) {
    return null;
  }
  chat21MessagesConnection = mongoose.createConnection(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  Chat21Message = chat21MessagesConnection.model('chat21_message', new mongoose.Schema({}, {
    strict: false,
    collection: 'messages'
  }));
  return Chat21Message;
}

async function syncChat21PollMessage(message) {
  var Chat21MessageModel = getChat21MessageModel();
  if (!Chat21MessageModel) {
    return 0;
  }
  var result = await Chat21MessageModel.updateMany(
    { 'attributes.tiledesk_message_id': String(message._id) },
    {
      $set: {
        text: message.text,
        metadata: message.metadata,
        'attributes.casezapPollVotes': message.attributes && message.attributes.casezapPollVotes,
        'attributes.casezapLastPollUpdateId': message.attributes && message.attributes.casezapLastPollUpdateId
      }
    }
  );
  return result.modifiedCount || result.nModified || 0;
}

async function applyPollUpdate(projectId, integration, mapped) {
  var pollUpdate = mapped.metadata && mapped.metadata.pollUpdate;
  if (!pollUpdate || !pollUpdate.pollMessageId || !pollUpdate.vote) {
    return null;
  }

  var originalMessage = await Message.findOne({
    id_project: projectId,
    'attributes.casezapMessageId': pollUpdate.pollMessageId,
    'metadata.type': 'casezap/poll'
  }).sort({ createdAt: -1 });

  if (!originalMessage || !originalMessage.metadata || !originalMessage.metadata.poll) {
    return null;
  }

  var voterId = pollUpdate.voterId || mapped.phone || mapped.messageId;
  var poll = messageMapper.applyPollVoteToPayload(originalMessage.metadata.poll, voterId, pollUpdate.vote);
  var metadata = Object.assign({}, originalMessage.metadata, { poll: poll });
  var attributes = Object.assign({}, originalMessage.attributes || {});
  attributes.casezapPollVotes = poll.votes || {};
  attributes.casezapLastPollUpdateId = mapped.messageId;

  originalMessage.metadata = metadata;
  originalMessage.attributes = attributes;
  originalMessage.text = messageMapper.applyStructuredMarker('poll', poll);
  originalMessage.markModified('metadata');
  originalMessage.markModified('attributes');
  originalMessage.markModified('text');
  var savedMessage = await originalMessage.save();
  await syncChat21PollMessage(savedMessage);
  messageEvent.emit('message.update.simple', savedMessage);
  return savedMessage;
}

function extractConnectionStatus(body) {
  var rawStatus = body && (
    (body.data && body.data.state) ||
    (body.data && body.data.status) ||
    (body.data && body.data.connection) ||
    (body.instance && body.instance.status) ||
    (body.instance && body.instance.state) ||
    (body.connection && body.connection.status) ||
    (body.connection && body.connection.state) ||
    body.status
  );
  return rawStatus ? String(rawStatus).toLowerCase() : '';
}

function mapConnectionStatus(body) {
  var rawStatus = extractConnectionStatus(body);
  if (['active', 'open', 'connected', 'online', 'ready', 'authenticated'].includes(rawStatus)) {
    return 'active';
  }
  if (['banned', 'bannedm', 'close', 'closed', 'disconnected', 'logout', 'logged_out', 'offline', 'removed', 'unauthenticated'].includes(rawStatus)) {
    return 'disconnected';
  }
  return null;
}

function mapConnectionHealth(rawStatus, connectionStatus) {
  if (connectionStatus === 'active') return 'ok';
  if (connectionStatus === 'disconnected') return 'down';
  if (rawStatus === 'connecting' || rawStatus === 'pending' || rawStatus === 'qr') return 'degraded';
  return 'unknown';
}

function extractWebhookReceipt(body) {
  body = body || {};
  var message = body.message || (body.data && body.data.message) || body.data || {};
  var key = message.key || body.key || {};
  var messageId = body.messageId || body.message_id || body.id || message.id || key.id || null;
  var messageType = body.type || body.messageType || message.type || message.messageType || null;
  var fromMe = body.fromMe;

  if (fromMe === undefined && key.fromMe !== undefined) {
    fromMe = key.fromMe;
  }

  return {
    eventType: body.EventType || body.event || body.type || null,
    messageId: messageId ? String(messageId) : null,
    messageType: messageType ? String(messageType) : null,
    fromMe: typeof fromMe === 'boolean' ? fromMe : null
  };
}

async function markWebhookReceived(integration, receipt) {
  if (!integration || !integration._id) return;
  receipt = receipt || {};
  var set = {
    'value.operational.lastWebhookReceivedAt': new Date().toISOString(),
    'value.operational.lastWebhookReceivedEvent': receipt.eventType || null,
    'value.operational.lastWebhookReceivedMessageId': receipt.messageId || null,
    'value.operational.lastWebhookReceivedType': receipt.messageType || null,
    'value.operational.lastWebhookReceivedFromMe': receipt.fromMe
  };

  await Integration.findByIdAndUpdate(integration._id, { $set: set });
}

async function handleWebhook(integration, req, res) {
  var projectId = integration.id_project;
  var startedAt = Date.now();
  var integrationId = integration._id.toString();

  try {
    var body = req.body;
    if (!body || !body.EventType) {
      recordOperation({
        level: 'warn',
        id_project: projectId,
        integrationId: integrationId,
        event: 'webhook.failed',
        status: 'failed',
        errorCode: 'invalid_payload',
        errorMessage: 'Invalid CaseZap payload',
        latencyMs: Date.now() - startedAt
      });
      return res.status(400).json({ error: 'Invalid payload' });
    }

    var receipt = extractWebhookReceipt(body);
    await markWebhookReceived(integration, receipt);

    recordOperation({
      id_project: projectId,
      integrationId: integrationId,
      event: 'webhook.received',
      status: 'success',
      messageId: receipt.messageId,
      details: { eventType: body.EventType, messageType: receipt.messageType, fromMe: receipt.fromMe }
    });

    if (body.EventType === 'connection') {
      var newStatus = mapConnectionStatus(body);
      var rawStatus = extractConnectionStatus(body);
      var connectionSet = {
        'value.operational.lastProviderCheckAt': new Date().toISOString(),
        'value.operational.lastProviderStatus': rawStatus || newStatus || 'unknown',
        'value.operational.lastProviderHealth': mapConnectionHealth(rawStatus, newStatus),
        'value.operational.lastProviderReason': rawStatus ? 'webhook_connection_' + rawStatus : 'webhook_connection'
      };
      if (newStatus) {
        connectionSet['value.status'] = newStatus;
      }
      await Integration.findByIdAndUpdate(integration._id, { $set: connectionSet });
      winston.info('CaseZap connection event: integration ' + integration._id + ' status=' + newStatus);
      recordOperation({
        id_project: projectId,
        integrationId: integrationId,
        event: 'webhook.connection',
        status: 'success',
        latencyMs: Date.now() - startedAt,
        details: { connectionStatus: newStatus, providerStatus: rawStatus }
      });
      return res.status(200).json({ success: true });
    }

    if (body.EventType === 'messages_update') {
      recordOperation({
        id_project: projectId,
        integrationId: integrationId,
        event: 'webhook.skipped',
        status: 'skipped',
        latencyMs: Date.now() - startedAt,
        details: { reason: 'messages_update' }
      });
      return res.status(200).json({ success: true });
    }

    if (body.EventType === 'presence') {
      var typingForwarded = await emitPresenceTyping(integration, body);
      recordOperation({
        id_project: projectId,
        integrationId: integrationId,
        event: 'webhook.presence',
        status: 'success',
        latencyMs: Date.now() - startedAt,
        details: {
          chatid: body.chatid,
          presence: body.presence,
          lastSeen: body.lastSeen,
          typingForwarded: typingForwarded
        }
      });
      return res.status(200).json({ success: true });
    }

    if (body.EventType !== 'messages') {
      recordOperation({
        id_project: projectId,
        integrationId: integrationId,
        event: 'webhook.skipped',
        status: 'skipped',
        latencyMs: Date.now() - startedAt,
        details: { reason: 'unsupported_event_type', eventType: body.EventType }
      });
      return res.status(200).json({ success: true });
    }

    var mapped = messageMapper.mapInbound(body);
    if (!mapped) {
      recordOperation({
        id_project: projectId,
        integrationId: integrationId,
        event: 'webhook.skipped',
        status: 'skipped',
        latencyMs: Date.now() - startedAt,
        details: { reason: 'unmappable_message_type' }
      });
      return res.status(200).json({ success: true, skipped: 'unmappable message type' });
    }

    if (mapped.isGroup) {
      recordOperation({
        id_project: projectId,
        integrationId: integrationId,
        messageId: mapped.messageId,
        event: 'webhook.skipped',
        status: 'skipped',
        latencyMs: Date.now() - startedAt,
        details: { reason: 'group_message' }
      });
      return res.status(200).json({ success: true, skipped: 'group message' });
    }

    if (await checkAndMarkProcessed(mapped.messageId)) {
      recordOperation({
        id_project: projectId,
        integrationId: integrationId,
        messageId: mapped.messageId,
        event: 'webhook.skipped',
        status: 'skipped',
        latencyMs: Date.now() - startedAt,
        details: { reason: 'deduplicated' }
      });
      return res.status(200).json({ success: true, deduplicated: true });
    }

    if (await hasStoredCaseZapMessage(projectId, mapped.messageId)) {
      recordOperation({
        id_project: projectId,
        integrationId: integrationId,
        messageId: mapped.messageId,
        event: 'webhook.skipped',
        status: 'skipped',
        latencyMs: Date.now() - startedAt,
        details: { reason: 'stored_duplicate' }
      });
      return res.status(200).json({ success: true, deduplicated: true });
    }

    if (mapped.type === 'casezap_poll_update') {
      var updatedPollMessage = await applyPollUpdate(projectId, integration, mapped);
      recordOperation({
        id_project: projectId,
        integrationId: integrationId,
        messageId: mapped.messageId,
        event: updatedPollMessage ? 'webhook.poll_update' : 'webhook.skipped',
        status: updatedPollMessage ? 'success' : 'skipped',
        latencyMs: Date.now() - startedAt,
        details: {
          reason: updatedPollMessage ? undefined : 'poll_message_not_found',
          pollMessageId: mapped.metadata && mapped.metadata.pollUpdate && mapped.metadata.pollUpdate.pollMessageId,
          vote: mapped.metadata && mapped.metadata.pollUpdate && mapped.metadata.pollUpdate.vote
        }
      });
      return res.status(200).json({ success: true, pollUpdate: Boolean(updatedPollMessage) });
    }

    mapped = await resolveInboundMedia(integration, mapped);
    mapped = await mediaStorage.persistMappedMedia(mapped, integration);

    var integrationId = integration._id.toString();
    var leadId = 'casezap-' + integrationId + '-' + mapped.phone;
    var instanceLabel = (integration.value.instanceName || '') + ' (' + (integration.value.number || mapped.phone) + ')';

    var lead = await leadService.createIfNotExistsWithLeadId(
      leadId,
      mapped.fullname,
      null,
      projectId,
      leadId,
      null,
      null,
      mapped.phone
    );

    var existingRequest = await Request.findOne({
      id_project: projectId,
      'channel.name': ChannelConstants.CASEZAP,
      $or: [{ integrationId: integration._id }, { integrationId: { $exists: false } }],
      lead: lead._id,
      status: { $lt: 1000 }
    }).sort({ createdAt: -1 });

    var requestId;
    var newRequest;
    if (existingRequest) {
      requestId = existingRequest.request_id;
    } else {
      requestId = 'support-group-' + projectId + '-' + uuidv4();
      var boundDept = await departmentService.getDepartmentByChannelBinding(projectId, ChannelConstants.CASEZAP, [
        integration._id,
        integration.value && integration.value.number
      ]);
      var defaultDept = boundDept || await Department.findOne({ id_project: projectId, default: true });
      newRequest = {
        request_id: requestId,
        id_project: projectId,
        lead_id: lead._id,
        lead: lead,
        first_text: messageMapper.stripQuoteMarker(mapped.text) || '',
        departmentid: defaultDept ? defaultDept._id : undefined,
        integrationId: integration._id,
        channel: { name: ChannelConstants.CASEZAP },
        skipDepartmentBot: shouldSkipCaseZapDepartmentBot(boundDept),
        createdBy: leadId,
        attributes: {
          casezapPhone: mapped.phone,
          instanceLabel: instanceLabel
        }
      };
      await requestService.create(newRequest);
    }

    var sender = leadId;
    var createdBy = leadId;
    var senderFullname = mapped.fullname || mapped.phone;
    var messageAttributes = { casezapMessageId: mapped.messageId };
    if (mapped.quote) {
      messageAttributes.casezapQuote = mapped.quote;
    }
    if (mapped.fromMe) {
      var fromMeSender = await resolveExternalFromMeSender(integration, existingRequest || newRequest);
      sender = fromMeSender.sender;
      createdBy = fromMeSender.sender;
      senderFullname = fromMeSender.fullname;
      messageAttributes.casezapFromMe = true;
      messageAttributes.casezapExternalFromMe = true;
    }

    var messageContext = {
      integrationId: integrationId,
      messageId: mapped.messageId
    };

    if (!existingRequest) {
      await ensureCaseZapChat21Group(requestId, projectId, messageContext);
    }

    var savedMessage = await messageService.send(
      sender,
      senderFullname,
      requestId,
      mapped.text,
      projectId,
      createdBy,
      messageAttributes,
      mapped.type,
      mapped.metadata,
      null
    );

    await syncCaseZapChat21TranscriptMessage(requestId, projectId, savedMessage, existingRequest || newRequest, messageContext);
    await syncCaseZapChat21LastMessage(requestId, projectId, savedMessage, messageContext);
    await syncCaseZapRequestLastMessage(requestId, projectId, savedMessage, messageContext);

    recordOperation({
      id_project: projectId,
      integrationId: integrationId,
      requestId: requestId,
      messageId: mapped.messageId,
      event: 'webhook.processed',
      status: 'success',
      latencyMs: Date.now() - startedAt,
      details: { messageType: mapped.type, fromMe: Boolean(mapped.fromMe) }
    });

    res.status(200).json({ success: true });

  } catch (err) {
    winston.error('CaseZap webhook error for integration ' + integration._id, err);
    recordOperation({
      level: 'error',
      id_project: projectId,
      integrationId: integrationId,
      event: 'webhook.failed',
      status: 'failed',
      latencyMs: Date.now() - startedAt,
      error: err
    });
    res.status(500).json({ error: 'Internal error' });
  }
}

router.post('/webhook/:integration_id', async function(req, res) {
  if (!casezapEnabled) {
    return res.status(503).json({ error: 'CaseZap module disabled' });
  }
  var integrationId = req.params.integration_id;
  var secret = REDACTED_SECRET;

  if (!integrationId || !integrationId.match(/^[0-9a-fA-F]{24}$/)) {
    return res.status(400).json({ error: 'Invalid integration ID' });
  }

  try {
    var integration = await Integration.findById(integrationId);
    if (!integration || !integration.value || integration.value.webhookSecret !== secret) {
      winston.warn('CaseZap webhook: invalid secret for integration ' + integrationId);
      recordOperation({
        level: 'warn',
        integrationId: integrationId,
        event: 'webhook.failed',
        status: 'failed',
        errorCode: 'invalid_secret',
        errorMessage: 'Invalid webhook secret'
      });
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
    await handleWebhook(integration, req, res);
  } catch (err) {
    winston.error('CaseZap webhook error', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/webhook/project/:project_id', async function(req, res) {
  if (!casezapEnabled) {
    return res.status(503).json({ error: 'CaseZap module disabled' });
  }
  var projectId = req.params.project_id;
  var secret = REDACTED_SECRET;

  winston.warn('CaseZap: legacy webhook route used for project ' + projectId);

  try {
    var integration = await Integration.findOne(buildLegacyWebhookIntegrationQuery(projectId, secret));
    if (!integration || !integration.value) {
      winston.warn('CaseZap webhook: invalid secret for project ' + projectId);
      recordOperation({
        level: 'warn',
        id_project: projectId,
        integrationId: integration ? integration._id.toString() : undefined,
        event: 'webhook.failed',
        status: 'failed',
        errorCode: 'invalid_secret',
        errorMessage: 'Invalid webhook secret'
      });
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
    await handleWebhook(integration, req, res);
  } catch (err) {
    winston.error('CaseZap legacy webhook error', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

async function sendToUazApi(domain, token, endpoint, body) {
  var url = domain.replace(/\/$/, '') + endpoint;
  try {
    var response = await axios.post(url, body, {
      headers: { 'token': token, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    return response.data;
  } catch (err) {
    if (err.response && err.response.status === 429) {
      winston.warn('CaseZap rate limited on ' + endpoint);
      return null;
    }
    throw err;
  }
}

function maskPhoneForLog(phone) {
  if (!phone) return '';
  return String(phone).replace(/\d(?=(?:\D*\d){4})/g, '*');
}

function describeProviderError(err) {
  if (!err) return 'unknown error';
  var parts = [];
  if (err.response && err.response.status) parts.push('status=' + err.response.status);
  if (err.code) parts.push('code=' + err.code);
  var message = operationalLogger.extractErrorMessage(err) || err.message;
  if (message) parts.push('message=' + message);
  return parts.join(' ') || 'unknown error';
}

function shouldDownloadInboundMedia(mapped) {
  return mapped &&
    mapped.downloadId &&
    mapped.metadata &&
    !mapped.metadata.src &&
    (mapped.type === 'image' || mapped.type === 'frame' || mapped.type === 'file');
}

async function resolveInboundMedia(integration, mapped) {
  if (!shouldDownloadInboundMedia(mapped)) {
    return mapped;
  }

  try {
    var downloaded = await sendToUazApi(
      integration.value.domain,
      integration.value.token,
      '/message/download',
      { id: mapped.downloadId, return_link: true, return_base64: false }
    );

    if (!downloaded || !downloaded.fileURL) {
      winston.warn('CaseZap media download returned no fileURL for message ' + mapped.messageId);
      return mapped;
    }

    mapped.metadata.src = downloaded.fileURL;
    if (downloaded.mimetype && mapped.type !== 'image') {
      mapped.metadata.type = downloaded.mimetype;
    }
    if (mapped.type === 'file' && mapped.metadata.name) {
      mapped.text = '[' + mapped.metadata.name + '](' + downloaded.fileURL + ')';
      mapped.text = messageMapper.applyQuoteMarker(mapped.text, mapped.quote);
    }
  } catch (err) {
    winston.warn('CaseZap media download failed for message ' + mapped.messageId + ': ' + err.message);
  }

  return mapped;
}

async function sendOutboundMessage(message) {
  try {
    if (!message || !message.request) return;
    if (!message.request.channel || !message.request.channel.name) return;
    if (message.status !== MessageConstants.CHAT_MESSAGE_STATUS.SENDING) return;
    if (message.channel_type !== MessageConstants.CHANNEL_TYPE.GROUP) return;
    if (message.request.channel.name !== ChannelConstants.CASEZAP) return;

    var leadId = message.request.lead && message.request.lead.lead_id;
    if (message.sender === leadId) return;
    if (isInternalOutboundMessage(message)) return;

    var projectId = message.id_project;
    var reqIntegrationId = message.request.integrationId;
    var integration;
    if (reqIntegrationId) {
      integration = await Integration.findById(reqIntegrationId);
    } else {
      integration = await Integration.findOne({ id_project: projectId, name: 'casezap' });
    }
    if (!integration || !integration.value) {
      winston.warn('CaseZap integration not found for outbound');
      return;
    }

    if (integration.value.status === 'disconnected') {
      winston.warn('CaseZap instance disconnected: ' + integration._id);
      return;
    }

    var phone;
    if (reqIntegrationId) {
      phone = leadId.split('-').pop();
    } else {
      phone = leadId.replace('casezap-', '');
    }

    var outbound = messageMapper.mapOutbound(message, phone);

    try {
      await sendToUazApi(integration.value.domain, integration.value.token, outbound.endpoint, outbound.body);
      winston.debug('CaseZap sent to ' + phone + ' via ' + outbound.endpoint);
    } catch (firstErr) {
      winston.warn('CaseZap send failed, retrying: ' + describeProviderError(firstErr));
      await new Promise(function(resolve) { setTimeout(resolve, 2000); });
      try {
        await sendToUazApi(integration.value.domain, integration.value.token, outbound.endpoint, outbound.body);
      } catch (retryErr) {
        winston.error('CaseZap send failed after retry to ' + maskPhoneForLog(phone) + ': ' + describeProviderError(retryErr));
      }
    }

  } catch (err) {
    winston.error('CaseZap outbound error: ' + describeProviderError(err));
  }
}

function isInternalOutboundMessage(message) {
  if (!message) return true;
  var attributes = message.attributes || {};
  var subtype = attributes.subtype ? String(attributes.subtype) : '';

  if (message.sender === 'system' || message.createdBy === 'system') return true;
  if (subtype === 'info' || subtype.indexOf('info/') === 0) return true;
  if (attributes.casezapExternalFromMe) return true;

  return false;
}

function setupOutboundListener() {
  messageEvent.on('message.sending', function(message) {
    sendOutboundMessage(message);
  });
  winston.info('CaseZap outbound listener registered');
}

async function registerWebhook(integration, baseUrl) {
  var domain = integration.value.domain;
  var token = integration.value.token;
  var webhookSecret = REDACTED_SECRET || uuidv4();
  var webhookUrl = baseUrl + '/modules/casezap/webhook/' + integration._id + '?secret=' + webhookSecret;

  var body = {
    url: webhookUrl,
    enabled: true,
    events: ['messages', 'messages_update', 'connection', 'presence'],
    excludeMessages: ['wasSentByApi', 'isGroupYes']
  };

  try {
    await axios.post(domain.replace(/\/$/, '') + '/webhook', body, {
      headers: { 'token': token, 'Content-Type': 'application/json' },
      timeout: 10000
    });

    await Integration.findByIdAndUpdate(integration._id, {
      $set: buildRegisterWebhookUpdate(integration, webhookSecret)
    });

    casezapProjects.set(integration._id.toString(), {
      projectId: integration.id_project,
      domain: domain,
      token: token
    });

    winston.info('CaseZap webhook registered for integration ' + integration._id);
    return { success: true, webhookSecret: webhookSecret };
  } catch (err) {
    var status = err.response && err.response.status;
    if (status === 401) {
      throw new Error('Token de instancia invalido');
    } else if (status === 429) {
      throw new Error('Instancia UazApi indisponivel');
    } else {
      throw new Error('Nao foi possivel conectar ao dominio da API: ' + (err.message || ''));
    }
  }
}

function buildRegisterWebhookUpdate(integration, webhookSecret) {
  var update = { 'value.webhookSecret': webhookSecret };
  if (!integration || !integration.value || !integration.value.status) {
    update['value.status'] = 'pending';
  }
  return update;
}

async function cleanupWebhook(integrationId, domain, token, baseUrl) {
  var webhookUrl = baseUrl + '/modules/casezap/webhook/' + integrationId;
  try {
    await axios.post(domain.replace(/\/$/, '') + '/webhook', {
      action: 'delete',
      url: webhookUrl
    }, {
      headers: { 'token': token, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    winston.info('CaseZap webhook cleaned up for integration ' + integrationId);
  } catch (err) {
    winston.warn('CaseZap webhook cleanup failed: ' + err.message);
  }
}

async function loadExistingProjects() {
  try {
    var integrations = await Integration.find({ name: 'casezap' });
    integrations.forEach(function(i) {
      if (i.value && i.value.domain && i.value.token) {
        casezapProjects.set(i._id.toString(), {
          projectId: i.id_project,
          domain: i.value.domain,
          token: i.value.token
        });
      }
    });
    winston.info('CaseZap loaded ' + casezapProjects.size + ' existing instances');
  } catch (err) {
    winston.warn('CaseZap failed to load existing instances: ' + err.message);
  }
}

function setupIntegrationListener(baseUrl) {
  loadExistingProjects();
  integrationEvent.on('integration.update', function(integrations, projectId) {
    var czInstances = integrations.filter(function(i) { return i.name === 'casezap'; });
    var currentIds = new Set(czInstances.map(function(i) { return i._id.toString(); }));

    for (var [intId, data] of casezapProjects) {
      if (data.projectId === projectId && !currentIds.has(intId)) {
        cleanupWebhook(intId, data.domain, data.token, baseUrl);
        casezapProjects.delete(intId);
      }
    }

    czInstances.forEach(function(i) {
      if (i.value) {
        casezapProjects.set(i._id.toString(), {
          projectId: projectId,
          domain: i.value.domain,
          token: i.value.token
        });
      }
    });
  });
  winston.info('CaseZap integration listener registered');
}

router.post('/register/:integration_id', [passport.authenticate(['basic', 'jwt'], { session: false }), validtoken], async function(req, res) {
  var integrationId = req.params.integration_id;
  if (!integrationId || !integrationId.match(/^[0-9a-fA-F]{24}$/)) {
    return res.status(400).json({ error: 'Invalid integration ID' });
  }
  var externalUrl = process.env.EXTERNAL_BASE_URL || (req.protocol + '://' + req.get('host'));
  var baseUrl = externalUrl.replace(/\/+$/, '') + '/api';

  try {
    var integration = await Integration.findById(integrationId);
    if (!integration || !integration.value) {
      return res.status(404).json({ error: 'CaseZap integration not found' });
    }

    var Project_user = require('../../models/project_user');
    var pu = await Project_user.findOne({ id_project: integration.id_project, id_user: req.user._id, status: 'active' });
    if (!pu) {
      return res.status(403).json({ error: 'You do not have access to this project' });
    }

    var result = await registerWebhook(integration, baseUrl);
    res.status(200).json(result);
  } catch (err) {
    winston.error('CaseZap register webhook error', err);
    res.status(502).json({ error: err.message });
  }
});

module.exports = {
  router: router,
  setupOutboundListener: setupOutboundListener,
  setupIntegrationListener: setupIntegrationListener,
  registerWebhook: registerWebhook,
  buildRegisterWebhookUpdate: buildRegisterWebhookUpdate,
  ensureCaseZapChat21Group: ensureCaseZapChat21Group,
  syncCaseZapChat21TranscriptMessage: syncCaseZapChat21TranscriptMessage,
  syncCaseZapChat21LastMessage: syncCaseZapChat21LastMessage,
  syncCaseZapRequestLastMessage: syncCaseZapRequestLastMessage,
  isInternalOutboundMessage: isInternalOutboundMessage,
  isTypingPresence: isTypingPresence,
  shouldSkipCaseZapDepartmentBot: shouldSkipCaseZapDepartmentBot,
  buildLegacyWebhookIntegrationQuery: buildLegacyWebhookIntegrationQuery,
  extractConnectionStatus: extractConnectionStatus,
  extractWebhookReceipt: extractWebhookReceipt,
  hasStoredCaseZapMessage: hasStoredCaseZapMessage,
  mapConnectionHealth: mapConnectionHealth,
  mapConnectionStatus: mapConnectionStatus,
  setRedisClient: setRedisClient,
  casezapProjects: casezapProjects
};
