// routes/admin.js
const express = require('express');
const router = express.Router();
const InternetPayment = require('../models/Payment');
const authMiddleware = require('../middleware/authMiddleware');
const User = require('../models/User');
const Balance = require('../models/Balance');

router.get('/pending', authMiddleware, async (req, res) => {
  const payments = await InternetPayment.find({
    status: { $in: ['جاري التسديد', 'بدء التسديد'] },
  });

  // إرسال التحديث عبر Socket.IO لكل العملاء
  const io = req.app.get('io');
  io.emit('pendingPaymentsUpdate', payments); // الاسم يمكن تغييره حسب الحاجة

  res.json(payments);
});

router.patch('/confirm/:id', async (req, res) => {
  const { id } = req.params;
  const updated = await InternetPayment.findByIdAndUpdate(
    id,
    { status: 'تم التسديد' },
    { new: true }
  );
  res.json(updated);
});

router.patch('/start/:id', async (req, res) => {
  const { id } = req.params;
  console.log({ id });
  const updated = await InternetPayment.findByIdAndUpdate(
    id,
    { status: 'بدء التسديد' },
    { new: true }
  );
  res.json(updated);
});

router.get('/user/confirmed', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const payments = await InternetPayment.find({ user: userId }).lean();
    const batchpayments = await Balance.find({ user: userId })
      .sort({ date: -1 })
      .lean();

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

    res.json(allData);
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

    // تحديث العملية
    const updatedPayment = await InternetPayment.findByIdAndUpdate(
      id,
      { paymentType },
      { new: true }
    );

    if (!updatedPayment) {
      return res.status(404).json({ message: 'العملية غير موجودة' });
    }

    res.json({ message: 'تم تحديث نوع الدفع بنجاح', payment: updatedPayment });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'حدث خطأ في السيرفر' });
  }
});

router.get('/user/allconfirmed', authMiddleware, async (req, res) => {
  try {
    const payments = await InternetPayment.find({
      status: { $in: ['تم التسديد', 'غير مسددة'] },
    });

    res.json(payments);
  } catch (error) {
    console.error('فشل في جلب عمليات المستخدم:', error);
    res.status(500).json({ message: 'حدث خطأ في الخادم' });
  }
});

// تأكيد العملية وإضافة المبلغ إلى المستخدم
router.post('/confirm-payment', async (req, res) => {
  try {
    const { id, amount } = req.body;

    if (!id || !amount) {
      return res.status(400).json({ message: 'البيانات غير مكتملة' });
    }

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

    // حدّث الرصيد وحالة التأكيد
    user.balance += amount;
    await user.save();

    payment.isConfirmed = true;
    await payment.save();
    res.status(200).json({ success: true, message: 'تم تحديث رصيد المستخدم' });
  } catch (error) {
    console.error('خطأ أثناء تأكيد الدفعة:', error);
    res.status(500).json({ message: 'حدث خطأ أثناء معالجة الطلب' });
  }
});

// ✅ فلترة العمليات حسب المستخدم
router.get('/user/pending', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const payments = await InternetPayment.find({
      user: userId,
      status: { $in: ['جاري التسديد'] },
    });

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
    const payment = await InternetPayment.findById(paymentId);

    // 1. تحديث العملية إلى "غير مسددة" مع سبب
    await InternetPayment.findByIdAndUpdate(paymentId, {
      status: 'غير مسددة',
      note: reason,
    });

    // 2. إرجاع الرصيد للمستخدم
    const user = await User.findOne({ email });
    if (user) {
      const Amount = payment.calculatedAmount;
      user.balance += Amount;
      await user.save();
    }
    req.io.emit('json_message', true);

    res.status(200).json({ message: 'تم الرفض وإرجاع الرصيد' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'حدث خطأ أثناء الرفض' });
  }
});

//جلب جميع المستخدمين
router.get('/all-user', authMiddleware, async (req, res) => {
  const allUser = await User.find();
  try {
    res.status(201).json(allUser);
  } catch (err) {
    res.status(401).json(err);
  }
});

