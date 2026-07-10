var STABLE_CAUSES = {
  provider_check_failed: true,
  disabled: true,
  not_configured: true,
  not_ready: true,
  mongo_not_ready: true,
  mongo_unavailable: true,
  redis_unavailable: true,
  rabbitmq_unavailable: true,
  storage_unavailable: true,
  storage_read_verification_failed: true,
  queue_backlog: true,
  queue_unacked: true,
  queue_no_consumers: true,
  upstream_timeout: true,
  provider_timeout: true,
  provider_unreachable: true,
  provider_status_unknown: true,
  provider_status_ok: true,
  provider_status_active: true,
  provider_status_connected: true,
  provider_status_open: true,
  provider_status_pending: true,
  provider_status_disconnected: true,
  provider_status_banned: true,
  provider_status_restricted: true,
  provider_not_connected: true,
  provider_not_logged_in: true,
  provider_cannot_send_new_messages: true,
  provider_message_capping_unavailable: true,
  provider_reachout_timelock: true,
  provider_quality_red: true,
  provider_quality_yellow: true,
  missing_casezap_domain: true,
  missing_casezap_token: true,
  missing_waba_id: true,
  missing_waba_phone_number_id: true,
  missing_waba_token: true,
  unsupported_channel: true,
  webhook_failure: true
};

function normalize(value) {
  if (value === undefined || value === null || value === '') return null;
  var candidate = String(value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(STABLE_CAUSES, candidate) ? candidate : null;
}

module.exports = {
  normalize: normalize
};
