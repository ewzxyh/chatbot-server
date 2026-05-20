var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var UsageMeteringSnapshotSchema = new Schema({
  id_project: {
    type: String,
    required: true,
    index: true
  },
  projectName: String,
  plan: String,
  planType: String,
  periodKey: {
    type: String,
    required: true,
    index: true
  },
  periodStart: {
    type: Date,
    required: true,
    index: true
  },
  periodEnd: {
    type: Date,
    required: true,
    index: true
  },
  source: {
    type: String,
    default: 'manual',
    index: true
  },
  generatedAt: {
    type: Date,
    default: Date.now
  },
  metrics: Schema.Types.Mixed
}, {
  strict: true,
  timestamps: true
});

UsageMeteringSnapshotSchema.index({ id_project: 1, periodKey: 1 }, { unique: true });
UsageMeteringSnapshotSchema.index({ id_project: 1, periodStart: -1 });

module.exports = mongoose.model('usage_metering_snapshot', UsageMeteringSnapshotSchema);
