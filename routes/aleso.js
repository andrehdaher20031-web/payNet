const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const requireAdmin = require('../middleware/requireAdmin');
const alesoController = require('../controllers/aleso');

const trueValues = new Set(['1', 'true', 'yes', 'on']);

const isAlesoApiEnabled = () =>
  trueValues.has(String(process.env.ALESO_API_ENABLED || '').trim().toLowerCase());

const requireAlesoApiEnabled = (_req, res, next) => {
  if (!isAlesoApiEnabled()) {
    return res.status(503).json({
      status: 'disabled',
      code: 'ALESO_DISABLED',
      message: 'Aleso API is temporarily disabled.',
    });
  }

  return next();
};

router.use(requireAlesoApiEnabled);

router.get('/products', alesoController.getProducts);
router.get('/content/:categoryId', alesoController.getContent);

router.get('/profile', authMiddleware, requireAdmin, alesoController.getProfile);
router.post('/quote', authMiddleware, alesoController.createQuote);
router.post('/order', authMiddleware, alesoController.purchaseProduct);
router.post('/check-orders', authMiddleware, alesoController.checkOrders);
router.post('/refresh-pending', authMiddleware, requireAdmin, alesoController.refreshPendingOrders);

module.exports = router;
