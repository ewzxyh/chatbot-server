process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

var assert = require('chai').assert;
var Department = require('../models/department');
var departmentService = require('../services/departmentService');

describe('DepartmentService channel bindings', function () {
  var originalFindOne;

  beforeEach(function () {
    originalFindOne = Department.findOne;
  });

  afterEach(function () {
    Department.findOne = originalFindOne;
  });

  it('finds a department by provider and unique instance candidates', async function () {
    var capturedQuery;
    var capturedSort;
    var expectedDepartment = { _id: 'department-1' };

    Department.findOne = function (query) {
      capturedQuery = query;

      return {
        sort: function (sortArg) {
          capturedSort = sortArg;

          return {
            exec: function () {
              return Promise.resolve(expectedDepartment);
            }
          };
        }
      };
    };

    var result = await departmentService.getDepartmentByChannelBinding('project-1', 'waba', [
      'integration-1',
      '',
      null,
      '5562999999999',
      '5562999999999'
    ]);

    assert.strictEqual(result, expectedDepartment);
    assert.deepEqual(capturedQuery, {
      id_project: 'project-1',
      status: 1,
      'channel_bindings.provider': { $in: ['whatsapp', 'waba'] },
      $or: [
        { 'channel_bindings.instances.id': { $in: ['integration-1', '5562999999999'] } },
        { 'channel_bindings.instances.number': { $in: ['integration-1', '5562999999999'] } }
      ]
    });
    assert.deepEqual(capturedSort, { updatedAt: -1 });
  });

  it('does not query when project, provider or candidates are missing', async function () {
    Department.findOne = function () {
      throw new Error('Department.findOne should not be called');
    };

    assert.strictEqual(await departmentService.getDepartmentByChannelBinding(null, 'casezap', ['integration-1']), null);
    assert.strictEqual(await departmentService.getDepartmentByChannelBinding('project-1', null, ['integration-1']), null);
    assert.strictEqual(await departmentService.getDepartmentByChannelBinding('project-1', 'casezap', []), null);
  });
});
