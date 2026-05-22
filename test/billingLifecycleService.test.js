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
      event.createdAt = event.createdAt || new Date();
      events.push(event);
      return event;
    },
    findOne: function(query) {
      return {
        sort: function() { return this; },
        lean: function() { return this; },
        exec: async function() {
          return events
            .filter(function(event) {
              return event.project_id === query.project_id && event.event_type === query.event_type;
            })
            .sort(function(a, b) {
              return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
            })[0] || null;
        }
      };
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

function fakeProjectCollection(projects) {
  return {
    find: function() {
      return {
        sort: function() { return this; },
        limit: function() { return this; },
        exec: async function() { return projects; }
      };
    },
    findById: async function(id) {
      return projects.find(function(project) { return String(project._id) === String(id); }) || projects[0];
    },
    findByIdAndUpdate: async function(id, update) {
      var project = projects.find(function(item) { return String(item._id) === String(id); }) || projects[0];
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

function fakeOwnerModels() {
  return {
    ProjectUser: {
      findOne: async function() { return { id_user: 'owner-1' }; }
    },
    User: {
      findById: async function() { return { email: 'redacted@example.invalid', firstname: 'Owner' }; }
    }
  };
}

function fakeEmailService() {
  var service = {
    enabled: true,
    baseUrl: 'http://localhost:8081/dashboard',
    sent: [],
    sendBillingLifecycleEmail: async function(to, user, projectName, notice) {
      service.sent.push({ to: to, user: user, projectName: projectName, notice: notice });
    }
  };
  return service;
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

  it('dry-runs the automatic sweep without mutating overdue projects', async function() {
    var project = createProject({
      _id: 'project-sweep-dry-run',
      status: 100,
      profile: Object.assign({}, createProject().profile, {
        subEnd: new Date('2026-05-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-05-01T00:00:00.000Z'),
        billingStatus: 'past_due'
      })
    });
    var payments = fakePaymentModel();
    var service = billingLifecycleService.createBillingLifecycleService({
      Project: fakeProjectCollection([project]),
      SubscriptionPayment: payments,
      now: function() { return new Date('2026-05-10T12:00:00.000Z'); }
    });

    var result = await service.runLifecycleSweep({
      dryRun: true,
      suspendAfterDays: 7,
      downgradeAfterDays: 30
    });

    assert.strictEqual(result.scanned, 1);
    assert.strictEqual(result.plannedActions, 1);
    assert.strictEqual(result.actions, 0);
    assert.strictEqual(project.profile.billingStatus, 'past_due');
    assert.strictEqual(payments.events.length, 0);
    assert.strictEqual(result.items[0].planned.action, 'suspend');
  });

  it('suspends overdue projects during an automatic sweep and notifies the owner', async function() {
    var project = createProject({
      _id: 'project-sweep-suspend',
      status: 100,
      profile: Object.assign({}, createProject().profile, {
        subEnd: new Date('2026-05-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-05-01T00:00:00.000Z'),
        billingStatus: 'past_due'
      })
    });
    var payments = fakePaymentModel();
    var ownerModels = fakeOwnerModels();
    var mailer = fakeEmailService();
    var service = billingLifecycleService.createBillingLifecycleService({
      Project: fakeProjectCollection([project]),
      ProjectUser: ownerModels.ProjectUser,
      User: ownerModels.User,
      SubscriptionPayment: payments,
      emailService: mailer,
      now: function() { return new Date('2026-05-10T12:00:00.000Z'); }
    });

    var result = await service.runLifecycleSweep({
      dryRun: false,
      suspendAfterDays: 7,
      downgradeAfterDays: 30
    });

    assert.strictEqual(result.actions, 1);
    assert.strictEqual(project.profile.billingStatus, 'suspended');
    assert.strictEqual(payments.events[0].event_type, 'billing.lifecycle.suspended');
    assert.strictEqual(mailer.sent.length, 1);
    assert.strictEqual(mailer.sent[0].notice.type, 'suspended');
  });

  it('downgrades long overdue suspended projects to the free plan', async function() {
    var project = createProject({
      _id: 'project-sweep-downgrade',
      status: 100,
      profile: Object.assign({}, createProject().profile, {
        subEnd: new Date('2026-05-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-05-01T00:00:00.000Z'),
        billingStatus: 'suspended',
        suspendedAt: new Date('2026-05-09T00:00:00.000Z')
      })
    });
    var payments = fakePaymentModel();
    var ownerModels = fakeOwnerModels();
    var mailer = fakeEmailService();
    var service = billingLifecycleService.createBillingLifecycleService({
      Project: fakeProjectCollection([project]),
      ProjectUser: ownerModels.ProjectUser,
      User: ownerModels.User,
      SubscriptionPayment: payments,
      emailService: mailer,
      now: function() { return new Date('2026-06-05T12:00:00.000Z'); }
    });

    var result = await service.runLifecycleSweep({
      dryRun: false,
      suspendAfterDays: 7,
      downgradeAfterDays: 30
    });

    assert.strictEqual(result.actions, 1);
    assert.strictEqual(project.profile.name, 'Free');
    assert.strictEqual(project.profile.type, 'free');
    assert.strictEqual(project.profile.billingStatus, 'free');
    assert.strictEqual(payments.events[0].event_type, 'billing.lifecycle.downgraded_to_free');
    assert.strictEqual(mailer.sent[0].notice.type, 'downgraded_to_free');
  });
});
