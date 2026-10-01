const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  productId: { type: Number, unique: true, required: true },
  purchaseEnabled: { type: Boolean, default: false },
  billingUnitQty: { type: Number, required: true },
  markupPercent: { type: String, default: '0' },
  markupFixedSyp: { type: String, default: '0' },
  fieldSchema: [{ _id: false, key: String, label: String, required: Boolean }],
  contractHash: { type: String, required: true },
  revision: { type: Number, default: 1 },
  orderSequence: { type: Number, default: 0 },
  note: { type: String, required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
module.exports = mongoose.model('AlraghebProductConfig', schema);
