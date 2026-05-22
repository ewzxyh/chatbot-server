var Project = require('../models/project');
var ProjectUser = require('../models/project_user');
var User = require('../models/user');
var emailService = require('../services/emailService');
var operationalLogger = require('./operationalLogger');
var SubscriptionPayment = require('../pubmodules/billing/models/subscription-payment');
var { getPlan } = require('../pubmodules/billing/plans');

var DAY_MS = 24 * 60 * 60 * 1000;
var DEFAULT_GRACE_DAYS = parseInt(process.env.BILLING_GRACE_DAYS || '3', 10);
var DEFAULT_BATCH_LIMIT = parseInt(process.env.BILLING_LIFECYCLE_BATCH_LIMIT || '100', 10);
var DEFAULT_SUSPEND_AFTER_DAYS = parseInt(process.env.BILLING_SUSPEND_AFTER_DAYS || '7', 10);
var DEFAULT_DOWNGRADE_AFTER_DAYS = parseInt(process.env.BILLING_DOWNGRADE_AFTER_DAYS || '30', 10);
var DEFAULT_NOTICE_INTERVAL_HOURS = parseInt(process.env.BILLING_DUNNING_NOTICE_INTERVAL_HOURS || '24', 10);
var DEFAULT_EXPIRING_NOTICE_DAYS = parseInt(process.env.BILLING_EXPIRING_NOTICE_DAYS || '3', 10);

var ACTION_EVENT_TYPES = {
  suspend: 'billing.lifecycle.suspended',
  reactivate: 'billing.lifecycle.reactivated',
  mark_past_due: 'billing.lifecycle.past_due',
  downgrade_to_free: 'billing.lifecycle.downgraded_to_free'
};

var NOTICE_EVENT_TYPES = {
  payment_failed: 'billing.lifecycle.notice.payment_failed',
  subscription_expiring: 'billing.lifecycle.notice.subscription_expiring',
  suspended: 'billing.lifecycle.notice.suspended',
  downgraded_to_free: 'billing.lifecycle.notice.downgraded_to_free'
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

function diffHoursFloor(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / (60 * 60 * 1000));
}

function boolEnv(name, fallback) {
  if (process.env[name] === undefined) return fallback;
  return process.env[name] === true || process.env[name] === 'true';
}

function parsePositiveInt(value, fallback) {
  var parsed = parseInt(value, 10);
  return isNaN(parsed) || parsed < 1 ? fallback : parsed;
}

function copyProfile(profile) {
  if (!profile) return {};
  if (typeof profile.toObject === 'function') return profile.toObject();
  return JSON.parse(JSON.stringify(profile));
}

function safeProjectId(project) {
  return project && project._id ? String(project._id) : undefined;
}

