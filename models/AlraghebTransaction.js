const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  quote: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', required: true },
  clientRequestId: { type: String, required: true },
  orderUuid: { type: String, required: true, unique: true },
  providerOrderId: String,
  productId: Number, productName: String, qty: Number,
  params: mongoose.Schema.Types.Mixed,
  totalSyp: String, price: String, billingUnitQty: Number,
  markupPercent: String, markupFixedSyp: String, providerCostEstimateSyp: String, estimatedProfitSyp: String,
  roundingPolicy: String,
  status: { type: String, enum: ['pending', 'completed', 'refunded'], default: 'pending' },
  providerStatus: { type: String, default: 'unknown' },
  phase: { type: String, enum: ['queued', 'sending', 'checking', 'done'], default: 'queued' },
  refundedAt: Date, providerCostSyp: String,
  result: mongoose.Schema.Types.Mixed,
  attempts: { type: Number, default: 0 }, lastError: String,
  nextCheckAt: { type: Date, default: Date.now },
  leaseUntil: { type: Date, default: () => new Date(0) }, leaseToken: String,
}, { timestamps: true });
schema.index({ user: 1, clientRequestId: 1 }, { unique: true });
schema.index({ status: 1, nextCheckAt: 1, leaseUntil: 1 });
schema.index({ user: 1, createdAt: -1 });
module.exports = mongoose.model('AlraghebTransaction', schema);
