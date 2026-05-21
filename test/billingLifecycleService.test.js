process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

var assert = require('assert');
var billingLifecycleService = require('../services/billingLifecycleService');

function createProject(overrides) {
  return Object.assign({
    _id: 'project-1',
    name: 'Billing Lifecycle Project',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    profile: {
      name: 'Business',
      type: 'payment',
      agents: 10,
      quotes: {
        contacts: 50000,
        platforms: 5,
        members: 10,
        tokens: 10000000,
        email: 200
      },
      subStart: new Date('2026-05-01T00:00:00.000Z'),
      subEnd: new Date('2026-06-01T00:00:00.000Z'),
      billingStatus: 'active'
    }
  }, overrides || {});
}

function fakeProjectModel(project) {
  return {
    findById: async function() {
      return project;
    },
    findByIdAndUpdate: async function(id, update) {
      project.lastUpdate = update;
      Object.keys(update.$set || {}).forEach(function(key) {
        var parts = key.split('.');
        var target = project;
        for (var i = 0; i < parts.length - 1; i++) {
          target[parts[i]] = target[parts[i]] || {};
          target = target[parts[i]];
        }
        target[parts[parts.length - 1]] = update.$set[key];
      });
      return project;
    }
  };
}

function fakePaymentModel(events) {
  events = events || [];
  return {
    create: async function(event) {
      events.push(event);
      return event;
    },
    find: function() {
      return {
        sort: function() {
          return {
            limit: function() {
              return {
                lean: async function() {
                  return events;
                }
              };
            }
          };
        }
      };
    },
    events: events
  };
}

describe('billingLifecycleService', function() {
  it('returns grace_period while a paid subscription is inside the grace window', function() {
    var service = billingLifecycleService.createBillingLifecycleService({
      now: function() { return new Date('2026-06-03T00:00:00.000Z'); }
    });

    var summary = service.summarizeProject(createProject({
      profile: Object.assign({}, createProject().profile, {
        currentPeriodEnd: new Date('2026-06-01T00:00:00.000Z'),
        subEnd: new Date('2026-06-04T00:00:00.000Z')
      })
    }));

    assert.strictEqual(summary.status, 'grace_period');
    assert.strictEqual(summary.isPaidPlan, true);
    assert.strictEqual(summary.canUsePaidFeatures, true);
    assert.strictEqual(summary.daysPastDue, 2);
  });

  it('returns past_due after the grace window expires', function() {
    var service = billingLifecycleService.createBillingLifecycleService({
      now: function() { return new Date('2026-06-06T00:00:00.000Z'); }
    });

    var summary = service.summarizeProject(createProject());

    assert.strictEqual(summary.status, 'past_due');
    assert.strictEqual(summary.canUsePaidFeatures, false);
    assert.strictEqual(summary.daysPastDue, 5);
  });

  it('does not add a second grace window to legacy subEnd-only projects', function() {
    var service = billingLifecycleService.createBillingLifecycleService({
      now: function() { return new Date('2026-06-02T00:00:00.000Z'); }
    });

    var summary = service.summarizeProject(createProject({
      profile: {
        name: 'Business',
        type: 'payment',
        subStart: new Date('2026-05-01T00:00:00.000Z'),
        subEnd: new Date('2026-06-01T00:00:00.000Z'),
        billingStatus: 'active'
      }
    }));

    assert.strictEqual(summary.status, 'past_due');
    assert.strictEqual(summary.canUsePaidFeatures, false);
    assert.strictEqual(summary.accessEndsAt.toISOString(), '2026-06-01T00:00:00.000Z');
  });

  it('suspends a project without changing the paid plan and records an audit event', async function() {
    var project = createProject();
    var payments = fakePaymentModel();
    var service = billingLifecycleService.createBillingLifecycleService({
      Project: fakeProjectModel(project),
      SubscriptionPayment: payments,
      now: function() { return new Date('2026-05-20T12:00:00.000Z'); }
    });

    var result = await service.applyAction('project-1', {
      action: 'suspend',
      userId: 'redacted@example.invalid',
      reason: 'chargeback'
    });

    assert.strictEqual(result.summary.status, 'suspended');
    assert.strictEqual(project.profile.name, 'Business');
    assert.strictEqual(project.profile.type, 'payment');
    assert.strictEqual(project.profile.billingStatusReason, 'chargeback');
    assert.strictEqual(payments.events.length, 1);
    assert.strictEqual(payments.events[0].event_type, 'billing.lifecycle.suspended');
    assert.strictEqual(payments.events[0].provider, 'chatcase');
  });

  it('downgrades a project to the free plan and records the lifecycle event', async function() {
    var project = createProject();
    var payments = fakePaymentModel();
    var service = billingLifecycleService.createBillingLifecycleService({
      Project: fakeProjectModel(project),
      SubscriptionPayment: payments,
      now: function() { return new Date('2026-05-20T12:00:00.000Z'); }
    });

    var result = await service.applyAction('project-1', {
      action: 'downgrade_to_free',
      userId: 'redacted@example.invalid',
      reason: 'payment overdue'
    });

    assert.strictEqual(result.summary.status, 'free');
    assert.strictEqual(project.profile.name, 'Free');
    assert.strictEqual(project.profile.type, 'free');
    assert.strictEqual(project.profile.mandateId, null);
    assert.strictEqual(project.profile.billingPeriod, null);
    assert.strictEqual(payments.events.length, 1);
    assert.strictEqual(payments.events[0].event_type, 'billing.lifecycle.downgraded_to_free');
  });

  it('marks a project as past due and increments the failure count', async function() {
    var project = createProject({
      profile: Object.assign({}, createProject().profile, {
        paymentFailureCount: 1
      })
    });
    var payments = fakePaymentModel();
    var service = billingLifecycleService.createBillingLifecycleService({
      Project: fakeProjectModel(project),
      SubscriptionPayment: payments,
      now: function() { return new Date('2026-05-20T12:00:00.000Z'); }
    });

    var result = await service.applyAction('project-1', {
      action: 'mark_past_due',
      userId: 'redacted@example.invalid',
      reason: 'payment failed'
    });

    assert.strictEqual(result.summary.status, 'past_due');
    assert.strictEqual(result.summary.canUsePaidFeatures, true);
    assert.strictEqual(project.profile.billingStatus, 'past_due');
    assert.strictEqual(project.profile.paymentFailureCount, 2);
    assert.strictEqual(payments.events[0].event_type, 'billing.lifecycle.past_due');
  });

  it('reactivates a suspended paid project', async function() {
    var project = createProject({
      profile: Object.assign({}, createProject().profile, {
        billingStatus: 'suspended',
        suspendedAt: new Date('2026-05-19T00:00:00.000Z')
      })
    });
    var payments = fakePaymentModel();
    var service = billingLifecycleService.createBillingLifecycleService({
      Project: fakeProjectModel(project),
      SubscriptionPayment: payments,
      now: function() { return new Date('2026-05-20T12:00:00.000Z'); }
    });

    var result = await service.applyAction('project-1', {
      action: 'reactivate',
      userId: 'redacted@example.invalid',
      reason: 'payment ok'
    });

    assert.strictEqual(result.summary.status, 'active');
    assert.strictEqual(project.profile.billingStatus, 'active');
    assert.strictEqual(project.profile.suspendedAt, null);
    assert.strictEqual(payments.events[0].event_type, 'billing.lifecycle.reactivated');
  });
});
