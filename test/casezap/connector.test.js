process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');
const {
  buildLegacyWebhookIntegrationQuery,
  buildCaseZapRequestQuery,
  buildRegisterWebhookUpdate,
  ensureCaseZapChat21Group,
  extractWebhookReceipt,
  hasStoredCaseZapMessage,
  isInternalOutboundMessage,
  isTypingPresence,
  mapConnectionHealth,
  mapConnectionStatus,
  sendOutboundMessage,
  isTransientProviderError,
  shouldSkipCaseZapDepartmentBot,
  syncCaseZapChat21LastMessage,
  syncCaseZapRequestLastMessage
} = require('../../pubmodules/casezap/connector');
const Lead = require('../../models/lead');
const leadService = require('../../services/leadService');
const Integration = require('../../models/integrations');
const axios = require('axios');
const MessageConstants = require('../../models/messageConstants');

describe('CaseZap connector', function() {
  it('resolves legacy project webhooks by secret so multiple instances can coexist', function() {
    assert.deepStrictEqual(buildLegacyWebhookIntegrationQuery('project-1', 'secret-markus'), {
      id_project: 'project-1',
      name: 'casezap',
      'value.webhookSecret': 'secret-markus'
    });
  });

  it('isolates presence events to the originating CaseZap integration', function() {
    const integration = { _id: 'integration-1', id_project: 'project-1' };

    assert.deepStrictEqual(buildCaseZapRequestQuery(integration, '5511999999999'), {
      id_project: 'project-1',
      integrationId: 'integration-1',
      'channel.name': 'casezap',
      status: { $lt: 1000 },
      $or: [
        { 'attributes.casezapPhone': '5511999999999' },
        { createdBy: 'casezap-5511999999999' }
      ]
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

  it('uses one canonical lead for the same phone across concurrent CaseZap integrations', async function() {
    const originalFindOneAndUpdate = Lead.findOneAndUpdate;
    const calls = [];
    const integrations = ['integration-1', 'integration-2'];
    const mapped = { leadId: 'casezap-5511999999999', phone: '5511999999999' };

    Lead.findOneAndUpdate = function(filter, update, options) {
      calls.push({ filter, update, options });
      return {
        exec: function(callback) {
          setImmediate(function() {
            callback(null, { _id: 'lead-1', createdBy: 'casezap-5511999999999' });
          });
        }
      };
    };

    try {
      await Promise.all(integrations.map(function() {
        return leadService.createIfNotExistsWithLeadId(
          mapped.leadId,
          'Contato',
          null,
          'project-1',
          mapped.leadId,
          null,
          null,
          mapped.phone
        );
      }));
    } finally {
      Lead.findOneAndUpdate = originalFindOneAndUpdate;
    }

    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls.map(function(call) { return call.filter; }), [
      { lead_id: 'casezap-5511999999999', id_project: 'project-1' },
      { lead_id: 'casezap-5511999999999', id_project: 'project-1' }
    ]);
  });

  it('serializes concurrent creation work for the same CaseZap conversation', async function() {
    const { withCaseZapRequestLock } = require('../../pubmodules/casezap/connector');
    let active = 0;
    let maxActive = 0;
    const order = [];

    await Promise.all([1, 2].map(function(value) {
      return withCaseZapRequestLock('project-1:integration-1:lead-1', async function() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(function(resolve) { setTimeout(resolve, 5); });
        order.push(value);
        active -= 1;
      });
    }));

    assert.strictEqual(maxActive, 1);
    assert.deepStrictEqual(order, [1, 2]);
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

  it('syncs the Tiledesk request preview after a CaseZap message is saved', async function() {
    const updates = [];

    const result = await syncCaseZapRequestLastMessage(
      'support-group-project-1-request-1',
      'project-1',
      {
        toObject: function() {
          return {
            _id: 'message-1',
            text: 'Mensagem nova',
            recipient: 'support-group-project-1-request-1',
            createdAt: new Date('2026-06-14T18:00:00.000Z')
          };
        }
      },
      { integrationId: 'integration-1', messageId: 'message-1' },
      {
        requestModel: {
          findOneAndUpdate: async function(query, update, options) {
            updates.push({ query, update, options });
            return { _id: 'request-1' };
          }
        }
      }
    );

    assert.strictEqual(result.status, 'updated');
    assert.deepStrictEqual(updates, [{
      query: {
        request_id: 'support-group-project-1-request-1',
        id_project: 'project-1'
      },
      update: {
        $set: {
          'attributes.last_message': {
            _id: 'message-1',
            text: 'Mensagem nova',
            recipient: 'support-group-project-1-request-1',
            createdAt: new Date('2026-06-14T18:00:00.000Z')
          },
          updatedAt: new Date('2026-06-14T18:00:00.000Z')
        }
      },
      options: { new: false, upsert: false }
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

  it('detects a CaseZap message already stored in Mongo', async function() {
    const calls = [];
    const exists = await hasStoredCaseZapMessage('project-1', 'casezap-message-1', {
      findOne: function(query) {
        calls.push(query);
        return {
          select: function(field) {
            calls.push({ select: field });
            return {
              lean: async function() {
                return { _id: 'message-1' };
              }
            };
          }
        };
      }
    });

    assert.strictEqual(exists, true);
    assert.deepStrictEqual(calls, [
      {
        id_project: 'project-1',
        'attributes.casezapMessageId': 'casezap-message-1'
      },
      { select: '_id' }
    ]);
  });

  it('allows normal agent outbound messages', function() {
    assert.strictEqual(isInternalOutboundMessage({
      sender: '69ed37fb4c5c780013165040',
      createdBy: '69ed37fb4c5c780013165040',
      text: 'Ola',
      attributes: {}
    }), false);
  });

  it('sends command messages sequentially, including stickers and documents', async function() {
    const originalFindOne = Integration.findOne;
    const originalPost = axios.post;
    const calls = [];

    Integration.findOne = function() {
      return Promise.resolve({
        _id: 'integration-1',
        value: {
          status: 'active',
          domain: 'https://uazapi.example/',
          token: 'token-1'
        }
      });
    };
    axios.post = async function(url, body) {
      calls.push({ url, body });
      return { data: { success: true } };
    };

    try {
      await sendOutboundMessage({
        request: {
          channel: { name: 'casezap' },
          lead: { lead_id: 'casezap-5511999999999' }
        },
        status: MessageConstants.CHAT_MESSAGE_STATUS.SENDING,
        channel_type: MessageConstants.CHANNEL_TYPE.GROUP,
        id_project: 'project-1',
        sender: 'agent-1',
        attributes: {
          commands: [
            { type: 'wait', time: 0 },
            {
              type: 'message',
              message: {
                type: 'sticker',
                metadata: { downloadCdnUrl: 'https://media.example/sticker.webp' }
              }
            },
            { type: 'wait', time: 0 },
            {
              type: 'message',
              message: {
                type: 'file',
                metadata: {
                  downloadCdnUrl: 'https://media.example/report.pdf',
                  name: 'report.pdf'
                }
              }
            }
          ]
        }
      });
    } finally {
      Integration.findOne = originalFindOne;
      axios.post = originalPost;
    }

    assert.deepStrictEqual(calls, [
      {
        url: 'https://uazapi.example/send/media',
        body: {
          number: '5511999999999',
          file: 'https://media.example/sticker.webp',
          type: 'sticker'
        }
      },
      {
        url: 'https://uazapi.example/send/media',
        body: {
          number: '5511999999999',
          file: 'https://media.example/report.pdf',
          type: 'document',
          docName: 'report.pdf'
        }
      }
    ]);
  });

  it('falls back to the original message when commands are invalid or media has no file', async function() {
    const originalFindOne = Integration.findOne;
    const originalPost = axios.post;
    const calls = [];

    Integration.findOne = function() {
      return Promise.resolve({ value: { status: 'active', domain: 'https://uazapi.example/', token: 'token-1' } });
    };
    axios.post = async function(url, body) {
      calls.push({ url, body });
      return { data: { success: true } };
    };

    try {
      await sendOutboundMessage({
        request: { channel: { name: 'casezap' }, lead: { lead_id: 'casezap-5511999999999' } },
        status: MessageConstants.CHAT_MESSAGE_STATUS.SENDING,
        channel_type: MessageConstants.CHANNEL_TYPE.GROUP,
        id_project: 'project-1',
        sender: 'agent-1',
        type: 'text',
        text: 'mensagem original',
        attributes: {
          commands: [
            { type: 'wait', time: 'invalid' },
            { type: 'message', message: { type: 'sticker', metadata: {} } }
          ]
        }
      });
    } finally {
      Integration.findOne = originalFindOne;
      axios.post = originalPost;
    }

    assert.deepStrictEqual(calls, [{
      url: 'https://uazapi.example/send/text',
      body: { number: '5511999999999', text: 'mensagem original' }
    }]);
  });

  it('retries only transient provider failures', function() {
    assert.strictEqual(isTransientProviderError({ response: { status: 400 } }), false);
    assert.strictEqual(isTransientProviderError({ response: { status: 503 } }), true);
    assert.strictEqual(isTransientProviderError({ code: 'ECONNRESET' }), true);
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
