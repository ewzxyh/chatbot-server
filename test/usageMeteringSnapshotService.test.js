process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

var assert = require('assert');
var usageMeteringSnapshotService = require('../services/usageMeteringSnapshotService');

describe('usageMeteringSnapshotService', function() {
  it('persists the current project usage snapshot with a monthly period key', async function() {
    var calls = [];
    var usage = {
      generatedAt: '2026-05-20T12:00:00.000Z',
      project: { id: 'project-1', name: 'Project 1', plan: 'Business' },
      period: {
        start: '2026-05-01T00:00:00.000Z',
        end: '2026-06-01T00:00:00.000Z',
        source: 'custom'
      },
      contacts: { current: 10, limit: 50000 },
      messages: { total: 22 },
      attachments: { count: 3, bytes: 4096 },
      mediaTraffic: { requests: 4, bytes: 8192 },
      costEstimate: { currency: 'USD', estimatedCostMonthly: 0.12 }
    };

    var service = usageMeteringSnapshotService.createUsageMeteringSnapshotService({
      usageMeteringService: {
        getProjectUsage: async function(projectId, options) {
          assert.strictEqual(projectId, 'project-1');
          assert.strictEqual(options.includeStorage, true);
          return usage;
        }
      },
      UsageMeteringSnapshot: {
        findOneAndUpdate: async function(filter, update, options) {
          calls.push({ filter: filter, update: update, options: options });
          return Object.assign({ _id: 'snapshot-1' }, update.$set);
        }
      }
    });

    var saved = await service.saveProjectSnapshot('project-1', { includeStorage: true, source: 'manual' });

    assert.strictEqual(saved.periodKey, '2026-05');
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].filter, { id_project: 'project-1', periodKey: '2026-05' });
    assert.strictEqual(calls[0].update.$set.source, 'manual');
    assert.strictEqual(calls[0].update.$set.metrics.mediaTraffic.bytes, 8192);
    assert.strictEqual(calls[0].options.upsert, true);
    assert.strictEqual(calls[0].options.new, true);
  });

  it('exports saved snapshots as CSV with stable billing columns', async function() {
    var rows = [
      {
        periodKey: '2026-05',
        projectName: 'Project 1',
        plan: 'Business',
        periodStart: new Date('2026-05-01T00:00:00.000Z'),
        periodEnd: new Date('2026-06-01T00:00:00.000Z'),
        metrics: {
          contacts: { current: 10 },
          conversations: { current: 5 },
          messages: { total: 22 },
          attachments: { count: 3, bytes: 4096 },
          mediaTraffic: { requests: 4, bytes: 8192 },
          tokens: { current: 100 },
          email: { current: 2 },
          costEstimate: { estimatedCostMonthly: 0.12 }
        }
      }
    ];

    var service = usageMeteringSnapshotService.createUsageMeteringSnapshotService({
      UsageMeteringSnapshot: {
        find: function() {
          return {
            sort: function() {
              return {
                limit: function() {
                  return {
                    lean: async function() { return rows; }
                  };
                }
              };
            }
          };
        }
      }
    });

    var csv = await service.exportProjectSnapshotsCsv('project-1', { limit: 12 });

    assert.ok(csv.indexOf('period_key,project_name,plan,period_start,period_end,contacts,conversations,messages,attachments_count,attachments_bytes,media_traffic_requests,media_traffic_bytes,tokens,email,estimated_cost_monthly') === 0);
    assert.ok(csv.indexOf('2026-05,Project 1,Business,2026-05-01T00:00:00.000Z,2026-06-01T00:00:00.000Z,10,5,22,3,4096,4,8192,100,2,0.12') > -1);
  });
});
