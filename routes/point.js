const express = require("express");
const router = express.Router();
const User = require('../models/User');
const Point = require("../models/Point")
const authMiddleware = require("../middleware/authMiddleware");
const Payment = require("../models/Payment"); // تأكد أنك استوردت Payment
const Balance = require("../models/Balance");



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

    res.status(201).json({ message: "تمت إضافة نقطة البيع بنجاح", newPoint });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "حدث خطأ أثناء إضافة نقطة البيع" });
  }
  
});

router.get('/add-point', async (req, res) => {
  try {
    const { email } = req.query; // ✅ استخدم query وليس body
    const FormData = await Point.find({ email });
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

    res.status(200).json({ message: "تم تعديل الرصيد بنجاح", point, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "حدث خطأ أثناء تعديل الرصيد" });
  }
});


router.get("/all", async (req, res) => {
  try {
    const {email} = req.query
    const payments = await Balance.find({ destination: email }).sort({ date: -1 });
    res.json(payments);
  } catch (error) {
    console.error("خطأ في جلب الدفعات:", error);
    res.status(500).json({ message: "حدث خطأ في الخادم" });
  }
});

router.get("/all-point", async (req, res) => {
  try {
    const {email} = req.query;
    const payments = await Balance.find({ name :email }).sort({ date: -1 });
    res.json(payments);
  } catch (error) {
    console.error("خطأ في جلب الدفعات:", error);
    res.status(500).json({ message: "حدث خطأ في الخادم" });
  }
});







// ✅ فلترة العمليات حسب المستخدم
router.get("/user/confirmed/point", async (req, res) => {
  try {
    const {emailPoint} = req.query

    const payments = await Point.find({
      email: emailPoint,
    });
    const paymentsPoint = payments.map(p => p.username);

const finical = await Payment.find({ email: { $in: paymentsPoint } });

    res.status(201).json(finical)

  } catch (error) {
    console.error("فشل في جلب عمليات المستخدم:", error);
    res.status(500).json({ message: "حدث خطأ في الخادم" });
  }
});



module.exports = router; // هذا السطر مهم جداً
