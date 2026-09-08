const mongoose = require('mongoose');

const alesoTransactionSchema = new mongoose.Schema(
  {
    payment: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    userEmail: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
    },
    productId: {
      type: Number,
      required: true,
      index: true,
    },
    productName: String,
    categoryName: {
      type: String,
      trim: true,
      index: true,
    },
    productType: String,
    qty: {
      type: Number,
      default: 1,
      min: 1,
    },
    params: mongoose.Schema.Types.Mixed,
    orderUuid: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      index: true,
    },
    alesoOrderId: {
      type: String,
      trim: true,
      index: true,
    },
    providerStatus: {
      type: String,
      enum: ['pending', 'accept', 'wait', 'reject', 'unknown'],
      default: 'pending',
      index: true,
    },
    paynetCurrency: {
      type: String,
      default: 'SYP',
      uppercase: true,
    },
    paynetAmountSyp: {
      type: Number,
      required: true,
    },
    paynetUnitAmountSyp: Number,
    paynetBalanceBeforeSyp: Number,
    paynetBalanceAfterSyp: Number,
    paynetRefundedSyp: Number,
    paynetRefundedAt: Date,
    currency: {
      type: String,
      default: 'USD',
      uppercase: true,
    },
    unitPriceUsd: {
      type: Number,
      required: true,
    },
    saleUnitPriceUsd: Number,
    providerUnitCostUsd: Number,
    expectedProviderDebitUsd: {
      type: Number,
      required: true,
    },
    actualProviderDebitUsd: Number,
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
    expectedCostSyp: Number,
    actualCostSyp: Number,
    profitSyp: Number,
    profitPercent: Number,
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded'],
      default: 'pending',
      index: true,
    },
    failureStage: String,
    failureReason: String,
    failureCode: String,
    quote: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AlesoPriceQuote',
    },
    startedAt: Date,
    completedAt: Date,
    failedAt: Date,
    rawOrderResponse: mongoose.Schema.Types.Mixed,
    rawCheckResponse: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

alesoTransactionSchema.index({ createdAt: -1 });
alesoTransactionSchema.index({ status: 1, createdAt: -1 });
alesoTransactionSchema.index({ providerStatus: 1, createdAt: -1 });
alesoTransactionSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('AlesoTransaction', alesoTransactionSchema);
