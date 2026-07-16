var Request = require('../models/request');
var ChannelConstants = require('../models/channelConstants');
var chat21 = require('../channels/chat21/chat21Client');
var chat21Config = require('../channels/chat21/chat21Config');
var operationalLogger = require('./operationalLogger');

function toPlainRequest(request) {
  if (!request) return null;
  if (typeof request.toJSON === 'function') return request.toJSON();
  if (typeof request.toObject === 'function') return request.toObject();
  return request;
}

function uniqueMembers(members) {
  var out = [];
  var seen = {};
  (members || []).forEach(function(member) {
    if (!member) return;
    var key = String(member);
    if (seen[key]) return;
    seen[key] = true;
    out.push(key);
  });
  return out;
}

function buildGroupPayload(request) {
  var requestObj = toPlainRequest(request);
  if (!requestObj) {
    var missingError = new Error('Request not found');
    missingError.status = 404;
    throw missingError;
  }

  var channelOutbound = requestObj.channelOutbound || {};
  if (channelOutbound.name !== ChannelConstants.CHAT21) {
    var channelError = new Error('Request does not use Chat21 as outbound channel');
    channelError.status = 409;
    throw channelError;
  }

  var members = uniqueMembers((requestObj.participants || []).concat([
    'system',
    requestObj.lead && requestObj.lead.lead_id
  ]));

  var attributes = Object.assign({}, requestObj.attributes || {});
  attributes.requester_id = requestObj.requester_id;
  attributes.projectId = requestObj.id_project;
  attributes.client = requestObj.userAgent || 'n.d.';
  attributes.sourcePage = requestObj.sourcePage;

  if (requestObj.channel && requestObj.channel.name) {
    attributes.request_channel = requestObj.channel.name;
  }
  if (requestObj.integrationId) {
    attributes.integrationId = String(requestObj.integrationId);
  }

  if (requestObj.lead) {
    attributes.userFullname = requestObj.lead.fullname;
    attributes.userEmail = requestObj.lead.email;
    attributes.senderAuthInfo = {
      authType: 'USER',
      authVar: { uid: requestObj.lead.lead_id }
    };
  }

  if (requestObj.department) {
    attributes.departmentId = requestObj.department._id;
    attributes.departmentName = requestObj.department.name;
  }

  var groupName = 'Guest';
  if (requestObj.lead && requestObj.lead.fullname) groupName = requestObj.lead.fullname;
  if (requestObj.subject) groupName = requestObj.subject;

  return {
    groupId: requestObj.request_id,
    groupName: groupName,
    members: members,
    attributes: attributes,
    id_project: requestObj.id_project,
    request_id: requestObj.request_id
  };
}

function isAlreadyExistsResult(result) {
  if (!result || result.success !== false) return false;
  var text = JSON.stringify(result).toLowerCase();
  return text.indexOf('already') !== -1 ||
    text.indexOf('exist') !== -1 ||
    text.indexOf('duplicate') !== -1 ||
    text.indexOf('409') !== -1;
}

function isFailureResult(result) {
  return result && result.success === false && !isAlreadyExistsResult(result);
}

function findRequest(requestId, projectId, RequestModel) {
  var query = { request_id: requestId };
  if (projectId) query.id_project = projectId;

  var finder = RequestModel.findOne(query);
  if (finder && typeof finder.populate === 'function') {
    finder = finder.populate('lead').populate('department');
  }
  if (finder && typeof finder.exec === 'function') return finder.exec();
  return finder;
}

function logRepair(logger, level, status, payload, error, details) {
  if (!logger || typeof logger.recordSafe !== 'function') return;
  logger.recordSafe({
    level: level,
    area: 'operation',
    channel: 'chat21',
    id_project: payload && payload.id_project,
    requestId: payload && payload.request_id,
    event: 'chat21.group.repair',
    status: status,
    error: error,
    details: Object.assign({
      groupId: payload && payload.groupId,
      membersCount: payload && payload.members ? payload.members.length : 0
    }, details || {})
  });
}

function createChat21GroupRepairService(deps) {
  deps = deps || {};
  var RequestModel = deps.Request || Request;
  var chatClient = deps.chat21 || chat21;
  var logger = deps.operationalLogger === undefined ? operationalLogger : deps.operationalLogger;
  var env = deps.env || process.env;
  var adminToken = env.CHAT21_ADMIN_TOKEN || chat21Config.adminToken;

  async function repairRequestGroup(options) {
    options = options || {};
    if (!options.request_id) {
      var validationError = new Error('request_id is required');
      validationError.status = 400;
      throw validationError;
    }

    var request = await findRequest(options.request_id, options.id_project, RequestModel);
    var payload = buildGroupPayload(request);

    if (options.dryRun) {
      logRepair(logger, 'info', 'dry_run', payload, null, { dryRun: true });
      return {
        status: 'dry_run',
        dryRun: true,
        payload: payload
      };
    }

    if (chatClient.auth && typeof chatClient.auth.setAdminToken === 'function') {
      chatClient.auth.setAdminToken(adminToken);
    }

    var createResult = await chatClient.groups.create(
      payload.groupName,
      payload.members,
      payload.attributes,
      payload.groupId
    );

    if (isFailureResult(createResult)) {
      var createError = new Error(createResult.error || createResult.message || 'Chat21 group creation failed');
      createError.status = 502;
      createError.result = createResult;
      logRepair(logger, 'error', 'failed', payload, createError, { createResult: createResult });
      throw createError;
    }

    if (isAlreadyExistsResult(createResult) && options.reconcileExisting !== false) {
      var membersResult = await chatClient.groups.setMembers(payload.members, payload.groupId);
      var attributesResult = await chatClient.groups.updateAttributes(payload.attributes, payload.groupId);
      logRepair(logger, 'info', 'updated_existing', payload, null, {
        createResult: createResult,
        membersResult: membersResult,
        attributesResult: attributesResult
      });
      return {
        status: 'updated_existing',
        groupId: payload.groupId,
        request_id: payload.request_id,
        id_project: payload.id_project,
        result: {
          create: createResult,
          members: membersResult,
          attributes: attributesResult
        }
      };
    }

    logRepair(logger, 'info', 'created', payload, null, { createResult: createResult });
    return {
      status: 'created',
      groupId: payload.groupId,
      request_id: payload.request_id,
      id_project: payload.id_project,
      result: createResult
    };
  }

  return {
    repairRequestGroup: repairRequestGroup
  };
}

module.exports = {
  buildGroupPayload: buildGroupPayload,
  createChat21GroupRepairService: createChat21GroupRepairService,
  isAlreadyExistsResult: isAlreadyExistsResult
};
