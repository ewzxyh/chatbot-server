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

function contentObject(message) {
  return message.content && typeof message.content === 'object' ? message.content : {};
}

function getText(message) {
  if (message.text) return message.text;
  var content = message.content;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    return content.conversation || content.caption || content.text || '';
  }
  return '';
}

function getButtonText(message) {
  var content = contentObject(message);
  var button = content.buttonsResponseMessage || content.buttonsMessage || content.templateButtonReplyMessage || content;
  return firstTruthy([
    getText(message),
    message.buttonOrListid,
    content.buttonOrListid,
    button.selectedDisplayText,
    button.selectedButtonId,
    button.displayText,
    button.contentText,
    button.title,
    button.text
  ]);
}

function getDocumentName(message) {
  var content = contentObject(message);
  return message.fileName || message.filename || message.docName || message.name || content.fileName || content.filename || content.docName || content.name || 'document';
}

function cleanMime(value) {
  return value ? String(value).split(';')[0].trim().toLowerCase() : value;
}

function getMediaMimeType(message) {
  var content = contentObject(message);
  return cleanMime(
    message.mimetype ||
    message.mimeType ||
    message.contentType ||
    content.mimetype ||
    content.mimeType ||
    content.contentType
  );
}

function getDocumentType(message) {
  return getMediaMimeType(message) || 'file';
}

function getDownloadId(message) {
  return message.id || message.messageid || message.messageId;
}

function encodeStructuredMarker(kind, payload) {
  if (!payload || !payload.preview) {
    return '';
  }
  return '[casezap-' + kind + ':' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64') + ']';
}

function applyStructuredMarker(kind, payload) {
  var marker = encodeStructuredMarker(kind, payload);
  if (!marker) {
    return payload && payload.preview ? payload.preview : '';
  }
  return marker + '\n' + payload.preview;
}

function firstTruthy(values) {
  for (var i = 0; i < values.length; i++) {
    if (values[i] !== undefined && values[i] !== null && String(values[i]).trim()) {
      return String(values[i]).trim();
    }
  }
  return '';
}

function parseVcardValue(vcard, key) {
  if (!vcard) return '';
  var lines = String(vcard).split(/\r?\n/);
  key = String(key).toUpperCase();
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var colonIndex = line.indexOf(':');
    if (colonIndex < 0) continue;
    var left = line.slice(0, colonIndex).toUpperCase();
    if (left === key || left.indexOf(key + ';') === 0) {
      return line.slice(colonIndex + 1).trim();
    }
  }
  return '';
}

function parseVcardPhone(vcard) {
  if (!vcard) return '';
  var waid = String(vcard).match(/waid=([^:;]+)/i);
  if (waid && waid[1]) {
    return waid[1].trim();
  }
  return parseVcardValue(vcard, 'TEL');
}

function contactPayload(message) {
  var content = contentObject(message);
  var vcard = content.vcard || message.vcard || '';
  var displayName = firstTruthy([
    content.displayName,
    message.displayName,
    parseVcardValue(vcard, 'FN'),
    getText(message)
  ]);
  var phone = firstTruthy([
    content.phoneNumber,
    message.phoneNumber,
    parseVcardPhone(vcard)
  ]);

  var payload = {
    displayName: displayName || phone || 'Contato',
    phone: phone,
    organization: firstTruthy([content.organization, message.organization, parseVcardValue(vcard, 'ORG')]),
    email: firstTruthy([content.email, message.email, parseVcardValue(vcard, 'EMAIL')]),
    url: firstTruthy([content.url, message.url, parseVcardValue(vcard, 'URL')])
  };
  payload.preview = 'Contato: ' + (payload.displayName || payload.phone || 'sem nome');
  return payload;
}

function formatDuration(seconds) {
  seconds = Number(seconds || 0);
  if (!seconds || seconds < 0) return '';
  var minutes = Math.floor(seconds / 60);
  var rest = Math.floor(seconds % 60);
  return minutes + ':' + String(rest).padStart(2, '0');
}

