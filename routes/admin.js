// routes/admin.js
const express = require('express');
const router = express.Router();
const InternetPayment = require('../models/Payment');
const authMiddleware = require('../middleware/authMiddleware');
const requireAdmin = require('../middleware/requireAdmin');
const User = require('../models/User');
const Balance = require('../models/Balance');
const { confirmPaymentService, refundManualPayment, transitionManualPayment, isProviderManaged, atomic } = require('../services/payments.services');
const { Decimal, sypAmount, walletAdjustment, MAX_WALLET } = require('../utils/money');
const WalletAdjustment = require('../models/WalletAdjustment');
const { customerPayment } = require('../utils/customerPayment');
const exchangeRateController = require('../controllers/exchangeRateController');
const proWaveController = require('../controllers/proWave');
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
const {
  normalizePaymentStatusLabel,
  sanitizePaymentStatusForResponse,
  sanitizePaymentsStatusForResponse,
} = require('../utils/paymentStatus');

const PAYMENT_FIELDS =
  'landline company speed email amount calculatedAmount paymentType status note extra createdAt updatedAt user';
const BALANCE_FIELDS =
  'destination name number operator amount noticeNumber amountDaen date isConfirmed status createdAt user';
const USER_FIELDS = 'name email number role balance card';
const PENDING_STATUSES = ['جاري التسديد', 'بدء التسديد'];
const CUSTOMER_PATHS = new Set(['/user/confirmed', '/user/pending', '/astalam']);
router.use(authMiddleware, (req, res, next) => CUSTOMER_PATHS.has(req.path) ? next() : requireAdmin(req, res, next));
const FINAL_STATUSES = ['تم التسديد', 'غير مسددة'];
const PROVIDER_MANAGED_PENDING_EXCLUSIONS = [{ 'extra.provider': { $in: ['prowave', 'alragheb', 'aleso'] } }];
const ADMIN_PENDING_PAYMENT_FILTER = {
  status: { $in: PENDING_STATUSES },
  $nor: PROVIDER_MANAGED_PENDING_EXCLUSIONS,
};
const PROVIDER_MANAGED_PAYMENT_MESSAGE =
  'هذه العملية تدار تلقائياً ولا تعالج من لوحة التسديد اليدوي';

const invalidateReports = async () => {
  await cache.delByPrefix('report:');
  await cache.delByPrefix('payments:');
  await cache.delByPrefix('balance:');
  await cache.delByPrefix('users:');
};

router.get(
  '/exchange-rate/prowave',
  authMiddleware,
  requireAdmin,
  exchangeRateController.getProWaveExchangeRate
);

router.put(
  '/exchange-rate/prowave',
  authMiddleware,
  requireAdmin,
  exchangeRateController.updateProWaveExchangeRate
);

router.get(
  '/exchange-rate/prowave/history',
  authMiddleware,
  requireAdmin,
  exchangeRateController.getProWaveExchangeRateHistory
);

router.get(
  '/exchange-rate/aleso',
  authMiddleware,
  requireAdmin,
  exchangeRateController.getAlesoExchangeRate
);

router.put(
  '/exchange-rate/aleso',
  authMiddleware,
  requireAdmin,
  exchangeRateController.updateAlesoExchangeRate
);

router.get(
  '/exchange-rate/aleso/history',
  authMiddleware,
  requireAdmin,
  exchangeRateController.getAlesoExchangeRateHistory
);

router.get(
  '/prowave/prices',
  authMiddleware,
  requireAdmin,
  proWaveController.getAdminPriceReport
);

router.get(
  '/prowave/reconciliation',
  authMiddleware,
  requireAdmin,
  proWaveController.getReconciliationReport
);

router.post(
  '/prowave/reconciliation/run',
  authMiddleware,
  requireAdmin,
  proWaveController.runReconciliation
);

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

const getPaymentOperationType = (payment = {}) => {
  const provider = payment.extra?.provider;

  if (provider === 'aleso') return 'منتج Aleso';
  if (provider === 'alragheb') return 'تطبيقات الدردشة Alragheb';
  if (provider === 'prowave') return 'منتج رقمي';

  return 'تسديد خدمة';
};

const isProviderManagedDirectTopUpPayment = isProviderManaged;

