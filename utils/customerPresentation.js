const chatServiceLabel = 'تطبيقات الدردشة';
const customerText = (value) => typeof value === 'string' ? value
  .replace(/https?:\/\/(?:www\.|api\.)?alragheb-store\.com[^\s"'<>]*/gi, 'PayNet')
  .replace(/\b(?:alragheb|alrageb)\b|الراغب/gi, 'PayNet') : value;
const isChatPayment = (payment) => payment?.extra?.provider === 'alragheb' || /alragheb|alrageb|الراغب/i.test(payment?.company || '');

module.exports = { chatServiceLabel, customerText, isChatPayment };
