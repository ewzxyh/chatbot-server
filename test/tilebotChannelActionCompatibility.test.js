process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');

const {
  adaptDirectivesForChannel,
  detectConversationChannel
} = require('../pubmodules/tilebot/channelActionCompatibility');

describe('Tilebot channel action compatibility', function() {
  it('detects CaseZap conversations from the support request channel', function() {
    const channel = detectConversationChannel(null, {
      request_id: 'support-group-project-request',
      channel: { name: 'casezap' }
    });

    assert.strictEqual(channel, 'casezap');
  });

  it('falls back WABA-only directives to text replies on CaseZap conversations', function() {
    const directives = [{
      name: 'whatsapp_static',
      action: {
        _tdActionType: 'whatsapp_static',
        attributes: {
          fallbackText: 'Menu ChatCase: responda com 1 ou 2.'
        }
      }
    }];

    const adapted = adaptDirectivesForChannel(directives, 'casezap');

    assert.strictEqual(adapted.length, 1);
    assert.strictEqual(adapted[0].name, 'reply');
    assert.strictEqual(adapted[0].action._tdActionType, 'reply');
    assert.strictEqual(adapted[0].action.text, 'Menu ChatCase: responda com 1 ou 2.');
  });

  it('keeps WABA-only directives native on WABA conversations', function() {
    const directive = {
      name: 'whatsapp_attribute',
      action: {
        _tdActionType: 'whatsapp_attribute',
        attributes: {
          fallbackText: 'Texto alternativo'
        }
      }
    };

    const adapted = adaptDirectivesForChannel([directive], 'waba');

    assert.strictEqual(adapted[0], directive);
  });
});
