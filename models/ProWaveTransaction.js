const mongoose = require('mongoose');

const proWaveTransactionSchema = new mongoose.Schema(
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
    operationType: {
      type: String,
      enum: ['digital_card', 'direct_topup'],
      default: 'digital_card',
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
    game: {
      type: String,
      trim: true,
      index: true,
    },
    playerId: {
      type: String,
      trim: true,
      index: true,
    },
    rechargeCategory: {
      type: String,
      trim: true,
    },
    qty: {
      type: Number,
      default: 1,
      min: 1,
    },
    prowaveCurrency: {
      type: String,
      default: 'USD',
      uppercase: true,
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
    unitPriceUsd: {
      type: Number,
      required: true,
    },
    saleUnitPriceUsd: Number,
    providerUnitCostUsd: Number,
    providerDiscountUsd: Number,
    providerDiscountPercent: Number,
    expectedProviderDebitUsd: {
      type: Number,
      required: true,
    },
    actualProviderDebitUsd: Number,
    invoiceProviderDebitUsd: Number,
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
    prowaveInvoice: {
      type: String,
      trim: true,
      index: true,
    },
    prowaveRequestName: {
      type: String,
      trim: true,
      index: true,
    },
    rechargeStatus: {
      type: String,
      trim: true,
      index: true,
    },
    rejectionReason: String,
    prowaveBalanceBeforeUsd: Number,
    prowaveBalanceAfterUsd: Number,
    providerBalanceStatus: {
      type: String,
      enum: ['pending', 'matched', 'mismatch', 'unavailable'],
      default: 'pending',
      index: true,
    },
    invoiceMatchStatus: {
      type: String,
      enum: ['pending', 'matched', 'missing', 'mismatch', 'unavailable'],
      default: 'pending',
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'mismatch', 'failed', 'refunded'],
      default: 'pending',
      index: true,
    },
    mismatchReason: {
      type: String,
      default: '',
    },
    failureStage: String,
    failureReason: String,
    quote: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProWavePriceQuote',
    },
    startedAt: Date,
    completedAt: Date,
    failedAt: Date,
    rawProviderBalanceBefore: mongoose.Schema.Types.Mixed,
    rawProviderBalanceAfter: mongoose.Schema.Types.Mixed,
    rawPurchaseResponse: mongoose.Schema.Types.Mixed,
    rawDirectTopupStatusResponse: mongoose.Schema.Types.Mixed,
    rawCodesResponse: mongoose.Schema.Types.Mixed,
    rawInvoice: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

proWaveTransactionSchema.index({ createdAt: -1 });
proWaveTransactionSchema.index({ status: 1, createdAt: -1 });
proWaveTransactionSchema.index({ operationType: 1, createdAt: -1 });
proWaveTransactionSchema.index({ prowaveInvoice: 1, itemCode: 1 });

module.exports = mongoose.model('ProWaveTransaction', proWaveTransactionSchema);
