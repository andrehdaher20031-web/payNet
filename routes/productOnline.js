const expess = require('express');
const router = expess.Router();
const ProductOnline = require("../models/ProductOnline");
const midaleware = require("../middleware/auth");
const { cache, cacheKey, getOrSet } = require("../services/cache.service");

const invalidateProductOnlineCache = async () => {
    await cache.delByPrefix("productOnline:");
};

router.get('/get-product-online', async (req, res) => {
    try {
        const name = req.query.name
        const products = await getOrSet(cacheKey("productOnline:by-name", { name }), 300, () =>
            ProductOnline.find({ name: name }).select('name type note cards').lean()
        );
        const card = products.map(p => p.cards)
        res.status(201).json({ card, products });
    } catch (err) {
        res.status(500).json({ message: "حدث خطأ أثناء جلب المنتجات" });
    }
})

router.get('/get-product-online/name', async (req, res) => {

    try {
        const productName = await getOrSet(cacheKey("productOnline:names", req.query), 300, () =>
            ProductOnline.find().select('name type note').sort({ name: 1 }).lean()
        );
        res.status(201).json({ productName });
    } catch (err) {
        res.status(500).json({ message: "حدث خطأ أثناء جلب أسماء المنتجات" });
    }
})

router.get('/get-product-online/name/:id', async (req, res) => {

    try {
        const id = req.params.id
        const products = await ProductOnline.findById(id).select('cards').lean()
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
        await invalidateProductOnlineCache()

        res.json({
            message: "Product updated successfully",
            product
        })

    } catch (err) {
        res.status(500).json({ message: 'حدث خطأ في تعديل المنتج' })
    }
})

router.post('/add-card/:id', async (req, res) => {
    const id = req.params.id
    const formData = req.body
    try {

        const productInsert = await ProductOnline.findById(id)
        if (!productInsert) {
            return res.status(404).json({ message: "المنتج غير موجود" });
        }

        productInsert.cards.push(formData)
        await productInsert.save()
        await invalidateProductOnlineCache()
        res.status(201).json({ message: 'تم اضافة البطاقة بنجاح' })


    }
    catch (err) {
        console.log(err)
        res.status(500).json({ message: 'حدث خطأ اثناء اضافة البطاقة' })
    }

})


router.delete('/delete/:id', async (req, res) => {
    const id = req.params.id
    try {
        const productDelete = await ProductOnline.findOne({ 'cards._id': id })
        if (!productDelete) {
            return res.status(400).json({ message: 'العنصر غير موجود' })
        }
        productDelete.cards.pull({ _id: id })
        await productDelete.save();
        await invalidateProductOnlineCache()

        res.status(201).json({ message: "تم حذف البطاقة بنجاح" });
    }
    catch (err) {
        console.log(err)
        res.status(500).json({ message: 'حدث خطأ اثناء حذف المنتج' })
    }
})

router.post('/addType', async (req, res) => {
    try {

        const { name, type, note } = req.body;

        // التحقق من البيانات
        if (!name) {
            return res.status(400).json({
                message: "اسم المنتج مطلوب"
            });
        }

        const cleanName = name.trim();

        // التحقق من وجود المنتج

        const existingProduct = await ProductOnline.findOne({
            name: { $regex: `^${cleanName}$`, $options: "i" }
        });

        if (existingProduct) {
            return res.status(409).json({
                message: "المنتج موجود مسبقاً"
            });
        }

        // إنشاء المنتج
        const newProduct = await ProductOnline.create({
            name: cleanName,
            type,
            note,
            cards: []
        });
        await invalidateProductOnlineCache()

        res.status(201).json({
            message: "تم إضافة المنتج بنجاح",
            product: newProduct
        });

    } catch (error) {

        console.error(error);

        res.status(500).json({
            message: "حدث خطأ في السيرفر"
        });

    }
});




module.exports = router
