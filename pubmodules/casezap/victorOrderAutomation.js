'use strict';

var Request = require('../../models/request');

var ORDER_STATES = Object.freeze({
  COLLECTING_ORDER: 'collecting_order',
  AWAITING_QUOTE: 'awaiting_quote',
  AWAITING_ADDRESS: 'awaiting_address',
  AWAITING_RECEIPT: 'awaiting_receipt',
  RECEIPT_REVIEW: 'receipt_review'
});

var TRACK_SOURCE = 'chatcase-victor-automation';
var DEFAULT_VICTOR_NOTIFY_NUMBERS = ['556292174737', '556198820985'];
var DEFAULT_SHOPEE_URL = 'https://shopee.com.br/universal-link/product/1502208056/58262112206';
var DEFAULT_VICTOR_ORDER_STICKER_PATH = '/community/assets/casezap/victor-table-sticker-1.webp';
var GO_DF_DDDS = Object.freeze({ '61': true, '62': true, '64': true });
var GO_DF_FREE_FREIGHT_THRESHOLD_CENTS = 60000;
var OTHER_FREE_FREIGHT_THRESHOLD_CENTS = 100000;

function normalizeCaseZapPixKey(value) {
  if (value === undefined || value === null) return null;
  var normalized = String(value).trim().replace(/^['"]|['"]$/g, '').trim();
  if (!normalized || normalized === 'undefined' || normalized === 'null') return null;
  return normalized;
}

function configuredPixKey(value) {
  return normalizeCaseZapPixKey(value === undefined ? process.env.CASEZAP_PIX_KEY : value);
}

function configuredShopeeUrl(value) {
  var url = value === undefined ? process.env.CASEZAP_SHOPEE_URL : value;
  return String(url || DEFAULT_SHOPEE_URL).trim() || DEFAULT_SHOPEE_URL;
}

function configuredVictorOrderStickerUrl(value) {
  var configured = value === undefined ? process.env.CASEZAP_VICTOR_ORDER_STICKER_URL : value;
  if (configured) return String(configured).trim();
  var baseUrl = String(process.env.EXTERNAL_BASE_URL || 'https://chatcase-dev.69-6-250-104.sslip.io').replace(/\/+$/, '');
  return baseUrl + DEFAULT_VICTOR_ORDER_STICKER_PATH;
}

function normalizePhoneDigits(value) {
  var digits = String(value || '').replace(/\D/g, '');
  if (digits.indexOf('00') === 0) digits = digits.slice(2);
  if (digits.indexOf('55') === 0 && (digits.length === 12 || digits.length === 13)) digits = digits.slice(2);
  if (digits.indexOf('0') === 0 && (digits.length === 11 || digits.length === 12)) digits = digits.slice(1);
  return digits;
}

function extractPhoneDdd(value) {
  var digits = normalizePhoneDigits(value);
  return digits.length >= 10 ? digits.slice(0, 2) : null;
}

function classifyFreeFreight(amountCents, phone) {
  var ddd = extractPhoneDdd(phone);
  var goDf = Boolean(ddd && GO_DF_DDDS[ddd]);
  var thresholdCents = goDf ? GO_DF_FREE_FREIGHT_THRESHOLD_CENTS : OTHER_FREE_FREIGHT_THRESHOLD_CENTS;
  return {
    free: Number(amountCents) >= thresholdCents,
    ddd: ddd,
    region: goDf ? 'go_df' : 'other',
    thresholdCents: thresholdCents
  };
}

function containsConfiguredPixKey(text, pixKey) {
  if (typeof text !== 'string' || !pixKey) return false;
  return text.replace(/\s+/g, '').toLowerCase().indexOf(
    String(pixKey).replace(/\s+/g, '').toLowerCase()
  ) !== -1;
}

function parseAmountToken(token) {
  if (!token) return null;
  var value = String(token).replace(/\s/g, '');
  var integerPart;
  var decimalPart = '';

  if (value.indexOf(',') >= 0) {
    var commaParts = value.split(',');
    decimalPart = commaParts.pop();
    integerPart = commaParts.join('').replace(/\./g, '');
  } else if ((value.match(/\./g) || []).length === 1) {
    var dotParts = value.split('.');
    if (dotParts[1].length === 3) {
      integerPart = dotParts.join('');
    } else {
      integerPart = dotParts[0];
      decimalPart = dotParts[1];
    }
  } else {
    integerPart = value.replace(/\./g, '');
  }

  if (!/^\d+$/.test(integerPart || '') || !/^\d{0,2}$/.test(decimalPart)) return null;
  var cents = Number(integerPart) * 100 + Number((decimalPart || '').padEnd(2, '0') || 0);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function parsePixAmountCents(text, options) {
  options = options || {};
  if (typeof text !== 'string') return null;
  var pixIndex = text.search(/\bpix\b/i);
  if (pixIndex < 0 && !options.allowWithoutPix) return null;

  var amountPattern = '(\\d{1,3}(?:[.\\s]\\d{3})*(?:,\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
  var match = text.match(new RegExp('r\\$\\s*' + amountPattern, 'i')) ||
    text.match(new RegExp('(?:valor|pre[cç]o|preco)\\s*(?:e|é|=|:)?\\s*(?:r\\$\\s*)?' + amountPattern, 'i'));

  if (!match) {
    match = text.slice(pixIndex >= 0 ? pixIndex : 0).match(new RegExp(amountPattern, 'i'));
  }

  return match ? parseAmountToken(match[1]) : null;
}

function getNestedMessage(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.message && typeof value.message === 'object') return value.message;
  if (value.data && value.data.message && typeof value.data.message === 'object') return value.data.message;
  return value;
}

function readBoolean(value, field) {
  if (!value || typeof value !== 'object') return undefined;
  return typeof value[field] === 'boolean' ? value[field] : undefined;
}

function extractFromMe(value) {
  var message = getNestedMessage(value);
  var candidates = [value, message, message && message.key, value && value.data];
  for (var i = 0; i < candidates.length; i++) {
    var fromMe = readBoolean(candidates[i], 'fromMe');
    if (fromMe !== undefined) return fromMe;
  }
  return undefined;
}

function extractWasSentByApi(value) {
  var message = getNestedMessage(value);
  var candidates = [value, message, message && message.key, value && value.data];
  for (var i = 0; i < candidates.length; i++) {
    var wasSentByApi = readBoolean(candidates[i], 'wasSentByApi');
    if (wasSentByApi !== undefined) return wasSentByApi;
  }
  return undefined;
}

function isManualFromMe(value) {
  return extractFromMe(value) === true && extractWasSentByApi(value) === false;
}

function extractTrackId(value, mapped) {
  var message = getNestedMessage(value);
  var candidates = [
    value && value.track_id,
    value && value.trackId,
    message && message.track_id,
    message && message.trackId,
    message && message.attributes && message.attributes.track_id,
    mapped && mapped.track_id,
    mapped && mapped.trackId
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] !== undefined && candidates[i] !== null && String(candidates[i]).trim()) {
      return String(candidates[i]);
    }
  }
  return null;
}

