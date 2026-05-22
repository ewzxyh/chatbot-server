process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';
process.env.DISABLE_BACKGROUND_WORKERS = 'true';
process.env.CREATE_INITIAL_DATA = 'false';
process.env.AUDIT_ENABLED = 'true';
process.env.PRIVACY_ANONYMIZE_MESSAGE_TEXT = 'true';
process.env.MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017/tiledesk-test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tiledesk-test';

var defaultAdminEmail = 'privacy-admin-' + process.pid + '-' + Date.now() + '@email.com';
if (!process.env.ADMIN_EMAIL) {
  process.env.ADMIN_EMAIL = defaultAdminEmail;
}

var chai = require('chai');
var chaiHttp = require('chai-http');
var server = require('../app');
var User = require('../models/user');
var Project = require('../models/project');
var Lead = require('../models/lead');
var Request = require('../models/request');
var Message = require('../models/message');
var AuditEvent = require('../models/auditEvent');
var privacyService = require('../services/privacyService');
var userService = require('../services/userService');

chai.use(chaiHttp);
chai.should();
var expect = chai.expect;

function postAsSuperAdmin(path, email, password, body) {
  return new Promise(function(resolve, reject) {
    chai.request(server)
      .post(path)
      .auth(email, password)
      .send(body || {})
      .end(function(err, res) {
        if (err) return reject(err);
        resolve(res);
      });
  });
}

function getAsSuperAdmin(path, email, password) {
  return new Promise(function(resolve, reject) {
    chai.request(server)
      .get(path)
      .auth(email, password)
      .end(function(err, res) {
        if (err) return reject(err);
        resolve(res);
      });
  });
}

describe('PrivacyRoute', function() {
  var pwd = 'Pwd1234!';
  var adminEmail;

  before(async function() {
    adminEmail = process.env.ADMIN_EMAIL || defaultAdminEmail;
    await User.deleteOne({ email: adminEmail });
    await userService.signup(adminEmail, pwd, 'Privacy', 'Admin');
  });

  beforeEach(async function() {
    await Project.deleteMany({ createdBy: 'privacy-route-test' });
    await Lead.deleteMany({ createdBy: 'privacy-route-test' });
    await Request.deleteMany({ createdBy: 'privacy-route-test' });
    await Message.deleteMany({ createdBy: 'privacy-route-test' });
    await AuditEvent.deleteMany({ action: /^admin\.privacy_/ });
  });

  it('exports and anonymizes project contact data without logging the raw identifier', async function() {
    var now = Date.now();
    var project = await Project.create({
      name: 'Privacy Route Project',
      createdBy: 'privacy-route-test',
      profile: { name: 'Free', type: 'free' }
    });

    var lead = await Lead.create({
      lead_id: 'lead-privacy-' + now,
      fullname: 'Jane Sensitive',
      email: 'redacted@example.invalid',
      phone: '+55 62 99999-0000',
      company: 'Sensitive Company',
      note: 'private note',
      attributes: { cpf: '123.456.789-00' },
      properties: { birthday: '1990-01-01' },
      id_project: String(project._id),
      createdBy: 'privacy-route-test'
    });

    var request = await Request.create({
      request_id: 'privacy-request-' + now,
      id_project: String(project._id),
      lead: lead._id,
      first_text: 'Meu CPF e 123.456.789-00',
      subject: 'Pedido sensivel',
      contact: {
        phone: lead.phone,
        email: lead.email,
        external_id: lead.lead_id
      },
      snapshot: { lead: lead.toObject() },
      createdBy: 'privacy-route-test'
    });

    await Message.create({
      sender: lead.lead_id,
      senderFullname: lead.fullname,
      recipient: request.request_id,
      text: 'Mensagem com dado pessoal',
      id_project: String(project._id),
      createdBy: 'privacy-route-test'
    });

    var exportRes = await postAsSuperAdmin('/sadmin/privacy/contact-export', adminEmail, pwd, {
      project_id: project._id,
      identifier: lead.email
    });
    expect(exportRes).to.have.status(200);
    expect(exportRes.body.matched.leadFound).to.equal(true);
    expect(exportRes.body.matched.requestCount).to.equal(1);
    expect(exportRes.body.matched.messageCount).to.equal(1);
    expect(exportRes.body.data.lead.email).to.equal(lead.email);

    var anonymizeRes = await postAsSuperAdmin('/sadmin/privacy/contact-anonymize', adminEmail, pwd, {
      project_id: project._id,
      identifier: lead.email,
      reason: 'LGPD request',
      confirm: true
    });
    expect(anonymizeRes).to.have.status(200);
    expect(anonymizeRes.body.counts.leadsMatched).to.equal(1);
    expect(anonymizeRes.body.counts.requestsMatched).to.equal(1);
    expect(anonymizeRes.body.counts.messagesModified).to.equal(1);

    var updatedLead = await Lead.findById(lead._id).lean();
    expect(updatedLead.fullname).to.equal(privacyService.ANONYMIZED_NAME);
    expect(updatedLead.email).to.equal(null);
    expect(updatedLead.phone).to.equal(null);
    expect(updatedLead.attributes.privacy.anonymized).to.equal(true);

    var updatedRequest = await Request.findById(request._id).lean();
    expect(updatedRequest.first_text).to.equal(privacyService.ANONYMIZED_TEXT);
    expect(updatedRequest.contact.phone).to.equal(null);
    expect(updatedRequest.snapshot.lead.fullname).to.equal(privacyService.ANONYMIZED_NAME);

    var updatedMessage = await Message.findOne({ recipient: request.request_id }).lean();
    expect(updatedMessage.text).to.equal(privacyService.ANONYMIZED_TEXT);
    expect(updatedMessage.senderFullname).to.equal(privacyService.ANONYMIZED_NAME);

    var auditEvents = await AuditEvent.find({ action: /^admin\.privacy_/ }).lean();
    expect(auditEvents.length).to.be.at.least(2);
    auditEvents.forEach(function(event) {
      var serialized = JSON.stringify(event);
      expect(serialized.indexOf(lead.email)).to.equal(-1);
      expect(serialized.indexOf(lead.phone)).to.equal(-1);
    });
  });

  it('exposes privacy retention config to superadmin', async function() {
    var res = await getAsSuperAdmin('/sadmin/privacy/config', adminEmail, pwd);
    expect(res).to.have.status(200);
    expect(res.body.config).to.have.property('conversationRetentionDays');
    expect(res.body.config).to.have.property('attachmentRetentionDays');
    expect(res.body.config).to.have.property('leadRetentionDays');
  });

  after(async function() {
    await User.deleteOne({ email: adminEmail });
    await Project.deleteMany({ createdBy: 'privacy-route-test' });
    await Lead.deleteMany({ createdBy: 'privacy-route-test' });
    await Request.deleteMany({ createdBy: 'privacy-route-test' });
    await Message.deleteMany({ createdBy: 'privacy-route-test' });
    await AuditEvent.deleteMany({ action: /^admin\.privacy_/ });
  });
});
