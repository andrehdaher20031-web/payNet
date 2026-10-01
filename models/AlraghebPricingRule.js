const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  categoryId: { type: Number, unique: true, required: true },
  categoryName: { type: String, required: true },
  markupPercent: { type: String, default: '0' },
  markupFixedSyp: { type: String, default: '0' },
  revision: { type: Number, default: 1 },
  note: { type: String, required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('AlraghebPricingRule', schema);
