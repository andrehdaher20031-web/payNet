// routes/admin.js
const express = require('express');
const router = express.Router();
const InternetPayment = require('../models/Payment');
const authMiddleware = require('../middleware/authMiddleware');
const User = require('../models/User');
const Balance = require('../models/Balance');
const { confirmPaymentService } = require('../services/payments.services');
const { cache, cacheKey, getOrSet } = require('../services/cache.service');
const {
  cleanMapKey,
  getDailyStatsRange,
  recordBalanceStats,
  recordPaymentStats,
} = require('../services/dailyStats.service');
const {
  buildDateRange,
  escapeRegex,
  getPagination,
  paginatedResponse,
} = require('../utils/pagination');

const PAYMENT_FIELDS =
  'landline company speed email amount calculatedAmount paymentType status note extra createdAt updatedAt user';
const BALANCE_FIELDS =
  'destination name number operator amount noticeNumber amountDaen date isConfirmed status createdAt user';
const USER_FIELDS = 'name email number role balance card';
const PENDING_STATUSES = ['جاري التسديد', 'بدء التسديد'];
const FINAL_STATUSES = ['تم التسديد', 'غير مسددة'];

const invalidateReports = async () => {
  await cache.delByPrefix('report:');
  await cache.delByPrefix('payments:');
  await cache.delByPrefix('balance:');
  await cache.delByPrefix('users:');
};

const buildPaymentFilters = (query = {}, baseFilter = {}) => {
  const filter = { ...baseFilter };
  const dateRange = buildDateRange(query);

  if (dateRange) filter.createdAt = dateRange;
  if (query.status) filter.status = query.status;
  if (query.paymentType) filter.paymentType = query.paymentType;
  if (query.search) {
    const search = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [{ landline: search }, { email: search }, { company: search }];
  }

  return filter;
};

const emitPendingPayments = async (req) => {
  const io = req.app.get('io');
  if (!io) return;

  const pendingPayments = await InternetPayment.find({ status: { $in: PENDING_STATUSES } })
    .select(PAYMENT_FIELDS)
    .sort({ createdAt: -1 })
    .lean();
  io.emit('pendingPaymentsUpdate', pendingPayments);
};

router.get('/pending', authMiddleware, async (req, res) => {
  const filter = buildPaymentFilters(req.query, { status: { $in: PENDING_STATUSES } });
  const payments = await InternetPayment.find(filter)
    .select(PAYMENT_FIELDS)
    .sort({ createdAt: -1 })
    .lean();

  res.json(payments);
});

router.patch('/confirm/:id', async (req, res) => {
  const { id } = req.params;
  const original = await InternetPayment.findById(id).lean();
  const updated = await InternetPayment.findByIdAndUpdate(
    id,
    { status: 'تم التسديد' },
    { new: true }
  ).lean();
  if (original && updated) {
    await recordPaymentStats(original, -1);
    await recordPaymentStats(updated, 1);
  }
  await invalidateReports();
  await emitPendingPayments(req);
  res.json(updated);
});

router.patch('/start/:id', async (req, res) => {
  const { id } = req.params;
  const original = await InternetPayment.findById(id).lean();
  const updated = await InternetPayment.findByIdAndUpdate(
    id,
    { status: 'بدء التسديد' },
    { new: true }
  ).lean();
  if (original && updated) {
    await recordPaymentStats(original, -1);
    await recordPaymentStats(updated, 1);
  }
  await invalidateReports();
  await emitPendingPayments(req);
  res.json(updated);
});

