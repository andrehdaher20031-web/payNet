const User = require("../models/User");
const jwt = require("jsonwebtoken");
const Balance = require("../models/Balance");

exports.login = async (req, res) => {
  const { email, password } = req.body;
  const balanceDaen = await Balance.findOne({}).sort({ _id: -1 });
  console.log(balanceDaen.amountDaen)


  try {
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
    res.status(500).json({ message: "حدث خطأ أثناء تسجيل الدخول" });
  }
};
