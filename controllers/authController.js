const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { randomUUID } = require('crypto');
const { verifyPassword } = require('../utils/passwords');
const activity = require('../services/userActivity.service');

exports.login = async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || !password || email.length > 200 || Buffer.byteLength(password) > 1024) {
    return res.status(400).json({ message: 'بيانات الدخول غير صحيحة' });
  }

  try {
    if (!process.env.JWT_SECRET) {
      console.error("Login configuration error: JWT_SECRET is missing");
      return res.status(503).json({ message: "إعدادات تسجيل الدخول غير مكتملة على الخادم" });
    }

    // تحقق من وجود المستخدم
    const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+password +passwordHash +passwordScheme');
    if (!user) {
      await activity.safeRecord({ eventType: 'login_failed', status: 'failed', errorCode: 'INVALID_CREDENTIALS', device: activity.deviceLabel(req.get('user-agent')) });
      return res.status(401).json({ message: "اسم المستخدم أو كلمة المرور غير صحيحة" });
    }

    // تحقق من كلمة المرور
    const isMatch = await verifyPassword(password, user);
    if (!isMatch) {
      await activity.safeRecord({ user: user._id, eventType: 'login_failed', status: 'failed', errorCode: 'INVALID_CREDENTIALS', device: activity.deviceLabel(req.get('user-agent')) });
      return res.status(401).json({ message: "اسم المستخدم أو كلمة المرور غير صحيحة" });
    }

    const now = new Date();
    const changes = { $set: { lastLoginAt: now, lastSeenAt: now }, $inc: { loginCount: 1 } };
    if (user.passwordHash) {
      changes.$set.password = password;
      changes.$unset = { passwordHash: 1, passwordScheme: 1 };
    }
    const identity = { _id: user._id, $or: [{ authVersion: Number(user.authVersion || 0) }, { authVersion: { $exists: false } }] };
    if (!user.passwordHash) identity.password = user.password;
    else identity.passwordHash = user.passwordHash;
    // The credential is unchanged, so migration must not revoke the current session.
    const updated = await User.collection.updateOne(identity, changes);
    if (!updated.matchedCount) return res.status(409).json({ message: 'تغيرت بيانات الحساب، يرجى إعادة تسجيل الدخول' });
    const sessionId = randomUUID();
    await activity.safeRecord({ user: user._id, eventType: 'login_success', status: 'completed', sessionId, device: activity.deviceLabel(req.get('user-agent')) });

    // توليد Token
    const token = jwt.sign({ id: user._id, email: user.email, role: user.role, sid: sessionId, av: Number(user.authVersion || 0) }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({
      message: "تم تسجيل الدخول بنجاح",
      token,
      user: { id: user._id, email: user.email },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ message: "حدث خطأ أثناء تسجيل الدخول" });
  }
};
