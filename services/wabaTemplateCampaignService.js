var uuidv4 = require('uuid/v4');
var mongoose = require('mongoose');
var { Transaction } = require('../models/transaction');
var Lead = require('../models/lead');
var LeadConstants = require('../models/leadConstants');
var Segment = require('../models/segment');
var Request = require('../models/request');
var Segment2MongoConverter = require('../utils/segment2mongoConverter');
var publicationService = require('./wabaTemplatePublicationService');
var operationalLogger = require('./operationalLogger');

var CAMPAIGN_TYPE = 'waba_template_campaign';
var activeCampaigns = {};

function getCampaignLimit() {
  var limit = parseInt(process.env.WABA_TEMPLATE_CAMPAIGN_RECIPIENT_LIMIT || '1000', 10);
  if (isNaN(limit) || limit < 1) return 1000;
  return limit;
}

function getDefaultIntervalMs(value) {
  var interval = parseInt(value || process.env.WABA_TEMPLATE_CAMPAIGN_INTERVAL_MS || '1000', 10);
  if (isNaN(interval) || interval < 0) return 1000;
  return interval;
}

function normalizeWhatsappRecipient(phoneNumber) {
  var normalized = String(phoneNumber || '').replace(/\D+/g, '');
  if (!normalized || normalized.length < 8) {
    var invalid = new Error('invalid_recipient_phone_number');
    invalid.statusCode = 400;
    throw invalid;
  }
  return normalized;
}

function normalizeCampaignRecipients(value, defaults, settings) {
  defaults = defaults || {};
  settings = settings || {};
  var source = Array.isArray(value) ? value : [];
  var seen = {};
  var recipients = [];

  source.forEach(function(item, index) {
    var normalized;
    if (typeof item === 'string') {
      normalized = {
        phoneNumber: normalizeWhatsappRecipient(item),
        recipientName: defaults.recipientName || defaults.customerName || 'Cliente'
      };
    } else {
      item = item || {};
      normalized = {
        phoneNumber: normalizeWhatsappRecipient(item.phoneNumber || item.phone || item.to || item.whatsapp),
        recipientName: item.recipientName || item.customerName || item.name || defaults.recipientName || defaults.customerName || 'Cliente',
        templateValues: item.templateValues || defaults.templateValues,
        headerParams: item.headerParams || defaults.headerParams,
        bodyParams: item.bodyParams || defaults.bodyParams,
        buttonParams: item.buttonParams || defaults.buttonParams,
        leadId: item.leadId,
        audienceSource: item.audienceSource
      };
    }

    if (seen[normalized.phoneNumber]) return;
    seen[normalized.phoneNumber] = true;
    recipients.push(Object.assign(normalized, {
      index: recipients.length,
      sourceIndex: index,
      status: 'queued',
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    }));
  });

  if (!recipients.length && !settings.allowEmpty) {
    var missing = new Error('missing_campaign_recipients');
    missing.statusCode = 400;
    throw missing;
  }

  var limit = getCampaignLimit();
  if (recipients.length > limit) {
    var tooMany = new Error('too_many_recipients_for_campaign');
    tooMany.statusCode = 400;
    tooMany.limit = limit;
    throw tooMany;
  }

  return recipients;
}

function normalizeTags(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map(function(item) { return String(item || '').trim(); }).filter(Boolean);
  }
  return String(value || '')
    .split(',')
    .map(function(item) { return item.trim(); })
    .filter(Boolean);
}

function normalizeAudienceChannel(value) {
  var channel = String(value || 'all').trim().toLowerCase();
  if (['waba', 'whatsapp', 'casezap', 'phone', 'all'].indexOf(channel) === -1) return 'all';
  return channel;
}

function campaignLimitFromAudience(audience) {
  audience = audience || {};
  var requested = parseInt(audience.limit || audience.maxRecipients || audience.max_recipients || getCampaignLimit(), 10);
  if (isNaN(requested) || requested < 1) requested = getCampaignLimit();
  return Math.min(requested, getCampaignLimit());
}