function audioPayload(message) {
  var content = contentObject(message);
  var seconds = Number(content.seconds || message.seconds || 0);
  var duration = formatDuration(seconds);
  var payload = {
    duration: duration,
    seconds: seconds || undefined,
    ptt: Boolean(content.PTT || content.ptt || message.ptt),
    mimeType: getDocumentType(message)
  };
  payload.preview = duration ? 'Audio - ' + duration : 'Audio';
  return payload;
}

function voteToOption(options, vote) {
  var value = firstTruthy([Array.isArray(vote) ? vote[0] : vote]);
  if (!value) {
    return '';
  }
  var stringValue = String(value);
  for (var i = 0; i < options.length; i++) {
    if (String(options[i]) === stringValue) {
      return options[i];
    }
  }
  var numeric = Number(stringValue);
  if (!isNaN(numeric)) {
    if (options[numeric] !== undefined) {
      return options[numeric];
    }
    if (options[numeric - 1] !== undefined) {
      return options[numeric - 1];
    }
  }
  return stringValue;
}

function applyPollVoteToPayload(payload, voterId, vote) {
  payload = Object.assign({}, payload || {});
  var options = payload.options || [];
  var votes = Object.assign({}, payload.votes || {});
  var normalizedVote = voteToOption(options, vote);
  if (voterId && normalizedVote) {
    votes[String(voterId)] = normalizedVote;
  }

  var counts = {};
  Object.keys(votes).forEach(function(key) {
    var option = voteToOption(options, votes[key]);
    if (option) {
      counts[option] = (counts[option] || 0) + 1;
    }
  });

  var total = Object.keys(votes).length;
  payload.votes = votes;
  payload.voteTotal = total;
  payload.results = options.map(function(option) {
    var count = counts[option] || 0;
    return {
      option: option,
      count: count,
      percent: total ? Math.round((count / total) * 100) : 0
    };
  });
  return payload;
}

function pollPayload(message) {
  var content = contentObject(message);
  var poll = content.pollCreationMessage || content.pollCreationMessageV3 || content.poll || content;
  var options = (poll.options || poll.selectableOptions || []).map(function(option) {
    if (typeof option === 'string') return option;
    return option.optionName || option.name || option.text || '';
  }).filter(Boolean);
  var title = firstTruthy([poll.name, message.name, getText(message), 'Enquete']);
  var payload = {
    title: title,
    options: options,
    selectableCount: Number(poll.selectableOptionsCount || poll.selectableCount || 0) || undefined
  };
  payload.preview = 'Enquete: ' + title;
  return applyPollVoteToPayload(payload);
}

function pollUpdatePayload(message) {
  var content = contentObject(message);
  var pollKey = content.pollCreationMessageKey || content.pollMessageKey || {};
  var vote = firstTruthy([
    message.vote,
    content.selectedOption,
    content.optionName,
    content.vote && content.vote.optionName,
    content.vote && content.vote.name,
    content.vote && content.vote.text
  ]);
  var payload = {
    pollMessageId: firstTruthy([message.quoted, pollKey.ID, pollKey.id, pollKey.messageid, pollKey.messageId]),
    vote: vote,
    voterId: firstTruthy([
      message.sender_pn,
      message.sender,
      message.sender_lid,
      message.participant,
      message.chatid,
      message.senderName
    ])
  };
  payload.preview = vote ? 'Voto em enquete: ' + vote : 'Atualizacao de enquete';
  return payload;
}

function eventPayload(message) {
  var content = contentObject(message);
  var location = content.location || {};
  var title = firstTruthy([content.name, message.name, getText(message), 'Evento']);
  var attendanceCount = Number(firstTruthy([
    content.attendanceCount,
    content.goingCount,
    content.confirmedCount,
    content.responseCount,
    message.attendanceCount,
    message.goingCount
  ])) || undefined;
  var payload = {
    title: title,
    description: firstTruthy([content.description, message.description]),
    locationName: firstTruthy([location.name, content.locationName, message.locationName]),
    latitude: location.degreesLatitude,
    longitude: location.degreesLongitude,
    startTime: content.startTime || message.startTime,
    isCanceled: Boolean(content.isCanceled || message.isCanceled)
  };
  if (attendanceCount || !payload.isCanceled) {
    payload.attendanceCount = attendanceCount || 1;
  }
  payload.preview = 'Evento: ' + title;
  return payload;
}

