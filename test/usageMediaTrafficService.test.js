process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

var assert = require('assert');
var usageMediaTrafficService = require('../services/usageMediaTrafficService');

describe('usageMediaTrafficService', function() {
  it('aggregates served media traffic by project and endpoint day', async function() {
    var calls = [];
    var service = usageMediaTrafficService.createUsageMediaTrafficService({
      now: function() { return new Date('2026-05-20T15:30:00.000Z'); },
      UsageMediaTrafficDaily: {
        updateOne: async function(filter, update, options) {
          calls.push({ filter: filter, update: update, options: options });
          return { modifiedCount: 1 };
        }
      }
    });

    var result = await service.recordServedFile({
      projectId: 'project-1',
      path: 'uploads/users/u1/files/f1/manual.pdf',
      bytes: 2048,
      endpoint: 'files.download'
    });

    assert.strictEqual(result.status, 'recorded');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].filter.id_project, 'project-1');
    assert.strictEqual(calls[0].filter.endpoint, 'files.download');
    assert.strictEqual(calls[0].filter.path, 'uploads/users/u1/files/f1/manual.pdf');
    assert.strictEqual(calls[0].filter.day.toISOString(), '2026-05-20T00:00:00.000Z');
    assert.deepStrictEqual(calls[0].update.$inc, { requests: 1, bytes: 2048 });
    assert.strictEqual(calls[0].options.upsert, true);
  });

  it('infers project id from project asset paths', async function() {
    var capturedFilter;
    var service = usageMediaTrafficService.createUsageMediaTrafficService({
      now: function() { return new Date('2026-05-20T15:30:00.000Z'); },
      UsageMediaTrafficDaily: {
        updateOne: async function(filter) {
          capturedFilter = filter;
        }
      }
    });

    await service.recordServedFile({
      path: 'uploads/projects/project-asset-1/files/a/logo.png',
      bytes: 512,
      endpoint: 'files.inline'
    });

    assert.strictEqual(capturedFilter.id_project, 'project-asset-1');
  });
});
