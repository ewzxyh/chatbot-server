process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

var assert = require('chai').assert;
var Department = require('../models/department');
var departmentRouter = require('../routes/department');

describe('Department route channel binding helpers', function () {
  var originalFindOne;

  beforeEach(function () {
    originalFindOne = Department.findOne;
  });

  afterEach(function () {
    Department.findOne = originalFindOne;
  });

  it('deduplicates equivalent instance id and number candidates', function () {
    var bindings = departmentRouter._private.normalizeChannelBindings({
      provider: 'casezap',
      instances: [
        { id: 'integration-1', number: '5585999999999', label: 'Main' },
        { id: '5585999999999', label: 'Same instance by number' },
        { id: 'integration-2', number: '5585888888888', label: 'Secondary' }
      ]
    });

    assert.deepEqual(bindings, {
      provider: 'casezap',
      instances: [
        { id: 'integration-1', label: 'Main', number: '5585999999999' },
        { id: 'integration-2', label: 'Secondary', number: '5585888888888' }
      ]
    });
  });

  it('checks duplicate bindings across both id and number fields', async function () {
    var capturedQuery;

    Department.findOne = function (query) {
      capturedQuery = query;

      return {
        select: function () {
          return {
            lean: function () {
              return {
                exec: function () {
                  return Promise.resolve(null);
                }
              };
            }
          };
        }
      };
    };

    await departmentRouter._private.ensureBindingsAreUnique('project-1', {
      provider: 'casezap',
      instances: [
        { id: 'integration-1', number: '5585999999999' }
      ]
    }, 'department-1');

    assert.deepEqual(capturedQuery, {
      id_project: 'project-1',
      status: 1,
      'channel_bindings.provider': 'casezap',
      $or: [
        { 'channel_bindings.instances.id': { $in: ['integration-1', '5585999999999'] } },
        { 'channel_bindings.instances.number': { $in: ['integration-1', '5585999999999'] } }
      ],
      _id: { $ne: 'department-1' }
    });
  });

  it('rejects duplicate bindings with conflict status', async function () {
    Department.findOne = function () {
      return {
        select: function () {
          return {
            lean: function () {
              return {
                exec: function () {
                  return Promise.resolve({ _id: 'department-2', name: 'Other' });
                }
              };
            }
          };
        }
      };
    };

    try {
      await departmentRouter._private.ensureBindingsAreUnique('project-1', {
        provider: 'casezap',
        instances: [
          { id: 'integration-1', number: '5585999999999' }
        ]
      });
      assert.fail('Expected duplicate binding to throw');
    } catch (err) {
      assert.strictEqual(err.statusCode, 409);
      assert.strictEqual(err.message, 'Channel binding instance already belongs to another department.');
    }
  });
});