function getOrderState(request) {
  return request && request.attributes && request.attributes.casezapOrder &&
    request.attributes.casezapOrder.state || null;
}

function getMessageText(message) {
  if (!message) return '';
  var parts = [message.text];
  var commands = message.attributes && message.attributes.commands;
  if (Array.isArray(commands)) {
    commands.forEach(function(command) {
      if (command && command.message && command.message.text) parts.push(command.message.text);
    });
  }
  return parts.filter(Boolean).join('\n');
}

function isVictorOrderPrompt(message) {
  var attributes = message && message.attributes || {};
  if (attributes.casezapOrderPrompt === true || attributes.casezapOrder && attributes.casezapOrder.prompt === true) {
    return true;
  }
  return /mande os produtos.{0,80}quantidades/i.test(getMessageText(message));
}

function isVictorHumanRequestPrompt(message) {
  var attributes = message && message.attributes || {};
  if (attributes.casezapHumanRequest === true) return true;
  var commands = attributes.commands;
  if (Array.isArray(commands) && commands.some(function(command) {
    return command && command.message && command.message.attributes && command.message.attributes.casezapHumanRequest === true;
  })) return true;
  return /vou chamar (?:o )?(?:vendedor|atendente|equipe)/i.test(getMessageText(message));
}

function isVictorOriginPrompt(message) {
  var text = getMessageText(message).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /vem de indicacao de alguem|como (?:voce )?me encontrou/.test(text);
}

function buildIdClauses(messageId, trackId) {
  var clauses = [];
  if (messageId) clauses.push({ 'attributes.casezapOrder.messageIds': { $ne: String(messageId) } });
  if (trackId) clauses.push({ 'attributes.casezapOrder.trackIds': { $ne: String(trackId) } });
  return clauses;
}

