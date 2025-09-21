// routes/userRoutes.js
const express = require("express");
const router = express.Router();
const User = require("../models/User");
const authMiddleware = require("../middleware/authMiddleware");

// GET /api/user/balance
router.get("/balance", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("balance");
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    res.json({ balance: user.balance });
  } catch (err) {
    res.status(500).json({ message: "حدث خطأ داخلي" });
  }
});


router.post("/", async (req, res) => {
  try {
    const { name, email, number, password, balance, role } = req.body;

    // تحقق إذا كان المستخدم موجود
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "المستخدم موجود مسبقاً" });
    }

    // تشفير كلمة المرور

    const newUser = new User({
      name,
      email,
      number,
      password,
      balance,
      role,
    });

    await newUser.save();
    res.status(201).json({ message: "تم إنشاء المستخدم بنجاح" });
  } catch (err) {
    res.status(500).json({ message: "خطأ في الخادم", error: err.message });
  }
});


module.exports = router;
