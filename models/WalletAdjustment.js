const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  source: { type: String, enum: ['deposit', 'manual_refund', 'admin_credit'], required: true },
  sourceId: { type: mongoose.Schema.Types.ObjectId, required: true },
  amountSyp: { type: String, required: true },
  balanceBeforeSyp: String,
  balanceAfterSyp: String,
  note: { type: String, maxlength: 1000 },
}, { timestamps: true });
schema.index({ user: 1, createdAt: -1 });
module.exports = mongoose.model('WalletAdjustment', schema);
