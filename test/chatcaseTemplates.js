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
      assert.strictEqual(template.attributes.nativeInteractions.whatsapp, 'buttons');
      assert.strictEqual(template.attributes.nativeInteractions.casezap, 'menu');
      assert(template.attributes.publication, 'template should expose publication readiness metadata');
      assert(Array.isArray(template.attributes.publication.readiness), 'template should expose channel readiness list');
      assert(Array.isArray(template.attributes.publication.wabaTemplates), 'template should expose WABA template suggestions');
      assert(template.attributes.publication.wabaTemplates.length > 0, 'template should expose at least one WABA template suggestion');
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

  it('filters template metadata and payloads by selected channel', () => {
    const casezapTemplates = chatcaseTemplates.listMetadata({ channel: 'casezap' });
    assert(casezapTemplates.length >= 6, 'casezap should list local templates');

    casezapTemplates.forEach((template) => {
      assert.strictEqual(chatcaseTemplates.getDefaultChannel(template), 'casezap');
      assert.strictEqual(template.attributes.targetChannel, 'casezap');
      assert.strictEqual(template.attributes.selectedChannel, 'casezap');
      assert(template.attributes.publication, 'casezap template should keep publication checklist');
      assert(!template.attributes.publication.wabaTemplates, 'casezap import should hide WABA template suggestions');
      assert(template.attributes.publication.readiness.every((item) => item.channel === 'casezap'), 'casezap readiness should be channel scoped');
    });

    const wabaPayload = chatcaseTemplates.getTemplatePayloadById(casezapTemplates[0]._id, { channel: 'waba' });
    assert.strictEqual(wabaPayload.attributes.targetChannel, 'waba');
    assert(Array.isArray(wabaPayload.attributes.publication.wabaTemplates), 'waba payload should expose WABA suggestions');
    assert(wabaPayload.attributes.publication.readiness.every((item) => item.channel === 'waba'), 'waba readiness should be channel scoped');

    const telegramTemplates = chatcaseTemplates.listMetadata({ channel: 'telegram' });
    assert.strictEqual(telegramTemplates.length, 0, 'telegram should not list templates without compatibility');
    assert.strictEqual(chatcaseTemplates.getTemplatePayloadById(casezapTemplates[0]._id, { channel: 'telegram' }), null, 'telegram detail should be unavailable without compatibility');
  });

  it('returns null for unknown template ids', () => {
    assert.strictEqual(chatcaseTemplates.getTemplateById('missing-template'), null);
    assert.strictEqual(chatcaseTemplates.getTemplatePayloadById('missing-template'), null);
    assert.strictEqual(chatcaseTemplates.getTemplateExportById('missing-template'), null);
  });
});
