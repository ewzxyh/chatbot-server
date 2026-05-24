var axios = require('axios');
var mongoose = require('mongoose');
var Integration = require('../models/integrations');
var FaqKb = require('../models/faq_kb');
var { Transaction } = require('../models/transaction');
var { MessageLog } = require('../models/whatsappLog');
var chatcaseTemplates = require('../pubmodules/chatbotTemplates/chatcaseTemplates');
var operationalLogger = require('./operationalLogger');

var DEFAULT_TIMEOUT_MS = parseInt(
  process.env.WABA_TEMPLATE_PUBLICATION_TIMEOUT_MS ||
  process.env.OPERATIONAL_PROVIDER_CHECK_TIMEOUT_MS ||
  '30000',
  10
);
var META_GRAPH_URL = process.env.META_GRAPH_URL || process.env.GRAPH_URL || 'https://graph.facebook.com/v25.0/';
if (isNaN(DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS < 1000) DEFAULT_TIMEOUT_MS = 30000;

function ensureTrailingSlash(url) {
  if (!url) return url;
  return url.charAt(url.length - 1) === '/' ? url : url + '/';
}

function graphUrl() {
  var url = process.env.META_GRAPH_URL || process.env.GRAPH_URL || META_GRAPH_URL;
  return ensureTrailingSlash(url);
}

function normalizeTemplateName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function variableIndexes(text) {
  var indexes = [];
  var regex = /\{\{(\d+)\}\}/g;
  var match;
  while ((match = regex.exec(String(text || ''))) !== null) {
    var index = parseInt(match[1], 10);
    if (!isNaN(index) && indexes.indexOf(index) === -1) {
      indexes.push(index);
    }
  }
  return indexes.sort(function(a, b) { return a - b; });
}

function sampleValuesForSuggestion(suggestion, indexes) {
  var variables = Array.isArray(suggestion.variables) ? suggestion.variables : [];
  return indexes.map(function(index, position) {
    var name = variables[position] || variables[index - 1] || 'valor';
    if (/nome|name/i.test(name)) return 'Cliente';
    if (/pedido|order/i.test(name)) return '12345';
    if (/data|date/i.test(name)) return '25/05/2026';
    return 'Exemplo';
  });
}

function buildMetaTemplatePayload(suggestion) {
  if (!suggestion) {
    var missing = new Error('missing_waba_template_suggestion');
    missing.statusCode = 400;
    throw missing;
  }

  var name = normalizeTemplateName(suggestion.name);
  var body = String(suggestion.body || '').trim();
  var category = String(suggestion.category || 'UTILITY').toUpperCase();
  var language = suggestion.language || 'pt_BR';

  if (!name) {
    var invalidName = new Error('invalid_waba_template_name');
    invalidName.statusCode = 400;
    throw invalidName;
  }

  if (!body) {
    var invalidBody = new Error('invalid_waba_template_body');
    invalidBody.statusCode = 400;
    throw invalidBody;
  }

  var bodyComponent = {
    type: 'BODY',
    text: body
  };
  var indexes = variableIndexes(body);
  if (indexes.length) {
    bodyComponent.example = {
      body_text: [
        sampleValuesForSuggestion(suggestion, indexes)
      ]
    };
  }

  var components = [bodyComponent];
  var buttons = Array.isArray(suggestion.buttons) ? suggestion.buttons.filter(Boolean).slice(0, 3) : [];
  if (buttons.length) {
    components.push({
      type: 'BUTTONS',
      buttons: buttons.map(function(button) {
        return {
          type: 'QUICK_REPLY',
          text: String(button).substring(0, 25)
        };
      })
    });
  }

  return {
    name: name,
    language: language,
    category: category,
    components: components
  };
}

function templateById(templateId) {
  var template = chatcaseTemplates.getTemplateById(templateId);
  if (!template) {
    var missing = new Error('template_not_found');
    missing.statusCode = 404;
    throw missing;
  }
  return template;
}

function getSuggestion(template, suggestionName) {
  var publication = template.attributes && template.attributes.publication;
  var suggestions = publication && Array.isArray(publication.wabaTemplates) ? publication.wabaTemplates : [];
  var suggestion = suggestions.find(function(item) {
    return !suggestionName || item.name === suggestionName;
  });

  if (!suggestion) {
    var missing = new Error('waba_template_suggestion_not_found');
    missing.statusCode = 404;
    throw missing;
  }

  return suggestion;
}

async function findWabaIntegration(projectId, integrationId, deps) {
  deps = deps || {};
  if (Object.prototype.hasOwnProperty.call(deps, 'integration')) return deps.integration;

  var query = {
    id_project: projectId,
    name: 'whatsapp'
  };
  if (integrationId) query._id = integrationId;

  return (deps.Integration || Integration)
    .findOne(query)
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean()
    .exec();
}

async function findWhatsappSettings(integration, deps, projectId) {
  deps = deps || {};
  if (Object.prototype.hasOwnProperty.call(deps, 'settings')) return deps.settings;

  var value = integration && integration.value || {};
  var collection = (deps.mongooseConnection || mongoose.connection).collection('kvstore');
  var clauses = [];

  if (value.waba_id) clauses.push({ key: 'whatsapp-' + value.waba_id });
  if (value.phone_number_id) clauses.push({ 'value.phone_number_id': value.phone_number_id });
  if (value.waba_id) clauses.push({ 'value.waba_id': value.waba_id });
  if (integration && integration.id_project) clauses.push({ key: 'whatsapp-' + integration.id_project });
  if (integration && integration.id_project) clauses.push({ project_id: integration.id_project });
  if (projectId) clauses.push({ key: 'whatsapp-' + projectId });
  if (projectId) clauses.push({ project_id: String(projectId), key: /^whatsapp-/ });
  if (projectId) clauses.push({ project_id: String(projectId), 'value.waba_id': { $exists: true } });

  if (!clauses.length) return null;
  return collection.findOne({ $or: clauses });
}

function getCredentials(integration, settings) {
  var integrationValue = integration && integration.value ? integration.value : {};
  var settingsValue = settings && settings.value ? settings.value : (settings || {});
  return {
    token: settingsValue.wab_token || settingsValue.access_token || integrationValue.wab_token || integrationValue.access_token || null,
    wabaId: settingsValue.waba_id || integrationValue.waba_id || null,
    phoneNumberId: settingsValue.phone_number_id || integrationValue.phone_number_id || null,
    businessAccountId: settingsValue.business_account_id || settingsValue.waba_id || integrationValue.business_account_id || integrationValue.waba_id || null
  };
}

function redactedEndpoint(wabaId) {
  return graphUrl() + (wabaId || '{waba-id}') + '/message_templates';
}

function publicationResponse(template, suggestion, payload, integration, credentials, extra) {
  extra = extra || {};
  var publication = template.attributes && template.attributes.publication || {};
  return Object.assign({
    templateId: template._id,
    templateName: template.name,
    dryRun: true,
    canPublish: !!(credentials && credentials.token && credentials.wabaId),
    channel: 'waba',
    waba: {
      integrationId: integration && integration._id ? String(integration._id) : null,
      wabaId: credentials && credentials.wabaId ? String(credentials.wabaId) : null,
      configured: !!(credentials && credentials.token && credentials.wabaId)
    },
    wabaTemplate: suggestion,
    metaEndpoint: redactedEndpoint(credentials && credentials.wabaId),
    metaPayload: payload,
    checklist: publication.checklist || []
  }, extra);
}

function normalizeMetaStatus(status) {
  var normalized = String(status || '').trim().toUpperCase();
  if (normalized === 'APPROVED') return 'approved';
  if (normalized === 'PENDING' || normalized === 'IN_REVIEW' || normalized === 'PAUSED') return 'pending';
  if (normalized === 'REJECTED' || normalized === 'DISABLED' || normalized === 'DELETED') return 'rejected';
  return normalized ? normalized.toLowerCase() : 'unknown';
}

function templateSyncState(metaTemplate) {
  if (!metaTemplate) return 'not_found';
  return normalizeMetaStatus(metaTemplate.status);
}

function findMatchingMetaTemplate(metaTemplates, suggestion) {
  var expectedName = normalizeTemplateName(suggestion.name);
  var expectedLanguage = String(suggestion.language || 'pt_BR').toLowerCase();

  return (metaTemplates || []).find(function(item) {
    return normalizeTemplateName(item.name) === expectedName &&
      String(item.language || '').toLowerCase() === expectedLanguage;
  }) || (metaTemplates || []).find(function(item) {
    return normalizeTemplateName(item.name) === expectedName;
  }) || null;
}

async function fetchMetaTemplates(credentials, deps) {
  var httpClient = deps.httpClient || axios;
  var url = graphUrl() + credentials.wabaId + '/message_templates';
  var templates = [];
  var pageUrl = url;
  var page = 0;

  while (pageUrl && page < 10) {
    var response = await httpClient.get(pageUrl, {
      headers: {
        Authorization: 'Bearer ' + credentials.token
      },
      params: page === 0 ? {
        fields: 'id,name,status,category,language,quality_score,rejected_reason,components',
        limit: 200
      } : undefined,
      timeout: DEFAULT_TIMEOUT_MS
    });

    templates = templates.concat(response.data && response.data.data || []);
    pageUrl = response.data && response.data.paging && response.data.paging.next;
    page += 1;
  }

  return templates;
}

function buildSyncResponse(template, suggestions, integration, credentials, metaTemplates, extra) {
  extra = extra || {};
  var items = suggestions.map(function(suggestion) {
    var metaTemplate = findMatchingMetaTemplate(metaTemplates, suggestion);
    return {
      name: suggestion.name,
      language: suggestion.language || 'pt_BR',
      category: suggestion.category || 'UTILITY',
      expectedBody: suggestion.body,
      expectedButtons: suggestion.buttons || [],
      state: templateSyncState(metaTemplate),
      found: !!metaTemplate,
      meta: metaTemplate ? {
        id: metaTemplate.id,
        name: metaTemplate.name,
        language: metaTemplate.language,
        category: metaTemplate.category,
        status: metaTemplate.status,
        qualityScore: metaTemplate.quality_score,
        rejectedReason: metaTemplate.rejected_reason
      } : null
    };
  });

  var summary = items.reduce(function(acc, item) {
    if (item.state === 'approved') acc.approved += 1;
    else if (item.state === 'pending') acc.pending += 1;
    else if (item.state === 'rejected') acc.rejected += 1;
    else if (item.state === 'not_found') acc.notFound += 1;
    else acc.unknown += 1;
    return acc;
  }, { approved: 0, pending: 0, rejected: 0, notFound: 0, unknown: 0 });

  return Object.assign({
    templateId: template._id,
    templateName: template.name,
    channel: 'waba',
    canSync: !!(credentials && credentials.token && credentials.wabaId),
    syncedAt: new Date().toISOString(),
    waba: {
      integrationId: integration && integration._id ? String(integration._id) : null,
      wabaId: credentials && credentials.wabaId ? String(credentials.wabaId) : null,
      configured: !!(credentials && credentials.token && credentials.wabaId)
    },
    templates: items,
    summary: summary
  }, extra);
}

function pickApprovedTemplate(syncResult, suggestionName) {
  var items = syncResult && Array.isArray(syncResult.templates) ? syncResult.templates : [];
  return items.find(function(item) {
    return item.state === 'approved' && (!suggestionName || item.name === suggestionName);
  }) || null;
}

function buildWabaTemplateBinding(template, approvedTemplate, integration, credentials) {
  var meta = approvedTemplate && approvedTemplate.meta || {};
  return {
    channel: 'waba',
    provider: 'meta',
    templateId: String(template._id),
    templateName: template.name,
    suggestionName: approvedTemplate.name,
    providerTemplateId: meta.id || null,
    providerTemplateName: meta.name || approvedTemplate.name,
    language: approvedTemplate.language || meta.language || 'pt_BR',
    category: approvedTemplate.category || meta.category || 'UTILITY',
    status: meta.status || 'APPROVED',
    state: approvedTemplate.state,
    wabaId: credentials && credentials.wabaId ? String(credentials.wabaId) : null,
    integrationId: integration && integration._id ? String(integration._id) : null,
    boundAt: new Date().toISOString()
  };
}

function cloneAttributes(attributes) {
  if (!attributes) return {};
  return JSON.parse(JSON.stringify(attributes));
}

function mergeWabaTemplateBinding(attributes, binding) {
  var nextAttributes = cloneAttributes(attributes);
  nextAttributes.publication = nextAttributes.publication || {};

  var bindings = Array.isArray(nextAttributes.publication.wabaTemplateBindings)
    ? nextAttributes.publication.wabaTemplateBindings.slice()
    : [];
  var bindingKey = [
    binding.channel,
    binding.provider,
    binding.wabaId || '',
    binding.suggestionName,
    binding.language
  ].join(':');

  var found = false;
  bindings = bindings.map(function(item) {
    var currentKey = [
      item.channel,
      item.provider,
      item.wabaId || '',
      item.suggestionName,
      item.language
    ].join(':');

    if (currentKey === bindingKey) {
      found = true;
      return binding;
    }
    return item;
  });

  if (!found) bindings.push(binding);
  nextAttributes.publication.wabaTemplateBinding = binding;
  nextAttributes.publication.wabaTemplateBindings = bindings;
  return nextAttributes;
}

function isApprovedBinding(binding) {
  if (!binding) return false;
  return String(binding.state || binding.status || '').toLowerCase() === 'approved';
}

function wabaTemplateBindingsFromAttributes(attributes) {
  var publication = attributes && attributes.publication || {};
  var bindings = [];

  if (publication.wabaTemplateBinding) {
    bindings.push(publication.wabaTemplateBinding);
  }

  if (Array.isArray(publication.wabaTemplateBindings)) {
    publication.wabaTemplateBindings.forEach(function(binding) {
      var exists = bindings.some(function(item) {
        return JSON.stringify(item) === JSON.stringify(binding);
      });
      if (!exists) bindings.push(binding);
    });
  }

  return bindings;
}

function bindingMatchesOptions(binding, options) {
  options = options || {};
  if (!binding) return false;
  if (options.integrationId && String(binding.integrationId || '') !== String(options.integrationId)) return false;
  if (options.wabaId && String(binding.wabaId || '') !== String(options.wabaId)) return false;
  if (options.suggestionName && String(binding.suggestionName || '') !== String(options.suggestionName)) return false;
  if (options.language && String(binding.language || '') !== String(options.language)) return false;
  return true;
}

function pickBoundWabaTemplate(attributes, options) {
  var bindings = wabaTemplateBindingsFromAttributes(attributes)
    .filter(isApprovedBinding);

  if (!bindings.length) return null;

  return bindings.find(function(binding) {
    return bindingMatchesOptions(binding, options);
  }) || bindings[0];
}

function normalizeTemplateParameter(value) {
  if (value && typeof value === 'object' && value.type) {
    return value;
  }

  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'text')) {
    return {
      type: 'text',
      text: String(value.text)
    };
  }

  return {
    type: 'text',
    text: String(value == null ? '' : value)
  };
}

