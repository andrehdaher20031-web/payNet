const mongoose = require('mongoose');
const User = require('../models/User');

module.exports = async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.user?.id)) {
    return res.status(401).json({ message: 'المستخدم غير موجود' });
  }
  try {
    const user = await User.findById(req.user.id).select('role card.cardapplication').lean();
    if (!user) return res.status(401).json({ message: 'المستخدم غير موجود' });
    if (user.role !== 'admin' && user.card?.cardapplication !== true) {
      return res.status(403).json({ message: 'تطبيقات الدردشة غير مفعلة لهذا الحساب' });
    }
    return next();
  } catch {
    return res.status(503).json({ message: 'تعذر التحقق من صلاحية الحساب' });
  }
};
