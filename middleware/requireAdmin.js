const authenticate = require('./authMiddleware');
module.exports = async (req, res, next) => {
  if (!req.authenticatedUser) return authenticate(req, res, () => module.exports(req, res, next));
  if (req.authenticatedUser.role !== 'admin') return res.status(403).json({ message: 'هذه العملية مخصصة للمدير فقط', code: 'ADMIN_REQUIRED' });
  return next();
};
