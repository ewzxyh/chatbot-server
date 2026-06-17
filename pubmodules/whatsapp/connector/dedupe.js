"use strict";

const Message = require("../../../models/message");

async function hasStoredWabaMessage(projectId, messageId, model) {
  if (!projectId || !messageId) return false;
  const MessageModel = model || Message;
  const existingMessage = await MessageModel.findOne({
    id_project: projectId,
    "attributes.wabaMessageId": String(messageId)
  }).select("_id").lean();
  return !!existingMessage;
}

function setWabaMessageId(tiledeskJsonMessage, messageId) {
  if (!tiledeskJsonMessage || !messageId) return;
  if (!tiledeskJsonMessage.attributes) tiledeskJsonMessage.attributes = {};
  tiledeskJsonMessage.attributes.wabaMessageId = String(messageId);
}

module.exports = {
  hasStoredWabaMessage,
  setWabaMessageId
};
