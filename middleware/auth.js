// middleware/auth.js
const jwt = require("jsonwebtoken");

module.exports = function (req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "غير مصرح" });

  try {
    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ message: "خطأ في إعدادات الخادم" });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: "انتهت صلاحية الرمز المميز" });
    } else if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: "رمز مميز غير صالح" });
    } else {
      return res.status(401).json({ message: "رمز مميز غير صالح" });
    }
  }
};