const emitPendingPayments = async (req) => {
  const io = req.app.get('io');
  if (!io) return;

  const pendingPayments = await InternetPayment.find(
    ADMIN_PENDING_PAYMENT_FILTER
  )
    .select(PAYMENT_FIELDS)
    .sort({ createdAt: -1 })
    .lean();
  io.emit(
    'pendingPaymentsUpdate',
    sanitizePaymentsStatusForResponse(pendingPayments)
  );
};

router.get('/pending', authMiddleware, async (req, res) => {
  const filter = buildPaymentFilters(req.query, ADMIN_PENDING_PAYMENT_FILTER);
  const payments = await InternetPayment.find(filter)
    .select(PAYMENT_FIELDS)
    .sort({ createdAt: -1 })
    .lean();

  res.json(sanitizePaymentsStatusForResponse(payments));
});

router.patch('/confirm/:id', async (req, res) => {
  try {
    const payment = await transitionManualPayment({ id: req.params.id, target: 'تم التسديد', actorId: req.user.id });
    await emitPendingPayments(req); res.json(sanitizePaymentStatusForResponse(payment.toObject()));
  } catch (error) { res.status(error.status || 500).json({ message: error.status ? error.message : 'تعذر تأكيد العملية', code: error.code }); }
});

router.patch('/start/:id', async (req, res) => {
  try {
    const payment = await transitionManualPayment({ id: req.params.id, target: 'بدء التسديد', actorId: req.user.id });
    await emitPendingPayments(req); res.json(sanitizePaymentStatusForResponse(payment.toObject()));
  } catch (error) { res.status(error.status || 500).json({ message: error.status ? error.message : 'تعذر بدء العملية', code: error.code }); }
});

router.get('/user/confirmed', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const userEmail = req.user.email;
    const { page, limit, skip } = getPagination(req.query);
    const paymentFilter = buildPaymentFilters(req.query, { user: userId });
    const dateRange = buildDateRange(req.query);
    const balanceClauses = [{ user: userId }];
    const pointTransferClauses = [{ destination: userEmail }];
    if (req.query.search) {
      const search = new RegExp(escapeRegex(req.query.search), 'i');
      paymentFilter.$or = [
        { landline: search },
        { company: search },
        { email: search },
      ];
      const balanceSearch = {
        $or: [{ name: search }, { destination: search }, { operator: search }],
      };
      balanceClauses.push(balanceSearch);
      pointTransferClauses.push(balanceSearch);
    }
    if (dateRange) {
      const balanceDate = {
        $or: [{ date: dateRange }, { createdAt: dateRange }],
      };
      balanceClauses.push(balanceDate);
      pointTransferClauses.push(balanceDate);
    }
    const balanceFilter =
      balanceClauses.length === 1
        ? balanceClauses[0]
        : { $and: balanceClauses };
    const pointTransferFilter =
      pointTransferClauses.length === 1
        ? pointTransferClauses[0]
        : { $and: pointTransferClauses };

    const [payments, batchpayments, pointTransfers] = await Promise.all([
      InternetPayment.find(paymentFilter)
        .select(PAYMENT_FIELDS)
        .sort({ createdAt: -1 })
        .lean(),
      Balance.find(balanceFilter)
        .select(BALANCE_FIELDS)
        .sort({ date: -1 })
        .lean(),
      Balance.find(pointTransferFilter)
        .select(BALANCE_FIELDS)
        .sort({ date: -1 })
        .lean(),
    ]);

    const paymentWithType = payments.map((p) => ({
      ...customerPayment(p),
      landline: String(p.landline || ''),
      status: normalizePaymentStatusLabel(p.status),
      operationType: getPaymentOperationType(p),
      operationTarget: p.email || '',
      source: 'internet',
    }));

    const batchWithType = batchpayments.map((b) => ({
      ...b,
      landline: String(b.number || ''),
      company: b.operator || '—',
      speed: 'تعبئة رصيد',
      note: '—',
      paymentType: b.paymentType || 'cash',
      status: b.status ? 'تم التسديد' : 'غير مسددة',
      createdAt: b.createdAt,
      updatedAt: b.date || b.createdAt,
      operationType: 'تعبئة رصيد',
      operationTarget: b.name || '',
      source: 'batch',
    }));

    const pointTransferWithType = pointTransfers.map((b) => ({
      ...b,
      landline: b.name || '',
      company: b.operator || '—',
      speed: 'تحويل رصيد لنقطة',
      note: '—',
      paymentType: b.paymentType || 'cash',
      status: b.isConfirmed ? 'تم التحويل' : 'غير مؤكد',
      createdAt: b.createdAt,
      updatedAt: b.date || b.createdAt,
      operationType: 'تحويل لنقطة فرعية',
      operationTarget: [b.name, b.operator].filter(Boolean).join(' - '),
      pointUsername: b.name || '',
      pointOwner: b.operator || '',
      source: 'point-transfer',
    }));

    const allData = [
      ...paymentWithType,
      ...batchWithType,
      ...pointTransferWithType,
    ];

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
    if (isProviderManaged(original)) {
      return res.status(400).json({ message: 'عملية Alragheb تدار من سجل المزوّد ولا يتغير نوع دفعها' });
    }
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

    res.json({
      message: 'تم تحديث نوع الدفع بنجاح',
      payment: sanitizePaymentStatusForResponse(updatedPayment),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'حدث خطأ في السيرفر' });
  }
});

