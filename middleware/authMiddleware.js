// middleware/authMiddleware.js
const jwt = require("jsonwebtoken");

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "لم يتم توفير توكن" });
  }

  const token = authHeader.split(" ")[1];

  try {
    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ message: "خطأ في إعدادات الخادم" });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // يحتوي على id
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: "انتهت صلاحية التوكن" });
    } else if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: "توكن غير صالح" });
    } else {
      return res.status(401).json({ message: "توكن غير صالح" });
    }
  }
};

module.exports = authMiddleware;
