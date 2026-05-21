var assert = require('assert');
var messageMapper = require('../../pubmodules/casezap/messageMapper');

describe('CaseZap messageMapper', function() {

  describe('extractPhone', function() {
    it('should extract phone from s.whatsapp.net JID', function() {
      assert.strictEqual(messageMapper.extractPhone('redacted@example.invalid'), '5511999999999');
    });
    it('should extract phone from lid JID', function() {
      assert.strictEqual(messageMapper.extractPhone('5511999999999@lid'), '5511999999999');
    });
    it('should return null for null input', function() {
      assert.strictEqual(messageMapper.extractPhone(null), null);
    });
  });

  describe('mapInbound (real UazApi format)', function() {
    it('should map conversation text message', function() {
      var webhook = {
        EventType: 'messages',
        message: { messageid: '3EB09D59070B', chatid: 'redacted@example.invalid', content: 'Ola teste', text: 'Ola teste', fromMe: false, isGroup: false, messageType: 'Conversation', senderName: 'Enzo Yoshida', messageTimestamp: 1777406588000 },
        chat: { wa_name: 'Enzo Yoshida', wa_chatid: 'redacted@example.invalid', wa_isGroup: false }
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.text, 'Ola teste');
      assert.strictEqual(result.type, 'text');
      assert.strictEqual(result.phone, '556284268492');
      assert.strictEqual(result.leadId, 'casezap-556284268492');
      assert.strictEqual(result.fullname, 'Enzo Yoshida');
      assert.strictEqual(result.messageId, '3EB09D59070B');
      assert.strictEqual(result.fromMe, false);
      assert.strictEqual(result.isGroup, false);
    });

    it('should map root-level UazApi conversation payload', function() {
      var webhook = {
        EventType: 'messages',
        messageid: '3EB0538DA65A59F6D8A251',
        chatid: 'redacted@example.invalid',
        senderName: 'Joao Silva',
        fromMe: false,
        isGroup: false,
        messageType: 'conversation',
        text: 'Ola, preciso de ajuda!'
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.text, 'Ola, preciso de ajuda!');
      assert.strictEqual(result.type, 'text');
      assert.strictEqual(result.phone, '5511999999999');
      assert.strictEqual(result.messageId, '3EB0538DA65A59F6D8A251');
    });

    it('should map image message', function() {
      var webhook = {
        EventType: 'messages',
        message: { messageid: 'img-001', chatid: 'redacted@example.invalid', text: 'caption', fromMe: false, isGroup: false, messageType: 'ImageMessage', mediaUrl: 'https://media.url/img.jpg', senderName: 'User' },
        chat: {}
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'image');
      assert.strictEqual(result.metadata.src, 'https://media.url/img.jpg');
    });

    it('should map root-level UazApi image fileURL', function() {
      var webhook = {
        EventType: 'messages',
        messageid: 'img-002',
        chatid: 'redacted@example.invalid',
        fromMe: false,
        isGroup: false,
        messageType: 'imageMessage',
        fileURL: 'https://media.url/img-root.jpg',
        senderName: 'User'
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'image');
      assert.strictEqual(result.metadata.src, 'https://media.url/img-root.jpg');
    });

    it('should not leak raw content objects into image text or src', function() {
      var webhook = {
        EventType: 'messages',
        messageid: 'img-003',
        chatid: 'redacted@example.invalid',
        fromMe: false,
        isGroup: false,
        messageType: 'imageMessage',
        content: {
          caption: 'caption from content',
          url: 'https://media.url/content-image.jpg'
        },
        senderName: 'User'
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'image');
      assert.strictEqual(result.text, 'caption from content');
      assert.strictEqual(result.metadata.src, 'https://media.url/content-image.jpg');
    });

    it('should expose download id when UazApi image has encrypted content but no fileURL', function() {
      var webhook = {
        EventType: 'messages',
        id: '5511999:img-004',
        messageid: 'img-004',
        chatid: 'redacted@example.invalid',
        fromMe: false,
        isGroup: false,
        messageType: 'ImageMessage',
        text: 'Imagem sem link publico',
        content: {
          URL: 'https://mmg.whatsapp.net/encrypted-image',
          mimetype: 'image/jpeg'
        },
        senderName: 'User'
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'image');
      assert.strictEqual(result.downloadId, '5511999:img-004');
      assert.strictEqual(result.metadata.src, undefined);
      assert.strictEqual(result.metadata.type, 'image');
    });

    it('should map root-level UazApi document fileURL to a visible chat link', function() {
      var webhook = {
        EventType: 'messages',
        messageid: 'doc-001',
        chatid: 'redacted@example.invalid',
        fromMe: false,
        isGroup: false,
        messageType: 'documentMessage',
        fileURL: 'https://media.url/report.pdf',
        fileName: 'report.pdf',
        mimetype: 'application/pdf',
        senderName: 'User'
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'file');
      assert.strictEqual(result.text, '[report.pdf](https://media.url/report.pdf)');
      assert.strictEqual(result.metadata.src, 'https://media.url/report.pdf');
      assert.strictEqual(result.metadata.name, 'report.pdf');
      assert.strictEqual(result.metadata.type, 'application/pdf');
    });

    it('should preserve document filename and mime type from encrypted UazApi content', function() {
      var webhook = {
        EventType: 'messages',
        id: '5511999:doc-002',
        messageid: 'doc-002',
        chatid: 'redacted@example.invalid',
        fromMe: false,
        isGroup: false,
        messageType: 'DocumentMessage',
        content: {
          URL: 'https://mmg.whatsapp.net/encrypted-document',
          fileName: 'contrato.pdf',
          mimetype: 'application/pdf'
        },
        senderName: 'User'
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'file');
      assert.strictEqual(result.downloadId, '5511999:doc-002');
      assert.strictEqual(result.text, 'contrato.pdf');
      assert.strictEqual(result.metadata.src, undefined);
      assert.strictEqual(result.metadata.name, 'contrato.pdf');
      assert.strictEqual(result.metadata.type, 'application/pdf');
    });

    it('should map audio message', function() {
      var webhook = {
        EventType: 'messages',
        message: { messageid: 'aud-001', chatid: 'redacted@example.invalid', fromMe: false, isGroup: false, messageType: 'AudioMessage', mediaUrl: 'https://media.url/a.ogg', senderName: 'User' },
        chat: {}
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'file');
      assert.strictEqual(result.metadata.type, 'audio');
    });

    it('should return null for reaction', function() {
      var webhook = { EventType: 'messages', message: { messageid: 'r1', chatid: 'redacted@example.invalid', fromMe: false, messageType: 'ReactionMessage' }, chat: {} };
      assert.strictEqual(messageMapper.mapInbound(webhook), null);
    });

    it('should detect group messages', function() {
      var webhook = { EventType: 'messages', message: { messageid: 'g1', chatid: 'redacted@example.invalid', fromMe: false, isGroup: true, messageType: 'Conversation', text: 'hi', senderName: 'U' }, chat: { wa_isGroup: true } };
      assert.strictEqual(messageMapper.mapInbound(webhook).isGroup, true);
    });

    it('should detect fromMe', function() {
      var webhook = { EventType: 'messages', message: { messageid: 'f1', chatid: 'redacted@example.invalid', fromMe: true, messageType: 'Conversation', text: 'x', senderName: 'Me' }, chat: {} };
      assert.strictEqual(messageMapper.mapInbound(webhook).fromMe, true);
    });
  });

  describe('mapOutbound', function() {
    it('should map text to /send/text', function() {
      var result = messageMapper.mapOutbound({ text: 'Hello!', type: 'text' }, '5511999999999');
      assert.strictEqual(result.endpoint, '/send/text');
      assert.strictEqual(result.body.text, 'Hello!');
    });
    it('should map image to /send/media', function() {
      var result = messageMapper.mapOutbound({ text: 'cap', type: 'image', metadata: { src: 'https://img.com/x.jpg', cdnUrl: 'https://media.example/x.jpg', type: 'image' } }, '55');
      assert.strictEqual(result.endpoint, '/send/media');
      assert.strictEqual(result.body.type, 'image');
      assert.strictEqual(result.body.file, 'https://media.example/x.jpg');
    });
    it('should map document to /send/media with docName', function() {
      var result = messageMapper.mapOutbound({ type: 'file', metadata: { src: 'https://x.com/f.pdf', downloadCdnUrl: 'https://media.example/f.pdf', name: 'report.pdf', type: 'file' } }, '55');
      assert.strictEqual(result.body.type, 'document');
      assert.strictEqual(result.body.docName, 'report.pdf');
      assert.strictEqual(result.body.file, 'https://media.example/f.pdf');
    });
    it('should map buttons to /send/menu', function() {
      var result = messageMapper.mapOutbound({ text: 'Choose:', type: 'text', attributes: { attachment: { buttons: [{ label: 'Yes' }, { label: 'No' }] } } }, '55');
      assert.strictEqual(result.endpoint, '/send/menu');
      assert.deepStrictEqual(result.body.choices, ['Yes', 'No']);
    });
  });
});
