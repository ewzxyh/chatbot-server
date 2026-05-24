var axios = require('axios');
var mongoose = require('mongoose');
var Integration = require('../models/integrations');
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
  var settingsValue = settings && settings.value ? settings.value : {};
  return {
    token: settingsValue.wab_token || settingsValue.access_token || integrationValue.wab_token || integrationValue.access_token || null,
    wabaId: settingsValue.waba_id || integrationValue.waba_id || null
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

module.exports = {
  buildMetaTemplatePayload: buildMetaTemplatePayload,
  publishWabaTemplate: publishWabaTemplate,
  syncWabaTemplateStatuses: syncWabaTemplateStatuses,
  normalizeTemplateName: normalizeTemplateName
};