router.get('/getPOSBalanceReport', async (req, res) => {
  try {
    const report = await User.aggregate([
      // ===============================
      // الإيداعات
      // ===============================
      {
        $lookup: {
          from: 'harams',
          localField: '_id',
          foreignField: 'user',
          as: 'deposits',
        },
      },

      // ===============================
      // المصاريف حسب الحالة
      // ===============================
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

      // ===============================
      // حساب الإيداعات المؤكدة وغير المؤكدة
      // ===============================
      {
        $addFields: {
          confirmedDeposits: {
            $sum: {
              $map: {
                input: {
                  $filter: {
                    input: '$deposits',
                    as: 'd',
                    cond: { $eq: ['$$d.isConfirmed', true] },
                  },
                },
                as: 'x',
                in: '$$x.amount',
              },
            },
          },
          unconfirmedDeposits: {
            $sum: {
              $map: {
                input: {
                  $filter: {
                    input: '$deposits',
                    as: 'd',
                    cond: { $eq: ['$$d.isConfirmed', false] },
                  },
                },
                as: 'x',
                in: '$$x.amount',
              },
            },
          },
          totalDeposits: { $sum: '$deposits.amount' },
        },
      },

      // ===============================
      // استخراج المصاريف كأرقام فقط
      // ===============================
      {
        $addFields: {
          expensesPaid: {
            $ifNull: [
              {
                $arrayElemAt: [
                  {
                    $map: {
                      input: {
                        $filter: {
                          input: '$expensesByStatus',
                          as: 'e',
                          cond: { $eq: ['$$e._id', 'تم التسديد'] },
                        },
                      },
                      as: 'x',
                      in: '$$x.total',
                    },
                  },
                  0,
                ],
              },
              0,
            ],
          },

          expensesUnpaid: {
            $ifNull: [
              {
                $arrayElemAt: [
                  {
                    $map: {
                      input: {
                        $filter: {
                          input: '$expensesByStatus',
                          as: 'e',
                          cond: { $eq: ['$$e._id', 'غير مسددة'] },
                        },
                      },
                      as: 'x',
                      in: '$$x.total',
                    },
                  },
                  0,
                ],
              },
              0,
            ],
          },

          expensesInProgress: {
            $ifNull: [
              {
                $arrayElemAt: [
                  {
                    $map: {
                      input: {
                        $filter: {
                          input: '$expensesByStatus',
                          as: 'e',
                          cond: {
                            $in: ['$$e._id', ['بدء التسديد', 'جاري التسديد']],
                          },
                        },
                      },
                      as: 'x',
                      in: '$$x.total',
                    },
                  },
                  0,
                ],
              },
              0,
            ],
          },
        },
      },

      // ===============================
      // مجموع المصاريف
      // ===============================
      {
        $addFields: {
          totalExpenses: {
            $add: ['$expensesPaid', '$expensesUnpaid', '$expensesInProgress'],
          },
        },
      },

      // ===============================
      // الحسابات النهائية
      // ===============================
      {
        $addFields: {
          netBalance: {
            $subtract: ['$totalDeposits', '$totalExpenses'],
          },
          finalBalance: {
            $add: [
              { $subtract: ['$totalDeposits', '$totalExpenses'] },
              '$balance',
            ],
          },
        },
      },

      // ===============================
      // الأعمدة النهائية
      // ===============================
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
    ]);

    res.status(200).json(report);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'حدث خطأ أثناء جلب التقرير' });
  }
});

router.delete('/deleteuser/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await User.findByIdAndDelete({ _id: id });
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
    if (daenamount > 1000000) {
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
    await User.findByIdAndUpdate(
      { _id: id },
      { balance: balanceAmount },
      { new: true }
    );
    res.status(201).json('تم اضافة الدفعة بنجاح');
  } catch (err) {
    res.status(401).json(err);
  }
});

//حذف دفعة
router.delete('/delete/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await Balance.findByIdAndDelete({ _id: id });
    res.status(201).json('delete done');
  } catch (err) {
    console.log(err);
    res.status(401).json('error');
  }
});

router.get('/user/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  try {
    const updateUser = await User.findById(id);
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
    });
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
    const daenBalance = await Balance.find({ status: false });
    res.status(201).json(daenBalance);
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
    console.log(lastBalance);
    await payment.save();

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

    // البحث في قاعدة البيانات
    const payments = await InternetPayment.find({
      status: { $in: ['تم التسديد', 'غير مسددة'] },
      createdAt: { $gte: start, $lte: end }, // بين التاريخين
    }).sort({ createdAt: -1 });

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

    const payments = await InternetPayment.find({
      status: 'تم التسديد',
      createdAt: { $gte: start, $lte: end },
    }).lean();

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
      const amount = (payment.amount || 0) / 100;

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
