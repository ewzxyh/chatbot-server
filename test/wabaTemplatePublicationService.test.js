const assert = require('assert');
const nock = require('nock');
const service = require('../services/wabaTemplatePublicationService');
const chatcaseTemplates = require('../pubmodules/chatbotTemplates/chatcaseTemplates');

function fakeTemplateTranslator() {
  return {
    toWhatsapp: async (message, to) => {
      const template = message.attributes.attachment.template;
      const whatsappMessage = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'template',
        template: {
          name: template.name,
          language: {
            code: template.language
          }
        }
      };
      if (template.params && template.params.body) {
        whatsappMessage.template.components = [{
          type: 'body',
          parameters: template.params.body
        }];
      }
      return whatsappMessage;
    }
  };
}

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

  it('returns missing credential status when syncing without configured WABA', async () => {
    const template = chatcaseTemplates.getTemplateById(chatcaseTemplates.CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC);
    const expectedSuggestions = template.attributes.publication.wabaTemplates.length;
    const result = await service.syncWabaTemplateStatuses({
      projectId: 'project-1',
      templateId: chatcaseTemplates.CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC
    }, {
      integration: null,
      settings: null,
      updateIntegration: false,
      operationalLogger: null
    });

    assert.strictEqual(result.status, 'missing_waba_credentials');
    assert.strictEqual(result.canSync, false);
    assert.strictEqual(result.templates.length, expectedSuggestions);
    assert.strictEqual(result.templates[0].state, 'not_found');
    assert.strictEqual(result.summary.notFound, expectedSuggestions);
  });

  it('syncs suggested template status from Meta', async () => {
    process.env.META_GRAPH_URL = 'https://graph.facebook.com/v25.0/';
    const scope = nock('https://graph.facebook.com', {
      reqheaders: {
        authorization: 'Bearer token-1'
      }
    })
      .get('/v25.0/waba-1/message_templates')
      .query((query) => query.fields && query.limit === '200')
      .reply(200, {
        data: [
          {
            id: 'template-provider-id',
            name: 'chatcase_menu_basico_inicio',
            language: 'pt_BR',
            category: 'MARKETING',
            status: 'APPROVED',
            quality_score: {
              score: 'GREEN'
            }
          }
        ]
      });

    const result = await service.syncWabaTemplateStatuses({
      projectId: 'project-1',
      templateId: chatcaseTemplates.CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC
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

    assert.strictEqual(result.status, 'synced');
    assert.strictEqual(result.canSync, true);
    assert.strictEqual(result.templates[0].state, 'approved');
    assert.strictEqual(result.summary.approved, 1);
    assert.strictEqual(result.summary.notFound, result.templates.length - 1);
    assert(scope.isDone(), 'Meta template list endpoint should be called');
  });

  it('syncs using WABA credentials saved only in kvstore', async () => {
    process.env.META_GRAPH_URL = 'https://graph.facebook.com/v25.0/';
    let capturedQuery;
    const scope = nock('https://graph.facebook.com', {
      reqheaders: {
        authorization: 'Bearer token-1'
      }
    })
      .get('/v25.0/waba-1/message_templates')
      .query((query) => query.fields && query.limit === '200')
      .reply(200, {
        data: [
          {
            id: 'template-provider-id',
            name: 'chatcase_menu_basico_inicio',
            language: 'pt_BR',
            category: 'MARKETING',
            status: 'PENDING'
          }
        ]
      });

    const result = await service.syncWabaTemplateStatuses({
      projectId: 'project-1',
      templateId: chatcaseTemplates.CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC
    }, {
      integration: null,
      mongooseConnection: {
        collection: () => ({
          findOne: async (query) => {
            capturedQuery = query;
            return {
              _id: 'kvstore-1',
              key: 'whatsapp-waba-1',
              project_id: 'project-1',
              value: {
                wab_token: 'token-1',
                waba_id: 'waba-1'
              }
            };
          }
        })
      },
      updateIntegration: false,
      operationalLogger: null
    });

    assert.strictEqual(result.status, 'synced');
    assert.strictEqual(result.canSync, true);
    assert.strictEqual(result.waba.integrationId, null);
    assert.strictEqual(result.waba.wabaId, 'waba-1');
    assert.strictEqual(result.templates[0].state, 'pending');
    assert.strictEqual(result.summary.notFound, result.templates.length - 1);
    assert(capturedQuery.$or.some((clause) => clause.project_id === 'project-1'), 'kvstore lookup should include project fallback');
    assert(scope.isDone(), 'Meta template list endpoint should be called with kvstore credentials');
  });

  it('binds an approved Meta template to a bot publication attributes', async () => {
    process.env.META_GRAPH_URL = 'https://graph.facebook.com/v25.0/';
    const scope = nock('https://graph.facebook.com', {
      reqheaders: {
        authorization: 'Bearer token-1'
      }
    })
      .get('/v25.0/waba-1/message_templates')
      .query((query) => query.fields && query.limit === '200')
      .reply(200, {
        data: [
          {
            id: 'template-provider-id',
            name: 'chatcase_menu_basico_inicio',
            language: 'pt_BR',
            category: 'MARKETING',
            status: 'APPROVED'
          }
        ]
      });

    let savedUpdate;
    const fakeFaqKb = {
      findOne: () => ({
        lean: () => ({
          exec: async () => ({
            _id: 'bot-1',
            id_project: 'project-1',
            attributes: {
              existing: true,
              publication: {
                note: 'keep-me'
              }
            }
          })
        })
      }),
      findByIdAndUpdate: (id, update) => {
        savedUpdate = { id, update };
        return {
          lean: () => ({
            exec: async () => Object.assign({ _id: id }, update.$set)
          })
        };
      }
    };

    const result = await service.bindApprovedWabaTemplateToBot({
      projectId: 'project-1',
      templateId: chatcaseTemplates.CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC,
      botId: 'bot-1'
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
      FaqKb: fakeFaqKb,
      updateIntegration: false,
      operationalLogger: null
    });

    const binding = savedUpdate.update.$set.attributes.publication.wabaTemplateBinding;
    assert.strictEqual(result.status, 'bound');
    assert.strictEqual(savedUpdate.id, 'bot-1');
    assert.strictEqual(savedUpdate.update.$set.attributes.existing, true);
    assert.strictEqual(savedUpdate.update.$set.attributes.publication.note, 'keep-me');
    assert.strictEqual(binding.suggestionName, 'chatcase_menu_basico_inicio');
    assert.strictEqual(binding.providerTemplateId, 'template-provider-id');
    assert.strictEqual(binding.state, 'approved');
    assert.strictEqual(binding.wabaId, 'waba-1');
    assert.strictEqual(savedUpdate.update.$set.attributes.publication.wabaTemplateBindings.length, 1);
    assert(scope.isDone(), 'Meta template list endpoint should be called before binding');
  });

  it('builds a Tiledesk WABA template message from a bot binding', async () => {
    const binding = {
      channel: 'waba',
      provider: 'meta',
      templateId: chatcaseTemplates.CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC,
      templateName: 'ChatCase WhatsApp menu basico',
      suggestionName: 'chatcase_menu_basico_inicio',
      providerTemplateId: 'template-provider-id',
      providerTemplateName: 'chatcase_menu_basico_inicio',
      language: 'pt_BR',
      status: 'APPROVED',
      state: 'approved',
      wabaId: 'waba-1',
      integrationId: 'integration-1'
    };
    const fakeFaqKb = {
      findOne: () => ({
        lean: () => ({
          exec: async () => ({
            _id: 'bot-1',
            id_project: 'project-1',
            attributes: {
              publication: {
                wabaTemplateBinding: binding
              }
            }
          })
        })
      })
    };

    const result = await service.buildBoundWabaTemplateMessage({
      projectId: 'project-1',
      botId: 'bot-1',
      recipientName: 'Enzo'
    }, {
      FaqKb: fakeFaqKb
    });

    const template = result.message.attributes.attachment.template;
    assert.strictEqual(result.status, 'ready');
    assert.strictEqual(result.botId, 'bot-1');
    assert.strictEqual(template.name, 'chatcase_menu_basico_inicio');
    assert.strictEqual(template.language, 'pt_BR');
    assert.strictEqual(template.params.body[0].type, 'text');
    assert.strictEqual(template.params.body[0].text, 'Enzo');
    assert.strictEqual(result.message.attributes.wabaTemplateBinding.providerTemplateId, 'template-provider-id');
  });

  it('builds a dry-run WABA template dispatch from an approved bot binding', async () => {
    const binding = {
      channel: 'waba',
      provider: 'meta',
      templateId: chatcaseTemplates.CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC,
      suggestionName: 'chatcase_menu_basico_inicio',
      providerTemplateId: 'template-provider-id',
      providerTemplateName: 'chatcase_menu_basico_inicio',
      language: 'pt_BR',
      status: 'APPROVED',
      state: 'approved',
      wabaId: 'waba-1',
      integrationId: 'integration-1'
    };
    const fakeFaqKb = {
      findOne: () => ({
        lean: () => ({
          exec: async () => ({
            _id: 'bot-1',
            id_project: 'project-1',
            attributes: {
              publication: {
                wabaTemplateBinding: binding
              }
            }
          })
        })
      })
    };

    const result = await service.dispatchBoundWabaTemplate({
      projectId: 'project-1',
      botId: 'bot-1',
      phoneNumber: '+55 (62) 98426-8492',
      recipientName: 'Enzo',
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
          wab_token: 'token-1',
          waba_id: 'waba-1',
          phone_number_id: 'phone-number-1'
        }
      },
      FaqKb: fakeFaqKb,
      translator: fakeTemplateTranslator(),
      whatsappClient: {
        sendMessage: async () => {
          throw new Error('dry-run should not send to Meta');
        }
      },
      operationalLogger: null
    });

    assert.strictEqual(result.status, 'ready');
    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.phoneNumberId, 'phone-number-1');
    assert.strictEqual(result.results[0].phoneNumber, '5562984268492');
    assert.strictEqual(result.results[0].whatsappJsonMessage.type, 'template');
    assert.strictEqual(result.results[0].whatsappJsonMessage.template.name, 'chatcase_menu_basico_inicio');
    assert.strictEqual(result.results[0].whatsappJsonMessage.template.components[0].parameters[0].text, 'Enzo');
  });

  it('sends a bound WABA template and persists broadcast logs', async () => {
    const binding = {
      channel: 'waba',
      provider: 'meta',
      templateId: chatcaseTemplates.CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC,
      suggestionName: 'chatcase_menu_basico_inicio',
      providerTemplateId: 'template-provider-id',
      providerTemplateName: 'chatcase_menu_basico_inicio',
      language: 'pt_BR',
      status: 'APPROVED',
      state: 'approved',
      wabaId: 'waba-1',
      integrationId: 'integration-1'
    };
    const fakeFaqKb = {
      findOne: () => ({
        lean: () => ({
          exec: async () => ({
            _id: 'bot-1',
            id_project: 'project-1',
            attributes: {
              publication: {
                wabaTemplateBinding: binding
              }
            }
          })
        })
      })
    };
    const transactionUpdates = [];
    const savedLogs = [];
    const fakeTransaction = {
      findOneAndUpdate: (query, update) => {
        transactionUpdates.push({ query, update });
        return {
          lean: () => ({
            exec: async () => Object.assign({}, query, update.$set)
          })
        };
      }
    };
    function FakeMessageLog(doc) {
      this.doc = doc;
      this.save = function(callback) {
        savedLogs.push(doc);
        callback(null, doc);
      };
    }
    const sentMessages = [];

    const result = await service.dispatchBoundWabaTemplate({
      projectId: 'project-1',
      botId: 'bot-1',
      phoneNumber: '+55 62 98426-8492',
      recipientName: 'Enzo',
      transactionId: 'transaction-1'
    }, {
      integration: {
        _id: 'integration-1',
        id_project: 'project-1',
        name: 'whatsapp',
        value: {}
      },
      settings: {
        value: {
          wab_token: 'token-1',
          waba_id: 'waba-1',
          phone_number_id: 'phone-number-1'
        }
      },
      FaqKb: fakeFaqKb,
      Transaction: fakeTransaction,
      MessageLog: FakeMessageLog,
      translator: fakeTemplateTranslator(),
      whatsappClient: {
        sendMessage: async (phoneNumberId, message) => {
          sentMessages.push({ phoneNumberId, message });
          return {
            status: 200,
            data: {
              messages: [{ id: 'wamid-1' }]
            }
          };
        }
      },
      operationalLogger: null
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.sent, 1);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.results[0].messageId, 'wamid-1');
    assert.strictEqual(sentMessages[0].phoneNumberId, 'phone-number-1');
    assert.strictEqual(sentMessages[0].message.to, '5562984268492');
    assert.strictEqual(savedLogs[0].message_id, 'wamid-1');
    assert.strictEqual(savedLogs[0].transaction_id, 'transaction-1');
    assert.strictEqual(transactionUpdates.length, 2);
    assert.strictEqual(transactionUpdates[0].update.$set.status, 'pending');
    assert.strictEqual(transactionUpdates[1].update.$set.status, 'completed');
  });

  it('sends a bound WABA template to multiple recipients', async () => {
    const binding = {
      channel: 'waba',
      provider: 'meta',
      templateId: chatcaseTemplates.CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC,
      suggestionName: 'chatcase_menu_basico_inicio',
      providerTemplateId: 'template-provider-id',
      providerTemplateName: 'chatcase_menu_basico_inicio',
      language: 'pt_BR',
      status: 'APPROVED',
      state: 'approved',
      wabaId: 'waba-1',
      integrationId: 'integration-1'
    };
    const fakeFaqKb = {
      findOne: () => ({
        lean: () => ({
          exec: async () => ({
            _id: 'bot-1',
            id_project: 'project-1',
            attributes: {
              publication: {
                wabaTemplateBinding: binding
              }
            }
          })
        })
      })
    };
    const transactionUpdates = [];
    const savedLogs = [];
    const fakeTransaction = {
      findOneAndUpdate: (query, update) => {
        transactionUpdates.push({ query, update });
        return {
          lean: () => ({
            exec: async () => Object.assign({}, query, update.$set)
          })
        };
      }
    };
    function FakeMessageLog(doc) {
      this.doc = doc;
      this.save = function(callback) {
        savedLogs.push(doc);
        callback(null, doc);
      };
    }
    const sentMessages = [];

    const result = await service.dispatchBoundWabaTemplate({
      projectId: 'project-1',
      botId: 'bot-1',
      recipients: [
        { phoneNumber: '+55 62 98426-8492', recipientName: 'Enzo' },
        { phoneNumber: '+55 62 99999-9999', recipientName: 'Cliente 2' }
      ],
      transactionId: 'transaction-batch-1'
    }, {
      integration: {
        _id: 'integration-1',
        id_project: 'project-1',
        name: 'whatsapp',
        value: {}
      },
      settings: {
        value: {
          wab_token: 'token-1',
          waba_id: 'waba-1',
          phone_number_id: 'phone-number-1'
        }
      },
      FaqKb: fakeFaqKb,
      Transaction: fakeTransaction,
      MessageLog: FakeMessageLog,
      translator: fakeTemplateTranslator(),
      whatsappClient: {
        sendMessage: async (phoneNumberId, message) => {
          sentMessages.push({ phoneNumberId, message });
          return {
            status: 200,
            data: {
              messages: [{ id: 'wamid-' + sentMessages.length }]
            }
          };
        }
      },
      operationalLogger: null
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.sent, 2);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.recipients, 2);
    assert.strictEqual(sentMessages.length, 2);
    assert.deepStrictEqual(sentMessages.map((item) => item.message.to), ['5562984268492', '5562999999999']);
    assert.strictEqual(sentMessages[0].message.template.components[0].parameters[0].text, 'Enzo');
    assert.strictEqual(sentMessages[1].message.template.components[0].parameters[0].text, 'Cliente 2');
    assert.strictEqual(savedLogs.length, 2);
    assert.deepStrictEqual(savedLogs.map((item) => item.message_id), ['wamid-1', 'wamid-2']);
    assert.strictEqual(transactionUpdates.length, 2);
    assert.strictEqual(transactionUpdates[0].update.$set.status, 'pending');
    assert.strictEqual(transactionUpdates[1].update.$set.status, 'completed');
  });

  it('rejects bound WABA dispatch when the connected account has no phone number ID', async () => {
    const fakeFaqKb = {
      findOne: () => ({
        lean: () => ({
          exec: async () => ({
            _id: 'bot-1',
            id_project: 'project-1',
            attributes: {
              publication: {
                wabaTemplateBinding: {
                  channel: 'waba',
                  templateId: chatcaseTemplates.CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC,
                  suggestionName: 'chatcase_menu_basico_inicio',
                  providerTemplateName: 'chatcase_menu_basico_inicio',
                  language: 'pt_BR',
                  status: 'APPROVED',
                  state: 'approved'
                }
              }
            }
          })
        })
      })
    };

    await assert.rejects(
      () => service.dispatchBoundWabaTemplate({
        projectId: 'project-1',
        botId: 'bot-1',
        phoneNumber: '+55 62 98426-8492'
      }, {
        integration: {
          _id: 'integration-1',
          id_project: 'project-1',
          name: 'whatsapp',
          value: {}
        },
        settings: {
          value: {
            wab_token: 'token-1',
            waba_id: 'waba-1'
          }
        },
        FaqKb: fakeFaqKb,
        operationalLogger: null
      }),
      (error) => {
        assert.strictEqual(error.message, 'missing_waba_phone_number_id');
        assert.strictEqual(error.statusCode, 400);
        return true;
      }
    );
  });

  it('rejects bound WABA message generation when no approved binding exists', async () => {
    const fakeFaqKb = {
      findOne: () => ({
        lean: () => ({
          exec: async () => ({
            _id: 'bot-1',
            id_project: 'project-1',
            attributes: {
              publication: {
                wabaTemplateBinding: {
                  state: 'pending',
                  suggestionName: 'chatcase_menu_basico_inicio'
                }
              }
            }
          })
        })
      })
    };

    await assert.rejects(
      () => service.buildBoundWabaTemplateMessage({
        projectId: 'project-1',
        botId: 'bot-1'
      }, {
        FaqKb: fakeFaqKb
      }),
      (error) => {
        assert.strictEqual(error.message, 'waba_template_binding_not_found');
        assert.strictEqual(error.statusCode, 404);
        return true;
      }
    );
  });

  it('rejects binding when the Meta template is not approved yet', async () => {
    process.env.META_GRAPH_URL = 'https://graph.facebook.com/v25.0/';
    const scope = nock('https://graph.facebook.com', {
      reqheaders: {
        authorization: 'Bearer token-1'
      }
    })
      .get('/v25.0/waba-1/message_templates')
      .query((query) => query.fields && query.limit === '200')
      .reply(200, {
        data: [
          {
            id: 'template-provider-id',
            name: 'chatcase_menu_basico_inicio',
            language: 'pt_BR',
            category: 'MARKETING',
            status: 'PENDING'
          }
        ]
      });

    await assert.rejects(
      () => service.bindApprovedWabaTemplateToBot({
        projectId: 'project-1',
        templateId: chatcaseTemplates.CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC,
        botId: 'bot-1'
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
      }),
      (error) => {
        assert.strictEqual(error.message, 'waba_template_not_approved');
        assert.strictEqual(error.statusCode, 409);
        assert.strictEqual(error.sync.summary.pending, 1);
        return true;
      }
    );

    assert(scope.isDone(), 'Meta template list endpoint should be called before rejecting the bind');
  });
});