function normalizeTemplateParameters(value) {
  if (value == null) return null;
  var values = Array.isArray(value) ? value : [value];
  if (!values.length) return null;
  return values.map(normalizeTemplateParameter);
}

function suggestionForBinding(binding) {
  if (!binding || !binding.templateId) return null;
  var template = chatcaseTemplates.getTemplateById(binding.templateId);
  if (!template) return null;
  var publication = template.attributes && template.attributes.publication;
  var suggestions = publication && Array.isArray(publication.wabaTemplates) ? publication.wabaTemplates : [];
  return suggestions.find(function(item) {
    return item.name === binding.suggestionName;
  }) || null;
}

function valueForTemplateVariable(options, index, position) {
  options = options || {};

  if (Array.isArray(options.templateValues) && options.templateValues[position] != null) {
    return options.templateValues[position];
  }

  if (options.templateValues && typeof options.templateValues === 'object') {
    if (options.templateValues[index] != null) return options.templateValues[index];
    if (options.templateValues[String(index)] != null) return options.templateValues[String(index)];
  }

  return options.recipientName || options.customerName || options.name || 'Cliente';
}

function buildBodyParamsFromSuggestion(suggestion, options) {
  if (!suggestion) return null;
  var indexes = variableIndexes(suggestion.body);
  if (!indexes.length) return null;

  return indexes.map(function(index, position) {
    return {
      type: 'text',
      text: String(valueForTemplateVariable(options, index, position))
    };
  });
}

