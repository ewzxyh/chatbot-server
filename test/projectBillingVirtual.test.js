process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

var assert = require('assert');
var Project = require('../models/project');

describe('Project billing virtuals', function() {
  it('returns false for a paid project without a valid subscription period', function() {
    var project = new Project({
      name: 'No Period',
      createdBy: 'billing-virtual-test',
      profile: {
        name: 'Business',
        type: 'payment'
      }
    });

    assert.strictEqual(project.isActiveSubscription, false);
  });

  it('returns false for a suspended paid project even with a future access date', function() {
    var project = new Project({
      name: 'Suspended',
      createdBy: 'billing-virtual-test',
      profile: {
        name: 'Business',
        type: 'payment',
        billingStatus: 'suspended',
        subEnd: new Date('2099-12-31T23:59:59.999Z')
      }
    });

    assert.strictEqual(project.isActiveSubscription, false);
  });
});
