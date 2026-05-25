const assert = require('assert');
const campaignService = require('../services/wabaTemplateCampaignService');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getPath(source, path) {
  return String(path || '').split('.').reduce((current, part) => {
    if (current == null) return undefined;
    return current[part];
  }, source);
}

function setPath(source, path, value) {
  const parts = String(path || '').split('.');
  let current = source;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      current[part] = value;
      return;
    }
    if (!current[part] || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part];
  });
}

function unsetPath(source, path) {
  const parts = String(path || '').split('.');
  let current = source;
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = current && current[parts[i]];
    if (!current) return;
  }
  delete current[parts[parts.length - 1]];
}

function comparableTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? null : date.getTime();
}

function matchesValue(candidateValue, expectedValue) {
  if (expectedValue && typeof expectedValue === 'object' && !Array.isArray(expectedValue) && !(expectedValue instanceof Date)) {
    if (Object.prototype.hasOwnProperty.call(expectedValue, '$lte')) {
      const candidateTime = comparableTime(candidateValue);
      const expectedTime = comparableTime(expectedValue.$lte);
      if (candidateTime !== null && expectedTime !== null) return candidateTime <= expectedTime;
      return candidateValue <= expectedValue.$lte;
    }
    if (Object.prototype.hasOwnProperty.call(expectedValue, '$exists')) {
      return expectedValue.$exists ? candidateValue !== undefined : candidateValue === undefined;
    }
    if (Object.prototype.hasOwnProperty.call(expectedValue, '$elemMatch')) {
      return Array.isArray(candidateValue) && candidateValue.some((item) => matchesQuery(item, expectedValue.$elemMatch));
    }
    if (Object.prototype.hasOwnProperty.call(expectedValue, '$in')) {
      return expectedValue.$in.indexOf(candidateValue) !== -1;
    }
    if (Object.prototype.hasOwnProperty.call(expectedValue, '$nin')) {
      return expectedValue.$nin.indexOf(candidateValue) === -1;
    }
  }
  return candidateValue === expectedValue;
}

function matchesQuery(candidate, query) {
  return Object.keys(query || {}).every((key) => {
    if (key === '$or') return query.$or.some((condition) => matchesQuery(candidate, condition));
    if (key === '$and') return query.$and.every((condition) => matchesQuery(candidate, condition));
    return matchesValue(getPath(candidate, key), query[key]);
  });
}

function applyUpdate(candidate, update) {
  Object.keys(update.$set || {}).forEach((path) => setPath(candidate, path, update.$set[path]));
  Object.keys(update.$unset || {}).forEach((path) => unsetPath(candidate, path));
}

function fakeTransactionModel(store, capture) {
  capture = capture || {};
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

  Model.find = function(query) {
    let results = store.filter((candidate) => matchesQuery(candidate, query));

    const chain = {
      limit: (limit) => {
        results = results.slice(0, limit);
        return chain;
      },
      select: () => chain,
      lean: () => chain,
      exec: async () => clone(results)
    };
    return chain;
  };

  Model.findOneAndUpdate = function(query, update) {
    capture.findOneAndUpdateCalls = capture.findOneAndUpdateCalls || [];
    capture.findOneAndUpdateCalls.push({ query: clone(query), update: clone(update || {}) });
    return {
      exec: async () => {
        const index = store.findIndex((candidate) => matchesQuery(candidate, query));
        if (index === -1) return null;
        applyUpdate(store[index], update || {});
        return new Model(store[index]);
      }
    };
  };

  return Model;
}

