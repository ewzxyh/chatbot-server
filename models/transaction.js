const mongoose = require('mongoose');

const TransactionSchema = mongoose.Schema({
  transaction_id: {
    type: String,
    required: true
  },
  id_project: {
    type: String,
    required: true
  },
  template_name: {
    type: String,
    required: true
  },
  status: {
    type: String,
    required: false
  },
  channel: {
    type: String,
    required: false
  },
  broadcast: {
    type: Boolean,
    required: false
  },
  dispatch_type: {
    type: String,
    required: false
  },
  faq_kb_id: {
    type: String,
    required: false
  },
  createdBy: {
    type: String,
    required: false
  },
  recipients_total: {
    type: Number,
    required: false,
    default: 0
  },
  processed_count: {
    type: Number,
    required: false,
    default: 0
  },
  sent_count: {
    type: Number,
    required: false,
    default: 0
  },
  failed_count: {
    type: Number,
    required: false,
    default: 0
  },
  ready_count: {
    type: Number,
    required: false,
    default: 0
  },
  skipped_count: {
    type: Number,
    required: false,
    default: 0
  },
  dry_run: {
    type: Boolean,
    required: false,
    default: false
  },
  interval_ms: {
    type: Number,
    required: false,
    default: 1000
  },
  recipients: {
    type: [mongoose.Schema.Types.Mixed],
    required: false,
    default: []
  },
  campaign: {
    type: mongoose.Schema.Types.Mixed,
    required: false
  },
  startedAt: {
    type: Date,
    required: false
  },
  finishedAt: {
    type: Date,
    required: false
  },
  pausedAt: {
    type: Date,
    required: false
  },
  canceledAt: {
    type: Date,
    required: false
  },
  last_error: {
    type: String,
    required: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  }
})


const Transaction = mongoose.model("Transactions", TransactionSchema);

module.exports = { Transaction };
