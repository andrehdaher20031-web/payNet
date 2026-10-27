// models/InternetPayment.js
const mongoose = require("mongoose");

const balanceSchema = new mongoose.Schema({
  destination: String,
  name: String,
  number: Number,
  operator: String,
  amount: Number,
  noticeNumber: String,
  amountDaen: { type: Number },
  date: { type: Date, default: Date.now },  // 👈 تلقائياً ياخذ التاريخ الحالي
  isConfirmed: { type: Boolean, default: false },
  confirmedAt: Date,
  confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  clientRequestId: String,
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
}, { timestamps: { createdAt: false, updatedAt: true } });
balanceSchema.index({ updatedAt: 1 });

balanceSchema.index({ user: 1, date: -1 });
balanceSchema.index({ destination: 1, date: -1 });
balanceSchema.index({ name: 1, date: -1 });
balanceSchema.index({ status: 1, date: -1 });
balanceSchema.index({ noticeNumber: 1 }, { sparse: true });
balanceSchema.index({ noticeNumber: 1 }, { name: 'verified_notice_unique', unique: true, partialFilterExpression: { noticeNumber: { $type: 'string' } } });
balanceSchema.index({ user: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });

module.exports = mongoose.model("Haram", balanceSchema);
