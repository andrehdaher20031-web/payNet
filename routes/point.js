const express = require("express");
const router = express.Router();
const User = require('../models/User');
const Point = require("../models/Point")
const authMiddleware = require("../middleware/authMiddleware");
const Payment = require("../models/Payment"); // تأكد أنك استوردت Payment
const Balance = require("../models/Balance");
const { cache } = require("../services/cache.service");
const {
  buildDateRange,
  escapeRegex,
  getPagination,
  paginatedResponse,
} = require("../utils/pagination");
const { normalizePaymentStatusLabel } = require("../utils/paymentStatus");

const BALANCE_FIELDS = 'destination name number operator amount noticeNumber amountDaen date isConfirmed status createdAt user';
const PAYMENT_FIELDS = 'landline company speed email amount calculatedAmount paymentType status note extra createdAt updatedAt user';

const invalidatePointCache = async () => {
  await cache.delByPrefix('point:');
  await cache.delByPrefix('balance:');
  await cache.delByPrefix('report:');
  await cache.delByPrefix('users:');
};



router.post("/add-point", async (req, res) => {
  try {
    const { formData, email } = req.body;
        const existUser = await User.findOne({ email: formData.username });
    if (existUser) {
      return res.status(400).json({ message: "هذا المستخدم موجود بالفعل" });
    }


    // إنشاء نقطة جديدة
    const newPoint = new Point({
      ...formData,
      email, // نضيف الإيميل القادم من التوكن
    });

    await newPoint.save();

    const newUser =  new User(
      {
        email : formData.username,
        password : formData.password,
        name : formData.owner,
        number : formData.number,
        role : "user-point",
      }
    )
    await newUser.save()
    await invalidatePointCache()

    res.status(201).json({ message: "تمت إضافة نقطة البيع بنجاح", newPoint });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "حدث خطأ أثناء إضافة نقطة البيع" });
  }
  
});

