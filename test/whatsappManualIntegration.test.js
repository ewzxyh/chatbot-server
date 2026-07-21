var assert = require('assert');

var whatsappIntegration = require('../pubmodules/whatsapp/connector/utils/WhatsappIntegration');

describe('WhatsApp manual integration', function() {
  var settings = {
    project_id: 'project-1',
    token: 'project-token',
    business_account_id: 'waba-1',
    phone_number_id: 'phone-1',
    phone_number: '+5511999999999',
    verified_name: 'ChatCase Test'
  };

  it('creates the same integration contract used by the platform quota', async function() {
    var posted;
    var client = {
      get: async function() { return { data: [] }; },
      post: async function(url, body, config) {
        posted = { url: url, body: body, config: config };
        return { data: { _id: 'integration-1' } };
      }
    };

    var result = await whatsappIntegration.ensure(settings, 'https://api.test', client);

    assert.strictEqual(result._id, 'integration-1');
    assert.strictEqual(posted.url, 'https://api.test/project-1/integration');
    assert.strictEqual(posted.config.headers.Authorization, 'JWT project-token');
    assert.deepStrictEqual(posted.body, {
      name: 'whatsapp',
      value: {
        phone_number_id: 'phone-1',
        waba_id: 'waba-1',
        phone_number: '+5511999999999',
        verified_name: 'ChatCase Test'
      }
    });
  });

  it('reuses an existing phone integration without consuming another slot', async function() {
    var postCalls = 0;
    var existing = {
      _id: 'integration-1',
      value: { phone_number_id: 'phone-1' }
    };
    var client = {
      get: async function() { return { data: [existing] }; },
      post: async function() { postCalls += 1; }
    };

    var result = await whatsappIntegration.ensure(settings, 'https://api.test', client);

    assert.strictEqual(result, existing);
    assert.strictEqual(postCalls, 0);
  });

  it('propagates the platform limit rejection before settings are persisted', async function() {
    var limitError = new Error('Platform limit reached');
    limitError.response = {
      status: 403,
      data: { error: 'platforms_limit_reached' }
    };
    var client = {
      get: async function() { return { data: [] }; },
      post: async function() { throw limitError; }
    };

    await assert.rejects(
      whatsappIntegration.ensure(settings, 'https://api.test', client),
      function(err) {
        return err.response && err.response.data.error === 'platforms_limit_reached';
      }
    );
  });
});
