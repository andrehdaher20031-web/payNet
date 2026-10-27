const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  _id: String,
  version: { type: Number, required: true },
  categories: { type: [mongoose.Schema.Types.Mixed], required: true },
  products: { type: [mongoose.Schema.Types.Mixed], required: true },
  synced_at: { type: String, required: true },
}, { versionKey: false });

module.exports = mongoose.model('AlraghebCatalogSnapshot', schema);
