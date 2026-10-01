const express = require("express");
const router = express.Router();
const alraghebController = require("../controllers/alraghebController");
const authMiddleware = require('../middleware/authMiddleware');
const requireAdmin = require('../middleware/requireAdmin');
const requireChatApplications = require('../middleware/requireChatApplications');

router.use(authMiddleware);
router.get('/profile', requireAdmin, alraghebController.getProfile);
router.get('/products', requireChatApplications, alraghebController.getProducts);
router.get('/products/:productId', requireChatApplications, alraghebController.getProduct);
router.get('/content/:categoryId', requireChatApplications, alraghebController.getContent);
router.post('/quote', requireChatApplications, alraghebController.quote);
router.post('/order', alraghebController.order);
router.get('/orders', alraghebController.orderList);
router.get('/orders/:id', alraghebController.orderDetail);

module.exports = router;