function fakePublicationService(failPhone, options) {
  options = options || {};
  const calls = [];
  const service = {
    calls: calls,
    buildBoundWabaTemplateMessage: async () => ({
      binding: Object.assign({
        providerTemplateName: 'chatcase_menu_basico_inicio',
        suggestionName: 'menu_basico',
        integrationId: 'integration-1',
        wabaId: 'waba-1',
        language: 'pt_BR'
      }, options.binding || {})
    }),
    dispatchBoundWabaTemplate: async (dispatchOptions) => {
      calls.push(dispatchOptions);
      if (dispatchOptions.phoneNumber === failPhone) {
        return {
          status: 'failed',
          failed: 1,
          results: [{
            phoneNumber: dispatchOptions.phoneNumber,
            status: 'failed',
            error: 'provider_error'
          }]
        };
      }

      return {
        status: dispatchOptions.dryRun ? 'ready' : 'completed',
        sent: dispatchOptions.dryRun ? 0 : 1,
        failed: 0,
        results: [{
          phoneNumber: dispatchOptions.phoneNumber,
          status: dispatchOptions.dryRun ? 'ready' : 'accepted',
          messageId: dispatchOptions.dryRun ? null : 'wamid-' + dispatchOptions.phoneNumber
        }]
      };
    }
  };
  return service;
}

function fakeLeadModel(leads, capture) {
  capture = capture || {};
  return {
    find: (query) => {
      capture.query = query;
      return {
        limit: (limit) => {
          capture.limit = limit;
          return {
            select: (select) => {
              capture.select = select;
              return {
                lean: () => ({
                  exec: async () => leads.slice(0, limit)
                })
              };
            }
          };
        }
      };
    }
  };
}

