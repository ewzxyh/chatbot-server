process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';
process.env.DISABLE_BACKGROUND_WORKERS = 'true';
process.env.CREATE_INITIAL_DATA = 'false';

var testId = process.pid + '-' + Date.now();
var emailPrefix = 'server-security-' + testId;
var adminEmail = emailPrefix + 'redacted@example.invalid';
var configuredSuperAdminEmail = emailPrefix + 'redacted@example.invalid';
var originalSuperAdminEmails = process.env.SUPER_ADMIN_EMAILS;
process.env.SUPER_ADMIN_EMAILS = [originalSuperAdminEmails, adminEmail, configuredSuperAdminEmail]
  .filter(Boolean)
  .join(',');

var chai = require('chai');
var chaiHttp = require('chai-http');
var crypto = require('crypto');
var mongoose = require('mongoose');
var TdCache = require('../utils/TdCache').TdCache;
var originalTdCacheConnect = TdCache.prototype.connect;
TdCache.prototype.connect = function(callback) {
  this.readyAt = new Date().toISOString();
  if (callback) callback();
  return Promise.resolve();
};
var server = require('../app');
TdCache.prototype.connect = originalTdCacheConnect;
var User = require('../models/user');
var Project_user = require('../models/project_user');
var PendingInvitation = require('../models/pending-invitation');
var authEvent = require('../event/authEvent');
var emailService = require('../services/emailService');
var pendingInvitationService = require('../services/pendingInvitationService');
var superAdminService = require('../services/superAdminService');
var userService = require('../services/userService');
var jwt = require('jsonwebtoken');

chai.use(chaiHttp);
var expect = chai.expect;

function PasswordResetRateLimitStub() {
  this.readyAt = new Date().toISOString();
  this.keys = new Map();
}

PasswordResetRateLimitStub.prototype.setNX = async function(key) {
  if (this.keys.has(key)) return false;
  this.keys.set(key, 1);
  return true;
};

PasswordResetRateLimitStub.prototype.incrementWithLimit = async function(key, limit) {
  var current = Number(this.keys.has(key) ? this.keys.get(key) : 0) + 1;
  this.keys.set(key, current);
  return current <= limit;
};

PasswordResetRateLimitStub.prototype.set = async function(key, value) {
  this.keys.set(key, value);
};

PasswordResetRateLimitStub.prototype.get = async function(key) {
  return this.keys.has(key) ? this.keys.get(key) : null;
};

PasswordResetRateLimitStub.prototype.del = async function(key) {
  this.keys.delete(key);
};

PasswordResetRateLimitStub.prototype.clear = function() {
  this.keys.clear();
};

function comparePassword(user, password) {
  return new Promise(function(resolve, reject) {
    user.comparePassword(password, function(err, matches) {
      if (err) return reject(err);
      resolve(matches);
    });
  });
}

