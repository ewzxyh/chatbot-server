const assert = require('assert');
const chatcaseTemplates = require('../pubmodules/chatbotTemplates/chatcaseTemplates');

describe('ChatCase chatbot templates', () => {
  it('lists all certified local templates with import metadata', () => {
    const templates = chatcaseTemplates.listMetadata();

    assert(templates.length >= 3, 'should expose multiple ChatCase templates');

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

      const exported = chatcaseTemplates.getTemplateExportById(template._id);
      assert(exported, `export should exist for ${template._id}`);
      assert.strictEqual(exported._id, template._id);
      assert.strictEqual(exported.source, 'chatcase-template-export');
      assert(Date.parse(exported.exportedAt), 'export should include exportedAt timestamp');
      assert.strictEqual(exported.intents.length, template.intentsCount);
    });
  });

  it('returns null for unknown template ids', () => {
    assert.strictEqual(chatcaseTemplates.getTemplateById('missing-template'), null);
    assert.strictEqual(chatcaseTemplates.getTemplatePayloadById('missing-template'), null);
    assert.strictEqual(chatcaseTemplates.getTemplateExportById('missing-template'), null);
  });
});
