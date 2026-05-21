var Project = require('../models/project');
var SubscriptionPayment = require('../pubmodules/billing/models/subscription-payment');
var { getPlan } = require('../pubmodules/billing/plans');

var DAY_MS = 24 * 60 * 60 * 1000;
var DEFAULT_GRACE_DAYS = parseInt(process.env.BILLING_GRACE_DAYS || '3', 10);

var ACTION_EVENT_TYPES = {
  suspend: 'billing.lifecycle.suspended',
  reactivate: 'billing.lifecycle.reactivated',
  mark_past_due: 'billing.lifecycle.past_due',
  downgrade_to_free: 'billing.lifecycle.downgraded_to_free'
};

function asDate(value) {
  if (!value) return null;
  var date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return null;
  return date;
}

function addDays(date, days) {
  return new Date(date.getTime() + (days * DAY_MS));
}

function diffDaysFloor(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

function copyProfile(profile) {
  if (!profile) return {};
  if (typeof profile.toObject === 'function') return profile.toObject();
  return JSON.parse(JSON.stringify(profile));
}

function safeProjectId(project) {
  return project && project._id ? String(project._id) : undefined;
}

function buildPlanUpdate(plan, now, changedBy, reason) {
  return {
    'profile.name': plan.name,
    'profile.type': plan.type,
    'profile.agents': plan.agents,
    'profile.quotes': plan.quotes,
    'profile.customization': plan.customization,
    'profile.mandateId': null,
    'profile.pendingPlan': null,
    'profile.billingPeriod': null,
    'profile.subStart': null,
    'profile.subEnd': null,
    'profile.currentPeriodStart': null,
    'profile.currentPeriodEnd': null,
    'profile.billingStatus': 'free',
    'profile.billingStatusReason': reason || null,
    'profile.billingStatusChangedAt': now,
    'profile.billingStatusChangedBy': changedBy || null,
    'profile.suspendedAt': null,
    'profile.cancelAtPeriodEnd': false,
    'profile.downgradeScheduledTo': null,
    'profile.paymentFailureCount': 0,
    'profile.lastBillingEventAt': now
  };
}

function createBillingLifecycleService(deps) {
  deps = deps || {};
  var ProjectModel = deps.Project || Project;
  var PaymentModel = deps.SubscriptionPayment || SubscriptionPayment;
  var getPlanFn = deps.getPlan || getPlan;
  var nowFn = deps.now || function() { return new Date(); };
  var graceDays = deps.graceDays !== undefined ? deps.graceDays : DEFAULT_GRACE_DAYS;

  function summarizeProject(project) {
    var now = nowFn();
    var profile = project && project.profile ? project.profile : {};
    var plan = getPlanFn(profile.name || 'free');
    var subStart = asDate(profile.currentPeriodStart || profile.subStart);
    var currentPeriodEnd = asDate(profile.currentPeriodEnd);
    var legacyAccessEnd = currentPeriodEnd ? null : asDate(profile.subEnd);
    var subEnd = currentPeriodEnd || legacyAccessEnd;
    var accessEndsAt = currentPeriodEnd ? addDays(currentPeriodEnd, graceDays) : legacyAccessEnd;
    var explicitStatus = profile.billingStatus;
    var status = 'free';
    var canUsePaidFeatures = false;
    var daysUntilPeriodEnd = null;
    var daysPastDue = 0;
    var isPaidPlan = profile.type === 'payment';

    if (explicitStatus === 'suspended') {
      status = 'suspended';
    } else if (explicitStatus === 'canceled') {
      status = 'canceled';
    } else if (profile.pendingPlan && profile.mandateId) {
      status = 'pending_authorization';
    } else if (isPaidPlan) {
      if (subEnd) {
        daysUntilPeriodEnd = diffDaysFloor(now, subEnd);
        if (explicitStatus === 'past_due') {
          status = 'past_due';
          canUsePaidFeatures = accessEndsAt && now.getTime() <= accessEndsAt.getTime();
          daysPastDue = now.getTime() > subEnd.getTime() ? diffDaysFloor(subEnd, now) : 0;
        } else if (now.getTime() <= subEnd.getTime()) {
          status = 'active';
          canUsePaidFeatures = true;
        } else if (accessEndsAt && now.getTime() <= accessEndsAt.getTime()) {
          status = 'grace_period';
          canUsePaidFeatures = true;
          daysPastDue = diffDaysFloor(subEnd, now);
        } else {
          status = 'past_due';
          daysPastDue = diffDaysFloor(subEnd, now);
        }
      } else if (explicitStatus === 'active') {
        status = 'active';
        canUsePaidFeatures = true;
      } else {
        status = explicitStatus || 'past_due';
      }
    } else if (profile.name && profile.name !== 'Free' && profile.name !== 'free') {
      status = 'trialing';
    }

    if (status === 'suspended' || status === 'canceled') {
      canUsePaidFeatures = false;
    }

    return {
      projectId: safeProjectId(project),
      projectName: project ? project.name : undefined,
      status: status,
      plan: profile.name || plan.name,
      planDisplayName: plan.displayName || profile.name || plan.name,
      type: profile.type || plan.type,
      isPaidPlan: isPaidPlan,
      canUsePaidFeatures: canUsePaidFeatures,
      billingPeriod: profile.billingPeriod || null,
      mandateId: profile.mandateId || null,
      pendingPlan: profile.pendingPlan || null,
      subStart: subStart,
      subEnd: subEnd,
      accessEndsAt: accessEndsAt,
      daysUntilPeriodEnd: daysUntilPeriodEnd,
      daysPastDue: daysPastDue,
      paymentFailureCount: profile.paymentFailureCount || 0,
      billingStatusReason: profile.billingStatusReason || null,
      billingStatusChangedAt: profile.billingStatusChangedAt || null,
      suspendedAt: profile.suspendedAt || null,
      cancelAtPeriodEnd: profile.cancelAtPeriodEnd || false,
      downgradeScheduledTo: profile.downgradeScheduledTo || null
    };
  }

  async function recordEvent(project, action, options, beforeProfile, afterSummary) {
    var eventType = ACTION_EVENT_TYPES[action] || 'billing.lifecycle.' + action;
    await PaymentModel.create({
      mandate_id: project.profile && project.profile.mandateId ? project.profile.mandateId : null,
      project_id: safeProjectId(project),
      user_id: options.userId || null,
      plan_name: afterSummary.plan || (project.profile && project.profile.name),
      event_type: eventType,
      status: afterSummary.status,
      provider: 'chatcase',
      object: {
        action: action,
        reason: options.reason || null,
        triggeredBy: options.userId || null,
        beforeProfile: beforeProfile,
        afterStatus: afterSummary.status
      }
    });
  }

  async function listEvents(projectId, limit) {
    limit = limit || 50;
    return PaymentModel
      .find({ project_id: projectId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
  }

  async function getProjectLifecycle(projectId, options) {
    options = options || {};
    var project = await ProjectModel.findById(projectId);
    if (!project) {
      var notFound = new Error('Project not found');
      notFound.status = 404;
      throw notFound;
    }
    var summary = summarizeProject(project);
    var events = options.includeEvents === false ? [] : await listEvents(projectId, options.limit || 50);
    return { project: project, summary: summary, events: events };
  }

  async function applyAction(projectId, options) {
    options = options || {};
    var action = options.action;
    if (!ACTION_EVENT_TYPES[action]) {
      var invalid = new Error('Invalid billing lifecycle action');
      invalid.status = 400;
      throw invalid;
    }

    var project = await ProjectModel.findById(projectId);
    if (!project) {
      var notFound = new Error('Project not found');
      notFound.status = 404;
      throw notFound;
    }

    var now = nowFn();
    var beforeProfile = copyProfile(project.profile);
    var changedBy = options.userId || null;
    var reason = options.reason || null;
    var update = {};

    if (action === 'suspend') {
      update = {
        'profile.billingStatus': 'suspended',
        'profile.billingStatusReason': reason,
        'profile.billingStatusChangedAt': now,
        'profile.billingStatusChangedBy': changedBy,
        'profile.suspendedAt': now,
        'profile.lastBillingEventAt': now
      };
    }

    if (action === 'reactivate') {
      var nextStatus = project.profile && project.profile.type === 'payment' ? 'active' : 'free';
      update = {
        'profile.billingStatus': nextStatus,
        'profile.billingStatusReason': reason,
        'profile.billingStatusChangedAt': now,
        'profile.billingStatusChangedBy': changedBy,
        'profile.suspendedAt': null,
        'profile.lastBillingEventAt': now
      };
    }

    if (action === 'mark_past_due') {
      update = {
        'profile.billingStatus': 'past_due',
        'profile.billingStatusReason': reason,
        'profile.billingStatusChangedAt': now,
        'profile.billingStatusChangedBy': changedBy,
        'profile.paymentFailureCount': ((project.profile && project.profile.paymentFailureCount) || 0) + 1,
        'profile.lastBillingEventAt': now
      };
    }

    if (action === 'downgrade_to_free') {
      update = buildPlanUpdate(getPlanFn('free'), now, changedBy, reason);
    }

    var updatedProject = await ProjectModel.findByIdAndUpdate(projectId, { $set: update }, { new: true });
    updatedProject = updatedProject || project;
    var summary = summarizeProject(updatedProject);

    await recordEvent(updatedProject, action, options, beforeProfile, summary);

    return {
      summary: summary,
      updated: update
    };
  }

  return {
    summarizeProject: summarizeProject,
    getProjectLifecycle: getProjectLifecycle,
    applyAction: applyAction,
    listEvents: listEvents
  };
}

module.exports = {
  createBillingLifecycleService: createBillingLifecycleService
};
