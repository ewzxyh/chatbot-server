var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var retentionDays = parseInt(process.env.AUDIT_EVENT_RETENTION_DAYS || '365', 10);

var AuditEventSchema = new Schema({
  timestamp: { type: Date, default: Date.now, index: true },
  action: { type: String, required: true, index: true },
  method: { type: String, index: true },
  path: { type: String, index: true },
  route: { type: String },
  statusCode: { type: Number, index: true },
  success: { type: Boolean, index: true },
  durationMs: { type: Number },
  id_project: { type: String, index: true },
  entityType: { type: String, index: true },
  entityId: { type: String, index: true },
  resource: { type: String },
  summary: { type: String },
  actor: {
    id: { type: String },
    email: { type: String, index: true },
    role: { type: String },
    type: { type: String }
  },
  requestId: { type: String, index: true },
  integrationId: { type: String },
  ip: { type: String },
  userAgent: { type: String },
  before: { type: Schema.Types.Mixed },
  after: { type: Schema.Types.Mixed },
  changes: { type: Schema.Types.Mixed },
  metadata: { type: Schema.Types.Mixed }
}, { timestamps: true });

AuditEventSchema.index({ timestamp: -1 });
AuditEventSchema.index({ id_project: 1, timestamp: -1 });
AuditEventSchema.index({ 'actor.email': 1, timestamp: -1 });
AuditEventSchema.index({ action: 1, timestamp: -1 });
AuditEventSchema.index({ entityType: 1, entityId: 1, timestamp: -1 });
AuditEventSchema.index({ success: 1, timestamp: -1 });

if (!isNaN(retentionDays) && retentionDays > 0) {
  AuditEventSchema.index({ timestamp: 1 }, { expireAfterSeconds: retentionDays * 24 * 60 * 60 });
}

module.exports = mongoose.model('audit_event', AuditEventSchema);
