const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  markupPercent: String, markupFixedSyp: String,
  products: [{ _id: false, productId: Number, revision: Number, contractHash: String, providerPrice: String }],
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  usedAt: Date,
}, { timestamps: true });
module.exports = mongoose.model('AlraghebPricingBatch', schema);
