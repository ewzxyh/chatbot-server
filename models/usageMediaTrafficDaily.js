var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var retentionDays = parseInt(process.env.USAGE_MEDIA_TRAFFIC_RETENTION_DAYS || '400', 10);
if (isNaN(retentionDays) || retentionDays < 31) {
  retentionDays = 400;
}

var UsageMediaTrafficDailySchema = new Schema({
  day: {
    type: Date,
    required: true,
    index: true
  },
  id_project: {
    type: String,
    required: true,
    index: true
  },
  path: {
    type: String,
    required: true,
    index: true
  },
  endpoint: {
    type: String,
    required: true,
    index: true
  },
  requests: {
    type: Number,
    default: 0
  },
  bytes: {
    type: Number,
    default: 0
  },
  firstAt: Date,
  lastAt: Date
}, {
  strict: true,
  timestamps: true
});

UsageMediaTrafficDailySchema.index({ id_project: 1, day: 1, endpoint: 1 });
UsageMediaTrafficDailySchema.index({ id_project: 1, day: 1, path: 1, endpoint: 1 }, { unique: true });
UsageMediaTrafficDailySchema.index({ day: 1 }, { expireAfterSeconds: retentionDays * 24 * 60 * 60 });

module.exports = mongoose.model('usage_media_traffic_daily', UsageMediaTrafficDailySchema);
