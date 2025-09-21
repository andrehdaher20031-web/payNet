// addUser.js
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const User = require("./models/User");

// تحميل متغيرات البيئة
dotenv.config();

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(async () => {
  console.log("🟢 تم الاتصال بقاعدة البيانات");

  const email = "hadi46"; // يمكنك تغييره
  const plainPassword = "Hh123123"; // كلمة المرور (غير مشفرة)
  const name ="هادي دومط";
  const number = "1";

  // تحقق إذا كان المستخدم موجود مسبقاً
  const existingUser = await User.findOne({ email });
  if (existingUser) {
    console.log("⚠️ المستخدم موجود مسبقاً");
    return process.exit(0);
  }

  const balance = 0;
  const role = "user";

  // ✅ توليد id يدوي
  const customId = new mongoose.Types.ObjectId("6881182fc169b808649726da"); // يولد ObjectId جديد
  // أو يمكنك استخدام نص مخصص: const customId = "user_001";

  // إنشاء المستخدم مع id مخصص
  const newUser = new User({
    _id: customId,         // هنا وضعنا الـ id يدوي
    email,
    password: plainPassword,
    balance,
    name,
    number,
    role,
  });

  await newUser.save();
  console.log("✅ تم إنشاء المستخدم بنجاح بالـ id:", customId.toString());

  process.exit(0);
})
.catch((err) => {
  console.error("❌ خطأ في الاتصال بقاعدة البيانات:", err);
  process.exit(1);
});
