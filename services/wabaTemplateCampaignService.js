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
var backgroundWorkers = require('../utils/backgroundWorkers');

var CAMPAIGN_TYPE = 'waba_template_campaign';
var PROCESS_OWNER = 'waba-campaign-' + process.pid + '-' + uuidv4();
var activeCampaigns = {};
var scheduledSweepState = {
  started: false,
  running: false,
  timer: null,
  startTimer: null,
  intervalMs: null,
  startDelayMs: null,
  lastRunAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  processedCount: 0,
  skippedCount: 0
};

function getNow(deps) {
  deps = deps || {};
  if (deps.nowFn) {
    var value = deps.nowFn();
    return value instanceof Date ? value : new Date(value);
  }
  return new Date();
}

function getCampaignLimit() {
  var limit = parseInt(process.env.WABA_TEMPLATE_CAMPAIGN_RECIPIENT_LIMIT || '1000', 10);
  if (isNaN(limit) || limit < 1) return 1000;
  return limit;
}

function getDefaultIntervalMs(value) {
  var raw = value !== undefined && value !== null && value !== ''
    ? value
    : (process.env.WABA_TEMPLATE_CAMPAIGN_INTERVAL_MS || '1000');
  var interval = parseInt(raw, 10);
  if (isNaN(interval) || interval < 0) return 1000;
  return interval;
}

function getSendingStaleMs() {
  var staleMs = parseInt(process.env.WABA_TEMPLATE_CAMPAIGN_SENDING_STALE_MS || String(10 * 60 * 1000), 10);
  if (isNaN(staleMs) || staleMs < 0) return 10 * 60 * 1000;
  return staleMs;
}

function getProcessingLeaseMs(deps) {
  deps = deps || {};
  if (deps.processingLeaseMs != null) {
    var injected = parseInt(deps.processingLeaseMs, 10);
    if (!isNaN(injected) && injected > 0) return injected;
  }
  var leaseMs = parseInt(process.env.WABA_TEMPLATE_CAMPAIGN_PROCESSING_LEASE_MS || String(15 * 60 * 1000), 10);
  if (isNaN(leaseMs) || leaseMs < 1000) return 15 * 60 * 1000;
  return leaseMs;
}

function getProcessingLeaseHeartbeatMs(deps) {
  deps = deps || {};
  if (deps.processingLeaseHeartbeatMs != null) {
    var injected = parseInt(deps.processingLeaseHeartbeatMs, 10);
    if (!isNaN(injected) && injected > 0) return injected;
  }
  var envHeartbeat = parseInt(process.env.WABA_TEMPLATE_CAMPAIGN_PROCESSING_HEARTBEAT_MS || '', 10);
  if (!isNaN(envHeartbeat) && envHeartbeat > 0) return envHeartbeat;
  return Math.max(250, Math.floor(getProcessingLeaseMs(deps) / 3));
}

function getMaxAttempts() {
  var maxAttempts = parseInt(process.env.WABA_TEMPLATE_CAMPAIGN_MAX_ATTEMPTS || '3', 10);
  if (isNaN(maxAttempts) || maxAttempts < 1) return 3;
  return maxAttempts;
}

function parseBoolean(value) {
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return null;
}

function parsePositiveInt(value, fallback) {
  var parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed < 1 ? fallback : parsed;
}

function normalizeQualityRating(value) {
  if (!value) return null;
  if (typeof value === 'object') {
    value = value.score || value.rating || value.quality_rating || value.qualityRating || value.status;
  }
  var rating = String(value || '').trim().toLowerCase();
  if (!rating) return null;
  if (['green', 'high', 'good'].indexOf(rating) !== -1) return 'green';
  if (['yellow', 'medium', 'warning'].indexOf(rating) !== -1) return 'yellow';
  if (['red', 'low', 'poor', 'restricted', 'disabled'].indexOf(rating) !== -1) return 'red';
  return null;
}

function qualityRatingFromOptions(options, binding) {
  binding = binding || {};
  var bindingRating = normalizeQualityRating(
    binding.qualityRating ||
    binding.quality_rating ||
    binding.qualityScore ||
    binding.quality_score ||
    binding.meta && (binding.meta.qualityScore || binding.meta.quality_score)
  );
  return bindingRating;
}