function buildTemplateParams(binding, options) {
  options = options || {};
  var params = {};
  var suggestion = suggestionForBinding(binding);
  var header = normalizeTemplateParameters(options.headerParams);
  var body = normalizeTemplateParameters(options.bodyParams) || buildBodyParamsFromSuggestion(suggestion, options);
  var buttons = normalizeTemplateParameters(options.buttonParams || options.buttonsParams);

  if (header) params.header = header;
  if (body) params.body = body;
  if (buttons) params.buttons = buttons;

  return Object.keys(params).length ? params : undefined;
}

function buildBoundWabaTemplateAttachment(binding, options) {
  if (!isApprovedBinding(binding)) {
    var notApproved = new Error('waba_template_binding_not_approved');
    notApproved.statusCode = 409;
    throw notApproved;
  }

  var name = binding.providerTemplateName || binding.suggestionName;
  if (!name) {
    var invalid = new Error('waba_template_binding_missing_name');
    invalid.statusCode = 400;
    throw invalid;
  }

  var template = {
    name: name,
    language: binding.language || 'pt_BR'
  };
  var params = buildTemplateParams(binding, options);
  if (params) template.params = params;

  return {
    type: 'wa_template',
    template: template
  };
}

async function getBoundWabaTemplateForBot(options, deps) {
  options = options || {};
  deps = deps || {};

  if (!options.botId) {
    var missingBot = new Error('missing_bot_id');
    missingBot.statusCode = 400;
    throw missingBot;
  }

  var FaqKbModel = deps.FaqKb || FaqKb;
  var bot = await FaqKbModel.findOne({
    _id: options.botId,
    id_project: options.projectId
  }).lean().exec();

  if (!bot) {
    var missingTarget = new Error('bot_not_found');
    missingTarget.statusCode = 404;
    throw missingTarget;
  }

  var binding = pickBoundWabaTemplate(bot.attributes, options);
  if (!binding) {
    var missingBinding = new Error('waba_template_binding_not_found');
    missingBinding.statusCode = 404;
    throw missingBinding;
  }

  return {
    bot: bot,
    binding: binding
  };
}

