const mongoose = require('mongoose');

const exchangeRateHistorySchema = new mongoose.Schema({
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
  previousRate: Number,
  newRate: {
    type: Number,
    required: true,
  },
  previousMarginPercent: Number,
  newMarginPercent: {
    type: Number,
    default: 0,
  },
  previousRoundingStep: Number,
  newRoundingStep: {
    type: Number,
    default: 1,
  },
  changedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  note: {
    type: String,
    trim: true,
    default: '',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

exchangeRateHistorySchema.index({
  provider: 1,
  fromCurrency: 1,
  toCurrency: 1,
  createdAt: -1,
});

module.exports = mongoose.model('ExchangeRateHistory', exchangeRateHistorySchema);
