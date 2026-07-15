#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var mongoose = require('mongoose');
var config = require('../config/database');
var Lead = require('../models/lead');
var Request = require('../models/request');
var ChannelConstants = require('../models/channelConstants');
var LeadConstants = require('../models/leadConstants');
var phoneUtil = require('../utils/phoneUtil');

var LEGACY_CASEZAP_LEAD_ID = /^casezap-([0-9a-fA-F]{24})-(\d+)$/;

function normalizeCaseZapPhone(phone) {
  var normalized = phoneUtil.normalizePhone(phone);
  if (!normalized) return null;
  return String(normalized).replace(/\D/g, '') || null;
}

function extractLegacyCaseZapLead(lead) {
  if (!lead || !lead.lead_id || !lead.id_project) return null;

  var match = String(lead.lead_id).match(LEGACY_CASEZAP_LEAD_ID);
  if (!match) return null;

  var phone = normalizeCaseZapPhone(match[2]);
  if (!phone) return null;

  return {
    projectId: String(lead.id_project),
    phone: phone,
    integrationId: match[1].toLowerCase()
  };
}

function isSafeCaseZapRequest(request) {
  if (!request || !request.channel || request.channel.name !== ChannelConstants.CASEZAP) return false;
  return true;
}

function resolveRequestIntegrationId(request, leadsById) {
  if (request.integrationId) return String(request.integrationId);
  var lead = leadsById.get(String(request.lead));
  var identity = extractLegacyCaseZapLead(lead) || extractLegacyCaseZapLead(request.snapshot && request.snapshot.lead);
  return identity && identity.integrationId;
}

function buildRequestReferenceQuery(projectId, leadIds) {
  return {
    id_project: projectId,
    $or: [
      { lead: { $in: leadIds } },
      { 'snapshot.lead._id': { $in: leadIds } }
    ]
  };
}

function buildRequestReferenceProjection() {
  return {
    _id: 1,
    lead: 1,
    integrationId: 1,
    channel: 1,
    snapshot: 1
  };
}

async function findUnsafeRequests(requests) {
  return requests.filter(function(request) {
    return !isSafeCaseZapRequest(request);
  });
}

function firstValue(leads, field) {
  for (var lead of leads) {
    if (lead[field] !== undefined && lead[field] !== null && lead[field] !== '') return lead[field];
  }
  return undefined;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeObjects(base, override) {
  var merged = Object.assign({}, base || {});
  Object.keys(override || {}).forEach(function(key) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
    merged[key] = isPlainObject(merged[key]) && isPlainObject(override[key])
      ? mergeObjects(merged[key], override[key])
      : override[key];
  });
  return merged;
}

