#!/usr/bin/env node
'use strict';

var fs = require('fs');
var mongoose = require('mongoose');
var config = require('../config/database');
var Request = require('../models/request');

function parseArgs(argv) {
  var args = argv || [];
  var projectIndex = args.indexOf('--project');
  var backupIndex = args.indexOf('--backup');
  var projectId = projectIndex >= 0 ? args[projectIndex + 1] : null;

  if (!projectId) throw new Error('--project is required');

  return {
    apply: args.indexOf('--apply') >= 0,
    backupPath: backupIndex >= 0 ? args[backupIndex + 1] : null,
    projectId: projectId
  };
}

function buildConversationUpdateOperations(requests) {
  return (requests || []).filter(function(request) {
    return request.request_id && request.integrationId && request.channel && request.channel.name;
  }).map(function(request) {
    return {
      updateMany: {
        filter: {
          $or: [
            { key: request.request_id },
            { conversWith: request.request_id }
          ]
        },
        update: {
          $set: {
            'attributes.request_channel': String(request.channel.name),
            'attributes.integrationId': String(request.integrationId)
          }
        }
      }
    };
  });
}

async function main(argv) {
  var options = parseArgs(argv);
  if (options.apply && !options.backupPath) {
    throw new Error('--backup is required with --apply');
  }

  var databaseUri = process.env.DATABASE_URI || process.env.MONGODB_URI || process.env.MONGODB_URL || config.database;
  await mongoose.connect(databaseUri, { useNewUrlParser: true, useUnifiedTopology: true });

  try {
    var requests = await Request.find({
      id_project: options.projectId,
      'channel.name': 'casezap',
      integrationId: { $exists: true, $ne: null }
    }).select('request_id integrationId channel').lean();
    var operations = buildConversationUpdateOperations(requests);
    var requestIds = requests.map(function(request) { return String(request.request_id); });
    var conversations = mongoose.connection.client.db('chat21').collection('conversations');
    var filter = {
      $or: [
        { key: { $in: requestIds } },
        { conversWith: { $in: requestIds } }
      ]
    };
    var affected = await conversations.find(filter, {
      projection: { key: 1, conversWith: 1, timelineOf: 1, attributes: 1 }
    }).toArray();
    var invalidAttributes = affected.filter(function(conversation) {
      return conversation.attributes !== undefined && conversation.attributes !== null &&
        typeof conversation.attributes !== 'object';
    });
    if (invalidAttributes.length) {
      throw new Error('Invalid attributes in ' + invalidAttributes.length + ' conversations');
    }

    if (!options.apply) {
      return {
        status: 'dry_run',
        requests: requests.length,
        conversations: affected.length
      };
    }

    fs.writeFileSync(options.backupPath, JSON.stringify({
      projectId: options.projectId,
      createdAt: new Date().toISOString(),
      conversations: affected
    }, null, 2));

    var result = operations.length
      ? await conversations.bulkWrite(operations, { ordered: false })
      : { matchedCount: 0, modifiedCount: 0 };

    return {
      status: 'applied',
      requests: requests.length,
      conversations: affected.length,
      matched: result.matchedCount || result.nMatched || 0,
      modified: result.modifiedCount || result.nModified || 0,
      backupPath: options.backupPath
    };
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(function(result) {
    console.log(JSON.stringify(result));
  }).catch(function(error) {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  buildConversationUpdateOperations: buildConversationUpdateOperations,
  parseArgs: parseArgs
};