router.get('/user/allconfirmed', authMiddleware, async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);
    const filter = buildPaymentFilters(req.query, {
      status: { $in: FINAL_STATUSES },
    });
    const [payments, total] = await Promise.all([
      InternetPayment.find(filter)
        .select(PAYMENT_FIELDS)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      InternetPayment.countDocuments(filter),
    ]);

    res.json(
      paginatedResponse({
        data: sanitizePaymentsStatusForResponse(payments),
        page,
        limit,
        total,
      })
    );
  } catch (error) {
    console.error('فشل في جلب عمليات المستخدم:', error);
    res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
});

// تأكيد العملية وإضافة المبلغ إلى المستخدم
router.post('/confirm-payment', async (req, res) => {
  try {
    const result = await confirmPaymentService({ ...req.body, actorId: req.user.id });
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

    res.json(sanitizePaymentsStatusForResponse(payments.map(customerPayment)));
  } catch (error) {
    console.error('فشل في جلب عمليات المستخدم:', error);
    res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
});

// routes/admin.js
router.post('/reject/:id', async (req, res) => {
  try {
    const result = await refundManualPayment({ id: req.params.id, reason: req.body.reason, actorId: req.user.id });
    req.io?.to('admins').emit('json_message', true);
    await emitPendingPayments(req);
    res.json({ message: result.duplicate ? 'الرصيد معاد سابقًا' : 'تم الرفض وإرجاع الرصيد لصاحب العملية', duplicate: result.duplicate });
  } catch (error) { res.status(error.status || 500).json({ message: error.status ? error.message : 'تعذر رفض العملية', code: error.code }); }
});

router.get('/all-user', authMiddleware, requireAdmin, async (req, res) => {
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
    const report = await getOrSet(
      cacheKey('report:pos-balance', req.query),
      300,
      () =>
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
                $add: [
                  '$expensesPaid',
                  '$expensesUnpaid',
                  '$expensesInProgress',
                ],
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
    const allData = await getOrSet(
      cacheKey('report:new-pos-balance', req.query),
      300,
      async () => {
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
          internetTotals.map((item) => [
            String(item._id),
            item.totalInternet || 0,
          ])
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
      }
    );

    res.json(allData);
  } catch (error) {
    console.error('فشل في جلب التقرير:', error);
    res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
});

router.delete('/deleteuser/:id', authMiddleware, requireAdmin, async (req, res) => {
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
  try {
    const id = req.params.id, key = req.body.client_request_id;
    if (!/^[a-f0-9]{24}$/i.test(id) || typeof key !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(key)) return res.status(400).json({ message: 'معرف الحساب والمحاولة مطلوبان' });
    const total = sypAmount(req.body.amount);
    const result = await atomic(async (session) => {
      const previous = await Balance.findOne({ user: id, clientRequestId: key }).session(session);
      if (previous) {
        if (sypAmount(previous.amount) !== total) throw Object.assign(new Error('معرف المحاولة مستخدم لمبلغ مختلف'), { status: 409 });
        return { duplicate: true, depositId: previous._id };
      }
      const user = await User.findById(id).session(session);
      if (!user) throw Object.assign(new Error('الحساب غير موجود'), { status: 404 });
      const latest = await Balance.findOne({}).sort({ _id: -1 }).session(session);
      const debt = new Decimal(latest?.amountDaen || 0);
      if (debt.plus(total).gt(1200000)) throw Object.assign(new Error('تجاوز حد الرصيد المستحق'), { status: 409 });
      const credited = await User.findOneAndUpdate({ _id: id, balance: { $lte: new Decimal(MAX_WALLET).minus(total).toNumber() } }, walletAdjustment(total), { new: true, session });
      if (!credited) throw Object.assign(new Error('تجاوز حد المحفظة'), { status: 409 });
      const [deposit] = await Balance.create([{ user: id, name: user.email, amount: Number(total), isConfirmed: true, confirmedAt: new Date(), confirmedBy: req.user.id, clientRequestId: key, destination: req.user.email, operator: req.user.email, amountDaen: debt.plus(total).toNumber(), status: false }], { session });
      await WalletAdjustment.create([{ key: 'admin-credit:'+id+':'+key, user: id, actor: req.user.id, source: 'admin_credit', sourceId: deposit._id, amountSyp: total, balanceBeforeSyp: new Decimal(user.balance || 0).toFixed(2), balanceAfterSyp: new Decimal(credited.balance).toFixed(2), note: 'دفعة إدارية موثقة' }], { session });
      await recordBalanceStats(deposit, 1, session);
      return { duplicate: false, depositId: deposit._id };
    });
    await invalidateReports(); res.status(result.duplicate ? 200 : 201).json({ message: result.duplicate ? 'الدفعة مضافة سابقًا' : 'تمت إضافة الدفعة', ...result });
  } catch (error) { res.status(error.status || 500).json({ message: error.status ? error.message : 'تعذر إضافة الدفعة' }); }
});

router.delete('/delete/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const original = await Balance.findById(id).lean();
    if (original?.isConfirmed) return res.status(409).json({ message: 'الدفعة المؤكدة سجل مالي ولا يمكن حذفها' });
    const deleted = await Balance.findOneAndDelete({ _id: id, isConfirmed: { $ne: true } }).lean();
    if (deleted) await recordBalanceStats(deleted, -1);
    await invalidateReports();
    res.status(201).json('delete done');
  } catch (err) {
    console.log(err);
    res.status(401).json('error');
  }
});

