const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const authError = (message, status = 401, code = 'UNAUTHORIZED') => Object.assign(new Error(message), { status, code });

// Tokens identify sessions; permissions are always read from the current account.
const authenticateToken = async (token) => {
  if (!process.env.JWT_SECRET) throw authError('إعدادات تسجيل الدخول غير مكتملة', 503, 'AUTH_NOT_CONFIGURED');
  if (typeof token !== 'string' || !token || token.length > 8192) throw authError('لم يتم توفير توكن');
  let decoded;
  try { decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }); }
  catch (error) { throw authError(error.name === 'TokenExpiredError' ? 'انتهت صلاحية التوكن' : 'توكن غير صالح'); }
  if (!mongoose.isValidObjectId(decoded?.id)) throw authError('توكن غير صالح');
  let user;
  try { user = await User.findById(decoded.id).select('email role card authVersion').lean(); }
  catch { throw authError('تعذر التحقق من صلاحية الحساب', 503, 'AUTH_UNAVAILABLE'); }
  if (!user || Number(decoded.av || 0) !== Number(user.authVersion || 0)) throw authError('انتهت صلاحية الجلسة، يرجى تسجيل الدخول');
  return { ...decoded, id: String(user._id || decoded.id), email: user.email, role: user.role, card: user.card, av: Number(user.authVersion || 0) };
};

const authMiddleware = async (req, res, next) => {
  if (req.authenticatedUser) return next();
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  try {
    req.user = await authenticateToken(match?.[1]);
    req.authenticatedUser = req.user;
    return next();
  } catch (error) {
    return res.status(error.status || 401).json({ message: error.message, code: error.code || 'UNAUTHORIZED' });
  }
};
module.exports = authMiddleware;
module.exports.authenticateToken = authenticateToken;
