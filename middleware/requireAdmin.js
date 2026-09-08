const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ message: 'هذه العملية مخصصة للأدمن فقط' });
  }

  next();
};

module.exports = requireAdmin;
