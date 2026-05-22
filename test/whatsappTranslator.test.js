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

    it('prefers signed CDN URLs when sending media to WhatsApp', async function() {
      const translator = new TiledeskWhatsappTranslator();

      const image = await translator.toWhatsapp({
        text: 'foto',
        type: 'image',
        metadata: {
          src: 'https://public.example/api/files?path=uploads%2Fphoto.jpg',
          cdnUrl: 'https://media.example/files/uploads/photo.jpg?exp=1&sig=a',
          type: 'image/jpeg',
        },
      }, '5511999999999');

      const document = await translator.toWhatsapp({
        text: '[report.pdf](https://public.example/api/files?path=uploads%2Freport.pdf)',
        type: 'file',
        metadata: {
          src: 'https://public.example/api/files?path=uploads%2Freport.pdf',
          downloadUrl: 'https://public.example/api/files/download?path=uploads%2Freport.pdf',
          downloadCdnUrl: 'https://media.example/files/uploads/report.pdf?exp=1&sig=b',
          name: 'report.pdf',
          type: 'application/pdf',
        },
      }, '5511999999999');

      assert.strictEqual(image.image.link, 'https://media.example/files/uploads/photo.jpg?exp=1&sig=a');
      assert.strictEqual(document.document.link, 'https://media.example/files/uploads/report.pdf?exp=1&sig=b');
    });

    it('maps ChatCase template buttons to WhatsApp interactive buttons', async function() {
      const translator = new TiledeskWhatsappTranslator();

      const result = await translator.toWhatsapp({
        text: 'Menu ChatCase',
        type: 'text',
        attributes: {
          attachment: {
            type: 'text',
            buttons: [
              { type: 'text', value: 'Ver planos', label: 'Ver planos' },
              { type: 'text', value: 'Falar atendente', label: 'Falar atendente' }
            ]
          }
        }
      }, '5511999999999');

      assert.strictEqual(result.type, 'interactive');
      assert.strictEqual(result.interactive.type, 'button');
      assert.strictEqual(result.interactive.body.text, 'Menu ChatCase');
      assert.strictEqual(result.interactive.action.buttons.length, 2);
      assert.strictEqual(result.interactive.action.buttons[0].reply.title, 'Ver planos');
      assert.strictEqual(result.interactive.action.buttons[1].reply.title, 'Falar atendente');
      assert(result.interactive.action.buttons[0].reply.id.startsWith('quick'));
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
      assert.strictEqual(result.text, '[invoice.pdf](https://public.example/api/files/download?path=uploads%2Finvoice.pdf)\ninvoice');
      assert.strictEqual(result.metadata.src, 'https://public.example/api/files/download?path=uploads%2Finvoice.pdf');
      assert.strictEqual(result.metadata.name, 'invoice.pdf');
      assert.strictEqual(result.metadata.type, 'application/pdf');
    });

    it('uses the uploaded inline URL and preserves the download URL for inbound WhatsApp documents', async function() {
      const translator = new TiledeskWhatsappTranslator();

      const result = await translator.toTiledesk({
        type: 'document',
        document: {
          filename: 'contract.pdf',
          mime_type: 'application/pdf',
        },
      }, 'Cliente', {
        url: 'https://public.example/api/files?path=uploads%2Fcontract.pdf',
        downloadUrl: 'https://public.example/api/files/download?path=uploads%2Fcontract.pdf',
      });

      assert.strictEqual(result.type, 'file');
      assert.strictEqual(result.text, '[contract.pdf](https://public.example/api/files?path=uploads%2Fcontract.pdf)');
      assert.strictEqual(result.metadata.src, 'https://public.example/api/files?path=uploads%2Fcontract.pdf');
      assert.strictEqual(result.metadata.downloadUrl, 'https://public.example/api/files/download?path=uploads%2Fcontract.pdf');
    });

    it('preserves inbound WhatsApp CDN metadata alongside API proxy fallback URLs', async function() {
      const translator = new TiledeskWhatsappTranslator();

      const result = await translator.toTiledesk({
        type: 'document',
        document: {
          filename: 'contract.pdf',
          mime_type: 'application/pdf',
        },
      }, 'Cliente', {
        url: 'https://public.example/api/files?path=uploads%2Fcontract.pdf',
        downloadUrl: 'https://public.example/api/files/download?path=uploads%2Fcontract.pdf',
        cdnUrl: 'https://media.example/files/uploads/contract.pdf?exp=1&sig=a',
        downloadCdnUrl: 'https://media.example/files/uploads/contract.pdf?exp=1&sig=b',
      });

      assert.strictEqual(result.metadata.src, 'https://public.example/api/files?path=uploads%2Fcontract.pdf');
      assert.strictEqual(result.metadata.downloadUrl, 'https://public.example/api/files/download?path=uploads%2Fcontract.pdf');
      assert.strictEqual(result.metadata.cdnUrl, 'https://media.example/files/uploads/contract.pdf?exp=1&sig=a');
      assert.strictEqual(result.metadata.downloadCdnUrl, 'https://media.example/files/uploads/contract.pdf?exp=1&sig=b');
    });

    it('preserves inbound WhatsApp image thumbnails generated by chat uploads', async function() {
      const translator = new TiledeskWhatsappTranslator();

      const result = await translator.toTiledesk({
        type: 'image',
        image: {
          caption: 'preview',
        },
      }, 'Cliente', {
        url: 'https://public.example/api/files/download?path=uploads%2Fphoto.jpg',
        thumbnailUrl: 'https://public.example/api/files/download?path=uploads%2Fthumbnails_200_200-photo.jpg',
      });

      assert.strictEqual(result.type, 'image');
      assert.strictEqual(result.metadata.src, 'https://public.example/api/files/download?path=uploads%2Fphoto.jpg');
      assert.strictEqual(result.metadata.thumbnail, 'https://public.example/api/files/download?path=uploads%2Fthumbnails_200_200-photo.jpg');
    });
  });
});
