process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

var assert = require('assert');
var axios = require('axios');
var uazapiAccountService = require('../services/uazapiAccountService');
var sadminRouter = require('../routes/sadmin');

var SERVICE_METHODS = [
  'listAccounts',
  'createAccount',
  'updateAccount',
  'deleteAccount',
  'testAccount'
];

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function findRoute(path, method) {
  return sadminRouter.stack.find(function (layer) {
    return layer.route && layer.route.path === path && layer.route.methods[method];
  });
}

function routeHandler(path, method) {
  var route = findRoute(path, method);
  return route.route.stack[route.route.stack.length - 1].handle;
}

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    sent: false,
    set: function (name, value) {
      this.headers[name] = value;
      return this;
    },
    status: function (statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json: function (body) {
      this.body = body;
      return this;
    },
    send: function (body) {
      this.body = body;
      this.sent = true;
      return this;
    }
  };
}

describe('UAZAPI account proxy', function () {
  var originalApiKey;
  var originalBaseUrl;
  var originalAxiosRequest;
  var originalServiceMethods = {};

  before(function () {
    for (var i = 0; i < SERVICE_METHODS.length; i++) {
      var method = SERVICE_METHODS[i];
      originalServiceMethods[method] = uazapiAccountService[method];
    }
  });

  beforeEach(function () {
    originalApiKey = process.env.CASEZAP_API_KEY;
    originalBaseUrl = process.env.CASEZAP_API_URL;
    originalAxiosRequest = axios.request;
  });

  afterEach(function () {
    restoreEnv('CASEZAP_API_KEY', originalApiKey);
    restoreEnv('CASEZAP_API_URL', originalBaseUrl);
    axios.request = originalAxiosRequest;
    for (var i = 0; i < SERVICE_METHODS.length; i++) {
      var method = SERVICE_METHODS[i];
      uazapiAccountService[method] = originalServiceMethods[method];
    }
  });

  it('uses the configured Bearer auth, timeout, default base URL and no-store list request', async function () {
    process.env.CASEZAP_API_KEY = 'casezap-api-key';
    delete process.env.CASEZAP_API_URL;
    var receivedConfig;
    axios.request = async function (config) {
      receivedConfig = config;
      return { status: 200, data: [{ id: 'account-1' }] };
    };

    var result = await uazapiAccountService.listAccounts();

    assert.deepStrictEqual(result, { status: 200, data: [{ id: 'account-1' }] });
    assert.strictEqual(receivedConfig.method, 'GET');
    assert.strictEqual(receivedConfig.url, 'https://casezap.chatcase.com.br/api/internal/chatcase/uazapi-accounts');
    assert.strictEqual(receivedConfig.headers.Authorization, 'Bearer casezap-api-key');
    assert.strictEqual(receivedConfig.headers['Cache-Control'], 'no-store');
    assert.strictEqual(receivedConfig.timeout, 10000);
  });

  it('maps create, update, delete and test calls to the upstream contract', async function () {
    process.env.CASEZAP_API_KEY = 'casezap-api-key';
    process.env.CASEZAP_API_URL = 'https://casezap.example.com/';
    var requests = [];
    axios.request = async function (config) {
      requests.push(config);
      return { status: config.method === 'DELETE' ? 204 : 200, data: { ok: true } };
    };

    await uazapiAccountService.createAccount({
      name: 'Primary',
      subdomain: 'primary',
      adminToken: 'admin-secret',
      acceptsNewInstances: true,
      ignored: 'drop-me'
    });
    await uazapiAccountService.updateAccount('account/id', {
      name: 'Secondary',
      subdomain: 'secondary',
      acceptsNewInstances: false,
      ignored: 'drop-me'
    });
    await uazapiAccountService.deleteAccount('account/id');
    await uazapiAccountService.testAccount('account id');

    assert.strictEqual(requests[0].method, 'POST');
    assert.strictEqual(requests[0].url, 'https://casezap.example.com/api/internal/chatcase/uazapi-accounts');
    assert.deepStrictEqual(requests[0].data, {
      name: 'Primary',
      subdomain: 'primary',
      acceptsNewInstances: true,
      adminToken: 'admin-secret'
    });
    assert.strictEqual(requests[1].method, 'PUT');
    assert.strictEqual(requests[1].url, 'https://casezap.example.com/api/internal/chatcase/uazapi-accounts/account%2Fid');
    assert.deepStrictEqual(requests[1].data, {
      name: 'Secondary',
      subdomain: 'secondary',
      acceptsNewInstances: false
    });
    assert.strictEqual(requests[2].method, 'DELETE');
    assert.strictEqual(requests[2].url, 'https://casezap.example.com/api/internal/chatcase/uazapi-accounts/account%2Fid');
    assert.strictEqual(requests[2].data, undefined);
    assert.strictEqual(requests[3].method, 'POST');
    assert.strictEqual(requests[3].url, 'https://casezap.example.com/api/internal/chatcase/uazapi-accounts/account%20id/test');
    assert.strictEqual(requests[3].data, undefined);
  });

  it('sanitizes upstream failures and reports configuration and timeout errors safely', async function () {
    process.env.CASEZAP_API_KEY = 'casezap-api-key';
    axios.request = async function () {
      var error = new Error('Bearer casezap-api-key admin-secret');
      error.response = { status: 422, data: { adminToken: 'admin-secret' } };
      throw error;
    };

    await assert.rejects(uazapiAccountService.listAccounts(), function (error) {
      assert.strictEqual(error.code, 'uazapi_upstream_error');
      assert.strictEqual(error.statusCode, 422);
      assert.strictEqual(error.message, 'UAZAPI account service request failed');
      assert.strictEqual(error.stack.includes('casezap-api-key'), false);
      assert.strictEqual(error.stack.includes('admin-secret'), false);
      return true;
    });

    axios.request = async function () {
      var error = new Error('admin-secret');
      error.code = 'ECONNABORTED';
      throw error;
    };
    await assert.rejects(uazapiAccountService.listAccounts(), function (error) {
      assert.strictEqual(error.code, 'uazapi_upstream_timeout');
      assert.strictEqual(error.statusCode, 504);
      return true;
    });

    delete process.env.CASEZAP_API_KEY;
    await assert.rejects(uazapiAccountService.listAccounts(), function (error) {
      assert.strictEqual(error.code, 'uazapi_proxy_not_configured');
      assert.strictEqual(error.statusCode, 503);
      return true;
    });
  });

  it('protects every proxy route with the existing sadmin auth chain', function () {
    var statsRoute = findRoute('/stats', 'get');
    var expectedAuth = statsRoute.route.stack.slice(0, -1).map(function (layer) {
      return layer.handle;
    });
    var routes = [
      findRoute('/uazapi-accounts', 'get'),
      findRoute('/uazapi-accounts', 'post'),
      findRoute('/uazapi-accounts/:id', 'put'),
      findRoute('/uazapi-accounts/:id', 'delete'),
      findRoute('/uazapi-accounts/:id/test', 'post')
    ];

    for (var i = 0; i < routes.length; i++) {
      var routeAuth = routes[i].route.stack.slice(0, -1).map(function (layer) {
        return layer.handle;
      });
      assert.deepStrictEqual(routeAuth, expectedAuth);
    }
  });

  it('forwards route inputs and success statuses while keeping route errors sanitized', async function () {
    var calls = [];
    uazapiAccountService.listAccounts = async function () {
      return { status: 200, data: [{ id: 'account-1' }] };
    };
    uazapiAccountService.createAccount = async function (body) {
      calls.push(['create', body]);
      return { status: 201, data: { id: 'account-2' } };
    };
    uazapiAccountService.updateAccount = async function (id, body) {
      calls.push(['update', id, body]);
      return { status: 200, data: { id: id } };
    };
    uazapiAccountService.deleteAccount = async function (id) {
      calls.push(['delete', id]);
      return { status: 204 };
    };
    uazapiAccountService.testAccount = async function () {
      var error = new Error('Bearer route-secret admin-token');
      error.statusCode = 500;
      throw error;
    };

    var listRes = responseRecorder();
    await routeHandler('/uazapi-accounts', 'get')({}, listRes);
    assert.strictEqual(listRes.statusCode, 200);
    assert.deepStrictEqual(listRes.body, [{ id: 'account-1' }]);
    assert.strictEqual(listRes.headers['Cache-Control'], 'no-store');

    var createBody = { name: 'Primary' };
    var createRes = responseRecorder();
    await routeHandler('/uazapi-accounts', 'post')({ body: createBody }, createRes);
    assert.strictEqual(createRes.statusCode, 201);
    assert.deepStrictEqual(createRes.body, { id: 'account-2' });
    assert.strictEqual(createRes.headers['Cache-Control'], 'no-store');

    var updateBody = { name: 'Secondary' };
    var updateRes = responseRecorder();
    await routeHandler('/uazapi-accounts/:id', 'put')({ params: { id: 'account-2' }, body: updateBody }, updateRes);
    assert.strictEqual(updateRes.statusCode, 200);

    var deleteRes = responseRecorder();
    await routeHandler('/uazapi-accounts/:id', 'delete')({ params: { id: 'account-2' } }, deleteRes);
    assert.strictEqual(deleteRes.statusCode, 204);
    assert.strictEqual(deleteRes.sent, true);

    var testRes = responseRecorder();
    await routeHandler('/uazapi-accounts/:id/test', 'post')({ params: { id: 'account-2' } }, testRes);
    assert.strictEqual(testRes.statusCode, 500);
    assert.deepStrictEqual(testRes.body, {
      error: {
        code: 'uazapi_proxy_error',
        message: 'UAZAPI account proxy request failed'
      }
    });
    assert.strictEqual(JSON.stringify(testRes.body).includes('route-secret'), false);
    assert.strictEqual(JSON.stringify(testRes.body).includes('admin-token'), false);
    assert.deepStrictEqual(calls, [
      ['create', createBody],
      ['update', 'account-2', updateBody],
      ['delete', 'account-2']
    ]);
  });
});
