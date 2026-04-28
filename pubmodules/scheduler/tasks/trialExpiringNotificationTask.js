const schedule = require('node-schedule');
const winston = require('../../../config/winston');
const Project = require('../../../models/project');
const Project_user = require('../../../models/project_user');
const User = require('../../../models/user');
const emailService = require('../../../services/emailService');

class TrialExpiringNotificationTask {
  constructor() {
    this.enabled = process.env.TRIAL_EXPIRING_NOTIFICATION_ENABLED || 'true';
    this.cronExp = process.env.TRIAL_EXPIRING_NOTIFICATION_CRON || '0 9 * * *';
    this.daysBeforeExpiry = parseInt(process.env.TRIAL_EXPIRING_NOTIFICATION_DAYS) || 3;
  }

  run() {
    if (this.enabled === 'true') {
      winston.info('TrialExpiringNotificationTask started with cron: ' + this.cronExp);
      this.scheduleTask();
    } else {
      winston.info('TrialExpiringNotificationTask disabled');
    }
  }

  scheduleTask() {
    var that = this;
    schedule.scheduleJob(this.cronExp, function() {
      winston.info('TrialExpiringNotificationTask running...');
      that.findExpiringTrials();
    });
  }

  async findExpiringTrials() {
    try {
      var projects = await Project.find({
        'profile.type': 'free',
        'profile.trialDays': { $exists: true },
        'profile.trialExpiringNotified': { $ne: true }
      }).lean();

      var now = new Date();
      var notified = 0;

      for (var i = 0; i < projects.length; i++) {
        var project = projects[i];
        var trialDays = project.profile.trialDays || 14;
        var createdAt = new Date(project.createdAt);
        var expiresAt = new Date(createdAt.getTime() + trialDays * 24 * 60 * 60 * 1000);
        var daysLeft = Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

        if (daysLeft === this.daysBeforeExpiry) {
          try {
            var ownerPU = await Project_user.findOne({ id_project: project._id, role: 'owner', status: 'active' });
            if (ownerPU) {
              var owner = await User.findById(ownerPU.id_user);
              if (owner && owner.email) {
                emailService.sendTrialExpiringEmail(owner.email, owner, project.name, daysLeft);
                await Project.findByIdAndUpdate(project._id, { $set: { 'profile.trialExpiringNotified': true } });
                notified++;
                winston.info('TrialExpiringNotificationTask: notified ' + owner.email + ' for project ' + project.name);
              }
            }
          } catch (err) {
            winston.error('TrialExpiringNotificationTask: error processing project ' + project._id, err);
          }
        }
      }

      winston.info('TrialExpiringNotificationTask: ' + notified + ' notifications sent');
    } catch (err) {
      winston.error('TrialExpiringNotificationTask error', err);
    }
  }
}

var task = new TrialExpiringNotificationTask();
module.exports = task;