router.get('/user/confirmed', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page, limit, skip } = getPagination(req.query);
    const paymentFilter = buildPaymentFilters(req.query, { user: userId });
    const balanceFilter = { user: userId };
    const dateRange = buildDateRange(req.query);
    if (dateRange) {
      balanceFilter.$or = [{ date: dateRange }, { createdAt: dateRange }];
    }
    if (req.query.search) {
      const search = new RegExp(escapeRegex(req.query.search), 'i');
      paymentFilter.$or = [{ landline: search }, { company: search }, { email: search }];
      balanceFilter.$or = [{ name: search }, { destination: search }, { operator: search }];
    }

    const [payments, batchpayments] = await Promise.all([
      InternetPayment.find(paymentFilter)
        .select(PAYMENT_FIELDS)
        .sort({ createdAt: -1 })
        .lean(),
      Balance.find(balanceFilter)
        .select(BALANCE_FIELDS)
        .sort({ date: -1 })
        .lean(),
    ]);

    const paymentWithType = payments.map((p) => ({
      ...p,
      landline: String(p.landline || ''),
      source: 'internet',
    }));

    const batchWithType = batchpayments.map((b) => ({
      ...b,
      landline: String(b.number || ''),
      company: b.operator || '—',
      speed: 'دفعة',
      note: '—',
      paymentType: b.paymentType || 'cash',
      status: b.status ? 'تم التسديد' : 'غير مسددة',
      createdAt: b.createdAt,
      updatedAt: b.date || b.createdAt,
      source: 'batch',
    }));

    const allData = [...paymentWithType, ...batchWithType];

    allData.sort((a, b) => {
      const da = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const db = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return db - da;
    });

    const filtered = req.query.paymentType
      ? allData.filter((item) => item.paymentType === req.query.paymentType)
      : allData;
    const data = filtered.slice(skip, skip + limit);

    res.json(paginatedResponse({ data, page, limit, total: filtered.length }));
  } catch (error) {
    console.error('فشل في جلب عمليات المستخدم:', error);
    res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
});

// تعديل نوع الدفع
router.put('/payment/:id', async (req, res) => {
  try {
    const { id } = req.params; // ID العملية
    const { paymentType } = req.body; // نوع الدفع الجديد

    // التحقق من صحة القيمة
    if (!['cash', 'credit'].includes(paymentType)) {
      return res.status(400).json({ message: 'نوع الدفع غير صالح' });
    }

    const original = await InternetPayment.findById(id).lean();
    const updatedPayment = await InternetPayment.findByIdAndUpdate(
      id,
      { paymentType },
      { new: true }
    ).lean();

    if (!updatedPayment) {
      return res.status(404).json({ message: 'العملية غير موجودة' });
    }

    if (original) {
      await recordPaymentStats(original, -1);
      await recordPaymentStats(updatedPayment, 1);
    }
    await invalidateReports();

    res.json({ message: 'تم تحديث نوع الدفع بنجاح', payment: updatedPayment });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'حدث خطأ في السيرفر' });
  }
});

router.get('/user/allconfirmed', authMiddleware, async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);
    const filter = buildPaymentFilters(req.query, { status: { $in: FINAL_STATUSES } });
    const [payments, total] = await Promise.all([
      InternetPayment.find(filter)
        .select(PAYMENT_FIELDS)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      InternetPayment.countDocuments(filter),
    ]);

    res.json(paginatedResponse({ data: payments, page, limit, total }));
  } catch (error) {
    console.error('فشل في جلب عمليات المستخدم:', error);
    res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
});

// تأكيد العملية وإضافة المبلغ إلى المستخدم
router.post('/confirm-payment', async (req, res) => {
  try {
    const result = await confirmPaymentService(req.body);
    res.status(200).json(result);
  } catch (error) {
    console.error('خطأ أثناء تأكيد الدفعة:', error);

    res.status(error.status || 500).json({
      message: error.message || 'حدث خطأ أثناء معالجة الطلب',
    });
  }
});

// ✅ فلترة العمليات حسب المستخدم
router.get('/user/pending', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const payments = await InternetPayment.find({
      user: userId,
      status: { $in: ['جاري التسديد'] },
    })
      .select(PAYMENT_FIELDS)
      .sort({ createdAt: -1 })
      .lean();

    res.json(payments);
  } catch (error) {
    console.error('فشل في جلب عمليات المستخدم:', error);
    res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
});

