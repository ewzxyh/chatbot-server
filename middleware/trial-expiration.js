var winston = require('../config/winston');
var Project = require('../models/project');
var { getPlan } = require('../pubmodules/billing/plans');

if (process.env.TRIAL_MODE_ENABLED !== 'true') {
  winston.warn('TRIAL_MODE_ENABLED is not "true" — trial expiration middleware will never trigger because trialExpired virtual always returns false.');
}

module.exports = function trialExpiration(req, res, next) {
  if (!req.project) return next();
  if (!req.preDecodedJwt) return next();
  if (req.project.profile.type === 'payment') return next();
  if (!req.project.trialExpired) return next();

  var freePlan = getPlan('free');

  if (req.project.profile.name === freePlan.name) return next();

  Project.findOneAndUpdate(
    {
      _id: req.project._id,
      'profile.type': { $ne: 'payment' }
    },
    {
      $set: {
        'profile.name': freePlan.name,
        'profile.type': freePlan.type,
        'profile.agents': freePlan.agents,
        'profile.quotes': freePlan.quotes,
        'profile.customization': freePlan.customization
      }
    },
    { new: true }
  ).then(function (updatedProject) {
    if (updatedProject) {
      winston.info('Trial expired for project ' + req.project._id + ', downgraded to Free');
      req.project = updatedProject;
    }
    return next();
  }).catch(function (err) {
    winston.error('Trial expiration middleware error', err);
    return next();
  });
};
