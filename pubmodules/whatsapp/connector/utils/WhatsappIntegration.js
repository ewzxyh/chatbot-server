function valueFromSettings(settings) {
  return {
    phone_number_id: settings.phone_number_id,
    waba_id: settings.waba_id || settings.business_account_id,
    phone_number: settings.phone_number,
    verified_name: settings.verified_name
  };
}

async function ensure(settings, apiUrl, httpClient) {
  const headers = { 'Authorization': 'JWT ' + settings.token };
  const value = valueFromSettings(settings);
  const instancesResponse = await httpClient.get(
    apiUrl + '/' + settings.project_id + '/integration/name/whatsapp/instances',
    { headers: headers }
  );
  const instances = Array.isArray(instancesResponse.data) ? instancesResponse.data : [];
  const existing = instances.find(function(instance) {
    return instance.value && instance.value.phone_number_id === value.phone_number_id;
  });
  if (existing) return existing;

  const response = await httpClient.post(
    apiUrl + '/' + settings.project_id + '/integration',
    { name: 'whatsapp', value: value },
    { headers: headers }
  );
  return response.data;
}

module.exports = {
  valueFromSettings: valueFromSettings,
  ensure: ensure
};
