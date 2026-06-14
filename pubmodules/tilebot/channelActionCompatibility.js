const {
  createActionFallbackForChannel,
  normalizeChannel
} = require('../chatbotTemplates/chatcaseTemplates');

function firstString(values) {
  return values.find((value) => typeof value === 'string' && value.trim());
}

function detectConversationChannel(message, supportRequest) {
  const request = supportRequest || (message && message.request) || {};
  const attributes = request.attributes || {};
  const messageAttributes = message && message.attributes || {};
  const channel = request.channel || message && message.channel || {};
  const candidate = firstString([
    channel.name,
    channel.type,
    channel.provider,
    request.channel,
    request.provider,
    request.integration,
    attributes.channel,
    attributes.provider,
    attributes.source,
    attributes.integration,
    messageAttributes.channel,
    messageAttributes.provider,
    messageAttributes.source
  ]);
  const normalized = normalizeChannel(candidate);

  if (normalized.indexOf('casezap') > -1 || normalized.indexOf('uazapi') > -1) {
    return 'casezap';
  }

  if (normalized === 'waba' || normalized === 'whatsapp') {
    return normalized;
  }

  const markers = [
    request.createdBy,
    request.lead_id,
    request.request_id,
    message && message.sender,
    message && message.recipient
  ].filter(Boolean).map(String);

  if (markers.some((marker) => marker.indexOf('casezap-') > -1)) {
    return 'casezap';
  }

  return normalized || 'all';
}

function adaptDirectivesForChannel(directives, channel) {
  const normalizedChannel = normalizeChannel(channel);

  if (!Array.isArray(directives) || !normalizedChannel || normalizedChannel === 'all') {
    return directives;
  }

  return directives.map((directive) => {
    const action = directive && directive.action;
    const fallback = createActionFallbackForChannel(action, normalizedChannel);

    if (!fallback) {
      return directive;
    }

    return Object.assign({}, directive, {
      name: fallback._tdActionType,
      action: fallback
    });
  });
}

function installTilebotActionCompatibilityPatch() {
  const { DirectivesChatbotPlug } = require('@tiledesk/tiledesk-tybot-connector/tiledeskChatbotPlugs/DirectivesChatbotPlug');

  if (!DirectivesChatbotPlug || DirectivesChatbotPlug.__chatcaseActionCompatibilityPatched) {
    return false;
  }

  const originalProcessDirectives = DirectivesChatbotPlug.prototype.processDirectives;

  DirectivesChatbotPlug.prototype.processDirectives = function(theend) {
    const channel = detectConversationChannel(this.message, this.supportRequest);
    this.directives = adaptDirectivesForChannel(this.directives, channel);
    return originalProcessDirectives.call(this, theend);
  };

  DirectivesChatbotPlug.__chatcaseActionCompatibilityPatched = true;
  return true;
}

module.exports = {
  adaptDirectivesForChannel,
  detectConversationChannel,
  installTilebotActionCompatibilityPatch
};
