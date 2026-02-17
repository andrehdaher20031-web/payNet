const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
  },
  password: {
    type: String,
  },
  name: {
    type: String,
  },
  number: {
    type: String,
  },
  card: {
    cardInternet: { type: Boolean, default: true },
    cardSyriatel: { type: Boolean, default: true },
    cardPlay: { type: Boolean, default: true },
    cardapplication: { type: Boolean, default: true },
    usdtpay: { type: Boolean, default: true },
    viewapp: { type: Boolean, default: true },
    ai: { type: Boolean, default: true },
    cardPronet: { type: Boolean, default: false },
    cardHifi: { type: Boolean, default: false },
  },

  role: {
    type: String,
    required: true,
    default: "user"
  },
  balance: { type: Number, default: 0 }, // رصيد المشترك

});

module.exports = mongoose.model("User", userSchema);
