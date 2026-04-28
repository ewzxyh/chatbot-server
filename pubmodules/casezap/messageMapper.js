var winston = require('../../config/winston');

function extractPhone(jid) {
  if (!jid) return null;
  return jid.replace('@s.whatsapp.net', '').replace('@lid', '');
}

function mapInbound(webhookData) {
  var msg = webhookData.data || webhookData;
  var key = msg.key || {};
  var remoteJid = key.remoteJid || '';
  var phone = extractPhone(remoteJid);
  var messageContent = msg.message || {};
  var messageType = msg.messageType || '';
  var pushName = msg.pushName || '';

  var result = {
    messageId: key.id,
    phone: phone,
    leadId: 'casezap-' + phone,
    fullname: pushName || phone,
    fromMe: key.fromMe || false,
    isGroup: remoteJid.includes('@g.us'),
    timestamp: msg.messageTimestamp || Date.now(),
    text: null,
    type: 'text',
    metadata: null
  };

  switch (messageType) {
    case 'conversation':
      result.text = messageContent.conversation || msg.body || '';
      result.type = 'text';
      break;

    case 'extendedTextMessage':
      result.text = (messageContent.extendedTextMessage && messageContent.extendedTextMessage.text) || '';
      result.type = 'text';
      break;

    case 'imageMessage':
      result.type = 'image';
      result.text = (messageContent.imageMessage && messageContent.imageMessage.caption) || '';
      result.metadata = {
        src: messageContent.imageMessage && messageContent.imageMessage.url,
        width: messageContent.imageMessage && messageContent.imageMessage.width,
        height: messageContent.imageMessage && messageContent.imageMessage.height,
        type: 'image'
      };
      break;

    case 'videoMessage':
      result.type = 'frame';
      result.text = (messageContent.videoMessage && messageContent.videoMessage.caption) || '';
      result.metadata = {
        src: messageContent.videoMessage && messageContent.videoMessage.url,
        type: 'video'
      };
      break;

    case 'audioMessage':
    case 'pttMessage':
      result.type = 'file';
      result.metadata = {
        src: (messageContent.audioMessage && messageContent.audioMessage.url) ||
             (messageContent.pttMessage && messageContent.pttMessage.url),
        type: 'audio'
      };
      break;

    case 'documentMessage':
      result.type = 'file';
      result.text = (messageContent.documentMessage && messageContent.documentMessage.title) || '';
      result.metadata = {
        src: messageContent.documentMessage && messageContent.documentMessage.url,
        name: (messageContent.documentMessage && messageContent.documentMessage.fileName) || 'document',
        type: 'file'
      };
      break;

    case 'stickerMessage':
      result.type = 'image';
      result.metadata = {
        src: messageContent.stickerMessage && messageContent.stickerMessage.url,
        type: 'image'
      };
      break;

    case 'locationMessage':
      var loc = messageContent.locationMessage || {};
      result.type = 'text';
      result.text = (loc.name ? loc.name + '\n' : '') +
        (loc.address ? loc.address + '\n' : '') +
        'https://maps.google.com/?q=' + (loc.degreesLatitude || 0) + ',' + (loc.degreesLongitude || 0);
      break;

    case 'contactMessage':
    case 'contactsArrayMessage':
      result.type = 'text';
      var contacts = messageContent.contactsArrayMessage
        ? messageContent.contactsArrayMessage.contacts
        : (messageContent.contactMessage ? [messageContent.contactMessage] : []);
      result.text = contacts.map(function(c) {
        return (c.displayName || 'Contact') + ': ' + (c.vcard || '');
      }).join('\n');
      break;

    case 'reactionMessage':
      return null;

    default:
      result.type = 'text';
      result.text = '[' + messageType + ']';
      break;
  }

  return result;
}

function mapOutbound(tiledeskMessage, recipientPhone) {
  var number = recipientPhone;
  var text = tiledeskMessage.text || '';
  var type = tiledeskMessage.type || 'text';
  var metadata = tiledeskMessage.metadata || {};
  var attributes = tiledeskMessage.attributes || {};

  if (attributes.attachment && attributes.attachment.type) {
    type = attributes.attachment.type;
    metadata = attributes.attachment;
  }

  if (type === 'text' && !metadata.src) {
    if (attributes.attachment && attributes.attachment.buttons && attributes.attachment.buttons.length > 0) {
      return {
        endpoint: '/send/menu',
        body: {
          number: number,
          type: 'button',
          text: text,
          choices: attributes.attachment.buttons.map(function(b) { return b.value || b.label || b.title; })
        }
      };
    }
    return {
      endpoint: '/send/text',
      body: { number: number, text: text }
    };
  }

  if (type === 'image' || (metadata.type === 'image')) {
    return {
      endpoint: '/send/media',
      body: {
        number: number,
        file: metadata.src || metadata.url,
        type: 'image',
        text: text || undefined
      }
    };
  }

  if (type === 'frame' || metadata.type === 'video') {
    return {
      endpoint: '/send/media',
      body: {
        number: number,
        file: metadata.src || metadata.url,
        type: 'video',
        text: text || undefined
      }
    };
  }

  if (type === 'file') {
    if (metadata.type === 'audio') {
      return {
        endpoint: '/send/media',
        body: {
          number: number,
          file: metadata.src || metadata.url,
          type: 'audio'
        }
      };
    }
    return {
      endpoint: '/send/media',
      body: {
        number: number,
        file: metadata.src || metadata.url,
        type: 'document',
        docName: metadata.name || 'document'
      }
    };
  }

  if (type === 'gallery' || (attributes.attachment && attributes.attachment.gallery)) {
    var gallery = attributes.attachment.gallery || [];
    return {
      endpoint: '/send/carousel',
      body: {
        number: number,
        text: text,
        choices: gallery.map(function(card) {
          var btns = (card.buttons || []).map(function(b) { return '[' + (b.value || b.label) + ']'; }).join('');
          return '[' + (card.title || '') + ']{' + (card.image || '') + '}' + btns;
        })
      }
    };
  }

  return {
    endpoint: '/send/text',
    body: { number: number, text: text || '[unsupported message type]' }
  };
}

module.exports = {
  mapInbound: mapInbound,
  mapOutbound: mapOutbound,
  extractPhone: extractPhone
};
