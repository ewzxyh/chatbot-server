var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var statuses = ['ok', 'degraded', 'down', 'unknown'];

var OperationalChannelDiagnosticSchema = new Schema({
  _id: { type: String, required: true },
  integrationId: { type: String, required: true, index: true },
  id_project: { type: String, index: true },
  name: { type: String },
  product: { type: String, enum: ['casezap', 'waba'], required: true, index: true },
  channel: { type: String, required: true, index: true },
  status: { type: String, enum: statuses, required: true, index: true },
  cause: { type: String, default: null, index: true },
  checkedAt: { type: Date, default: null, index: true },
  cycleId: { type: String, required: true, index: true },
  cycleAt: { type: Date, required: true, index: true }
}, {
  collection: 'operational_channel_diagnostics',
  strict: true
});

OperationalChannelDiagnosticSchema.index({ checkedAt: -1, integrationId: 1 });
OperationalChannelDiagnosticSchema.index({ product: 1, channel: 1, status: 1, cause: 1, checkedAt: -1, integrationId: 1 });

module.exports = mongoose.model('operational_channel_diagnostic', OperationalChannelDiagnosticSchema);
