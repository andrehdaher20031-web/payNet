const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  categoryId: { type: Number, required: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  note: { type: String, required: true },
  before: mongoose.Schema.Types.Mixed,
  after: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
schema.index({ categoryId: 1, createdAt: -1 });
module.exports = mongoose.model('AlraghebPricingRuleAudit', schema);
