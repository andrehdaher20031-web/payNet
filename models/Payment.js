// models/InternetPayment.js
const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
  landline: String,
  company: String,
  speed: String,
  email: String,
  amount: Number,
  paymentType: { type: String, enum: ["cash", "credit"], default: "cash" },
  status: {
    type: String,
    enum: ["جاري التسديد", "تم التسديد", "غير مسددة","بدء التسديد"], // ← أضف "غير مسددة"
    default: "جاري التسديد"
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

module.exports = mongoose.model("Payment", paymentSchema);
