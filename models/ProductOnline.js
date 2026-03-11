const mongoose = require('mongoose');


const CardSchema = new mongoose.Schema({
  title: String,
  description: String,
  name: String,
  price: Number,
  priceOnweb: Number,
  min: Number,
  multiplier: Number,
  url: String,
  btntext: String,
  btnbg: String,
  hoverbtn: String,
  spanbg: String,
  bgdown: String,
  image: String,
  border: String,
});

const ProductSchema = new mongoose.Schema({
  name: String,
  type: String,
  note: String,
  cards: [CardSchema]
});

module.exports = mongoose.model('ProductOnline', ProductSchema);