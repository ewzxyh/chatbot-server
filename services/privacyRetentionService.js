var AuditEvent = require('../models/auditEvent');
var Lead = require('../models/lead');
var Message = require('../models/message');
var Request = require('../models/request');
var RequestConstants = require('../models/requestConstants');
var fileStorageServiceFactory = require('./fileStorageServiceFactory');
var privacyService = require('./privacyService');

var REMOVED_ATTACHMENT_TEXT = '[anexo removido por politica de retencao]';

var ATTACHMENT_METADATA_KEYS = [
  'src',
  'url',
  'file',
  'downloadUrl',
  'downloadURL',
  'thumbnail',
  'thumbnailUrl',
  'thumbnailURL',
  'cdnUrl',
  'downloadCdnUrl',
  'thumbnailCdnUrl',
  'externalSrc'
];

function daysAgo(days, now) {
  return new Date((now || new Date()).getTime() - (days * 24 * 60 * 60 * 1000));
}

function decodeMaybe(value) {
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return value;
  }
}

function normalizeUploadPath(value) {
  if (!value) return null;
  var text = String(value).trim();
  if (!text) return null;

  if (text.indexOf('uploads/') === 0) {
    return text;
  }

  var pathMatch = text.match(/[?&]path=([^&#\s)]+)/);
  if (pathMatch && pathMatch[1]) {
    var decoded = decodeMaybe(pathMatch[1]);
    if (decoded.indexOf('uploads/') === 0) return decoded;
  }

  var uploadMatch = text.match(/(uploads\/[^\s)'"]+)/);
  if (uploadMatch && uploadMatch[1]) {
    return decodeMaybe(uploadMatch[1]);
  }

  return null;
}

function collectFilePathsFromValue(value, paths) {
  if (!value || typeof value !== 'string') return;

  var direct = normalizeUploadPath(value);
  if (direct) paths[direct] = true;

  var pathRegex = /[?&]path=([^&#\s)]+)/g;
  var match;
  while ((match = pathRegex.exec(value)) !== null) {
    var decoded = decodeMaybe(match[1]);
    if (decoded.indexOf('uploads/') === 0) paths[decoded] = true;
  }
}

function extractFilePathsFromMessage(message) {
  var paths = {};
  var metadata = message && message.metadata ? message.metadata : {};
  ATTACHMENT_METADATA_KEYS.forEach(function(key) {
    collectFilePathsFromValue(metadata[key], paths);
  });
  collectFilePathsFromValue(message && message.text, paths);
  return Object.keys(paths);
}

function hasUploadPathInText(text) {
  return !!normalizeUploadPath(text);
}

function shouldIgnoreFileNotFound(err) {
  return err && (err.code === 'ENOENT' || err.msg === 'File not found' || err.message === 'File not found');
}

function defaultFileServices() {
  var services = [
    fileStorageServiceFactory.createPrimaryFileService('files'),
    fileStorageServiceFactory.createPrimaryFileService('images')
  ];

  if (fileStorageServiceFactory.isObjectStorageEnabled()) {
    services = services.concat(fileStorageServiceFactory.createLegacyFallbackFileServices(['files', 'images']));
  }

  return services;
}

async function deletePathFromServices(path, fileServices) {
  var missing = 0;
  for (var i = 0; i < fileServices.length; i++) {
    try {
      await fileServices[i].deleteFile(path);
      return { deleted: true, missing: missing };
    } catch (err) {
      if (shouldIgnoreFileNotFound(err)) {
        missing += 1;
      } else {
        return { deleted: false, missing: missing, error: err.message || String(err) };
      }
    }
  }
  return { deleted: false, missing: missing > 0 ? 1 : 0 };
}

async function deleteReferencedFiles(paths, fileServices, counters) {
  var unique = {};
  paths.forEach(function(path) {
    if (path) unique[path] = true;
  });
  var list = Object.keys(unique);

  for (var i = 0; i < list.length; i++) {
    counters.attachmentsMatched += 1;
    var result = await deletePathFromServices(list[i], fileServices);
    if (result.deleted) {
      counters.attachmentsDeleted += 1;
    } else if (result.error) {
      counters.attachmentDeleteErrors += 1;
    } else {
      counters.attachmentsMissing += 1;
    }
  }
}

function projectFilter(projectId) {
  return projectId ? { id_project: String(projectId) } : {};
}

function oldClosedConversationQuery(cutoff, projectId) {
  var query = projectFilter(projectId);
  query.status = RequestConstants.CLOSED;
  query.$or = [
    { closed_at: { $lt: cutoff } },
    { closed_at: { $exists: false }, updatedAt: { $lt: cutoff } },
    { closed_at: null, updatedAt: { $lt: cutoff } }
  ];
  return query;
}

function attachmentCandidateQuery(cutoff, projectId) {
  var query = projectFilter(projectId);
  query.createdAt = { $lt: cutoff };
  query['metadata.privacy.attachmentRetained'] = { $ne: true };
  query.$or = ATTACHMENT_METADATA_KEYS.map(function(key) {
    var field = {};
    field['metadata.' + key] = { $exists: true, $ne: null };
    return field;
  });
  query.$or.push({ text: /uploads\// });
  query.$or.push({ text: /[?&]path=uploads%2F/i });
  return query;
}

function oldLeadQuery(cutoff, projectId) {
  var query = projectFilter(projectId);
  query.createdAt = { $lt: cutoff };
  query['attributes.privacy.anonymized'] = { $ne: true };
  return query;
}

function requestQueryForLead(lead) {
  var or = [{ lead: lead._id }];
  if (lead.lead_id) or.push({ 'snapshot.lead.lead_id': lead.lead_id });
  if (lead.email) {
    or.push({ 'snapshot.lead.email': lead.email });
    or.push({ 'contact.email': lead.email });
  }
  if (lead.phone) {
    or.push({ 'snapshot.lead.phone': lead.phone });
    or.push({ 'contact.phone': lead.phone });
  }
  return { id_project: String(lead.id_project), $or: or };
}

function resultSkeleton(options, config, now) {
  var auditCutoff = daysAgo(config.auditEventRetentionDays, now);
  var conversationCutoff = daysAgo(config.conversationRetentionDays, now);
  var attachmentCutoff = daysAgo(config.attachmentRetentionDays, now);
  var leadCutoff = daysAgo(config.leadRetentionDays, now);

  return {
    generatedAt: now.toISOString(),
    dryRun: options.dryRun !== false,
    project_id: options.projectId ? String(options.projectId) : null,
    source: options.source || 'manual',
    config: config,
    cutoffs: {
      auditEventsBefore: auditCutoff.toISOString(),
      conversationsBefore: conversationCutoff.toISOString(),
      attachmentsBefore: attachmentCutoff.toISOString(),
      leadsBefore: leadCutoff.toISOString()
    },
    counts: {
      auditEventsMatched: 0,
      auditEventsDeleted: 0,
      requestsMatched: 0,
      requestsDeleted: 0,
      messagesMatched: 0,
      messagesDeleted: 0,
      messagesUpdated: 0,
      attachmentsMatched: 0,
      attachmentsDeleted: 0,
      attachmentsMissing: 0,
      attachmentDeleteErrors: 0,
      leadsMatched: 0,
      leadsDeleted: 0,
      leadsSkippedWithRequests: 0
    }
  };
}

function normalizedScopes(scopes) {
  scopes = scopes || {};
  var hasAny = ['audit', 'conversations', 'attachments', 'leads'].some(function(key) {
    return scopes[key] !== undefined;
  });
  if (!hasAny) {
    return { audit: true, conversations: true, attachments: true, leads: true };
  }
  return {
    audit: scopes.audit !== false,
    conversations: scopes.conversations !== false,
    attachments: scopes.attachments !== false,
    leads: scopes.leads !== false
  };
}

async function countCandidates(options) {
  options = options || {};
  var config = privacyService.getRetentionConfig();
  var now = options.now || new Date();
  var result = resultSkeleton({ dryRun: true, projectId: options.projectId, source: 'status' }, config, now);

  result.counts.auditEventsMatched = await AuditEvent.countDocuments({
    timestamp: { $lt: daysAgo(config.auditEventRetentionDays, now) }
  });
  result.counts.requestsMatched = await Request.countDocuments(
    oldClosedConversationQuery(daysAgo(config.conversationRetentionDays, now), options.projectId)
  );
  result.counts.messagesMatched = await Message.countDocuments(
    attachmentCandidateQuery(daysAgo(config.attachmentRetentionDays, now), options.projectId)
  );
  result.counts.leadsMatched = await Lead.countDocuments(
    oldLeadQuery(daysAgo(config.leadRetentionDays, now), options.projectId)
  );

  return result;
}

async function pruneAuditEvents(result, now) {
  var cutoff = daysAgo(result.config.auditEventRetentionDays, now);
  var query = { timestamp: { $lt: cutoff } };
  result.counts.auditEventsMatched = await AuditEvent.countDocuments(query);
  if (!result.dryRun) {
    var deleted = await AuditEvent.deleteMany(query);
    result.counts.auditEventsDeleted = deleted.deletedCount || deleted.n || 0;
  }
}

async function pruneConversations(result, options, now) {
  var cutoff = daysAgo(result.config.conversationRetentionDays, now);
  var limit = options.limit || result.config.retentionBatchLimit;
  var query = oldClosedConversationQuery(cutoff, options.projectId);
  var requests = await Request.find(query).select('_id request_id').limit(limit).lean();
  var requestIds = requests.map(function(request) { return request.request_id; }).filter(Boolean);

  result.counts.requestsMatched = await Request.countDocuments(query);
  if (requestIds.length === 0) return;

  var messageQuery = { recipient: { $in: requestIds } };
  if (options.projectId) messageQuery.id_project = String(options.projectId);
  var messages = await Message.find(messageQuery).select('_id text metadata').lean();
  result.counts.messagesMatched += messages.length;

  if (result.dryRun) return;

  if (result.config.retentionDeleteAttachments) {
    var paths = [];
    messages.forEach(function(message) {
      paths = paths.concat(extractFilePathsFromMessage(message));
    });
    await deleteReferencedFiles(paths, options.fileServices || defaultFileServices(), result.counts);
  }

  var messageDelete = await Message.deleteMany(messageQuery);
  result.counts.messagesDeleted += messageDelete.deletedCount || messageDelete.n || 0;

  var requestDelete = await Request.deleteMany({ _id: { $in: requests.map(function(request) { return request._id; }) } });
  result.counts.requestsDeleted += requestDelete.deletedCount || requestDelete.n || 0;
}

function attachmentUnsetFields() {
  var unset = {};
  ATTACHMENT_METADATA_KEYS.forEach(function(key) {
    unset['metadata.' + key] = '';
  });
  return unset;
}

async function pruneAttachments(result, options, now) {
  var cutoff = daysAgo(result.config.attachmentRetentionDays, now);
  var limit = options.attachmentLimit || result.config.retentionAttachmentBatchLimit;
  var query = attachmentCandidateQuery(cutoff, options.projectId);
  var messages = await Message.find(query).select('_id text metadata').limit(limit).lean();

  result.counts.messagesMatched += messages.length;
  if (messages.length === 0) return;
  if (result.dryRun) return;

  var fileServices = options.fileServices || defaultFileServices();
  for (var i = 0; i < messages.length; i++) {
    var message = messages[i];
    var paths = extractFilePathsFromMessage(message);
    if (result.config.retentionDeleteAttachments) {
      await deleteReferencedFiles(paths, fileServices, result.counts);
    }

    var update = {
      $set: {
        'metadata.privacy.attachmentRetained': true,
        'metadata.privacy.attachmentRetainedAt': now,
        'metadata.privacy.attachmentRetainedReason': 'retention_policy'
      },
      $unset: attachmentUnsetFields()
    };
    if (hasUploadPathInText(message.text)) {
      update.$set.text = REMOVED_ATTACHMENT_TEXT;
    }

    var updated = await Message.updateOne({ _id: message._id }, update);
    result.counts.messagesUpdated += updated.nModified || updated.modifiedCount || 0;
  }
}

async function pruneLeads(result, options, now) {
  var cutoff = daysAgo(result.config.leadRetentionDays, now);
  var limit = options.limit || result.config.retentionBatchLimit;
  var leads = await Lead.find(oldLeadQuery(cutoff, options.projectId)).select('_id lead_id email phone id_project').limit(limit).lean();
  result.counts.leadsMatched = await Lead.countDocuments(oldLeadQuery(cutoff, options.projectId));

  if (leads.length === 0 || result.dryRun) return;

  var deleteIds = [];
  for (var i = 0; i < leads.length; i++) {
    var requestCount = await Request.countDocuments(requestQueryForLead(leads[i]));
    if (requestCount > 0) {
      result.counts.leadsSkippedWithRequests += 1;
    } else {
      deleteIds.push(leads[i]._id);
    }
  }

  if (deleteIds.length > 0) {
    var deleted = await Lead.deleteMany({ _id: { $in: deleteIds } });
    result.counts.leadsDeleted = deleted.deletedCount || deleted.n || 0;
  }
}

async function runRetention(options) {
  options = options || {};
  var config = privacyService.getRetentionConfig();
  var now = options.now || new Date();
  var scopes = normalizedScopes(options.scopes);
  var result = resultSkeleton(options, config, now);

  if (scopes.audit) await pruneAuditEvents(result, now);
  if (scopes.conversations) await pruneConversations(result, options, now);
  if (scopes.attachments) await pruneAttachments(result, options, now);
  if (scopes.leads) await pruneLeads(result, options, now);

  result.scopes = scopes;
  return result;
}

async function getStatus(options) {
  var status = await countCandidates(options || {});
  status.job = options && options.jobStatus ? options.jobStatus : null;
  return status;
}

module.exports = {
  REMOVED_ATTACHMENT_TEXT: REMOVED_ATTACHMENT_TEXT,
  extractFilePathsFromMessage: extractFilePathsFromMessage,
  getStatus: getStatus,
  runRetention: runRetention
};
