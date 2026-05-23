var assert = require('assert');
var subscriptionNotifier = require('../services/subscriptionNotifier');

describe('SubscriptionNotifier', function() {
  describe('_projectToSubscriptionPayload', function() {
    it('normalizes a Mongoose-like project document', function() {
      var payload = subscriptionNotifier._projectToSubscriptionPayload({
        toJSON: function() {
          return {
            _id: 'project-1',
            name: 'Project 1'
          };
        }
      });

      assert.deepStrictEqual(payload, {
        _id: 'project-1',
        id_project: 'project-1',
        name: 'Project 1'
      });
    });

    it('normalizes a plain project object', function() {
      var payload = subscriptionNotifier._projectToSubscriptionPayload({
        _id: 'project-2',
        name: 'Project 2'
      });

      assert.deepStrictEqual(payload, {
        _id: 'project-2',
        id_project: 'project-2',
        name: 'Project 2'
      });
    });

    it('preserves an existing id_project', function() {
      var payload = subscriptionNotifier._projectToSubscriptionPayload({
        _id: 'project-3',
        id_project: 'existing-project',
        name: 'Project 3'
      });

      assert.deepStrictEqual(payload, {
        _id: 'project-3',
        id_project: 'existing-project',
        name: 'Project 3'
      });
    });
  });
});
