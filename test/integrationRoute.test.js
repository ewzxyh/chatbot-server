var assert = require('assert');

var integrationRoute = require('../routes/integration');

describe('Integration route', function() {
  it('preserves CaseZap operational value fields when updating editable settings', function() {
    var update = integrationRoute.__test.buildIntegrationUpdate({
      name: 'casezap',
      value: {
        number: '5585000000000',
        domain: 'https://casezap.test',
        token: 'old-token',
        instanceName: 'Old',
        status: 'active',
        webhookSecret: 'secret',
        operational: {
          lastProviderHealth: 'ok'
        }
      }
    }, {
      value: {
        number: '5585999999999',
        domain: 'https://casezap.test',
        token: 'new-token',
        instanceName: 'New'
      }
    });

    assert.strictEqual(update.value.number, '5585999999999');
    assert.strictEqual(update.value.token, 'new-token');
    assert.strictEqual(update.value.status, 'active');
    assert.strictEqual(update.value.webhookSecret, 'secret');
    assert.strictEqual(update.value.operational.lastProviderHealth, 'ok');
  });

  it('keeps replacement semantics for non-CaseZap integrations', function() {
    var update = integrationRoute.__test.buildIntegrationUpdate({
      name: 'openai',
      value: {
        apiKey: 'old-key',
        extra: true
      }
    }, {
      value: {
        apiKey: 'new-key'
      }
    });

    assert.deepStrictEqual(update.value, {
      apiKey: 'new-key'
    });
  });
});