async function buildBoundWabaTemplateMessage(options, deps) {
  options = options || {};
  deps = deps || {};

  var resolved = options.binding
    ? { bot: options.bot || null, binding: options.binding }
    : await getBoundWabaTemplateForBot(options, deps);
  var attachment = buildBoundWabaTemplateAttachment(resolved.binding, options);
  var message = {
    text: options.text || '',
    type: 'text',
    attributes: {
      attachment: attachment,
      wabaTemplateBinding: resolved.binding
    }
  };

  if (options.botId) {
    message.attributes.wabaTemplateBindingSource = {
      botId: String(options.botId)
    };
  }

  return {
    status: 'ready',
    botId: options.botId ? String(options.botId) : (resolved.bot && resolved.bot._id ? String(resolved.bot._id) : null),
    binding: resolved.binding,
    message: message
  };
}

function normalizeWhatsappRecipient(phoneNumber) {
  var normalized = String(phoneNumber || '').replace(/\D+/g, '');
  if (!normalized) {
    var missing = new Error('missing_recipient_phone_number');
    missing.statusCode = 400;
    throw missing;
  }
  if (normalized.length < 8) {
    var invalid = new Error('invalid_recipient_phone_number');
    invalid.statusCode = 400;
    throw invalid;
  }
  return normalized;
}

