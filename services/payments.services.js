const mongoose = require('mongoose');
const Balance = require('../models/Balance');
const Payment = require('../models/Payment');
const User = require('../models/User');
const WalletAdjustment = require('../models/WalletAdjustment');
const { cache } = require('./cache.service');
const { recordBalanceStats, recordPaymentStats } = require('./dailyStats.service');
const { Decimal, MAX_WALLET, sypAmount, walletAdjustment, moneyError } = require('../utils/money');

const atomic = async (task) => {
  const session = await mongoose.startSession();
  try { let result; await session.withTransaction(async () => { result = await task(session); }); return result; }
  finally { await session.endSession(); }
};
const idRequired = (id) => { if (!mongoose.isValidObjectId(id)) throw moneyError('معرف العملية غير صالح'); };
const isProviderManaged = (payment) => ['prowave', 'alragheb', 'aleso'].includes(payment?.extra?.provider);
const invalidate = async () => { await Promise.allSettled(['balance:', 'payments:', 'users:', 'report:'].map(prefix => cache.delByPrefix(prefix))); };

const confirmPaymentService = async ({ id, amount, actorId }) => {
  idRequired(id);
  const result = await atomic(async (session) => {
    const deposit = await Balance.findById(id).session(session);
    if (!deposit) throw moneyError('لم يتم العثور على الدفعة', 404, 'DEPOSIT_NOT_FOUND');
    const total = sypAmount(deposit.amount);
    if (amount !== undefined && sypAmount(amount) !== total) throw moneyError('المبلغ المرسل لا يطابق الدفعة المسجلة', 409, 'AMOUNT_MISMATCH');
    const user = await User.findById(deposit.user).session(session);
    if (!user) throw moneyError('صاحب الدفعة غير موجود', 409, 'DEPOSIT_OWNER_MISSING');
    if (deposit.isConfirmed) return { success: true, duplicate: true, message: 'الدفعة مؤكدة سابقًا', data: { userId: user._id, newBalance: user.balance, paymentId: deposit._id } };
    const updated = await Balance.findOneAndUpdate({ _id: id, isConfirmed: { $ne: true } }, { $set: { isConfirmed: true, confirmedAt: new Date(), ...(actorId ? { confirmedBy: actorId } : {}) } }, { new: true, session });
    if (!updated) throw moneyError('تغيرت حالة الدفعة، أعد المحاولة', 409, 'DEPOSIT_CHANGED');
    const credited = await User.findOneAndUpdate({ _id: user._id, balance: { $lte: new Decimal(MAX_WALLET).minus(total).toNumber() } }, walletAdjustment(total), { new: true, session });
    if (!credited) throw moneyError('تعذر إضافة الرصيد ضمن حدود المحفظة', 409, 'WALLET_LIMIT');
    await WalletAdjustment.create([{ key: `deposit:${id}`, user: user._id, actor: actorId, source: 'deposit', sourceId: deposit._id, amountSyp: total, balanceBeforeSyp: new Decimal(user.balance || 0).toFixed(2), balanceAfterSyp: new Decimal(credited.balance).toFixed(2), note: 'تأكيد الدفعة المسجلة' }], { session });
    await recordBalanceStats(updated, 1, session);
    return { success: true, duplicate: false, message: 'تم تحديث رصيد المستخدم', data: { userId: user._id, newBalance: credited.balance, paymentId: updated._id } };
  });
  await invalidate(); return result;
};

const refundManualPayment = async ({ id, reason, actorId }) => {
  idRequired(id);
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 1000) throw moneyError('سبب الرفض مطلوب من 3 إلى 1000 حرف');
  const result = await atomic(async (session) => {
    const payment = await Payment.findById(id).session(session);
    if (!payment) throw moneyError('العملية غير موجودة', 404, 'PAYMENT_NOT_FOUND');
    if (isProviderManaged(payment)) throw moneyError('عملية المزوّد تدار من لوحة الربط ولا يمكن رفضها يدويًا', 409, 'PROVIDER_MANAGED');
    const existing = await WalletAdjustment.findOne({ key: `manual-refund:${id}` }).session(session);
    if (existing || payment.extra?.manual_refunded_at) return { duplicate: true, payment };
    if (!['جاري التسديد', 'بدء التسديد'].includes(payment.status)) throw moneyError('يمكن رفض العملية المعلقة فقط', 409, 'PAYMENT_FINAL');
    const total = sypAmount(payment.calculatedAmount ?? payment.amount);
    const owner = await User.findById(payment.user).session(session);
    if (!owner) throw moneyError('صاحب العملية غير موجود', 409, 'PAYMENT_OWNER_MISSING');
    const before = payment.toObject();
    const credited = await User.findOneAndUpdate({ _id: owner._id, balance: { $lte: new Decimal(MAX_WALLET).minus(total).toNumber() } }, walletAdjustment(total), { new: true, session });
    if (!credited) throw moneyError('تعذر إعادة الرصيد', 409, 'WALLET_LIMIT');
    payment.status = 'غير مسددة'; payment.note = reason.trim();
    payment.extra = { ...payment.extra, manual_refunded_at: new Date().toISOString(), manual_refunded_syp: total, manual_refunded_by: actorId ? String(actorId) : undefined };
    await payment.save({ session });
    await WalletAdjustment.create([{ key: `manual-refund:${id}`, user: owner._id, actor: actorId, source: 'manual_refund', sourceId: payment._id, amountSyp: total, balanceBeforeSyp: new Decimal(owner.balance || 0).toFixed(2), balanceAfterSyp: new Decimal(credited.balance).toFixed(2), note: reason.trim() }], { session });
    await recordPaymentStats(before, -1, session); await recordPaymentStats(payment, 1, session);
    return { duplicate: false, payment };
  });
  await invalidate(); return result;
};

const transitionManualPayment = async ({ id, target, actorId }) => {
  idRequired(id);
  if (!['بدء التسديد', 'تم التسديد'].includes(target)) throw moneyError('الحالة غير صالحة');
  const result = await atomic(async (session) => {
    const payment = await Payment.findById(id).session(session);
    if (!payment) throw moneyError('العملية غير موجودة', 404, 'PAYMENT_NOT_FOUND');
    if (isProviderManaged(payment)) throw moneyError('عملية المزوّد تدار من لوحة الربط', 409, 'PROVIDER_MANAGED');
    if (payment.status === target) return payment;
    if (!['جاري التسديد', 'بدء التسديد'].includes(payment.status)) throw moneyError('العملية نهائية ولا تقبل هذا التعديل', 409, 'PAYMENT_FINAL');
    const before = payment.toObject(); payment.status = target;
    payment.extra = { ...payment.extra, manual_status_by: actorId ? String(actorId) : undefined, manual_status_at: new Date().toISOString() };
    await payment.save({ session }); await recordPaymentStats(before, -1, session); await recordPaymentStats(payment, 1, session);
    return payment;
  });
  await invalidate(); return result;
};

module.exports = { confirmPaymentService, refundManualPayment, transitionManualPayment, isProviderManaged, atomic };

