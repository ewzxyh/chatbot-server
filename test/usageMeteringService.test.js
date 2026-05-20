process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

var assert = require('assert');
var usageMeteringService = require('../services/usageMeteringService');

function matches(record, query) {
  return Object.keys(query || {}).every(function(key) {
    var expected = query[key];
    var actual = key.split('.').reduce(function(value, part) {
      return value == null ? undefined : value[part];
    }, record);

    if (expected && expected.$gte !== undefined && expected.$lt !== undefined) {
      return actual >= expected.$gte && actual < expected.$lt;
    }

    if (expected && expected.$ne !== undefined) {
      return actual !== expected.$ne;
    }

    if (expected && expected.$exists !== undefined) {
      return expected.$exists ? actual !== undefined : actual === undefined;
    }

    if (expected && expected.$in) {
      return expected.$in.indexOf(actual) !== -1;
    }

    return String(actual) === String(expected);
  });
}

function fakeCountModel(rows) {
  return {
    countDocuments: async function(query) {
      return rows.filter(function(row) { return matches(row, query); }).length;
    }
  };
}

function fakeMessageModel(rows) {
  return {
    countDocuments: async function(query) {
      return rows.filter(function(row) { return matches(row, query); }).length;
    },
    aggregate: async function(pipeline) {
      var match = pipeline[0].$match;
      var groupId = pipeline[1].$group._id;
      var field = groupId.$ifNull[0].replace('$', '');
      var grouped = {};

      rows.filter(function(row) { return matches(row, match); }).forEach(function(row) {
        var key = field.split('.').reduce(function(value, part) {
          return value == null ? undefined : value[part];
        }, row) || 'unknown';
        grouped[key] = (grouped[key] || 0) + 1;
      });

      return Object.keys(grouped).sort().map(function(key) {
        return { _id: key, count: grouped[key] };
      });
    },
    find: function(query) {
      var result = rows.filter(function(row) { return matches(row, query); });
      return {
        select: function() {
          return {
            lean: async function() {
              return result;
            }
          };
        }
      };
    }
  };
}

