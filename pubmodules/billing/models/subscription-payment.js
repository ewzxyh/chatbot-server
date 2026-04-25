var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var schema = new Schema({
  mandate_id: { type: String },
  subscription_id: { type: String },
  project_id: { type: String, index: true },
  user_id: { type: String },
  plan_name: { type: String },
  event_type: { type: String },
  stripe_event: { type: String },
  event_id: { type: String, unique: true, sparse: true },
  amount: { type: Number },
  agents: { type: Number },
  status: { type: String },
  provider: { type: String, default: 'casepay' },
  object: { type: Object }
}, {
  timestamps: true
});

module.exports = mongoose.models['subscription-payment'] || mongoose.model('subscription-payment', schema);
