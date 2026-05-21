var winston = require('../../config/winston');

function extractPhone(jid) {
  if (!jid) return null;
  return jid.replace('@s.whatsapp.net', '').replace('@lid', '');
}

function getMessage(webhookData) {
  return webhookData.message || webhookData;
}

function getMediaUrl(message) {
  var content = message.content;
  if (content && typeof content === 'object') {
    content = content.url || content.fileURL || content.mediaUrl;
  }
  return message.mediaUrl || message.fileURL || message.fileUrl || message.url || content;
}

function getText(message) {
  if (message.text) return message.text;
  if (typeof message.content === 'string') return message.content;
  if (message.content && typeof message.content === 'object') {
    return message.content.conversation || message.content.caption || message.content.text || '';
  }
  return '';
}

function getDocumentName(message) {
  var content = message.content && typeof message.content === 'object' ? message.content : {};
  return message.fileName || message.filename || message.docName || message.name || content.fileName || content.filename || content.docName || content.name || 'document';
}

function getDocumentType(message) {
  var content = message.content && typeof message.content === 'object' ? message.content : {};
  return message.mimetype || message.mimeType || message.contentType || content.mimetype || content.mimeType || content.contentType || 'file';
}

function getDownloadId(message) {
  return message.id || message.messageid || message.messageId;
}

function mapInbound(webhookData) {
  var message = getMessage(webhookData || {});
  var chat = webhookData.chat || {};
  var chatid = message.chatid || chat.wa_chatid || '';
  var phone = extractPhone(chatid);
  var messageType = (message.messageType || message.type || '').toLowerCase();
  var senderName = message.senderName || chat.wa_name || chat.wa_contactName || '';

  var result = {
    messageId: message.messageid || message.id,
    phone: phone,
    leadId: 'casezap-' + phone,
    fullname: senderName || phone,
    fromMe: message.fromMe || false,
    isGroup: message.isGroup || chat.wa_isGroup || chatid.includes('@g.us'),
    timestamp: message.messageTimestamp || Date.now(),
    text: null,
    type: 'text',
    metadata: null
  };
  result.downloadId = getDownloadId(message);

  switch (messageType) {
    case 'conversation':
    case 'extendedtextmessage':
    case 'text':
      result.text = getText(message);
      result.type = 'text';
      break;

    case 'imagemessage':
    case 'image':
      result.type = 'image';
      result.text = getText(message);
      result.metadata = { src: getMediaUrl(message), type: 'image' };
      break;

    case 'videomessage':
    case 'video':
      result.type = 'frame';
      result.text = getText(message);
      result.metadata = { src: getMediaUrl(message), type: 'video' };
      break;

    case 'audiomessage':
    case 'pttmessage':
    case 'audio':
    case 'ptt':
      result.type = 'file';
      result.metadata = { src: getMediaUrl(message), type: message.mimetype || message.mimeType || 'audio' };
      break;

    case 'documentmessage':
    case 'document':
      var documentUrl = getMediaUrl(message);
      var documentName = getDocumentName(message);
      result.type = 'file';
      result.text = message.text || (documentUrl ? '[' + documentName + '](' + documentUrl + ')' : documentName);
      result.metadata = { src: documentUrl, name: documentName, type: getDocumentType(message) };
      break;

    case 'stickermessage':
    case 'sticker':
      result.type = 'image';
      result.metadata = { src: getMediaUrl(message), type: 'image' };
      break;

    case 'locationmessage':
    case 'location':
      result.type = 'text';
      result.text = getText(message) + '\nhttps://maps.google.com/?q=' + (message.latitude || 0) + ',' + (message.longitude || 0);
      break;

    case 'contactmessage':
    case 'contact':
      result.type = 'text';
      result.text = getText(message) || '[contact]';
      break;

    case 'reactionmessage':
    case 'reaction':
      return null;

    default:
      result.type = 'text';
      result.text = getText(message) || '[' + messageType + ']';
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

  function outboundMediaUrl() {
    return metadata.downloadCdnUrl || metadata.cdnUrl || metadata.downloadUrl || metadata.src || metadata.url;
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
        file: outboundMediaUrl(),
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
        file: outboundMediaUrl(),
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
          file: outboundMediaUrl(),
          type: 'audio'
        }
      };
    }
    return {
      endpoint: '/send/media',
      body: {
        number: number,
        file: outboundMediaUrl(),
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
  extractPhone: extractPhone,
  getMediaUrl: getMediaUrl,
  getText: getText
};
