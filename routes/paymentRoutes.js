// routes/paymentRoutes.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Payment = require("../models/Payment"); // تأكد أنك استوردت Payment
const authMiddleware = require("../middleware/authMiddleware");

router.post("/internet-full", authMiddleware, async (req, res) => {
  try {
    const { landline, company, speed, amount, email , paymentType } = req.body;
    const userId = req.user.id;

    if (!landline || !company || !speed || !amount) {
      return res.status(400).json({ message: "البيانات غير مكتملة" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "المستخدم غير موجود" });
    }

    const amountToDeduct = parseFloat((amount * 1.05).toFixed(2));
    if (user.balance < amountToDeduct) {
      return res.status(400).json({ message: "الرصيد غير كافٍ" });
    }

    // 💡 تحقق من التكرار: هل تم تنفيذ نفس الطلب خلال آخر دقيقة؟
    const recentDuplicate = await Payment.findOne({
      user: userId,
      landline,
      company,
      speed,
      amount,
      email,
      createdAt: { $gt: new Date(Date.now() - 60 * 1000) }
    });


    // خصم الرصيد
    user.balance -= amountToDeduct;
    await user.save();

    // تسجيل العملية
    const payment = new Payment({
      user: userId,
      landline,
      company,
      speed,
      amount,
      paymentType,
      email,
      status: "جاري التسديد",
    });
    await payment.save();

    const io = req.app.get("io");
if (io) {
  const pendingPayments = await Payment.find({ status: { $in: ["جاري التسديد", "بدء التسديد"] } });
  io.emit("pendingPaymentsUpdate", pendingPayments);
}


    res.status(200).json({
      message: "تمت العملية بنجاح",
      newBalance: user.balance,
    });

  } catch (err) {
    console.error("❌ خطأ أثناء تسديد الإنترنت:", err);
    res.status(500).json({ message: "حدث خطأ أثناء العملية" });
  }
});

module.exports = router;
