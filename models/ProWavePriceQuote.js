const mongoose = require('mongoose');

const proWavePriceQuoteSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  itemCode: {
    type: String,
    required: true,
    trim: true,
    index: true,
  },
  itemName: String,
  itemTitle: String,
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
  providerDiscountUsd: Number,
  providerDiscountPercent: Number,
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

proWavePriceQuoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
proWavePriceQuoteSchema.index({ user: 1, itemCode: 1, createdAt: -1 });

module.exports = mongoose.model('ProWavePriceQuote', proWavePriceQuoteSchema);