router.get('/add-point', async (req, res) => {
  try {
    const { email } = req.query; // ✅ استخدم query وليس body
    const FormData = await Point.find({ email }).select('username balance owner email createdAt updatedAt').lean();
    res.status(200).json(FormData);
  } catch (err) {
    res.status(500).json({ err });
  }
});
router.delete('/delete/:id', async (req, res) => {
  const idDelete = req.params.id;

  try {
    const emailPoint = await Point.findById(idDelete);

    if (!emailPoint) {
      return res.status(404).json({ message: "Point not found" });
    }

    await Point.findByIdAndDelete(idDelete);
    await User.findOneAndDelete({ email: emailPoint.username });
    await invalidatePointCache();

    res.status(200).json({ message: "Delete done" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.put('/add-balance/:id', async (req, res) => {
  const { amount, email , username , owner } = req.body;
  const id = req.params.id;

  try {
    const value = Number(amount);
    if (isNaN(value)) return res.status(400).json({ message: "المبلغ غير صحيح" });

    // إيجاد نقطة البيع أولًا
    const findPoint = await Point.findById(id);
    if (!findPoint) return res.status(404).json({ message: "نقطة البيع غير موجودة" });

    // إيجاد المستخدم الذي سيدفع
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "المستخدم غير موجود" });

    if (user.balance < value) {
      return res.status(400).json({ message: "الرصيد غير كافٍ" });
    }

    // تحديث رصيد نقطة البيع
    findPoint.balance += value;
    await findPoint.save();

    // تحديث رصيد الحساب المرتبط بنقطة البيع
    const point = await User.findOne({ email: findPoint.username });
    if (!point) return res.status(404).json({ message: "الحساب المرتبط بنقطة البيع غير موجود" });

    point.balance += value;
    await point.save();

    // خصم من المستخدم
    user.balance -= value;
    await user.save();

        const balanceDaen = await Balance.findOne({}).sort({_id:-1});
        const amountDaen = balanceDaen.amountDaen || 0;
        

    // حفظ عملية الدفع
    const balanceDoc = new Balance({
      user: id,
      destination: email,
      name: username,
      operator: owner,
      amount: value,
      isConfirmed: true,
      amountDaen,
    });

    await balanceDoc.save();
    await invalidatePointCache();

    res.status(200).json({ message: "تم تعديل الرصيد بنجاح", point, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "حدث خطأ أثناء تعديل الرصيد" });
  }
});


router.get("/all", authMiddleware, async (req, res) => {
  try {
    const ownerEmail = req.user.email;
    const { pointUsername, search } = req.query;
    const { page, limit, skip } = getPagination(req.query);
    const filter = { destination: ownerEmail };
    const dateRange = buildDateRange(req.query);

    if (pointUsername) filter.name = pointUsername;
    if (dateRange) filter.date = dateRange;
    if (search) {
      const searchRegex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { name: searchRegex },
        { operator: searchRegex },
      ];
    }

    const [payments, total] = await Promise.all([
      Balance.find(filter).select(BALANCE_FIELDS).sort({ date: -1 }).skip(skip).limit(limit).lean(),
      Balance.countDocuments(filter),
    ]);

    const transfers = payments.map((payment) => ({
      ...payment,
      fromAccount: payment.destination,
      pointUsername: payment.name,
      pointOwner: payment.operator,
    }));

    res.json(paginatedResponse({ data: transfers, page, limit, total }));
  } catch (error) {
    console.error("خطأ في جلب الدفعات:", error);
    res.status(500).json({ message: "حدث خطأ في الخادم" });
  }
});

router.get("/all-point", async (req, res) => {
  try {
    const {email} = req.query;
    const { page, limit, skip } = getPagination(req.query);
    const filter = { name: email };
    const [payments, total] = await Promise.all([
      Balance.find(filter).select(BALANCE_FIELDS).sort({ date: -1 }).skip(skip).limit(limit).lean(),
      Balance.countDocuments(filter),
    ]);
    res.json(paginatedResponse({ data: payments, page, limit, total }));
  } catch (error) {
    console.error("خطأ في جلب الدفعات:", error);
    res.status(500).json({ message: "حدث خطأ في الخادم" });
  }
});







// ✅ فلترة العمليات حسب المستخدم
router.get("/user/confirmed/point", authMiddleware, async (req, res) => {
  try {
    const ownerEmail = req.user.email;
    const { pointUsername, search, status, paymentType } = req.query;
    const { page, limit, skip } = getPagination(req.query);

    const pointFilter = { email: ownerEmail };
    if (pointUsername) pointFilter.username = pointUsername;

    const points = await Point.find(pointFilter)
      .select('username owner')
      .lean();
    const pointUsernames = points.map((point) => point.username);

    if (pointUsernames.length === 0) {
      return res.json(paginatedResponse({ data: [], page, limit, total: 0 }));
    }

    const pointByUsername = new Map(
      points.map((point) => [point.username, point])
    );
    const filter = { email: { $in: pointUsernames } };
    const dateRange = buildDateRange(req.query);

    if (dateRange) filter.createdAt = dateRange;
    if (status) filter.status = status;
    if (paymentType) filter.paymentType = paymentType;
    if (search) {
      const searchRegex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { landline: searchRegex },
        { company: searchRegex },
        { speed: searchRegex },
        { email: searchRegex },
      ];
    }

    const [payments, total] = await Promise.all([
      Payment.find(filter)
        .select(PAYMENT_FIELDS)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Payment.countDocuments(filter),
    ]);

    const enrichedPayments = payments.map((payment) => {
      const point = pointByUsername.get(payment.email);

      return {
        ...payment,
        status: normalizePaymentStatusLabel(payment.status),
        pointUsername: payment.email,
        pointOwner: point?.owner || '',
      };
    });

    res.json(paginatedResponse({ data: enrichedPayments, page, limit, total }))

  } catch (error) {
    console.error("فشل في جلب عمليات المستخدم:", error);
    res.status(500).json({ message: "حدث خطأ في الخادم" });
  }
});



module.exports = router; // هذا السطر مهم جداً
