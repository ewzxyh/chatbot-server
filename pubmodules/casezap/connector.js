var express = require('express');
var router = express.Router();
var winston = require('../../config/winston');
var axios = require('axios');
var LRU = require('lru-cache');
var { v4: uuidv4 } = require('uuid');
var passport = require('passport');
var validtoken = require('../../middleware/valid-token');
var messageMapper = require('./messageMapper');
var Integration = require('../../models/integrations');
var ChannelConstants = require('../../models/channelConstants');
var MessageConstants = require('../../models/messageConstants');
var Request = require('../../models/request');
var Department = require('../../models/department');
var leadService = require('../../services/leadService');
var requestService = require('../../services/requestService');
var messageService = require('../../services/messageService');
var messageEvent = require('../../event/messageEvent');
var integrationEvent = require('../../event/integrationEvent');

var processedMessages = new LRU({ max: 10000, maxAge: 1000 * 60 * 60 });
var casezapProjects = new Map();
var casezapEnabled = process.env.CASEZAP_ENABLED !== 'false';

async function handleWebhook(integration, req, res) {
  var projectId = integration.id_project;

  try {
    var body = req.body;
    if (!body || !body.EventType) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    if (body.EventType === 'connection') {
      var newStatus = (body.data && body.data.state === 'open') ? 'active' : 'disconnected';
      await Integration.findByIdAndUpdate(integration._id, { $set: { 'value.status': newStatus } });
      winston.info('CaseZap connection event: integration ' + integration._id + ' status=' + newStatus);
      return res.status(200).json({ success: true });
    }

    if (body.EventType === 'messages_update') {
      return res.status(200).json({ success: true });
    }

    if (body.EventType !== 'messages') {
      return res.status(200).json({ success: true });
    }

    var mapped = messageMapper.mapInbound(body);
    if (!mapped) {
      return res.status(200).json({ success: true, skipped: 'unmappable message type' });
    }

    if (mapped.fromMe) {
      return res.status(200).json({ success: true, skipped: 'fromMe' });
    }
    if (mapped.isGroup) {
      return res.status(200).json({ success: true, skipped: 'group message' });
    }

    if (processedMessages.has(mapped.messageId)) {
      return res.status(200).json({ success: true, deduplicated: true });
    }
    processedMessages.set(mapped.messageId, true);

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
    if (existingRequest) {
      requestId = existingRequest.request_id;
    } else {
      requestId = 'support-group-' + projectId + '-' + uuidv4();
      var defaultDept = await Department.findOne({ id_project: projectId, default: true });
      var newRequest = {
        request_id: requestId,
        id_project: projectId,
        lead_id: lead._id,
        lead: lead,
        first_text: mapped.text || '',
        departmentid: defaultDept ? defaultDept._id : undefined,
        integrationId: integration._id,
        channel: { name: ChannelConstants.CASEZAP },
        createdBy: leadId,
        attributes: {
          casezapPhone: mapped.phone,
          instanceLabel: instanceLabel
        }
      };
      await requestService.create(newRequest);
    }

    var senderFullname = mapped.fullname || mapped.phone;
    await messageService.send(
      leadId,
      senderFullname,
      requestId,
      mapped.text,
      projectId,
      leadId,
      { casezapMessageId: mapped.messageId },
      mapped.type,
      mapped.metadata,
      null
    );

    res.status(200).json({ success: true });

  } catch (err) {
    winston.error('CaseZap webhook error for integration ' + integration._id, err);
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
    var integration = await Integration.findOne({ id_project: projectId, name: 'casezap' });
    if (!integration || !integration.value || integration.value.webhookSecret !== secret) {
      winston.warn('CaseZap webhook: invalid secret for project ' + projectId);
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

async function sendOutboundMessage(message) {
  try {
    if (!message || !message.request) return;
    if (!message.request.channel || !message.request.channel.name) return;
    if (message.status !== MessageConstants.CHAT_MESSAGE_STATUS.SENDING) return;
    if (message.channel_type !== MessageConstants.CHANNEL_TYPE.GROUP) return;
    if (message.request.channel.name !== ChannelConstants.CASEZAP) return;

    var leadId = message.request.lead && message.request.lead.lead_id;
    if (message.sender === leadId) return;

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
      winston.warn('CaseZap send failed, retrying: ' + firstErr.message);
      await new Promise(function(resolve) { setTimeout(resolve, 2000); });
      try {
        await sendToUazApi(integration.value.domain, integration.value.token, outbound.endpoint, outbound.body);
      } catch (retryErr) {
        winston.error('CaseZap send failed after retry to ' + phone, retryErr);
      }
    }

  } catch (err) {
    winston.error('CaseZap outbound error', err);
  }
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
    events: ['messages', 'messages_update', 'connection'],
    excludeMessages: ['wasSentByApi', 'isGroupYes']
  };

  try {
    await axios.post(domain.replace(/\/$/, '') + '/webhook', body, {
      headers: { 'token': token, 'Content-Type': 'application/json' },
      timeout: 10000
    });

    await Integration.findByIdAndUpdate(integration._id, {
      $set: { 'value.webhookSecret': webhookSecret, 'value.status': 'active' }
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
  processedMessages: processedMessages,
  casezapProjects: casezapProjects
};
