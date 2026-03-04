const expess = require('express');
const router = expess.Router();
const ProductOnline = require("../models/ProductOnline");
const midaleware = require("../middleware/auth");

router.get('/get-product-online', async (req, res) => {
    const name = req.query.name
    const products = await ProductOnline.find({ name: name });
    const card = products.map(p => p.cards)
    try {
        res.status(201).json({card, products});
    } catch (err) {
        res.status(500).json({ message: "حدث خطأ أثناء جلب المنتجات" });
    }
})





module.exports = router