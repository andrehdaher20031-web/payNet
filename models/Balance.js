// models/InternetPayment.js
const mongoose = require("mongoose");

const balanceSchema = new mongoose.Schema({
  destination: String,
  name: String,
  number: Number,
  operator: String,
  amount: Number,
  noticeNumber: Number,
  amountDaen: { type: Number },
  date: { type: Date, default: Date.now },  // 👈 تلقائياً ياخذ التاريخ الحالي
  isConfirmed: { type: Boolean, default: false },
  status: { type: Boolean, default: true },
  createdAt: {
    type: Date,
    default: Date.now
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  }
});

balanceSchema.index({ user: 1, date: -1 });
balanceSchema.index({ destination: 1, date: -1 });
balanceSchema.index({ name: 1, date: -1 });
balanceSchema.index({ status: 1, date: -1 });
balanceSchema.index({ noticeNumber: 1 }, { sparse: true });

module.exports = mongoose.model("Haram", balanceSchema);
