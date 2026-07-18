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

function getFlowSnapshot(template) {
  return template.intents.map((intent) => ({
    intentId: intent.intent_id,
    position: intent.attributes.position,
    actions: intent.actions.map((action) => ({
      actionId: action._tdActionId,
      buttons: getActionButtons(action).map((button) => ({
        type: button.type,
        uid: button.uid,
        action: button.action
      }))
    }))
  }));
}

function getReachableIntentIds(template) {
  const startIntent = template.intents.find((intent) => intent.question === '\\start');
  const intentIds = new Set(template.intents.map((intent) => intent.intent_id));
  const reachable = new Set(startIntent ? [startIntent.intent_id] : []);
  const queue = startIntent ? [startIntent] : [];

  while (queue.length) {
    const currentIntent = queue.shift();
    currentIntent.actions.forEach((action) => {
      getActionButtons(action).forEach((button) => {
        const targetId = String(button.action || '').replace(/^#/, '');
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
      assert(handoffIntent, `detail should include human handoff intent for ${template._id}`);
      assert(
        !handoffIntent.answer.includes('\\agent'),
        `${template._id}: human handoff answer should not leak routing commands to the user`
      );
      assert(
        handoffIntent.actions.some((action) => action._tdActionType === 'agent'),
        `${template._id}: human handoff action should trigger Tiledesk agent routing`
      );

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
      assert.strictEqual(exported.attributes.nativeInteractions.whatsapp, 'buttons');
      assert.strictEqual(exported.attributes.nativeInteractions.casezap, 'menu');
      assert(exported.attributes.publication, 'export should include publication readiness metadata');
      assert(Array.isArray(exported.attributes.publication.checklist), 'export should include publication checklist');
    });
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
      const reachable = getReachableIntentIds(imported);
      const disconnected = imported.intents.filter((intent) => !reachable.has(intent.intent_id));

      assert.deepStrictEqual(
        disconnected.map((intent) => intent.intent_display_name),
        ['defaultFallback'],
        `${template._id}: only the fallback block should remain intentionally disconnected`
      );
    });
  });

  it('filters template metadata and payloads by channel compatibility without scoping generic flows', () => {
    const casezapTemplates = chatcaseTemplates.listMetadata({ channel: 'casezap' });
    assert(casezapTemplates.length >= 6, 'casezap should list local templates');

    casezapTemplates.forEach((template) => {
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
