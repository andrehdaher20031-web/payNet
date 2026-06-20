// routes/balanceRoutes.js
const express = require('express');
const router = express.Router();

const Balance = require('../models/Balance');
const User = require('../models/User');
const authMiddleware = require('../middleware/auth');
const { confirmPaymentService } = require('../services/payments.services');
const { cache } = require('../services/cache.service');
const {
  buildDateRange,
  escapeRegex,
  getPagination,
  paginatedResponse,
} = require('../utils/pagination');
// const { confirmPaymentService } = require('../services/confirmPaymentService'); // تأكد من المسار

const BALANCE_FIELDS =
  'destination name number operator amount noticeNumber amountDaen date isConfirmed status createdAt user';

const invalidateBalanceCache = async () => {
  await cache.delByPrefix('balance:');
  await cache.delByPrefix('report:');
  await cache.delByPrefix('users:');
};

const buildBalanceFilters = (query = {}, baseFilter = {}) => {
  const filter = { ...baseFilter };
  const dateRange = buildDateRange(query);
  if (dateRange) filter.date = dateRange;
  if (query.search) {
    const search = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [{ name: search }, { destination: search }, { operator: search }];
  }
  return filter;
};
router.post('/haram', authMiddleware, async (req, res) => {
  try {
    const { destination, name, number, operator, noticeNumber, amount, date } =
      req.body;

    const userId = req.user.id;
    const cleanNoticeNumber = String(noticeNumber || '').trim();

    if (!cleanNoticeNumber) {
      return res.status(400).json({
        message: 'رقم الإشعار مطلوب',
      });
    }

    const existingNotice = await Balance.findOne({
      noticeNumber: cleanNoticeNumber,
    });

    if (existingNotice) {
      return res.status(409).json({
        message: 'رقم الإشعار مستخدم مسبقاً',
      });
    }

    const balanceDaen = await Balance.findOne({}).sort({ _id: -1 });
    const amountDaen = balanceDaen?.amountDaen || 0;

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        message: 'المستخدم غير موجود',
      });
    }

    const balanceDoc = new Balance({
      user: userId,
      destination,
      name,
      number,
      operator,
      noticeNumber: cleanNoticeNumber,
      amount: Number(amount),
      date,
      amountDaen,
    });

    await balanceDoc.save();
    await invalidateBalanceCache();

    const apiUrl = `https://apisyria.com/api/v1?resource=shamcash&action=find_tx&tx=${cleanNoticeNumber}&account_address=94c308290d8df1af551993db4ca3de0d&api_key=5eef4628bbf241f2b56bb73c60e8cd8de633513818b68db362b477eb17c05771`;

    const response = await fetch(apiUrl);

    if (!response.ok) {
      console.log('API Error:', response.status);

      return res.status(500).json({
        message: 'خطأ في التحقق من رقم الإشعار',
      });
    }

    const autoConfirm = await response.json();

    console.log('الرد من API:', autoConfirm);
    console.log(autoConfirm?.data?.found);
    if (!autoConfirm?.data?.found) {
      return res.status(404).json({
        message: 'خطأ في رقم الإشعار الرجاء التأكد منه',
      });
    }

    const apiDate = new Date(
      autoConfirm.data.transaction.datetime.replace(' ', 'T')
    );

    const requestDate = new Date(date);

    const diffMs = Math.abs(apiDate.getTime() - requestDate.getTime());
    const diffHours = diffMs / (1000 * 60 * 60);

    console.log('فرق الوقت بالساعات:', diffHours);

    if (
      Number(autoConfirm?.data?.transaction?.amount) === Number(amount) &&
      autoConfirm?.data?.transaction?.currency === 'SYP' &&
      diffHours <= 48
    ) {
      await confirmPaymentService({
        id: balanceDoc.id,
        amount: Number(amount),
      });

      return res.status(200).json({
        message: 'تم اضافة الرصيد تلقائيا بنجاح',
      });
    }

    return res.status(200).json({
      message: 'لم يتم اضافة الرصيد و جاري معالجة الطلب يدويًا',
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      message: 'خطأ في الخادم',
    });
  }
});

router.get('/all', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { page, limit, skip } = getPagination(req.query);
    const filter = buildBalanceFilters(req.query, { user: userId });
    const [payments, total] = await Promise.all([
      Balance.find(filter)
        .select(BALANCE_FIELDS)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Balance.countDocuments(filter),
    ]);
    res.json(paginatedResponse({ data: payments, page, limit, total }));
  } catch (error) {
    console.error('خطأ في جلب الدفعات:', error);
    res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
});

router.get('/all-admin', async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query);
    const filter = buildBalanceFilters(req.query);
    const [payments, total] = await Promise.all([
      Balance.find(filter)
        .select(BALANCE_FIELDS)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Balance.countDocuments(filter),
    ]);
    res.json(paginatedResponse({ data: payments, page, limit, total }));
  } catch (error) {
    console.error('خطأ في جلب الدفعات:', error);
    res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
});

module.exports = router;
