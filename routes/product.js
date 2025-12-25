const express = require("express");
const router = express.Router();
const Product = require("../models/Product");
const authMiddleware = require("../middleware/authMiddleware");

// إضافة منتج جديد
router.post("/add", async (req, res) => {
  try {
    console.log(req.body)
    const { name, price, description, category, imageUrl, stock } = req.body;
    if (!name || !price || !description || !category || !imageUrl) {
      return res.status(400).json({ message: "البيانات غير مكتملة" });
    }
    const newProduct = new Product({
      name,
      price,
      description,
      category,
      imageUrl,
      stock: stock || 1,
    });
    await newProduct.save();
    res.status(201).json({ message: "تم إضافة المنتج بنجاح", product: newProduct });
  } catch (error) {
    console.error("خطأ في إضافة المنتج:", error);
    res.status(500).json({ message: "حدث خطأ أثناء إضافة المنتج" });
  }
});


router.get('/get-product', async (req, res) => {
  const products = await Product.find({});
  try {
    res.status(201).json(products)

  } catch (err) {
    res.status(500).json({ message: "حدث خطأ أثناء جلب المنتجات" });
  }

})
router.delete('/delete-product/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const deletedProduct = await Product.findByIdAndDelete(id);

    if (!deletedProduct) {
      return res.status(404).json({
        message: 'المنتج غير موجود'
      });
    }

    return res.status(200).json({
      message: 'تم حذف المنتج بنجاح'
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: 'حدث خطأ أثناء حذف المنتج'
    });
  }
});

router.put('/update-product/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const {
      name,
      price,
      category,
      stock,
      description,
      imageUrl,
    } = req.body;

    const product = await Product.findById(id);

    if (!product) {
      return res.status(404).json({ message: "المنتج غير موجود" });
    }

    // تحديث القيم (مع الحفاظ على القديمة إن لم تُرسل)
    product.name = name ?? product.name;
    product.price = price ?? product.price;
    product.category = category ?? product.category;
    product.stock = stock ?? product.stock;
    product.description = description ?? product.description;
    product.imageUrl = imageUrl ?? product.imageUrl;

    const updatedProduct = await product.save();

    res.status(200).json(updatedProduct);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "حدث خطأ أثناء تعديل المنتج",
    });
  }

});



module.exports = router;