var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var statuses = ['ok', 'degraded', 'down', 'unknown'];

var OperationalChannelDiagnosticSchema = new Schema({
  _id: { type: String, required: true },
  integrationId: { type: String, required: true },
  id_project: { type: String },
  name: { type: String },
  product: { type: String, enum: ['casezap', 'waba'], required: true },
  channel: { type: String, required: true },
  status: { type: String, enum: statuses, required: true },
  cause: { type: String, default: null },
  checkedAt: { type: Date, default: null },
  cycleId: { type: String, required: true },
  generation: { type: Number, required: true, min: 1 },
  cycleAt: { type: Date, required: true }
}, {
  collection: 'operational_channel_diagnostics',
  strict: true
});

OperationalChannelDiagnosticSchema.index({ cycleId: 1, checkedAt: -1, integrationId: 1 });
OperationalChannelDiagnosticSchema.index({ cycleId: 1, product: 1, channel: 1, status: 1, cause: 1, checkedAt: -1, integrationId: 1 });
OperationalChannelDiagnosticSchema.index({ generation: 1 });

module.exports = mongoose.model('operational_channel_diagnostic', OperationalChannelDiagnosticSchema);
