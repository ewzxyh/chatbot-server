process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '../utils/Translator') {
    return { translate: function(key) { return key; } };
  }
  return originalLoad.apply(this, arguments);
};
let TiledeskWhatsappTranslator;
try {
  ({ TiledeskWhatsappTranslator } = require('../pubmodules/whatsapp/connector/tiledesk/TiledeskWhatsappTranslator'));
} finally {
  Module._load = originalLoad;
}

describe('TiledeskWhatsappTranslator', function() {
  describe('toWhatsapp', function() {
    it('maps native dashboard document metadata.src to a WhatsApp document link', async function() {
      const translator = new TiledeskWhatsappTranslator();

      const result = await translator.toWhatsapp({
        text: '[report.pdf](http://localhost:8081/api/files/download?path=uploads%2Freport.pdf)',
        type: 'file',
        metadata: {
          src: 'http://localhost:8081/api/files/download?path=uploads%2Freport.pdf',
          name: 'report.pdf',
          type: 'application/pdf',
        },
      }, '5511999999999');

      assert.strictEqual(result.type, 'document');
      assert.strictEqual(result.document.link, 'http://localhost:8081/api/files/download?path=uploads%2Freport.pdf');
      assert.strictEqual(result.document.filename, 'report.pdf');
    });
  });

  describe('toTiledesk', function() {
    it('preserves inbound WhatsApp document filename and mime type for the chat preview', async function() {
      const translator = new TiledeskWhatsappTranslator();

      const result = await translator.toTiledesk({
        type: 'document',
        document: {
          caption: 'invoice',
          filename: 'invoice.pdf',
          mime_type: 'application/pdf',
        },
      }, 'Cliente', 'https://public.example/api/files/download?path=uploads%2Finvoice.pdf');

      assert.strictEqual(result.type, 'file');
      assert.strictEqual(result.metadata.src, 'https://public.example/api/files/download?path=uploads%2Finvoice.pdf');
      assert.strictEqual(result.metadata.name, 'invoice.pdf');
      assert.strictEqual(result.metadata.type, 'application/pdf');
    });
  });
});