function normalizeDispatchRecipients(options) {
  options = options || {};
  var source = Array.isArray(options.recipients) && options.recipients.length
    ? options.recipients
    : [options];

  var recipients = source.map(function(item) {
    if (typeof item === 'string') {
      return {
        phoneNumber: normalizeWhatsappRecipient(item),
        recipientName: options.recipientName || options.customerName || options.name || 'Cliente'
      };
    }

    item = item || {};
    return {
      phoneNumber: normalizeWhatsappRecipient(item.phoneNumber || item.phone || item.to || item.whatsapp),
      recipientName: item.recipientName || item.customerName || item.name || options.recipientName || options.customerName || options.name || 'Cliente',
      templateValues: item.templateValues || options.templateValues,
      headerParams: item.headerParams || options.headerParams,
      bodyParams: item.bodyParams || options.bodyParams,
      buttonParams: item.buttonParams || options.buttonParams
    };
  });

  var limit = parseInt(process.env.WABA_TEMPLATE_DIRECT_DISPATCH_LIMIT || '50', 10);
  if (isNaN(limit) || limit < 1) limit = 50;
  if (recipients.length > limit) {
    var tooMany = new Error('too_many_recipients_for_direct_dispatch');
    tooMany.statusCode = 400;
    tooMany.limit = limit;
    throw tooMany;
  }

  return recipients;
}

function getApiUrl() {
  return process.env.API_URL || process.env.SERVER_BASE_URL || 'http://localhost:3000';
}

function extractProviderMessageId(response) {
  var data = response && response.data || {};
  var messages = Array.isArray(data.messages) ? data.messages : [];
  return messages[0] && (messages[0].id || messages[0].message_id) || data.message_id || null;
}

function extractProviderError(err) {
  return err && err.response && err.response.data ||
    err && err.data ||
    (err && err.message ? { message: err.message } : err);
}

async function saveDispatchTransaction(options, deps) {
  deps = deps || {};
  if (deps.persistLogs === false) return null;

  var TransactionModel = deps.Transaction || Transaction;
  if (!TransactionModel || !TransactionModel.findOneAndUpdate) return null;

  return TransactionModel.findOneAndUpdate(
    {
      id_project: options.projectId,
      transaction_id: options.transactionId
    },
    {
      $set: {
        id_project: options.projectId,
        transaction_id: options.transactionId,
        template_name: options.templateName,
        status: options.status,
        channel: 'whatsapp',
        updatedAt: new Date()
      },
      $setOnInsert: {
        createdAt: new Date()
      }
    },
    {
      new: true,
      upsert: true
    }
  ).lean().exec();
}

async function saveDispatchMessageLog(options, deps) {
  deps = deps || {};
  if (deps.persistLogs === false) return null;

  var MessageLogModel = deps.MessageLog || MessageLog;
  if (!MessageLogModel) return null;

  var log = new MessageLogModel({
    id_project: options.projectId,
    json_message: options.whatsappJsonMessage,
    transaction_id: options.transactionId,
    message_id: options.messageId,
    status: options.status,
    status_code: options.statusCode,
    error: options.error
  });

  return new Promise(function(resolve, reject) {
    log.save(function(err, savedLog) {
      if (err) return reject(err);
      resolve(savedLog);
    });
  });
}

async function recordDispatchLog(level, status, integration, details, deps) {
  deps = deps || {};
  if (deps.operationalLogger === null || deps.operationalLogger === false) return;
  var logger = deps.operationalLogger || operationalLogger;
  if (!logger || !logger.recordSafe) return;

  logger.recordSafe({
    level: level,
    area: 'waba_template',
    channel: 'waba',
    id_project: integration && integration.id_project,
    integrationId: integration && integration._id ? String(integration._id) : null,
    event: 'waba_template.dispatch',
    status: status,
    details: details
  });
}

function createWhatsappTranslator() {
  var TiledeskWhatsappTranslator = require('../pubmodules/whatsapp/connector/tiledesk/TiledeskWhatsappTranslator').TiledeskWhatsappTranslator;
  return new TiledeskWhatsappTranslator();
}

function createWhatsappClient(credentials) {
  var TiledeskWhatsapp = require('../pubmodules/whatsapp/connector/tiledesk/TiledeskWhatsapp').TiledeskWhatsapp;
  return new TiledeskWhatsapp({
    token: credentials.token,
    GRAPH_URL: graphUrl(),
    API_URL: getApiUrl()
  });
}

