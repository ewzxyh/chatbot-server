const assert = require('assert');
const campaignService = require('../services/wabaTemplateCampaignService');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fakeTransactionModel(store) {
  function Model(data) {
    Object.assign(this, clone(data || {}));
  }

  Model.prototype.save = async function() {
    const data = clone(this);
    const index = store.findIndex((item) => item.transaction_id === data.transaction_id);
    if (index === -1) {
      store.push(data);
    } else {
      store[index] = data;
    }
    return this;
  };

  Model.prototype.toObject = function() {
    return clone(this);
  };

  Model.findOne = function(query) {
    return {
      exec: async () => {
        const item = store.find((candidate) => {
          return candidate.id_project === query.id_project &&
            candidate.transaction_id === query.transaction_id;
        });
        return item ? new Model(item) : null;
      }
    };
  };

  return Model;
}

function fakePublicationService(failPhone) {
  return {
    buildBoundWabaTemplateMessage: async () => ({
      binding: {
        providerTemplateName: 'chatcase_menu_basico_inicio',
        suggestionName: 'menu_basico',
        integrationId: 'integration-1',
        wabaId: 'waba-1',
        language: 'pt_BR'
      }
    }),
    dispatchBoundWabaTemplate: async (options) => {
      if (options.phoneNumber === failPhone) {
        return {
          status: 'failed',
          failed: 1,
          results: [{
            phoneNumber: options.phoneNumber,
            status: 'failed',
            error: 'provider_error'
          }]
        };
      }

      return {
        status: options.dryRun ? 'ready' : 'completed',
        sent: options.dryRun ? 0 : 1,
        failed: 0,
        results: [{
          phoneNumber: options.phoneNumber,
          status: options.dryRun ? 'ready' : 'accepted',
          messageId: options.dryRun ? null : 'wamid-' + options.phoneNumber
        }]
      };
    }
  };
}

describe('WABA template campaign service', () => {
  it('normalizes and deduplicates campaign recipients', () => {
    const recipients = campaignService.normalizeCampaignRecipients([
      '+55 62 98426-8492; ignored',
      { phoneNumber: '+55 62 98426-8492', recipientName: 'Duplicate' },
      { phone: '+55 62 99999-9999', name: 'Cliente 2' }
    ]);

    assert.strictEqual(recipients.length, 2);
    assert.strictEqual(recipients[0].phoneNumber, '5562984268492');
    assert.strictEqual(recipients[1].recipientName, 'Cliente 2');
  });

  it('processes a tracked campaign and stores recipient progress', async () => {
    const store = [];
    const Transaction = fakeTransactionModel(store);

    const result = await campaignService.createCampaign({
      projectId: 'project-1',
      botId: 'bot-1',
      recipients: [
        { phoneNumber: '+55 62 98426-8492', recipientName: 'Enzo' },
        { phoneNumber: '+55 62 99999-9999', recipientName: 'Cliente 2' }
      ],
      intervalMs: 0,
      runInBackground: false
    }, {
      Transaction: Transaction,
      publicationService: fakePublicationService(),
      delayFn: async () => {}
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.dispatch_type, campaignService.CAMPAIGN_TYPE);
    assert.strictEqual(result.recipients_total, 2);
    assert.strictEqual(result.processed_count, 2);
    assert.strictEqual(result.sent_count, 2);
    assert.strictEqual(result.failed_count, 0);
    assert.deepStrictEqual(result.recipients.map((recipient) => recipient.status), ['accepted', 'accepted']);
  });

  it('can pause, resume and cancel persisted campaigns', async () => {
    const store = [];
    const Transaction = fakeTransactionModel(store);

    const created = await campaignService.createCampaign({
      projectId: 'project-1',
      botId: 'bot-1',
      recipients: [
        { phoneNumber: '+55 62 98426-8492', recipientName: 'Enzo' }
      ],
      autostart: false
    }, {
      Transaction: Transaction,
      publicationService: fakePublicationService()
    });

    const paused = await campaignService.pauseCampaign({
      projectId: 'project-1',
      transactionId: created.transaction_id
    }, { Transaction: Transaction });
    assert.strictEqual(paused.status, 'paused');

    const canceled = await campaignService.cancelCampaign({
      projectId: 'project-1',
      transactionId: created.transaction_id
    }, { Transaction: Transaction });
    assert.strictEqual(canceled.status, 'canceled');
    assert.strictEqual(canceled.skipped_count, 1);
  });

  it('marks campaigns completed with errors when a recipient fails', async () => {
    const store = [];
    const Transaction = fakeTransactionModel(store);

    const result = await campaignService.createCampaign({
      projectId: 'project-1',
      botId: 'bot-1',
      recipients: [
        { phoneNumber: '+55 62 98426-8492', recipientName: 'Enzo' },
        { phoneNumber: '+55 62 99999-9999', recipientName: 'Cliente 2' }
      ],
      intervalMs: 0,
      runInBackground: false
    }, {
      Transaction: Transaction,
      publicationService: fakePublicationService('5562999999999'),
      delayFn: async () => {}
    });

    assert.strictEqual(result.status, 'completed_with_errors');
    assert.strictEqual(result.sent_count, 1);
    assert.strictEqual(result.failed_count, 1);
    assert.deepStrictEqual(result.recipients.map((recipient) => recipient.status), ['accepted', 'failed']);
  });
});
