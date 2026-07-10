var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var statuses = ['ok', 'degraded', 'down', 'unknown'];

var SnapshotItemSchema = new Schema({
  name: { type: String, required: true },
  status: { type: String, enum: statuses, required: true },
  cause: { type: String, default: null },
  checkedAt: { type: Date, default: null }
}, { _id: false, strict: true });

var CauseSchema = new Schema({
  cause: { type: String, required: true },
  count: { type: Number, required: true }
}, { _id: false, strict: true });

var StatusCountsSchema = new Schema({
  ok: { type: Number, default: 0 },
  degraded: { type: Number, default: 0 },
  down: { type: Number, default: 0 },
  unknown: { type: Number, default: 0 }
}, { _id: false, strict: true });

var OperationalHealthSnapshotSchema = new Schema({
  _id: { type: String, default: 'singleton' },
  version: { type: Number, enum: [2], default: 2 },
  overallStatus: { type: String, enum: statuses, required: true },
  generatedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  services: { type: [SnapshotItemSchema], default: [] },
  queues: { type: [SnapshotItemSchema], default: [] },
  channels: {
    count: { type: Number, default: 0 },
    byStatus: { type: StatusCountsSchema, default: function() { return {}; } },
    byProduct: { type: Schema.Types.Mixed, default: {} },
    topCauses: { type: [CauseSchema], default: [] }
  },
  alerts: {
    count: { type: Number, default: 0 },
    byStatus: { type: StatusCountsSchema, default: function() { return {}; } },
    topCauses: { type: [CauseSchema], default: [] }
  }
}, {
  collection: 'health',
  strict: true,
  timestamps: true
});

module.exports = mongoose.model('operational_health_snapshot', OperationalHealthSnapshotSchema);
