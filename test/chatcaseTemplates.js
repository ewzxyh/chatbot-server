const assert = require('assert');
const chatcaseTemplates = require('../pubmodules/chatbotTemplates/chatcaseTemplates');

function getIntentButtons(intent) {
  const commands = intent.actions
    .flatMap((action) => action.attributes && action.attributes.commands || []);
  const messageCommand = commands.find((command) => command.type === 'message' && command.message);
  return messageCommand &&
    messageCommand.message.attributes &&
    messageCommand.message.attributes.attachment &&
    messageCommand.message.attributes.attachment.buttons || [];
}

function getActionButtons(action) {
  return getIntentButtons({ actions: [action] });
}

function getIntentMessages(intent) {
  return intent.actions
    .flatMap((action) => action.attributes && action.attributes.commands || [])
    .filter((command) => command.type === 'message' && command.message)
    .map((command) => command.message);
}

function assertCasezapAssetBaseUrl(detail, baseUrl) {
  const messages = detail.intents.flatMap(getIntentMessages);
  const stickers = messages.filter((message) => message.type === 'sticker');
  const pdfs = messages.filter((message) => message.type === 'file' && message.metadata && message.metadata.type === 'application/pdf');
  const expectedBaseUrl = baseUrl.replace(/\/+$/, '');

  assert.strictEqual(stickers.length, 2);
  assert.deepStrictEqual(
    stickers.map((message) => [
      message.type,
      message.metadata.type,
      message.metadata.mimetype,
      message.metadata.src,
      message.metadata.downloadURL
    ]).sort(),
    [
      [
        'sticker',
        'sticker',
        'image/webp',
        `${expectedBaseUrl}/community/assets/casezap/sticker-animated.webp`,
        `${expectedBaseUrl}/community/assets/casezap/sticker-animated.webp`
      ],
      [
        'sticker',
        'sticker',
        'image/webp',
        `${expectedBaseUrl}/community/assets/casezap/sticker-static.webp`,
        `${expectedBaseUrl}/community/assets/casezap/sticker-static.webp`
      ]
    ].sort()
  );
  assert.strictEqual(pdfs.length, 2);
  assert.deepStrictEqual(
    pdfs.map((message) => [message.metadata.src, message.metadata.downloadURL]).sort(),
    [
      [
        `${expectedBaseUrl}/community/assets/casezap/catalogo-chatcase.pdf`,
        `${expectedBaseUrl}/community/assets/casezap/catalogo-chatcase.pdf`
      ],
      [
        `${expectedBaseUrl}/community/assets/casezap/horse-power-2-0.pdf`,
        `${expectedBaseUrl}/community/assets/casezap/horse-power-2-0.pdf`
      ]
    ].sort()
  );
}

function getFlowSnapshot(template) {
  return template.intents.map((intent) => ({
    intentId: intent.intent_id,
    position: intent.attributes.position,
    actions: intent.actions.map((action) => ({
      actionId: action._tdActionId,
      actionType: action._tdActionType,
      intentName: action.intentName,
      trueIntent: action.trueIntent,
      falseIntent: action.falseIntent,
      buttons: getActionButtons(action).map((button) => ({
        type: button.type,
        uid: button.uid,
        action: button.action
      }))
    }))
  }));
}

