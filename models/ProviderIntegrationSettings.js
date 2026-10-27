const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  provider: { type: String, enum: ['alragheb', 'prowave'], required: true, unique: true },
  purchaseEnabled: { type: Boolean, default: true },
  lowBalanceThreshold: { type: String, default: '0' },
  reviewAfterMinutes: { type: Number, default: 30 },
  workerConcurrency: { type: Number, default: 3 },
  revision: { type: Number, default: 1 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('ProviderIntegrationSettings', schema);
