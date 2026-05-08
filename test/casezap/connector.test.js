process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');

const { buildRegisterWebhookUpdate } = require('../../pubmodules/casezap/connector');

describe('CaseZap connector', function() {
  it('does not mark an instance active just because the webhook was registered', function() {
    const update = buildRegisterWebhookUpdate({ value: {} }, 'secret-1');

    assert.deepStrictEqual(update, {
      'value.webhookSecret': 'secret-1',
      'value.status': 'disconnected'
    });
  });
});
