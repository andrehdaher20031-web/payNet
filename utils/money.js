const Decimal = require('decimal.js');
const MAX_WALLET = 1000000000000;
const moneyError = (message, status = 400, code = 'INVALID_AMOUNT') => Object.assign(new Error(message), { status, code });
const sypAmount = (value, { allowZero = false } = {}) => {
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && !/^\d+(\.\d{1,2})?$/.test(value))) throw moneyError('المبلغ يجب أن يكون رقمًا صالحًا بحد أقصى منزلتين عشريتين');
  let amount;
  try { amount = new Decimal(value); } catch { throw moneyError('المبلغ غير صالح'); }
  if (!amount.isFinite() || amount.lt(0) || (!allowZero && amount.eq(0)) || amount.gt(MAX_WALLET) || amount.decimalPlaces() > 2) throw moneyError('المبلغ خارج الحدود المسموحة');
  return amount.toFixed(2);
};
const walletAdjustment = (amount) => [{ $set: { balance: { $round: [{ $add: [{ $ifNull: ['$balance', 0] }, Number(amount)] }, 2] } } }];
module.exports = { Decimal, MAX_WALLET, sypAmount, walletAdjustment, moneyError };