function buildThrottlePolicy(intervalMs, options, binding) {
  var qualityRating = qualityRatingFromOptions(options, binding);
  var allowLowQuality = parseBoolean(options && (options.allowLowQuality || options.allow_low_quality)) === true;
  var minYellowInterval = parseInt(process.env.WABA_TEMPLATE_CAMPAIGN_YELLOW_INTERVAL_MS || '5000', 10);
  if (isNaN(minYellowInterval) || minYellowInterval < 0) minYellowInterval = 5000;

  if (qualityRating === 'red' && !allowLowQuality) {
    var blocked = new Error('waba_quality_blocks_campaign');
    blocked.statusCode = 409;
    throw blocked;
  }

  return {
    qualityRating: qualityRating,
    allowLowQuality: allowLowQuality,
    intervalMs: qualityRating === 'yellow' ? Math.max(intervalMs, minYellowInterval) : intervalMs,
    minIntervalMs: qualityRating === 'yellow' ? minYellowInterval : 0
  };
}

function requireCampaignConsent(options, dryRun) {
  if (dryRun) {
    return {
      required: false,
      confirmed: false,
      mode: 'dry_run'
    };
  }

  var confirmed = parseBoolean(options && (
    options.consentConfirmed ||
    options.consent_confirmed ||
    options.optInConfirmed ||
    options.opt_in_confirmed
  ));

  if (confirmed !== true) {
    var missing = new Error('waba_campaign_consent_required');
    missing.statusCode = 400;
    throw missing;
  }

  return {
    required: true,
    confirmed: true,
    mode: 'confirmed'
  };
}

function parseScheduledAt(options, deps) {
  options = options || {};
  var raw = options.scheduledAt || options.scheduled_at;
  if (!raw) return null;

  var scheduledAt = new Date(raw);
  if (isNaN(scheduledAt.getTime())) {
    var invalid = new Error('invalid_campaign_schedule');
    invalid.statusCode = 400;
    throw invalid;
  }

  var now = getNow(deps);
  if (scheduledAt.getTime() <= now.getTime()) {
    var past = new Error('campaign_schedule_must_be_future');
    past.statusCode = 400;
    throw past;
  }
  return scheduledAt;
}

function isTruthyFlag(value) {
  return value === true || value === 'true' || value === '1' || value === 1 || value === 'yes';
}

function pickNestedStatus(value) {
  if (value === false) return 'false';
  if (value === true) return 'true';
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    return value.status || value.state || value.value || null;
  }
  return null;
}

function isOptedOutValue(value) {
  var status = pickNestedStatus(value);
  if (!status) return false;
  status = String(status).trim().toLowerCase();
  return ['opted_out', 'optout', 'unsubscribed', 'blocked', 'false', 'no'].indexOf(status) !== -1;
}

function hasExplicitOptOut(source) {
  source = source || {};
  return isTruthyFlag(source.optedOut) ||
    isTruthyFlag(source.opted_out) ||
    isTruthyFlag(source.unsubscribed) ||
    isTruthyFlag(source.unsubscribe) ||
    isTruthyFlag(source.doNotContact) ||
    isTruthyFlag(source.do_not_contact) ||
    isOptedOutValue(source.consentStatus) ||
    isOptedOutValue(source.consent_status) ||
    isOptedOutValue(source.wabaConsent) ||
    isOptedOutValue(source.whatsappConsent);
}

