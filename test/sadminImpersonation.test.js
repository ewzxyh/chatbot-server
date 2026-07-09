process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';
process.env.DISABLE_BACKGROUND_WORKERS = 'true';
process.env.CREATE_INITIAL_DATA = 'false';
process.env.AUDIT_ENABLED = 'true';
process.env.MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017/tiledesk-test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tiledesk-test';

var testId = process.pid + '-' + Date.now();
var emailPrefix = 'impersonation-test-' + testId;
var phonePrefix = '+155' + String(Date.now()).slice(-8);
var adminEmail = emailPrefix + 'redacted@example.invalid';
var otherSuperAdminEmail = emailPrefix + 'redacted@example.invalid';
var projectJwtSecret = 'REDACTED_SECRET' + testId;
var originalSuperAdminEmails = process.env.SUPER_ADMIN_EMAILS;
process.env.SUPER_ADMIN_EMAILS = [originalSuperAdminEmails, adminEmail, otherSuperAdminEmail]
  .filter(Boolean)
  .join(',');

var chai = require('chai');
var chaiHttp = require('chai-http');
var jwt = require('jsonwebtoken');
var mongoose = require('mongoose');
var server = require('../app');
var User = require('../models/user');
var Project = require('../models/project');
var Project_user = require('../models/project_user');
var AuditEvent = require('../models/auditEvent');
var userService = require('../services/userService');

chai.use(chaiHttp);
var expect = chai.expect;

function postImpersonation(email, password, body) {
  var request = chai.request(server).post('/sadmin/impersonation');
  if (email) request.auth(email, password);
  return request.send(body || {});
}

async function waitForAudit(query) {
  for (var attempt = 0; attempt < 40; attempt++) {
    var event = await AuditEvent.findOne(query).sort({ timestamp: -1 }).lean();
    if (event) return event;
    await new Promise(function(resolve) { setTimeout(resolve, 50); });
  }
  throw new Error('Timed out waiting for audit event');
}

