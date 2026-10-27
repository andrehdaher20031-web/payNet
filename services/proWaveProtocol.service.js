const Decimal = require('decimal.js');
const plain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const first = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');
const text = (value) => typeof value === 'string' ? value.trim() : '';
const statusText = (value) => text(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
const COMPLETED = new Set(['completed', 'complete', 'success', 'successful', 'done', 'paid', 'تم التسديد', 'ناجح']);
const FAILED = new Set(['rejected', 'reject', 'failed', 'failure', 'canceled', 'cancelled', 'declined']);
const payload = (response) => first(response?.message?.data, response?.data?.message?.data, response?.data?.data, response?.data, plain(response?.message) ? response.message : undefined, response) || {};
// Request identifiers and invoice identifiers must never share a fallback.
const invoiceName = (value = {}) => text(first(value.sales_invoice, value.invoice_name, value.invoice));
const requestName = (value = {}) => text(first(value.name, value.request_name, value.requestName, value.id));
const money = (value) => {
  if (value === undefined || value === null || value === '' || typeof value === 'boolean' || typeof value === 'object') return null;
  try { const result = new Decimal(String(value).replace(/,/g, '')); return result.isFinite() && result.gte(0) ? result.toNumber() : null; } catch { return null; }
};
const invoiceAmount = (value = {}) => money(first(value['Total Amount'], value.total_amount, value.totalAmount, value.grand_total, value.rounded_total, value.amount));
const codes = (response) => {
  const value = payload(response);
  const candidate = first(value.digital_codes, value.digitalCodes, value.digital_code, value.digitalCode, value.codes, value.cards, response?.digital_codes, response?.codes);
  const valid = (item) => typeof item === 'string' && item.trim() || plain(item) && first(item.code, item.pin, item.card_number, item.cardNumber, item.digital_code, item.serial, item.voucher, item.password) !== undefined;
  if (candidate !== undefined) return (Array.isArray(candidate) ? candidate : [candidate]).filter(valid);
  return plain(value) && valid(value) ? [value] : [];
};
const explicitFailure = (response) => {
  const value = payload(response);
  return [response?.success, value?.success].some((entry) => entry === false || entry === 'false') ||
    [response?.status, value?.status, response?.message?.status].some((entry) => FAILED.has(statusText(entry)) || ['error', 'fail'].includes(statusText(entry)));
};
const inspect = (response, operationType) => {
  const value = payload(response);
  const request = plain(value.request) ? value.request : plain(value.direct_topup_request) ? value.direct_topup_request : value;
  const invoice = invoiceName(request) || invoiceName(value) || invoiceName(response);
  const digitalCodes = codes(response);
  const rechargeStatus = text(first(request.recharge_status, request.rechargeStatus, request.request_status, request.status));
  const rejected = FAILED.has(statusText(rechargeStatus)) || explicitFailure(response);
  const errorCode = statusText(first(request.error_code, request.code, value.error_code, response?.error_code));
  const definitiveRejection = FAILED.has(statusText(rechargeStatus)) || rejected && new Set(['insufficient balance', 'insufficient funds', 'out of stock', 'item unavailable', 'invalid item', 'invalid player']).has(errorCode);
  const completed = operationType === 'direct_topup' ? COMPLETED.has(statusText(rechargeStatus)) : Boolean(digitalCodes.length);
  return {
    request, invoice, requestName: operationType === 'direct_topup' ? requestName(request) : '', rechargeStatus,
    rejected, definitiveRejection, completed: completed && !rejected, digitalCodes,
    providerCostUsd: invoiceAmount(request) ?? invoiceAmount(value),
    rejectionReason: text(first(request.rejection_reason, request.rejectionReason, request.failure_reason, request.message)),
    accepted: operationType === 'direct_topup' ? Boolean(requestName(request)) : Boolean(invoice || digitalCodes.length),
  };
};
const CUSTOMER_EXTRA_KEYS = ['provider', 'operation_type', 'prowave_operation_type', 'item_code', 'item_name', 'item_title', 'qty', 'currency', 'game', 'player_id', 'playerId', 'customer_identifier', 'customer_contact', 'paynet_currency', 'paynet_amount_syp', 'paynet_unit_amount_syp', 'paynet_sale_price_usd', 'paynet_exchange_rate', 'paynet_margin_percent', 'paynet_rounding_step', 'client_request_id', 'prowave_transaction_id', 'prowave_request_name', 'name', 'recharge_status', 'sales_invoice', 'prowave_sales_invoice', 'digital_codes', 'paynet_refunded_syp', 'completed_at', 'failed_at'];
const customerPayment = (payment) => {
  const row = payment?.toObject ? payment.toObject() : payment;
  if (!row) return row;
  const extra = Object.fromEntries(CUSTOMER_EXTRA_KEYS.filter((key) => row.extra?.[key] !== undefined).map((key) => [key, row.extra[key]]));
  return Object.fromEntries(['_id', 'landline', 'company', 'speed', 'email', 'amount', 'calculatedAmount', 'paymentType', 'status', 'note', 'createdAt', 'updatedAt'].map((key) => [key, row[key]]).concat([['extra', extra]]));
};
const customerTransaction = (transaction) => {
  const row = transaction?.toObject ? transaction.toObject() : transaction;
  if (!row) return row;
  return Object.fromEntries(['_id', 'payment', 'clientRequestId', 'operationType', 'itemCode', 'itemTitle', 'game', 'playerId', 'qty', 'paynetAmountSyp', 'paynetCurrency', 'prowaveInvoice', 'prowaveRequestName', 'rechargeStatus', 'status', 'stage', 'deliveryStatus', 'createdAt', 'updatedAt', 'paynetRefundedSyp'].map((key) => [key, row[key]]));
};
module.exports = { Decimal, plain, payload, invoiceName, requestName, invoiceAmount, money, codes, inspect, customerPayment, customerTransaction };