function mergeLeadData(plan, target) {
  var leads = [target].concat(plan.legacyLeads.filter(function(lead) {
    return String(lead._id) !== String(target._id);
  }));
  var activeLead = leads.find(function(lead) {
    return lead.status === undefined || lead.status < LeadConstants.DELETED;
  });
  var merged = {
    lead_id: plan.canonicalLeadId,
    phone: plan.phone,
    tags: Array.from(new Set(leads.flatMap(function(lead) { return lead.tags || []; }))),
    attributes: leads.slice().reverse().reduce(function(result, lead) {
      return mergeObjects(result, lead.attributes);
    }, {}),
    properties: leads.slice().reverse().reduce(function(result, lead) {
      return mergeObjects(result, lead.properties);
    }, {}),
    status: activeLead && activeLead.status !== undefined ? activeLead.status : LeadConstants.NORMAL
  };
  ['fullname', 'email', 'company', 'note', 'streetAddress', 'city', 'region', 'zipcode', 'country', 'createdBy'].forEach(function(field) {
    var value = firstValue(leads, field);
    if (value !== undefined) merged[field] = value;
  });
  return merged;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv) {
  var options = { apply: false };
  for (var index = 0; index < argv.length; index += 1) {
    var argument = argv[index];
    if (argument === '--apply') {
      options.apply = true;
    } else if (argument === '--report' || argument === '--backup') {
      var value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(argument + ' requires a path');
      options[argument.slice(2) + 'Path'] = path.resolve(value);
      index += 1;
    } else {
      throw new Error('Unknown argument: ' + argument);
    }
  }

  var suffix = timestamp();
  options.reportPath = options.reportPath || path.resolve('logs', 'casezap-lead-migration-' + suffix + '.report.json');
  options.backupPath = options.backupPath || path.resolve('logs', 'casezap-lead-migration-' + suffix + '.backup.json');
  return options;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function sortLeads(leads) {
  return leads.slice().sort(function(left, right) {
    var leftDate = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    var rightDate = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    if (leftDate !== rightDate) return leftDate - rightDate;
    return String(left._id).localeCompare(String(right._id));
  });
}

async function collectPlans() {
  var groups = new Map();
  var cursor = Lead.find({
    lead_id: /^casezap-[0-9a-fA-F]{24}-/,
    id_project: { $exists: true },
    status: { $lt: LeadConstants.DELETED }
  }).lean().cursor();

  for await (var lead of cursor) {
    var identity = extractLegacyCaseZapLead(lead);
    if (!identity) continue;
    var key = identity.projectId + ':' + identity.phone;
    if (!groups.has(key)) groups.set(key, {
      projectId: identity.projectId,
      phone: identity.phone,
      leads: []
    });
    groups.get(key).leads.push(lead);
  }

  var plans = [];
  for (var group of groups.values()) {
    var canonicalLeadId = 'casezap-' + group.phone;
    var canonical = await Lead.findOne({
      id_project: group.projectId,
      lead_id: canonicalLeadId
    }).lean();
    var orderedLeads = sortLeads(group.leads);

    var target = canonical || orderedLeads[0];
    var duplicateLeads = orderedLeads.filter(function(lead) {
      return String(lead._id) !== String(target._id);
    });
    if (duplicateLeads.length === 0 && canonical) continue;

    var sourceLeadIds = [target._id].concat(duplicateLeads.map(function(lead) { return lead._id; }));
    var requests = await Request.find(buildRequestReferenceQuery(group.projectId, sourceLeadIds))
      .select(buildRequestReferenceProjection())
      .lean();
    var unsafeRequests = await findUnsafeRequests(requests);

    plans.push({
      status: unsafeRequests.length ? 'skipped' : 'ready',
      skipReason: unsafeRequests.length ? 'non_casezap_request_reference' : null,
      projectId: group.projectId,
      phone: group.phone,
      canonicalLeadId: canonicalLeadId,
      canonical: target,
      legacyLeads: orderedLeads,
      duplicateLeads: duplicateLeads,
      requests: requests,
      unsafeRequestIds: unsafeRequests.map(function(request) { return request._id; }),
      requiresCanonicalRename: !canonical
    });
  }

  return plans;
}

function planSummary(plan) {
  return {
    status: plan.status,
    skipReason: plan.skipReason,
    projectId: plan.projectId,
    phone: plan.phone,
    canonicalLeadId: plan.canonicalLeadId,
    canonicalMongoId: plan.canonical && plan.canonical._id,
    legacyLeadIds: plan.legacyLeads.map(function(lead) { return lead._id; }),
    duplicateLeadIds: plan.duplicateLeads.map(function(lead) { return lead._id; }),
    requestIds: plan.requests.map(function(request) { return request._id; }),
    requestIntegrationIds: plan.requests.map(function(request) { return request.integrationId || null; }),
    unsafeRequestIds: plan.unsafeRequestIds || [],
    requiresCanonicalRename: Boolean(plan.requiresCanonicalRename)
  };
}

function buildBackup(plans) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    purpose: 'casezap duplicate lead migration',
    plans: plans.map(function(plan) {
      return {
        summary: planSummary(plan),
        leads: plan.legacyLeads.concat(plan.canonical).filter(function(lead, index, all) {
          return lead && all.findIndex(function(item) {
            return String(item._id) === String(lead._id);
          }) === index;
        }),
        requests: plan.requests
      };
    })
  };
}

function canonicalSnapshot(plan, target) {
  var snapshot = Object.assign({}, target);
  snapshot.lead_id = plan.canonicalLeadId;
  return snapshot;
}

