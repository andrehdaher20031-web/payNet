const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  productId: { type: Number, index: true },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  before: mongoose.Schema.Types.Mixed, after: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
module.exports = mongoose.model('AlraghebConfigAudit', schema);