// routes/admin.js
router.post('/reject/:id', async (req, res) => {
  try {
    const { reason, email } = req.body;
    const paymentId = req.params.id;
    const payment = await InternetPayment.findById(paymentId).lean();

    // 1. تحديث العملية إلى "غير مسددة" مع سبب
    const updatedPayment = await InternetPayment.findByIdAndUpdate(
      paymentId,
      {
        status: 'غير مسددة',
        note: reason,
      },
      { new: true }
    ).lean();

    // 2. إرجاع الرصيد للمستخدم
    const user = await User.findOne({ email });
    if (user) {
      const Amount = payment.calculatedAmount;
      user.balance += Amount;
      await user.save();
    }
    req.io.emit('json_message', true);
    if (payment && updatedPayment) {
      await recordPaymentStats(payment, -1);
      await recordPaymentStats(updatedPayment, 1);
    }
    await invalidateReports();
    await emitPendingPayments(req);

    res.status(200).json({ message: 'تم الرفض وإرجاع الرصيد' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'حدث خطأ أثناء الرفض' });
  }
});

//جلب جميع المستخدمين
router.get('/all-user', authMiddleware, async (req, res) => {
  try {
    const allUser = await getOrSet(cacheKey('users:all', req.query), 120, () =>
      User.find().select(USER_FIELDS).sort({ name: 1 }).lean()
    );
    res.status(201).json(allUser);
  } catch (err) {
    res.status(401).json(err);
  }
});

router.get('/getPOSBalanceReport', authMiddleware, async (req, res) => {
  try {
    const report = await getOrSet(cacheKey('report:pos-balance', req.query), 300, () =>
      User.aggregate([
        {
          $lookup: {
            from: 'harams',
            localField: '_id',
            foreignField: 'user',
            as: 'deposits',
          },
        },
        {
          $lookup: {
            from: 'payments',
            let: { userId: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ['$user', '$$userId'] },
                },
              },
              {
                $group: {
                  _id: '$status',
                  total: { $sum: '$amount' },
                },
              },
            ],
            as: 'expensesByStatus',
          },
        },
        {
          $addFields: {
            confirmedDeposits: {
              $sum: {
                $map: {
                  input: {
                    $filter: {
                      input: '$deposits',
                      as: 'deposit',
                      cond: { $eq: ['$$deposit.isConfirmed', true] },
                    },
                  },
                  as: 'deposit',
                  in: '$$deposit.amount',
                },
              },
            },
            unconfirmedDeposits: {
              $sum: {
                $map: {
                  input: {
                    $filter: {
                      input: '$deposits',
                      as: 'deposit',
                      cond: { $eq: ['$$deposit.isConfirmed', false] },
                    },
                  },
                  as: 'deposit',
                  in: '$$deposit.amount',
                },
              },
            },
            totalDeposits: { $sum: '$deposits.amount' },
          },
        },
        {
          $addFields: {
            expensesPaid: {
              $sum: {
                $map: {
                  input: {
                    $filter: {
                      input: '$expensesByStatus',
                      as: 'expense',
                      cond: { $eq: ['$$expense._id', 'تم التسديد'] },
                    },
                  },
                  as: 'expense',
                  in: '$$expense.total',
                },
              },
            },
            expensesUnpaid: {
              $sum: {
                $map: {
                  input: {
                    $filter: {
                      input: '$expensesByStatus',
                      as: 'expense',
                      cond: { $eq: ['$$expense._id', 'غير مسددة'] },
                    },
                  },
                  as: 'expense',
                  in: '$$expense.total',
                },
              },
            },
            expensesInProgress: {
              $sum: {
                $map: {
                  input: {
                    $filter: {
                      input: '$expensesByStatus',
                      as: 'expense',
                      cond: { $in: ['$$expense._id', PENDING_STATUSES] },
                    },
                  },
                  as: 'expense',
                  in: '$$expense.total',
                },
              },
            },
          },
        },
        {
          $addFields: {
            totalExpenses: {
              $add: ['$expensesPaid', '$expensesUnpaid', '$expensesInProgress'],
            },
          },
        },
        {
          $addFields: {
            netBalance: {
              $subtract: ['$totalDeposits', '$totalExpenses'],
            },
            finalBalance: {
              $add: [
                { $subtract: ['$totalDeposits', '$totalExpenses'] },
                { $ifNull: ['$balance', 0] },
              ],
            },
          },
        },
        {
          $project: {
            name: 1,
            email: 1,
            balance: 1,
            totalDeposits: 1,
            confirmedDeposits: 1,
            unconfirmedDeposits: 1,
            expensesPaid: 1,
            expensesUnpaid: 1,
            expensesInProgress: 1,
            totalExpenses: 1,
            netBalance: 1,
            finalBalance: 1,
          },
        },
      ])
    );

    res.status(200).json(report);
  } catch (error) {
    console.error('خطأ أثناء جلب تقرير الأرصدة:', error);
    res.status(500).json({
      message: 'حدث خطأ أثناء جلب تقرير الأرصدة',
      error: error.message,
    });
  }
});

