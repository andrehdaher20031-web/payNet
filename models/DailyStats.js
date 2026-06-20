const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema(
  {
    count: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
  },
  { _id: false }
);

const dailyStatsSchema = new mongoose.Schema(
  {
    day: {
      type: String,
      required: true,
      unique: true,
    },
    payments: {
      total: { type: counterSchema, default: () => ({}) },
      byStatus: { type: Map, of: counterSchema, default: () => ({}) },
      byCompany: { type: Map, of: counterSchema, default: () => ({}) },
      byPaymentType: { type: Map, of: counterSchema, default: () => ({}) },
    },
    balances: {
      total: { type: counterSchema, default: () => ({}) },
      confirmed: { type: counterSchema, default: () => ({}) },
      unconfirmed: { type: counterSchema, default: () => ({}) },
    },
    invoices: {
      total: { type: counterSchema, default: () => ({}) },
    },
  },
  { timestamps: true }
);

dailyStatsSchema.index({ day: 1 }, { unique: true });

module.exports = mongoose.model('DailyStats', dailyStatsSchema);
