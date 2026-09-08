const mongoose = require('mongoose');

const alesoPriceQuoteSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  productId: {
    type: Number,
    required: true,
    index: true,
  },
  productName: {
    type: String,
    trim: true,
  },
  categoryName: {
    type: String,
    trim: true,
    index: true,
  },
  productType: {
    type: String,
    trim: true,
  },
  paramsDefinition: [String],
  qtyValues: mongoose.Schema.Types.Mixed,
  currency: {
    type: String,
    default: 'USD',
    uppercase: true,
  },
  qty: {
    type: Number,
    default: 1,
    min: 1,
  },
  unitPriceUsd: {
    type: Number,
    required: true,
  },
  saleUnitPriceUsd: Number,
  providerUnitCostUsd: Number,
  expectedProviderDebitUsd: Number,
  exchangeRate: {
    type: Number,
    required: true,
  },
  marginPercent: {
    type: Number,
    default: 0,
  },
  roundingStep: {
    type: Number,
    default: 1,
  },
  baseUnitAmountSyp: Number,
  unitAmountBeforeRoundingSyp: Number,
  unitAmountSyp: {
    type: Number,
    required: true,
  },
  totalAmountSyp: {
    type: Number,
    required: true,
  },
  rawProduct: mongoose.Schema.Types.Mixed,
  expiresAt: {
    type: Date,
    required: true,
  },
  usedAt: Date,
  payment: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payment',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

alesoPriceQuoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
alesoPriceQuoteSchema.index({ user: 1, productId: 1, createdAt: -1 });

module.exports = mongoose.model('AlesoPriceQuote', alesoPriceQuoteSchema);