router.get('/newPosBalanceReport', async (req, res) => {
  try {
    const allData = await getOrSet(cacheKey('report:new-pos-balance', req.query), 300, async () => {
      const [allUsers, internetTotals, batchTotals] = await Promise.all([
        User.find().select('name email balance').lean(),
        InternetPayment.aggregate([
          { $group: { _id: '$user', totalInternet: { $sum: '$amount' } } },
        ]),
        Balance.aggregate([
          { $group: { _id: '$user', totalBatch: { $sum: '$amount' } } },
        ]),
      ]);

      const internetByUser = new Map(
        internetTotals.map((item) => [String(item._id), item.totalInternet || 0])
      );
      const batchByUser = new Map(
        batchTotals.map((item) => [String(item._id), item.totalBatch || 0])
      );

      return allUsers.map((user) => {
        const key = String(user._id);
        const totalInternet = internetByUser.get(key) || 0;
        const totalBatch = batchByUser.get(key) || 0;
        return {
          userId: user._id,
          userName: user.name,
          userEmail: user.email,
          balance: user.balance,
          totalInternet,
          totalBatch,
          total: totalInternet + totalBatch,
        };
      });
    });

    res.json(allData);
  } catch (error) {
    console.error('فشل في جلب التقرير:', error);
    res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
});

router.delete('/deleteuser/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await User.findByIdAndDelete({ _id: id });
    await invalidateReports();
    res.status(201).json('تم حذف المستخدم');
  } catch (err) {
    res.status(401).json(err);
  }
});

router.put('/addbatch/:id', async (req, res) => {
  const id = req.params.id;
  const batch = req.body.amount;

  try {
    const balanceDaen = await Balance.findOne({}).sort({ _id: -1 });

    const daenamount = balanceDaen.amountDaen;
    console.log(daenamount);
    if (daenamount > 1200000) {
      return res
        .status(401)
        .json('لا يمكن اضافة دفعة جديدة لان المبلغ المستحق اكثر من المليون');
    }
    const newUser = await User.findById({ _id: id });
    const balanceAmount = newUser.balance + batch;
    const newBalance = await new Balance({
      name: newUser.email,
      amount: batch,
      isConfirmed: true,
      destination: 'nader daher',
      operator: 'nader daher',
      noticeNumber: 1,
      number: '0966248984',
      amountDaen: daenamount + batch,
      status: false,
      date: Date.now(),
      user: newUser._id,
    });

    await newBalance.save();
    await recordBalanceStats(newBalance, 1);
    await User.findByIdAndUpdate(
      { _id: id },
      { balance: balanceAmount },
      { new: true }
    );
    await invalidateReports();
    res.status(201).json('تم اضافة الدفعة بنجاح');
  } catch (err) {
    res.status(401).json(err);
  }
});

//حذف دفعة
router.delete('/delete/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const deleted = await Balance.findByIdAndDelete({ _id: id }).lean();
    if (deleted) await recordBalanceStats(deleted, -1);
    await invalidateReports();
    res.status(201).json('delete done');
  } catch (err) {
    console.log(err);
    res.status(401).json('error');
  }
});

