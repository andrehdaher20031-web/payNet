const PROVIDER_NEUTRAL_PENDING_STATUS = 'قيد التنفيذ';

const normalizePaymentStatusLabel = (status) => {
  if (status === undefined || status === null || status === '') return status;

  const text = String(status).trim();
  if (!/prowave/i.test(text)) return status;

  const sanitized = text
    .replace(/\s*(?:لدى|عبر)\s*Prowave\s*/gi, ' ')
    .replace(/\bProwave\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitized || PROVIDER_NEUTRAL_PENDING_STATUS;
};

const sanitizePaymentStatusForResponse = (payment) => {
  if (!payment || typeof payment !== 'object') return payment;

  const status = normalizePaymentStatusLabel(payment.status);
  const rechargeStatus = normalizePaymentStatusLabel(payment.extra?.recharge_status);
  const shouldUpdateExtra = rechargeStatus !== payment.extra?.recharge_status;

  if (status === payment.status && !shouldUpdateExtra) return payment;

  return {
    ...payment,
    status,
    extra: shouldUpdateExtra
      ? { ...payment.extra, recharge_status: rechargeStatus }
      : payment.extra,
  };
};

const sanitizePaymentsStatusForResponse = (payments = []) =>
  payments.map(sanitizePaymentStatusForResponse);

module.exports = {
  PROVIDER_NEUTRAL_PENDING_STATUS,
  normalizePaymentStatusLabel,
  sanitizePaymentStatusForResponse,
  sanitizePaymentsStatusForResponse,
};
