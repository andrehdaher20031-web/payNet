// routes/paymentRoutes.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Payment = require('../models/Payment'); // تأكد أنك استوردت Payment
const saveNumber = require('../models/saveNumber'); // تأكد أنك استوردت Payment
const authMiddleware = require('../middleware/authMiddleware');
const { cache } = require('../services/cache.service');
const { recordPaymentStats } = require('../services/dailyStats.service');

const PAYMENT_FIELDS =
  'landline company speed email amount calculatedAmount paymentType status note extra createdAt updatedAt user';
const PENDING_STATUSES = ['جاري التسديد', 'بدء التسديد'];
const ADMIN_PENDING_PAYMENT_FILTER = {
  status: { $in: PENDING_STATUSES },
  $nor: [
    { 'extra.provider': 'prowave', 'extra.operation_type': 'direct_topup' },
    { 'extra.provider': 'prowave', 'extra.prowave_operation_type': 'direct_topup' },
  ],
};
const PROWAVE_DIRECT_TOPUP_ONLY_MESSAGE =
  'طلبات PUBG و Free Fire يجب أن ترسل عبر مسار الشحن المباشر فقط';

const normalizeExtra = (bodyExtra, extraFields = {}) => {
  if (bodyExtra && typeof bodyExtra === 'object' && !Array.isArray(bodyExtra)) {
    return { ...extraFields, ...bodyExtra };
  }

  return bodyExtra !== undefined ? bodyExtra : extraFields;
};

const normalizeServiceText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

const getExtraSearchText = (extra) => {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return '';

  return [
    extra.provider,
    extra.formType,
    extra.game,
    extra.service,
    extra.item_group,
    extra.itemGroup,
    extra.product,
    extra.productName,
  ].filter(Boolean).join(' ');
};

const isLegacyProWaveDirectTopUpPayment = ({ landline, company, speed, extra }) => {
  const normalizedText = normalizeServiceText(
    [landline, company, speed, getExtraSearchText(extra)].filter(Boolean).join(' ')
  );

  if (!normalizedText) return false;

  const isFreeFire =
    /\bfree\s*fire\b/.test(normalizedText) || /\bfreefire\b/.test(normalizedText);
  const isPubg =
    /\bpubg\b/.test(normalizedText) &&
    !/\bpubg\s*(mobile\s*)?tr\b/.test(normalizedText) &&
    !/\bpubgtr\b/.test(normalizedText);

  return isPubg || isFreeFire;
};

const invalidatePaymentCache = async () => {
  await cache.delByPrefix('payments:');
  await cache.delByPrefix('report:');
  await cache.delByPrefix('balance:');
};

const emitPendingPayments = async (req) => {
  const io = req.app.get('io');
  console.log(io);
  if (!io) return;

  const pendingPayments = await Payment.find(ADMIN_PENDING_PAYMENT_FILTER)
    .select(PAYMENT_FIELDS)
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  io.emit('pendingPaymentsUpdate', pendingPayments);
};

