process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');

const { buildRegisterWebhookUpdate, mapConnectionStatus } = require('../../pubmodules/casezap/connector');

describe('CaseZap connector', function() {
  it('does not mark an instance active just because the webhook was registered', function() {
    const update = buildRegisterWebhookUpdate({ value: {} }, 'secret-1');

    assert.deepStrictEqual(update, {
      'value.webhookSecret': 'secret-1',
      'value.status': 'disconnected'
    });
  });

  it('maps current UazApi connected payloads to active', function() {
    const status = mapConnectionStatus({
      EventType: 'connection',
      status: 'connected',
      instance: { status: 'connected' }
    });

    assert.strictEqual(status, 'active');
  });

  it('maps current UazApi disconnected payloads to disconnected', function() {
    const status = mapConnectionStatus({
      EventType: 'connection',
      status: 'disconnected',
      instance: { status: 'disconnected' }
    });

    assert.strictEqual(status, 'disconnected');
  });

  it('keeps compatibility with older UazApi open-state payloads', function() {
    assert.strictEqual(mapConnectionStatus({ data: { state: 'open' } }), 'active');
  });
});