function isLeadOptedOut(lead) {
  lead = lead || {};
  var attributes = lead.attributes || {};
  var properties = lead.properties || {};
  return hasExplicitOptOut(lead) ||
    hasExplicitOptOut(attributes) ||
    hasExplicitOptOut(properties) ||
    isOptedOutValue(attributes.wabaConsent) ||
    isOptedOutValue(attributes.whatsappConsent) ||
    isOptedOutValue(properties.wabaConsent) ||
    isOptedOutValue(properties.whatsappConsent);
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
      var optedOut = hasExplicitOptOut(item);
      normalized = {
        phoneNumber: normalizeWhatsappRecipient(item.phoneNumber || item.phone || item.to || item.whatsapp),
        recipientName: item.recipientName || item.customerName || item.name || defaults.recipientName || defaults.customerName || 'Cliente',
        templateValues: item.templateValues || defaults.templateValues,
        headerParams: item.headerParams || defaults.headerParams,
        bodyParams: item.bodyParams || defaults.bodyParams,
        buttonParams: item.buttonParams || defaults.buttonParams,
        leadId: item.leadId,
        audienceSource: item.audienceSource,
        optedOut: optedOut
      };
    }

    if (seen[normalized.phoneNumber]) return;
    seen[normalized.phoneNumber] = true;
    var recipientStatus = normalized.optedOut ? 'skipped' : 'queued';
    recipients.push(Object.assign(normalized, {
      index: recipients.length,
      sourceIndex: index,
      status: recipientStatus,
      skipReason: normalized.optedOut ? 'opted_out' : undefined,
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
    .select('lead_id fullname email phone tags attributes properties status')
    .lean()
    .exec();

  var candidates = [];
  var invalid = 0;
  var optedOutSkipped = 0;
  (leads || []).forEach(function(lead) {
    if (isLeadOptedOut(lead)) {
      optedOutSkipped += 1;
      return;
    }
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
      duplicatesSkipped: Math.max(candidates.length - recipients.length, 0),
      optedOutSkipped: optedOutSkipped
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
      duplicatesSkipped: 0,
      optedOutSkipped: 0
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

function queryExec(query) {
  return query && typeof query.exec === 'function' ? query.exec() : query;
}

async function acquireProcessingLease(projectId, transactionId, deps) {
  deps = deps || {};
  if (deps.disableProcessingLease === true) return true;

  var TransactionModel = deps.Transaction || Transaction;
  if (!TransactionModel.findOneAndUpdate) return true;

  var now = getNow(deps);
  var nowIso = now.toISOString();
  var leaseMs = getProcessingLeaseMs(deps);
  var lockUntil = new Date(now.getTime() + leaseMs).toISOString();
  var owner = deps.processingOwner || PROCESS_OWNER;
  var update = {
    $set: {
      'campaign.processing.lockOwner': owner,
      'campaign.processing.lockUntil': lockUntil,
      'campaign.processing.lockedAt': nowIso,
      updatedAt: now
    }
  };

  var transaction = await queryExec(TransactionModel.findOneAndUpdate({
    id_project: projectId,
    transaction_id: transactionId,
    dispatch_type: CAMPAIGN_TYPE,
    $or: [
      { 'campaign.processing.lockUntil': { $exists: false } },
      { 'campaign.processing.lockUntil': null },
      { 'campaign.processing.lockUntil': { $lte: nowIso } },
      { 'campaign.processing.lockOwner': owner }
    ]
  }, update, {
    new: true
  }));

  return transaction ? owner : null;
}

async function releaseProcessingLease(projectId, transactionId, owner, deps) {
  deps = deps || {};
  if (!owner || deps.disableProcessingLease === true) return;

  var TransactionModel = deps.Transaction || Transaction;
  if (!TransactionModel.findOneAndUpdate) return;

  await queryExec(TransactionModel.findOneAndUpdate({
    id_project: projectId,
    transaction_id: transactionId,
    dispatch_type: CAMPAIGN_TYPE,
    'campaign.processing.lockOwner': owner
  }, {
    $unset: {
      'campaign.processing': ''
    },
    $set: {
      updatedAt: getNow(deps)
    }
  }));
}

async function renewProcessingLease(projectId, transactionId, owner, deps) {
  deps = deps || {};
  if (!owner || deps.disableProcessingLease === true) return true;

  var TransactionModel = deps.Transaction || Transaction;
  if (!TransactionModel.findOneAndUpdate) return true;

  var now = getNow(deps);
  var leaseMs = getProcessingLeaseMs(deps);
  var lockUntil = new Date(now.getTime() + leaseMs).toISOString();
  var transaction = await queryExec(TransactionModel.findOneAndUpdate({
    id_project: projectId,
    transaction_id: transactionId,
    dispatch_type: CAMPAIGN_TYPE,
    'campaign.processing.lockOwner': owner
  }, {
    $set: {
      'campaign.processing.lockUntil': lockUntil,
      'campaign.processing.renewedAt': now.toISOString(),
      updatedAt: now
    }
  }, {
    new: true
  }));

  return !!transaction;
}

async function ensureProcessingLease(projectId, transactionId, owner, deps) {
  var renewed = await renewProcessingLease(projectId, transactionId, owner, deps);
  if (renewed) return true;

  if (operationalLogger && operationalLogger.recordSafe) {
    operationalLogger.recordSafe({
      level: 'warn',
      area: 'waba_template_campaign',
      channel: 'waba',
      id_project: projectId,
      event: 'waba_template.campaign.processing_lease',
      status: 'lost',
      details: {
        transactionId: transactionId
      }
    });
  }

  return false;
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
  var recipients = Array.isArray(transaction.recipients) ? transaction.recipients : [];
  var hasPending = recipients.some(function(recipient) {
    return recipient && ['queued', 'retry', 'sending'].indexOf(recipient.status) !== -1;
  });
  if (hasPending) return transaction.status || 'running';
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

function logProcessingLeaseHeartbeatError(projectId, transactionId, err) {
  if (!operationalLogger || !operationalLogger.recordSafe) return;
  operationalLogger.recordSafe({
    level: 'warn',
    area: 'waba_template_campaign',
    channel: 'waba',
    id_project: projectId,
    event: 'waba_template.campaign.processing_lease',
    status: 'heartbeat_failed',
    details: {
      transactionId: transactionId,
      error: operationalLogger.extractErrorMessage(err)
    }
  });
}

function startProcessingLeaseHeartbeat(projectId, transactionId, owner, deps) {
  deps = deps || {};
  if (!owner || deps.disableProcessingLease === true) return null;

  var running = false;
  var intervalMs = getProcessingLeaseHeartbeatMs(deps);
  var setIntervalFn = deps.setIntervalFn || setInterval;
  var timer = setIntervalFn(function() {
    if (running) return;
    running = true;
    return ensureProcessingLease(projectId, transactionId, owner, deps)
      .catch(function(err) {
        logProcessingLeaseHeartbeatError(projectId, transactionId, err);
      })
      .then(function() {
        running = false;
      });
  }, intervalMs);
  safeUnref(timer);
  return timer;
}

function stopProcessingLeaseHeartbeat(timer, deps) {
  if (!timer) return;
  deps = deps || {};
  var clearIntervalFn = deps.clearIntervalFn || clearInterval;
  clearIntervalFn(timer);
}

async function withProcessingLeaseHeartbeat(projectId, transactionId, owner, deps, operation) {
  var timer = startProcessingLeaseHeartbeat(projectId, transactionId, owner, deps);
  try {
    return await operation();
  } finally {
    stopProcessingLeaseHeartbeat(timer, deps);
  }
}

async function delayWithProcessingLease(ms, projectId, transactionId, owner, deps) {
  return withProcessingLeaseHeartbeat(projectId, transactionId, owner, deps, function() {
    return delay(ms, deps);
  });
}

function recoverStaleSendingRecipients(transaction, deps) {
  deps = deps || {};
  var recipients = Array.isArray(transaction.recipients) ? transaction.recipients : [];
  var staleMs = deps.sendingStaleMs != null ? parseInt(deps.sendingStaleMs, 10) : getSendingStaleMs();
  var now = getNow(deps);
  var maxAttempts = getMaxAttempts();
  var changed = false;

  recipients.forEach(function(recipient) {
    if (!recipient || recipient.status !== 'sending') return;
    var updatedAt = recipient.updatedAt ? new Date(recipient.updatedAt) : null;
    var isStale = !updatedAt || isNaN(updatedAt.getTime()) || now.getTime() - updatedAt.getTime() >= staleMs;
    if (!isStale) return;

    if ((recipient.attempts || 0) >= maxAttempts) {
      recipient.status = 'failed';
      recipient.error = recipient.error || 'stale_sending_max_attempts_reached';
    } else {
      recipient.status = 'retry';
      recipient.error = recipient.error || 'stale_sending_recovered';
    }
    recipient.updatedAt = now;
    changed = true;
  });

  if (changed) {
    transaction.recipients = recipients;
    markRecipientsModified(transaction);
    transaction.updatedAt = now;
  }
  return changed;
}

function getSweepIntervalMs(options) {
  if (options && options.intervalMs) return options.intervalMs;
  return parsePositiveInt(process.env.WABA_TEMPLATE_CAMPAIGN_SCHEDULER_INTERVAL_SECONDS || '60', 60) * 1000;
}

function getSweepStartDelayMs(options) {
  if (options && options.startDelayMs !== undefined) return options.startDelayMs;
  return parsePositiveInt(process.env.WABA_TEMPLATE_CAMPAIGN_SCHEDULER_START_DELAY_SECONDS || '30', 30) * 1000;
}

function getSweepLimit(options) {
  if (options && options.limit) return options.limit;
  return parsePositiveInt(process.env.WABA_TEMPLATE_CAMPAIGN_SCHEDULER_LIMIT || '25', 25);
}

function boolEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  return process.env[name] === true || process.env[name] === 'true';
}

function scheduledSweepDisabledReason(options) {
  options = options || {};
  if (options.force) return null;
  if (!boolEnv('WABA_TEMPLATE_CAMPAIGN_SCHEDULER_ENABLED', true)) return 'env_disabled';
  if (backgroundWorkers.disabled()) return 'background_workers_disabled';
  return null;
}

function safeUnref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
}

async function findDueScheduledCampaigns(options, deps) {
  options = options || {};
  deps = deps || {};
  var TransactionModel = deps.Transaction || Transaction;
  var now = getNow(deps);
  var nowIso = now.toISOString();
  var staleMs = deps.sendingStaleMs != null ? parseInt(deps.sendingStaleMs, 10) : getSendingStaleMs();
  if (isNaN(staleMs) || staleMs < 0) staleMs = getSendingStaleMs();
  var staleDate = new Date(now.getTime() - staleMs);
  var finder = TransactionModel.find({
    dispatch_type: CAMPAIGN_TYPE,
    $or: [
      {
        status: 'scheduled',
        $or: [
          { 'campaign.nextRunAt': { $lte: nowIso } },
          { 'campaign.scheduledAt': { $lte: nowIso } }
        ]
      },
      {
        status: 'running',
        $or: [
          {
            recipients: {
              $elemMatch: {
                status: 'sending',
                $or: [
                  { updatedAt: { $lte: staleDate } },
                  { updatedAt: { $exists: false } },
                  { updatedAt: null }
                ]
              }
            }
          },
          {
            recipients: {
              $elemMatch: {
                status: { $in: ['queued', 'retry'] }
              }
            }
          }
        ]
      }
    ]
  });

  if (finder.limit) finder = finder.limit(getSweepLimit(options));
  if (finder.select) finder = finder.select('id_project transaction_id');
  if (finder.lean) finder = finder.lean();
  return finder.exec();
}

async function runScheduledCampaignSweep(options, deps) {
  options = options || {};
  deps = deps || {};

  if (scheduledSweepState.running) {
    scheduledSweepState.skippedCount += 1;
    return {
      ok: false,
      skipped: true,
      reason: 'already_running'
    };
  }

  scheduledSweepState.running = true;
  scheduledSweepState.lastRunAt = getNow(deps).toISOString();
  scheduledSweepState.lastError = null;

  try {
    var campaigns = await findDueScheduledCampaigns(options, deps);
    var processed = 0;
    var failed = 0;

    for (var i = 0; i < campaigns.length; i += 1) {
      var campaign = campaigns[i];
      var projectId = campaign.id_project;
      var transactionId = campaign.transaction_id;
      try {
        await processCampaign({
          projectId: projectId,
          transactionId: transactionId
        }, deps);
        processed += 1;
      } catch (err) {
        failed += 1;
        var message = err && err.message ? err.message : err;
        if (operationalLogger && operationalLogger.recordSafe) {
          operationalLogger.recordSafe({
            level: 'error',
            area: 'waba_template_campaign',
            channel: 'waba',
            id_project: projectId,
            event: 'waba_template.campaign.scheduled_sweep',
            status: 'failed',
            details: {
              transactionId: transactionId,
              error: message
            }
          });
        }
      }
    }

    scheduledSweepState.lastSuccessAt = getNow(deps).toISOString();
    scheduledSweepState.processedCount += processed;
    return {
      ok: failed === 0,
      matched: campaigns.length,
      processed: processed,
      failed: failed
    };
  } catch (err) {
    scheduledSweepState.lastFailureAt = getNow(deps).toISOString();
    scheduledSweepState.lastError = err.message;
    if (operationalLogger && operationalLogger.recordSafe) {
      operationalLogger.recordSafe({
        level: 'error',
        area: 'waba_template_campaign',
        channel: 'waba',
        event: 'waba_template.campaign.scheduled_sweep',
        status: 'failed',
        error: err
      });
    }
    return {
      ok: false,
      error: err.message
    };
  } finally {
    scheduledSweepState.running = false;
  }
}

function scheduleScheduledCampaignSweepRun(options, deps) {
  runScheduledCampaignSweep(options, deps).catch(function(err) {
    scheduledSweepState.lastFailureAt = new Date().toISOString();
    scheduledSweepState.lastError = err.message;
    if (operationalLogger && operationalLogger.recordSafe) {
      operationalLogger.recordSafe({
        level: 'error',
        area: 'waba_template_campaign',
        channel: 'waba',
        event: 'waba_template.campaign.scheduled_sweep',
        status: 'failed',
        error: err
      });
    }
  });
}

function startScheduledCampaignSweep(options, deps) {
  options = options || {};
  deps = deps || {};
  if (scheduledSweepState.started) {
    return Object.assign({ started: true, alreadyStarted: true }, scheduledCampaignSweepStatus());
  }

  var reason = scheduledSweepDisabledReason(options);
  if (reason) {
    return {
      started: false,
      reason: reason
    };
  }

  var setIntervalFn = options.setIntervalFn || setInterval;
  var setTimeoutFn = options.setTimeoutFn || setTimeout;
  var intervalMs = getSweepIntervalMs(options);
  var startDelayMs = getSweepStartDelayMs(options);

  scheduledSweepState.started = true;
  scheduledSweepState.intervalMs = intervalMs;
  scheduledSweepState.startDelayMs = startDelayMs;
  scheduledSweepState.timer = setIntervalFn(function() {
    scheduleScheduledCampaignSweepRun(options, deps);
  }, intervalMs);
  safeUnref(scheduledSweepState.timer);

  scheduledSweepState.startTimer = setTimeoutFn(function() {
    scheduledSweepState.startTimer = null;
    scheduleScheduledCampaignSweepRun(options, deps);
  }, startDelayMs);
  safeUnref(scheduledSweepState.startTimer);

  return Object.assign({ started: true }, scheduledCampaignSweepStatus());
}

function stopScheduledCampaignSweep(options) {
  options = options || {};
  var clearIntervalFn = options.clearIntervalFn || clearInterval;
  var clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  if (scheduledSweepState.timer) clearIntervalFn(scheduledSweepState.timer);
  if (scheduledSweepState.startTimer) clearTimeoutFn(scheduledSweepState.startTimer);
  scheduledSweepState.started = false;
  scheduledSweepState.running = false;
  scheduledSweepState.timer = null;
  scheduledSweepState.startTimer = null;
  scheduledSweepState.intervalMs = null;
  scheduledSweepState.startDelayMs = null;
}

function scheduledCampaignSweepStatus() {
  return {
    started: scheduledSweepState.started,
    running: scheduledSweepState.running,
    intervalMs: scheduledSweepState.intervalMs,
    startDelayMs: scheduledSweepState.startDelayMs,
    lastRunAt: scheduledSweepState.lastRunAt,
    lastSuccessAt: scheduledSweepState.lastSuccessAt,
    lastFailureAt: scheduledSweepState.lastFailureAt,
    lastError: scheduledSweepState.lastError,
    processedCount: scheduledSweepState.processedCount,
    skippedCount: scheduledSweepState.skippedCount
  };
}

function getCampaignNextRunAt(transaction) {
  var value = transaction && transaction.campaign && (transaction.campaign.nextRunAt || transaction.campaign.scheduledAt);
  if (!value) return null;
  var date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

async function scheduleCampaign(projectId, transactionId, deps) {
  deps = deps || {};
  if (deps.autostart === false) return;

  var transaction = await findTransaction(projectId, transactionId, deps);
  ensureCampaign(transaction);
  var nextRunAt = getCampaignNextRunAt(transaction);
  if (transaction.status === 'scheduled' && nextRunAt && nextRunAt.getTime() > getNow(deps).getTime()) {
    if (deps.runInBackground === false) return serializeTransaction(transaction);
    if (scheduledSweepDisabledReason(deps)) return serializeTransaction(transaction);
    var waitMs = Math.min(nextRunAt.getTime() - getNow(deps).getTime(), 2147483647);
    var setTimeoutFn = deps.setTimeoutFn || setTimeout;
    var timer = setTimeoutFn(function() {
      scheduleCampaign(projectId, transactionId, deps).catch(function(err) {
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
    }, waitMs);
    safeUnref(timer);
    return serializeTransaction(transaction);
  }

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

  var dryRun = options.dryRun === true || options.dryRun === 'true';
  var consentPolicy = requireCampaignConsent(options, dryRun);
  var resolvedRecipients = await resolveCampaignRecipients(options, deps);
  var recipients = resolvedRecipients.recipients;
  var firstRecipient = recipients[0] || {};
  var service = deps.publicationService || publicationService;
  var preview = await service.buildBoundWabaTemplateMessage(Object.assign({}, options, firstRecipient), deps);
  var binding = preview.binding || {};
  var transactionId = options.transactionId || ('waba-campaign-' + String(options.botId || 'bot') + '-' + Date.now() + '-' + uuidv4());
  var templateName = binding.providerTemplateName || binding.suggestionName || binding.name || 'waba_template';
  var requestedIntervalMs = options.intervalMs !== undefined && options.intervalMs !== null ? options.intervalMs : options.interval_ms;
  var throttlePolicy = buildThrottlePolicy(getDefaultIntervalMs(requestedIntervalMs), options, binding);
  var intervalMs = throttlePolicy.intervalMs;
  var scheduledAt = parseScheduledAt(options, deps);
  var now = getNow(deps);
  var initialStatus = scheduledAt ? 'scheduled' : 'queued';

  var TransactionModel = deps.Transaction || Transaction;
  var transaction = new TransactionModel({
    transaction_id: transactionId,
    id_project: options.projectId,
    template_name: templateName,
    status: initialStatus,
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
      audience: resolvedRecipients.audience,
      consent: consentPolicy,
      quality: {
        rating: throttlePolicy.qualityRating || null,
        allowLowQuality: throttlePolicy.allowLowQuality
      },
      throttle: {
        intervalMs: intervalMs,
        minIntervalMs: throttlePolicy.minIntervalMs
      },
      scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
      nextRunAt: scheduledAt ? scheduledAt.toISOString() : null,
      timezone: options.timezone || options.timeZone || process.env.CHATCASE_CAMPAIGN_TIMEZONE || 'America/Sao_Paulo'
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
  var leaseOwner = null;

  try {
    leaseOwner = await acquireProcessingLease(projectId, transactionId, deps);
    if (!leaseOwner) {
      var current = await findTransaction(projectId, transactionId, deps);
      ensureCampaign(current);
      return serializeTransaction(current);
    }

    while (true) {
      if (!(await ensureProcessingLease(projectId, transactionId, leaseOwner, deps))) {
        return serializeTransaction(await findTransaction(projectId, transactionId, deps));
      }

      var transaction = await findTransaction(projectId, transactionId, deps);
      ensureCampaign(transaction);

      if (['paused', 'canceled', 'completed', 'completed_with_errors', 'failed'].indexOf(transaction.status) !== -1) {
        return serializeTransaction(transaction);
      }

      if (transaction.status === 'scheduled') {
        var nextRunAt = getCampaignNextRunAt(transaction);
        var now = getNow(deps);
        if (nextRunAt && nextRunAt.getTime() > now.getTime()) {
          return serializeTransaction(transaction);
        }
        transaction.status = 'queued';
        transaction.updatedAt = now;
        await transaction.save();
        if (!(await ensureProcessingLease(projectId, transactionId, leaseOwner, deps))) {
          return serializeTransaction(await findTransaction(projectId, transactionId, deps));
        }
      }

      var recipients = Array.isArray(transaction.recipients) ? transaction.recipients : [];
      if (recoverStaleSendingRecipients(transaction, deps)) {
        await transaction.save();
        if (!(await ensureProcessingLease(projectId, transactionId, leaseOwner, deps))) {
          return serializeTransaction(await findTransaction(projectId, transactionId, deps));
        }
        recipients = Array.isArray(transaction.recipients) ? transaction.recipients : [];
      }

      var nextIndex = recipients.findIndex(function(recipient) {
        return recipient && (recipient.status === 'queued' || recipient.status === 'retry');
      });

      if (nextIndex === -1) {
        var hasSending = recipients.some(function(recipient) {
          return recipient && recipient.status === 'sending';
        });
        if (hasSending) {
          transaction.status = 'running';
          applyRecipientSummary(transaction);
          transaction.updatedAt = getNow(deps);
          await transaction.save();
          await ensureProcessingLease(projectId, transactionId, leaseOwner, deps);
          return serializeTransaction(transaction);
        }
        transaction.status = finalCampaignStatus(transaction);
        transaction.finishedAt = new Date();
        transaction.updatedAt = new Date();
        await transaction.save();
        await ensureProcessingLease(projectId, transactionId, leaseOwner, deps);
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
      if (!(await ensureProcessingLease(projectId, transactionId, leaseOwner, deps))) {
        return serializeTransaction(await findTransaction(projectId, transactionId, deps));
      }

      var result = null;
      try {
        var service = deps.publicationService || publicationService;
        result = await withProcessingLeaseHeartbeat(projectId, transactionId, leaseOwner, deps, function() {
          return service.dispatchBoundWabaTemplate({
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
        });
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

      if (!(await ensureProcessingLease(projectId, transactionId, leaseOwner, deps))) {
        return serializeTransaction(await findTransaction(projectId, transactionId, deps));
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
      if (!(await ensureProcessingLease(projectId, transactionId, leaseOwner, deps))) {
        return serializeTransaction(await findTransaction(projectId, transactionId, deps));
      }

      if (transaction.interval_ms > 0) {
        await delayWithProcessingLease(transaction.interval_ms, projectId, transactionId, leaseOwner, deps);
      }
    }
  } finally {
    try {
      await releaseProcessingLease(projectId, transactionId, leaseOwner, deps);
    } catch (err) {
      if (operationalLogger && operationalLogger.recordSafe) {
        operationalLogger.recordSafe({
          level: 'error',
          area: 'waba_template_campaign',
          channel: 'waba',
          id_project: projectId,
          event: 'waba_template.campaign.release_lease',
          status: 'failed',
          error: err
        });
      }
    }
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
    var nextRunAt = getCampaignNextRunAt(transaction);
    transaction.status = nextRunAt && nextRunAt.getTime() > getNow(deps).getTime() ? 'scheduled' : 'queued';
    transaction.pausedAt = null;
    transaction.updatedAt = getNow(deps);
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
  summarizeRecipients: summarizeRecipients,
  runScheduledCampaignSweep: runScheduledCampaignSweep,
  startScheduledCampaignSweep: startScheduledCampaignSweep,
  stopScheduledCampaignSweep: stopScheduledCampaignSweep,
  scheduledCampaignSweepStatus: scheduledCampaignSweepStatus
};