describe('usageMeteringService', function() {
  it('uses profile.subStart for active paid projects even when lean omits virtuals', function() {
    var period = usageMeteringService.resolvePeriod({
      _id: 'project-lean',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      profile: {
        type: 'payment',
        subStart: new Date('2026-05-05T00:00:00.000Z'),
        subEnd: new Date('2026-06-08T00:00:00.000Z')
      }
    }, {}, new Date('2026-05-20T12:00:00.000Z'));

    assert.strictEqual(period.start.toISOString(), '2026-05-05T00:00:00.000Z');
  });

  it('builds a real usage snapshot for the current billing period', async function() {
    var now = new Date('2026-05-20T12:00:00.000Z');
    var periodStart = new Date('2026-05-05T00:00:00.000Z');
    var project = {
      _id: 'project-1',
      name: 'Project 1',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      isActiveSubscription: true,
      profile: {
        name: 'Business',
        type: 'payment',
        agents: 10,
        subStart: periodStart,
        quotes: {
          contacts: 50000,
          platforms: 5,
          members: 10,
          tokens: 10000000,
          email: 200
        }
      }
    };

    var messages = [
      { id_project: 'project-1', createdAt: new Date('2026-05-06T00:00:00.000Z'), channel: { name: 'whatsapp' }, type: 'text', metadata: {} },
      {
        id_project: 'project-1',
        createdAt: new Date('2026-05-07T00:00:00.000Z'),
        channel: { name: 'whatsapp' },
        type: 'image',
        metadata: { src: 'https://chatcase.test/api/files?path=uploads%2Fusers%2Fu1%2Ffiles%2Fa%2Fphoto.png' }
      },
      {
        id_project: 'project-1',
        createdAt: new Date('2026-05-08T00:00:00.000Z'),
        channel: { name: 'casezap' },
        type: 'file',
        metadata: { src: 'uploads/users/u1/files/b/manual.pdf' }
      },
      {
        id_project: 'project-1',
        createdAt: new Date('2026-04-20T00:00:00.000Z'),
        channel: { name: 'casezap' },
        type: 'image',
        metadata: { src: 'uploads/users/u1/files/old/photo.png' }
      }
    ];

    var service = usageMeteringService.createUsageMeteringService({
      now: function() { return now; },
      Project: {
        findById: function() {
          return { lean: async function() { return project; } };
        }
      },
      Request: fakeCountModel([
        { id_project: 'project-1', createdAt: new Date('2026-05-06T00:00:00.000Z') },
        { id_project: 'project-1', createdAt: new Date('2026-05-07T00:00:00.000Z') },
        { id_project: 'project-1', createdAt: new Date('2026-04-07T00:00:00.000Z') }
      ]),
      Message: fakeMessageModel(messages),
      Lead: fakeCountModel([
        { id_project: 'project-1', status: 100, createdAt: new Date('2026-05-06T00:00:00.000Z') },
        { id_project: 'project-1', status: 100, createdAt: new Date('2026-04-06T00:00:00.000Z') },
        { id_project: 'project-1', status: 200, createdAt: new Date('2026-05-06T00:00:00.000Z') }
      ]),
      ProjectUser: fakeCountModel([
        { id_project: 'project-1', status: 'active', id_user: 'user-1' }
      ]),
      leadNormalStatus: 100,
      platformUsageService: {
        countConnectedPlatforms: async function() { return 2; }
      },
      UsageMediaTrafficDaily: {
        aggregate: async function() {
          return [
            { _id: 'files.inline', requests: 3, bytes: 4096 },
            { _id: 'files.download', requests: 1, bytes: 2048 }
          ];
        }
      },
      costRates: {
        storageGbMonth: 1,
        mediaTrafficGb: 2,
        aiToken1k: 0.5,
        emailUnit: 0.01
      },
      quoteManager: {
        getAllQuotes: async function() {
          return {
            tokens: { quote: 42 },
            email: { quote: 7 },
            messages: { quote: 0 },
            requests: { quote: 0 }
          };
        },
        getPlanLimits: async function() {
          return { tokens: 10000000, email: 200, requests: -1, messages: 0 };
        }
      },
      fileServices: [{
        find: async function(path) {
          var sizes = {
            'uploads/users/u1/files/a/photo.png': 1024,
            'uploads/users/u1/files/b/manual.pdf': 2048
          };
          if (!sizes[path]) throw { code: 'ENOENT' };
          return { filename: path, length: sizes[path] };
        }
      }]
    });

    var usage = await service.getProjectUsage('project-1');

    assert.strictEqual(usage.project.id, 'project-1');
    assert.strictEqual(usage.period.start, '2026-05-05T00:00:00.000Z');
    assert.strictEqual(usage.contacts.current, 2);
    assert.strictEqual(usage.contacts.newInPeriod, 1);
    assert.strictEqual(usage.contacts.limit, 50000);
    assert.strictEqual(usage.members.current, 1);
    assert.strictEqual(usage.platforms.current, 2);
    assert.strictEqual(usage.conversations.current, 2);
    assert.strictEqual(usage.messages.total, 3);
    assert.deepStrictEqual(usage.messages.byChannel, { casezap: 1, whatsapp: 2 });
    assert.deepStrictEqual(usage.messages.byType, { file: 1, image: 1, text: 1 });
    assert.strictEqual(usage.attachments.count, 2);
    assert.strictEqual(usage.attachments.measuredCount, 2);
    assert.strictEqual(usage.attachments.bytes, 3072);
    assert.strictEqual(usage.mediaTraffic.requests, 4);
    assert.strictEqual(usage.mediaTraffic.bytes, 6144);
    assert.deepStrictEqual(usage.mediaTraffic.byEndpoint, {
      'files.download': { requests: 1, bytes: 2048 },
      'files.inline': { requests: 3, bytes: 4096 }
    });
    assert.strictEqual(usage.costEstimate.currency, 'USD');
    assert.strictEqual(usage.costEstimate.rates.storageGbMonth, 1);
    assert.strictEqual(usage.costEstimate.estimatedCostMonthly, 0.09);
    assert.strictEqual(usage.tokens.current, 42);
    assert.strictEqual(usage.tokens.limit, 10000000);
    assert.strictEqual(usage.email.current, 7);
    assert.strictEqual(usage.email.limit, 200);
  });
});
