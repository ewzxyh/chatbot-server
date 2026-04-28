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

  describe('mapInbound', function() {
    it('should map conversation text message', function() {
      var webhook = { data: { key: { id: 'msg-001', remoteJid: 'redacted@example.invalid', fromMe: false }, message: { conversation: 'Ola!' }, messageType: 'conversation', pushName: 'Maria' } };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.text, 'Ola!');
      assert.strictEqual(result.type, 'text');
      assert.strictEqual(result.phone, '5511999999999');
      assert.strictEqual(result.leadId, 'casezap-5511999999999');
      assert.strictEqual(result.fullname, 'Maria');
    });
    it('should map image message with caption', function() {
      var webhook = { data: { key: { id: 'msg-002', remoteJid: 'redacted@example.invalid', fromMe: false }, message: { imageMessage: { url: 'https://cdn.example.com/img.jpg', caption: 'Look', width: 800, height: 600 } }, messageType: 'imageMessage', pushName: 'Maria' } };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'image');
      assert.strictEqual(result.text, 'Look');
      assert.strictEqual(result.metadata.src, 'https://cdn.example.com/img.jpg');
    });
    it('should map audio message', function() {
      var webhook = { data: { key: { id: 'msg-003', remoteJid: 'redacted@example.invalid', fromMe: false }, message: { audioMessage: { url: 'https://cdn.example.com/audio.ogg' } }, messageType: 'audioMessage', pushName: 'Maria' } };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'file');
      assert.strictEqual(result.metadata.type, 'audio');
    });
    it('should map location message', function() {
      var webhook = { data: { key: { id: 'msg-004', remoteJid: 'redacted@example.invalid', fromMe: false }, message: { locationMessage: { degreesLatitude: -23.55, degreesLongitude: -46.63, name: 'Sao Paulo' } }, messageType: 'locationMessage', pushName: 'Maria' } };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'text');
      assert.ok(result.text.includes('maps.google.com'));
    });
    it('should return null for reaction messages', function() {
      var webhook = { data: { key: { id: 'msg-005', remoteJid: 'redacted@example.invalid', fromMe: false }, message: { reactionMessage: { text: '' } }, messageType: 'reactionMessage', pushName: 'Maria' } };
      assert.strictEqual(messageMapper.mapInbound(webhook), null);
    });
    it('should detect group JIDs', function() {
      var webhook = { data: { key: { id: 'msg-006', remoteJid: 'redacted@example.invalid', fromMe: false }, message: { conversation: 'group' }, messageType: 'conversation', pushName: 'Maria' } };
      assert.strictEqual(messageMapper.mapInbound(webhook).isGroup, true);
    });
  });

  describe('mapOutbound', function() {
    it('should map text to /send/text', function() {
      var result = messageMapper.mapOutbound({ text: 'Hello!', type: 'text' }, '5511999999999');
      assert.strictEqual(result.endpoint, '/send/text');
      assert.strictEqual(result.body.text, 'Hello!');
    });
    it('should map image to /send/media', function() {
      var result = messageMapper.mapOutbound({ text: 'cap', type: 'image', metadata: { src: 'https://img.com/x.jpg', type: 'image' } }, '5511999999999');
      assert.strictEqual(result.endpoint, '/send/media');
      assert.strictEqual(result.body.type, 'image');
      assert.strictEqual(result.body.file, 'https://img.com/x.jpg');
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