function buildIdUpdate(messageId, trackId) {
  var addToSet = {};
  if (messageId) addToSet['attributes.casezapOrder.messageIds'] = String(messageId);
  if (trackId) addToSet['attributes.casezapOrder.trackIds'] = String(trackId);
  return addToSet;
}

async function updateOrder(model, query, set, messageId, trackId, extraUpdate) {
  var update = { $set: set };
  var addToSet = buildIdUpdate(messageId, trackId);
  if (Object.keys(addToSet).length) update.$addToSet = addToSet;
  if (extraUpdate && extraUpdate.$push) update.$push = extraUpdate.$push;
  return model.findOneAndUpdate(query, update, { new: true, upsert: false });
}

async function markOrderPrompt(options) {
  options = options || {};
  if (!options.requestId || !options.projectId) return { status: 'skipped' };
  var model = options.model || Request;
  var query = {
    request_id: options.requestId,
    id_project: options.projectId,
    $or: [
      { 'attributes.casezapOrder.state': { $exists: false } },
      { 'attributes.casezapOrder.state': ORDER_STATES.COLLECTING_ORDER }
    ]
  };
  var idClauses = buildIdClauses(options.messageId, options.trackId);
  if (idClauses.length) query.$and = idClauses;
  var updated = await updateOrder(model, query, {
    'attributes.casezapOrder.state': ORDER_STATES.COLLECTING_ORDER
  }, options.messageId, options.trackId);
  return { status: updated ? 'updated' : 'skipped', request: updated || null };
}

async function claimHumanHandoff(options) {
  options = options || {};
  if (!options.requestId || !options.projectId) return null;
  var model = options.model || Request;
  return model.findOneAndUpdate({
    request_id: options.requestId,
    id_project: options.projectId,
    'attributes.casezapHumanNotified': { $ne: true }
  }, {
    $set: {
      'attributes.casezapHumanNotified': true,
      'attributes.casezapHumanNotifiedAt': new Date()
    }
  }, { new: true, upsert: false });
}

async function claimOriginPrompt(options) {
  options = options || {};
  if (!options.requestId || !options.projectId) return null;
  var model = options.model || Request;
  return model.findOneAndUpdate({
    request_id: options.requestId,
    id_project: options.projectId,
    'attributes.casezapOrigin': { $exists: false },
    'attributes.casezapOriginAwaiting': { $ne: true }
  }, {
    $set: { 'attributes.casezapOriginAwaiting': true }
  }, { new: true, upsert: false });
}

async function saveCustomerOrigin(options) {
  options = options || {};
  var text = String(options.text || '').trim();
  if (!options.requestId || !options.projectId || !text) return null;
  var model = options.model || Request;
  return model.findOneAndUpdate({
    request_id: options.requestId,
    id_project: options.projectId,
    'attributes.casezapOriginAwaiting': true,
    'attributes.casezapOrigin': { $exists: false }
  }, {
    $set: {
      'attributes.casezapOrigin': text,
      'attributes.casezapOriginAt': new Date(),
      'attributes.casezapOriginAwaiting': false
    }
  }, { new: true, upsert: false });
}

async function claimCustomerOrderMessage(options) {
  options = options || {};
  if (!options.requestId || !options.projectId || (!options.messageId && !options.trackId)) return null;
  var model = options.model || Request;
  var query = {
    request_id: options.requestId,
    id_project: options.projectId,
    'attributes.casezapOrder.state': { $in: [ORDER_STATES.COLLECTING_ORDER, ORDER_STATES.AWAITING_QUOTE] }
  };
  query.$and = buildIdClauses(options.messageId, options.trackId);
  var customerText = String(options.customerText || '').trim();
  return updateOrder(model, query, {
    'attributes.casezapOrder.state': ORDER_STATES.AWAITING_QUOTE
  }, options.messageId, options.trackId, customerText ? {
    $push: {
      'attributes.casezapOrder.customerMessages': {
        $each: [customerText],
        $slice: -20
      }
    }
  } : null);
}

