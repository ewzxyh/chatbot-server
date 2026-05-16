var expect = require('chai').expect;
var sentryService = require('../services/sentryService');

describe('sentryService', function () {
  it('redacts sensitive request data before sending events', function () {
    var event = sentryService._private.beforeSend({
      message: 'Failed with token=abc123 for user redacted@example.invalid',
      request: {
        url: 'https://chatcase.test/api/files?token=abc123&path=uploads/private.pdf',
        query_string: 'token=abc123&path=uploads/private.pdf',
        headers: {
          authorization: 'Bearer abc123',
          cookie: 'session=secret',
          host: 'chatcase.test'
        },
        data: {
          message: 'hello',
          webhookSecret: 'secret-value'
        },
        cookies: {
          session: 'secret'
        }
      },
      extra: {
        phone: '+5511999999999',
        nested: {
          apiKey: 'secret-key',
          safe: 'ok'
        }
      }
    });

    expect(event.message).to.contain('[redacted]');
    expect(event.message).to.contain('[email]');
    expect(event.request.url).to.equal('https://chatcase.test/api/files');
    expect(event.request.query_string).to.equal('[redacted]');
    expect(event.request.headers.authorization).to.equal('[redacted]');
    expect(event.request.headers.cookie).to.equal('[redacted]');
    expect(event.request.data).to.equal(undefined);
    expect(event.request.cookies).to.equal(undefined);
    expect(event.extra.phone).to.equal('[redacted]');
    expect(event.extra.nested.apiKey).to.equal('[redacted]');
    expect(event.extra.nested.safe).to.equal('ok');
    expect(event.user).to.equal(undefined);
  });

  it('clamps trace sample rate values', function () {
    expect(sentryService._private.parseSampleRate('2', 0)).to.equal(1);
    expect(sentryService._private.parseSampleRate('-1', 0.5)).to.equal(0);
    expect(sentryService._private.parseSampleRate('bad', 0.25)).to.equal(0.25);
  });
});
