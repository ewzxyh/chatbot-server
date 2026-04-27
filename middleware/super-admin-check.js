var winston = require('../config/winston');

var adminEmail = process.env.ADMIN_EMAIL || 'redacted@example.invalid';

module.exports = function superAdminCheck(req, res, next) {
  if (!req.user || req.user.email !== adminEmail) {
    winston.warn('Super-admin access denied for: ' + (req.user ? req.user.email : 'unauthenticated'));
    return res.status(403).json({ error: 'Super-admin access required' });
  }
  next();
};
