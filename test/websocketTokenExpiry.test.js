process.env.LOG_LEVEL = 'critical';

var EventEmitter = require('events');
var fs = require('fs');
var path = require('path');
var expect = require('chai').expect;
var PubSub = require('../websocket/pubsub');

function wait(milliseconds) {
  return new Promise(function(resolve) { setTimeout(resolve, milliseconds); });
}

function createSocket() {
  var socket = new EventEmitter();
  socket.sent = [];
  socket.closed = [];
  socket.terminated = false;
  socket.send = function(message) { socket.sent.push(message); };
  socket.close = function(code, reason) {
    socket.closed.push({ code: code, reason: reason });
    socket.emit('close');
  };
  socket.terminate = function() {
    socket.terminated = true;
    socket.emit('close');
  };
  return socket;
}

describe('WebSocket token expiry', function() {
  this.timeout(5000);

  it('carries the verified JWT exp into the WebSocket request', function() {
    var source = fs.readFileSync(path.join(__dirname, '..', 'websocket', 'webSocketServer.js'), 'utf8');
    expect(source).to.include('info.req.jwtExp = decoded.exp;');
  });

  it('closes an existing connection when its token expires', async function() {
    var wss = new EventEmitter();
    var pubSub = new PubSub(wss, {});
    var socket = createSocket();
    var req = { jwtExp: Math.floor(Date.now() / 1000) + 1 };

    wss.emit('connection', socket, req);
    await wait(1100);

    expect(socket.closed).to.deep.equal([{ code: 1008, reason: 'Token expired' }]);
    expect(pubSub.clients.size).to.equal(0);
  });

  it('rejects message processing at or after exp', async function() {
    var callbackCount = 0;
    var wss = new EventEmitter();
    var pubSub = new PubSub(wss, {
      onMessage: async function() { callbackCount++; }
    });
    var socket = createSocket();
    var req = { jwtExp: Math.floor(Date.now() / 1000) + 60 };

    wss.emit('connection', socket, req);
    req.jwtExp = Math.floor(Date.now() / 1000) - 1;
    socket.emit('message', JSON.stringify({ action: 'heartbeat' }));
    await wait(20);

    expect(callbackCount).to.equal(0);
    expect(socket.closed).to.have.length(1);
    expect(pubSub.clients.size).to.equal(0);
  });

  it('does not expire connections for tokens without exp', async function() {
    var callbackCount = 0;
    var wss = new EventEmitter();
    var pubSub = new PubSub(wss, {
      onMessage: async function() { callbackCount++; }
    });
    var socket = createSocket();

    wss.emit('connection', socket, {});
    socket.emit('message', JSON.stringify({ action: 'heartbeat' }));
    await wait(20);

    expect(callbackCount).to.equal(1);
    expect(socket.closed).to.have.length(0);
    socket.emit('close');
    expect(pubSub.clients.size).to.equal(0);
  });
});
