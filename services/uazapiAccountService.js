var axios = require('axios');

var DEFAULT_BASE_URL = 'https://casezap.chatcase.com.br';
var ACCOUNTS_PATH = '/api/internal/chatcase/uazapi-accounts';
var REQUEST_TIMEOUT_MS = 10000;

function createServiceError(code, message, statusCode) {
  var error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function buildAccountPayload(body) {
  body = body || {};
  var payload = {
    name: body.name,
    subdomain: body.subdomain,
    acceptsNewInstances: body.acceptsNewInstances
  };
  if (body.adminToken !== undefined) payload.adminToken = body.adminToken;
  return payload;
}

function buildRequestConfig(method, path, data) {
  var apiKey = process.env.CASEZAP_API_KEY;
  if (!apiKey) {
    throw createServiceError(
      'uazapi_proxy_not_configured',
      'UAZAPI account proxy is not configured',
      503
    );
  }

  var baseUrl = (process.env.CASEZAP_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  var headers = {
    Accept: 'application/json',
    Authorization: 'Bearer ' + apiKey
  };
  if (method === 'GET') headers['Cache-Control'] = 'no-store';
  if (data !== undefined) headers['Content-Type'] = 'application/json';

  var config = {
    method: method,
    url: baseUrl + path,
    headers: headers,
    timeout: REQUEST_TIMEOUT_MS
  };
  if (data !== undefined) config.data = data;
  return config;
}

function sanitizeRequestError(error) {
  if (error && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT')) {
    return createServiceError(
      'uazapi_upstream_timeout',
      'UAZAPI account service timed out',
      504
    );
  }

  var upstreamStatus = error && error.response && error.response.status;
  var statusCode = upstreamStatus >= 400 && upstreamStatus <= 599 ? upstreamStatus : 502;
  return createServiceError(
    'uazapi_upstream_error',
    'UAZAPI account service request failed',
    statusCode
  );
}

async function request(method, path, data) {
  var config = buildRequestConfig(method, path, data);
  try {
    var response = await axios.request(config);
    return {
      status: response.status,
      data: response.data
    };
  } catch (error) {
    throw sanitizeRequestError(error);
  }
}

function accountPath(id) {
  return ACCOUNTS_PATH + '/' + encodeURIComponent(id);
}

function listAccounts() {
  return request('GET', ACCOUNTS_PATH);
}

function createAccount(body) {
  return request('POST', ACCOUNTS_PATH, buildAccountPayload(body));
}

function updateAccount(id, body) {
  return request('PUT', accountPath(id), buildAccountPayload(body));
}

function deleteAccount(id) {
  return request('DELETE', accountPath(id));
}

function testAccount(id) {
  return request('POST', accountPath(id) + '/test');
}

module.exports = {
  listAccounts: listAccounts,
  createAccount: createAccount,
  updateAccount: updateAccount,
  deleteAccount: deleteAccount,
  testAccount: testAccount
};