router.get('/user/:id', authMiddleware, requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    const updateUser = await User.findById(id).select(USER_FIELDS).lean();
    res.status(200).json(updateUser);
  } catch (err) {
    res.status(401).json(err);
  }
});
router.put('/updateuser/:id', authMiddleware, requireAdmin, async (req, res) => {
  const id = req.params.id;
  try {
    const fields = Object.fromEntries(['name', 'email', 'number', 'role', 'card'].filter(key => Object.hasOwn(req.body, key)).map(key => [key, req.body[key]]));
    if (Object.hasOwn(req.body, 'balance')) return res.status(400).json({ message: 'تعديل الرصيد يتم بإجراء مالي موثق، وليس بتحرير بيانات الحساب' });
    if (fields.role && !['admin', 'user', 'user-point'].includes(fields.role)) return res.status(400).json({ message: 'صلاحية الحساب غير صالحة' });
    const updateUser = await User.findByIdAndUpdate(id, { $set: fields, $inc: { authVersion: 1 } }, {
      new: true,
    })
      .select(USER_FIELDS)
      .lean();
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
  const email = req.user.email;

  // if (!selectedCompany || !landline) {
  //   return res.status(400).json({ error: "يرجى إدخال الشركة والرقم الأرضي" });
  // }

  fatoraDataMap[email] = data;

  // إرسال البيانات لكل العملاء المتصلين عبر socket.io
  req.io?.to(email).emit('fatoraUpdated', fatoraDataMap[email]);

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
    res
      .status(201)
      .json(paginatedResponse({ data: daenBalance, page, limit, total }));
  } catch (err) {
    res.status(401).json(err);
  }
});

