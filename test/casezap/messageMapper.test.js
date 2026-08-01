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
        chat: { wa_name: 'Enzo Yoshida', wa_contactName: 'Enzo salvo', wa_chatid: 'redacted@example.invalid', wa_isGroup: false }
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.text, 'Ola teste');
      assert.strictEqual(result.type, 'text');
      assert.strictEqual(result.phone, '556284268492');
      assert.strictEqual(result.leadId, 'casezap-556284268492');
      assert.strictEqual(result.fullname, 'Enzo Yoshida');
      assert.strictEqual(result.contactName, 'Enzo salvo');
      assert.strictEqual(result.isSavedContact, true);
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
      assert.strictEqual(result.contactName, '');
      assert.strictEqual(result.isSavedContact, false);
    });

    it('should preserve quoted text message metadata from UazApi extended text payload', function() {
      var webhook = {
        EventType: 'messages',
        message: {
          messageid: 'ACDE6DFB8E61716193CF896CDB41ED70',
          chatid: 'redacted@example.invalid',
          quoted: '3EB05EABF3EF9677182E43',
          fromMe: false,
          isGroup: false,
          messageType: 'ExtendedTextMessage',
          senderName: 'Enzo Yoshida',
          sender_pn: 'redacted@example.invalid',
          content: {
            text: 'Teste citacao',
            contextInfo: {
              participant: '38732652634220@lid',
              quotedMessage: {
                conversation: 'Uma nova solicitação de suporte foi atribuída a você: I'
              },
              quotedType: 0
            }
          }
        },
        chat: { wa_chatid: 'redacted@example.invalid', wa_name: 'Enzo Yoshida' }
      };

      var result = messageMapper.mapInbound(webhook);
      var markerMatch = result.text.match(/^\[casezap-quote:([A-Za-z0-9+/=]+)\]\nTeste citacao$/);

      assert.ok(markerMatch);
      assert.strictEqual(result.quote.id, '3EB05EABF3EF9677182E43');
      assert.strictEqual(result.quote.text, 'Uma nova solicitação de suporte foi atribuída a você: I');
      assert.strictEqual(result.quote.participant, '38732652634220@lid');
      assert.strictEqual(result.quote.senderLabel, 'Você');
      assert.strictEqual(result.quote.type, '0');

      var decoded = JSON.parse(Buffer.from(markerMatch[1], 'base64').toString('utf8'));
      assert.deepStrictEqual(decoded, result.quote);
      assert.strictEqual(messageMapper.stripQuoteMarker(result.text), 'Teste citacao');
    });

    it('should strip structured CaseZap markers from request previews', function() {
      assert.strictEqual(
        messageMapper.stripQuoteMarker('[casezap-event:eyJwcmV2aWV3IjoiRXZlbnRvOiB0ZXN0ZSJ9]\nEvento: teste'),
        'Evento: teste'
      );
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
        message: {
          messageid: 'aud-001',
          chatid: 'redacted@example.invalid',
          fromMe: false,
          isGroup: false,
          messageType: 'AudioMessage',
          mediaUrl: 'https://media.url/a.ogg',
          senderName: 'User',
          content: { mimetype: 'audio/ogg; codecs=opus', seconds: 473, PTT: false }
        },
        chat: {}
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'file');
      assert.strictEqual(result.metadata.type, 'audio/ogg');
      assert.strictEqual(result.metadata.duration, '7:53');
      assert.ok(result.text.indexOf('[casezap-audio:') === 0);
      assert.ok(result.text.endsWith('Audio - 7:53'));
    });

    it('should map contact message to a structured contact preview', function() {
      var webhook = {
        EventType: 'messages',
        message: {
          messageid: 'contact-001',
          chatid: 'redacted@example.invalid',
          fromMe: false,
          isGroup: false,
          messageType: 'ContactMessage',
          content: {
            displayName: '+55 62 8426-8492',
            vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:+55 62 8426-8492\nTEL;type=CELL;waid=556284268492:+55 62 8426-8492\nEND:VCARD'
          },
          senderName: 'User'
        },
        chat: {}
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'text');
      assert.strictEqual(result.metadata.type, 'casezap/contact');
      assert.strictEqual(result.metadata.contact.phone, '556284268492');
      assert.ok(result.text.indexOf('[casezap-contact:') === 0);
      assert.ok(result.text.endsWith('Contato: +55 62 8426-8492'));
    });

    it('should map poll creation message to a structured poll preview', function() {
      var webhook = {
        EventType: 'messages',
        message: {
          messageid: 'poll-001',
          chatid: 'redacted@example.invalid',
          fromMe: false,
          isGroup: false,
          messageType: 'PollCreationMessage',
          text: 'teste',
          content: {
            pollCreationMessage: {
              name: 'teste',
              options: [{ optionName: '1' }, { optionName: '2' }]
            }
          },
          senderName: 'User'
        },
        chat: {}
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.metadata.type, 'casezap/poll');
      assert.deepStrictEqual(result.metadata.poll.options, ['1', '2']);
      assert.deepStrictEqual(result.metadata.poll.results, [
        { option: '1', count: 0, percent: 0 },
        { option: '2', count: 0, percent: 0 }
      ]);
      assert.ok(result.text.indexOf('[casezap-poll:') === 0);
      assert.ok(result.text.endsWith('Enquete: teste'));
    });

    it('should map poll update message to a non-chat update payload', function() {
      var webhook = {
        EventType: 'messages',
        message: {
          messageid: 'poll-update-001',
          chatid: 'redacted@example.invalid',
          sender: 'redacted@example.invalid',
          fromMe: false,
          isGroup: false,
          messageType: 'PollUpdateMessage',
          vote: '1',
          quoted: 'poll-001',
          content: {
            pollCreationMessageKey: { ID: 'poll-001' }
          },
          senderName: 'User'
        },
        chat: {}
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'casezap_poll_update');
      assert.strictEqual(result.metadata.type, 'casezap/poll_update');
      assert.strictEqual(result.metadata.pollUpdate.pollMessageId, 'poll-001');
      assert.strictEqual(result.metadata.pollUpdate.vote, '1');
      assert.strictEqual(result.metadata.pollUpdate.voterId, 'redacted@example.invalid');
    });

    it('should compute poll percentages from unique voters', function() {
      var poll = messageMapper.applyPollVoteToPayload({
        title: 'teste',
        options: ['1', '2'],
        preview: 'Enquete: teste'
      }, 'redacted@example.invalid', '1');

      poll = messageMapper.applyPollVoteToPayload(poll, 'redacted@example.invalid', '2');

      assert.strictEqual(poll.voteTotal, 2);
      assert.deepStrictEqual(poll.results, [
        { option: '1', count: 1, percent: 50 },
        { option: '2', count: 1, percent: 50 }
      ]);
    });

    it('should map event message to a structured event preview', function() {
      var webhook = {
        EventType: 'messages',
        message: {
          messageid: 'event-001',
          chatid: 'redacted@example.invalid',
          fromMe: false,
          isGroup: false,
          messageType: 'EventMessage',
          content: {
            name: 'teste',
            description: '123',
            startTime: 1779422400,
            attendanceCount: 1,
            location: { name: '123', degreesLatitude: 0, degreesLongitude: 0 }
          },
          senderName: 'User'
        },
        chat: {}
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.metadata.type, 'casezap/event');
      assert.strictEqual(result.metadata.event.title, 'teste');
      assert.strictEqual(result.metadata.event.description, '123');
      assert.strictEqual(result.metadata.event.locationName, '123');
      assert.strictEqual(result.metadata.event.attendanceCount, 1);
      assert.ok(result.text.indexOf('[casezap-event:') === 0);
      assert.ok(result.text.endsWith('Evento: teste'));
    });

    it('should map button response message to selected button id', function() {
      var webhook = {
        EventType: 'messages',
        message: {
          messageid: 'button-response-001',
          chatid: 'redacted@example.invalid',
          fromMe: false,
          isGroup: false,
          messageType: 'buttonsResponseMessage',
          buttonOrListid: 'Falar atendente',
          senderName: 'User'
        },
        chat: {}
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'text');
      assert.strictEqual(result.text, 'Falar atendente');
    });

    it('should map list response message to selected item id', function() {
      var webhook = {
        EventType: 'messages',
        message: {
          messageid: 'list-response-001',
          chatid: 'redacted@example.invalid',
          fromMe: false,
          isGroup: false,
          messageType: 'listResponseMessage',
          buttonOrListid: 'Plano mensal',
          senderName: 'User'
        },
        chat: {}
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'text');
      assert.strictEqual(result.text, 'Plano mensal');
    });

    it('should map button message without leaking provider type', function() {
      var webhook = {
        EventType: 'messages',
        message: {
          messageid: 'button-message-001',
          chatid: 'redacted@example.invalid',
          fromMe: false,
          isGroup: false,
          messageType: 'buttonsMessage',
          senderName: 'User'
        },
        chat: {}
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'text');
      assert.strictEqual(result.text, 'Mensagem com botões');
    });

    it('should map list message without leaking provider type', function() {
      var webhook = {
        EventType: 'messages',
        message: {
          messageid: 'list-message-001',
          chatid: 'redacted@example.invalid',
          fromMe: false,
          isGroup: false,
          messageType: 'listMessage',
          senderName: 'User'
        },
        chat: {}
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.type, 'text');
      assert.strictEqual(result.text, 'Mensagem de lista');
    });

    it('should show one confirmed attendee for event payloads without provider attendance count', function() {
      var webhook = {
        EventType: 'messages',
        message: {
          messageid: 'event-002',
          chatid: 'redacted@example.invalid',
          fromMe: false,
          isGroup: false,
          messageType: 'EventMessage',
          content: {
            name: 'teste',
            startTime: 1779422400,
            isCanceled: false
          },
          senderName: 'User'
        },
        chat: {}
      };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.metadata.event.attendanceCount, 1);
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
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.fromMe, true);
      assert.strictEqual(result.fullname, null);
    });

    it('should detect fromMe from message key', function() {
      var webhook = { EventType: 'messages', message: { messageid: 'f2', chatid: 'redacted@example.invalid', key: { fromMe: true }, messageType: 'Conversation', text: 'x', senderName: 'Me' }, chat: {} };
      var result = messageMapper.mapInbound(webhook);
      assert.strictEqual(result.fromMe, true);
      assert.strictEqual(result.fullname, null);
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
    it('should map sticker to /send/media without document or text fields', function() {
      var result = messageMapper.mapOutbound({
        text: 'ignored caption',
        type: 'sticker',
        metadata: {
          downloadCdnUrl: 'https://media.example/sticker.webp',
          cdnUrl: 'https://cdn.example/sticker.webp',
          src: 'https://img.com/sticker.webp',
          type: 'image'
        }
      }, '55');
      assert.deepStrictEqual(result, {
        endpoint: '/send/media',
        body: {
          number: '55',
          file: 'https://media.example/sticker.webp',
          type: 'sticker'
        }
      });
    });
    it('should map document to /send/media with docName', function() {
      var result = messageMapper.mapOutbound({ type: 'file', metadata: { src: 'https://x.com/f.pdf', downloadCdnUrl: 'https://media.example/f.pdf', name: 'report.pdf', type: 'file' } }, '55');
      assert.strictEqual(result.endpoint, '/send/media');
      assert.strictEqual(result.body.type, 'document');
      assert.strictEqual(result.body.docName, 'report.pdf');
      assert.strictEqual(result.body.file, 'https://media.example/f.pdf');
    });
    it('should map buttons to /send/menu', function() {
      var result = messageMapper.mapOutbound({
        text: 'Choose:',
        type: 'text',
        attributes: {
          attachment: {
            buttons: [
              { value: 'Ver planos', label: 'Plans' },
              { value: 'Falar atendente', label: 'Support' }
            ]
          }
        }
      }, '55');
      assert.strictEqual(result.endpoint, '/send/menu');
      assert.strictEqual(result.body.type, 'button');
      assert.strictEqual(result.body.text, 'Choose:');
      assert.deepStrictEqual(result.body.choices, ['Ver planos', 'Falar atendente']);
    });
  });
});