async function claimVictorQuote(options) {
  options = options || {};
  if (!options.requestId || !options.projectId || (!options.messageId && !options.trackId)) return null;
  var model = options.model || Request;
  var query = {
    request_id: options.requestId,
    id_project: options.projectId,
    'attributes.casezapOrder.state': ORDER_STATES.AWAITING_QUOTE
  };
  query.$and = buildIdClauses(options.messageId, options.trackId);
  var freightRule = options.freightRule || {};
  var set = {
    'attributes.casezapOrder.state': options.nextState || ORDER_STATES.AWAITING_RECEIPT,
    'attributes.casezapOrder.quotedAmountCents': options.amountCents,
    'attributes.casezapOrder.quoteReview': 'manual',
    'attributes.casezapOrder.quoteMessageId': options.messageId ? String(options.messageId) : undefined
  };
  if (freightRule.free !== undefined) {
    set['attributes.casezapOrder.freeFreight'] = Boolean(freightRule.free);
    set['attributes.casezapOrder.freightRegion'] = freightRule.region || 'other';
    set['attributes.casezapOrder.freightDdd'] = freightRule.ddd || null;
    set['attributes.casezapOrder.freightThresholdCents'] = freightRule.thresholdCents;
  }
  return updateOrder(model, query, set, options.messageId, options.trackId);
}

function normalizeAddressText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function getAddressMissingFields(text) {
  var original = String(text || '');
  var normalized = normalizeAddressText(original);
  var withoutCep = normalized.replace(/\b\d{5}-?\d{3}\b/g, '');
  var missing = [];
  if (!/\b(?:rua|r\.?|avenida|av\.?|alameda|travessa|tv\.?|rodovia|estrada|praca|largo)\b/.test(normalized)) {
    missing.push('rua');
  }
  if (!/\b\d{1,5}\b/.test(withoutCep)) missing.push('número');
  if (!/\b(?:complemento|comp\.?|apto|apartamento|casa|bloco|lote|lt\.?|quadra|qd\.?|sala|fundos|edificio|predio|conjunto)\b/.test(normalized)) {
    missing.push('complemento');
  }
  if (!/\b\d{5}-?\d{3}\b/.test(original)) missing.push('CEP');
  return missing;
}

function validateCustomerAddress(messages) {
  var list = Array.isArray(messages) ? messages.filter(Boolean).map(String) : [];
  var text = list.join('\n');
  var missing = getAddressMissingFields(text);
  return { text: text, missing: missing, complete: missing.length === 0 };
}

async function claimCustomerAddress(options) {
  options = options || {};
  if (!options.requestId || !options.projectId || (!options.messageId && !options.trackId)) return null;
  var model = options.model || Request;
  var query = {
    request_id: options.requestId,
    id_project: options.projectId,
    'attributes.casezapOrder.state': ORDER_STATES.AWAITING_ADDRESS
  };
  var idClauses = buildIdClauses(options.messageId, options.trackId);
  if (idClauses.length) query.$and = idClauses;
  var set = {
    'attributes.casezapOrder.addressMissing': options.missing || []
  };
  if (options.complete) {
    set['attributes.casezapOrder.state'] = ORDER_STATES.AWAITING_RECEIPT;
    set['attributes.casezapOrder.addressText'] = options.addressText;
    set['attributes.casezapOrder.addressCompletedAt'] = new Date();
  }
  var customerText = String(options.customerText || '').trim();
  return updateOrder(model, query, set, options.messageId, options.trackId, customerText ? {
    $push: {
      'attributes.casezapOrder.addressMessages': {
        $each: [customerText],
        $slice: -20
      }
    }
  } : null);
}

async function claimAddressPrompt(options) {
  options = options || {};
  if (!options.requestId || !options.projectId) return null;
  var model = options.model || Request;
  return model.findOneAndUpdate({
    request_id: options.requestId,
    id_project: options.projectId,
    'attributes.casezapOrder.state': ORDER_STATES.AWAITING_ADDRESS,
    'attributes.casezapOrder.addressPromptSent': { $ne: true }
  }, {
    $set: {
      'attributes.casezapOrder.addressPromptSent': true,
      'attributes.casezapOrder.addressPromptSentAt': new Date()
    }
  }, { new: true, upsert: false });
}

async function claimReceipt(options) {
  options = options || {};
  if (!options.requestId || !options.projectId || (!options.messageId && !options.trackId)) return null;
  var model = options.model || Request;
  var query = {
    request_id: options.requestId,
    id_project: options.projectId,
    'attributes.casezapOrder.state': ORDER_STATES.AWAITING_RECEIPT
  };
  query.$and = buildIdClauses(options.messageId, options.trackId);
  return updateOrder(model, query, {
    'attributes.casezapOrder.state': ORDER_STATES.RECEIPT_REVIEW,
    'attributes.casezapOrder.receiptReview': 'manual',
    'attributes.casezapOrder.receiptMessageId': options.messageId ? String(options.messageId) : undefined
  }, options.messageId, options.trackId);
}