function addAndCondition(query, condition) {
  if (!condition) return;
  query.$and = query.$and || [];
  query.$and.push(condition);
}

function channelNamesFromAudience(value) {
  var channel = normalizeAudienceChannel(value);
  if (channel === 'waba' || channel === 'whatsapp') return ['whatsapp'];
  if (channel === 'casezap') return ['casezap'];
  return [];
}

async function buildAudienceLeadQuery(projectId, audience, deps) {
  audience = audience || {};
  deps = deps || {};

  var query = {
    id_project: projectId,
    status: LeadConstants.NORMAL
  };

  var segmentId = audience.segmentId || audience.segment_id;
  if (segmentId) {
    if (!mongoose.Types.ObjectId.isValid(segmentId)) {
      var invalidSegment = new Error('invalid_audience_segment_id');
      invalidSegment.statusCode = 400;
      throw invalidSegment;
    }

    var SegmentModel = deps.Segment || Segment;
    var segment = await SegmentModel.findOne({ id_project: projectId, _id: segmentId }).exec();
    if (!segment) {
      var missingSegment = new Error('audience_segment_not_found');
      missingSegment.statusCode = 404;
      throw missingSegment;
    }
    Segment2MongoConverter.convert(query, segment);
    query.id_project = projectId;
    if (!query.status) query.status = LeadConstants.NORMAL;
  }

  if (audience.status != null && audience.status !== '') {
    var requestedStatus = parseInt(audience.status, 10);
    if (requestedStatus !== LeadConstants.NORMAL) {
      var invalidStatus = new Error('invalid_audience_status');
      invalidStatus.statusCode = 400;
      throw invalidStatus;
    }
    query.status = requestedStatus;
  }

  if (audience.fullText || audience.full_text || audience.search) {
    query.$text = { $search: String(audience.fullText || audience.full_text || audience.search) };
  }

  if (audience.email) {
    query.email = String(audience.email).trim();
  }

  var tags = normalizeTags(audience.tags);
  if (tags.length === 1) {
    query.tags = tags[0];
  } else if (tags.length > 1) {
    query.tags = { $all: tags };
  }

  var channel = normalizeAudienceChannel(audience.channel);
  var channelNames = channelNamesFromAudience(channel);
  var channelSourceConditions = [];

  if (channelNames.length) {
    var RequestModel = deps.Request || Request;
    var leadIds = await RequestModel.distinct('lead', {
      id_project: projectId,
      'channel.name': { $in: channelNames },
      lead: { $exists: true, $ne: null }
    }).exec();

    if (leadIds && leadIds.length > 0) {
      channelSourceConditions.push({ _id: { $in: leadIds } });
    }
  }

  if (channel === 'waba' || channel === 'whatsapp') {
    channelSourceConditions.push({ lead_id: /^wab-/ });
  } else if (channel === 'casezap') {
    channelSourceConditions.push({ lead_id: /^casezap-/ });
    channelSourceConditions.push({ 'attributes.casezapPhone': { $exists: true, $ne: '' } });
  } else if (channel === 'phone') {
    channelSourceConditions.push({ phone: { $exists: true, $ne: '' } });
    channelSourceConditions.push({ lead_id: /^wab-/ });
    channelSourceConditions.push({ lead_id: /^casezap-/ });
    channelSourceConditions.push({ 'attributes.casezapPhone': { $exists: true, $ne: '' } });
  }

  if (channelSourceConditions.length > 0) {
    addAndCondition(query, { $or: channelSourceConditions });
  }

  return query;
}

function phoneFromLeadId(leadId) {
  var value = String(leadId || '');
  if (value.indexOf('wab-') === 0) return value.replace(/^wab-/, '');
  if (value.indexOf('casezap-') === 0) {
    var parts = value.split('-');
    return parts[parts.length - 1];
  }
  return '';
}

