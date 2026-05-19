process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');

const {
  buildRegisterWebhookUpdate,
  isInternalOutboundMessage,
  mapConnectionHealth,
  mapConnectionStatus
} = require('../../pubmodules/casezap/connector');

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

  it('maps banned-like UazApi payloads to disconnected', function() {
    assert.strictEqual(mapConnectionStatus({ instance: { status: 'bannedm' } }), 'disconnected');
    assert.strictEqual(mapConnectionStatus({ instance: { status: 'banned' } }), 'disconnected');
  });

  it('keeps connecting provider status degraded instead of healthy', function() {
    assert.strictEqual(mapConnectionHealth('connecting', 'disconnected'), 'degraded');
    assert.strictEqual(mapConnectionHealth('bannedm', 'disconnected'), 'down');
  });

  it('keeps compatibility with older UazApi open-state payloads', function() {
    assert.strictEqual(mapConnectionStatus({ data: { state: 'open' } }), 'active');
  });

  it('does not send system assignment messages to the WhatsApp contact', function() {
    assert.strictEqual(isInternalOutboundMessage({
      sender: 'system',
      createdBy: 'system',
      text: 'A new support request has been assigned to you: I',
      attributes: {
        subtype: 'info',
        updateconversation: true,
        messagelabel: { key: 'TOUCHING_OPERATOR' }
      }
    }), true);
  });

  it('allows normal agent outbound messages', function() {
    assert.strictEqual(isInternalOutboundMessage({
      sender: '69ed37fb4c5c780013165040',
      createdBy: '69ed37fb4c5c780013165040',
      text: 'Ola',
      attributes: {}
    }), false);
  });
});
