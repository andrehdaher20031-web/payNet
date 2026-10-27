const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  provider: { type: String, enum: ['alragheb', 'prowave'], required: true, unique: true },
  lastStartedAt: Date,
  lastFinishedAt: Date,
  lastSuccessAt: Date,
  leaseUntil: Date,
  lastError: String,
  lastProcessed: { type: Number, default: 0 },
  consecutiveFailures: { type: Number, default: 0 },
  balance: { amount: String, currency: String, observedAt: Date, checkedAt: Date, status: String, errorCode: String },
}, { timestamps: true });
module.exports = mongoose.model('ProviderWorkerHealth', schema);
