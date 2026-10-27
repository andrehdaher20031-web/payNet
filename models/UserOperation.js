const mongoose = require('mongoose');
// A rebuildable read model. Financial records remain the authority for balances.
const schema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, required: true },
  sourceModel: String, referenceId: String, paymentId: String,
  provider: String, kind: String, productId: String, productName: String,
  quantity: Number, amountSyp: String, refundedSyp: String,
  status: String, errorCode: String,
  occurredAt: Date, sourceUpdatedAt: Date, observedAt: Date,
}, { versionKey: false });
schema.index({ user: 1, occurredAt: -1, _id: -1 });
schema.index({ user: 1, status: 1, occurredAt: -1 });
schema.index({ user: 1, provider: 1, productId: 1, occurredAt: -1 });
schema.index({ provider: 1, occurredAt: -1 });
module.exports = mongoose.model('UserOperation', schema);
