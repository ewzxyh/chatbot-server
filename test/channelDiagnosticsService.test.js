process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

var assert = require('assert');
var diagnostics = require('../services/channelDiagnosticsService');

describe('channelDiagnosticsService', function() {
  it('marks banned-like provider statuses as down', function() {
    var result = diagnostics.normalizeProviderHealth({
      instance: { status: 'bannedm' },
      status: { connected: false, loggedIn: false }
    });

    assert.strictEqual(result.status, 'down');
    assert.strictEqual(result.providerStatus, 'bannedm');
  });

  it('marks CaseZap WhatsApp send limits as degraded', function() {
    var result = diagnostics.normalizeProviderHealth({
      instance: { status: 'connected' },
      status: { connected: true, loggedIn: true },
      can_send_new_messages: false,
      error_key: 'WHATSAPP_REACHOUT_TIMELOCK',
      new_chat_message_capping: { status: 'CAPPED' }
    });

    assert.strictEqual(result.status, 'degraded');
    assert.strictEqual(result.providerCode, 'WHATSAPP_REACHOUT_TIMELOCK');
  });

  it('marks WABA restricted and red quality as degraded', function() {
    var result = diagnostics.normalizeProviderHealth({
      status: 'RESTRICTED',
      quality_rating: 'RED',
      name_status: 'APPROVED'
    }, { connectedFallback: true });

    assert.strictEqual(result.status, 'degraded');
    assert.strictEqual(result.providerStatus, 'RESTRICTED');
  });
});