router.post('/confirm-daen', async (req, res) => {
  try {
    const id = req.body.id;
    if (!/^[a-f0-9]{24}$/i.test(id || '')) return res.status(400).json({ message: 'معرف الدفعة غير صالح' });
    const result = await atomic(async (session) => {
      const payment = await Balance.findById(id).session(session);
      if (!payment) throw Object.assign(new Error('الدفعة غير موجودة'), { status: 404 });
      if (payment.status) return { duplicate: true };
      if (!payment.isConfirmed) throw Object.assign(new Error('الدفعة غير مؤكدة'), { status: 409 });
      const total = Number(sypAmount(payment.amount));
      const latest = await Balance.findOne({}).sort({ _id: -1 }).session(session);
      if (!latest || new Decimal(latest.amountDaen || 0).lt(total)) throw Object.assign(new Error('السجل المالي بحاجة للمراجعة'), { status: 409 });
      payment.status = true; await payment.save({ session });
      await Balance.updateOne({ _id: latest._id }, { $inc: { amountDaen: -total } }, { session });
      return { duplicate: false };
    });
    await invalidateReports(); res.json({ success: true, message: 'تم تأكيد تسوية الدفعة', ...result });
  } catch (error) { res.status(error.status || 500).json({ message: error.status ? error.message : 'تعذر تسوية الدفعة' }); }
});
router.get('/payments/bydate', authMiddleware, async (req, res) => {
  try {
    const { fromDate, toDate, pagination } = req.query;

    if (!fromDate || !toDate) {
      return res
        .status(400)
        .json({ message: 'يرجى إرسال تاريخ البداية والنهاية' });
    }

    const start = new Date(fromDate);
    const end = new Date(toDate);

    end.setHours(23, 59, 59, 999);

    const filter = {
      status: { $in: FINAL_STATUSES },
      createdAt: { $gte: start, $lte: end },
    };

    // pagination=false فقط هو الذي يعطل الـ pagination
    const paginationDisabled = pagination === 'false';

    // بدون Pagination
    if (paginationDisabled) {
      const payments = await InternetPayment.find(filter)
        .select(PAYMENT_FIELDS)
        .sort({ createdAt: -1 })
        .lean();

      return res.json({
        data: sanitizePaymentsStatusForResponse(payments),
        pagination: null,
      });
    }

    // السلوك الحالي - Pagination
    const { page, limit, skip } = getPagination(req.query);

    const [payments, total] = await Promise.all([
      InternetPayment.find(filter)
        .select(PAYMENT_FIELDS)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),

      InternetPayment.countDocuments(filter),
    ]);

    res.json(
      paginatedResponse({
        data: sanitizePaymentsStatusForResponse(payments),
        page,
        limit,
        total,
      })
    );
  } catch (error) {
    console.error('فشل في جلب عمليات المستخدم حسب التاريخ:', error);

    res.status(500).json({
      message: 'حدث خطأ في الخادم',
    });
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

    const cachedReport = await getOrSet(
      cacheKey('report:balance-need', req.query),
      300,
      async () => {
        const stats = await getDailyStatsRange(start, end);
        const hasPaymentStats = stats.some(
          (stat) => stat.payments?.total?.count > 0
        );

        if (hasPaymentStats) {
          const byCompany = {};
          companies.forEach((company) => {
            byCompany[company] = {
              company,
              totalAmount: 0,
              avgOnDayAmount: 0,
              count: 0,
            };
          });

          let totalPayments = 0;
          let grandTotalFromStats = 0;

          stats.forEach((stat) => {
            const companyStats = stat.payments?.byCompany || {};
            companies.forEach((company) => {
              const entry =
                companyStats.get?.(cleanMapKey(company)) ||
                companyStats[cleanMapKey(company)];
              if (!entry) return;
              byCompany[company].totalAmount += entry.amount || 0;
              byCompany[company].count += entry.count || 0;
              grandTotalFromStats += entry.amount || 0;
              totalPayments += entry.count || 0;
            });
          });

          Object.values(byCompany).forEach((company) => {
            company.avgOnDayAmount = Number(
              (company.totalAmount / totalDays).toFixed(2)
            );
          });

          return {
            fromDate,
            toDate,
            totalDays,
            totalPayments,
            grandTotal: grandTotalFromStats,
            companies: Object.values(byCompany).sort(
              (a, b) => b.totalAmount - a.totalAmount
            ),
          };
        }

        return null;
      }
    );

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