router.post('/internet-full', authMiddleware, async (req, res) => {
  try {
    const {
      landline,
      company,
      speed,
      amount,
      email,
      paymentType,
      calculatedAmount,
      extra: bodyExtra,
      ...extraFields
    } = req.body;
    const extra = normalizeExtra(bodyExtra, extraFields);

    const userId = req.user.id;
    if (!landline || !company || !speed || !amount) {
      return res.status(400).json({ message: 'البيانات غير مكتملة' });
    }

    if (isLegacyProWaveDirectTopUpPayment({ landline, company, speed, extra })) {
      return res.status(400).json({
        message: PROWAVE_DIRECT_TOPUP_ONLY_MESSAGE,
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    const isAdmin = email && email.includes('daheradmin');
    const amountToDeduct = calculatedAmount;
    if (!isAdmin) {
      if (user.balance < amountToDeduct) {
        return res.status(400).json({ message: 'الرصيد غير كافٍ' });
      }
    }
    // 💡 تحقق من التكرار: هل تم تنفيذ نفس الطلب خلال آخر دقيقة؟
    const recentDuplicate = await Payment.findOne({
      user: userId,
      landline,
      company,
      speed,
      amount,
      email,
      createdAt: { $gt: new Date(Date.now() - 60 * 1000) },
    });

    // خصم الرصيد
    user.balance -= amountToDeduct;
    await user.save();
    // تسجيل العملية
    const payment = new Payment({
      user: userId,
      landline,
      company,
      speed,
      amount,
      paymentType,
      email,
      calculatedAmount,
      status: 'جاري التسديد',
      extra,
    });
    await payment.save();
    await recordPaymentStats(payment, 1);
    await invalidatePaymentCache();

    console.log(payment);

    await emitPendingPayments(req);

    res.status(200).json({
      message: 'تمت العملية بنجاح',
      newBalance: user.balance,
      payment,
    });
  } catch (err) {
    console.error('❌ خطأ أثناء تسديد الإنترنت:', err);
    res.status(500).json({ message: 'حدث خطأ أثناء العملية' });
  }
});

router.post('/adminPayInternet', async (req, res) => {
  try {
    const {
      landline,
      company,
      speed,
      amount,
      email,
      paymentType,
      calculatedAmount,
      extra: bodyExtra,
      ...extraFields
    } = req.body;
    const extra = normalizeExtra(bodyExtra, extraFields);

    if (!landline || !company || !speed || !amount) {
      return res.status(400).json({ message: 'البيانات غير مكتملة' });
    }

    if (isLegacyProWaveDirectTopUpPayment({ landline, company, speed, extra })) {
      return res.status(400).json({
        message: PROWAVE_DIRECT_TOPUP_ONLY_MESSAGE,
      });
    }

    // جلب حساب الأدمن
    const user = await User.findOne({ email: 'daheradmin' });
    if (!user) {
      return res.status(404).json({ message: 'حساب الأدمن غير موجود' });
    }

    // تسجيل العملية
    const payment = new Payment({
      user: user._id, // ✅ ObjectId صحيح
      landline,
      company,
      speed,
      amount,
      calculatedAmount,
      paymentType,
      email,
      status: 'جاري التسديد',
      extra,
    });

    await payment.save();
    await recordPaymentStats(payment, 1);
    await invalidatePaymentCache();

    await emitPendingPayments(req);

    res.status(200).json({
      message: 'تمت العملية بنجاح',
    });
  } catch (err) {
    console.error('❌ خطأ أثناء تسديد الإنترنت:', err);
    res.status(500).json({
      message: 'حدث خطأ أثناء العملية',
      error: err.message,
    });
  }
});

router.post('/save-number', authMiddleware, async (req, res) => {
  try {
    const formData = req.body;
    const num = Number(formData.amount);
    calculatedAmount = num + num * 0.05;
    console.log(calculatedAmount);
    const userId = req.user.id;
    const newNumber = new saveNumber({
      user: userId,
      landline: formData.number,
      company: formData.company,
      speed: formData.speed,
      amount: formData.amount,
      email: formData.email,
      date: formData.date,
      calculatedAmount,
    });
    await newNumber.save();
    res.status(201).json({ message: 'تم حفظ الرقم بنجاح' });
  } catch (err) {
    console.error('❌ خطأ أثناء حفظ الرقم:', err);
    res.status(500).json({ message: 'حدث خطأ أثناء العملية' });
  }
});

router.get('/save-number', async (req, res) => {
  const email = req.query;
  try {
    const payment = await saveNumber
      .find(email)
      .select(
        'landline company speed email amount paymentType status note createdAt date user'
      )
      .sort({ date: -1 })
      .lean();
    res.status(201).json(payment);
  } catch {
    res.status(401).json('error');
  }
});

router.post('/pay-selected', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { email, selectedData } = req.body;
    console.log(req.body);

    if (!Array.isArray(selectedData) || selectedData.length === 0) {
      return res
        .status(400)
        .json({ message: 'selectedData يجب أن تكون مصفوفة غير فارغة' });
    }

    // selectedData: مصفوفة كائنات محفوظة تحتوي على بيانات الرقم
    const docsToCreate = selectedData
      .map((item) => ({
        user: userId,
        landline: item?.landline != null ? String(item.landline) : undefined,
        company: item?.company,
        speed: item?.speed,
        email: item?.email ?? email ?? '',
        amount: item?.amount,
        calculatedAmount: item?.calculatedAmount,
        paymentType: item?.paymentType ?? 'cash',
        status: 'جاري التسديد',
        extra: item?.extra || {},
      }))
      .filter((doc) => !!doc.landline);

    if (docsToCreate.length === 0) {
      return res
        .status(400)
        .json({ message: 'لا توجد عناصر صالحة للإنشاء (landline مفقود)' });
    }

    const blockedDirectTopUpDoc = docsToCreate.find((doc) =>
      isLegacyProWaveDirectTopUpPayment(doc)
    );
    if (blockedDirectTopUpDoc) {
      return res.status(400).json({
        message: PROWAVE_DIRECT_TOPUP_ONLY_MESSAGE,
      });
    }

    let totalAmount = 0;
    docsToCreate.forEach((doc) => {
      totalAmount += parseFloat((doc.amount * 1.05).toFixed(2));
    });

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    if (user.balance < totalAmount) {
      return res
        .status(400)
        .json({ message: 'الرصيد غير كافٍ لإتمام العملية' });
    }

    // خصم الرصيد
    user.balance -= totalAmount;
    await user.save();

    const created = await Payment.insertMany(docsToCreate, { ordered: false });
    await Promise.all(created.map((payment) => recordPaymentStats(payment, 1)));
    await invalidatePaymentCache();

    // تحديث قائمة العمليات المعلقة عبر Socket.IO إن وجدت
    await emitPendingPayments(req);

    return res.status(201).json({
      message: 'تم إنشاء المدفوعات',
      count: created.length,
      payments: created,
    });
  } catch (err) {
    res.status(401).json(err);
  }
});

router.put('/save-number/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const { landline, company, date, amount } = req.body;
  try {
    const updatePayment = await saveNumber.findByIdAndUpdate(
      id,
      {
        landline: landline,
        company: company,
        amount: amount,
        date: date,
      },
      { new: true }
    );
    res.status(201).json('done');
  } catch (err) {
    res.status(401).json(err);
  }
});

router.delete('/save-number/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  try {
    await saveNumber.findByIdAndDelete(id);
    res.status(201).json('done');
  } catch (err) {
    res.status(401).json(err);
  }
});
module.exports = router;