async function dispatchBoundWabaTemplate(options, deps) {
  options = options || {};
  deps = deps || {};

  var recipients = normalizeDispatchRecipients(options);
  var dryRun = options.dryRun === true || options.dryRun === 'true';
  var resolved = await getBoundWabaTemplateForBot(options, deps);
  var integration = await findWabaIntegration(options.projectId, options.integrationId || resolved.binding.integrationId, deps);
  var settings = await findWhatsappSettings(integration, deps, options.projectId);
  var credentials = getCredentials(integration, settings);
  var transactionId = options.transactionId || ('waba-template-' + String(options.botId || 'bot') + '-' + Date.now());
  var templateName = resolved.binding.providerTemplateName || resolved.binding.suggestionName;

  if (!credentials.token || !credentials.phoneNumberId) {
    var missing = new Error(!credentials.phoneNumberId ? 'missing_waba_phone_number_id' : 'missing_waba_token');
    missing.statusCode = 400;
    throw missing;
  }

  var translator = deps.translator || createWhatsappTranslator();
  var whatsappClient = deps.whatsappClient || createWhatsappClient(credentials);

  var results = [];
  var sent = 0;
  var failed = 0;

  if (!dryRun) {
    await saveDispatchTransaction({
      projectId: options.projectId,
      transactionId: transactionId,
      templateName: templateName,
      status: 'pending'
    }, deps);
  }

  for (var i = 0; i < recipients.length; i += 1) {
    var recipient = recipients[i];
    var messageResult = await buildBoundWabaTemplateMessage(Object.assign({}, options, recipient, {
      binding: resolved.binding,
      bot: resolved.bot
    }), deps);
    var whatsappJsonMessage = await translator.toWhatsapp(messageResult.message, recipient.phoneNumber);

    if (!whatsappJsonMessage) {
      failed += 1;
      results.push({
        phoneNumber: recipient.phoneNumber,
        status: 'failed',
        error: 'waba_template_translation_failed'
      });
      continue;
    }

    if (dryRun) {
      results.push({
        phoneNumber: recipient.phoneNumber,
        status: 'ready',
        whatsappJsonMessage: whatsappJsonMessage
      });
      continue;
    }

    try {
      var startedAt = Date.now();
      var response = await whatsappClient.sendMessage(credentials.phoneNumberId, whatsappJsonMessage);
      var providerMessageId = extractProviderMessageId(response);
      sent += 1;
      await saveDispatchMessageLog({
        projectId: options.projectId,
        transactionId: transactionId,
        whatsappJsonMessage: whatsappJsonMessage,
        messageId: providerMessageId,
        status: 'accepted',
        statusCode: 0
      }, deps);
      results.push({
        phoneNumber: recipient.phoneNumber,
        status: 'accepted',
        messageId: providerMessageId,
        providerStatus: response && response.status,
        latencyMs: Date.now() - startedAt
      });
    } catch (err) {
      failed += 1;
      var errorMessage = operationalLogger.extractErrorMessage(err);
      await saveDispatchMessageLog({
        projectId: options.projectId,
        transactionId: transactionId,
        whatsappJsonMessage: whatsappJsonMessage,
        messageId: null,
        status: 'failed',
        statusCode: -2,
        error: errorMessage
      }, deps);
      results.push({
        phoneNumber: recipient.phoneNumber,
        status: 'failed',
        error: errorMessage,
        providerError: extractProviderError(err)
      });
    }
  }

  var status = dryRun
    ? 'ready'
    : (failed === 0 ? 'completed' : (sent > 0 ? 'partial_failed' : 'failed'));

  if (!dryRun) {
    await saveDispatchTransaction({
      projectId: options.projectId,
      transactionId: transactionId,
      templateName: templateName,
      status: status === 'completed' ? 'completed' : 'aborted'
    }, deps);
    await recordDispatchLog(status === 'completed' ? 'info' : 'error', status, integration, {
      botId: String(options.botId),
      templateName: templateName,
      transactionId: transactionId,
      recipients: recipients.length,
      sent: sent,
      failed: failed
    }, deps);
  }

  return {
    status: status,
    dryRun: dryRun,
    transactionId: transactionId,
    botId: String(options.botId),
    templateName: templateName,
    channel: 'waba',
    phoneNumberId: credentials.phoneNumberId,
    wabaId: credentials.wabaId,
    recipients: recipients.length,
    sent: sent,
    failed: failed,
    results: results
  };
}

async function updateIntegrationPublication(integration, status, details, deps) {
  deps = deps || {};
  if (deps.updateIntegration === false || !integration || !integration._id) return;

  var set = {
    'value.operational.lastWabaTemplatePublicationAt': new Date().toISOString(),
    'value.operational.lastWabaTemplatePublicationStatus': status,
    'value.operational.lastWabaTemplatePublicationError': details && details.error || null
  };

  if (details && details.templateName) {
    set['value.operational.lastWabaTemplateName'] = details.templateName;
  }
  if (details && details.providerTemplateId) {
    set['value.operational.lastWabaTemplateProviderId'] = details.providerTemplateId;
  }

  await (deps.Integration || Integration).findByIdAndUpdate(integration._id, { $set: set });
}

