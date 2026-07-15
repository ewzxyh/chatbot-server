'use strict';

var assert = require('assert');
var migration = require('../../bin/migrate-casezap-duplicate-leads');

describe('CaseZap duplicate lead migration', function() {
  it('recognizes only legacy CaseZap lead ids and normalizes their phone', function() {
    var identity = migration.extractLegacyCaseZapLead({
      lead_id: 'casezap-507f1f77bcf86cd799439011-5511999999999',
      id_project: 'project-1',
      phone: '5511888888888'
    });

    assert.deepStrictEqual(identity, {
      projectId: 'project-1',
      phone: '5511999999999',
      integrationId: '507f1f77bcf86cd799439011'
    });
    assert.strictEqual(migration.extractLegacyCaseZapLead({
      lead_id: 'wab-507f1f77bcf86cd799439011-5511999999999',
      id_project: 'project-1',
      phone: '5511999999999'
    }), null);
  });

  it('merges useful duplicate fields and keeps an active contact visible', function() {
    var target = {
      _id: 'lead-1',
      fullname: 'Nome canônico',
      tags: ['cliente'],
      status: 1000,
      attributes: { source: 'canonical', preferences: { language: 'pt' } },
      properties: {}
    };
    var merged = migration.mergeLeadData({
      canonicalLeadId: 'casezap-5511999999999',
      phone: '5511999999999',
      legacyLeads: [target, {
        _id: 'lead-2',
        email: 'redacted@example.invalid',
        tags: ['vip'],
        attributes: { source: 'legacy', campaign: 'july', preferences: { timezone: 'America/Sao_Paulo' } },
        properties: { preferred: true },
        createdBy: 'casezap-5511999999999'
      }]
    }, target);

    assert.strictEqual(merged.fullname, 'Nome canônico');
    assert.strictEqual(merged.email, 'redacted@example.invalid');
    assert.deepStrictEqual(merged.tags, ['cliente', 'vip']);
    assert.strictEqual(merged.status, 100);
    assert.deepStrictEqual(merged.attributes, {
      source: 'canonical',
      campaign: 'july',
      preferences: { timezone: 'America/Sao_Paulo', language: 'pt' }
    });
    assert.deepStrictEqual(merged.properties, { preferred: true });
  });

  it('rejects WABA request references before a merge', function() {
    assert.strictEqual(migration.isSafeCaseZapRequest({
      channel: { name: 'casezap' },
      integrationId: '507f1f77bcf86cd799439011'
    }), true);
    assert.strictEqual(migration.isSafeCaseZapRequest({
      channel: { name: 'whatsapp' },
      integrationId: '507f1f77bcf86cd799439012'
    }), false);
  });

  it('infers a missing integration from an embedded legacy lead', function() {
    var integrationId = migration.resolveRequestIntegrationId({
      snapshot: {
        lead: {
          lead_id: 'casezap-507f1f77bcf86cd799439011-5511999999999',
          id_project: 'project-1'
        }
      }
    }, new Map());

    assert.strictEqual(integrationId, '507f1f77bcf86cd799439011');
  });

  it('finds references stored in the request or only in its snapshot', function() {
    assert.deepStrictEqual(migration.buildRequestReferenceQuery('project-1', ['lead-1']), {
      id_project: 'project-1',
      $or: [
        { lead: { $in: ['lead-1'] } },
        { 'snapshot.lead._id': { $in: ['lead-1'] } }
      ]
    });
  });

  it('defaults to dry-run and requires --apply to mutate', function() {
    assert.strictEqual(migration.parseArgs([]).apply, false);
    assert.strictEqual(migration.parseArgs(['--apply']).apply, true);
  });
});
