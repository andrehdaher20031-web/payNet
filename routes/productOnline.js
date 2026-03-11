const expess = require('express');
const router = expess.Router();
const ProductOnline = require("../models/ProductOnline");
const midaleware = require("../middleware/auth");

router.get('/get-product-online', async (req, res) => {
    const name = req.query.name
    const products = await ProductOnline.find({ name: name });
    const card = products.map(p => p.cards)
    try {
        res.status(201).json({ card, products });
    } catch (err) {
        res.status(500).json({ message: "حدث خطأ أثناء جلب المنتجات" });
    }
})

router.get('/get-product-online/name', async (req, res) => {

    const productName = await ProductOnline.find().select('name type note');
    try {
        res.status(201).json({ productName });
    } catch (err) {
        res.status(500).json({ message: "حدث خطأ أثناء جلب أسماء المنتجات" });
    }
})

router.get('/get-product-online/name/:id', async (req, res) => {

    try {
        const id = req.params.id
        const products = await ProductOnline.findById(id)
        res.status(201).json(products.cards)

    } catch (err) {
        res.status(500).json({ message: "حدث خطأ أثناء جلب أسماء المنتجات" })
    }
})

router.put('/update/:id', async (req, res) => {
    try {

        const { id } = req.params
        const data = req.body

        const product = await ProductOnline.findOne({
            "cards._id": id
        })

        if (!product) {
            return res.status(404).json({ message: "Product not found" })
        }

        const card = product.cards.id(id)

        card.title = data.title
        card.description = data.description
        card.price = data.price
        card.priceOnweb = data.priceOnweb

        await product.save()

        res.json({
            message: "Product updated successfully",
            product
        })

    } catch (err) {
        res.status(500).json({ message: 'حدث خطأ في تعديل المنتج' })
    }
})




module.exports = router