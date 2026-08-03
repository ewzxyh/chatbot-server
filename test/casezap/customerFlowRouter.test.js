var assert = require('assert');
var router = require('../../pubmodules/casezap/customerFlowRouter');
var rulesTrigger = require('../../pubmodules/trigger/rulesTrigger');
var botEvent = require('../../event/botEvent');

describe('CaseZap customer flow routing', function() {
  it('routes an unknown saved contact to the returning flow', function() {
    var result = router.buildAttributeUpdate({}, true);

    assert.deepStrictEqual(result.classification, {
      customerType: 'customer',
      source: 'saved_contact'
    });
    assert.strictEqual(router.getStartCommand(result.classification.customerType), '2');
    assert.strictEqual(result.update['attributes.casezapCustomerType'], 'customer');
  });

  it('routes an unknown unsaved contact to the new flow', function() {
    var result = router.buildAttributeUpdate({}, false);

    assert.deepStrictEqual(result.classification, {
      customerType: 'new',
      source: 'unsaved_contact'
    });
    assert.strictEqual(router.getStartCommand(result.classification.customerType), '1');
  });

  it('keeps a persisted customer in the returning flow after contact removal', function() {
    var result = router.buildAttributeUpdate({
      casezapCustomerType: 'customer',
      casezapCustomerTypeSource: 'saved_contact'
    }, false);

    assert.deepStrictEqual(result.classification, {
      customerType: 'customer',
      source: 'saved_contact'
    });
    assert.strictEqual(router.getStartCommand(result.classification.customerType), '2');
  });

  it('upgrades a provisional new contact when the contact is later saved', function() {
    var result = router.buildAttributeUpdate({
      casezapCustomerType: 'new',
      casezapCustomerTypeSource: 'unsaved_contact'
    }, true);

    assert.strictEqual(result.classification.customerType, 'customer');
    assert.strictEqual(result.classification.source, 'saved_contact');
  });

  it('overrides only the CaseZap default start command', function() {
    assert.strictEqual(
      rulesTrigger.resolveBotStartText({ channel: { name: 'casezap' }, attributes: { casezapFlowStart: '2' } }, '/start'),
      '2'
    );
    assert.strictEqual(
      rulesTrigger.resolveBotStartText({ channel: { name: 'whatsapp' }, attributes: { casezapFlowStart: '2' } }, '/start'),
      '/start'
    );
    assert.strictEqual(
      rulesTrigger.resolveBotStartText({ channel: { name: 'casezap' }, attributes: { casezapFlowStart: '2' } }, 'custom-start'),
      'custom-start'
    );
  });

  it('accepts the classified CaseZap start marker without opening a bot loop', function() {
    assert.strictEqual(
      botEvent.isBotStartMessage({
        sender: 'system',
        text: '2',
        attributes: { casezapFlowStart: '2' }
      }),
      true
    );
    assert.strictEqual(
      botEvent.isBotStartMessage({ sender: 'bot_example', text: '2' }),
      false
    );
    assert.strictEqual(
      botEvent.isBotStartMessage({ sender: 'system', text: '2' }),
      false
    );
  });
});
