const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const authMiddleware = require('../middleware/authMiddleware');

const MAX_PRODUCTS_PER_PAGE = 60;

function toPositiveInteger(value, fallback) {
  const numberValue = Number.parseInt(value, 10);

  if (!Number.isFinite(numberValue) || numberValue < 1) {
    return fallback;
  }

  return numberValue;
}

function hasPaginationQuery(query) {
  return query.page !== undefined || query.limit !== undefined;
}

function getPagination(query) {
  const page = toPositiveInteger(query.page, 1);
  const requestedLimit = toPositiveInteger(query.limit, 20);
  const limit = Math.min(requestedLimit, MAX_PRODUCTS_PER_PAGE);

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildProductSearchFilter(searchTerm) {
  const safeSearchTerm = escapeRegex(searchTerm);

  return {
    $or: [
      { name: { $regex: safeSearchTerm, $options: 'i' } },
      { description: { $regex: safeSearchTerm, $options: 'i' } },
      { category: { $regex: safeSearchTerm, $options: 'i' } },
    ],
  };
}

async function sendProducts(req, res, filter = {}) {
  if (!hasPaginationQuery(req.query)) {
    const products = await Product.find(filter).sort({ _id: -1 }).lean();
    return res.status(200).json(products);
  }

  const { page, limit, skip } = getPagination(req.query);
  const [products, total] = await Promise.all([
    Product.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).lean(),
    Product.countDocuments(filter),
  ]);
  const totalPages = Math.max(Math.ceil(total / limit), 1);

  return res.status(200).json({
    data: products,
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  });
}

// إضافة منتج جديد
router.post('/add', async (req, res) => {
  try {
    const {
      name,
      price,
      description,
      category,
      imageUrl,
      stock,
      priceCost,
      priceWolesale,
    } = req.body;

    if (
      !name ||
      !price ||
      !description ||
      !category ||
      !imageUrl ||
      !priceCost ||
      !priceWolesale
    ) {
      return res.status(400).json({ message: 'البيانات غير مكتملة' });
    }

    const product = await Product.findOneAndUpdate(
      { name },
      {
        $inc: { stock: stock || 1 },
        $set: {
          price,
          priceCost,
          priceWolesale,
          description,
          category,
          imageUrl,
        },
      },
      {
        new: true,
        upsert: true,
      }
    );

    res.status(200).json({
      message: 'تمت إضافة المنتج أو تحديث الكمية بنجاح',
      product,
    });
  } catch (error) {
    console.error('خطأ:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء العملية' });
  }
});

router.get('/get-product', async (req, res) => {
  try {
    await sendProducts(req, res);
  } catch (err) {
    res.status(500).json({ message: 'حدث خطأ أثناء جلب المنتجات' });
  }
});

router.delete('/delete-product/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const deletedProduct = await Product.findByIdAndDelete(id);

    if (!deletedProduct) {
      return res.status(404).json({
        message: 'المنتج غير موجود',
      });
    }

    return res.status(200).json({
      message: 'تم حذف المنتج بنجاح',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      message: 'حدث خطأ أثناء حذف المنتج',
    });
  }
});

router.put('/update-product/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const {
      name,
      price,
      priceCost,
      priceWolesale,
      category,
      stock,
      description,
      imageUrl,
    } = req.body;

    const product = await Product.findById(id);

    if (!product) {
      return res.status(404).json({ message: 'المنتج غير موجود' });
    }

    // تحديث القيم (مع الحفاظ على القديمة إن لم تُرسل)
    product.name = name ?? product.name;
    product.price = price ?? product.price;
    product.priceCost = priceCost ?? product.priceCost;
    product.priceWolesale = priceWolesale ?? product.priceWolesale;
    product.category = category ?? product.category;
    product.stock = stock ?? product.stock;
    product.description = description ?? product.description;
    product.imageUrl = imageUrl ?? product.imageUrl;

    const updatedProduct = await product.save();

    res.status(200).json(updatedProduct);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: 'حدث خطأ أثناء تعديل المنتج',
    });
  }
});

router.get('/search-product', async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    const filter = name ? buildProductSearchFilter(name) : {};

    await sendProducts(req, res, filter);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: 'حدث خطأ أثناء البحث عن المنتجات',
    });
  }
});

module.exports = router;
