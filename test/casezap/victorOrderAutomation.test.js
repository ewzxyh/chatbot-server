process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');
const automation = require('../../pubmodules/casezap/victorOrderAutomation');

describe('Victor order automation', function() {
  it('normalizes the PIX key and parses Brazilian PIX amounts', function() {
    assert.strictEqual(automation.normalizeCaseZapPixKey('  \'redacted@example.invalid\'  '), 'redacted@example.invalid');
    assert.strictEqual(automation.parsePixAmountCents('PIX R$ 1.234,56'), 123456);
    assert.strictEqual(automation.parsePixAmountCents('Pagamento PIX: 99,90'), 9990);
    assert.strictEqual(automation.parsePixAmountCents('valor R$ 10,00'), null);
  });

  it('accepts only manual fromMe messages', function() {
    assert.strictEqual(automation.isManualFromMe({ message: { fromMe: true, wasSentByApi: false } }), true);
    assert.strictEqual(automation.isManualFromMe({ message: { fromMe: true, wasSentByApi: true } }), false);
    assert.strictEqual(automation.isManualFromMe({ message: { fromMe: false, wasSentByApi: false } }), false);
  });

  it('builds the Shopee and PIX sequence as separate messages', function() {
    const messages = automation.buildVictorAutomationMessages(
      18000,
      'redacted@example.invalid',
      automation.DEFAULT_SHOPEE_URL
    );

    assert.deepStrictEqual(messages.map((message) => message.text), [
      'O frete agora é feito pela Shopee.',
      automation.DEFAULT_SHOPEE_URL,
      'Esse aqui é o frete 👆',
      'Você compra esse item e vale pelo frete.',
      'O valor ficou em R$ 180,00. Faça o pagamento via PIX na chave redacted@example.invalid e envie o comprovante aqui.'
    ]);
    assert.deepStrictEqual(messages.map((message) => message.shopee), [true, true, true, true, false]);
    assert.strictEqual(
      automation.buildVictorAutomationText(18000, 'redacted@example.invalid', automation.DEFAULT_SHOPEE_URL),
      messages.map((message) => message.text).join('\n\n')
    );
    assert.strictEqual(automation.containsShopeeFlowText('O frete é feito pela shoope'), true);
  });

  it('claims a manual Shopee message before the PIX quote resumes automation', async function() {
    let claims = 0;
    const result = await automation.handleInboundMessage({
      model: { findOneAndUpdate: async function() { return { request_id: 'request-1' }; } },
      request: {
        request_id: 'request-1',
        id_project: 'project-1',
        attributes: { casezapOrder: { state: 'awaiting_quote' } }
      },
      pixKey: 'redacted@example.invalid',
      rawMessage: { message: { fromMe: true, wasSentByApi: false } },
      mapped: { text: 'O frete é feito pela shoope' },
      claimShopeeFlow: async function() { claims += 1; return true; }
    });

    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(result.reason, 'pix_key_not_found');
    assert.strictEqual(claims, 1);
  });

  it('marks the order prompt atomically without resetting a later state', async function() {
    const calls = [];
    const model = {
      findOneAndUpdate: async function(query, update, options) {
        calls.push({ query, update, options });
        return { request_id: 'request-1' };
      }
    };

    const result = await automation.markOrderPrompt({
      model,
      requestId: 'request-1',
      projectId: 'project-1',
      messageId: 'message-1'
    });

    assert.strictEqual(result.status, 'updated');
    assert.strictEqual(calls[0].update.$set['attributes.casezapOrder.state'], 'collecting_order');
    assert.deepStrictEqual(calls[0].update.$addToSet, {
      'attributes.casezapOrder.messageIds': 'message-1'
    });
    assert.deepStrictEqual(calls[0].options, { new: true, upsert: false });
    assert(calls[0].query.$or);
  });

  it('detects and claims the human handoff once per request', async function() {
    const calls = [];
    const model = {
      findOneAndUpdate: async function(query, update, options) {
        calls.push({ query, update, options });
        return { request_id: 'request-1' };
      }
    };

    assert.strictEqual(automation.isVictorHumanRequestPrompt({
      attributes: {
        commands: [{ message: { text: 'Certo, amigo. Vou chamar o vendedor.' } }]
      }
    }), true);
    assert(await automation.claimHumanHandoff({ model, requestId: 'request-1', projectId: 'project-1' }));
    assert.strictEqual(calls[0].query['attributes.casezapHumanNotified'].$ne, true);
    assert.strictEqual(calls[0].update.$set['attributes.casezapHumanNotified'], true);
  });

  it('persists the new-customer referral answer for later notifications', async function() {
    const calls = [];
    const model = {
      findOneAndUpdate: async function(query, update) {
        calls.push({ query, update });
        return { request_id: 'request-1' };
      }
    };

    assert.strictEqual(automation.isVictorOriginPrompt({
      text: 'Vem de indicação de alguém?'
    }), true);
    assert.strictEqual(automation.isVictorOriginPrompt({
      text: 'Como você me encontrou?'
    }), true);
    await automation.claimOriginPrompt({ model, requestId: 'request-1', projectId: 'project-1' });
    await automation.saveCustomerOrigin({
      model,
      requestId: 'request-1',
      projectId: 'project-1',
      text: 'Indicação de um amigo'
    });

    assert.strictEqual(calls[0].update.$set['attributes.casezapOriginAwaiting'], true);
    assert.strictEqual(calls[1].update.$set['attributes.casezapOrigin'], 'Indicação de um amigo');
    assert(automation.buildOrderNotification({
      phone: '5511999999999',
      origin: 'Indicação de um amigo',
      text: '2 unidades'
    }).includes('Indicação de um amigo'));
  });

  it('moves a client order to awaiting_quote and notifies both Victor numbers', async function() {
    const sent = [];
    const model = {
      findOneAndUpdate: async function() {
        return { request_id: 'request-1' };
      }
    };

    const result = await automation.handleInboundMessage({
      model,
      request: {
        request_id: 'request-1',
        id_project: 'project-1',
        attributes: { casezapOrder: { state: 'collecting_order' } }
      },
      rawMessage: { message: { fromMe: false, wasSentByApi: false } },
      mapped: { messageId: 'message-2', phone: '5511999999999', type: 'text', text: '2 unidades' },
      messageId: 'message-2',
      sendInternalMessage: async function(number, text) {
        sent.push({ number, text });
        return true;
      }
    });

    assert.strictEqual(result.status, 'awaiting_quote');
    assert.deepStrictEqual(sent.map(function(item) { return item.number; }), ['556292174737', '556198820985']);
    assert(sent[0].text.includes('Novo pedido aguardando cotação'));
  });

  it('requires the PIX key and rejects API-generated fromMe messages', async function() {
    let updates = 0;
    const model = {
      findOneAndUpdate: async function() {
        updates += 1;
        return { request_id: 'request-1' };
      }
    };
    const request = {
      request_id: 'request-1',
      id_project: 'project-1',
      attributes: { casezapOrder: { state: 'awaiting_quote' } }
    };

    const missingKey = await automation.handleInboundMessage({
      model,
      request,
      rawMessage: { message: { fromMe: true, wasSentByApi: false } },
      mapped: { text: 'PIX R$ 10,00' },
      messageId: 'quote-1'
    });
    const apiMessage = await automation.handleInboundMessage({
      model,
      request,
      pixKey: 'redacted@example.invalid',
      rawMessage: { message: { fromMe: true, wasSentByApi: true } },
      mapped: { text: 'PIX R$ 10,00' },
      messageId: 'quote-2'
    });

    assert.strictEqual(missingKey.reason, 'pix_key_missing');
    assert.strictEqual(apiMessage.status, 'skipped');
    assert.strictEqual(updates, 0);
  });

  it('requires the configured PIX key before resuming with Shopee and payment', async function() {
    const automationMessages = [];
    const internalMessages = [];
    const model = {
      findOneAndUpdate: async function() {
        return { request_id: 'request-1' };
      }
    };

    const result = await automation.handleInboundMessage({
      model,
      request: {
        request_id: 'request-1',
        id_project: 'project-1',
        attributes: { casezapOrder: { state: 'awaiting_quote' } }
      },
      pixKey: 'redacted@example.invalid',
      rawMessage: { message: { fromMe: true, wasSentByApi: false } },
      mapped: { phone: '5511999999999', text: 'PIX redacted@example.invalid R$ 99,90' },
      messageId: 'quote-1',
      sendAutomationMessage: async function(message) {
        automationMessages.push(message);
      },
      sendInternalMessage: async function(number, text) {
        internalMessages.push({ number, text });
        return true;
      }
    });

    assert.strictEqual(result.status, 'quoted');
    assert.strictEqual(result.amountCents, 9990);
    assert(automationMessages[0].text.includes(automation.DEFAULT_SHOPEE_URL));
    assert(automationMessages[0].text.includes('redacted@example.invalid'));
    assert.strictEqual(automationMessages[0].stickerUrl, automation.configuredVictorOrderStickerUrl());
    assert.deepStrictEqual(internalMessages.map(function(item) { return item.number; }), [
      '556292174737',
      '556198820985'
    ]);
  });

  it('keeps receipt_review/manual, calls OCR once, and notifies both numbers', async function() {
    const calls = [];
    const sent = [];
    const model = {
      findOneAndUpdate: async function(query, update) {
        calls.push({ query, update });
        return { request_id: 'request-1' };
      }
    };

    const result = await automation.handleInboundMessage({
      model,
      request: {
        request_id: 'request-1',
        id_project: 'project-1',
        attributes: { casezapOrder: { state: 'awaiting_receipt', quotedAmountCents: 12345 } }
      },
      rawMessage: { message: { fromMe: false, wasSentByApi: false } },
      mapped: { type: 'image', text: '', phone: '5511999999999' },
      messageId: 'receipt-1',
      trackId: 'track-1',
      loadMedia: async function() {
        return { buffer: Buffer.from('image'), mimetype: 'image/png' };
      },
      runReceiptOcr: async function(input) {
        assert(Buffer.isBuffer(input.buffer));
        assert.strictEqual(input.mimetype, 'image/png');
        assert.strictEqual(input.expectedAmountCents, 12345);
        return { status: 'review', amountsCents: [12345], text: 'comprovante', reason: 'confidence' };
      },
      sendInternalMessage: async function(number, text) {
        sent.push({ number, text });
        return true;
      }
    });

    assert.strictEqual(result.status, 'receipt_review');
    assert.strictEqual(result.result.status, 'review');
    assert.strictEqual(calls[0].update.$set['attributes.casezapOrder.state'], 'receipt_review');
    assert.strictEqual(calls[0].update.$set['attributes.casezapOrder.receiptReview'], 'manual');
    assert.strictEqual(calls[1].update.$set['attributes.casezapOrder.ocrAmountsCents'][0], 12345);
    assert.deepStrictEqual(sent.map(function(item) { return item.number; }), ['556292174737', '556198820985']);
  });
});