function getQuotedText(quotedMessage) {
  if (!quotedMessage) return '';
  if (typeof quotedMessage === 'string') return quotedMessage;
  if (quotedMessage.conversation) return quotedMessage.conversation;
  if (quotedMessage.extendedTextMessage && quotedMessage.extendedTextMessage.text) return quotedMessage.extendedTextMessage.text;
  if (quotedMessage.imageMessage) return quotedMessage.imageMessage.caption || '[imagem]';
  if (quotedMessage.videoMessage) return quotedMessage.videoMessage.caption || '[video]';
  if (quotedMessage.documentMessage) return quotedMessage.documentMessage.caption || quotedMessage.documentMessage.fileName || '[documento]';
  if (quotedMessage.audioMessage) return '[audio]';
  if (quotedMessage.stickerMessage) return '[sticker]';
  return '';
}

function sameJid(a, b) {
  if (!a || !b) return false;
  return String(a).split('@')[0] === String(b).split('@')[0];
}

function getQuoteSenderLabel(message, participant) {
  if (!participant) {
    return '';
  }

  var senderIds = [
    message.sender,
    message.sender_pn,
    message.sender_lid,
    message.participant,
    message.chatid
  ].filter(Boolean);

  for (var i = 0; i < senderIds.length; i++) {
    if (sameJid(participant, senderIds[i])) {
      return message.senderName || 'Contato';
    }
  }

  return 'Você';
}

function getQuote(message) {
  var content = message.content && typeof message.content === 'object' ? message.content : {};
  var contextInfo = content.contextInfo || message.contextInfo || {};
  var quotedMessage = contextInfo.quotedMessage || message.quotedMessage;
  var quotedId = message.quoted || contextInfo.stanzaID || contextInfo.quotedStanzaID || contextInfo.id || '';
  var quotedText = getQuotedText(quotedMessage);
  var participant = contextInfo.participant || message.quotedParticipant || '';

  if (!quotedId && !quotedText) {
    return null;
  }

  return {
    id: quotedId,
    text: quotedText,
    participant: participant,
    senderLabel: getQuoteSenderLabel(message, participant),
    type: contextInfo.quotedType !== undefined && contextInfo.quotedType !== null ? String(contextInfo.quotedType) : ''
  };
}

function encodeQuoteMarker(quote) {
  if (!quote || !quote.text) {
    return '';
  }
  return '[casezap-quote:' + Buffer.from(JSON.stringify(quote), 'utf8').toString('base64') + ']';
}

function applyQuoteMarker(text, quote) {
  if (typeof text === 'string' && text.indexOf('[casezap-quote:') === 0) {
    return text;
  }
  var marker = encodeQuoteMarker(quote);
  if (!marker) {
    return text || '';
  }
  return marker + '\n' + (text || '');
}

function stripQuoteMarker(text) {
  return typeof text === 'string' ? text.replace(/^\[casezap-(quote|contact|poll|event|audio):[A-Za-z0-9+/=]+\]\s*/, '') : '';
}

