const express = require('express');
const proWaveController = require('../controllers/proWave');
const authMiddleware = require('../middleware/authMiddleware');
const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();

router.get('/balance', proWaveController.getBalance);
router.get('/categories', proWaveController.getCategories);
router.get('/items', proWaveController.getItems);
router.get('/direct-topup/catalog', proWaveController.getDirectTopUpCatalog);
router.post('/quote', authMiddleware, proWaveController.createQuote);
router.get('/check-availability', proWaveController.checkAvailability);
router.post('/purchase-digital-card', authMiddleware, proWaveController.purchaseDigitalCard);
router.post('/direct-topup/request', authMiddleware, proWaveController.createDirectTopUpRequest);
router.post('/direct-topup/request-result', authMiddleware, proWaveController.getDirectTopUpRequestResult);
router.post('/direct-topup/requests', authMiddleware, requireAdmin, proWaveController.getDirectTopUpRequests);
router.post('/direct-topup/refresh-pending', authMiddleware, requireAdmin, proWaveController.refreshPendingDirectTopUpRequestStatuses);
router.get('/codes', proWaveController.getCodes);
router.get('/invoices', proWaveController.getInvoices);

module.exports = router;
