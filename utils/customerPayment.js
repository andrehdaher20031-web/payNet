const allowed = new Set(['provider', 'operation_type', 'prowave_operation_type', 'transaction_id', 'product_id', 'product_name', 'item_code', 'item_name', 'item_title', 'game', 'player_id', 'recharge_category', 'qty', 'currency', 'paynet_currency', 'paynet_amount_syp', 'paynet_refunded_syp', 'refunded_at', 'completed_at', 'failed_at', 'digital_codes', 'sales_invoice', 'prowave_sales_invoice', 'prowave_request_name', 'prowave_recharge_status', 'manual_refunded_at', 'manual_refunded_syp']);
const { chatServiceLabel, customerText, isChatPayment } = require('./customerPresentation');
const customerPayment = (payment) => {
  const plain = typeof payment?.toObject === 'function' ? payment.toObject() : payment;
  if (!plain || typeof plain !== 'object') return plain;
  return { ...plain,
    company: isChatPayment(plain) ? chatServiceLabel : customerText(plain.company),
    speed: customerText(plain.speed), note: customerText(plain.note),
    extra: Object.fromEntries(Object.entries(plain.extra || {}).filter(([key]) => allowed.has(key))
      .map(([key, value]) => [key, ['product_name', 'item_name', 'item_title'].includes(key) ? customerText(value) : value])) };
};
module.exports = { customerPayment };
