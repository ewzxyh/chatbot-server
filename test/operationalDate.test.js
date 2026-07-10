var chai = require('chai');
var operationalDate = require('../services/operationalDate');

var expect = chai.expect;

describe('operationalDate', function() {
  it('uses UTC midnight for from dates and the UTC end of day for to dates', function() {
    expect(operationalDate.parse('2026-07-10').toISOString()).to.equal('2026-07-10T00:00:00.000Z');
    expect(operationalDate.parse('2026-07-10', { endOfDay: true }).toISOString()).to.equal('2026-07-10T23:59:59.999Z');
  });

  it('preserves the exact instant of a complete ISO timestamp', function() {
    expect(operationalDate.parse('2026-07-10T12:34:56.789Z', { endOfDay: true }).toISOString())
      .to.equal('2026-07-10T12:34:56.789Z');
  });
});
