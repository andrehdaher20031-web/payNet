const DailyStats = require('../models/DailyStats');
const { cache } = require('./cache.service');

const toDayKey = (date = new Date()) => {
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return toDayKey(new Date());
  return value.toISOString().slice(0, 10);
};

const cleanMapKey = (value) =>
  String(value || 'unknown').replace(/\./g, '_').replace(/^\$/, '_');

const incCounter = (inc, path, amount = 0, count = 1) => {
  inc[`${path}.count`] = (inc[`${path}.count`] || 0) + count;
  inc[`${path}.amount`] = (inc[`${path}.amount`] || 0) + amount;
};

const updateDailyStats = async (date, inc) => {
  if (!Object.keys(inc).length) return null;

  const updated = await DailyStats.findOneAndUpdate(
    { day: toDayKey(date) },
    { $inc: inc },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();

  cache.delByPrefix('dailyStats:');
  cache.delByPrefix('report:');
  return updated;
};

const recordPaymentStats = async (payment, direction = 1) => {
  if (!payment) return null;

  const amount = Number(payment.amount || payment.calculatedAmount || 0) * direction;
  const count = direction;
  const inc = {};

  incCounter(inc, 'payments.total', amount, count);
  incCounter(inc, `payments.byStatus.${cleanMapKey(payment.status)}`, amount, count);
  incCounter(inc, `payments.byCompany.${cleanMapKey(payment.company)}`, amount, count);
  incCounter(
    inc,
    `payments.byPaymentType.${cleanMapKey(payment.paymentType || 'cash')}`,
    amount,
    count
  );

  return updateDailyStats(payment.createdAt || new Date(), inc);
};

const recordBalanceStats = async (balance, direction = 1) => {
  if (!balance) return null;

  const amount = Number(balance.amount || 0) * direction;
  const count = direction;
  const inc = {};
  const bucket = balance.isConfirmed ? 'confirmed' : 'unconfirmed';

  incCounter(inc, 'balances.total', amount, count);
  incCounter(inc, `balances.${bucket}`, amount, count);

  return updateDailyStats(balance.date || balance.createdAt || new Date(), inc);
};

const recordInvoiceStats = async (invoice, direction = 1) => {
  if (!invoice) return null;

  const inc = {};
  incCounter(inc, 'invoices.total', Number(invoice.total || 0) * direction, direction);

  return updateDailyStats(invoice.createdAt || new Date(), inc);
};

const getDailyStatsRange = async (fromDate, toDate) => {
  const start = toDayKey(fromDate);
  const end = toDayKey(toDate);

  return DailyStats.find({ day: { $gte: start, $lte: end } })
    .sort({ day: 1 })
    .lean();
};

module.exports = {
  cleanMapKey,
  getDailyStatsRange,
  recordBalanceStats,
  recordInvoiceStats,
  recordPaymentStats,
  toDayKey,
};
