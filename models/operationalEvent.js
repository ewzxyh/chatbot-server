var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var retentionDays = parseInt(process.env.OPERATIONAL_EVENT_RETENTION_DAYS || '14', 10);
if (isNaN(retentionDays) || retentionDays < 1) {
  retentionDays = 14;
}

var OperationalEventSchema = new Schema({
  timestamp: {
    type: Date,
    default: Date.now
  },
  level: {
    type: String,
    enum: ['debug', 'info', 'warn', 'error'],
    default: 'info',
    index: true
  },
  area: {
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
  requestId: {
    type: String,
    index: true
  },
  messageId: {
    type: String,
    index: true
  },
  event: {
    type: String,
    required: true,
    index: true
  },
  status: {
    type: String,
    index: true
  },
  latencyMs: {
    type: Number
  },
  errorCode: {
    type: String
  },
  errorMessage: {
    type: String
  },
  details: {
    type: Schema.Types.Mixed
  }
}, {
  strict: true
});

OperationalEventSchema.index({ timestamp: -1, level: 1, channel: 1 });
OperationalEventSchema.index({ id_project: 1, channel: 1, timestamp: -1 });
OperationalEventSchema.index({ timestamp: 1 }, { expireAfterSeconds: retentionDays * 24 * 60 * 60 });

module.exports = mongoose.model('operational_event', OperationalEventSchema);
