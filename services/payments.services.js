const Balance = require('../models/Balance');
const User = require('../models/User');
const { cache } = require('./cache.service');
const { recordBalanceStats } = require('./dailyStats.service');

const confirmPaymentService = async ({ id, amount }) => {
  if (!id || !amount) {
    throw {
      status: 400,
      message: 'البيانات غير مكتملة',
    };
  }

  const payment = await Balance.findById(id);
  if (!payment) {
    throw {
      status: 404,
      message: 'لم يتم العثور على الدفعة',
    };
  }

  const user = await User.findOne({ email: payment.name });
  if (!user) {
    throw {
      status: 404,
      message: 'المستخدم غير موجود',
    };
  }

  user.balance += Number(amount);
  await user.save();

  const wasConfirmed = payment.isConfirmed;
  payment.isConfirmed = true;
  await payment.save();

  if (!wasConfirmed) {
    await recordBalanceStats(payment, 1);
  }

  await cache.delByPrefix('balance:');
  await cache.delByPrefix('users:');
  await cache.delByPrefix('report:');

  return {
    success: true,
    message: 'تم تحديث رصيد المستخدم',
    data: {
      userId: user._id,
      newBalance: user.balance,
      paymentId: payment._id,
    },
  };
};

module.exports = { confirmPaymentService };
