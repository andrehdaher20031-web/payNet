// routes/balanceRoutes.js
const express = require("express");
const router = express.Router();
const Balance = require("../models/Balance");
const User = require("../models/User");
const authMiddleware = require("../middleware/auth"); // تحقق من تسجيل الدخول

// POST /api/pay
router.post("/haram", authMiddleware, async (req, res) => {
  try {
    const { destination,name,number, operator, noticeNumber, amount ,date} = req.body;
    const userId = req.user.id;
    const balanceDaen = await Balance.findOne({}).sort({_id:-1});
    const amountDaen = balanceDaen.amountDaen || 0;
    

    // خصم الرصيد من حساب المستخدم
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

  

    // حفظ عملية الدفع
    const balanceDoc  = new Balance({
      user: userId,
      destination,
      name,
      number,
      operator,
      noticeNumber,
      amount,
      date, 
      amountDaen,


    });


    await balanceDoc .save();

    res.status(200).json({ mescsage: "تمت العملية بنجاح" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "خطأ في الخادم" });
  }
});



router.get("/all", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const payments = await Balance.find({ user: userId }).sort({ date: -1 });
    res.json(payments);
  } catch (error) {
    console.error("خطأ في جلب الدفعات:", error);
    res.status(500).json({ message: "حدث خطأ في الخادم" });
  }
});



router.get("/all-admin", async (req, res) => {
  try {
    const payments = await Balance.find().sort({ date: -1 });
    res.json(payments);
  } catch (error) {
    console.error("خطأ في جلب الدفعات:", error);
    res.status(500).json({ message: "حدث خطأ في الخادم" });
  }
});

module.exports = router;
