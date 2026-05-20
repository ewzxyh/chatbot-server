process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';
process.env.DISABLE_BACKGROUND_WORKERS = 'true';
process.env.CREATE_INITIAL_DATA = 'false';
process.env.MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017/tiledesk-test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tiledesk-test';

var defaultAdminEmail = 'usage-admin-' + process.pid + '-' + Date.now() + '@email.com';
if (!process.env.ADMIN_EMAIL) {
  process.env.ADMIN_EMAIL = defaultAdminEmail;
}

var chai = require('chai');
var chaiHttp = require('chai-http');
var server = require('../app');
var User = require('../models/user');
var Project = require('../models/project');
var ProjectUser = require('../models/project_user');
var Lead = require('../models/lead');
var Message = require('../models/message');
var Request = require('../models/request');
var userService = require('../services/userService');

chai.use(chaiHttp);
chai.should();
var expect = chai.expect;

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

describe('UsageMeteringRoute', function() {
  var pwd = 'Pwd1234!';
  var adminUser;
  var adminEmail;

  before(async function() {
    adminEmail = process.env.ADMIN_EMAIL || defaultAdminEmail;
    await User.deleteOne({ email: adminEmail });
    await userService.signup(adminEmail, pwd, 'Usage', 'Admin');
    adminUser = await User.findOne({ email: adminEmail });
  });

  beforeEach(async function() {
    await Project.deleteMany({ name: /^Usage Metering/ });
    await ProjectUser.deleteMany({ createdBy: 'usage-metering-test' });
    await Lead.deleteMany({ createdBy: 'usage-metering-test' });
    await Message.deleteMany({ createdBy: 'usage-metering-test' });
    await Request.deleteMany({ createdBy: 'usage-metering-test' });
  });

  it('returns a project usage snapshot for superadmin', async function() {
    var project = await Project.create({
      name: 'Usage Metering Project',
      createdBy: 'usage-metering-test',
      profile: {
        name: 'Business',
        type: 'payment',
        agents: 10,
        quotes: {
          contacts: 50000,
          platforms: 5,
          members: 10,
          tokens: 10000000,
          email: 200
        },
        subStart: new Date('2026-05-01T00:00:00.000Z'),
        subEnd: new Date('2026-06-01T00:00:00.000Z')
      }
    });

    await ProjectUser.create({
      id_project: project._id,
      id_user: adminUser._id,
      role: 'owner',
      createdBy: 'usage-metering-test',
      status: 'active'
    });

    await Lead.create({
      lead_id: 'lead-usage-1',
      id_project: String(project._id),
      status: 100,
      createdBy: 'usage-metering-test',
      createdAt: new Date('2026-05-05T00:00:00.000Z')
    });

    await Request.create({
      request_id: 'usage-request-1',
      first_text: 'hello',
      id_project: String(project._id),
      createdBy: 'usage-metering-test',
      createdAt: new Date('2026-05-05T00:00:00.000Z')
    });

    await Message.create({
      sender: 'visitor',
      recipient: 'support-group-' + project._id,
      type: 'text',
      channel_type: 'group',
      channel: { name: 'casezap' },
      text: 'hello',
      id_project: String(project._id),
      status: 200,
      createdBy: 'usage-metering-test',
      createdAt: new Date('2026-05-05T00:00:00.000Z')
    });

    var path = '/sadmin/usage-metering/projects/' + project._id +
      '?from=2026-05-01T00:00:00.000Z&to=2026-06-01T00:00:00.000Z&includeStorage=false';
    var res = await getAsSuperAdmin(path, adminEmail, pwd);

    expect(res).to.have.status(200);
    expect(res.body.project.id).to.equal(String(project._id));
    expect(res.body.contacts.current).to.equal(1);
    expect(res.body.members.current).to.equal(1);
    expect(res.body.conversations.current).to.equal(1);
    expect(res.body.messages.total).to.equal(1);
    expect(res.body.messages.byChannel.casezap).to.equal(1);
    expect(res.body.attachments.bytes).to.equal(null);
  });

  after(async function() {
    await User.deleteOne({ email: adminEmail });
    await Project.deleteMany({ name: /^Usage Metering/ });
    await ProjectUser.deleteMany({ createdBy: 'usage-metering-test' });
    await Lead.deleteMany({ createdBy: 'usage-metering-test' });
    await Message.deleteMany({ createdBy: 'usage-metering-test' });
    await Request.deleteMany({ createdBy: 'usage-metering-test' });
  });
});
