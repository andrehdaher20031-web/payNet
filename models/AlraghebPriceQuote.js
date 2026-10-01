const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  productId: Number, productName: String, qty: Number,
  params: mongoose.Schema.Types.Mixed,
  configRevision: Number, contractHash: String,
  price: String, billingUnitQty: Number, totalBeforeRoundingSyp: String, totalSyp: String,
  saleUnitPrice: String, markupPercent: String, markupFixedSyp: String,
  providerCostEstimateSyp: String, estimatedProfitSyp: String,
  roundingPolicy: String,
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  usedAt: Date,
}, { timestamps: true });
module.exports = mongoose.model('AlraghebPriceQuote', schema);