function fakeRequestModel(leadIds, capture) {
  capture = capture || {};
  return {
    distinct: (field, query) => {
      capture.field = field;
      capture.query = query;
      return {
        exec: async () => leadIds
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
      consentConfirmed: true,
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
      consentConfirmed: true,
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
      consentConfirmed: true,
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

  it('requires explicit consent confirmation for real campaigns', async () => {
    const store = [];
    const Transaction = fakeTransactionModel(store);

    let error;
    try {
      await campaignService.createCampaign({
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
    } catch (err) {
      error = err;
    }

    assert(error);
    assert.strictEqual(error.message, 'waba_campaign_consent_required');
    assert.strictEqual(error.statusCode, 400);
    assert.strictEqual(store.length, 0);
  });

  it('keeps future scheduled campaigns queued for later without dispatching now', async () => {
    const store = [];
    const Transaction = fakeTransactionModel(store);
    const publication = fakePublicationService();

    const result = await campaignService.createCampaign({
      projectId: 'project-1',
      botId: 'bot-1',
      recipients: [
        { phoneNumber: '+55 62 98426-8492', recipientName: 'Enzo' }
      ],
      consentConfirmed: true,
      scheduledAt: '2026-05-25T15:00:00.000Z',
      runInBackground: false
    }, {
      Transaction: Transaction,
      publicationService: publication,
      nowFn: () => new Date('2026-05-25T14:00:00.000Z')
    });

    assert.strictEqual(result.status, 'scheduled');
    assert.strictEqual(result.processed_count, 0);
    assert.strictEqual(result.campaign.scheduledAt, '2026-05-25T15:00:00.000Z');
    assert.strictEqual(publication.calls.length, 0);
  });

  it('does not create per-campaign timers when the scheduler is disabled', async () => {
    const previous = process.env.WABA_TEMPLATE_CAMPAIGN_SCHEDULER_ENABLED;
    process.env.WABA_TEMPLATE_CAMPAIGN_SCHEDULER_ENABLED = 'false';
    const store = [];
    const Transaction = fakeTransactionModel(store);
    let timerCreated = false;

    try {
      const result = await campaignService.createCampaign({
        projectId: 'project-1',
        botId: 'bot-1',
        recipients: [
          { phoneNumber: '+55 62 98426-8492', recipientName: 'Enzo' }
        ],
        consentConfirmed: true,
        scheduledAt: '2026-05-25T15:00:00.000Z'
      }, {
        Transaction: Transaction,
        publicationService: fakePublicationService(),
        nowFn: () => new Date('2026-05-25T14:00:00.000Z'),
        setTimeoutFn: () => {
          timerCreated = true;
        }
      });

      assert.strictEqual(result.status, 'scheduled');
      assert.strictEqual(timerCreated, false);
    } finally {
      if (previous === undefined) {
        delete process.env.WABA_TEMPLATE_CAMPAIGN_SCHEDULER_ENABLED;
      } else {
        process.env.WABA_TEMPLATE_CAMPAIGN_SCHEDULER_ENABLED = previous;
      }
    }
  });

  it('rejects scheduled campaigns in the past instead of sending immediately', async () => {
    const store = [];
    const Transaction = fakeTransactionModel(store);

    let error;
    try {
      await campaignService.createCampaign({
        projectId: 'project-1',
        botId: 'bot-1',
        recipients: [
          { phoneNumber: '+55 62 98426-8492', recipientName: 'Enzo' }
        ],
        consentConfirmed: true,
        scheduledAt: '2026-05-25T13:00:00.000Z',
        runInBackground: false
      }, {
        Transaction: Transaction,
        publicationService: fakePublicationService(),
        nowFn: () => new Date('2026-05-25T14:00:00.000Z')
      });
    } catch (err) {
      error = err;
    }

    assert(error);
    assert.strictEqual(error.message, 'campaign_schedule_must_be_future');
    assert.strictEqual(error.statusCode, 400);
    assert.strictEqual(store.length, 0);
  });

  it('does not complete campaigns while a recipient is still sending and not stale', async () => {
    const store = [{
      transaction_id: 'tx-sending',
      id_project: 'project-1',
      status: 'running',
      channel: 'whatsapp',
      dispatch_type: campaignService.CAMPAIGN_TYPE,
      faq_kb_id: 'bot-1',
      dry_run: false,
      interval_ms: 0,
      recipients_total: 1,
      processed_count: 0,
      sent_count: 0,
      failed_count: 0,
      ready_count: 0,
      skipped_count: 0,
      recipients: [{
        phoneNumber: '5562984268492',
        recipientName: 'Enzo',
        status: 'sending',
        attempts: 1,
        updatedAt: '2026-05-25T14:00:00.000Z'
      }],
      campaign: {
        suggestionName: 'menu_basico',
        integrationId: 'integration-1',
        wabaId: 'waba-1',
        language: 'pt_BR'
      }
    }];
    const Transaction = fakeTransactionModel(store);
    const publication = fakePublicationService();

    const result = await campaignService.processCampaign({
      projectId: 'project-1',
      transactionId: 'tx-sending'
    }, {
      Transaction: Transaction,
      publicationService: publication,
      nowFn: () => new Date('2026-05-25T14:01:00.000Z'),
      sendingStaleMs: 10 * 60 * 1000
    });

    assert.strictEqual(result.status, 'running');
    assert.strictEqual(result.processed_count, 0);
    assert.strictEqual(publication.calls.length, 0);
  });

  it('recovers stale sending recipients and retries them', async () => {
    const store = [{
      transaction_id: 'tx-stale',
      id_project: 'project-1',
      status: 'running',
      channel: 'whatsapp',
      dispatch_type: campaignService.CAMPAIGN_TYPE,
      faq_kb_id: 'bot-1',
      dry_run: false,
      interval_ms: 0,
      recipients_total: 1,
      processed_count: 0,
      sent_count: 0,
      failed_count: 0,
      ready_count: 0,
      skipped_count: 0,
      recipients: [{
        phoneNumber: '5562984268492',
        recipientName: 'Enzo',
        status: 'sending',
        attempts: 1,
        updatedAt: '2026-05-25T14:00:00.000Z'
      }],
      campaign: {
        suggestionName: 'menu_basico',
        integrationId: 'integration-1',
        wabaId: 'waba-1',
        language: 'pt_BR'
      }
    }];
    const Transaction = fakeTransactionModel(store);
    const publication = fakePublicationService();

    const result = await campaignService.processCampaign({
      projectId: 'project-1',
      transactionId: 'tx-stale'
    }, {
      Transaction: Transaction,
      publicationService: publication,
      nowFn: () => new Date('2026-05-25T14:20:00.000Z'),
      sendingStaleMs: 1000,
      delayFn: async () => {}
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.sent_count, 1);
    assert.strictEqual(result.recipients[0].status, 'accepted');
    assert.strictEqual(publication.calls.length, 1);
  });

  it('does not process a campaign held by another active processing lease', async () => {
    const store = [{
      transaction_id: 'tx-locked',
      id_project: 'project-1',
      status: 'queued',
      channel: 'whatsapp',
      dispatch_type: campaignService.CAMPAIGN_TYPE,
      faq_kb_id: 'bot-1',
      dry_run: false,
      interval_ms: 0,
      recipients_total: 1,
      processed_count: 0,
      sent_count: 0,
      failed_count: 0,
      ready_count: 0,
      skipped_count: 0,
      recipients: [{
        phoneNumber: '5562984268492',
        recipientName: 'Enzo',
        status: 'queued',
        attempts: 0,
        updatedAt: '2026-05-25T14:00:00.000Z'
      }],
      campaign: {
        suggestionName: 'menu_basico',
        integrationId: 'integration-1',
        wabaId: 'waba-1',
        language: 'pt_BR',
        processing: {
          lockOwner: 'other-process',
          lockUntil: '2026-05-25T14:30:00.000Z'
        }
      }
    }];
    const Transaction = fakeTransactionModel(store);
    const publication = fakePublicationService();

    const result = await campaignService.processCampaign({
      projectId: 'project-1',
      transactionId: 'tx-locked'
    }, {
      Transaction: Transaction,
      publicationService: publication,
      nowFn: () => new Date('2026-05-25T14:00:00.000Z')
    });

    assert.strictEqual(result.status, 'queued');
    assert.strictEqual(publication.calls.length, 0);
    assert.strictEqual(store[0].recipients[0].status, 'queued');
  });

  it('renews the processing lease while processing multi-recipient campaigns', async () => {
    const store = [];
    const capture = {};
    const Transaction = fakeTransactionModel(store, capture);
    const publication = fakePublicationService();

    const result = await campaignService.createCampaign({
      projectId: 'project-1',
      botId: 'bot-1',
      recipients: [
        { phoneNumber: '+55 62 98426-8492', recipientName: 'Enzo' },
        { phoneNumber: '+55 62 99999-9999', recipientName: 'Cliente 2' }
      ],
      consentConfirmed: true,
      intervalMs: 0,
      runInBackground: false
    }, {
      Transaction: Transaction,
      publicationService: publication,
      processingLeaseMs: 1000,
      nowFn: () => new Date('2026-05-25T14:00:00.000Z')
    });

    const renewals = (capture.findOneAndUpdateCalls || []).filter((call) => {
      const set = call.update && call.update.$set || {};
      return Object.prototype.hasOwnProperty.call(set, 'campaign.processing.renewedAt');
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(publication.calls.length, 2);
    assert.ok(renewals.length >= 2);
  });

  it('heartbeats the processing lease while provider dispatch is pending', async () => {
    const store = [];
    const capture = {};
    const Transaction = fakeTransactionModel(store, capture);
    let heartbeat;
    const publication = fakePublicationService();
    const originalDispatch = publication.dispatchBoundWabaTemplate;
    let renewedDuringDispatch = false;
    publication.dispatchBoundWabaTemplate = async (dispatchOptions) => {
      const before = (capture.findOneAndUpdateCalls || []).length;
      assert.strictEqual(typeof heartbeat, 'function');
      await heartbeat();
      renewedDuringDispatch = (capture.findOneAndUpdateCalls || []).length > before;
      return originalDispatch(dispatchOptions);
    };

    const result = await campaignService.createCampaign({
      projectId: 'project-1',
      botId: 'bot-1',
      recipients: [
        { phoneNumber: '+55 62 98426-8492', recipientName: 'Enzo' }
      ],
      consentConfirmed: true,
      intervalMs: 0,
      runInBackground: false
    }, {
      Transaction: Transaction,
      publicationService: publication,
      processingLeaseMs: 1000,
      setIntervalFn: (fn) => {
        heartbeat = fn;
        return { unref: () => {} };
      },
      clearIntervalFn: () => {},
      nowFn: () => new Date('2026-05-25T14:00:00.000Z')
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(publication.calls.length, 1);
    assert.strictEqual(renewedDuringDispatch, true);
  });

  it('heartbeats the processing lease while campaign interval delay is pending', async () => {
    const store = [];
    const capture = {};
    const Transaction = fakeTransactionModel(store, capture);
    const publication = fakePublicationService();
    let heartbeat;
    let renewedDuringDelay = false;

    const result = await campaignService.createCampaign({
      projectId: 'project-1',
      botId: 'bot-1',
      recipients: [
        { phoneNumber: '+55 62 98426-8492', recipientName: 'Enzo' },
        { phoneNumber: '+55 62 99999-9999', recipientName: 'Cliente 2' }
      ],
      consentConfirmed: true,
      intervalMs: 2000,
      runInBackground: false
    }, {
      Transaction: Transaction,
      publicationService: publication,
      processingLeaseMs: 1000,
      setIntervalFn: (fn) => {
        heartbeat = fn;
        return { unref: () => {} };
      },
      clearIntervalFn: () => {},
      delayFn: async () => {
        const before = (capture.findOneAndUpdateCalls || []).length;
        assert.strictEqual(typeof heartbeat, 'function');
        await heartbeat();
        renewedDuringDelay = renewedDuringDelay || (capture.findOneAndUpdateCalls || []).length > before;
      },
      nowFn: () => new Date('2026-05-25T14:00:00.000Z')
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(publication.calls.length, 2);
    assert.strictEqual(renewedDuringDelay, true);
  });

  it('applies quality-aware throttling and blocks red quality by default', async () => {
    const store = [];
    const Transaction = fakeTransactionModel(store);

    const yellow = await campaignService.createCampaign({
      projectId: 'project-1',
      botId: 'bot-1',
      recipients: [
        { phoneNumber: '+55 62 98426-8492', recipientName: 'Enzo' }
      ],
      consentConfirmed: true,
      intervalMs: 0,
      autostart: false
    }, {
      Transaction: Transaction,
      publicationService: fakePublicationService(null, {
        binding: {
          qualityScore: 'YELLOW'
        }
      })
    });

    assert.strictEqual(yellow.interval_ms, 5000);
    assert.strictEqual(yellow.campaign.quality.rating, 'yellow');

    let error;
    try {
      await campaignService.createCampaign({
        projectId: 'project-1',
        botId: 'bot-1',
        recipients: [
          { phoneNumber: '+55 62 98426-8492', recipientName: 'Enzo' }
        ],
        consentConfirmed: true,
        autostart: false
      }, {
        Transaction: Transaction,
        publicationService: fakePublicationService(null, {
          binding: {
            qualityScore: 'RED'
          }
        })
      });
    } catch (err) {
      error = err;
    }

    assert(error);
    assert.strictEqual(error.message, 'waba_quality_blocks_campaign');
    assert.strictEqual(error.statusCode, 409);
  });

  it('ignores request payload quality when no server-side binding quality exists', async () => {
    const store = [];
    const Transaction = fakeTransactionModel(store);

    const result = await campaignService.createCampaign({
      projectId: 'project-1',
      botId: 'bot-1',
      recipients: [
        { phoneNumber: '+55 62 98426-8492', recipientName: 'Enzo' }
      ],
      consentConfirmed: true,
      qualityRating: 'RED',
      intervalMs: 0,
      autostart: false
    }, {
      Transaction: Transaction,
      publicationService: fakePublicationService()
    });

    assert.strictEqual(result.campaign.quality.rating, null);
    assert.strictEqual(result.interval_ms, 0);
  });

  it('uses server-side binding quality before request payload quality', async () => {
    const store = [];
    const Transaction = fakeTransactionModel(store);

    let error;
    try {
      await campaignService.createCampaign({
        projectId: 'project-1',
        botId: 'bot-1',
        recipients: [
          { phoneNumber: '+55 62 98426-8492', recipientName: 'Enzo' }
        ],
        consentConfirmed: true,
        qualityRating: 'green',
        autostart: false
      }, {
        Transaction: Transaction,
        publicationService: fakePublicationService(null, {
          binding: {
            qualityScore: 'red'
          }
        })
      });
    } catch (err) {
      error = err;
    }

    assert(error);
    assert.strictEqual(error.message, 'waba_quality_blocks_campaign');
    assert.strictEqual(error.statusCode, 409);
    assert.strictEqual(store.length, 0);
  });

  it('previews audience recipients from leads and keeps lead metadata', async () => {
    const leadCapture = {};
    const requestCapture = {};
    const result = await campaignService.previewAudience({
      projectId: 'project-1',
      audience: {
        type: 'contacts',
        channel: 'casezap',
        tags: ['vip'],
        limit: 10
      }
    }, {
      Lead: fakeLeadModel([
        { _id: 'lead-1', lead_id: 'casezap-inst-5562984268492', fullname: 'Enzo', tags: ['vip'] },
        { _id: 'lead-2', lead_id: 'casezap-inst-5562984268492', fullname: 'Duplicado', tags: ['vip'] },
        { _id: 'lead-3', lead_id: 'casezap-inst-invalid', fullname: 'Sem telefone', tags: ['vip'] }
      ], leadCapture),
      Request: fakeRequestModel(['lead-1', 'lead-2', 'lead-3'], requestCapture)
    });

    assert.strictEqual(requestCapture.field, 'lead');
    assert.deepStrictEqual(requestCapture.query['channel.name'].$in, ['casezap']);
    assert.strictEqual(leadCapture.query.id_project, 'project-1');
    assert.strictEqual(leadCapture.query.tags, 'vip');
    assert.strictEqual(leadCapture.query.$and[0].$or[0]._id.$in.length, 3);
    assert.ok(String(leadCapture.query.$and[0].$or[1].lead_id).indexOf('casezap') > -1);
    assert.strictEqual(result.audience.totalMatched, 3);
    assert.strictEqual(result.audience.validRecipients, 1);
    assert.strictEqual(result.audience.invalidRecipients, 1);
    assert.strictEqual(result.audience.duplicatesSkipped, 1);
    assert.deepStrictEqual(result.recipients, []);
  });

  it('excludes opted-out leads from campaign audiences', async () => {
    const result = await campaignService.previewAudience({
      projectId: 'project-1',
      audience: {
        type: 'contacts',
        limit: 10
      }
    }, {
      Lead: fakeLeadModel([
        { _id: 'lead-1', phone: '+55 62 98426-8492', fullname: 'Enzo' },
        {
          _id: 'lead-2',
          phone: '+55 62 99999-9999',
          fullname: 'Opt Out',
          attributes: {
            wabaConsent: {
              status: 'opted_out'
            }
          }
        }
      ])
    });

    assert.strictEqual(result.audience.totalMatched, 2);
    assert.strictEqual(result.audience.validRecipients, 1);
    assert.strictEqual(result.audience.optedOutSkipped, 1);
  });

  it('excludes boolean false consent values from audiences and manual recipients', async () => {
    const preview = await campaignService.previewAudience({
      projectId: 'project-1',
      audience: {
        type: 'contacts',
        limit: 10
      }
    }, {
      Lead: fakeLeadModel([
        { _id: 'lead-1', phone: '+55 62 98426-8492', fullname: 'Enzo' },
        {
          _id: 'lead-2',
          phone: '+55 62 99999-9999',
          fullname: 'Sem Consentimento',
          attributes: {
            whatsappConsent: false
          }
        }
      ])
    });

    const recipients = campaignService.normalizeCampaignRecipients([
      { phoneNumber: '+55 62 98426-8492', recipientName: 'Enzo' },
      { phoneNumber: '+55 62 99999-9999', recipientName: 'Sem Consentimento', whatsappConsent: false }
    ]);

    assert.strictEqual(preview.audience.validRecipients, 1);
    assert.strictEqual(preview.audience.optedOutSkipped, 1);
    assert.deepStrictEqual(recipients.map((recipient) => recipient.status), ['queued', 'skipped']);
    assert.strictEqual(recipients[1].skipReason, 'opted_out');
  });

  it('creates a tracked campaign from an audience', async () => {
    const store = [];
    const Transaction = fakeTransactionModel(store);

    const result = await campaignService.createCampaign({
      projectId: 'project-1',
      botId: 'bot-1',
      audience: {
        type: 'contacts',
        tags: 'vip',
        limit: 10
      },
      consentConfirmed: true,
      intervalMs: 0,
      runInBackground: false
    }, {
      Transaction: Transaction,
      Lead: fakeLeadModel([
        { _id: 'lead-1', phone: '+55 62 98426-8492', fullname: 'Enzo', tags: ['vip'] },
        { _id: 'lead-2', lead_id: 'wab-5562999999999', fullname: 'Cliente 2', tags: ['vip'] }
      ]),
      publicationService: fakePublicationService(),
      delayFn: async () => {}
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.recipients_total, 2);
    assert.strictEqual(result.campaign.audience.type, 'contacts');
    assert.strictEqual(result.campaign.audience.tags[0], 'vip');
    assert.deepStrictEqual(result.recipients.map((recipient) => recipient.phoneNumber), ['5562984268492', '5562999999999']);
    assert.strictEqual(result.recipients[0].leadId, 'lead-1');
    assert.strictEqual(result.recipients[0].leadKey, undefined);
    assert.strictEqual(result.recipients[0].email, undefined);
    assert.strictEqual(result.recipients[0].tags, undefined);
  });

  it('rejects deleted lead status audiences', async () => {
    let error;
    try {
      await campaignService.previewAudience({
        projectId: 'project-1',
        audience: {
          status: 1000
        }
      }, {
        Lead: fakeLeadModel([])
      });
    } catch (err) {
      error = err;
    }

    assert(error);
    assert.strictEqual(error.message, 'invalid_audience_status');
    assert.strictEqual(error.statusCode, 400);
  });

  it('rejects invalid segment ids before querying mongo', async () => {
    let error;
    try {
      await campaignService.previewAudience({
        projectId: 'project-1',
        audience: {
          segmentId: 'not-an-objectid'
        }
      }, {
        Lead: fakeLeadModel([])
      });
    } catch (err) {
      error = err;
    }

    assert(error);
    assert.strictEqual(error.message, 'invalid_audience_segment_id');
    assert.strictEqual(error.statusCode, 400);
  });

  it('sweeps due scheduled campaigns after a restart window', async () => {
    const store = [{
      transaction_id: 'tx-due',
      id_project: 'project-1',
      status: 'scheduled',
      channel: 'whatsapp',
      dispatch_type: campaignService.CAMPAIGN_TYPE,
      faq_kb_id: 'bot-1',
      dry_run: false,
      interval_ms: 0,
      recipients_total: 1,
      processed_count: 0,
      sent_count: 0,
      failed_count: 0,
      ready_count: 0,
      skipped_count: 0,
      recipients: [{
        phoneNumber: '5562984268492',
        recipientName: 'Enzo',
        status: 'queued',
        attempts: 0,
        updatedAt: '2026-05-25T13:00:00.000Z'
      }],
      campaign: {
        suggestionName: 'menu_basico',
        integrationId: 'integration-1',
        wabaId: 'waba-1',
        language: 'pt_BR',
        scheduledAt: '2026-05-25T13:00:00.000Z',
        nextRunAt: '2026-05-25T13:00:00.000Z'
      }
    }];
    const Transaction = fakeTransactionModel(store);
    const publication = fakePublicationService();

    const sweep = await campaignService.runScheduledCampaignSweep({
      limit: 5
    }, {
      Transaction: Transaction,
      publicationService: publication,
      nowFn: () => new Date('2026-05-25T14:00:00.000Z'),
      delayFn: async () => {}
    });

    assert.strictEqual(sweep.ok, true);
    assert.strictEqual(sweep.matched, 1);
    assert.strictEqual(sweep.processed, 1);
    assert.strictEqual(publication.calls.length, 1);
    assert.strictEqual(store[0].status, 'completed');
    assert.strictEqual(store[0].sent_count, 1);
  });

  it('sweeps stale running campaigns after a restart window', async () => {
    const store = [{
      transaction_id: 'tx-running-stale',
      id_project: 'project-1',
      status: 'running',
      channel: 'whatsapp',
      dispatch_type: campaignService.CAMPAIGN_TYPE,
      faq_kb_id: 'bot-1',
      dry_run: false,
      interval_ms: 0,
      recipients_total: 1,
      processed_count: 0,
      sent_count: 0,
      failed_count: 0,
      ready_count: 0,
      skipped_count: 0,
      recipients: [{
        phoneNumber: '5562984268492',
        recipientName: 'Enzo',
        status: 'sending',
        attempts: 1,
        updatedAt: '2026-05-25T13:00:00.000Z'
      }],
      campaign: {
        suggestionName: 'menu_basico',
        integrationId: 'integration-1',
        wabaId: 'waba-1',
        language: 'pt_BR'
      }
    }];
    const Transaction = fakeTransactionModel(store);
    const publication = fakePublicationService();

    const sweep = await campaignService.runScheduledCampaignSweep({
      limit: 5
    }, {
      Transaction: Transaction,
      publicationService: publication,
      nowFn: () => new Date('2026-05-25T14:00:00.000Z'),
      sendingStaleMs: 1000,
      delayFn: async () => {}
    });

    assert.strictEqual(sweep.ok, true);
    assert.strictEqual(sweep.matched, 1);
    assert.strictEqual(sweep.processed, 1);
    assert.strictEqual(publication.calls.length, 1);
    assert.strictEqual(store[0].status, 'completed');
    assert.strictEqual(store[0].sent_count, 1);
  });

  it('sweeps running campaigns that have queued recipients after a restart window', async () => {
    const store = [{
      transaction_id: 'tx-running-queued',
      id_project: 'project-1',
      status: 'running',
      channel: 'whatsapp',
      dispatch_type: campaignService.CAMPAIGN_TYPE,
      faq_kb_id: 'bot-1',
      dry_run: false,
      interval_ms: 0,
      recipients_total: 2,
      processed_count: 1,
      sent_count: 1,
      failed_count: 0,
      ready_count: 0,
      skipped_count: 0,
      recipients: [{
        phoneNumber: '5562984268492',
        recipientName: 'Enzo',
        status: 'accepted',
        attempts: 1,
        updatedAt: '2026-05-25T13:00:00.000Z'
      }, {
        phoneNumber: '5562999999999',
        recipientName: 'Cliente 2',
        status: 'queued',
        attempts: 0,
        updatedAt: '2026-05-25T13:00:00.000Z'
      }],
      campaign: {
        suggestionName: 'menu_basico',
        integrationId: 'integration-1',
        wabaId: 'waba-1',
        language: 'pt_BR'
      }
    }];
    const Transaction = fakeTransactionModel(store);
    const publication = fakePublicationService();

    const sweep = await campaignService.runScheduledCampaignSweep({
      limit: 5
    }, {
      Transaction: Transaction,
      publicationService: publication,
      nowFn: () => new Date('2026-05-25T14:00:00.000Z'),
      delayFn: async () => {}
    });

    assert.strictEqual(sweep.ok, true);
    assert.strictEqual(sweep.matched, 1);
    assert.strictEqual(sweep.processed, 1);
    assert.strictEqual(publication.calls.length, 1);
    assert.strictEqual(store[0].status, 'completed');
    assert.strictEqual(store[0].sent_count, 2);
  });
});
