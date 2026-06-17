process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

var chai = require('chai');
var expect = chai.expect;
var operationalAlertNotifier = require('../services/operationalAlertNotifier');

function sampleAlert(overrides) {
  return Object.assign({
    key: 'queue_no_consumers:messages',
    type: 'queue_no_consumers',
    severity: 'critical',
    status: 'open',
    title: 'Fila sem consumers',
    message: 'messages tem mensagens e nenhum consumer',
    service: 'rabbitmq',
    queue: 'messages',
    channel: 'system',
    id_project: 'project-1',
    integrationId: 'integration-1',
    firstAt: new Date('2026-05-15T10:00:00.000Z'),
    lastAt: new Date('2026-05-15T10:05:00.000Z'),
    occurrences: 2,
    details: {
      token: 'secret-token',
      url: 'https://files.example.com/a.pdf?X-Amz-Signature=secret',
      messagesReady: 101
    }
  }, overrides || {});
}

describe('OperationalAlertNotifier', function() {
  it('sends critical alert webhooks with sanitized details', async function() {
    var calls = [];
    var env = {
      OPERATIONAL_ALERT_WEBHOOK_URL: 'https://alerts.example.com/hook',
      OPERATIONAL_ALERT_MIN_SEVERITY: 'critical'
    };

    var result = await operationalAlertNotifier.notify('alert.opened', sampleAlert(), {
      env: env,
      httpClient: {
        post: async function(url, body, options) {
          calls.push({ url: url, body: body, options: options });
          return { status: 202 };
        }
      }
    });

    expect(result.webhook.status).to.equal('sent');
    expect(result.webhook.httpStatus).to.equal(202);
    expect(calls).to.have.lengthOf(1);
    expect(calls[0].url).to.equal(env.OPERATIONAL_ALERT_WEBHOOK_URL);
    expect(calls[0].options.timeout).to.equal(5000);
    expect(calls[0].body.key).to.equal('queue_no_consumers:messages');
    expect(calls[0].body.details.token).to.equal('[Redacted]');
    expect(calls[0].body.details.url).to.equal('https://files.example.com/a.pdf?[Redacted query]');
  });

  it('does not notify warning alerts when minimum severity is critical', async function() {
    var calls = [];
    var env = {
      OPERATIONAL_ALERT_WEBHOOK_URL: 'https://alerts.example.com/hook',
      OPERATIONAL_ALERT_MIN_SEVERITY: 'critical'
    };

    var result = await operationalAlertNotifier.notify('alert.opened', sampleAlert({ severity: 'warning' }), {
      env: env,
      httpClient: {
        post: async function() {
          calls.push(true);
          return { status: 200 };
        }
      }
    });

    expect(calls).to.have.lengthOf(0);
    expect(result.webhook.status).to.equal('disabled');
  });

  it('sends email notifications to configured recipients', async function() {
    var sent = [];
    var env = {
      BRAND_NAME: 'ChatCase',
      OPERATIONAL_ALERT_EMAIL_ENABLED: 'true',
      OPERATIONAL_ALERT_EMAIL_TO: 'redacted@example.invalid;redacted@example.invalid',
      OPERATIONAL_ALERT_MIN_SEVERITY: 'critical'
    };

    var result = await operationalAlertNotifier.notify('alert.reopened', sampleAlert(), {
      env: env,
      emailService: {
        send: async function(mail) {
          sent.push(mail);
        }
      }
    });

    expect(result.email.status).to.equal('sent');
    expect(sent).to.have.lengthOf(1);
    expect(sent[0].to).to.equal('redacted@example.invalid,redacted@example.invalid');
    expect(sent[0].subject).to.contain('Alerta operacional critical');
    expect(sent[0].text).to.contain('Evento: alert.reopened');
  });

  it('does not send repeated still-open alerts by email unless email events opt in', async function() {
    var sent = [];
    var env = {
      BRAND_NAME: 'ChatCase',
      OPERATIONAL_ALERT_EMAIL_ENABLED: 'true',
      OPERATIONAL_ALERT_EMAIL_TO: 'redacted@example.invalid',
      OPERATIONAL_ALERT_EVENTS: 'alert.opened,alert.reopened,alert.still_open',
      OPERATIONAL_ALERT_MIN_SEVERITY: 'critical'
    };

    var result = await operationalAlertNotifier.notify('alert.still_open', sampleAlert(), {
      env: env,
      emailService: {
        send: async function(mail) {
          sent.push(mail);
        }
      }
    });

    expect(result.email.status).to.equal('disabled');
    expect(sent).to.have.lengthOf(0);
  });

  it('skips resolved alerts unless explicitly enabled', async function() {
    var calls = [];
    var env = {
      OPERATIONAL_ALERT_WEBHOOK_URL: 'https://alerts.example.com/hook',
      OPERATIONAL_ALERT_MIN_SEVERITY: 'critical',
      OPERATIONAL_ALERT_WEBHOOK_EVENTS: 'alert.opened,alert.resolved'
    };

    var result = await operationalAlertNotifier.notify('alert.resolved', sampleAlert(), {
      env: env,
      httpClient: {
        post: async function() {
          calls.push(true);
          return { status: 200 };
        }
      }
    });

    expect(calls).to.have.lengthOf(0);
    expect(result.webhook.status).to.equal('disabled');
  });

  it('records notification failures without throwing from notifySafe', async function() {
    var records = [];
    var warnings = [];
    var env = {
      OPERATIONAL_ALERT_WEBHOOK_URL: 'https://alerts.example.com/hook',
      OPERATIONAL_ALERT_MIN_SEVERITY: 'critical'
    };

    var result = await operationalAlertNotifier.notifySafe('alert.opened', sampleAlert(), {
      env: env,
      httpClient: {
        post: async function() {
          throw new Error('webhook down');
        }
      },
      logger: {
        recordSafe: function(event) {
          records.push(event);
        }
      },
      winston: {
        warn: function(message) {
          warnings.push(message);
        }
      }
    });

    expect(result.ok).to.equal(false);
    expect(result.error).to.contain('webhook down');
    expect(warnings).to.have.lengthOf(1);
    expect(records).to.have.lengthOf(1);
    expect(records[0].event).to.equal('operational.alert_notification.failed');
    expect(records[0].details.alertKey).to.equal('queue_no_consumers:messages');
  });
});
