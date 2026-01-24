const express = require("express");
const router = express.Router();
const Product = require("../models/Product");
const Invoice = require("../models/Invoice");
const { route } = require("./admin");
router.post('/create-invoice', async (req, res) => {
    try {
        const { items, total, customerName, customerPhone } = req.body;

        if (!items || !Array.isArray(items) || items.length === 0 || !total || !customerName || !customerPhone) {
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
        const paymentAmount = -total;

        // 3️⃣ إنشاء الفاتورة
        const newInvoice = new Invoice({
            items: invoiceItems,
            total,
            customerName,
            customerPhone,
            paymentAmount
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
        // استرجاع الكميات للمخزون
        for (const item of invoice.items) {
            const product = await Product.findById(item._id);
            if (product) {
                product.stock += item.stock;
                await product.save();
            }
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

        // احفظ العنصر قبل الحذف
        const deletedItem = invoice.items.find(
            item => item._id.toString() === req.params.itemId
        );

        // احذفه من الفاتورة
        invoice.items = invoice.items.filter(
            item => item._id.toString() !== req.params.itemId
        );

        // رجّع الكمية للمخزون
        if (deletedItem) {
            const product = await Product.findById(deletedItem._id);
            if (product) {
                product.stock += deletedItem.stock;

                await product.save();
            }
        }

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
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "خطأ في السيرفر" });
    }
})

router.put('/add-bill-items/:id', async (req, res) => {
    const invoiceId = req.params.id;
    const { items, initialItems } = req.body;
    let total = 0;
    try {
        const invoice = await Invoice.findById(invoiceId);
        if (!invoice) {
            return res.status(404).json({ message: "الفاتورة غير موجودة" });
        }
        const oldProductIds = initialItems.map(i => i._id);
        const products = await Product.find({ _id: { $in: oldProductIds } });
        // استرجاع الكميات القديمة
        for (const oldItem of initialItems) {
            const product = products.find(p => p._id.toString() === oldItem._id);
            product.stock += oldItem.stock;
            await product.save();
        }
        const newProductIds = items.map(i => i._id);
        const newAllProducts = [...newProductIds, ...oldProductIds];
        const newProducts = await Product.find({ _id: { $in: newAllProducts } });
        // خصم الكميات الجديدة
        for (const newItem of items) {
            const product = newProducts.find(p => p._id.toString() === newItem._id);
            if (product.stock < newItem.stock) {
                return res.status(400).json({
                    message: `الكمية غير كافية للمنتج ${product.name}`
                });
            }
            total += newItem.price * newItem.stock;
            invoice.paymentAmount = invoice.paymentAmount + (invoice.total - total);
            invoice.total = total;
            product.stock -= newItem.stock;
            await product.save();
        }
        invoice.items = items.map(i => ({
            _id: i._id,
            name: i.name,
            stock: i.stock,
            price: i.price

        }));
        await invoice.save();
        res.status(200).json({ message: "تم تعديل الفاتورة بنجاح" });
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ message: "خطأ في السيرفر" });
    }

});

router.post('/new-payment/:id', async (req, res) => {
    const { amount, date, details, FormTitle } = req.body;
    try {
        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) {
            return res.status(404).json({ message: "الفاتورة غير موجودة" });
        }
        invoice.payments.push({ amount, date, details, FormTitle });
        if (FormTitle === "اضافة دفعة") {
            invoice.paymentAmount += amount;
        } else if (FormTitle === "اضافة فاتورة") {
            invoice.paymentAmount -= amount;
        }

        await invoice.save();
        res.status(200).json({ message: "تم إضافة الدفع بنجاح" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "خطأ في السيرفر" });
    }

});

router.delete('/delete-payment/:id/delete-payment/:paymentId', async (req, res) => {
    try {
        const invoice = await Invoice.findById(req.params.id);
        if (!invoice) {
            return res.status(404).json({ message: "الفاتورة غير موجودة" });
        }

        const payment = invoice.payments.find(
            p => p._id.toString() === req.params.paymentId
        )
        if (!payment) {
            return res.status(404).json({ message: "الدفع غير موجود" });
        }
        if (payment.FormTitle === "اضافة دفعة") {
            invoice.paymentAmount -= payment.amount;
        } else if (payment.FormTitle === "اضافة فاتورة") {
            invoice.paymentAmount += payment.amount;
        }
        
 




        invoice.payments = invoice.payments.filter(
            payment => payment._id.toString() !== req.params.paymentId
        );
        await invoice.save();
        res.status(200).json({ message: "تم حذف الدفع بنجاح" });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "خطأ في السيرفر" });
    }
});

module.exports = router;