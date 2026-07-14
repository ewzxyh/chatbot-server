'use strict';

var expect = require('chai').expect;
var Lead = require('../models/lead');
var leadService = require('../services/leadService');

describe('LeadService atomic upsert', function () {
  var originalFindOneAndUpdate;
  var capturedFilter;
  var capturedUpdate;
  var capturedOptions;

  beforeEach(function () {
    originalFindOneAndUpdate = Lead.findOneAndUpdate;
    capturedFilter = null;
    capturedUpdate = null;
    capturedOptions = null;
    Lead.findOneAndUpdate = function (filter, update, options) {
      capturedFilter = filter;
      capturedUpdate = update;
      capturedOptions = options;
      return {
        exec: function (callback) {
          callback(null, { createdBy: 'system' });
        }
      };
    };
  });

  afterEach(function () {
    Lead.findOneAndUpdate = originalFindOneAndUpdate;
  });

  it('uses the phone only when inserting a lead without a fullname', async function () {
    await leadService.createIfNotExistsWithLeadId(
      'casezap-5511999999999',
      null,
      null,
      'project-id',
      null,
      null,
      null,
      '+5511999999999'
    );

    expect(capturedUpdate.$setOnInsert.fullname).to.equal('+5511999999999');
    expect(capturedUpdate.$set).to.not.have.property('fullname');
    expect(capturedUpdate.$set.phone).to.equal('+5511999999999');
    expect(capturedFilter).to.deep.equal({ lead_id: 'casezap-5511999999999', id_project: 'project-id' });
    expect(capturedOptions).to.deep.equal({ upsert: true, new: true, setDefaultsOnInsert: true });
  });

  it('updates the fullname when the contact provides one', async function () {
    await leadService.createIfNotExistsWithLeadId(
      'casezap-5511888888888',
      'Nome do contato',
      null,
      'project-id',
      null,
      null,
      null,
      '+5511888888888'
    );

    expect(capturedUpdate.$set.fullname).to.equal('Nome do contato');
    expect(capturedUpdate.$setOnInsert).to.not.have.property('fullname');
  });
});
