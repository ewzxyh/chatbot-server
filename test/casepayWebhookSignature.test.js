process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';
process.env.CASEPAY_WEBHOOK_SECRET = 'REDACTED_SECRET';

var assert = require('assert');
var crypto = require('crypto');
var billingRouter = require('../pubmodules/billing');

function sign(payload) {
  return crypto.createHmac('sha256', process.env.CASEPAY_WEBHOOK_SECRET).update(payload).digest('hex');
}

describe('CasePay webhook signature', function() {
  it('validates the signature against the raw request body', function() {
    var rawBody = '{ "event": "automatic_pix_payment/completed", "eventId": "evt-1" }';
    var req = {
      headers: {
        'x-webhook-signature': 'sha256=' + sign(rawBody)
      },
      rawBody: rawBody,
      body: {
        event: 'automatic_pix_payment/completed',
        eventId: 'evt-1'
      }
    };

    assert.strictEqual(billingRouter._verifyWebhookSignature(req), true);
  });

  it('rejects a signature generated from a normalized JSON body when raw body differs', function() {
    var rawBody = '{ "event": "automatic_pix_payment/completed", "eventId": "evt-1" }';
    var normalized = JSON.stringify({
      event: 'automatic_pix_payment/completed',
      eventId: 'evt-1'
    });
    var req = {
      headers: {
        'x-webhook-signature': 'sha256=' + sign(normalized)
      },
      rawBody: rawBody,
      body: {
        event: 'automatic_pix_payment/completed',
        eventId: 'evt-1'
      }
    };

    assert.strictEqual(billingRouter._verifyWebhookSignature(req), false);
  });

  it('rejects missing and malformed signatures', function() {
    assert.strictEqual(billingRouter._verifyWebhookSignature({ headers: {}, rawBody: '{}' }), false);
    assert.strictEqual(billingRouter._verifyWebhookSignature({
      headers: { 'x-webhook-signature': 'sha256=not-hex' },
      rawBody: '{}'
    }), false);
  });
});