async function saveReceiptResult(options) {
  options = options || {};
  if (!options.requestId || !options.projectId) return null;
  var model = options.model || Request;
  var result = options.result || {};
  return model.findOneAndUpdate({
    request_id: options.requestId,
    id_project: options.projectId,
    'attributes.casezapOrder.state': ORDER_STATES.RECEIPT_REVIEW
  }, {
    $set: {
      'attributes.casezapOrder.receiptReview': 'manual',
      'attributes.casezapOrder.ocrStatus': result.status || 'manual',
      'attributes.casezapOrder.ocrReason': result.reason || null,
      'attributes.casezapOrder.ocrAmountsCents': Array.isArray(result.amountsCents) ? result.amountsCents : [],
      'attributes.casezapOrder.ocrAt': new Date()
    }
  }, { new: true, upsert: false });
}

function normalizeOcrResult(result) {
  result = result || {};
  return {
    status: result.status || 'manual',
    amountsCents: Array.isArray(result.amountsCents) ? result.amountsCents : [],
    text: result.text || '',
    reason: result.reason || null
  };
}

function formatAmountCents(amountCents) {
  return (Number(amountCents) / 100).toFixed(2).replace('.', ',');
}

function containsShopeeFlowText(value) {
  var text = String(value || '');
  return /https?:\/\/(?:www\.)?shopee\.com\.br/i.test(text) ||
    (/(?:shopee|shoope)/i.test(text) && /frete/i.test(text));
}

function buildVictorAutomationMessages(amountCents, pixKey, shopeeUrl) {
  if (!shopeeUrl) return [];

  return [
    { text: 'O frete é feito pela Shopee.', shopee: true },
    { text: shopeeUrl, shopee: true },
    { text: 'Aqui você paga o frete 👆', shopee: true },
    { text: 'Você compra esse item fictício e vale pelo frete.', shopee: true }
  ];
}

function buildVictorAutomationText(amountCents, pixKey, shopeeUrl) {
  return buildVictorAutomationMessages(amountCents, pixKey, shopeeUrl)
    .map(function(message) { return message.text; })
    .join('\n\n');
}

function buildFreeFreightMessages() {
  return [
    { text: 'Nessa compra você ganhou frete grátis 🆓', shopee: false },
    { text: 'Me manda o endereço de entrega completo, por favor: rua, número, complemento e CEP.', shopee: false }
  ];
}

function buildFreeFreightText() {
  return buildFreeFreightMessages()
    .map(function(message) { return message.text; })
    .join('\n\n');
}

function buildAddressRequestMessage(missing) {
  var fields = Array.isArray(missing) ? missing.filter(Boolean) : [];
  return fields.length
    ? 'Para completar, ainda preciso de: ' + fields.join(', ') + '.'
    : 'Me manda o endereço de entrega completo, por favor.';
}

function buildOrderNotification(options) {
  var messages = Array.isArray(options.messages) ? options.messages.filter(Boolean) : [];
  var orderText = messages.length ? messages.join('\n') : (options.text || '[sem texto]');
  var origin = options.origin ? '\nOrigem da indicação: ' + options.origin : '';
  return 'Novo pedido aguardando cotação. Cliente: ' + (options.name || options.phone || 'desconhecido') +
    ' (' + (options.phone || 'sem número') + ').' + origin + '\nPedido:\n' + orderText;
}

function buildQuoteNotification(options) {
  var message = 'Cotação enviada para o cliente ' + (options.phone || 'desconhecido') +
    ': R$ ' + formatAmountCents(options.amountCents) + '.';
  if (options.freeFreight) {
    return message + ' Frete grátis; aguardando endereço completo antes do comprovante.';
  }
  return message + ' Aguardando comprovante para conferência manual.';
}

function buildAddressNotification(options) {
  var customer = options.name ? options.name + ' (' + (options.phone || 'sem número') + ')' : (options.phone || 'desconhecido');
  var origin = options.origin ? ' Origem da indicação: ' + options.origin + '.' : '';
  return 'Endereço recebido do cliente ' + customer +
    ' para pedido de R$ ' + formatAmountCents(options.amountCents) +
    '. Frete grátis.' + origin + ' Endereço: ' + (options.addressText || '[sem texto]') +
    '. Aguardando comprovante para conferência manual.';
}

