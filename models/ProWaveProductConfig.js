const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  itemCode: { type: String, required: true, trim: true },
  operationType: { type: String, enum: ['digital_card', 'direct_topup'], required: true },
  currency: { type: String, enum: ['USD'], default: 'USD' },
  purchaseEnabled: { type: Boolean, default: true },
  salePriceUsd: { type: String, default: null },
  marginPercent: { type: Number, default: null },
  revision: { type: Number, default: 0 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  note: String,
}, { timestamps: true });
schema.index({ itemCode: 1, operationType: 1, currency: 1 }, { unique: true });
module.exports = mongoose.model('ProWaveProductConfig', schema);