function phoneFromLead(lead) {
  lead = lead || {};
  var attributes = lead.attributes || {};
  var candidates = [
    lead.phone,
    attributes.whatsappPhone,
    attributes.casezapPhone,
    attributes.phone,
    phoneFromLeadId(lead.lead_id)
  ];

  for (var i = 0; i < candidates.length; i += 1) {
    var normalized = String(candidates[i] || '').replace(/\D+/g, '');
    if (normalized && normalized.length >= 8) return normalized;
  }
  return null;
}

function leadAudienceSource(lead) {
  var leadId = String(lead && lead.lead_id || '');
  if (leadId.indexOf('casezap-') === 0) return 'casezap';
  if (leadId.indexOf('wab-') === 0) return 'waba';
  return 'contact';
}

function recipientFromLead(lead) {
  var phoneNumber = phoneFromLead(lead);
  if (!phoneNumber) return null;
  return {
    phoneNumber: phoneNumber,
    recipientName: lead.fullname || lead.name || 'Cliente',
    leadId: lead._id ? String(lead._id) : null,
    audienceSource: leadAudienceSource(lead)
  };
}

async function resolveAudienceRecipients(options, deps) {
  options = options || {};
  deps = deps || {};
  var audience = options.audience || {};
  var LeadModel = deps.Lead || Lead;
  var limit = campaignLimitFromAudience(audience);
  var query = await buildAudienceLeadQuery(options.projectId, audience, deps);

  var leads = await LeadModel.find(query)
    .limit(limit)
    .select('lead_id fullname email phone tags attributes status')
    .lean()
    .exec();

  var candidates = [];
  var invalid = 0;
  (leads || []).forEach(function(lead) {
    var recipient = recipientFromLead(lead);
    if (!recipient) {
      invalid += 1;
      return;
    }
    candidates.push(recipient);
  });

  var recipients = normalizeCampaignRecipients(candidates, options, {
    allowEmpty: options.allowEmptyAudience === true
  });

  return {
    recipients: recipients,
    audience: {
      type: audience.type || 'contacts',
      segmentId: audience.segmentId || audience.segment_id || null,
      channel: normalizeAudienceChannel(audience.channel),
      tags: normalizeTags(audience.tags),
      fullText: audience.fullText || audience.full_text || audience.search || null,
      limit: limit,
      totalMatched: leads ? leads.length : 0,
      validRecipients: recipients.length,
      invalidRecipients: invalid,
      duplicatesSkipped: Math.max(candidates.length - recipients.length, 0)
    }
  };
}

async function resolveCampaignRecipients(options, deps) {
  options = options || {};
  if ((options.audience && (options.audience.type || options.audience.segmentId || options.audience.segment_id || options.audience.tags || options.audience.fullText || options.audience.full_text || options.audience.search || options.audience.channel)) || options.segmentId || options.segment_id) {
    if (!options.audience) options.audience = {};
    if (!options.audience.segmentId && !options.audience.segment_id) {
      options.audience.segmentId = options.segmentId || options.segment_id;
    }
    return resolveAudienceRecipients(options, deps);
  }

  return {
    recipients: normalizeCampaignRecipients(options.recipients, options),
    audience: {
      type: 'manual',
      totalMatched: Array.isArray(options.recipients) ? options.recipients.length : 0,
      validRecipients: Array.isArray(options.recipients) ? options.recipients.length : 0,
      invalidRecipients: 0,
      duplicatesSkipped: 0
    }
  };
}

async function previewAudience(options, deps) {
  var resolved = await resolveAudienceRecipients(Object.assign({}, options, {
    allowEmptyAudience: true
  }), deps);
  return {
    audience: resolved.audience,
    recipients: []
  };
}

function serializeTransaction(transaction) {
  if (!transaction) return null;
  if (typeof transaction.toObject === 'function') return transaction.toObject();
  return transaction;
}

function findTransaction(projectId, transactionId, deps) {
  deps = deps || {};
  var TransactionModel = deps.Transaction || Transaction;
  return TransactionModel.findOne({
    id_project: projectId,
    transaction_id: transactionId
  }).exec();
}

