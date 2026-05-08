var mongoose = require('mongoose');
var Integration = require('../models/integrations');

const PLATFORM_CHANNELS = ['whatsapp', 'telegram', 'messenger', 'sms', 'voice', 'voice_twilio', 'casezap'];

function whatsappKeyFromValue(value, fallback) {
  if (!value) return fallback ? 'whatsapp:' + fallback : null;
  return 'whatsapp:' + (value.phone_number_id || value.waba_id || value.business_account_id || fallback);
}

function integrationPlatformKey(integration) {
  if (!integration) return null;
  if (integration.name === 'whatsapp') {
    return whatsappKeyFromValue(integration.value, integration._id ? integration._id.toString() : null);
  }
  return integration.name + ':' + (integration._id ? integration._id.toString() : 'new');
}

function whatsappSettingPlatformKey(setting) {
  if (!setting || !setting.value) return null;
  if (!setting.value.phone_number_id && !setting.value.waba_id && !setting.value.business_account_id) return null;
  return whatsappKeyFromValue(setting.value, setting.key || (setting._id ? setting._id.toString() : null));
}

async function getConnectedPlatformKeys(projectId) {
  const [integrations, whatsappSettings] = await Promise.all([
    Integration.find({ id_project: projectId, name: { $in: PLATFORM_CHANNELS } }).select('name value').lean(),
    mongoose.connection.collection('kvstore').find({
      project_id: projectId,
      key: /^whatsapp-/
    }).project({ key: 1, value: 1 }).toArray()
  ]);

  const keys = new Set();

  integrations.forEach(function(integration) {
    var key = integrationPlatformKey(integration);
    if (key) keys.add(key);
  });

  whatsappSettings.forEach(function(setting) {
    var key = whatsappSettingPlatformKey(setting);
    if (key) keys.add(key);
  });

  return keys;
}

async function countConnectedPlatforms(projectId) {
  const keys = await getConnectedPlatformKeys(projectId);
  return keys.size;
}

module.exports = {
  PLATFORM_CHANNELS,
  countConnectedPlatforms,
  getConnectedPlatformKeys,
  integrationPlatformKey
};
