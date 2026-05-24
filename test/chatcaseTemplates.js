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
      assert.strictEqual(template.attributes.nativeInteractions.whatsapp, 'buttons');
      assert.strictEqual(template.attributes.nativeInteractions.casezap, 'menu');
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
    });
  });

  it('returns null for unknown template ids', () => {
    assert.strictEqual(chatcaseTemplates.getTemplateById('missing-template'), null);
    assert.strictEqual(chatcaseTemplates.getTemplatePayloadById('missing-template'), null);
    assert.strictEqual(chatcaseTemplates.getTemplateExportById('missing-template'), null);
  });
});
