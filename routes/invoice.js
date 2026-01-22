const express = require("express");
const router = express.Router();
const Product = require("../models/Product");
const Invoice = require("../models/Invoice");
router.post('/create-invoice', async (req, res) => {
    try {
        const { items, total, customerName, customerPhone } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ message: "البيانات غير مكتملة" });
        }

        const productIds = items.map(i => i._id);
        const products = await Product.find({ _id: { $in: productIds } });

        if (products.length !== items.length) {
            return res.status(400).json({ message: "بعض المنتجات غير موجودة" });
        }

        // 1️⃣ التحقق من توفر الكمية
        for (const item of items) {
            const product = products.find(p => p._id.toString() === item._id);

            if (product.stock < item.quantity) {
                return res.status(400).json({
                    message: `الكمية غير كافية للمنتج ${product.name}`
                });
            }
        }

        // 2️⃣ تجهيز عناصر الفاتورة + خصم الكمية
        const invoiceItems = [];

        for (const item of items) {
            const product = products.find(p => p._id.toString() === item._id);

            // خصم الكمية من المخزون
            product.stock -= item.quantity;
            await product.save();

            invoiceItems.push({
                _id: product._id,
                name: product.name,
                quantity: item.quantity,
                price: product.price
            });
        }

        // 3️⃣ إنشاء الفاتورة
        const newInvoice = new Invoice({
            items: invoiceItems,
            total,
            customerName,
            customerPhone
        });


        await newInvoice.save();

        res.status(201).json({
            message: "تم إنشاء الفاتورة بنجاح",
            invoiceId: newInvoice._id
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "خطأ في السيرفر" });
    }
});

router.get('/viewBills', async (req, res) => {
    try {
        const invoices = await Invoice.find().sort({ createdAt: -1 });
        res.status(200).json(invoices);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "خطأ في السيرفر" });
    }
});
router.get('/viewBills/:id', async (req, res) => {
    try {
        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) {
            return res.status(404).json({ message: "الفاتورة غير موجودة" });
        }
        res.status(200).json(invoice);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "خطأ في السيرفر" });
    }
});

router.delete('/delete-bill/:id', async (req, res) => {
    try {
        const invoice = await Invoice.findByIdAndDelete(req.params.id);
        if (!invoice) {
            return res.status(404).json({ message: "الفاتورة غير موجودة" });
        }
        res.status(200).json({ message: "تم حذف الفاتورة بنجاح" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "خطأ في السيرفر" });
    }
});
router.delete('/delete-bill-items/:id/delete-item/:itemId', async (req, res) => {

    try {
        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) {
            return res.status(404).json({ message: "الفاتورة غير موجودة" });
        }
        invoice.items = invoice.items.filter(item => item._id.toString() !== req.params.itemId);
        await invoice.save();
        if (invoice.items.length === 0) {
            await Invoice.findByIdAndDelete(req.params.id);
            return res.status(200).json({ message: "تم حذف العنصر والفاتورة لأنها أصبحت فارغة" });
        }
        res.status(200).json({ message: "تم حذف العنصر من الفاتورة بنجاح" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "خطأ في السيرفر" });
    }
    
});

router.post('/add-bill-items/:id', async (req, res) => {
    try {
        const id = req.params.id;
        console.log(id)
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "خطأ في السيرفر" });
    }
})

module.exports = router;