function ensureCampaign(transaction) {
  if (!transaction) {
    var missing = new Error('campaign_not_found');
    missing.statusCode = 404;
    throw missing;
  }
  if (transaction.dispatch_type !== CAMPAIGN_TYPE) {
    var invalid = new Error('transaction_is_not_waba_campaign');
    invalid.statusCode = 400;
    throw invalid;
  }
}

function summarizeRecipients(recipients) {
  recipients = Array.isArray(recipients) ? recipients : [];
  return recipients.reduce(function(summary, recipient) {
    var status = recipient && recipient.status;
    if (status === 'accepted') summary.sent_count += 1;
    if (status === 'failed') summary.failed_count += 1;
    if (status === 'ready') summary.ready_count += 1;
    if (status === 'skipped' || status === 'canceled') summary.skipped_count += 1;
    if (['accepted', 'failed', 'ready', 'skipped', 'canceled'].indexOf(status) !== -1) {
      summary.processed_count += 1;
    }
    return summary;
  }, {
    processed_count: 0,
    sent_count: 0,
    failed_count: 0,
    ready_count: 0,
    skipped_count: 0
  });
}

function applyRecipientSummary(transaction) {
  var summary = summarizeRecipients(transaction.recipients);
  transaction.processed_count = summary.processed_count;
  transaction.sent_count = summary.sent_count;
  transaction.failed_count = summary.failed_count;
  transaction.ready_count = summary.ready_count;
  transaction.skipped_count = summary.skipped_count;
  transaction.recipients_total = Array.isArray(transaction.recipients) ? transaction.recipients.length : 0;
}

function markRecipientsModified(transaction) {
  if (transaction && typeof transaction.markModified === 'function') {
    transaction.markModified('recipients');
  }
}

function finalCampaignStatus(transaction) {
  applyRecipientSummary(transaction);
  if (transaction.failed_count > 0 && transaction.sent_count === 0 && transaction.ready_count === 0) return 'failed';
  if (transaction.failed_count > 0) return 'completed_with_errors';
  return 'completed';
}