function mapInbound(webhookData) {
  var message = getMessage(webhookData || {});
  var chat = webhookData.chat || {};
  var chatid = message.chatid || chat.wa_chatid || '';
  var phone = extractPhone(chatid);
  var messageType = (message.messageType || message.type || '').toLowerCase();
  var senderName = message.senderName || chat.wa_name || chat.wa_contactName || '';
  var contactName = typeof chat.wa_contactName === 'string' ? chat.wa_contactName.trim() : '';
  var fromMe = Boolean(message.fromMe || (message.key && message.key.fromMe));

  var result = {
    messageId: message.messageid || message.id,
    phone: phone,
    leadId: 'casezap-' + phone,
    fullname: fromMe ? null : (senderName || phone),
    contactName: contactName,
    isSavedContact: Boolean(contactName),
    fromMe: fromMe,
    isGroup: message.isGroup || chat.wa_isGroup || chatid.includes('@g.us'),
    timestamp: message.messageTimestamp || Date.now(),
    text: null,
    type: 'text',
    metadata: null,
    quote: getQuote(message)
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
    case 'myaudio':
      result.type = 'file';
      result.text = applyStructuredMarker('audio', audioPayload(message));
      result.metadata = {
        src: getMediaUrl(message),
        type: getDocumentType(message),
        duration: audioPayload(message).duration,
        ptt: audioPayload(message).ptt
      };
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
      var stickerMimeType = getMediaMimeType(message);
      result.type = 'sticker';
      result.metadata = {
        src: getMediaUrl(message),
        type: stickerMimeType || 'image/webp'
      };
      if (stickerMimeType) {
        result.metadata.mimetype = stickerMimeType;
      }
      break;

    case 'locationmessage':
    case 'location':
      result.type = 'text';
      result.text = getText(message) + '\nhttps://maps.google.com/?q=' + (message.latitude || 0) + ',' + (message.longitude || 0);
      break;

    case 'contactmessage':
    case 'contact':
      result.type = 'text';
      result.metadata = { type: 'casezap/contact', contact: contactPayload(message) };
      result.text = applyStructuredMarker('contact', contactPayload(message));
      break;

    case 'pollcreationmessage':
    case 'poll':
      result.type = 'text';
      result.metadata = { type: 'casezap/poll', poll: pollPayload(message) };
      result.text = applyStructuredMarker('poll', pollPayload(message));
      break;

    case 'pollupdatemessage':
      result.type = 'casezap_poll_update';
      result.metadata = { type: 'casezap/poll_update', pollUpdate: pollUpdatePayload(message) };
      result.text = pollUpdatePayload(message).preview;
      break;

    case 'eventmessage':
    case 'event':
      result.type = 'text';
      result.metadata = { type: 'casezap/event', event: eventPayload(message) };
      result.text = applyStructuredMarker('event', eventPayload(message));
      break;

    case 'listmessage':
      result.type = 'text';
      result.text = getText(message) || 'Mensagem de lista';
      break;

    case 'listresponsemessage':
      result.type = 'text';
      result.text = firstTruthy([message.buttonOrListid, contentObject(message).buttonOrListid, getButtonText(message)]) || 'Resposta de lista';
      break;

    case 'buttonsmessage':
      result.type = 'text';
      result.text = getButtonText(message) || 'Mensagem com botões';
      break;

    case 'buttonsresponsemessage':
    case 'templatebuttonreplymessage':
      result.type = 'text';
      result.text = getButtonText(message) || 'Resposta de botão';
      break;

    case 'reactionmessage':
    case 'reaction':
      return null;

    default:
      result.type = 'text';
      result.text = getText(message) || '[' + messageType + ']';
      break;
  }

  result.text = applyQuoteMarker(result.text, result.quote);
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

  if (type === 'sticker') {
    var stickerFile = outboundMediaUrl();
    if (typeof stickerFile !== 'string' || !stickerFile.trim()) return null;
    var stickerMimeType = metadata.mimetype ||
      (typeof metadata.type === 'string' && metadata.type.indexOf('/') >= 0 ? metadata.type : null);
    return {
      endpoint: '/send/media',
      body: {
        number: number,
        file: stickerFile,
        type: 'sticker',
        ...(stickerMimeType ? { mimetype: stickerMimeType } : {})
      }
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

  if (type === 'file' || type === 'document' || metadata.type === 'document') {
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
    var documentFile = outboundMediaUrl();
    if (typeof documentFile !== 'string' || !documentFile.trim()) return null;
    return {
      endpoint: '/send/media',
      body: {
        number: number,
        file: documentFile,
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
  getText: getText,
  getQuote: getQuote,
  applyStructuredMarker: applyStructuredMarker,
  applyPollVoteToPayload: applyPollVoteToPayload,
  applyQuoteMarker: applyQuoteMarker,
  stripQuoteMarker: stripQuoteMarker
};