router.get('/user/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  try {
    const updateUser = await User.findById(id).select(USER_FIELDS).lean();
    res.status(200).json(updateUser);
  } catch (err) {
    res.status(401).json(err);
  }
});
router.put('/updateuser/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const updateUser = await User.findByIdAndUpdate(id, req.body, {
      new: true,
    }).select(USER_FIELDS).lean();
    await invalidateReports();
    res.status(200).json(updateUser);
  } catch (err) {
    res.status(401).json(err);
  }
});

let fatoraDataMap = {}; // مفتاح = البريد الإلكتروني، القيمة = بيانات الفاتورة

// POST - حفظ البيانات (استعلام)
router.post('/astalam', (req, res) => {
  let fatoraDataMap = {}; // مفتاح = البريد الإلكتروني، القيمة = بيانات الفاتورة

  const data = req.body;
  const { email } = req.body;

  // if (!selectedCompany || !landline) {
  //   return res.status(400).json({ error: "يرجى إدخال الشركة والرقم الأرضي" });
  // }

  fatoraDataMap[email] = data;

  // إرسال البيانات لكل العملاء المتصلين عبر socket.io
  req.io.emit('fatoraUpdated', fatoraDataMap[email]);

  res.status(201).json({ message: 'تم الاستعلام وحفظ البيانات' });
});

// GET - جلب البيانات
router.get('/astalam', (req, res) => {
  const { email } = req.query;
  let fatoraDataMap = {}; // مفتاح = البريد الإلكتروني، القيمة = بيانات الفاتورة

  if (!fatoraDataMap[email]) {
    return res.status(404).json({ message: 'لا توجد بيانات' });
  }

  res.status(200).json(fatoraDataMap[email]);
});

router.get('/daen', authMiddleware, async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);
    const filter = { status: false };
    const [daenBalance, total] = await Promise.all([
      Balance.find(filter)
        .select(BALANCE_FIELDS)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Balance.countDocuments(filter),
    ]);
    res.status(201).json(paginatedResponse({ data: daenBalance, page, limit, total }));
  } catch (err) {
    res.status(401).json(err);
  }
});

router.post('/confirm-daen', async (req, res) => {
  const { id } = req.body;
  try {
    // ابحث عن الدفعة المطلوبة
    const payment = await Balance.findById(id);

    if (!payment) {
      return res.status(404).json({ message: 'لم يتم العثور على الدفعة' });
    }

    // ابحث عن المستخدم
    const user = await User.findOne({ email: payment.name });
    if (!user) {
      return res.status(404).json({ message: 'المستخدم غير موجود' });
    }

    payment.status = true;
    const lastBalance = await Balance.findOneAndUpdate(
      {},
      { $inc: { amountDaen: -payment.amount } },
      { sort: { _id: -1 }, new: true }
    );
    await payment.save();
    await recordBalanceStats(payment, 1);
    await invalidateReports();

    res.status(200).json({ success: true, message: 'تم تحديث رصيد المستخدم' });
  } catch (error) {
    console.error('خطأ أثناء تأكيد الدفعة:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء معالجة الطلب' });
  }
});

