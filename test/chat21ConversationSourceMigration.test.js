'use strict';

var expect = require('chai').expect;
var migration = require('../bin/migrate-chat21-conversation-source-metadata');

describe('Chat21ConversationSourceMigration', function() {
  it('builds scoped metadata updates from canonical requests', function() {
    var operations = migration.buildConversationUpdateOperations([{
      request_id: 'support-group-project-request',
      integrationId: 'integration-1',
      channel: { name: 'casezap' }
    }]);

    expect(operations).to.deep.equal([{
      updateMany: {
        filter: {
          $or: [
            { key: 'support-group-project-request' },
            { conversWith: 'support-group-project-request' }
          ]
        },
        update: {
          $set: {
            'attributes.request_channel': 'casezap',
            'attributes.integrationId': 'integration-1'
          }
        }
      }
    }]);
  });

  it('requires a project and defaults to dry-run mode', function() {
    expect(function() { migration.parseArgs([]); }).to.throw('--project is required');
    expect(migration.parseArgs(['--project', 'project-1'])).to.deep.equal({
      apply: false,
      backupPath: null,
      projectId: 'project-1'
    });
  });
});
