// models/InternetPayment.js
const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
  landline: String,
  company: String,
  speed: String,
  email: String,
  amount: Number,

  calculatedAmount: Number,
  paymentType: { type: String, enum: ["cash", "credit"], default: "cash" },
  status: {
    type: String,
    enum: [
      "جاري التسديد",
      "تم التسديد",
      "غير مسددة",
      "بدء التسديد",
      "قيد التنفيذ",
      "قيد التنفيذ لدى Prowave",
    ],
    default: "جاري التسديد"
  },
  extra: {
    type: mongoose.Schema.Types.Mixed,
    default:{},
  },
  note: {
    type: String, // ← سبب الرفض، يمكن أن يكون فارغًا
    default: ""
  },
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

paymentSchema.index({ status: 1, createdAt: -1 });
paymentSchema.index({ user: 1, createdAt: -1 });
paymentSchema.index({ email: 1, createdAt: -1 });
paymentSchema.index({ company: 1, status: 1, createdAt: -1 });
paymentSchema.index({
  user: 1,
  landline: 1,
  company: 1,
  speed: 1,
  amount: 1,
  email: 1,
  createdAt: -1,
});

module.exports = mongoose.model("Payment", paymentSchema);
