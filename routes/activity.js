const router = require('express').Router();
const User = require('../models/User');
const Activity = require('../models/UserActivity');
const service = require('../services/userActivity.service');
router.use(require('../middleware/authMiddleware'));
router.use(async (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    if (!await User.exists({ _id: req.user.id })) return res.sendStatus(401);
    const count = await Activity.countDocuments({ user: req.user.id, source: 'browser', occurredAt: { $gte: new Date(Date.now() - 60000) } });
    if (count >= 60) return res.sendStatus(429);
    next();
  } catch { res.sendStatus(503); }
});
router.post('/heartbeat', async (req, res) => {
  try { await service.touch(req.user.id); res.sendStatus(204); } catch { res.sendStatus(503); }
});
router.post('/events', async (req, res) => {
  const body = req.body || {};
  if (!['page_view', 'product_view', 'catalog_filter', 'checkout_started', 'checkout_failed', 'logout'].includes(body.eventType) ||
      (body.provider && !['alragheb', 'aleso', 'prowave', 'paynet'].includes(body.provider)) ||
      (body.productId != null && !/^[\w.-]{1,80}$/.test(String(body.productId))) ||
      (body.categoryId != null && !/^[\w.-]{1,80}$/.test(String(body.categoryId))) ||
      (body.route && (typeof body.route !== 'string' || !/^\/[a-zA-Z0-9/_-]{0,100}$/.test(body.route))) ||
      (body.errorCode != null && (body.eventType !== 'checkout_failed' || !service.safeCode(body.errorCode))) ||
      (body.eventType === 'checkout_failed' && (!body.productId || !body.provider || !service.safeCode(body.errorCode)))) return res.sendStatus(400);
  if (Object.keys(body).some(key => !['eventType', 'provider', 'productId', 'productName', 'categoryId', 'route', 'errorCode'].includes(key))) return res.sendStatus(400);
  try {
    await service.record({ ...body, source: 'browser', user: req.user.id,
      eventKey: `browser:${req.user.id}:${body.eventType}:${body.provider || ''}:${body.productId || body.categoryId || body.route || ''}:${Math.floor(Date.now() / 60000)}` });
    if (body.eventType !== 'logout') await service.touch(req.user.id);
    res.sendStatus(204);
  } catch { res.sendStatus(503); }
});
module.exports = router;
