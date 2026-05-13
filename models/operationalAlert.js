var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var retentionDays = parseInt(process.env.OPERATIONAL_ALERT_RETENTION_DAYS || '30', 10);
if (isNaN(retentionDays) || retentionDays < 1) {
  retentionDays = 30;
}

var OperationalAlertSchema = new Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  type: {
    type: String,
    required: true,
    index: true
  },
  severity: {
    type: String,
    enum: ['info', 'warning', 'critical'],
    default: 'warning',
    index: true
  },
  status: {
    type: String,
    enum: ['open', 'resolved'],
    default: 'open',
    index: true
  },
  title: String,
  message: String,
  service: {
    type: String,
    index: true
  },
  queue: {
    type: String,
    index: true
  },
  channel: {
    type: String,
    index: true
  },
  id_project: {
    type: String,
    index: true
  },
  integrationId: {
    type: String,
    index: true
  },
  firstAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  lastAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  resolvedAt: {
    type: Date,
    index: true
  },
  lastEventAt: Date,
  occurrences: {
    type: Number,
    default: 1
  },
  details: Schema.Types.Mixed
}, {
  strict: true,
  timestamps: true
});

OperationalAlertSchema.index({ status: 1, severity: 1, lastAt: -1 });
OperationalAlertSchema.index({ resolvedAt: 1 }, { expireAfterSeconds: retentionDays * 24 * 60 * 60 });

module.exports = mongoose.model('operational_alert', OperationalAlertSchema);