router.get('/payments/bydate', authMiddleware, async (req, res) => {
  try {
    // استلام التاريخين من الفرونت
    const { fromDate, toDate } = req.query;

    // التحقق من وجود التاريخين
    if (!fromDate || !toDate) {
      return res
        .status(400)
        .json({ message: 'يرجى إرسال تاريخ البداية والنهاية' });
    }

    // تحويل النصوص إلى كائنات Date
    const start = new Date(fromDate);
    const end = new Date(toDate);

    // ضبط نهاية اليوم الأخير لتشمل كامل اليوم
    end.setHours(23, 59, 59, 999);

    const filter = {
      status: { $in: FINAL_STATUSES },
      createdAt: { $gte: start, $lte: end },
    };
    const payments = await InternetPayment.find(filter)
      .select(PAYMENT_FIELDS)
      .sort({ createdAt: -1 })
      .lean();

    res.json(payments);
  } catch (error) {
    console.error('فشل في جلب عمليات المستخدم حسب التاريخ:', error);
    res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
});

router.get('/report/balanceNeed', async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;

    if (!fromDate || !toDate) {
      return res
        .status(400)
        .json({ message: 'يرجى إرسال تاريخ البداية والنهاية' });
    }

    const start = new Date(fromDate);
    const end = new Date(toDate);
    end.setHours(23, 59, 59, 999);

    const MS_PER_DAY = 1000 * 60 * 60 * 24;
    const totalDays = Math.ceil((end - start) / MS_PER_DAY) || 1;

    const companies = [
      'برونت',
      'اينت',
      'رنت',
      'الكم',
      'ليما',
      'سوا',
      'اية',
      'يارا',
      'بطاقات',
      'هايبر',
      'ويف',
      'امنية',
      'فيو',
      'ليزر',
      'متس',
      'سما',
      'زاد',
      'دنيا',
      'هاي فاي',
      'تكامل',
      'لاين',
      'الجمعية',
    ];

    const cachedReport = await getOrSet(cacheKey('report:balance-need', req.query), 300, async () => {
      const stats = await getDailyStatsRange(start, end);
      const hasPaymentStats = stats.some((stat) => stat.payments?.total?.count > 0);

      if (hasPaymentStats) {
        const byCompany = {};
        companies.forEach((company) => {
          byCompany[company] = { company, totalAmount: 0, avgOnDayAmount: 0, count: 0 };
        });

        let totalPayments = 0;
        let grandTotalFromStats = 0;

        stats.forEach((stat) => {
          const companyStats = stat.payments?.byCompany || {};
          companies.forEach((company) => {
            const entry = companyStats.get?.(cleanMapKey(company)) || companyStats[cleanMapKey(company)];
            if (!entry) return;
            byCompany[company].totalAmount += entry.amount || 0;
            byCompany[company].count += entry.count || 0;
            grandTotalFromStats += entry.amount || 0;
            totalPayments += entry.count || 0;
          });
        });

        Object.values(byCompany).forEach((company) => {
          company.avgOnDayAmount = Number((company.totalAmount / totalDays).toFixed(2));
        });

        return {
          fromDate,
          toDate,
          totalDays,
          totalPayments,
          grandTotal: grandTotalFromStats,
          companies: Object.values(byCompany).sort((a, b) => b.totalAmount - a.totalAmount),
        };
      }

      return null;
    });

    if (cachedReport) {
      return res.json(cachedReport);
    }

    const payments = await InternetPayment.find({
      status: 'تم التسديد',
      createdAt: { $gte: start, $lte: end },
    })
      .select('company amount createdAt')
      .lean();

    const paymentsByCompany = {};
    companies.forEach((company) => {
      paymentsByCompany[company] = {
        company,
        totalAmount: 0,
        avgOnDayAmount: 0,
        count: 0,
      };
    });

    let grandTotal = 0;

    payments.forEach((payment) => {
      const company = payment.company?.trim();
      if (!company || !paymentsByCompany[company]) return;

      // تقسيم كل مبلغ على 100 هنا
      const amount = payment.amount || 0;

      paymentsByCompany[company].totalAmount += amount;
      paymentsByCompany[company].count += 1;
      grandTotal += amount;
    });

    // حساب المتوسط اليومي بعد القسمة
    Object.values(paymentsByCompany).forEach((company) => {
      company.avgOnDayAmount = Number(
        (company.totalAmount / totalDays).toFixed(2)
      );
    });

    const sortedCompanies = Object.values(paymentsByCompany).sort(
      (a, b) => b.totalAmount - a.totalAmount
    );

    res.json({
      fromDate,
      toDate,
      totalDays,
      totalPayments: payments.length,
      grandTotal,
      companies: sortedCompanies,
    });
  } catch (error) {
    console.error('فشل في جلب تقرير الأرصدة:', error);
    res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
});

module.exports = router; // هذا السطر مهم جداً
