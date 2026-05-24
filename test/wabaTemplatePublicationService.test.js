const assert = require('assert');
const nock = require('nock');
const service = require('../services/wabaTemplatePublicationService');
const chatcaseTemplates = require('../pubmodules/chatbotTemplates/chatcaseTemplates');

describe('WABA template publication service', () => {
  afterEach(() => {
    nock.cleanAll();
    delete process.env.META_GRAPH_URL;
  });

  it('builds a Meta message template payload from ChatCase suggestions', () => {
    const template = chatcaseTemplates.getTemplateById(chatcaseTemplates.CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC);
    const suggestion = template.attributes.publication.wabaTemplates[0];
    const payload = service.buildMetaTemplatePayload(suggestion);

    assert.strictEqual(payload.name, 'chatcase_menu_basico_inicio');
    assert.strictEqual(payload.language, 'pt_BR');
    assert.strictEqual(payload.category, 'MARKETING');
    assert.strictEqual(payload.components[0].type, 'BODY');
    assert.deepStrictEqual(payload.components[0].example.body_text, [['Cliente']]);
    assert.strictEqual(payload.components[1].type, 'BUTTONS');
    assert.deepStrictEqual(payload.components[1].buttons.map((button) => button.type), ['QUICK_REPLY', 'QUICK_REPLY']);
  });

  it('returns a dry-run payload and detects configured WABA credentials', async () => {
    const result = await service.publishWabaTemplate({
      projectId: 'project-1',
      templateId: chatcaseTemplates.CHATCASE_TEMPLATE_IDS.ECOMMERCE_ORDERS,
      dryRun: true
    }, {
      integration: {
        _id: 'integration-1',
        id_project: 'project-1',
        name: 'whatsapp',
        value: {}
      },
      settings: {
        value: {
          access_token: 'token-1',
          waba_id: 'waba-1'
        }
      },
      updateIntegration: false,
      operationalLogger: null
    });

    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.status, 'ready_to_publish');
    assert.strictEqual(result.canPublish, true);
    assert.strictEqual(result.metaPayload.name, 'chatcase_loja_status_pedido');
    assert(result.metaEndpoint.indexOf('/waba-1/message_templates') !== -1);
  });

  it('submits the template to Meta when publish is requested', async () => {
    process.env.META_GRAPH_URL = 'https://graph.facebook.com/v25.0/';
    const scope = nock('https://graph.facebook.com', {
      reqheaders: {
        authorization: 'Bearer token-1'
      }
    })
      .post('/v25.0/waba-1/message_templates', (body) => {
        return body.name === 'chatcase_clinica_agendamento' &&
          body.components.some((component) => component.type === 'BODY');
      })
      .reply(200, {
        id: 'template-provider-id',
        status: 'PENDING'
      });

    const result = await service.publishWabaTemplate({
      projectId: 'project-1',
      templateId: chatcaseTemplates.CHATCASE_TEMPLATE_IDS.CLINIC_SCHEDULING,
      dryRun: false
    }, {
      integration: {
        _id: 'integration-1',
        id_project: 'project-1',
        name: 'whatsapp',
        value: {}
      },
      settings: {
        value: {
          access_token: 'token-1',
          waba_id: 'waba-1'
        }
      },
      updateIntegration: false,
      operationalLogger: null
    });

    assert.strictEqual(result.dryRun, false);
    assert.strictEqual(result.status, 'submitted');
    assert.strictEqual(result.providerResponse.id, 'template-provider-id');
    assert(scope.isDone(), 'Meta template creation endpoint should be called');
  });
});
