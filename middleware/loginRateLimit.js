const attempts = new Map();
module.exports = (req, res, next) => {
  const now = Date.now();
  const key = req.ip;
  for (const [ip, entry] of attempts) if (entry.until <= now) attempts.delete(ip);
  if (!attempts.has(key) && attempts.size >= 10000) return res.sendStatus(429);
  const entry = attempts.get(key) || { count: 0, until: now + 60000 };
  attempts.set(key, entry);
  if (++entry.count > 30) return res.status(429).json({ message: 'محاولات كثيرة؛ يرجى الانتظار دقيقة' });
  next();
};
