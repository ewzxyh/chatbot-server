var mongoose = require('mongoose');
var Lead = require('../models/lead');
var Request = require('../models/request');
var Message = require('../models/message');

var ANONYMIZED_NAME = 'Contato anonimizado';
var ANONYMIZED_TEXT = '[mensagem anonimizada por LGPD]';

function parsePositiveInt(value, fallback, max) {
  var parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function normalizeIdentifier(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  var normalized = normalizeIdentifier(value);
  return normalized ? normalized.toLowerCase() : '';
}

function normalizePhone(value) {
  return normalizeIdentifier(value).replace(/\D/g, '');
}

function unique(values) {
  var result = [];
  var seen = {};
  for (var i = 0; i < values.length; i++) {
    var value = values[i];
    if (value === undefined || value === null || value === '') continue;
    var stringValue = String(value);
    if (!seen[stringValue]) {
      seen[stringValue] = true;
      result.push(stringValue);
    }
  }
  return result;
}

function maskIdentifier(value) {
  var identifier = normalizeIdentifier(value);
  if (!identifier) return '';
  if (identifier.indexOf('@') !== -1) {
    var parts = identifier.split('@');
    var local = parts[0] || '';
    var domain = parts.slice(1).join('@');
    return (local.length > 2 ? local.substring(0, 2) : local.substring(0, 1)) + '***@' + domain;
  }
  var digits = normalizePhone(identifier);
  if (digits.length >= 8) {
    return digits.substring(0, 4) + '***' + digits.substring(digits.length - 2);
  }
  if (identifier.length <= 4) return identifier.substring(0, 1) + '***';
  return identifier.substring(0, 2) + '***' + identifier.substring(identifier.length - 2);
}

function getRetentionConfig() {
  return {
    auditEventRetentionDays: parsePositiveInt(process.env.AUDIT_EVENT_RETENTION_DAYS, 365),
    conversationRetentionDays: parsePositiveInt(process.env.PRIVACY_CONVERSATION_RETENTION_DAYS, 1095),
    attachmentRetentionDays: parsePositiveInt(process.env.PRIVACY_ATTACHMENT_RETENTION_DAYS, 1095),
    leadRetentionDays: parsePositiveInt(process.env.PRIVACY_LEAD_RETENTION_DAYS, 1095),
    retentionBatchLimit: parsePositiveInt(process.env.PRIVACY_RETENTION_BATCH_LIMIT, 500, 5000),
    retentionAttachmentBatchLimit: parsePositiveInt(process.env.PRIVACY_RETENTION_ATTACHMENT_BATCH_LIMIT, 500, 5000),
    retentionDeleteAttachments: parseBoolean(process.env.PRIVACY_RETENTION_DELETE_ATTACHMENTS, true),
    retentionJobEnabled: parseBoolean(process.env.PRIVACY_RETENTION_JOB_ENABLED, false),
    retentionJobDryRun: parseBoolean(process.env.PRIVACY_RETENTION_JOB_DRY_RUN, true),
    retentionJobIntervalHours: parsePositiveInt(process.env.PRIVACY_RETENTION_JOB_INTERVAL_HOURS, 24, 168),
    retentionJobStartDelaySeconds: parsePositiveInt(process.env.PRIVACY_RETENTION_JOB_START_DELAY_SECONDS, 300, 86400),
    exportMaxRequests: parsePositiveInt(process.env.PRIVACY_EXPORT_MAX_REQUESTS, 100, 500),
    exportMaxMessages: parsePositiveInt(process.env.PRIVACY_EXPORT_MAX_MESSAGES, 500, 5000),
    anonymizeMessageText: parseBoolean(process.env.PRIVACY_ANONYMIZE_MESSAGE_TEXT, true)
  };
}

function buildLeadQuery(projectId, identifier) {
  var value = normalizeIdentifier(identifier);
  var email = normalizeEmail(value);
  var phone = normalizePhone(value);
  var or = [
    { lead_id: value },
    { email: value },
    { phone: value }
  ];
  if (email && email !== value) or.push({ email: email });
  if (phone && phone !== value) or.push({ phone: phone });
  if (mongoose.Types.ObjectId.isValid(value)) or.push({ _id: value });
  return { id_project: String(projectId), $or: or };
}

function collectIdentifiers(lead, identifier) {
  var values = [identifier];
  if (lead) {
    values.push(lead._id);
    values.push(lead.lead_id);
    values.push(lead.email);
    values.push(lead.phone);
  }
  var normalizedPhone = normalizePhone(identifier);
  if (normalizedPhone) values.push(normalizedPhone);
  var normalizedEmail = normalizeEmail(identifier);
  if (normalizedEmail) values.push(normalizedEmail);
  return unique(values);
}

function buildRequestQuery(projectId, lead, identifier) {
  var value = normalizeIdentifier(identifier);
  var email = normalizeEmail(value);
  var phone = normalizePhone(value);
  var or = [];

  if (lead) {
    or.push({ lead: lead._id });
    or.push({ 'snapshot.lead._id': lead._id });
    or.push({ 'snapshot.lead.lead_id': lead.lead_id });
    if (lead.email) {
      or.push({ 'snapshot.lead.email': lead.email });
      or.push({ 'contact.email': lead.email });
    }
    if (lead.phone) {
      or.push({ 'snapshot.lead.phone': lead.phone });
      or.push({ 'contact.phone': lead.phone });
      var leadPhone = normalizePhone(lead.phone);
      if (leadPhone && leadPhone !== lead.phone) or.push({ 'contact.phone': leadPhone });
    }
  }

  if (value) {
    or.push({ 'contact.email': value });
    or.push({ 'contact.phone': value });
    or.push({ 'contact.external_id': value });
    or.push({ 'snapshot.lead.email': value });
    or.push({ 'snapshot.lead.phone': value });
    or.push({ 'snapshot.lead.lead_id': value });
  }
  if (email && email !== value) {
    or.push({ 'contact.email': email });
    or.push({ 'snapshot.lead.email': email });
  }
  if (phone && phone !== value) {
    or.push({ 'contact.phone': phone });
    or.push({ 'snapshot.lead.phone': phone });
  }

  if (or.length === 0) return null;
  return { id_project: String(projectId), $or: or };
}

function buildMessageQuery(projectId, requestIds, identifiers) {
  var or = [];
  if (requestIds && requestIds.length > 0) {
    or.push({ recipient: { $in: requestIds } });
  }
  if (identifiers && identifiers.length > 0) {
    or.push({ sender: { $in: identifiers } });
  }
  if (or.length === 0) return null;
  return { id_project: String(projectId), $or: or };
}

async function resolveContact(projectId, identifier) {
  var lead = await Lead.findOne(buildLeadQuery(projectId, identifier)).lean();
  var requestQuery = buildRequestQuery(projectId, lead, identifier);

  if (!lead && requestQuery) {
    var request = await Request.findOne(requestQuery).select('lead snapshot contact').lean();
    if (request && request.lead) {
      lead = await Lead.findById(request.lead).lean();
      requestQuery = buildRequestQuery(projectId, lead, identifier);
    }
  }

  return {
    lead: lead,
    requestQuery: requestQuery || buildRequestQuery(projectId, lead, identifier),
    identifiers: collectIdentifiers(lead, identifier)
  };
}

async function exportContact(projectId, identifier) {
  var config = getRetentionConfig();
  var resolved = await resolveContact(projectId, identifier);
  var requests = [];
  var messages = [];
  var requestCount = 0;
  var messageCount = 0;

  if (resolved.requestQuery) {
    requestCount = await Request.countDocuments(resolved.requestQuery);
    requests = await Request.find(resolved.requestQuery)
      .sort({ createdAt: -1 })
      .limit(config.exportMaxRequests)
      .lean();
  }

  var requestIds = requests.map(function(request) { return request.request_id; }).filter(Boolean);
  var messageQuery = buildMessageQuery(projectId, requestIds, resolved.identifiers);
  if (messageQuery) {
    messageCount = await Message.countDocuments(messageQuery);
    messages = await Message.find(messageQuery)
      .sort({ createdAt: 1 })
      .limit(config.exportMaxMessages)
      .lean();
  }

  if (!resolved.lead && requestCount === 0 && messageCount === 0) {
    var notFound = new Error('Contact not found');
    notFound.statusCode = 404;
    throw notFound;
  }

  return {
    generatedAt: new Date().toISOString(),
    project_id: String(projectId),
    identifier: maskIdentifier(identifier),
    config: config,
    matched: {
      leadFound: !!resolved.lead,
      requestCount: requestCount,
      messageCount: messageCount,
      requestsTruncated: requestCount > requests.length,
      messagesTruncated: messageCount > messages.length
    },
    data: {
      lead: resolved.lead || null,
      requests: requests,
      messages: messages
    }
  };
}

function leadAnonymizeUpdate(actorEmail) {
  return {
    fullname: ANONYMIZED_NAME,
    email: null,
    phone: null,
    company: null,
    note: null,
    streetAddress: null,
    city: null,
    region: null,
    zipcode: null,
    country: null,
    tags: [],
    attributes: {
      privacy: {
        anonymized: true,
        anonymizedAt: new Date(),
        anonymizedBy: actorEmail || 'superadmin'
      }
    },
    properties: {}
  };
}

function requestAnonymizeUpdate(actorEmail) {
  var privacy = {
    anonymized: true,
    anonymizedAt: new Date(),
    anonymizedBy: actorEmail || 'superadmin'
  };
  return {
    subject: '[anonimizado por LGPD]',
    first_text: ANONYMIZED_TEXT,
    transcript: null,
    sourcePage: null,
    userAgent: null,
    location: null,
    contact: {
      phone: null,
      email: null,
      external_id: null
    },
    attributes: {
      privacy: privacy
    },
    'snapshot.lead.fullname': ANONYMIZED_NAME,
    'snapshot.lead.email': null,
    'snapshot.lead.phone': null,
    'snapshot.lead.company': null,
    'snapshot.lead.note': null,
    'snapshot.lead.streetAddress': null,
    'snapshot.lead.city': null,
    'snapshot.lead.region': null,
    'snapshot.lead.zipcode': null,
    'snapshot.lead.country': null,
    'snapshot.lead.tags': [],
    'snapshot.lead.attributes': { privacy: privacy },
    'snapshot.lead.properties': {}
  };
}

async function anonymizeContact(projectId, identifier, options) {
  options = options || {};
  var actorEmail = options.actorEmail || 'superadmin';
  var config = getRetentionConfig();
  var resolved = await resolveContact(projectId, identifier);
  var requestIds = [];
  var requestCount = 0;

  if (resolved.requestQuery) {
    var requests = await Request.find(resolved.requestQuery).select('_id request_id').lean();
    requestCount = requests.length;
    requestIds = requests.map(function(request) { return request.request_id; }).filter(Boolean);
  }

  if (!resolved.lead && requestCount === 0) {
    var notFound = new Error('Contact not found');
    notFound.statusCode = 404;
    throw notFound;
  }

  var leadResult = { nModified: 0 };
  if (resolved.lead) {
    leadResult = await Lead.updateOne({ _id: resolved.lead._id, id_project: String(projectId) }, { $set: leadAnonymizeUpdate(actorEmail) });
  }

  var requestResult = { nModified: 0 };
  if (resolved.requestQuery) {
    requestResult = await Request.updateMany(resolved.requestQuery, { $set: requestAnonymizeUpdate(actorEmail) });
  }

  var messageTextResult = { nModified: 0 };
  var messageIdentityResult = { nModified: 0 };
  var messageQuery = buildMessageQuery(projectId, requestIds, resolved.identifiers);
  if (messageQuery && config.anonymizeMessageText) {
    messageTextResult = await Message.updateMany(messageQuery, {
      $set: {
        text: ANONYMIZED_TEXT,
        metadata: { privacy: { anonymized: true, anonymizedAt: new Date(), anonymizedBy: actorEmail } },
        attributes: { privacy: { anonymized: true, anonymizedAt: new Date(), anonymizedBy: actorEmail } }
      }
    });
  }
  if (resolved.identifiers.length > 0) {
    messageIdentityResult = await Message.updateMany({
      id_project: String(projectId),
      sender: { $in: resolved.identifiers }
    }, {
      $set: {
        senderFullname: ANONYMIZED_NAME
      }
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    project_id: String(projectId),
    identifier: maskIdentifier(identifier),
    reason: options.reason || null,
    counts: {
      leadsMatched: resolved.lead ? 1 : 0,
      leadsModified: leadResult.nModified || leadResult.modifiedCount || 0,
      requestsMatched: requestCount,
      requestsModified: requestResult.nModified || requestResult.modifiedCount || 0,
      messagesModified: messageTextResult.nModified || messageTextResult.modifiedCount || 0,
      messageIdentitiesModified: messageIdentityResult.nModified || messageIdentityResult.modifiedCount || 0
    },
    config: config
  };
}

module.exports = {
  ANONYMIZED_NAME: ANONYMIZED_NAME,
  ANONYMIZED_TEXT: ANONYMIZED_TEXT,
  getRetentionConfig: getRetentionConfig,
  maskIdentifier: maskIdentifier,
  exportContact: exportContact,
  anonymizeContact: anonymizeContact
};