function delay(ms, deps) {
  deps = deps || {};
  if (deps.delayFn) return deps.delayFn(ms);
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function scheduleCampaign(projectId, transactionId, deps) {
  deps = deps || {};
  if (deps.autostart === false) return;

  if (deps.runInBackground === false) {
    return processCampaign({
      projectId: projectId,
      transactionId: transactionId
    }, deps);
  }

  setImmediate(function() {
    processCampaign({
      projectId: projectId,
      transactionId: transactionId
    }, deps).catch(function(err) {
      var message = err && err.message ? err.message : err;
      if (operationalLogger && operationalLogger.recordSafe) {
        operationalLogger.recordSafe({
          level: 'error',
          area: 'waba_template_campaign',
          channel: 'waba',
          id_project: projectId,
          event: 'waba_template.campaign.process',
          status: 'failed',
          details: {
            transactionId: transactionId,
            error: message
          }
        });
      }
    });
  });
}

async function createCampaign(options, deps) {
  options = options || {};
  deps = deps || {};

  var resolvedRecipients = await resolveCampaignRecipients(options, deps);
  var recipients = resolvedRecipients.recipients;
  var firstRecipient = recipients[0] || {};
  var service = deps.publicationService || publicationService;
  var preview = await service.buildBoundWabaTemplateMessage(Object.assign({}, options, firstRecipient), deps);
  var binding = preview.binding || {};
  var transactionId = options.transactionId || ('waba-campaign-' + String(options.botId || 'bot') + '-' + Date.now() + '-' + uuidv4());
  var templateName = binding.providerTemplateName || binding.suggestionName || binding.name || 'waba_template';
  var dryRun = options.dryRun === true || options.dryRun === 'true';
  var intervalMs = getDefaultIntervalMs(options.intervalMs || options.interval_ms);
  var now = new Date();

  var TransactionModel = deps.Transaction || Transaction;
  var transaction = new TransactionModel({
    transaction_id: transactionId,
    id_project: options.projectId,
    template_name: templateName,
    status: 'queued',
    channel: 'whatsapp',
    broadcast: true,
    dispatch_type: CAMPAIGN_TYPE,
    faq_kb_id: String(options.botId),
    createdBy: options.createdBy,
    recipients_total: recipients.length,
    processed_count: 0,
    sent_count: 0,
    failed_count: 0,
    ready_count: 0,
    skipped_count: 0,
    dry_run: dryRun,
    interval_ms: intervalMs,
    recipients: recipients,
    campaign: {
      provider: 'meta',
      channel: 'waba',
      suggestionName: options.suggestionName || binding.suggestionName || null,
      integrationId: options.integrationId || binding.integrationId || null,
      wabaId: options.wabaId || binding.wabaId || null,
      language: options.language || binding.language || null,
      templateValues: options.templateValues,
      headerParams: options.headerParams,
      bodyParams: options.bodyParams,
      buttonParams: options.buttonParams,
      text: options.text || '',
      audience: resolvedRecipients.audience
    },
    createdAt: now,
    updatedAt: now
  });

  await transaction.save();
  var processedCampaign = await scheduleCampaign(options.projectId, transactionId, Object.assign({}, deps, {
    autostart: options.autostart,
    runInBackground: options.runInBackground
  }));

  if (processedCampaign) return processedCampaign;
  return serializeTransaction(transaction);
}

async function processCampaign(options, deps) {
  options = options || {};
  deps = deps || {};

  var projectId = options.projectId;
  var transactionId = options.transactionId;
  var key = projectId + ':' + transactionId;
  if (activeCampaigns[key]) {
    return serializeTransaction(await findTransaction(projectId, transactionId, deps));
  }

  activeCampaigns[key] = true;

  try {
    while (true) {
      var transaction = await findTransaction(projectId, transactionId, deps);
      ensureCampaign(transaction);

      if (['paused', 'canceled', 'completed', 'completed_with_errors', 'failed'].indexOf(transaction.status) !== -1) {
        return serializeTransaction(transaction);
      }

      var recipients = Array.isArray(transaction.recipients) ? transaction.recipients : [];
      var nextIndex = recipients.findIndex(function(recipient) {
        return recipient && (recipient.status === 'queued' || recipient.status === 'retry');
      });

      if (nextIndex === -1) {
        transaction.status = finalCampaignStatus(transaction);
        transaction.finishedAt = new Date();
        transaction.updatedAt = new Date();
        await transaction.save();
        return serializeTransaction(transaction);
      }

      var recipient = recipients[nextIndex];
      recipient.status = 'sending';
      recipient.attempts = (recipient.attempts || 0) + 1;
      recipient.updatedAt = new Date();
      transaction.recipients = recipients;
      markRecipientsModified(transaction);
      transaction.status = 'running';
      transaction.startedAt = transaction.startedAt || new Date();
      transaction.updatedAt = new Date();
      await transaction.save();

      var result = null;
      try {
        var service = deps.publicationService || publicationService;
        result = await service.dispatchBoundWabaTemplate({
          projectId: projectId,
          botId: transaction.faq_kb_id,
          suggestionName: transaction.campaign && transaction.campaign.suggestionName,
          integrationId: transaction.campaign && transaction.campaign.integrationId,
          wabaId: transaction.campaign && transaction.campaign.wabaId,
          language: transaction.campaign && transaction.campaign.language,
          phoneNumber: recipient.phoneNumber,
          recipientName: recipient.recipientName,
          customerName: recipient.recipientName,
          templateValues: recipient.templateValues || transaction.campaign && transaction.campaign.templateValues,
          headerParams: recipient.headerParams || transaction.campaign && transaction.campaign.headerParams,
          bodyParams: recipient.bodyParams || transaction.campaign && transaction.campaign.bodyParams,
          buttonParams: recipient.buttonParams || transaction.campaign && transaction.campaign.buttonParams,
          text: transaction.campaign && transaction.campaign.text,
          transactionId: transaction.transaction_id,
          dryRun: transaction.dry_run,
          persistTransaction: false
        }, deps);
      } catch (err) {
        result = {
          status: 'failed',
          failed: 1,
          results: [{
            phoneNumber: recipient.phoneNumber,
            status: 'failed',
            error: operationalLogger.extractErrorMessage(err)
          }]
        };
      }

      transaction = await findTransaction(projectId, transactionId, deps);
      ensureCampaign(transaction);
      recipients = Array.isArray(transaction.recipients) ? transaction.recipients : [];
      recipient = recipients[nextIndex] || recipient;
      var recipientResult = result && Array.isArray(result.results) ? result.results[0] : null;
      var resultStatus = recipientResult && recipientResult.status || result && result.status || 'failed';
      var finishedStatus = resultStatus === 'accepted' || resultStatus === 'ready' ? resultStatus : 'failed';
      recipient.status = finishedStatus;
      recipient.messageId = recipientResult && recipientResult.messageId || null;
      recipient.providerStatus = recipientResult && recipientResult.providerStatus || null;
      recipient.error = recipientResult && recipientResult.error || null;
      recipient.updatedAt = new Date();
      transaction.recipients = recipients;
      markRecipientsModified(transaction);
      transaction.last_error = recipient.error || transaction.last_error;
      applyRecipientSummary(transaction);
      transaction.updatedAt = new Date();
      await transaction.save();

      if (transaction.interval_ms > 0) {
        await delay(transaction.interval_ms, deps);
      }
    }
  } finally {
    delete activeCampaigns[key];
  }
}

async function getCampaign(options, deps) {
  options = options || {};
  var transaction = await findTransaction(options.projectId, options.transactionId, deps);
  ensureCampaign(transaction);
  return serializeTransaction(transaction);
}

async function pauseCampaign(options, deps) {
  options = options || {};
  var transaction = await findTransaction(options.projectId, options.transactionId, deps);
  ensureCampaign(transaction);
  if (['completed', 'completed_with_errors', 'failed', 'canceled'].indexOf(transaction.status) === -1) {
    transaction.status = 'paused';
    transaction.pausedAt = new Date();
    transaction.updatedAt = new Date();
    await transaction.save();
  }
  return serializeTransaction(transaction);
}

async function resumeCampaign(options, deps) {
  options = options || {};
  deps = deps || {};
  var transaction = await findTransaction(options.projectId, options.transactionId, deps);
  ensureCampaign(transaction);
  if (transaction.status === 'paused') {
    transaction.status = 'queued';
    transaction.pausedAt = null;
    transaction.updatedAt = new Date();
    await transaction.save();
    await scheduleCampaign(options.projectId, options.transactionId, deps);
  }
  return serializeTransaction(transaction);
}

async function cancelCampaign(options, deps) {
  options = options || {};
  var transaction = await findTransaction(options.projectId, options.transactionId, deps);
  ensureCampaign(transaction);
  if (['completed', 'completed_with_errors', 'failed', 'canceled'].indexOf(transaction.status) === -1) {
    var recipients = Array.isArray(transaction.recipients) ? transaction.recipients : [];
    recipients.forEach(function(recipient) {
      if (recipient && ['queued', 'retry', 'sending'].indexOf(recipient.status) !== -1) {
        recipient.status = 'canceled';
        recipient.updatedAt = new Date();
      }
    });
    transaction.recipients = recipients;
    markRecipientsModified(transaction);
    transaction.status = 'canceled';
    transaction.canceledAt = new Date();
    transaction.finishedAt = new Date();
    applyRecipientSummary(transaction);
    transaction.updatedAt = new Date();
    await transaction.save();
  }
  return serializeTransaction(transaction);
}

module.exports = {
  CAMPAIGN_TYPE: CAMPAIGN_TYPE,
  createCampaign: createCampaign,
  processCampaign: processCampaign,
  getCampaign: getCampaign,
  pauseCampaign: pauseCampaign,
  resumeCampaign: resumeCampaign,
  cancelCampaign: cancelCampaign,
  previewAudience: previewAudience,
  resolveCampaignRecipients: resolveCampaignRecipients,
  normalizeCampaignRecipients: normalizeCampaignRecipients,
  summarizeRecipients: summarizeRecipients
};
