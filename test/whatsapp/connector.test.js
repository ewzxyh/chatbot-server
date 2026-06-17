process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');

const {
  hasStoredWabaMessage,
  setWabaMessageId
} = require('../../pubmodules/whatsapp/connector/dedupe');

describe('WhatsApp connector', function() {
  it('detects a WABA message already stored in Mongo', async function() {
    const calls = [];
    const exists = await hasStoredWabaMessage('project-1', 'wamid-1', {
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
        'attributes.wabaMessageId': 'wamid-1'
      },
      { select: '_id' }
    ]);
  });

  it('marks translated messages with the WABA message id', function() {
    const message = { text: 'Oi' };

    setWabaMessageId(message, 'wamid-1');

    assert.deepStrictEqual(message.attributes, {
      wabaMessageId: 'wamid-1'
    });
  });
});
