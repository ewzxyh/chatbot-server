function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getSuperAdminEmails() {
  var emails = [];
  var adminEmail = process.env.ADMIN_EMAIL || 'redacted@example.invalid';
  if (adminEmail) {
    emails.push(adminEmail);
  }

  var extraEmails = process.env.SUPER_ADMIN_EMAILS || '';
  extraEmails.split(/[,\s;]+/).forEach(function(email) {
    if (email) {
      emails.push(email);
    }
  });

  return emails
    .map(normalizeEmail)
    .filter(Boolean)
    .filter(function(email, index, list) {
      return list.indexOf(email) === index;
    });
}

function isSuperAdminEmail(email) {
  var normalized = normalizeEmail(email);
  if (!normalized) return false;
  return getSuperAdminEmails().indexOf(normalized) !== -1;
}

module.exports = {
  getSuperAdminEmails: getSuperAdminEmails,
  isSuperAdminEmail: isSuperAdminEmail
};
