const router = require('express').Router();
const authMiddleware = require('../middleware/authMiddleware');
const requireAdmin = require('../middleware/requireAdmin');
const controller = require('../controllers/alraghebController');

router.use(authMiddleware, requireAdmin);
router.get('/products', controller.getAdminProducts);
router.post('/catalog/refresh', controller.refreshCatalog);
router.get('/pricing/rules', controller.pricingRules);
router.put('/pricing/rules/:categoryId', controller.savePricingRule);
router.post('/pricing/preview', controller.previewMarkup);
router.post('/pricing/apply', controller.applyMarkup);
router.patch('/products/:productId', controller.saveConfig);
router.get('/products/:productId/history', controller.configHistory);
router.get('/transactions', controller.adminOrderList);
router.get('/summary', controller.summary);
router.post('/transactions/:id/check', controller.checkOrder);

module.exports = router;
