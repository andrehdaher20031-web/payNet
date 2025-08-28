// models/Point.js
const mongoose = require('mongoose');
const pointSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true, // اسم المستخدم إلزامي
      trim: true,
    },

    balance: {
      type: Number,
      min: 0,
    default: "0"
      
    },
    owner: {
      type: String,
      required: true, // صاحب النقطة
      trim: true,
    },
    createdAt: {
      type: Date,
      default: Date.now, // وقت الإنشاء
    },
    email: {
      type: String,
      required: true, // البريد المستخرج من التوكن
      trim: true,
      lowercase: true,
    },
  },
  {
    timestamps: true, // يضيف createdAt و updatedAt تلقائياً
  }
);

const Point = mongoose.model("Point", pointSchema);

module.exports = Point; // هذا السطر مهم جداً