function getReachableIntentIds(template, textIntentNames = []) {
  const startIntent = template.intents.find((intent) => intent.question === '\\start');
  const intentIds = new Set(template.intents.map((intent) => intent.intent_id));
  const textIntents = template.intents.filter((intent) => textIntentNames.includes(intent.intent_display_name));
  const initialIntents = [startIntent, ...textIntents].filter(Boolean);
  const reachable = new Set(initialIntents.map((intent) => intent.intent_id));
  const queue = initialIntents.slice();

  while (queue.length) {
    const currentIntent = queue.shift();
    currentIntent.actions.forEach((action) => {
      const targets = getActionButtons(action).map((button) => button.action);
      if (action._tdActionType === 'intent') targets.push(action.intentName);
      targets.push(action.trueIntent, action.falseIntent);
      targets.forEach((target) => {
        const targetId = String(target || '').replace(/^#/, '');
        if (!intentIds.has(targetId) || reachable.has(targetId)) {
          return;
        }
        reachable.add(targetId);
        queue.push(template.intents.find((intent) => intent.intent_id === targetId));
      });
    });
  }

  return reachable;
}

describe('ChatCase chatbot templates', () => {
  it('lists all certified local templates with import metadata', () => {
    const templates = chatcaseTemplates.listMetadata();

    assert(templates.length >= 6, 'should expose multiple ChatCase templates');

    templates.forEach((template) => {
      assert(template._id, 'template should have an id');
      assert.strictEqual(template.certified, true);
      assert.strictEqual(template.public, true);
      assert.strictEqual(template.type, 'tilebot');
      assert.strictEqual(template.subtype, 'chatbot');
      assert.strictEqual(template.language, 'pt');
      assert(template.intentsCount >= 5, 'template should report importable intents');
      assert(Array.isArray(template.attributes.channels), 'template should expose supported channels');
      assert(template.attributes.channels.includes('whatsapp'), 'template should support WhatsApp');
      assert(template.attributes.channels.includes('casezap'), 'template should support CaseZap');
      assert(!template.attributes.channels.includes('telegram'), 'template should not advertise Telegram when not supported');
      assert(Array.isArray(template.attributes.availableChannels), 'template should expose available channel modes');

      if (template.attributes.exclusiveChannel === true) {
        assert.strictEqual(chatcaseTemplates.getDefaultChannel(template), 'casezap');
        assert.strictEqual(template.attributes.targetChannel, 'casezap');
        assert.strictEqual(template.attributes.selectedChannel, 'casezap');
        assert.strictEqual(template.attributes.channelCompatibility.waba, undefined);
        assert.strictEqual(template.attributes.publication.wabaTemplates, undefined);
        assert(!template.attributes.availableChannels.includes('waba'));
        assert.strictEqual(template.attributes.nativeInteractions.casezap, 'menu');
        assert(!template.intents, 'metadata list should not include full intents payload');
        return;
      }

      assert(template.attributes.availableChannels.includes('waba'), 'template should expose WABA as a separate publication mode');
      assert.strictEqual(template.attributes.channelCompatibility.casezap.status, 'supported');
      assert.strictEqual(template.attributes.channelCompatibility.waba.status, 'requires_approval');
      assert.strictEqual(chatcaseTemplates.getDefaultChannel(template), 'all');
      assert.strictEqual(template.attributes.targetChannel, undefined);
      assert.strictEqual(template.attributes.selectedChannel, undefined);
      assert.strictEqual(template.attributes.nativeInteractions.whatsapp, 'buttons');
      assert.strictEqual(template.attributes.nativeInteractions.casezap, 'menu');
      assert(template.attributes.publication, 'template should expose publication readiness metadata');
      assert(Array.isArray(template.attributes.publication.readiness), 'template should expose channel readiness list');
      assert(Array.isArray(template.attributes.publication.wabaTemplates), 'template should expose WABA template suggestions');
      assert(template.attributes.publication.wabaTemplates.length >= 3, 'template should expose a local WABA template library');
      assert.strictEqual(
        new Set(template.attributes.publication.wabaTemplates.map((item) => item.name)).size,
        template.attributes.publication.wabaTemplates.length,
        'WABA template suggestion names should be unique per local template'
      );
      template.attributes.publication.wabaTemplates.forEach((suggestion) => {
        assert.strictEqual(suggestion.language, 'pt_BR', 'WABA suggestions should use Brazilian Portuguese');
        assert(['UTILITY', 'MARKETING'].includes(suggestion.category), 'WABA suggestions should use supported Meta categories');
        assert(suggestion.body, 'WABA suggestions should include a body');
        assert(suggestion.purpose, 'WABA suggestions should explain their purpose');
        assert(suggestion.whenToUse, 'WABA suggestions should explain when to use them');
      });
      assert(!template.intents, 'metadata list should not include full intents payload');
    });
  });

  it('returns detail and export payloads for every local template', () => {
    const templates = chatcaseTemplates.listMetadata();

    templates.forEach((template) => {
      const detail = chatcaseTemplates.getTemplatePayloadById(template._id);
      assert(detail, `detail should exist for ${template._id}`);
      assert.strictEqual(detail.name, template.name);
      assert.strictEqual(detail.type, 'tilebot');
      assert.strictEqual(detail.subtype, 'chatbot');
      assert(Array.isArray(detail.intents), 'detail should include intents');
      assert.strictEqual(detail.intents.length, template.intentsCount);
      assert(detail.intents.some((intent) => intent.intent_display_name === 'start'), 'detail should include start intent');
      assert(detail.intents.some((intent) => intent.intent_display_name === 'defaultFallback'), 'detail should include fallback intent');
      assert(detail.intents.some((intent) => getIntentButtons(intent).length > 0), 'detail should include native button metadata');

      const handoffIntent = detail.intents.find((intent) => intent.intent_display_name === 'human_handoff');
      if (template.attributes.exclusiveChannel === true) {
        const handoffCheck = detail.intents.find((intent) => intent.intent_display_name === 'handoff_check');
        const handoffOnline = detail.intents.find((intent) => intent.intent_display_name === 'handoff_online');
        const handoffOffline = detail.intents.find((intent) => intent.intent_display_name === 'handoff_offline');
        assert(handoffCheck, `detail should include handoff check intent for ${template._id}`);
        assert(handoffOnline, `detail should include online handoff intent for ${template._id}`);
        assert(handoffOffline, `detail should include offline handoff intent for ${template._id}`);
        assert.strictEqual(handoffCheck.actions[0]._tdActionType, 'ifonlineagentsv2');
        assert(handoffOnline.actions.some((action) => action._tdActionType === 'agent'));
        assert(handoffOffline.actions.some((action) => action._tdActionType === 'reply'));
      } else {
        assert(handoffIntent, `detail should include human handoff intent for ${template._id}`);
        assert(
          !handoffIntent.answer.includes('\\agent'),
          `${template._id}: human handoff answer should not leak routing commands to the user`
        );
        assert(
          handoffIntent.actions.some((action) => action._tdActionType === 'agent'),
          `${template._id}: human handoff action should trigger Tiledesk agent routing`
        );
      }

      detail.intents
        .filter((intent) => /^[0-9]+$/.test(intent.question || ''))
        .forEach((intent) => {
          assert(
            Array.isArray(intent.attributes.aliases) && intent.attributes.aliases.length > 0,
            `${template._id}:${intent.intent_display_name} should expose button aliases`
          );
        });

      const exported = chatcaseTemplates.getTemplateExportById(template._id);
      assert(exported, `export should exist for ${template._id}`);
      assert.strictEqual(exported._id, template._id);
      assert.strictEqual(exported.source, 'chatcase-template-export');
      assert(Date.parse(exported.exportedAt), 'export should include exportedAt timestamp');
      assert.strictEqual(exported.intents.length, template.intentsCount);
      assert.strictEqual(exported.attributes.nativeInteractions.casezap, 'menu');
      assert(exported.attributes.publication, 'export should include publication readiness metadata');
      assert(Array.isArray(exported.attributes.publication.checklist), 'export should include publication checklist');

      if (template.attributes.exclusiveChannel === true) {
        assert.strictEqual(exported.attributes.publication.wabaTemplates, undefined);
      } else {
        assert.strictEqual(exported.attributes.nativeInteractions.whatsapp, 'buttons');
      }
    });
  });

  it('preserves the CaseZap commercial continuity flow by slug', () => {
    const templateId = chatcaseTemplates.CHATCASE_TEMPLATE_IDS.CASEZAP_COMMERCIAL_CONTINUITY;
    const metadata = chatcaseTemplates.listMetadata().find((template) => template._id === templateId);
    const originalExternalBaseUrl = process.env.EXTERNAL_BASE_URL;
    let devDetail;
    let fallbackDetail;
    try {
      process.env.EXTERNAL_BASE_URL = 'https://chatcase-dev.69-6-250-104.sslip.io/';
      devDetail = chatcaseTemplates.getTemplatePayloadById(templateId);
      delete process.env.EXTERNAL_BASE_URL;
      fallbackDetail = chatcaseTemplates.getTemplatePayloadById(templateId);
    } finally {
      if (originalExternalBaseUrl === undefined) {
        delete process.env.EXTERNAL_BASE_URL;
      } else {
        process.env.EXTERNAL_BASE_URL = originalExternalBaseUrl;
      }
    }
    const detail = devDetail;

    assert(metadata, 'CaseZap template should be listed');
    assert(detail, 'CaseZap template detail should resolve by slug');
    assert.strictEqual(metadata.intentsCount, 18);
    assert.strictEqual(detail.intents.length, 18);
    assert.strictEqual(metadata.attributes.exclusiveChannel, true);
    assert.strictEqual(metadata.attributes.targetChannel, 'casezap');
    assert.strictEqual(metadata.attributes.selectedChannel, 'casezap');
    assert.strictEqual(metadata.attributes.publication.wabaTemplates, undefined);

    const newCustomer = detail.intents.find((intent) => intent.intent_display_name === 'new_customer_menu');
    const returningCustomer = detail.intents.find((intent) => intent.intent_display_name === 'returning_customer_menu');
    const returningPurchase = detail.intents.find((intent) => intent.intent_display_name === 'returning_purchase');
    const handoffCheck = detail.intents.find((intent) => intent.intent_display_name === 'handoff_check');
    const handoffOnline = detail.intents.find((intent) => intent.intent_display_name === 'handoff_online');
    const handoffOffline = detail.intents.find((intent) => intent.intent_display_name === 'handoff_offline');
    const catalogRequest = detail.intents.find((intent) => intent.intent_display_name === 'catalog_request');
    const freightQuestion = detail.intents.find((intent) => intent.intent_display_name === 'freight_question');
    const orderRequest = detail.intents.find((intent) => intent.intent_display_name === 'order_request');
    const humanRequest = detail.intents.find((intent) => intent.intent_display_name === 'human_request');
    const directIntentAliases = {
      freight_question: 'frete',
      product_question: 'produto',
      delivery_support: 'entrega',
      after_sales: 'Pós-venda',
      payment_receipt: 'comprovante'
    };
    const directIntentNames = Object.keys(directIntentAliases);
    const directIntents = directIntentNames.map((name) => detail.intents.find((intent) => intent.intent_display_name === name));
    const catalogResponse = 'Segue a nova tabela 👇';
    const returningPurchaseResponse = 'Bom te ver de novo! Mande os produtos e as quantidades. A equipe confirma preço, estoque, frete, pagamento e prazo.';
    const messages = detail.intents.flatMap(getIntentMessages);
    const stickers = messages.filter((message) => message.type === 'sticker');
    const pdfs = messages.filter((message) => message.type === 'file' && message.metadata && message.metadata.type === 'application/pdf');

    assert(!JSON.stringify(detail).includes('Victor'));
    assert.strictEqual(newCustomer.question, '1');
    assert(newCustomer.answer.includes('Vem de indicação de alguém?'));
    assert(!newCustomer.answer.includes('Victor'));
    assert(newCustomer.answer.includes('1 - VER TABELA ATUALIZADA'));
    assert.deepStrictEqual(
      getIntentButtons(newCustomer).map((button) => [button.value, button.label]),
      [
        ['Tabela atualizada', 'VER TABELA ATUALIZADA'],
        ['Fazer pedido', 'FAZER PEDIDO'],
        ['Falar com vendedor', 'FALAR COM VENDEDOR']
      ]
    );
    assert.strictEqual(returningCustomer.question, '2');
    assert(!returningCustomer.answer.includes('Victor'));
    assert.strictEqual(catalogRequest.question, '3');
    assert(freightQuestion.attributes.aliases.includes('quanto é o frete'));
    assert(freightQuestion.answer.includes('R$ 35,00'));
    assert(freightQuestion.answer.includes('https://shopee.com.br/universal-link/product/1502208056/58262112206'));
    assert(returningCustomer.answer.includes('1 - VER TABELA ATUALIZADA'));
    assert(returningCustomer.answer.includes('2 - FAZER PEDIDO / RECOMPRA'));
    assert(!returningCustomer.answer.includes('Entrega ou rastreio'));
    assert.deepStrictEqual(
      getIntentButtons(returningCustomer).map((button) => [button.value, button.label]),
      [
        ['Tabela atualizada', 'VER TABELA ATUALIZADA'],
        ['Comprar novamente', 'FAZER PEDIDO / RECOMPRA'],
        ['Falar com vendedor', 'FALAR COM VENDEDOR']
      ]
    );
    assert.strictEqual(
      detail.intents.find((intent) => intent.intent_display_name === 'support_menu'),
      undefined,
      'CaseZap template should not expose support_menu'
    );
    directIntents.forEach((intent, index) => {
      assert(intent, `${directIntentNames[index]} should remain available by text`);
      assert(
        intent.attributes.aliases.includes(directIntentAliases[directIntentNames[index]]),
        `${directIntentNames[index]} should keep its direct text alias`
      );
    });
    assert.strictEqual(returningPurchase.answer, returningPurchaseResponse);
    assert(!returningPurchase.answer.includes('tabela'));
    assert(!returningPurchase.attributes.aliases.includes('Pedido / catálogo'));
    assert.strictEqual(catalogRequest.answer, catalogResponse);
    assert.strictEqual(catalogRequest.actions.find((action) => action._tdActionType === 'reply').text, catalogResponse);
    assert.strictEqual(
      getIntentMessages(catalogRequest).find((message) => message.type === 'text').text,
      catalogResponse
    );
    assert(messages.some((message) => message.text === 'Pedido mínimo de R$200,00'));
    assert(!orderRequest.answer.includes('cidade ou CEP'));
    assert(getIntentMessages(humanRequest).some((message) => message.attributes && message.attributes.casezapHumanRequest === true));
    assert.strictEqual(stickers.length, 2);
    stickers.forEach((sticker) => {
      assert.strictEqual(sticker.type, 'sticker');
      assert.strictEqual(sticker.metadata.type, 'sticker');
      assert.strictEqual(sticker.metadata.mimetype, 'image/webp');
    });
    assert.strictEqual(pdfs.length, 2);
    assert.strictEqual(
      messages.filter((message) => (message.text || '').includes('https://shopee.com.br/universal-link/product/1502208056/58262112206')).length,
      1
    );
    assertCasezapAssetBaseUrl(devDetail, 'https://chatcase-dev.69-6-250-104.sslip.io');
    assertCasezapAssetBaseUrl(fallbackDetail, 'https://chatcase.com.br');
    assert.strictEqual(handoffCheck.actions[0]._tdActionType, 'ifonlineagentsv2');
    assert.strictEqual(handoffCheck.actions[0].trueIntent, `#${handoffOnline.intent_id}`);
    assert.strictEqual(handoffCheck.actions[0].falseIntent, `#${handoffOffline.intent_id}`);
    assert(handoffOnline.actions.some((action) => action._tdActionType === 'agent'));
    assert(handoffOffline.actions.some((action) => action._tdActionType === 'reply'));

    const reachable = getReachableIntentIds(detail, directIntentNames);
    directIntents.forEach((intent) => assert(reachable.has(intent.intent_id)));
    assert(!reachable.has('cc-commercial-support-menu'));
    assert(reachable.has(handoffCheck.intent_id));
    assert(reachable.has(handoffOnline.intent_id));
    assert(reachable.has(handoffOffline.intent_id));

    const serialized = JSON.parse(JSON.stringify(detail));
    assert.deepStrictEqual(getFlowSnapshot(serialized), getFlowSnapshot(detail));
    assert.strictEqual(
      serialized.intents.find((intent) => intent.intent_display_name === 'handoff_check').actions[0].trueIntent,
      `#${handoffOnline.intent_id}`
    );
  });

  it('persists valid block connections when every template is imported', () => {
    chatcaseTemplates.listMetadata().forEach((template) => {
      const imported = chatcaseTemplates.getTemplatePayloadById(template._id);
      const serialized = JSON.parse(JSON.stringify(imported));
      const intentIds = new Set(imported.intents.map((intent) => intent.intent_id));
      const actionIds = [];
      const buttonIds = [];

      imported.intents.forEach((intent) => {
        intent.actions.forEach((action) => {
          assert(action._tdActionId, `${template._id}: every action should have a stable id`);
          actionIds.push(action._tdActionId);

          getActionButtons(action).forEach((button) => {
            assert.strictEqual(
              button.type,
              'action',
              `${template._id}: connected buttons should be action buttons`
            );
            assert(button.uid, `${template._id}: every button should have a stable id`);
            assert(/^#.+/.test(button.action || ''), `${template._id}: every button should persist its target`);
            assert(
              intentIds.has(button.action.slice(1)),
              `${template._id}: button target ${button.action} should reference an imported block`
            );
            buttonIds.push(button.uid);
          });
        });
      });

      assert.strictEqual(new Set(actionIds).size, actionIds.length, `${template._id}: action ids should be unique`);
      assert.strictEqual(new Set(buttonIds).size, buttonIds.length, `${template._id}: button ids should be unique`);
      assert.deepStrictEqual(
        getFlowSnapshot(serialized),
        getFlowSnapshot(imported),
        `${template._id}: serialization should preserve block connections`
      );

      const exported = chatcaseTemplates.getTemplateExportById(template._id);
      assert.deepStrictEqual(
        getFlowSnapshot(exported),
        getFlowSnapshot(imported),
        `${template._id}: exported import payload should preserve block connections`
      );
    });
  });

  it('uses the editor contract for start reload, removal and reconnection', () => {
    chatcaseTemplates.listMetadata().forEach((template) => {
      const imported = chatcaseTemplates.getTemplatePayloadById(template._id);
      let start = imported.intents.find((intent) => intent.question === '\\start');
      assert.strictEqual(start.actions.length, 1, `${template._id}: start should expose one connection`);
      assert.strictEqual(start.actions[0]._tdActionType, 'intent');
      assert(/^#.+/.test(start.actions[0].intentName));

      let persisted = JSON.parse(JSON.stringify(imported));
      start = persisted.intents.find((intent) => intent.question === '\\start');
      assert(start.actions[0].intentName, `${template._id}: start connection should survive reload`);

      start.actions[0].intentName = null;
      persisted = JSON.parse(JSON.stringify(persisted));
      start = persisted.intents.find((intent) => intent.question === '\\start');
      assert.strictEqual(start.actions[0].intentName, null, `${template._id}: removal should survive reload`);

      const replacementName = template.attributes.exclusiveChannel === true ? 'handoff_online' : 'human_handoff';
      const replacement = persisted.intents.find((intent) => intent.intent_display_name === replacementName);
      assert(replacement, `${template._id}: replacement handoff intent should exist`);
      start.actions[0].intentName = `#${replacement.intent_id}`;
      persisted = JSON.parse(JSON.stringify(persisted));
      start = persisted.intents.find((intent) => intent.question === '\\start');
      assert.strictEqual(start.actions[0].intentName, `#${replacement.intent_id}`);
    });
  });

  it('assigns deterministic initial positions without overlapping blocks', () => {
    chatcaseTemplates.listMetadata().forEach((template) => {
      const firstImport = chatcaseTemplates.getTemplatePayloadById(template._id);
      const secondImport = chatcaseTemplates.getTemplatePayloadById(template._id);
      const firstPositions = firstImport.intents.map((intent) => ({
        intentId: intent.intent_id,
        position: intent.attributes.position
      }));
      const positionKeys = firstPositions.map(({ position }) => `${position.x}:${position.y}`);

      firstPositions.forEach(({ position }) => {
        assert(Number.isFinite(position.x), `${template._id}: initial x position should be numeric`);
        assert(Number.isFinite(position.y), `${template._id}: initial y position should be numeric`);
      });
      assert.strictEqual(
        new Set(positionKeys).size,
        positionKeys.length,
        `${template._id}: initial blocks should not overlap`
      );
      assert.deepStrictEqual(
        firstPositions,
        secondImport.intents.map((intent) => ({
          intentId: intent.intent_id,
          position: intent.attributes.position
        })),
        `${template._id}: repeated imports should use the same initial positions`
      );
    });
  });

  it('keeps imported template blocks reachable except for the fallback block', () => {
    chatcaseTemplates.listMetadata().forEach((template) => {
      const imported = chatcaseTemplates.getTemplatePayloadById(template._id);
      const textIntentNames = template._id === chatcaseTemplates.CHATCASE_TEMPLATE_IDS.CASEZAP_COMMERCIAL_CONTINUITY
        ? ['freight_question', 'product_question', 'delivery_support', 'after_sales', 'payment_receipt']
        : [];
      const reachable = getReachableIntentIds(imported, textIntentNames);
      const disconnected = imported.intents.filter((intent) => !reachable.has(intent.intent_id));

      assert.deepStrictEqual(
        disconnected.map((intent) => intent.intent_display_name),
        template.attributes.exclusiveChannel === true
          ? ['defaultFallback', 'media_received']
          : ['defaultFallback'],
        `${template._id}: only the fallback block should remain intentionally disconnected`
      );
    });
  });

  it('filters template metadata and payloads by channel compatibility without scoping generic flows', () => {
    const casezapTemplates = chatcaseTemplates.listMetadata({ channel: 'casezap' });
    assert(casezapTemplates.length >= 6, 'casezap should list local templates');

    casezapTemplates.forEach((template) => {
      if (template.attributes.exclusiveChannel === true) {
        assert.strictEqual(chatcaseTemplates.getDefaultChannel(template), 'casezap');
        assert.strictEqual(template.attributes.targetChannel, 'casezap');
        assert.strictEqual(template.attributes.selectedChannel, 'casezap');
        assert.deepStrictEqual(template.attributes.channels, ['casezap']);
        assert.deepStrictEqual(template.attributes.availableChannels, ['casezap']);
        assert(template.attributes.channelCompatibility.casezap, 'exclusive CaseZap compatibility should remain visible');
        assert.strictEqual(template.attributes.channelCompatibility.waba, undefined);
        assert.strictEqual(template.attributes.nativeInteractions.casezap, 'menu');
        assert.strictEqual(template.attributes.publication.wabaTemplates, undefined);
        assert(template.attributes.publication.readiness.every((item) => item.channel === 'casezap'));
        return;
      }

      assert.strictEqual(chatcaseTemplates.getDefaultChannel(template), 'all');
      assert.strictEqual(template.attributes.targetChannel, undefined);
      assert.strictEqual(template.attributes.selectedChannel, undefined);
      assert.strictEqual(template.attributes.channelScopeMode, undefined);
      assert(template.attributes.channels.includes('casezap'), 'casezap filtered template should keep CaseZap compatibility');
      assert(template.attributes.channels.includes('whatsapp'), 'casezap filtered template should keep WhatsApp compatibility');
      assert(template.attributes.availableChannels.includes('waba'), 'casezap filtered template should keep WABA publication compatibility');
      assert(template.attributes.channelCompatibility.casezap, 'casezap compatibility should remain visible');
      assert(template.attributes.channelCompatibility.waba, 'waba compatibility should remain visible');
      assert.strictEqual(template.attributes.nativeInteractions.casezap, 'menu');
      assert.strictEqual(template.attributes.nativeInteractions.whatsapp, 'buttons');
      assert(template.tags.includes('whatsapp'), 'generic template should keep WhatsApp tags after compatibility filtering');
      assert(template.attributes.publication, 'generic template should keep publication metadata');
      assert(Array.isArray(template.attributes.publication.wabaTemplates), 'generic template should keep WABA template suggestions');
      assert(template.attributes.publication.readiness.some((item) => item.channel === 'casezap'), 'generic readiness should keep CaseZap items');
    });

    const wabaPayload = chatcaseTemplates.getTemplatePayloadById(casezapTemplates[0]._id, { channel: 'waba' });
    assert.strictEqual(chatcaseTemplates.getDefaultChannel(wabaPayload), 'all');
    assert.strictEqual(wabaPayload.attributes.targetChannel, undefined);
    assert.strictEqual(wabaPayload.attributes.channelScopeMode, undefined);
    assert(wabaPayload.attributes.availableChannels.includes('waba'), 'waba payload should keep WABA compatibility');
    assert(wabaPayload.attributes.channelCompatibility.waba, 'waba payload should keep WABA metadata');
    assert(Array.isArray(wabaPayload.attributes.publication.wabaTemplates), 'waba payload should expose WABA suggestions');
    assert(wabaPayload.attributes.publication.readiness.some((item) => item.channel === 'waba'), 'waba readiness should remain visible');

    const whatsappPayload = chatcaseTemplates.getTemplatePayloadById(casezapTemplates[0]._id, { channel: 'whatsapp' });
    assert.strictEqual(chatcaseTemplates.getDefaultChannel(whatsappPayload), 'all');
    assert(whatsappPayload.attributes.channels.includes('whatsapp'), 'whatsapp payload should keep WhatsApp compatibility');

    const telegramTemplates = chatcaseTemplates.listMetadata({ channel: 'telegram' });
    assert.strictEqual(telegramTemplates.length, 0, 'telegram should not list templates without compatibility');
    assert.strictEqual(chatcaseTemplates.getTemplatePayloadById(casezapTemplates[0]._id, { channel: 'telegram' }), null, 'telegram detail should be unavailable without compatibility');
  });

  it('normalizes legacy channel metadata without scoping generic imports', () => {
    const mixedTemplate = chatcaseTemplates.getTemplatePayloadById(chatcaseTemplates.CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC);
    mixedTemplate.attributes.channels = ['CaseZap', 'WhatsApp'];
    mixedTemplate.attributes.targetChannel = 'casezap';
    mixedTemplate.attributes.selectedChannel = 'casezap';
    mixedTemplate.intents[0].actions.push({ _tdActionType: 'whatsapp_static', attributes: { templateName: 'legacy_waba' } });

    assert.strictEqual(chatcaseTemplates.getDefaultChannel(mixedTemplate), 'all', 'legacy targetChannel alone should not scope a multichannel template');
    assert.strictEqual(chatcaseTemplates.templateSupportsChannel({ attributes: { channels: ['CaseZap'] } }, 'casezap'), true);
    assert.strictEqual(chatcaseTemplates.templateSupportsChannel({ attributes: { channels: ['Telegram'] } }, 'telegram'), true);

    const preparedAll = chatcaseTemplates.prepareTemplateForChannel(mixedTemplate, 'all');
    assert.strictEqual(preparedAll.attributes.targetChannel, undefined, 'multichannel import should not keep stale targetChannel');
    assert.strictEqual(preparedAll.attributes.selectedChannel, undefined, 'multichannel import should not keep stale selectedChannel');
    assert.strictEqual(preparedAll.attributes.channelScopeMode, undefined, 'multichannel import should not keep stale channelScopeMode');
    assert.strictEqual(chatcaseTemplates.getDefaultChannel(preparedAll), 'all');

    const preparedCasezap = chatcaseTemplates.prepareTemplateForChannel(mixedTemplate, 'casezap');
    assert.strictEqual(preparedCasezap.attributes.targetChannel, undefined, 'casezap compatibility filter should not persist targetChannel');
    assert.strictEqual(preparedCasezap.attributes.selectedChannel, undefined, 'casezap compatibility filter should not persist selectedChannel');
    assert.strictEqual(preparedCasezap.attributes.channelScopeMode, undefined, 'casezap compatibility filter should not persist channelScopeMode');
    assert(preparedCasezap.attributes.channels.includes('casezap'), 'casezap compatibility should remain visible');
    assert(preparedCasezap.attributes.channels.includes('whatsapp'), 'whatsapp compatibility should remain visible');
    assert(preparedCasezap.intents[0].actions.some((action) => action._tdActionType === 'whatsapp_static'), 'generic import should keep channel-specific actions for explicit user review');

    const preparedWaba = chatcaseTemplates.prepareTemplateForChannel(mixedTemplate, 'waba');
    assert(preparedWaba.intents[0].actions.some((action) => action._tdActionType === 'whatsapp_static'), 'waba scoped import may keep WABA-only actions');
  });

  it('keeps explicit channel-exclusive templates scoped', () => {
    const exclusiveTemplate = chatcaseTemplates.getTemplatePayloadById(chatcaseTemplates.CHATCASE_TEMPLATE_IDS.WHATSAPP_MENU_BASIC);
    exclusiveTemplate.attributes.exclusiveChannel = true;
    exclusiveTemplate.intents[0].actions.push({ _tdActionType: 'whatsapp_static', attributes: { templateName: 'exclusive_waba' } });

    const preparedCasezap = chatcaseTemplates.prepareTemplateForChannel(exclusiveTemplate, 'casezap');
    assert.strictEqual(preparedCasezap.attributes.targetChannel, 'casezap');
    assert.strictEqual(preparedCasezap.attributes.selectedChannel, 'casezap');
    assert.strictEqual(preparedCasezap.attributes.channelScopeMode, 'exclusive');
    assert.deepStrictEqual(preparedCasezap.attributes.channels, ['casezap']);
    assert.deepStrictEqual(Object.keys(preparedCasezap.attributes.channelCompatibility), ['casezap']);
    assert(!preparedCasezap.intents[0].actions.some((action) => action._tdActionType === 'whatsapp_static'), 'explicit CaseZap flow should strip WABA-only actions');
  });

  it('classifies WABA-specific actions with a safe text fallback for CaseZap', () => {
    const action = {
      _tdActionId: 'stable-action-id',
      _tdActionType: 'whatsapp_static',
      attributes: {
        body: 'Olá, escolha uma opção no menu.'
      }
    };

    const compatibility = chatcaseTemplates.getActionChannelCompatibility(action, 'casezap');
    assert.strictEqual(compatibility.status, 'fallback');
    assert.strictEqual(compatibility.channel, 'casezap');
    assert.strictEqual(compatibility.fallbackType, 'text');
    assert.strictEqual(compatibility.reason, 'waba_action_on_non_waba_channel');

    const fallback = chatcaseTemplates.createActionFallbackForChannel(action, 'casezap');
    assert.strictEqual(fallback._tdActionId, action._tdActionId);
    assert.strictEqual(fallback._tdActionType, 'reply');
    assert.strictEqual(fallback.text, 'Olá, escolha uma opção no menu.');
  });

  it('classifies WABA send actions with payload fallback text for CaseZap', () => {
    const action = {
      _tdActionType: 'send_whatsapp',
      payload: {
        fallbackText: 'Mensagem alternativa para conversa CaseZap.'
      }
    };

    const compatibility = chatcaseTemplates.getActionChannelCompatibility(action, 'casezap');
    assert.strictEqual(compatibility.status, 'fallback');
    assert.strictEqual(compatibility.fallbackType, 'text');

    const fallback = chatcaseTemplates.createActionFallbackForChannel(action, 'casezap');
    assert.strictEqual(fallback._tdActionType, 'reply');
    assert.strictEqual(fallback.text, 'Mensagem alternativa para conversa CaseZap.');
  });

  it('requires review for WABA-specific actions without text fallback on CaseZap', () => {
    const action = {
      _tdActionType: 'whatsapp_static',
      attributes: {
        templateName: 'approved_template_without_local_body'
      }
    };

    const compatibility = chatcaseTemplates.getActionChannelCompatibility(action, 'casezap');
    assert.strictEqual(compatibility.status, 'review_required');
    assert.strictEqual(compatibility.channel, 'casezap');
    assert.strictEqual(compatibility.fallbackType, null);
    assert.strictEqual(compatibility.reason, 'waba_action_without_text_fallback');
    assert.strictEqual(chatcaseTemplates.createActionFallbackForChannel(action, 'casezap'), null);
  });

  it('keeps generic actions native on CaseZap and WABA-specific actions native on WABA', () => {
    const genericAction = {
      _tdActionType: 'reply',
      text: 'Mensagem comum'
    };
    const wabaAction = {
      _tdActionType: 'whatsapp_attribute',
      attributes: {
        body: 'Mensagem de template'
      }
    };

    assert.strictEqual(chatcaseTemplates.getActionChannelCompatibility(genericAction, 'casezap').status, 'native');
    assert.strictEqual(chatcaseTemplates.getActionChannelCompatibility(wabaAction, 'waba').status, 'native');
    assert.strictEqual(chatcaseTemplates.createActionFallbackForChannel(genericAction, 'casezap'), null);
  });

  it('returns null for unknown template ids', () => {
    assert.strictEqual(chatcaseTemplates.getTemplateById('missing-template'), null);
    assert.strictEqual(chatcaseTemplates.getTemplatePayloadById('missing-template'), null);
    assert.strictEqual(chatcaseTemplates.getTemplateExportById('missing-template'), null);
  });
});