async function updateSettingsPublication(settings, status, details, deps) {
  deps = deps || {};
  if (deps.updateIntegration === false || !settings || !settings._id) return;

  var set = {
    'value.operational.lastWabaTemplatePublicationAt': new Date().toISOString(),
    'value.operational.lastWabaTemplatePublicationStatus': status,
    'value.operational.lastWabaTemplatePublicationError': details && details.error || null
  };

  if (details && details.templateName) {
    set['value.operational.lastWabaTemplateName'] = details.templateName;
  }
  if (details && details.providerTemplateId) {
    set['value.operational.lastWabaTemplateProviderId'] = details.providerTemplateId;
  }

  await (deps.mongooseConnection || mongoose.connection)
    .collection('kvstore')
    .updateOne({ _id: settings._id }, { $set: set });
}

async function updateIntegrationSync(integration, result, deps) {
  deps = deps || {};
  if (deps.updateIntegration === false || !integration || !integration._id) return;

  await (deps.Integration || Integration).findByIdAndUpdate(integration._id, {
    $set: {
      'value.operational.lastWabaTemplateSyncAt': result.syncedAt,
      'value.operational.lastWabaTemplateSyncStatus': result.status,
      'value.operational.lastWabaTemplateSyncSummary': result.summary,
      'value.operational.lastWabaTemplateSyncError': result.error || null
    }
  });
}

async function updateSettingsSync(settings, result, deps) {
  deps = deps || {};
  if (deps.updateIntegration === false || !settings || !settings._id) return;

  await (deps.mongooseConnection || mongoose.connection).collection('kvstore').updateOne({ _id: settings._id }, {
    $set: {
      'value.operational.lastWabaTemplateSyncAt': result.syncedAt,
      'value.operational.lastWabaTemplateSyncStatus': result.status,
      'value.operational.lastWabaTemplateSyncSummary': result.summary,
      'value.operational.lastWabaTemplateSyncError': result.error || null
    }
  });
}

async function recordPublicationLog(level, status, integration, details, deps) {
  deps = deps || {};
  if (deps.operationalLogger === null || deps.operationalLogger === false) return;
  var logger = deps.operationalLogger || operationalLogger;
  if (!logger || !logger.recordSafe) return;

  logger.recordSafe({
    level: level,
    area: 'waba_template',
    channel: 'waba',
    id_project: integration && integration.id_project,
    integrationId: integration && integration._id ? String(integration._id) : null,
    event: 'waba_template.publication',
    status: status,
    details: details
  });
}

async function publishWabaTemplate(options, deps) {
  options = options || {};
  deps = deps || {};

  var dryRun = options.dryRun !== false;
  var template = templateById(options.templateId);
  var suggestion = getSuggestion(template, options.suggestionName);
  var payload = buildMetaTemplatePayload(suggestion);
  var integration = await findWabaIntegration(options.projectId, options.integrationId, deps);
  var settings = await findWhatsappSettings(integration, deps, options.projectId);
  var credentials = getCredentials(integration, settings);

  if (dryRun) {
    return publicationResponse(template, suggestion, payload, integration, credentials, {
      dryRun: true,
      status: credentials.token && credentials.wabaId ? 'ready_to_publish' : 'missing_waba_credentials',
      message: credentials.token && credentials.wabaId
        ? 'Payload pronto para envio ao endpoint de templates da Meta.'
        : 'Configure WABA ID e token antes de enviar para a Meta.'
    });
  }

  if (!credentials.token || !credentials.wabaId) {
    var missing = new Error(!credentials.wabaId ? 'missing_waba_id' : 'missing_waba_token');
    missing.statusCode = 400;
    throw missing;
  }

  try {
    var httpClient = deps.httpClient || axios;
    var startedAt = Date.now();
    var result = await httpClient.post(redactedEndpoint(credentials.wabaId), payload, {
      headers: {
        Authorization: 'Bearer ' + credentials.token,
        'Content-Type': 'application/json'
      },
      timeout: DEFAULT_TIMEOUT_MS
    });

    await updateIntegrationPublication(integration, 'success', {
      templateName: payload.name,
      providerTemplateId: result.data && result.data.id
    }, deps);
    await updateSettingsPublication(settings, 'success', {
      templateName: payload.name,
      providerTemplateId: result.data && result.data.id
    }, deps);
    await recordPublicationLog('info', 'success', integration, {
      templateName: payload.name,
      providerTemplateId: result.data && result.data.id,
      providerStatus: result.data && result.data.status,
      latencyMs: Date.now() - startedAt
    }, deps);

    return publicationResponse(template, suggestion, payload, integration, credentials, {
      dryRun: false,
      status: 'submitted',
      providerResponse: result.data
    });
  } catch (err) {
    await updateIntegrationPublication(integration, 'failed', {
      templateName: payload.name,
      error: operationalLogger.extractErrorMessage(err)
    }, deps);
    await updateSettingsPublication(settings, 'failed', {
      templateName: payload.name,
      error: operationalLogger.extractErrorMessage(err)
    }, deps);
    await recordPublicationLog('error', 'failed', integration, {
      templateName: payload.name,
      errorMessage: operationalLogger.extractErrorMessage(err),
      errorCode: operationalLogger.extractErrorCode(err)
    }, deps);
    throw err;
  }
}

