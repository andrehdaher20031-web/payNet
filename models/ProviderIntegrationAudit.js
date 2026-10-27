const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  provider: { type: String, enum: ['alragheb', 'prowave'], required: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  action: { type: String, required: true },
  target: String,
  note: { type: String, required: true },
  before: mongoose.Schema.Types.Mixed,
  after: mongoose.Schema.Types.Mixed,
  evidence: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
schema.index({ provider: 1, createdAt: -1 });
schema.index({ provider: 1, target: 1, createdAt: -1 });
module.exports = mongoose.model('ProviderIntegrationAudit', schema);