function buildHumanRequestNotification(options) {
  var origin = options.origin ? ' Origem da indicação: ' + options.origin + '.' : '';
  return 'Atendimento humano solicitado. Cliente: ' + (options.phone || 'desconhecido') +
    '.' + origin + ' Mensagem inicial: ' + (options.text || '[sem texto]');
}

function buildReceiptNotification(options) {
  var result = normalizeOcrResult(options.result);
  var amounts = result.amountsCents.map(formatAmountCents).join(', ');
  var detail = amounts ? ' valores R$ ' + amounts : '';
  var reason = result.reason ? ' Motivo: ' + result.reason : '';
  return 'Comprovante recebido para revisão manual. OCR: ' + result.status + detail + '.' + reason;
}

async function notifyVictorNumbers(options) {
  options = options || {};
  var numbers = options.numbers || DEFAULT_VICTOR_NOTIFY_NUMBERS;
  var sent = [];
  var seen = {};
  for (var i = 0; i < numbers.length; i++) {
    var number = String(numbers[i] || '').replace(/\D/g, '');
    if (!number || seen[number]) continue;
    seen[number] = true;
    if (typeof options.sendInternalMessage !== 'function') continue;
    try {
      var delivered = await options.sendInternalMessage(number, options.text);
      if (delivered !== false) sent.push(number);
    } catch (err) {
      if (typeof options.onNotificationError === 'function') options.onNotificationError(number, err);
    }
  }
  return sent;
}

function isReceiptMessage(mapped) {
  return Boolean(mapped && (mapped.type === 'image' || mapped.type === 'file'));
}

async function runReceiptOcr(options, media, expectedAmountCents) {
  var ocr = options.runReceiptOcr;
  if (!ocr) {
    try {
      ocr = require('./victorOcr').runReceiptOcr;
    } catch (err) {
      return { status: 'manual', amountsCents: [], text: '', reason: 'ocr_unavailable' };
    }
  }
  try {
    return normalizeOcrResult(await ocr({
      buffer: media.buffer,
      mimetype: media.mimetype || media.contentType || 'application/octet-stream',
      expectedAmountCents: expectedAmountCents
    }));
  } catch (err) {
    return { status: 'manual', amountsCents: [], text: '', reason: 'ocr_failed' };
  }
}

