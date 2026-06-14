process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');

const {
  buildLegacyWebhookIntegrationQuery,
  buildRegisterWebhookUpdate,
  ensureCaseZapChat21Group,
  extractWebhookReceipt,
  isInternalOutboundMessage,
  isTypingPresence,
  mapConnectionHealth,
  mapConnectionStatus,
  shouldSkipCaseZapDepartmentBot,
  syncCaseZapChat21LastMessage
} = require('../../pubmodules/casezap/connector');

describe('CaseZap connector', function() {
  it('resolves legacy project webhooks by secret so multiple instances can coexist', function() {
    assert.deepStrictEqual(buildLegacyWebhookIntegrationQuery('project-1', 'secret-markus'), {
      id_project: 'project-1',
      name: 'casezap',
      'value.webhookSecret': 'secret-markus'
    });
  });

  it('keeps the current instance status when webhook registration is refreshed', function() {
    const update = buildRegisterWebhookUpdate({ value: { status: 'active' } }, 'secret-1');

    assert.deepStrictEqual(update, {
      'value.webhookSecret': 'secret-1'
    });
  });

  it('marks new webhook registration as pending until health check confirms state', function() {
    const update = buildRegisterWebhookUpdate({ value: {} }, 'secret-1');

    assert.deepStrictEqual(update, {
      'value.webhookSecret': 'secret-1',
      'value.status': 'pending'
    });
  });

  it('repairs the Chat21 group before the first CaseZap message is sent', async function() {
    const calls = [];

    const result = await ensureCaseZapChat21Group(
      'support-group-project-1-request-1',
      'project-1',
      {
        integrationId: 'integration-1',
        messageId: 'message-1'
      },
      {
        chat21GroupRepair: {
          repairRequestGroup: async function(payload) {
            calls.push(payload);
            return { status: 'created' };
          }
        }
      }
    );

    assert.deepStrictEqual(calls, [{
      request_id: 'support-group-project-1-request-1',
      id_project: 'project-1'
    }]);
    assert.deepStrictEqual(result, { status: 'created' });
  });

  it('does not repair the same CaseZap Chat21 group repeatedly in the same process', async function() {
    const calls = [];
    const services = {
      chat21GroupRepair: {
        repairRequestGroup: async function(payload) {
          calls.push(payload);
          return { status: 'created' };
        }
      }
    };

    const first = await ensureCaseZapChat21Group(
      'support-group-project-1-cached-request',
      'project-1',
      { integrationId: 'integration-1', messageId: 'message-1' },
      services
    );
    const second = await ensureCaseZapChat21Group(
      'support-group-project-1-cached-request',
      'project-1',
      { integrationId: 'integration-1', messageId: 'message-2' },
      services
    );

    assert.deepStrictEqual(calls, [{
      request_id: 'support-group-project-1-cached-request',
      id_project: 'project-1'
    }]);
    assert.deepStrictEqual(first, { status: 'created' });
    assert.deepStrictEqual(second, { status: 'cached' });
  });

  it('syncs the Chat21 group preview after a CaseZap message is saved', async function() {
    const updates = [];

    const result = await syncCaseZapChat21LastMessage(
      'support-group-project-1-request-1',
      'project-1',
      {
        toObject: function() {
          return {
            _id: 'message-1',
            text: 'Mensagem nova',
            recipient: 'support-group-project-1-request-1'
          };
        }
      },
      { integrationId: 'integration-1', messageId: 'message-1' },
      {
        chat21: {
          groups: {
            updateAttributes: async function(attributes, groupId) {
              updates.push({ attributes, groupId });
              return { success: true };
            }
          }
        }
      }
    );

    assert.strictEqual(result.status, 'updated');
    assert.deepStrictEqual(updates, [{
      groupId: 'support-group-project-1-request-1',
      attributes: {
        last_message: {
          _id: 'message-1',
          text: 'Mensagem nova',
          recipient: 'support-group-project-1-request-1'
        }
      }
    }]);
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

  it('does not map unknown connection payloads to disconnected', function() {
    assert.strictEqual(mapConnectionStatus({ status: 'server_starting' }), null);
    assert.strictEqual(mapConnectionStatus({ data: { connection: 'connecting' } }), null);
  });

  it('keeps connecting provider status degraded instead of healthy', function() {
    assert.strictEqual(mapConnectionHealth('connecting', null), 'degraded');
    assert.strictEqual(mapConnectionHealth('bannedm', 'disconnected'), 'down');
  });

  it('keeps compatibility with older UazApi open-state payloads', function() {
    assert.strictEqual(mapConnectionStatus({ data: { state: 'open' } }), 'active');
  });

  it('extracts diagnostic receipt from current UazApi message payloads', function() {
    assert.deepStrictEqual(extractWebhookReceipt({
      EventType: 'messages',
      message: {
        type: 'conversation',
        key: {
          id: 'BAE5TEST',
          fromMe: false
        }
      }
    }), {
      eventType: 'messages',
      messageId: 'BAE5TEST',
      messageType: 'conversation',
      fromMe: false
    });
  });

  it('does not send system assignment messages to the WhatsApp contact', function() {
    assert.strictEqual(isInternalOutboundMessage({
      sender: 'system',
      createdBy: 'system',
      text: 'Uma nova solicitação de suporte foi atribuída a você: I',
      attributes: {
        subtype: 'info',
        updateconversation: true,
        messagelabel: { key: 'TOUCHING_OPERATOR' }
      }
    }), true);
  });

  it('does not resend messages mirrored from WhatsApp Web back to CaseZap', function() {
    assert.strictEqual(isInternalOutboundMessage({
      sender: '69ed37fb4c5c780013165040',
      createdBy: '69ed37fb4c5c780013165040',
      text: 'Oi',
      attributes: {
        casezapFromMe: true,
        casezapExternalFromMe: true
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

  it('detects only live composing presences as typing indicators', function() {
    assert.strictEqual(isTypingPresence('composing'), true);
    assert.strictEqual(isTypingPresence('recording'), true);
    assert.strictEqual(isTypingPresence('available'), false);
    assert.strictEqual(isTypingPresence('unavailable'), false);
    assert.strictEqual(isTypingPresence(null), false);
  });

  it('enables a CaseZap department bot only for bound departments with a bot', function() {
    assert.strictEqual(shouldSkipCaseZapDepartmentBot(null), true);
    assert.strictEqual(shouldSkipCaseZapDepartmentBot({ _id: 'department-1' }), true);
    assert.strictEqual(shouldSkipCaseZapDepartmentBot({ _id: 'department-1', id_bot: 'bot-1' }), false);
  });
});
