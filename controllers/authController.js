const User = require("../models/User");
const jwt = require("jsonwebtoken");

exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    if (!process.env.JWT_SECRET) {
      console.error("Login configuration error: JWT_SECRET is missing");
      return res.status(503).json({ message: "إعدادات تسجيل الدخول غير مكتملة على الخادم" });
    }

    // تحقق من وجود المستخدم
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: "البريد الإلكتروني غير صحيح" });
    }

    // تحقق من كلمة المرور
    const isMatch = user.password === password;
    if (!isMatch) {
      return res.status(401).json({ message: "كلمة المرور غير صحيحة" });
    }

    // توليد Token
    const token = jwt.sign({ id: user._id, email: user.email, role: user.role  }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({
      message: "تم تسجيل الدخول بنجاح",
      token,
      user: { id: user._id, email: user.email},
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ message: "حدث خطأ أثناء تسجيل الدخول" });
  }
};
