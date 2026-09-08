const mongoose = require('mongoose');

const exchangeRateSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    fromCurrency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    toCurrency: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    rate: {
      type: Number,
      required: true,
      min: 0.000001,
    },
    marginPercent: {
      type: Number,
      default: 0,
      min: 0,
    },
    roundingStep: {
      type: Number,
      default: 1,
      min: 1,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    note: {
      type: String,
      trim: true,
      default: '',
    },
  },
  { timestamps: true }
);

exchangeRateSchema.index(
  { provider: 1, fromCurrency: 1, toCurrency: 1 },
  { unique: true }
);

module.exports = mongoose.model('ExchangeRate', exchangeRateSchema);
