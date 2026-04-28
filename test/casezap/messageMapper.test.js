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
      var result = messageMapper.mapOutbound({ text: 'cap', type: 'image', metadata: { src: 'https://img.com/x.jpg', type: 'image' } }, '55');
      assert.strictEqual(result.endpoint, '/send/media');
      assert.strictEqual(result.body.type, 'image');
    });
    it('should map document to /send/media with docName', function() {
      var result = messageMapper.mapOutbound({ type: 'file', metadata: { src: 'https://x.com/f.pdf', name: 'report.pdf', type: 'file' } }, '55');
      assert.strictEqual(result.body.type, 'document');
      assert.strictEqual(result.body.docName, 'report.pdf');
    });
    it('should map buttons to /send/menu', function() {
      var result = messageMapper.mapOutbound({ text: 'Choose:', type: 'text', attributes: { attachment: { buttons: [{ label: 'Yes' }, { label: 'No' }] } } }, '55');
      assert.strictEqual(result.endpoint, '/send/menu');
      assert.deepStrictEqual(result.body.choices, ['Yes', 'No']);
    });
  });
});
