// models/InternetsaveNumber.js
const mongoose = require("mongoose");

const saveNumberSchema = new mongoose.Schema({
  landline: String,
  company: String,
  speed: String,
  email: String,
  amount: Number,
  paymentType: { type: String, enum: ["cash", "credit"], default: "cash" },
  status: {
    type: String,
    enum: ["جاري التسديد", "تم التسديد", "غير مسددة","بدء التسديد","حفظ الرقم"], // ← أضف "غير مسددة"
    default: "حفظ الرقم"
  },
  
  note: {
    type: String, // ← سبب الرفض، يمكن أن يكون فارغًا
    default: ""
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  date: {
    type: Date,
    default: Date.now
  },
  user: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "User",
  required: true,
}
});

module.exports = mongoose.model("saveNumber", saveNumberSchema);
