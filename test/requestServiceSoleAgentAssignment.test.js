process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'critical';

const assert = require('assert');
const requestService = require('../services/requestService');

describe('RequestService sole agent auto assignment', function() {
  const previousFlag = process.env.CHATCASE_AUTO_ASSIGN_SOLE_AGENT;

  afterEach(function() {
    if (previousFlag === undefined) {
      delete process.env.CHATCASE_AUTO_ASSIGN_SOLE_AGENT;
    } else {
      process.env.CHATCASE_AUTO_ASSIGN_SOLE_AGENT = previousFlag;
    }
  });

  it('selects the only active agent when routing did not select an operator', function() {
    const operators = requestService.__test.resolveOperatorsForAssignment({
      operators: [],
      agents: [{ id_user: 'agent-1' }]
    });

    assert.deepStrictEqual(operators, [{ id_user: 'agent-1' }]);
  });

  it('keeps the normal routing result when an operator was already selected', function() {
    const operators = requestService.__test.resolveOperatorsForAssignment({
      operators: [{ id_user: 'agent-selected' }],
      agents: [{ id_user: 'agent-1' }]
    });

    assert.deepStrictEqual(operators, [{ id_user: 'agent-selected' }]);
  });

  it('does not fallback when more than one active agent exists', function() {
    const operators = requestService.__test.resolveOperatorsForAssignment({
      operators: [],
      agents: [{ id_user: 'agent-1' }, { id_user: 'agent-2' }]
    });

    assert.deepStrictEqual(operators, []);
  });

  it('can be disabled by environment flag', function() {
    process.env.CHATCASE_AUTO_ASSIGN_SOLE_AGENT = 'false';

    const operators = requestService.__test.resolveOperatorsForAssignment({
      operators: [],
      agents: [{ id_user: 'agent-1' }]
    });

    assert.deepStrictEqual(operators, []);
  });

  it('skips department bot routing only when explicitly requested', function() {
    assert.strictEqual(requestService.__test.shouldSkipDepartmentBot({ skipDepartmentBot: true }), true);
    assert.strictEqual(requestService.__test.shouldSkipDepartmentBot({}), false);
    assert.strictEqual(requestService.__test.shouldSkipDepartmentBot(null), false);
  });
});