async function syncWabaTemplateStatuses(options, deps) {
  options = options || {};
  deps = deps || {};

  var template = templateById(options.templateId);
  var publication = template.attributes && template.attributes.publication || {};
  var suggestions = publication && Array.isArray(publication.wabaTemplates) ? publication.wabaTemplates : [];
  var integration = await findWabaIntegration(options.projectId, options.integrationId, deps);
  var settings = await findWhatsappSettings(integration, deps, options.projectId);
  var credentials = getCredentials(integration, settings);

  if (!suggestions.length) {
    var noSuggestions = new Error('waba_template_suggestions_not_found');
    noSuggestions.statusCode = 404;
    throw noSuggestions;
  }

  if (!credentials.token || !credentials.wabaId) {
    var missing = buildSyncResponse(template, suggestions, integration, credentials, [], {
      status: 'missing_waba_credentials',
      message: 'Configure WABA ID e token antes de sincronizar status na Meta.'
    });
    await updateIntegrationSync(integration, missing, deps);
    await updateSettingsSync(settings, missing, deps);
    return missing;
  }

  try {
    var startedAt = Date.now();
    var metaTemplates = await fetchMetaTemplates(credentials, deps);
    var result = buildSyncResponse(template, suggestions, integration, credentials, metaTemplates, {
      status: 'synced',
      providerLatencyMs: Date.now() - startedAt
    });

    await updateIntegrationSync(integration, result, deps);
    await updateSettingsSync(settings, result, deps);
    await recordPublicationLog('info', 'success', integration, {
      action: 'sync',
      summary: result.summary,
      providerLatencyMs: result.providerLatencyMs
    }, deps);
    return result;
  } catch (err) {
    var failed = buildSyncResponse(template, suggestions, integration, credentials, [], {
      status: 'failed',
      error: operationalLogger.extractErrorMessage(err)
    });
    await updateIntegrationSync(integration, failed, deps);
    await updateSettingsSync(settings, failed, deps);
    await recordPublicationLog('error', 'failed', integration, {
      action: 'sync',
      errorMessage: operationalLogger.extractErrorMessage(err),
      errorCode: operationalLogger.extractErrorCode(err)
    }, deps);
    throw err;
  }
}

async function bindApprovedWabaTemplateToBot(options, deps) {
  options = options || {};
  deps = deps || {};

  if (!options.botId) {
    var missingBot = new Error('missing_bot_id');
    missingBot.statusCode = 400;
    throw missingBot;
  }

  var template = templateById(options.templateId);
  var integration = await findWabaIntegration(options.projectId, options.integrationId, deps);
  var settings = await findWhatsappSettings(integration, deps, options.projectId);
  var credentials = getCredentials(integration, settings);

  if (!credentials.token || !credentials.wabaId) {
    var missing = new Error(!credentials.wabaId ? 'missing_waba_id' : 'missing_waba_token');
    missing.statusCode = 400;
    throw missing;
  }

  var syncResult = await syncWabaTemplateStatuses(options, deps);
  var approvedTemplate = pickApprovedTemplate(syncResult, options.suggestionName);
  if (!approvedTemplate) {
    var notApproved = new Error('waba_template_not_approved');
    notApproved.statusCode = 409;
    notApproved.sync = syncResult;
    throw notApproved;
  }

  var FaqKbModel = deps.FaqKb || FaqKb;
  var bot = await FaqKbModel.findOne({
    _id: options.botId,
    id_project: options.projectId
  }).lean().exec();

  if (!bot) {
    var missingTarget = new Error('bot_not_found');
    missingTarget.statusCode = 404;
    throw missingTarget;
  }

  var binding = buildWabaTemplateBinding(template, approvedTemplate, integration, credentials);
  var attributes = mergeWabaTemplateBinding(bot.attributes, binding);
  var updatedBot = await FaqKbModel.findByIdAndUpdate(
    bot._id,
    { $set: { attributes: attributes, modified: true } },
    { new: true }
  ).lean().exec();

  await recordPublicationLog('info', 'success', integration, {
    action: 'bind',
    botId: String(bot._id),
    templateName: binding.suggestionName,
    providerTemplateId: binding.providerTemplateId
  }, deps);

  return {
    status: 'bound',
    botId: String(bot._id),
    templateId: template._id,
    binding: binding,
    sync: syncResult,
    bot: updatedBot
  };
}

module.exports = {
  buildMetaTemplatePayload: buildMetaTemplatePayload,
  buildBoundWabaTemplateAttachment: buildBoundWabaTemplateAttachment,
  buildBoundWabaTemplateMessage: buildBoundWabaTemplateMessage,
  dispatchBoundWabaTemplate: dispatchBoundWabaTemplate,
  getBoundWabaTemplateForBot: getBoundWabaTemplateForBot,
  pickBoundWabaTemplate: pickBoundWabaTemplate,
  publishWabaTemplate: publishWabaTemplate,
  syncWabaTemplateStatuses: syncWabaTemplateStatuses,
  bindApprovedWabaTemplateToBot: bindApprovedWabaTemplateToBot,
  normalizeTemplateName: normalizeTemplateName
};
