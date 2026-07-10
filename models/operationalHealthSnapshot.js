var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var statuses = ['ok', 'degraded', 'down', 'unknown'];

var SnapshotItemSchema = new Schema({
  name: { type: String, required: true },
  status: { type: String, enum: statuses, required: true },
  cause: { type: String, default: null },
  checkedAt: { type: Date, default: null },
  messagesReady: { type: Number, min: 0 },
  messagesUnacknowledged: { type: Number, min: 0 },
  messagesTotal: { type: Number, min: 0 },
  consumers: { type: Number, min: 0 }
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

var ProductAggregatesSchema = new Schema({
  casezap: { type: StatusCountsSchema, default: function() { return {}; } },
  waba: { type: StatusCountsSchema, default: function() { return {}; } },
  unknown: { type: StatusCountsSchema, default: function() { return {}; } }
}, { _id: false, strict: true });

var MonitorLeaseSchema = new Schema({
  owner: { type: String, required: true },
  expiresAt: { type: Date, required: true }
}, { _id: false, strict: true });

var OperationalHealthSnapshotSchema = new Schema({
  _id: { type: String, enum: ['singleton'], default: 'singleton' },
  version: { type: Number, enum: [2], default: 2 },
  overallStatus: { type: String, enum: statuses, required: true },
  generatedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  services: { type: [SnapshotItemSchema], default: [] },
  queues: { type: [SnapshotItemSchema], default: [] },
  channels: {
    count: { type: Number, default: 0 },
    byStatus: { type: StatusCountsSchema, default: function() { return {}; } },
    byProduct: { type: ProductAggregatesSchema, default: function() { return {}; } },
    topCauses: { type: [CauseSchema], default: [] }
  },
  alerts: {
    count: { type: Number, default: 0 },
    byStatus: { type: StatusCountsSchema, default: function() { return {}; } },
    topCauses: { type: [CauseSchema], default: [] }
  },
  activeDiagnosticCycleId: { type: String, default: null },
  diagnosticGeneration: { type: Number, min: 0, default: 0 },
  monitorLease: { type: MonitorLeaseSchema, default: null }
}, {
  collection: 'health',
  strict: true,
  timestamps: true
});

module.exports = mongoose.model('operational_health_snapshot', OperationalHealthSnapshotSchema);