describe('Server auth and sadmin user security', function() {
  this.timeout(20000);

  var password = 'SecurePwd123!';
  var newPassword = 'ChangedPwd123!';
  var admin;
  var regularUser;
  var configuredSuperAdmin;
  var resetUser;
  var userIds = [];
  var resetEmails = [];
  var rateLimit = new PasswordResetRateLimitStub();
  var originalRedisClient = server.get('redis_client');
  var originalResetEmail = emailService.sendPasswordResetRequestEmail;
  var originalChangedEmail = emailService.sendYourPswHasBeenChangedEmail;
  var originalVerifyEmail = emailService.sendVerifyEmailAddress;
  var originalWelcomeEmail = emailService.sendWelcomeEmail;

  function track(user) {
    userIds.push(user._id);
    return user;
  }

  async function createUser(label, firstName, lastName) {
    return track(await userService.signup(
      emailPrefix + '-' + label + '@email.com',
      password,
      firstName || 'Security',
      lastName === undefined ? 'User' : lastName
    ));
  }

  function postAs(email, credentialsPassword, body) {
    var request = chai.request(server).post('/sadmin/users');
    if (email) request.auth(email, credentialsPassword);
    return request.send(body);
  }

  function deleteAs(email, credentialsPassword, id) {
    var request = chai.request(server).delete('/sadmin/users/' + id);
    if (email) request.auth(email, credentialsPassword);
    return request.send();
  }

  before(async function() {
    await User.deleteMany({ email: new RegExp('^' + emailPrefix) });
    admin = track(await userService.signup(adminEmail, password, 'Security', 'Admin'));
    regularUser = await createUser('regular');
    configuredSuperAdmin = track(await userService.signup(
      configuredSuperAdminEmail,
      password,
      'Protected',
      'Admin'
    ));
    resetUser = await createUser('reset');

    server.set('redis_client', rateLimit);
    emailService.sendPasswordResetRequestEmail = async function(to, token) {
      resetEmails.push({ to: to, token: token });
    };
    emailService.sendYourPswHasBeenChangedEmail = async function() {};
    emailService.sendVerifyEmailAddress = async function() {};
    emailService.sendWelcomeEmail = async function() {};
  });

  beforeEach(function() {
    rateLimit.clear();
    resetEmails = [];
  });

  it('normalizes signup fields, accepts an empty lastname, and rejects passwords over 72 bytes without echoing them', async function() {
    var signupEmail = emailPrefix + 'redacted@example.invalid';
    var signup = await chai.request(server).post('/auth/signup').send({
      email: '  ' + signupEmail.toUpperCase() + '  ',
      firstname: '  Signup  ',
      lastname: '',
      password: password,
      disableEmail: true
    });

    expect(signup).to.have.status(200);
    expect(signup.body.user.email).to.equal(signupEmail);
    expect(signup.body.user.firstname).to.equal('Signup');
    expect(signup.body.user.lastname).to.equal('');
    expect(signup.body.user).not.to.have.property('password');
    userIds.push(signup.body.user._id);

    var oversizedPassword = '\u00e9'.repeat(37);
    var rejected = await chai.request(server).post('/auth/signup').send({
      email: emailPrefix + 'redacted@example.invalid',
      firstname: 'Oversized',
      lastname: '',
      password: REDACTED_SECRET
    });

    expect(rejected).to.have.status(422);
    expect(JSON.stringify(rejected.body)).not.to.contain(oversizedPassword);
  });

  it('rate limits public signup independently of recaptcha', async function() {
    var duplicate = await chai.request(server).post('/auth/signup').send({
      email: resetUser.email,
      firstname: 'Duplicate',
      lastname: '',
      password: password,
      disableEmail: true
    });
    expect(duplicate).to.have.status(403);

    var signupKey = Array.from(rateLimit.keys.keys()).find(function(key) {
      return key.indexOf('signup:ip:') === 0;
    });
    expect(signupKey).to.be.a('string');
    rateLimit.keys.set(signupKey, 10);

    var limited = await chai.request(server).post('/auth/signup').send({
      email: emailPrefix + 'redacted@example.invalid',
      firstname: 'Limited',
      lastname: '',
      password: password,
      disableEmail: true
    });
    expect(limited).to.have.status(429);
  });

  it('applies pending invitations only after the email address is verified', async function() {
    var invitedEmail = emailPrefix + 'redacted@example.invalid';
    var projectId = String(new mongoose.Types.ObjectId());
    var invitation = await PendingInvitation.create({
      email: invitedEmail,
      id_project: projectId,
      role: 'agent',
      createdBy: String(admin._id)
    });

    var signup = await chai.request(server).post('/auth/signup').send({
      email: invitedEmail,
      firstname: 'Invited',
      lastname: '',
      password: password
    });
    expect(signup).to.have.status(200);
    userIds.push(signup.body.user._id);
    expect(await Project_user.countDocuments({ id_user: signup.body.user._id })).to.equal(0);

    var verificationKey = Array.from(rateLimit.keys.keys()).find(function(key) {
      return key.indexOf('emailverify:verify-') === 0;
    });
    expect(verificationKey).to.be.a('string');
    var verificationCode = verificationKey.replace('emailverify:verify-', '');
    expect(verificationCode).to.match(/^[a-f0-9]{64}$/);

    var malformed = await chai.request(server)
      .put('/auth/verifyemail/' + signup.body.user._id + '/123456')
      .send({ emailverified: true });
    expect(malformed).to.have.status(401);

    var verified = await chai.request(server)
      .put('/auth/verifyemail/' + signup.body.user._id + '/' + verificationCode)
      .send({ emailverified: false, status: 0 });
    expect(verified).to.have.status(200);
    expect(verified.body.emailverified).to.equal(true);
    expect(verified.body.status).to.equal(100);
    expect(await Project_user.countDocuments({
      id_user: signup.body.user._id,
      id_project: projectId
    })).to.equal(1);
    expect(await PendingInvitation.countDocuments({ _id: invitation._id })).to.equal(0);

    var reused = await chai.request(server)
      .put('/auth/verifyemail/' + signup.body.user._id + '/' + verificationCode)
      .send({ emailverified: true });
    expect(reused).to.have.status(401);
  });

  it('retries pending invitation application without duplicating project membership', async function() {
    var invitedUser = await createUser('pending-invite-retry');
    var projectId = new mongoose.Types.ObjectId();
    await Project_user.create({
      id_project: projectId,
      id_user: invitedUser._id,
      role: 'agent',
      roleType: 1,
      createdBy: String(admin._id)
    });
    var invitation = await PendingInvitation.create({
      email: invitedUser.email,
      id_project: String(projectId),
      role: 'agent',
      createdBy: String(admin._id)
    });

    await pendingInvitationService.checkNewUserInPendingInvitationAndSavePrcjUser(
      invitedUser.email,
      invitedUser._id
    );

    expect(await Project_user.countDocuments({
      id_project: projectId,
      id_user: invitedUser._id
    })).to.equal(1);
    expect(await PendingInvitation.countDocuments({ _id: invitation._id })).to.equal(0);
  });

  it('validates the recaptcha v3 action, score, and hostname', async function() {
    var RecaptchaV3 = require('express-recaptcha').RecaptchaV3;
    var originalVerify = RecaptchaV3.prototype.verify;
    var recaptchaModulePath = require.resolve('../middleware/recaptcha');
    var originalEnvironment = {
      enabled: process.env.RECAPTCHA_ENABLED,
      key: process.env.RECAPTCHA_KEY,
      secret: process.env.RECAPTCHA_SECRET,
      action: process.env.RECAPTCHA_ACTION,
      score: process.env.RECAPTCHA_MIN_SCORE,
      hostnames: process.env.RECAPTCHA_HOSTNAMES
    };

    process.env.RECAPTCHA_ENABLED = 'true';
    process.env.RECAPTCHA_KEY = 'test-key';
    process.env.RECAPTCHA_SECRET = 'test-secret';
    process.env.RECAPTCHA_ACTION = 'submit';
    process.env.RECAPTCHA_MIN_SCORE = '0.7';
    process.env.RECAPTCHA_HOSTNAMES = 'chatcase.test';
    delete require.cache[recaptchaModulePath];
    var middleware = require('../middleware/recaptcha');

    async function verify(result) {
      RecaptchaV3.prototype.verify = function(_req, callback) { callback(null, result); };
      return new Promise(function(resolve) {
        var response = {
          statusCode: 200,
          status: function(statusCode) { this.statusCode = statusCode; return this; },
          send: function(body) { resolve({ status: this.statusCode, body: body }); }
        };
        middleware({ headers: { host: 'chatcase.test' }, hostname: 'chatcase.test' }, response, function() {
          resolve({ status: 200, next: true });
        });
      });
    }

    try {
      expect(await verify({ action: 'submit', score: 0.9, hostname: 'chatcase.test' }))
        .to.deep.equal({ status: 200, next: true });
      expect((await verify({ action: 'other', score: 0.9, hostname: 'chatcase.test' })).status).to.equal(403);
      expect((await verify({ action: 'submit', score: 0.4, hostname: 'chatcase.test' })).status).to.equal(403);
      expect((await verify({ action: 'submit', score: 0.9, hostname: 'other.test' })).status).to.equal(403);
    } finally {
      RecaptchaV3.prototype.verify = originalVerify;
      Object.keys(originalEnvironment).forEach(function(key) {
        var environmentName = {
          enabled: 'RECAPTCHA_ENABLED',
          key: 'RECAPTCHA_KEY',
          secret: 'REDACTED_SECRET',
          action: 'RECAPTCHA_ACTION',
          score: 'RECAPTCHA_MIN_SCORE',
          hostnames: 'RECAPTCHA_HOSTNAMES'
        }[key];
        if (originalEnvironment[key] === undefined) delete process.env[environmentName];
        else process.env[environmentName] = originalEnvironment[key];
      });
      delete require.cache[recaptchaModulePath];
    }
  });

  it('stores only a one-hour reset hash, returns uniform responses, rate limits, and consumes the token once', async function() {
    var requestedEvent;
    var changedEvent;
    var signedIn = await chai.request(server).post('/auth/signin').send({
      email: resetUser.email,
      password: password
    });
    expect(signedIn).to.have.status(200);
    var previousSessionToken = signedIn.body.token;
    expect(await chai.request(server).get('/users').set('Authorization', previousSessionToken)).to.have.status(200);

    authEvent.once('user.requestresetpassword', function(event) { requestedEvent = event; });
    var existing = await chai.request(server).put('/auth/requestresetpsw').send({ email: resetUser.email });
    var missing = await chai.request(server).put('/auth/requestresetpsw').send({
      email: emailPrefix + 'redacted@example.invalid'
    });

    expect(existing).to.have.status(200);
    expect(missing).to.have.status(200);
    expect(existing.body).to.deep.equal(missing.body);
    expect(resetEmails).to.have.length(1);

    var token = resetEmails[0].token;
    var tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    var stored = await User.findById(resetUser._id)
      .select('+password +resetpswrequestid +resetpswrequestexpires');

    expect(token).to.match(/^[a-f0-9]{64}$/);
    expect(stored.resetpswrequestid).to.equal(tokenHash);
    expect(stored.resetpswrequestid).not.to.equal(token);
    expect(stored.resetpswrequestexpires.getTime()).to.be.above(Date.now());
    expect(stored.resetpswrequestexpires.getTime()).to.be.at.most(Date.now() + 60 * 60 * 1000);
    expect(requestedEvent).to.deep.equal({ userId: String(resetUser._id), email: resetUser.email });

    var limited = await chai.request(server).put('/auth/requestresetpsw').send({ email: resetUser.email });
    expect(limited).to.have.status(429);

    var checked = await chai.request(server).get('/auth/checkpswresetkey/' + token);
    expect(checked).to.have.status(200);
    expect(checked.body).to.deep.equal({ success: true });

    var oversizedPassword = '\u00e9'.repeat(37);
    var invalidPassword = await chai.request(server).put('/auth/resetpsw/' + token).send({
      password: REDACTED_SECRET
    });
    expect(invalidPassword).to.have.status(422);
    expect(JSON.stringify(invalidPassword.body)).not.to.contain(oversizedPassword);

    authEvent.once('user.resetpassword', function(event) { changedEvent = event; });
    var reset = await chai.request(server).put('/auth/resetpsw/' + token).send({ password: newPassword });
    var reused = await chai.request(server).put('/auth/resetpsw/' + token).send({ password: password });

    expect(reset).to.have.status(200);
    expect(reset.body).to.deep.equal({ message: 'Password change successful' });
    expect(reused).to.have.status(404);
    expect(changedEvent).to.deep.equal({ userId: String(resetUser._id), email: resetUser.email });
    expect(await chai.request(server).get('/users').set('Authorization', previousSessionToken)).to.have.status(401);

    var signedInAgain = await chai.request(server).post('/auth/signin').send({
      email: resetUser.email,
      password: newPassword
    });
    expect(signedInAgain).to.have.status(200);
    expect(await chai.request(server).get('/users').set('Authorization', signedInAgain.body.token)).to.have.status(200);

    var responseText = JSON.stringify(reset.body);
    for (var secret of [resetUser.email, token, tokenHash, newPassword]) {
      expect(responseText).not.to.contain(secret);
    }

    stored = await User.findById(resetUser._id)
      .select('+password +resetpswrequestid +resetpswrequestexpires');
    expect(stored.resetpswrequestid).to.equal(undefined);
    expect(stored.resetpswrequestexpires).to.equal(undefined);
    expect(stored.sessionVersion).to.equal(1);
    expect(await comparePassword(stored, newPassword)).to.equal(true);
  });

  it('rejects expired reset tokens without leaking account data', async function() {
    var expiringUser = await createUser('expiring');
    await chai.request(server).put('/auth/requestresetpsw').send({ email: expiringUser.email });
    var token = resetEmails[0].token;

    await User.updateOne({ _id: expiringUser._id }, {
      resetpswrequestexpires: new Date(Date.now() - 1000)
    });

    var checked = await chai.request(server).get('/auth/checkpswresetkey/' + token);
    var reset = await chai.request(server).put('/auth/resetpsw/' + token).send({ password: newPassword });

    expect(checked).to.have.status(404);
    expect(reset).to.have.status(404);
    expect(JSON.stringify(checked.body)).not.to.contain(expiringUser.email);
    expect(JSON.stringify(reset.body)).not.to.contain(expiringUser.email);
  });

  it('limits password reset requests independently by source IP', async function() {
    for (var index = 0; index < 5; index++) {
      var allowed = await chai.request(server).put('/auth/requestresetpsw').send({
        email: emailPrefix + '-rate-' + index + '@email.com'
      });
      expect(allowed).to.have.status(200);
    }
    var limited = await chai.request(server).put('/auth/requestresetpsw').send({
      email: emailPrefix + 'redacted@example.invalid'
    });
    expect(limited).to.have.status(429);
  });

  it('rate limits password reset attempts before password hashing', async function() {
    var token = crypto.randomBytes(32).toString('hex');
    var missing = await chai.request(server).put('/auth/resetpsw/' + token).send({ password: newPassword });
    expect(missing).to.have.status(404);

    var tokenKey = Array.from(rateLimit.keys.keys()).find(function(key) {
      return key.indexOf('passwordreset:attempt:token:') === 0;
    });
    expect(tokenKey).to.be.a('string');
    rateLimit.keys.set(tokenKey, 5);

    var limited = await chai.request(server).put('/auth/resetpsw/' + token).send({ password: newPassword });
    expect(limited).to.have.status(429);
  });

  it('protects admin creation and returns a verified DTO with a bcrypt password', async function() {
    var body = {
      email: '  ' + (emailPrefix + 'redacted@example.invalid').toUpperCase() + '  ',
      firstname: '  Created  ',
      lastname: '',
      password: password
    };
    var unauthorized = await postAs(null, null, body);
    var forbidden = await postAs(regularUser.email, password, body);

    expect(unauthorized).to.have.status(401);
    expect(forbidden).to.have.status(403);

    var oversizedPassword = '\u00e9'.repeat(37);
    var invalid = await postAs(adminEmail, password, {
      email: emailPrefix + 'redacted@example.invalid',
      firstname: 'Invalid',
      password: REDACTED_SECRET
    });
    expect(invalid).to.have.status(400);
    expect(JSON.stringify(invalid.body)).not.to.contain(oversizedPassword);

    var created = await postAs(adminEmail, password, body);
    expect(created).to.have.status(201);
    expect(created.body.email).to.equal(emailPrefix + 'redacted@example.invalid');
    expect(created.body.firstname).to.equal('Created');
    expect(created.body.lastname).to.equal('');
    expect(created.body.emailverified).to.equal(true);
    expect(created.body).not.to.have.property('password');
    userIds.push(created.body._id);

    var stored = await User.findById(created.body._id).select('+password');
    expect(await comparePassword(stored, password)).to.equal(true);

    var duplicate = await postAs(adminEmail, password, body);
    expect(duplicate).to.have.status(409);
  });

  it('escapes special characters in the admin user search', async function() {
    var literal = await createUser('regex-literal', 'Needle.*Literal');
    await createUser('regex-wildcard', 'NeedleXYZLiteral');

    var response = await chai.request(server)
      .get('/sadmin/users?search=' + encodeURIComponent('Needle.*Literal'))
      .auth(adminEmail, password);

    expect(response).to.have.status(200);
    expect(response.body.count).to.equal(1);
    expect(response.body.data[0]._id).to.equal(String(literal._id));
  });

  it('blocks protected deletions and logically anonymizes an unlinked user', async function() {
    var linked = await createUser('linked');
    await Project_user.create({
      id_user: linked._id,
      status: 'disabled',
      trashed: true,
      createdBy: emailPrefix
    });
    var legacyLinked = await createUser('legacy-linked');
    await Project_user.create({
      uuid_user: String(legacyLinked._id),
      status: 'disabled',
      trashed: true,
      createdBy: emailPrefix
    });

    var target = await createUser('delete-target');
    var targetEmail = target.email;
    await User.updateOne({ _id: target._id }, {
      phone: '+1555' + String(Date.now()).slice(-7),
      description: 'Private description',
      public_email: targetEmail,
      public_website: 'https://example.com/private',
      authUrl: 'private-auth-url',
      attributes: { private: true },
      signedInAt: new Date(),
      resetpswrequestid: 'stored-reset-hash',
      resetpswrequestexpires: new Date(Date.now() + 10000)
    });

    var unauthorized = await deleteAs(null, null, target._id);
    var forbidden = await deleteAs(regularUser.email, password, target._id);
    expect(unauthorized).to.have.status(401);
    expect(forbidden).to.have.status(403);

    expect(await deleteAs(adminEmail, password, 'invalid-id')).to.have.status(400);
    expect(await deleteAs(adminEmail, password, new mongoose.Types.ObjectId())).to.have.status(404);
    expect(await deleteAs(adminEmail, password, admin._id)).to.have.status(409);
    expect(await deleteAs(adminEmail, password, configuredSuperAdmin._id)).to.have.status(409);
    expect(await deleteAs(adminEmail, password, linked._id)).to.have.status(409);
    expect(await deleteAs(adminEmail, password, legacyLinked._id)).to.have.status(409);

    var invalidationPayload;
    authEvent.once('user.cache.invalidate', function(payload) { invalidationPayload = payload; });
    var deleted = await deleteAs(adminEmail, password, target._id);
    expect(deleted).to.have.status(200);
    expect(deleted.body).to.deep.equal({ success: true });
    expect(invalidationPayload).to.deep.equal({ userId: String(target._id) });
    expect(await User.countDocuments({ _id: target._id })).to.equal(1);

    var stored = await User.findById(target._id)
      .select('+password +resetpswrequestid +resetpswrequestexpires');
    expect(stored.status).to.equal(0);
    expect(stored.email).not.to.equal(targetEmail);
    expect(stored.email).to.match(/@deleted\.invalid$/);
    expect(stored.firstname).to.equal('anonymized');
    expect(stored.lastname).to.equal('anonymized');
    expect(stored.emailverified).to.equal(false);
    expect(stored.phone).to.equal(undefined);
    expect(stored.description).to.equal(undefined);
    expect(stored.public_email).to.equal(undefined);
    expect(stored.public_website).to.equal(undefined);
    expect(stored.authUrl).to.equal(undefined);
    expect(stored.attributes).to.equal(undefined);
    expect(stored.signedInAt).to.equal(undefined);
    expect(stored.resetpswrequestid).to.equal(undefined);
    expect(stored.resetpswrequestexpires).to.equal(undefined);
    expect(await comparePassword(stored, password)).to.equal(false);
  });

  it('does not grant the legacy super-admin email when configuration is absent', function() {
    var originalAdminEmail = process.env.ADMIN_EMAIL;
    var originalExtraEmails = process.env.SUPER_ADMIN_EMAILS;
    delete process.env.ADMIN_EMAIL;
    delete process.env.SUPER_ADMIN_EMAILS;
    try {
      expect(superAdminService.isSuperAdminEmail('redacted@example.invalid')).to.equal(false);
    } finally {
      if (originalAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
      else process.env.ADMIN_EMAIL = originalAdminEmail;
      if (originalExtraEmails === undefined) delete process.env.SUPER_ADMIN_EMAILS;
      else process.env.SUPER_ADMIN_EMAILS = originalExtraEmails;
    }
  });

  it('includes the current session version in impersonation tokens', async function() {
    await User.updateOne({ _id: regularUser._id }, { sessionVersion: 2 });

    var response = await chai.request(server)
      .post('/sadmin/impersonation')
      .auth(adminEmail, password)
      .send({ targetType: 'user', targetId: String(regularUser._id) });

    expect(response).to.have.status(200);
    expect(response.body.user.sessionVersion).to.equal(2);
    var token = response.body.token.replace(/^JWT\s+/, '');
    expect(jwt.decode(token).sessionVersion).to.equal(2);
  });

  after(async function() {
    emailService.sendPasswordResetRequestEmail = originalResetEmail;
    emailService.sendYourPswHasBeenChangedEmail = originalChangedEmail;
    emailService.sendVerifyEmailAddress = originalVerifyEmail;
    emailService.sendWelcomeEmail = originalWelcomeEmail;
    server.set('redis_client', originalRedisClient);
    await Project_user.deleteMany({
      $or: [{ createdBy: emailPrefix }, { id_user: { $in: userIds } }]
    });
    await PendingInvitation.deleteMany({ createdBy: String(admin._id) });
    await User.deleteMany({ _id: { $in: userIds } });
    if (originalSuperAdminEmails === undefined) delete process.env.SUPER_ADMIN_EMAILS;
    else process.env.SUPER_ADMIN_EMAILS = originalSuperAdminEmails;
  });
});