describe('Sadmin impersonation', function() {
  this.timeout(15000);

  var password = 'Pwd1234!';
  var admin;
  var regularUser;
  var targetUser;
  var otherSuperAdmin;
  var inactiveOwner;
  var activeOwner;
  var missingOwnerProject;
  var disabledOwnerProject;
  var inactiveUserProject;
  var inactiveProject;
  var superAdminOwnedProject;
  var mixedOwnerProject;
  var activeOwnerProject;

  before(async function() {
    await User.deleteMany({ email: new RegExp('^' + emailPrefix) });
    await Project.deleteMany({ createdBy: emailPrefix });

    admin = await userService.signup(adminEmail, password, 'Real', 'Admin', false, phonePrefix + '1');
    regularUser = await userService.signup(emailPrefix + 'redacted@example.invalid', password, 'Regular', 'User', false, phonePrefix + '2');
    targetUser = await userService.signup(emailPrefix + 'redacted@example.invalid', password, 'Target', 'User', false, phonePrefix + '3');
    otherSuperAdmin = await userService.signup(otherSuperAdminEmail, password, 'Other', 'Admin', false, phonePrefix + '4');
    inactiveOwner = await userService.signup(emailPrefix + 'redacted@example.invalid', password, 'Inactive', 'Owner', false, phonePrefix + '5');
    activeOwner = await userService.signup(emailPrefix + 'redacted@example.invalid', password, 'Active', 'Owner', false, phonePrefix + '6');
    await User.updateOne({ _id: inactiveOwner._id }, { status: 0 });
    await User.updateOne({ _id: targetUser._id }, {
      authUrl: 'private-auth-url',
      attributes: { private: true },
      description: 'Allowed description',
      public_email: 'redacted@example.invalid',
      public_website: 'https://example.com'
    });

    missingOwnerProject = await Project.create({ name: 'Missing owner', createdBy: emailPrefix });
    disabledOwnerProject = await Project.create({ name: 'Disabled owner', createdBy: emailPrefix });
    inactiveUserProject = await Project.create({ name: 'Inactive owner user', createdBy: emailPrefix });
    inactiveProject = await Project.create({ name: 'Inactive project', createdBy: emailPrefix, status: 0 });
    superAdminOwnedProject = await Project.create({ name: 'Superadmin owner', createdBy: emailPrefix });
    mixedOwnerProject = await Project.create({ name: 'Mixed owners', createdBy: emailPrefix });
    activeOwnerProject = await Project.create({
      name: 'Active owner',
      createdBy: emailPrefix,
      jwtSecret: REDACTED_SECRET
    });

    await Project_user.create({
      id_project: disabledOwnerProject._id,
      id_user: activeOwner._id,
      role: 'owner',
      status: 'disabled',
      createdBy: emailPrefix
    });
    await Project_user.create({
      id_project: inactiveUserProject._id,
      id_user: inactiveOwner._id,
      role: 'owner',
      status: 'active',
      createdBy: emailPrefix
    });
    await Project_user.create({
      id_project: inactiveProject._id,
      id_user: activeOwner._id,
      role: 'owner',
      status: 'active',
      createdBy: emailPrefix
    });
    await Project_user.create({
      id_project: superAdminOwnedProject._id,
      id_user: otherSuperAdmin._id,
      role: 'owner',
      status: 'active',
      createdBy: emailPrefix
    });
    await Project_user.create({
      id_project: mixedOwnerProject._id,
      id_user: admin._id,
      role: 'owner',
      status: 'active',
      createdBy: emailPrefix
    });
    await Project_user.create({
      id_project: mixedOwnerProject._id,
      id_user: otherSuperAdmin._id,
      role: 'owner',
      status: 'active',
      createdBy: emailPrefix
    });
    await Project_user.create({
      id_project: mixedOwnerProject._id,
      id_user: targetUser._id,
      role: 'owner',
      status: 'active',
      createdBy: emailPrefix
    });
    await Project_user.create({
      id_project: mixedOwnerProject._id,
      id_user: activeOwner._id,
      role: 'owner',
      status: 'active',
      createdBy: emailPrefix
    });
    await Project_user.create({
      id_project: activeOwnerProject._id,
      id_user: activeOwner._id,
      role: 'owner',
      status: 'active',
      createdBy: emailPrefix
    });
  });

  beforeEach(async function() {
    await AuditEvent.deleteMany({
      $or: [
        { 'actor.email': new RegExp('^' + emailPrefix) },
        { 'actor.impersonation.adminEmail': adminEmail },
        { action: 'admin.impersonation', 'metadata.body.targetId': { $in: [
          String(targetUser._id),
          String(activeOwnerProject._id)
        ] } }
      ]
    });
  });

  it('rejects unauthenticated and non-superadmin callers and audits both attempts', async function() {
    var body = { targetType: 'user', targetId: String(targetUser._id) };
    var unauthorized = await postImpersonation(null, null, body);
    var forbidden = await postImpersonation(regularUser.email, password, body);

    expect(unauthorized).to.have.status(401);
    expect(forbidden).to.have.status(403);

    var unauthorizedAudit = await waitForAudit({
      action: 'admin.impersonation',
      statusCode: 401,
      'metadata.body.targetId': body.targetId
    });
    var forbiddenAudit = await waitForAudit({
      action: 'admin.impersonation',
      statusCode: 403,
      'actor.email': regularUser.email
    });
    expect(unauthorizedAudit.success).to.equal(false);
    expect(forbiddenAudit.success).to.equal(false);
  });

  it('rejects invalid and unavailable targets', async function() {
    var invalid = await postImpersonation(adminEmail, password, {
      targetType: 'user',
      targetId: 'not-an-object-id'
    });
    var missing = await postImpersonation(adminEmail, password, {
      targetType: 'user',
      targetId: String(new mongoose.Types.ObjectId())
    });

    expect(invalid).to.have.status(400);
    expect(missing).to.have.status(404);
  });

  it('rejects self and every configured superadmin target', async function() {
    var self = await postImpersonation(adminEmail, password, {
      targetType: 'user',
      targetId: String(admin._id)
    });
    var configuredSuperAdmin = await postImpersonation(adminEmail, password, {
      targetType: 'user',
      targetId: String(otherSuperAdmin._id)
    });

    expect(self).to.have.status(403);
    expect(configuredSuperAdmin).to.have.status(403);
  });

  it('rejects inactive projects and projects with a missing, disabled, or inactive owner', async function() {
    var disabledMembership = await Project_user.findOne({
      id_project: disabledOwnerProject._id,
      id_user: activeOwner._id
    }).lean();
    expect(disabledMembership.status).to.equal('disabled');

    var missing = await postImpersonation(adminEmail, password, {
      targetType: 'project',
      targetId: String(missingOwnerProject._id)
    });
    var disabled = await postImpersonation(adminEmail, password, {
      targetType: 'project',
      targetId: String(disabledOwnerProject._id)
    });
    var inactive = await postImpersonation(adminEmail, password, {
      targetType: 'project',
      targetId: String(inactiveUserProject._id)
    });
    var unavailableProject = await postImpersonation(adminEmail, password, {
      targetType: 'project',
      targetId: String(inactiveProject._id)
    });

    expect(missing).to.have.status(409);
    expect(disabled).to.have.status(409);
    expect(inactive).to.have.status(409);
    expect(unavailableProject).to.have.status(404);
  });

  it('returns 409 when a project has no eligible owner', async function() {
    var response = await postImpersonation(adminEmail, password, {
      targetType: 'project',
      targetId: String(superAdminOwnedProject._id)
    });

    expect(response).to.have.status(409);
  });

  it('selects the stable first eligible owner from mixed active owners', async function() {
    var eligibleOwners = [targetUser, activeOwner].sort(function(left, right) {
      return String(left._id).localeCompare(String(right._id));
    });
    var response = await postImpersonation(adminEmail, password, {
      targetType: 'project',
      targetId: String(mixedOwnerProject._id)
    });

    expect(response).to.have.status(200);
    expect(response.body.user._id).to.equal(String(eligibleOwners[0]._id));
  });

  it('issues a 15-minute user token with explicit claims and no password', async function() {
    var response = await postImpersonation(adminEmail, password, {
      targetType: 'user',
      targetId: String(targetUser._id)
    });

    expect(response).to.have.status(200);
    expect(response.body.token).to.match(/^JWT /);
    expect(response.body.expiresIn).to.equal(900);
    expect(response.body.user._id).to.equal(String(targetUser._id));
    expect(response.body.user).not.to.have.property('password');
    expect(response.body.user).not.to.have.property('impersonation');
    expect(response.body.user).not.to.have.property('authUrl');
    expect(response.body.user).not.to.have.property('attributes');
    expect(response.body.user).not.to.have.property('phone');
    expect(response.body.user.description).to.equal('Allowed description');
    expect(response.body.user.public_email).to.equal('redacted@example.invalid');
    expect(response.body.user.public_website).to.equal('https://example.com');
    expect(response.body).not.to.have.property('adminEmail');

    var rawToken = response.body.token.substring(4);
    var claims = jwt.decode(rawToken);
    expect(claims._id).to.equal(String(targetUser._id));
    expect(claims.password).to.equal(undefined);
    expect(claims.iss).to.equal('https://tiledesk.com');
    expect(claims.aud).to.equal('https://tiledesk.com');
    expect(claims.sub).to.equal('user');
    expect(claims.jti).to.be.a('string').and.not.equal('');
    expect(claims.exp - claims.iat).to.equal(900);
    expect(claims.token_use).to.equal('impersonation');
    expect(claims).not.to.have.property('authUrl');
    expect(claims).not.to.have.property('attributes');
    expect(claims).not.to.have.property('phone');
    expect(claims.impersonation).to.deep.equal({
      adminId: String(admin._id),
      adminEmail: adminEmail,
      targetType: 'user',
      targetId: String(targetUser._id),
      userId: String(targetUser._id)
    });

    var audit = await waitForAudit({
      action: 'admin.impersonation',
      statusCode: 200,
      'metadata.body.targetId': String(targetUser._id)
    });
    expect(audit.actor.email).to.equal(adminEmail);
    expect(audit.metadata.body.targetType).to.equal('user');
    expect(audit.metadata.body).not.to.have.property('token');
    expect(JSON.stringify(audit)).not.to.include(rawToken);
  });

  it('issues a project token for an active owner with project and role claims', async function() {
    var response = await postImpersonation(adminEmail, password, {
      targetType: 'project',
      targetId: String(activeOwnerProject._id)
    });

    expect(response).to.have.status(200);
    expect(response.body.user._id).to.equal(String(activeOwner._id));
    expect(response.body.projectId).to.equal(String(activeOwnerProject._id));
    expect(response.body.role).to.equal('owner');
    expect(response.body.expiresIn).to.equal(900);

    var claims = jwt.decode(response.body.token.substring(4));
    expect(claims._id).to.equal(String(activeOwner._id));
    expect(claims.id_project).to.equal(String(activeOwnerProject._id));
    expect(claims.projectId).to.equal(String(activeOwnerProject._id));
    expect(claims.role).to.equal('owner');
    expect(claims.token_use).to.equal('impersonation');
    expect(claims.exp - claims.iat).to.equal(900);
    expect(claims.impersonation.projectId).to.equal(String(activeOwnerProject._id));
    expect(claims.impersonation.targetId).to.equal(String(activeOwnerProject._id));
  });

  it('audits an authorized downstream GET with effective user and real admin attribution', async function() {
    var issued = await postImpersonation(adminEmail, password, {
      targetType: 'user',
      targetId: String(targetUser._id)
    });
    expect(issued).to.have.status(200);

    var downstream = await chai.request(server)
      .get('/testauth')
      .set('Authorization', issued.body.token);
    expect(downstream).to.have.status(200);

    var audit = await waitForAudit({
      action: 'api.read',
      path: '/testauth',
      'actor.id': String(targetUser._id)
    });
    expect(audit.actor.email).to.equal(targetUser.email);
    expect(audit.actor.impersonation.adminId).to.equal(String(admin._id));
    expect(audit.actor.impersonation.adminEmail).to.equal(adminEmail);
    expect(audit.actor.impersonation.targetType).to.equal('user');
    expect(audit.actor.impersonation.targetId).to.equal(String(targetUser._id));
  });

  it('does not trust impersonation attribution from a project-key JWT', async function() {
    var forgedToken = jwt.sign({
      _id: String(targetUser._id),
      email: targetUser.email,
      token_use: 'impersonation',
      impersonation: {
        adminId: String(admin._id),
        adminEmail: adminEmail,
        targetType: 'user',
        targetId: String(targetUser._id),
        userId: String(targetUser._id)
      }
    }, projectJwtSecret, {
      subject: 'user',
      audience: 'https://tiledesk.com/projects/' + activeOwnerProject._id,
      expiresIn: 300
    });

    var response = await chai.request(server)
      .get('/testauth')
      .set('Authorization', 'JWT ' + forgedToken);
    expect(response).to.have.status(200);

    await new Promise(function(resolve) { setTimeout(resolve, 200); });
    var auditCount = await AuditEvent.countDocuments({
      path: '/testauth',
      'actor.id': String(targetUser._id)
    });
    expect(auditCount).to.equal(0);
  });

  after(async function() {
    var projects = await Project.find({ createdBy: emailPrefix }).select('_id').lean();
    var projectIds = projects.map(function(project) { return project._id; });
    await Project_user.deleteMany({ id_project: { $in: projectIds } });
    await Project.deleteMany({ createdBy: emailPrefix });
    await User.deleteMany({ email: new RegExp('^' + emailPrefix) });
    await AuditEvent.deleteMany({
      $or: [
        { 'actor.email': new RegExp('^' + emailPrefix) },
        { 'actor.impersonation.adminEmail': adminEmail },
        { action: 'admin.impersonation', 'metadata.body.targetId': { $in: projectIds.map(String) } }
      ]
    });
    if (originalSuperAdminEmails === undefined) {
      delete process.env.SUPER_ADMIN_EMAILS;
    } else {
      process.env.SUPER_ADMIN_EMAILS = originalSuperAdminEmails;
    }
  });
});
