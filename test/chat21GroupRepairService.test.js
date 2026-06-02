process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';
process.env.DISABLE_BACKGROUND_WORKERS = 'true';

var expect = require('chai').expect;
var chat21GroupRepairService = require('../services/chat21GroupRepairService');

function sampleRequest(overrides) {
  return Object.assign({
    request_id: 'support-group-project-123',
    id_project: 'project-123',
    requester_id: 'lead-object-id',
    subject: 'Cliente Teste',
    participants: ['agent-1', 'agent-1'],
    userAgent: 'casezap',
    sourcePage: 'whatsapp',
    channelOutbound: { name: 'chat21' },
    attributes: { existing: true },
    lead: {
      lead_id: 'lead-1',
      fullname: 'Cliente Lead',
      email: 'redacted@example.invalid'
    },
    department: {
      _id: 'department-1',
      name: 'Atendimento'
    }
  }, overrides || {});
}

function fakeRequestModel(request, state) {
  state = state || {};
  return {
    findOne: function(query) {
      state.query = query;
      var chain = {
        populate: function(field) {
          state.populates = state.populates || [];
          state.populates.push(field);
          return chain;
        },
        exec: async function() {
          return request;
        }
      };
      return chain;
    }
  };
}

function fakeChatClient(createResult, state) {
  state = state || {};
  return {
    auth: {
      setAdminToken: function(token) {
        state.adminToken = token;
      }
    },
    groups: {
      create: async function(name, members, attributes, groupId) {
        state.create = { name: name, members: members, attributes: attributes, groupId: groupId };
        return createResult;
      },
      setMembers: async function(members, groupId) {
        state.setMembers = { members: members, groupId: groupId };
        return { success: true };
      },
      updateAttributes: async function(attributes, groupId) {
        state.updateAttributes = { attributes: attributes, groupId: groupId };
        return { success: true };
      }
    }
  };
}

describe('Chat21GroupRepairService', function() {
  it('builds a Chat21 group payload without mutating participants', function() {
    var request = sampleRequest();
    var payload = chat21GroupRepairService.buildGroupPayload(request);

    expect(payload.groupId).to.equal(request.request_id);
    expect(payload.groupName).to.equal('Cliente Teste');
    expect(payload.members).to.deep.equal(['agent-1', 'system', 'lead-1']);
    expect(request.participants).to.deep.equal(['agent-1', 'agent-1']);
    expect(payload.attributes.projectId).to.equal('project-123');
    expect(payload.attributes.userFullname).to.equal('Cliente Lead');
    expect(payload.attributes.departmentName).to.equal('Atendimento');
    expect(payload.attributes.senderAuthInfo.authVar.uid).to.equal('lead-1');
  });

  it('returns a dry run payload and does not call Chat21', async function() {
    var queryState = {};
    var chatState = {};
    var service = chat21GroupRepairService.createChat21GroupRepairService({
      Request: fakeRequestModel(sampleRequest(), queryState),
      chat21: fakeChatClient({ success: true }, chatState),
      operationalLogger: null
    });

    var result = await service.repairRequestGroup({
      request_id: 'support-group-project-123',
      id_project: 'project-123',
      dryRun: true
    });

    expect(queryState.query).to.deep.equal({
      request_id: 'support-group-project-123',
      id_project: 'project-123'
    });
    expect(queryState.populates).to.deep.equal(['lead', 'department']);
    expect(result.status).to.equal('dry_run');
    expect(result.payload.groupId).to.equal('support-group-project-123');
    expect(chatState.create).to.equal(undefined);
  });

  it('creates a missing Chat21 group with the configured admin token', async function() {
    var chatState = {};
    var service = chat21GroupRepairService.createChat21GroupRepairService({
      Request: fakeRequestModel(sampleRequest()),
      chat21: fakeChatClient({ success: true, group: { uid: 'support-group-project-123' } }, chatState),
      operationalLogger: null,
      env: { CHAT21_ADMIN_TOKEN: 'admin-token' }
    });

    var result = await service.repairRequestGroup({ request_id: 'support-group-project-123' });

    expect(result.status).to.equal('created');
    expect(chatState.adminToken).to.equal('admin-token');
    expect(chatState.create.groupId).to.equal('support-group-project-123');
    expect(chatState.create.members).to.deep.equal(['agent-1', 'system', 'lead-1']);
  });

  it('reconciles members and attributes when the group already exists', async function() {
    var chatState = {};
    var service = chat21GroupRepairService.createChat21GroupRepairService({
      Request: fakeRequestModel(sampleRequest()),
      chat21: fakeChatClient({ success: false, message: 'group already exists' }, chatState),
      operationalLogger: null
    });

    var result = await service.repairRequestGroup({ request_id: 'support-group-project-123' });

    expect(result.status).to.equal('updated_existing');
    expect(chatState.setMembers.groupId).to.equal('support-group-project-123');
    expect(chatState.setMembers.members).to.deep.equal(['agent-1', 'system', 'lead-1']);
    expect(chatState.updateAttributes.attributes.projectId).to.equal('project-123');
  });
});