function getLifecycleConfig(options) {
  options = options || {};
  return {
    dryRun: options.dryRun !== undefined ? options.dryRun : boolEnv('BILLING_LIFECYCLE_DRY_RUN', true),
    batchLimit: parsePositiveInt(options.limit || process.env.BILLING_LIFECYCLE_BATCH_LIMIT, DEFAULT_BATCH_LIMIT),
    suspendAfterDays: parsePositiveInt(options.suspendAfterDays || process.env.BILLING_SUSPEND_AFTER_DAYS, DEFAULT_SUSPEND_AFTER_DAYS),
    downgradeAfterDays: parsePositiveInt(options.downgradeAfterDays || process.env.BILLING_DOWNGRADE_AFTER_DAYS, DEFAULT_DOWNGRADE_AFTER_DAYS),
    noticeIntervalHours: parsePositiveInt(options.noticeIntervalHours || process.env.BILLING_DUNNING_NOTICE_INTERVAL_HOURS, DEFAULT_NOTICE_INTERVAL_HOURS),
    expiringNoticeDays: parsePositiveInt(options.expiringNoticeDays || process.env.BILLING_EXPIRING_NOTICE_DAYS, DEFAULT_EXPIRING_NOTICE_DAYS),
    emailEnabled: options.emailEnabled !== undefined ? options.emailEnabled : boolEnv('BILLING_LIFECYCLE_EMAIL_ENABLED', true)
  };
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
  var ProjectUserModel = deps.ProjectUser || ProjectUser;
  var UserModel = deps.User || User;
  var PaymentModel = deps.SubscriptionPayment || SubscriptionPayment;
  var getPlanFn = deps.getPlan || getPlan;
  var email = deps.emailService || emailService;
  var logger = deps.operationalLogger || operationalLogger;
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

    if (subEnd) {
      daysUntilPeriodEnd = diffDaysFloor(now, subEnd);
      if (now.getTime() > subEnd.getTime()) {
        daysPastDue = diffDaysFloor(subEnd, now);
      }
    }

    if (explicitStatus === 'suspended') {
      status = 'suspended';
    } else if (explicitStatus === 'canceled') {
      status = 'canceled';
    } else if (profile.pendingPlan && profile.mandateId) {
      status = 'pending_authorization';
    } else if (isPaidPlan) {
      if (subEnd) {
        if (explicitStatus === 'past_due') {
          status = 'past_due';
          canUsePaidFeatures = accessEndsAt && now.getTime() <= accessEndsAt.getTime();
        } else if (now.getTime() <= subEnd.getTime()) {
          status = 'active';
          canUsePaidFeatures = true;
        } else if (accessEndsAt && now.getTime() <= accessEndsAt.getTime()) {
          status = 'grace_period';
          canUsePaidFeatures = true;
        } else {
          status = 'past_due';
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

  async function getLatestEvent(projectId, eventType) {
    if (!PaymentModel.findOne) return null;
    var query = PaymentModel.findOne({ project_id: projectId, event_type: eventType });
    if (query.sort) query = query.sort({ createdAt: -1 });
    if (query.lean) query = query.lean();
    if (query.exec) return await query.exec();
    return await query;
  }

  async function recentlyNotified(projectId, eventType, intervalHours) {
    var latest = await getLatestEvent(projectId, eventType);
    if (!latest || !latest.createdAt) return false;
    return diffHoursFloor(new Date(latest.createdAt), nowFn()) < intervalHours;
  }

  async function recordNotice(project, noticeType, summary, options, emailResult) {
    options = options || {};
    var eventType = NOTICE_EVENT_TYPES[noticeType] || 'billing.lifecycle.notice.' + noticeType;
    return PaymentModel.create({
      mandate_id: project.profile && project.profile.mandateId ? project.profile.mandateId : null,
      project_id: safeProjectId(project),
      user_id: options.userId || null,
      plan_name: summary.plan || (project.profile && project.profile.name),
      event_type: eventType,
      status: summary.status,
      provider: 'chatcase',
      object: {
        noticeType: noticeType,
        reason: options.reason || null,
        dryRun: false,
        summary: {
          status: summary.status,
          daysPastDue: summary.daysPastDue,
          daysUntilPeriodEnd: summary.daysUntilPeriodEnd,
          accessEndsAt: summary.accessEndsAt
        },
        email: emailResult || { status: 'not_sent' }
      }
    });
  }

  async function getProjectOwner(projectId) {
    if (!ProjectUserModel || !ProjectUserModel.findOne || !UserModel || !UserModel.findById) return null;
    var projectUser = await ProjectUserModel.findOne({ id_project: projectId, role: 'owner', status: 'active' });
    if (!projectUser || !projectUser.id_user) return null;
    return await UserModel.findById(projectUser.id_user);
  }

  async function sendLifecycleEmail(project, summary, noticeType, options) {
    options = options || {};
    if (!options.emailEnabled) return { status: 'disabled' };
    if (email && email.enabled === false && !deps.emailService) return { status: 'disabled' };
    if (!email || !email.sendBillingLifecycleEmail) return { status: 'skipped', reason: 'email_method_missing' };

    var owner = await getProjectOwner(safeProjectId(project));
    if (!owner || !owner.email) return { status: 'skipped', reason: 'owner_email_missing' };

    await email.sendBillingLifecycleEmail(owner.email, owner, project.name, {
      type: noticeType,
      status: summary.status,
      planName: summary.planDisplayName || summary.plan,
      daysPastDue: summary.daysPastDue,
      daysUntilPeriodEnd: summary.daysUntilPeriodEnd,
      accessEndsAt: summary.accessEndsAt,
      projectUrl: (email.baseUrl || '') + '/#/project/' + safeProjectId(project) + '/home'
    });

    return { status: 'sent', to: owner.email };
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

  async function findProjectsForSweep(limit) {
    var query = {
      status: 100,
      $or: [
        { 'profile.type': 'payment' },
        { 'profile.billingStatus': { $in: ['past_due', 'grace_period', 'suspended', 'pending_authorization'] } }
      ]
    };
    var q = ProjectModel.find(query);
    if (q.sort) q = q.sort({ updatedAt: 1 });
    if (q.limit) q = q.limit(limit);
    if (q.exec) return await q.exec();
    return await q;
  }

  function decideProjectPlan(summary, config) {
    if (!summary || !summary.isPaidPlan) return null;

    if ((summary.status === 'past_due' || summary.status === 'suspended') && summary.daysPastDue >= config.downgradeAfterDays) {
      return {
        kind: 'action',
        action: 'downgrade_to_free',
        reason: 'billing_overdue_' + summary.daysPastDue + '_days'
      };
    }

    if (summary.status === 'past_due' && summary.daysPastDue >= config.suspendAfterDays) {
      return {
        kind: 'action',
        action: 'suspend',
        reason: 'billing_overdue_' + summary.daysPastDue + '_days'
      };
    }

    if (summary.status === 'past_due' || summary.status === 'grace_period') {
      return {
        kind: 'notice',
        noticeType: 'payment_failed',
        reason: 'billing_overdue_' + summary.daysPastDue + '_days'
      };
    }

    if (summary.status === 'active' && summary.daysUntilPeriodEnd !== null && summary.daysUntilPeriodEnd >= 0 && summary.daysUntilPeriodEnd <= config.expiringNoticeDays) {
      return {
        kind: 'notice',
        noticeType: 'subscription_expiring',
        reason: 'billing_period_ends_in_' + summary.daysUntilPeriodEnd + '_days'
      };
    }

    return null;
  }

  async function executeProjectPlan(project, summary, plan, config, options) {
    var projectId = safeProjectId(project);
    var item = {
      projectId: projectId,
      projectName: project.name,
      beforeStatus: summary.status,
      plan: summary.plan,
      daysPastDue: summary.daysPastDue,
      daysUntilPeriodEnd: summary.daysUntilPeriodEnd,
      planned: plan
    };

    if (!plan) {
      item.status = 'skipped';
      item.reason = 'no_action_needed';
      return item;
    }

    if (config.dryRun) {
      item.status = 'planned';
      return item;
    }

    if (plan.kind === 'action') {
      var actionResult = await applyAction(projectId, {
        action: plan.action,
        reason: plan.reason,
        userId: options.userId || 'billing-lifecycle-job'
      });
      item.status = 'applied';
      item.afterStatus = actionResult.summary.status;
      item.updated = actionResult.updated;

      var noticeType = plan.action === 'suspend' ? 'suspended' : (plan.action === 'downgrade_to_free' ? 'downgraded_to_free' : null);
      if (noticeType) {
        var emailResult = await sendLifecycleEmail(project, actionResult.summary, noticeType, config);
        item.email = emailResult;
      }

      return item;
    }

    if (plan.kind === 'notice') {
      var eventType = NOTICE_EVENT_TYPES[plan.noticeType] || 'billing.lifecycle.notice.' + plan.noticeType;
      if (await recentlyNotified(projectId, eventType, config.noticeIntervalHours)) {
        item.status = 'skipped';
        item.reason = 'recent_notice';
        return item;
      }
      var noticeEmail = await sendLifecycleEmail(project, summary, plan.noticeType, config);
      await recordNotice(project, plan.noticeType, summary, { reason: plan.reason, userId: options.userId || 'billing-lifecycle-job' }, noticeEmail);
      item.status = 'notified';
      item.email = noticeEmail;
      return item;
    }

    item.status = 'skipped';
    item.reason = 'unknown_plan';
    return item;
  }

  async function runLifecycleSweep(options) {
    options = options || {};
    var startedAt = Date.now();
    var config = getLifecycleConfig(options);
    var projects = await findProjectsForSweep(config.batchLimit);
    var result = {
      generatedAt: nowFn(),
      dryRun: config.dryRun,
      config: config,
      scanned: projects.length,
      plannedActions: 0,
      plannedNotices: 0,
      actions: 0,
      notices: 0,
      skipped: 0,
      errors: 0,
      items: []
    };

    for (var i = 0; i < projects.length; i++) {
      var project = projects[i];
      try {
        var summary = summarizeProject(project);
        var plan = decideProjectPlan(summary, config);
        var item = await executeProjectPlan(project, summary, plan, config, options);
        result.items.push(item);
        if (item.status === 'planned' && item.planned && item.planned.kind === 'action') result.plannedActions += 1;
        else if (item.status === 'planned' && item.planned && item.planned.kind === 'notice') result.plannedNotices += 1;
        else if (item.status === 'applied') result.actions += 1;
        else if (item.status === 'notified') result.notices += 1;
        else result.skipped += 1;
      } catch (err) {
        result.errors += 1;
        result.items.push({
          projectId: safeProjectId(project),
          projectName: project && project.name,
          status: 'error',
          error: err.message
        });
        logger.recordSafe({
          level: 'error',
          area: 'billing',
          channel: 'system',
          id_project: safeProjectId(project),
          event: 'billing.lifecycle_sweep.project_failed',
          status: 'failed',
          error: err
        });
      }
    }

    result.durationMs = Date.now() - startedAt;
    logger.recordSafe({
      level: result.errors ? 'warn' : 'info',
      area: 'billing',
      channel: 'system',
      event: 'billing.lifecycle_sweep.completed',
      status: result.errors ? 'partial' : 'success',
      details: {
        dryRun: result.dryRun,
        scanned: result.scanned,
        plannedActions: result.plannedActions,
        plannedNotices: result.plannedNotices,
        actions: result.actions,
        notices: result.notices,
        skipped: result.skipped,
        errors: result.errors,
        durationMs: result.durationMs
      }
    });

    return result;
  }

  return {
    summarizeProject: summarizeProject,
    getProjectLifecycle: getProjectLifecycle,
    applyAction: applyAction,
    listEvents: listEvents,
    runLifecycleSweep: runLifecycleSweep,
    decideProjectPlan: decideProjectPlan,
    getLifecycleConfig: getLifecycleConfig
  };
}

module.exports = {
  createBillingLifecycleService: createBillingLifecycleService,
  getLifecycleConfig: getLifecycleConfig
};