async function handleInboundMessage(options) {
  options = options || {};
  var request = options.request;
  var requestId = options.requestId || request && request.request_id;
  var projectId = options.projectId || request && request.id_project;
  var rawMessage = options.rawMessage;
  var fromMe = extractFromMe(rawMessage);
  var wasSentByApi = extractWasSentByApi(rawMessage);
  var messageId = options.messageId;
  var trackId = options.trackId || extractTrackId(rawMessage, options.mapped);
  var state = getOrderState(request);
  var instancePhone = String(options.instancePhone || '').replace(/\D/g, '');
  var mappedPhone = String(options.mapped && options.mapped.phone ||
    request && request.attributes && request.attributes.casezapPhone || '').replace(/\D/g, '');

  if (!requestId || !projectId || wasSentByApi === true) return { status: 'skipped' };
  if (instancePhone && mappedPhone && instancePhone === mappedPhone) return { status: 'skipped', reason: 'instance_notification' };

  if (fromMe === false && options.mapped && options.mapped.text) {
    try {
      await saveCustomerOrigin({
        model: options.model,
        requestId: requestId,
        projectId: projectId,
        text: options.mapped.text
      });
    } catch (err) {
      // The order path remains available if this optional context write fails.
    }
  }

  if (fromMe === true) {
    if (!isManualFromMe(rawMessage)) return { status: 'skipped', reason: 'not_manual' };
    if (state !== ORDER_STATES.AWAITING_QUOTE) return { status: 'skipped', reason: 'state' };
    var manualText = options.mapped && options.mapped.text || options.text || '';
    if (containsShopeeFlowText(manualText) && typeof options.claimShopeeFlow === 'function') {
      try {
        await options.claimShopeeFlow();
      } catch (err) {
        // Keep the quote path available if this optional guard write fails.
      }
    }
    var pixKey = configuredPixKey(options.pixKey);
    if (!pixKey) return { status: 'skipped', reason: 'pix_key_missing' };
    var quoteText = options.mapped && options.mapped.text || options.text || '';
    if (!containsConfiguredPixKey(quoteText, pixKey)) return { status: 'skipped', reason: 'pix_key_not_found' };
    var amountCents = parsePixAmountCents(quoteText, { allowWithoutPix: true });
    if (!amountCents) return { status: 'skipped', reason: 'pix_amount_missing' };

    var freightRule = classifyFreeFreight(amountCents, mappedPhone);
    var freeFreight = freightRule.free;

    var quote = await claimVictorQuote({
      model: options.model,
      requestId: requestId,
      projectId: projectId,
      messageId: messageId,
      trackId: trackId,
      amountCents: amountCents,
      nextState: freeFreight ? ORDER_STATES.AWAITING_ADDRESS : ORDER_STATES.AWAITING_RECEIPT,
      freightRule: freightRule
    });
    if (!quote) return { status: 'duplicate' };

    if (typeof options.sendAutomationMessage === 'function') {
      var automationMessages = freeFreight
        ? buildFreeFreightMessages()
        : buildVictorAutomationMessages(amountCents, pixKey, configuredShopeeUrl(options.shopeeUrl));
      await options.sendAutomationMessage({
        request: request,
        projectId: projectId,
        amountCents: amountCents,
        pixKey: pixKey,
        messages: automationMessages,
        text: automationMessages.map(function(message) { return message.text; }).join('\n\n'),
        stickerUrl: configuredVictorOrderStickerUrl(options.stickerUrl)
      });
    }
    await notifyVictorNumbers({
      numbers: options.notifyNumbers,
      text: buildQuoteNotification({
        phone: mappedPhone,
        amountCents: amountCents,
        freeFreight: freeFreight
      }),
      sendInternalMessage: options.sendInternalMessage
    });
    return { status: 'quoted', amountCents: amountCents, freeFreight: freeFreight, freightRule: freightRule };
  }

  if (fromMe !== false) return { status: 'skipped', reason: 'unknown_direction' };

  if (state === ORDER_STATES.AWAITING_ADDRESS) {
    var addressText = String(options.mapped && options.mapped.text || '').trim();
    if (!addressText) return { status: 'skipped', reason: 'address_text_missing' };
    var order = request && request.attributes && request.attributes.casezapOrder || {};
    var priorAddressMessages = Array.isArray(order.addressMessages) ? order.addressMessages : [];
    var addressValidation = validateCustomerAddress(priorAddressMessages.concat([addressText]));
    var address = await claimCustomerAddress({
      model: options.model,
      requestId: requestId,
      projectId: projectId,
      messageId: messageId,
      trackId: trackId,
      customerText: addressText,
      addressText: addressValidation.text,
      missing: addressValidation.missing,
      complete: addressValidation.complete
    });
    if (!address) return { status: 'duplicate' };

    if (!addressValidation.complete) {
      var addressPrompt = await claimAddressPrompt({
        model: options.model,
        requestId: requestId,
        projectId: projectId
      });
      if (addressPrompt && typeof options.sendAutomationMessage === 'function') {
        var promptText = buildAddressRequestMessage(addressValidation.missing);
        await options.sendAutomationMessage({
          request: request,
          projectId: projectId,
          messages: [{ text: promptText, shopee: false }],
          text: promptText
        });
      }
      return { status: 'awaiting_address', missing: addressValidation.missing };
    }

    var quotedAmount = order.quotedAmountCents;
    await notifyVictorNumbers({
      numbers: options.notifyNumbers,
      text: buildAddressNotification({
        phone: mappedPhone,
        amountCents: quotedAmount,
        name: options.mapped && (options.mapped.contactName || options.mapped.fullname),
        origin: request && request.attributes && request.attributes.casezapOrigin,
        addressText: addressValidation.text
      }),
      sendInternalMessage: options.sendInternalMessage
    });
    return { status: 'awaiting_receipt', address: addressValidation.text };
  }

  if (state === ORDER_STATES.AWAITING_RECEIPT && isReceiptMessage(options.mapped)) {
    var receipt = await claimReceipt({
      model: options.model,
      requestId: requestId,
      projectId: projectId,
      messageId: messageId,
      trackId: trackId
    });
    if (!receipt) return { status: 'duplicate' };

    var media = null;
    if (typeof options.loadMedia === 'function') {
      try {
        media = await options.loadMedia();
      } catch (err) {
        media = null;
      }
    }
    var quotedAmountCents = request && request.attributes && request.attributes.casezapOrder &&
      request.attributes.casezapOrder.quotedAmountCents;
    var ocrResult = media && media.buffer ? await runReceiptOcr(options, media, quotedAmountCents) : {
      status: 'manual',
      amountsCents: [],
      text: '',
      reason: 'media_unavailable'
    };
    await saveReceiptResult({
      model: options.model,
      requestId: requestId,
      projectId: projectId,
      result: ocrResult
    });
    await notifyVictorNumbers({
      numbers: options.notifyNumbers,
      text: buildReceiptNotification({ result: ocrResult, expectedAmountCents: quotedAmountCents }),
      sendInternalMessage: options.sendInternalMessage
    });
    return { status: 'receipt_review', result: ocrResult };
  }

  if (state === ORDER_STATES.COLLECTING_ORDER || state === ORDER_STATES.AWAITING_QUOTE) {
    var customerMessage = await claimCustomerOrderMessage({
      model: options.model,
      requestId: requestId,
      projectId: projectId,
      messageId: messageId,
      trackId: trackId,
      customerText: options.mapped && options.mapped.text
    });
    if (!customerMessage) return { status: 'duplicate' };
    await notifyVictorNumbers({
      numbers: options.notifyNumbers,
      text: buildOrderNotification({
        phone: options.mapped && options.mapped.phone,
        name: options.mapped && (options.mapped.contactName || options.mapped.fullname),
        origin: request && request.attributes && request.attributes.casezapOrigin,
        text: options.mapped && options.mapped.text,
        messages: customerMessage && customerMessage.attributes && customerMessage.attributes.casezapOrder &&
          customerMessage.attributes.casezapOrder.customerMessages
      }),
      sendInternalMessage: options.sendInternalMessage
    });
    return { status: 'awaiting_quote' };
  }

  return { status: 'skipped', reason: 'state' };
}

