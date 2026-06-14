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

  it('builds CaseZap instance diagnostics without leaking secrets', function() {
    var result = diagnostics.buildCaseZapInstanceDiagnostics({
      _id: '507f1f77bcf86cd799439011',
      id_project: 'project-1',
      name: 'casezap',
      value: {
        instanceName: 'markus-chatcase',
        number: '5585958546364',
        domain: 'https://chatcase.uazapi.com',
        token: 'secret-token',
        webhookSecret: 'secret-webhook',
        status: 'active',
        operational: {
          lastWebhookRegistrationAt: '2026-06-14T12:00:00.000Z',
          lastWebhookRegistrationStatus: 'success',
          lastWebhookRegistrationUrl: 'https://app.chatcase.com.br/api/modules/casezap/webhook/507f1f77bcf86cd799439011?secret=secret-webhook',
          lastWebhookReceivedAt: '2026-06-14T12:05:00.000Z',
          lastWebhookReceivedEvent: 'messages',
          lastWebhookReceivedMessageId: 'msg-1',
          lastWebhookReceivedType: 'text',
          lastWebhookReceivedFromMe: false
        }
      }
    }, {
      providerHealth: 'ok',
      providerStatus: 'connected',
      providerReason: 'provider_status_ok',
      providerCheckedAt: '2026-06-14T12:01:00.000Z',
      providerLatencyMs: 34
    }, [{
      timestamp: new Date('2026-06-14T12:06:00.000Z'),
      level: 'error',
      area: 'webhook',
      event: 'webhook.failed',
      status: 'failed',
      errorMessage: 'boom',
      details: { token: 'must-redact', eventType: 'messages' }
    }]);

    var serialized = JSON.stringify(result);
    assert.strictEqual(serialized.indexOf('secret-token'), -1);
    assert.strictEqual(serialized.indexOf('secret-webhook'), -1);
    assert.strictEqual(result.webhook.lastRegistrationUrl, 'https://app.chatcase.com.br/api/modules/casezap/webhook/507f1f77bcf86cd799439011?[redacted]');
    assert.strictEqual(result.webhook.lastErrorEvent, 'webhook.failed');
    assert.strictEqual(result.recentEvents[0].details.token, '[Redacted]');
  });
});
