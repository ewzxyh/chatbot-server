var winston = require('../config/winston');
var superAdminService = require('../services/superAdminService');

module.exports = function superAdminCheck(req, res, next) {
  if (!req.user || !superAdminService.isSuperAdminEmail(req.user.email)) {
    winston.warn('Super-admin access denied for: ' + (req.user ? req.user.email : 'unauthenticated'));
    return res.status(403).json({ error: 'Super-admin access required' });
  }
  next();
};