async function applyPlan(plan) {
  var target = await Lead.findById(plan.canonical._id).lean();
  if (!target || String(target.id_project) !== plan.projectId) {
    throw new Error('Canonical target changed before apply');
  }

  var canonical = await Lead.findOne({
    id_project: plan.projectId,
    lead_id: plan.canonicalLeadId
  }).lean();
  if (plan.requiresCanonicalRename && canonical) {
    throw new Error('Canonical lead appeared before apply');
  }
  if (!plan.requiresCanonicalRename && (!canonical || String(canonical._id) !== String(target._id))) {
    throw new Error('Canonical lead changed before apply');
  }

  var duplicateIds = plan.duplicateLeads.map(function(lead) { return lead._id; });
  var sourceLeadIds = [target._id].concat(duplicateIds);
  var requests = await Request.find(buildRequestReferenceQuery(plan.projectId, sourceLeadIds))
    .select(buildRequestReferenceProjection())
    .lean();
  var sourceLeads = await Lead.find({ _id: { $in: sourceLeadIds }, id_project: plan.projectId }).lean();
  var unsafeRequests = await findUnsafeRequests(requests);
  if (unsafeRequests.length) {
    throw new Error('Refusing to merge non-CaseZap Request references');
  }

  var mergedLead = mergeLeadData(plan, target);
  var targetUpdate = await Lead.updateOne(
    { _id: target._id, id_project: plan.projectId },
    { $set: mergedLead }
  );
  if (!targetUpdate.n && !targetUpdate.matchedCount) {
    throw new Error('Canonical lead update was not applied');
  }

  var snapshot = canonicalSnapshot(plan, Object.assign({}, target, mergedLead));
  var sourceLeadIdSet = new Set(sourceLeadIds.map(String));
  var leadsById = new Map(sourceLeads.map(function(lead) {
    return [String(lead._id), lead];
  }));
  var requestOperations = requests.map(function(request) {
    var integrationId = resolveRequestIntegrationId(request, leadsById);
    var update = {
      'snapshot.lead': snapshot
    };
    if (integrationId) update.integrationId = integrationId;
    if (sourceLeadIdSet.has(String(request.lead))) update.lead = target._id;
    return {
      updateOne: {
        filter: { _id: request._id, id_project: plan.projectId },
        update: { $set: update }
      }
    };
  });
  var requestUpdate = requestOperations.length
    ? await Request.bulkWrite(requestOperations, { ordered: true })
    : { modifiedCount: 0, nModified: 0 };

  var remainingRequests = await Request.countDocuments(buildRequestReferenceQuery(plan.projectId, duplicateIds));
  if (remainingRequests !== 0) {
    throw new Error('Request references remain after update');
  }

  var remainingLeads = await Lead.countDocuments({
    _id: { $in: duplicateIds },
    id_project: plan.projectId
  });
  if (remainingLeads !== duplicateIds.length) {
    throw new Error('Legacy lead set changed before delete');
  }

  var archivedLeads = await Lead.updateMany({
    _id: { $in: duplicateIds },
    id_project: plan.projectId
  }, {
    $set: { status: LeadConstants.DELETED }
  });

  var activeDuplicates = await Lead.countDocuments({
    _id: { $in: duplicateIds },
    status: { $lt: LeadConstants.DELETED }
  });
  if (activeDuplicates !== 0) {
    throw new Error('Legacy leads remain active after archive');
  }

  return {
    status: 'applied',
    projectId: plan.projectId,
    phone: plan.phone,
    canonicalMongoId: target._id,
    updatedRequests: requestUpdate.modifiedCount || requestUpdate.nModified || 0,
    archivedLeads: archivedLeads.modifiedCount || archivedLeads.nModified || 0,
    preservedRequestIntegrationIds: requests.map(function(request) { return request.integrationId || null; })
  };
}

async function main(argv) {
  var options = parseArgs(argv);
  var databaseUri = process.env.DATABASE_URI || process.env.MONGODB_URI || process.env.MONGODB_URL || config.database;
  await mongoose.connect(databaseUri, { useNewUrlParser: true, useUnifiedTopology: true });

  try {
    var plans = await collectPlans();
    var backup = buildBackup(plans);
    var report = {
      version: 1,
      createdAt: new Date().toISOString(),
      dryRun: !options.apply,
      applyRequested: options.apply,
      backupPath: options.backupPath,
      reportPath: options.reportPath,
      summary: {
        groups: plans.length,
        ready: plans.filter(function(plan) { return plan.status === 'ready'; }).length,
        skipped: plans.filter(function(plan) { return plan.status === 'skipped'; }).length,
        applied: 0,
        failed: 0
      },
      plans: plans.map(planSummary),
      results: []
    };

    writeJson(options.backupPath, backup);
    writeJson(options.reportPath, report);

    if (options.apply) {
      for (var plan of plans) {
        if (plan.status !== 'ready') continue;
        try {
          var result = await applyPlan(plan);
          report.results.push(result);
          report.summary.applied += 1;
        } catch (error) {
          report.summary.failed += 1;
          report.results.push({
            status: 'failed',
            projectId: plan.projectId,
            phone: plan.phone,
            error: error.message
          });
          writeJson(options.reportPath, report);
          throw error;
        }
        writeJson(options.reportPath, report);
      }
    }

    console.log(JSON.stringify({
      dryRun: report.dryRun,
      groups: report.summary.groups,
      ready: report.summary.ready,
      skipped: report.summary.skipped,
      applied: report.summary.applied,
      backupPath: options.backupPath,
      reportPath: options.reportPath
    }));
    return report;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(function(error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  normalizeCaseZapPhone: normalizeCaseZapPhone,
  extractLegacyCaseZapLead: extractLegacyCaseZapLead,
  isSafeCaseZapRequest: isSafeCaseZapRequest,
  resolveRequestIntegrationId: resolveRequestIntegrationId,
  buildRequestReferenceQuery: buildRequestReferenceQuery,
  buildRequestReferenceProjection: buildRequestReferenceProjection,
  findUnsafeRequests: findUnsafeRequests,
  mergeLeadData: mergeLeadData,
  parseArgs: parseArgs,
  planSummary: planSummary
};