module.exports = {
  ORDER_STATES: ORDER_STATES,
  TRACK_SOURCE: TRACK_SOURCE,
  DEFAULT_VICTOR_NOTIFY_NUMBERS: DEFAULT_VICTOR_NOTIFY_NUMBERS,
  DEFAULT_SHOPEE_URL: DEFAULT_SHOPEE_URL,
  DEFAULT_VICTOR_ORDER_STICKER_PATH: DEFAULT_VICTOR_ORDER_STICKER_PATH,
  normalizeCaseZapPixKey: normalizeCaseZapPixKey,
  normalizePixKey: normalizeCaseZapPixKey,
  configuredPixKey: configuredPixKey,
  configuredShopeeUrl: configuredShopeeUrl,
  configuredVictorOrderStickerUrl: configuredVictorOrderStickerUrl,
  normalizePhoneDigits: normalizePhoneDigits,
  extractPhoneDdd: extractPhoneDdd,
  classifyFreeFreight: classifyFreeFreight,
  containsConfiguredPixKey: containsConfiguredPixKey,
  parsePixAmountCents: parsePixAmountCents,
  parsePixValueCents: parsePixAmountCents,
  extractFromMe: extractFromMe,
  extractWasSentByApi: extractWasSentByApi,
  isManualFromMe: isManualFromMe,
  extractTrackId: extractTrackId,
  getOrderState: getOrderState,
  isVictorOrderPrompt: isVictorOrderPrompt,
  isVictorHumanRequestPrompt: isVictorHumanRequestPrompt,
  isVictorOriginPrompt: isVictorOriginPrompt,
  markOrderPrompt: markOrderPrompt,
  claimHumanHandoff: claimHumanHandoff,
  claimOriginPrompt: claimOriginPrompt,
  saveCustomerOrigin: saveCustomerOrigin,
  claimCustomerOrderMessage: claimCustomerOrderMessage,
  claimVictorQuote: claimVictorQuote,
  claimCustomerAddress: claimCustomerAddress,
  claimAddressPrompt: claimAddressPrompt,
  claimReceipt: claimReceipt,
  saveReceiptResult: saveReceiptResult,
  containsShopeeFlowText: containsShopeeFlowText,
  buildVictorAutomationMessages: buildVictorAutomationMessages,
  buildVictorAutomationText: buildVictorAutomationText,
  buildFreeFreightMessages: buildFreeFreightMessages,
  buildFreeFreightText: buildFreeFreightText,
  buildAddressRequestMessage: buildAddressRequestMessage,
  buildOrderNotification: buildOrderNotification,
  buildQuoteNotification: buildQuoteNotification,
  buildAddressNotification: buildAddressNotification,
  buildHumanRequestNotification: buildHumanRequestNotification,
  buildReceiptNotification: buildReceiptNotification,
  notifyVictorNumbers: notifyVictorNumbers,
  isReceiptMessage: isReceiptMessage,
  handleInboundMessage: handleInboundMessage
};
