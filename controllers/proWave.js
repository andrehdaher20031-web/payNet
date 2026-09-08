const axios = require('axios');
const mongoose = require('mongoose');
const User = require('../models/User');
const Payment = require('../models/Payment');
const ProWavePriceQuote = require('../models/ProWavePriceQuote');
const ProWaveTransaction = require('../models/ProWaveTransaction');
const {
  findDirectTopUpCatalogItem,
  listDirectTopUpCatalog,
  normalizeDirectTopUpGame,
} = require('../config/prowaveDirectTopupCatalog');
const { cache } = require('../services/cache.service');
const {
  calculateSypPricing,
  formatSypAmount,
  getExchangeRateConfig,
} = require('../services/exchangeRate.service');
const {
  createPendingTransaction,
  extractProWaveBalanceUsd,
  getInvoiceAmountUsd,
  markCompletedTransaction,
  markFailedTransaction,
  markPayNetReserved,
  getReconciliationReport,
  reconcileTransactionsWithInvoices,
} = require('../services/proWaveLedger.service');
const { recordPaymentStats } = require('../services/dailyStats.service');
const { PROVIDER_NEUTRAL_PENDING_STATUS } = require('../utils/paymentStatus');

const PROWAVE_BASE_URL =
  process.env.PROWAVE_BASE_URL || 'https://pro-wave.net/api/method';
const PROWAVE_TIMEOUT_MS = Number(process.env.PROWAVE_TIMEOUT_MS) || 30000;
const PROWAVE_ITEMS_CACHE_TTL_MS =
  Number(process.env.PROWAVE_ITEMS_CACHE_TTL_MS) || 5 * 60 * 1000;
const PROWAVE_ITEMS_MAX_PAGES =
  Number(process.env.PROWAVE_ITEMS_MAX_PAGES) || 50;
const PROWAVE_PRICE_REPORT_MAX_LIMIT =
  Number(process.env.PROWAVE_PRICE_REPORT_MAX_LIMIT) || 500;
const PROWAVE_QUOTE_TTL_SECONDS = Number(process.env.PROWAVE_QUOTE_TTL_SECONDS) || 180;
const PROWAVE_DIRECT_TOPUP_STATUS_INTERVAL_MS =
  Number(process.env.PROWAVE_DIRECT_TOPUP_STATUS_INTERVAL_MS) || 0;
const PROWAVE_DIRECT_TOPUP_STATUS_BATCH_LIMIT =
  Number(process.env.PROWAVE_DIRECT_TOPUP_STATUS_BATCH_LIMIT) || 25;
const PROWAVE_DIRECT_TOPUP_REQUIRE_PROVIDER_ITEM_CODE =
  process.env.PROWAVE_DIRECT_TOPUP_REQUIRE_PROVIDER_ITEM_CODE !== 'false';
const PAYMENT_FIELDS =
  'landline company speed email amount calculatedAmount paymentType status note extra createdAt updatedAt user';
const PENDING_STATUSES = ['جاري التسديد', 'بدء التسديد'];
const PROWAVE_PROVIDER = 'prowave';
const PAYNET_CURRENCY = 'SYP';
const DEFAULT_PROWAVE_CURRENCY = 'USD';
const DIGITAL_CARD_OPERATION = 'digital_card';
const DIRECT_TOPUP_OPERATION = 'direct_topup';
const STARTED_STATUS = 'بدء التسديد';
const DIRECT_TOPUP_PENDING_STATUS = PROVIDER_NEUTRAL_PENDING_STATUS;
const COMPLETED_STATUS = 'تم التسديد';
const FAILED_STATUS = 'غير مسددة';
const ADMIN_PENDING_PAYMENT_FILTER = {
  status: { $in: PENDING_STATUSES },
  $nor: [
    { 'extra.provider': PROWAVE_PROVIDER, 'extra.operation_type': DIRECT_TOPUP_OPERATION },
    { 'extra.provider': PROWAVE_PROVIDER, 'extra.prowave_operation_type': DIRECT_TOPUP_OPERATION },
  ],
};

const prowave = axios.create({
  baseURL: PROWAVE_BASE_URL,
  timeout: PROWAVE_TIMEOUT_MS,
});

const DIRECT_TOPUP_ITEM_GROUP_BY_GAME = {
  pubg: 'PUBG Cards',
  free_fire: 'Free Fire Cards',
};

const itemsCache = new Map();
let proWavePurchaseLock = Promise.resolve();
let reconciliationSchedulerStarted = false;
let directTopUpStatusSchedulerStarted = false;
let directTopUpStatusRefreshRunning = false;

const getProWaveHeaders = () => {
  const { PROWAVE_API_KEY, PROWAVE_API_SECRET } = process.env;

  if (!PROWAVE_API_KEY || !PROWAVE_API_SECRET) {
    const error = new Error('ProWave API credentials are missing');
    error.status = 500;
    throw error;
  }

  return {
    Authorization: `token ${PROWAVE_API_KEY}:${PROWAVE_API_SECRET}`,
    'Content-Type': 'application/json',
  };
};

const toNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getFirstPresent = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== '');

const toPositiveNumber = (...values) =>
  values.map((value) => toNumber(value, 0)).find((value) => value > 0) || 0;

const toPositiveInteger = (value, fallback = 1) => {
  const parsed = Math.trunc(toNumber(value, fallback));
  return parsed > 0 ? parsed : fallback;
};

const clampPositiveInteger = (value, fallback, max) =>
  Math.min(toPositiveInteger(value, fallback), max);

const getMissingQueryParams = (query, requiredParams) =>
  requiredParams.filter((param) => !query[param]);

const getMissingBodyParams = (body, requiredParams) =>
  requiredParams.filter((param) => !body[param]);

const normalizeExtra = (bodyExtra, extraFields = {}) => {
  if (bodyExtra && typeof bodyExtra === 'object' && !Array.isArray(bodyExtra)) {
    return { ...extraFields, ...bodyExtra };
  }

  return bodyExtra !== undefined ? bodyExtra : extraFields;
};

const sendSuccess = (res, data) => {
  res.json({
    success: true,
    source: 'prowave',
    data,
  });
};

const getErrorDetails = (error) =>
  error.responseData || error.response?.data || error.details || error.message;

const parseMaybeJson = (value) => {
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const getReadableErrorMessage = (value) => {
  const parsed = parseMaybeJson(value);

  if (!parsed) return '';
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed)) {
    return parsed.map(getReadableErrorMessage).find(Boolean) || '';
  }

  if (typeof parsed === 'object') {
    return (
      getReadableErrorMessage(parsed.message) ||
      getReadableErrorMessage(parsed.error) ||
      getReadableErrorMessage(parsed.description) ||
      getReadableErrorMessage(parsed.exception) ||
      getReadableErrorMessage(parsed._server_messages) ||
      getReadableErrorMessage(parsed.exc_type) ||
      ''
    );
  }

  return String(parsed);
};

const getProviderErrorPayload = (error) => {
  const details = getErrorDetails(error);
  const payload = getProWavePayload(details);

  return isPlainObject(payload) ? payload : {};
};

const getProviderReferenceId = (error) => {
  const details = getErrorDetails(error);
  const payload = getProviderErrorPayload(error);

  return getFirstPresent(
    payload.reference_id,
    payload.referenceId,
    details?.reference_id,
    details?.referenceId,
    details?.message?.reference_id,
    details?.message?.referenceId
  );
};

const getProviderErrorCode = (error) => {
  const details = getErrorDetails(error);
  const payload = getProviderErrorPayload(error);

  return getFirstPresent(
    payload.code,
    payload.error_code,
    details?.code,
    details?.error_code,
    details?.message?.code
  );
};

const isProWaveAxiosError = (error) => {
  const requestBaseUrl = String(error.config?.baseURL || '');
  const responseUrl = String(error.response?.config?.baseURL || '');

  return (
    requestBaseUrl === PROWAVE_BASE_URL ||
    responseUrl === PROWAVE_BASE_URL ||
    requestBaseUrl.includes('prowave') ||
    responseUrl.includes('prowave')
  );
};

const getErrorStatus = (error) => {
  const status = error.response?.status || error.status || 500;

  if (isProWaveAxiosError(error) && status >= 500) {
    return 502;
  }

  return status;
};

const sendError = (res, error, message) => {
  const status = getErrorStatus(error);
  const details = getErrorDetails(error);
  const readableMessage =
    getReadableErrorMessage(details) || getReadableErrorMessage(error.message);
  const providerReferenceId = getProviderReferenceId(error);
  const providerCode = getProviderErrorCode(error);

  res.status(status).json({
    success: false,
    message: readableMessage || message,
    fallbackMessage: message,
    stage: error.stage,
    provider: isProWaveAxiosError(error) ? PROWAVE_PROVIDER : undefined,
    providerCode,
    providerReferenceId,
    error: details,
  });
};

const getFailureMessage = (error, fallback) => {
  const details = getErrorDetails(error);
  return (
    getReadableErrorMessage(details) ||
    getReadableErrorMessage(error.message) ||
    fallback
  );
};

const getFromProWave = (url, options = {}) =>
  prowave.request({
    method: 'GET',
    url,
    headers: getProWaveHeaders(),
    ...options,
  });

const postToProWave = (url, data) =>
  prowave.post(url, data, {
    headers: getProWaveHeaders(),
  });

const withProWavePurchaseLock = async (task) => {
  const previousLock = proWavePurchaseLock;
  let releaseLock;

  proWavePurchaseLock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;

  try {
    return await task();
  } finally {
    releaseLock();
  }
};

const getProWaveBalanceSnapshot = async () => {
  try {
    const response = await getFromProWave('/get_balance');
    return response.data;
  } catch (error) {
    return {
      success: false,
      error: getErrorDetails(error),
    };
  }
};

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const getProWavePayload = (responseData) => {
  const candidates = [
    responseData?.message?.data,
    responseData?.data?.message?.data,
    responseData?.data?.data,
    responseData?.data,
    isPlainObject(responseData?.message) ? responseData.message : undefined,
    responseData,
  ];

  return (
    candidates.find(
      (value) => value !== undefined && value !== null && value !== ''
    ) || {}
  );
};

const getProWaveMessage = (responseData, fallback = '') => {
  const payload = getProWavePayload(responseData);
  const message = [
    responseData?.message?.message,
    responseData?.message,
    payload?.message,
    responseData?.description,
    payload?.description,
    responseData?.error,
    payload?.error,
    fallback,
  ]
    .map(getReadableErrorMessage)
    .find(Boolean);

  return message || fallback;
};

const normalizeProWaveText = (value) =>
  getReadableErrorMessage(value).trim().toLowerCase();

const isFailureText = (value) => {
  const normalized = normalizeProWaveText(value);
  if (!normalized) return false;

  return [
    'failed',
    'failure',
    'error',
    'exception',
    'not successfully',
    'unsuccessful',
    'insufficient',
    'not available',
    'unavailable',
    'out of stock',
    'cancelled',
    'canceled',
    'rejected',
    'فشل',
    'خطأ',
    'غير ناجح',
    'غير متوفر',
  ].some((pattern) => normalized.includes(pattern));
};

const isSuccessText = (value) => {
  const normalized = normalizeProWaveText(value);
  if (!normalized || isFailureText(normalized)) return false;

  return [
    'purchase completed successfully',
    'completed successfully',
    'purchased successfully',
    'successfully',
    'success',
    'succeeded',
    'تم بنجاح',
    'بنجاح',
    'ناجح',
  ].some((pattern) => normalized.includes(pattern));
};

const isFailureStatusValue = (value) => {
  if (value === false) return true;
  if (typeof value === 'number') return value <= 0;

  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return false;

  return [
    '0',
    'FALSE',
    'FAIL',
    'FAILED',
    'FAILURE',
    'ERROR',
    'EXCEPTION',
    'REJECTED',
    'CANCELLED',
    'CANCELED',
  ].includes(normalized);
};

const isSuccessStatusValue = (value) => {
  if (value === true) return true;
  if (typeof value === 'number') return value > 0;

  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return false;

  return [
    '1',
    'TRUE',
    'SUCCESS',
    'SUCCEEDED',
    'COMPLETED',
    'COMPLETE',
    'OK',
    '200',
  ].includes(normalized);
};

const isProWaveSuccess = (responseData) => {
  const payload = getProWavePayload(responseData);
  const statusCandidates = [
    responseData?.success,
    payload?.success,
    responseData?.status,
    payload?.status,
    responseData?.code,
    payload?.code,
    responseData?.message?.status,
    responseData?.message?.code,
  ];

  if (statusCandidates.some(isFailureStatusValue)) return false;
  if (statusCandidates.some(isSuccessStatusValue)) return true;

  const message = getProWaveMessage(responseData, '');
  if (isFailureText(message)) return false;
  if (getDigitalCodes(responseData).length) return true;
  if (getInvoiceName(payload, responseData)) return true;

  return isSuccessText(message);
};

const hasDigitalCodeFields = (value) =>
  isPlainObject(value) &&
  getFirstPresent(
    value.code,
    value.pin,
    value.card_number,
    value.cardNumber,
    value.serial,
    value.digital_code,
    value.digitalCode,
    value.voucher,
    value.password
  ) !== undefined;

const normalizeDigitalCodeList = (value) => {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== '');
  if (!isPlainObject(value)) return [value];
  if (hasDigitalCodeFields(value)) return [value];

  return Object.values(value).filter(
    (item) => item !== undefined && item !== null && item !== ''
  );
};

const getDigitalCodes = (responseData) => {
  const payload = getProWavePayload(responseData);
  const candidates = [
    payload?.digital_codes,
    payload?.digitalCodes,
    payload?.digital_code,
    payload?.digitalCode,
    payload?.codes,
    payload?.cards,
    payload?.items,
    responseData?.digital_codes,
    responseData?.digitalCodes,
    responseData?.codes,
    responseData?.cards,
    responseData?.message?.digital_codes,
    responseData?.message?.data?.digital_codes,
    responseData?.data?.digital_codes,
    responseData?.data?.codes,
  ];

  for (const candidate of candidates) {
    const codes = normalizeDigitalCodeList(candidate);
    if (codes.length) return codes;
  }

  return hasDigitalCodeFields(payload) ? [payload] : [];
};

const getInvoiceName = (payload, responseData = {}) =>
  getFirstPresent(
    payload?.sales_invoice,
    payload?.invoice_name,
    payload?.invoice,
    payload?.name,
    responseData?.sales_invoice,
    responseData?.invoice_name,
    responseData?.invoice,
    responseData?.message?.sales_invoice,
    responseData?.message?.data?.sales_invoice,
    responseData?.data?.sales_invoice,
    responseData?.data?.invoice_name,
    responseData?.data?.invoice
  );

const getProWaveTotalAmount = (payload) =>
  toNumber(
    getFirstPresent(
      payload?.['Total Amount'],
      payload?.total_amount,
      payload?.totalAmount,
      payload?.amount
    ),
    null
  );

const logProWaveResponse = (label, data) => {
  if (process.env.PROWAVE_DEBUG_RESPONSE !== 'true') return;

  try {
    console.log(`[ProWave] ${label}:`, JSON.stringify(data, null, 2));
  } catch {
    console.log(`[ProWave] ${label}:`, data);
  }
};

const CUSTOMER_HIDDEN_PAYMENT_EXTRA_KEYS = [
  'prowave_priced_item',
  'prowave_catalog_item',
  'prowave_response',
  'prowave_purchase_data',
  'prowave_codes_response',
  'prowave_total_amount_usd',
  'prowave_balance_before_response',
  'prowave_balance_after_response',
  'prowave_unit_cost_usd',
  'provider_unit_cost_usd',
  'prowave_provider_discount_usd',
  'prowave_provider_discount_percent',
  'provider_cost_usd',
  'provider_discount_usd',
  'provider_discount_percent',
];

const CUSTOMER_HIDDEN_TRANSACTION_KEYS = [
  'unitPriceUsd',
  'saleUnitPriceUsd',
  'providerUnitCostUsd',
  'providerDiscountUsd',
  'providerDiscountPercent',
  'expectedProviderDebitUsd',
  'actualProviderDebitUsd',
  'invoiceProviderDebitUsd',
  'expectedCostSyp',
  'actualCostSyp',
  'profitSyp',
  'profitPercent',
  'prowaveBalanceBeforeUsd',
  'prowaveBalanceAfterUsd',
  'providerBalanceStatus',
  'invoiceMatchStatus',
  'mismatchReason',
  'rawProviderBalanceBefore',
  'rawProviderBalanceAfter',
  'rawPurchaseResponse',
  'rawDirectTopupStatusResponse',
  'rawCodesResponse',
  'rawInvoice',
];

const sanitizePaymentForCustomer = (payment) => {
  const plain = typeof payment?.toObject === 'function' ? payment.toObject() : payment;

  if (!isPlainObject(plain)) return plain;
  if (!isPlainObject(plain.extra)) return plain;

  const extra = { ...plain.extra };
  CUSTOMER_HIDDEN_PAYMENT_EXTRA_KEYS.forEach((key) => delete extra[key]);

  return {
    ...plain,
    extra,
  };
};

const sanitizeDirectTopUpRequestForCustomer = (requestData = {}) => {
  if (!isPlainObject(requestData)) return {};

  const hiddenKeys = [
    'price',
    'amount',
    'total_amount',
    'Total Amount',
    'totalAmount',
    'grand_total',
    'rounded_total',
    'provider_cost_usd',
    'providerUnitCostUsd',
    'prowave_unit_cost_usd',
  ];
  const sanitized = { ...requestData };

  hiddenKeys.forEach((key) => delete sanitized[key]);
  return sanitized;
};

const sanitizeTransactionForCustomer = (transaction) => {
  const plain = typeof transaction?.toObject === 'function' ? transaction.toObject() : transaction;

  if (!isPlainObject(plain)) return plain;

  const sanitized = { ...plain };
  CUSTOMER_HIDDEN_TRANSACTION_KEYS.forEach((key) => delete sanitized[key]);
  return sanitized;
};

const buildPurchaseResultData = ({
  purchaseData,
  invoiceName,
  digitalCodes,
  payment,
  amountToDeduct,
  reservedUser,
  proWaveResponseData,
  codesResponseData,
  proWaveMessage,
  warning,
}) => ({
  prowave_message: proWaveMessage,
  sales_invoice: invoiceName,
  invoice_name: invoiceName,
  digital_codes: digitalCodes,
  payment_id: payment?._id,
  paynet_currency: PAYNET_CURRENCY,
  paynet_amount_syp: amountToDeduct,
  newBalance: reservedUser?.balance,
  payment: sanitizePaymentForCustomer(payment),
  warning,
});

const getDirectTopUpRequestPayload = (responseData) => {
  const payload = getProWavePayload(responseData);
  const request = getFirstPresent(
    payload?.request,
    payload?.direct_topup_request,
    payload?.topup_request,
    payload
  );

  return isPlainObject(request) ? request : {};
};

const getDirectTopUpRequestName = (requestData = {}) =>
  getFirstPresent(requestData.name, requestData.request_name, requestData.requestName, requestData.id);

const getDirectTopUpRechargeStatus = (requestData = {}) =>
  getFirstPresent(
    requestData.recharge_status,
    requestData.rechargeStatus,
    requestData.status,
    requestData.request_status
  );

const getDirectTopUpRejectionReason = (requestData = {}) =>
  getFirstPresent(
    requestData.rejection_reason,
    requestData.rejectionReason,
    requestData.failure_reason,
    requestData.message
  );

const normalizeStatusText = (value) =>
  String(value || '').trim().toLowerCase().replace(/[_-]+/g, ' ');

const isDirectTopUpCompletedStatus = (status) => {
  const normalized = normalizeStatusText(status);
  if (!normalized) return false;

  return ['completed', 'complete', 'success', 'successful', 'done', 'paid'].some((value) =>
    normalized.includes(value)
  );
};

const isDirectTopUpFailedStatus = (status) => {
  const normalized = normalizeStatusText(status);
  if (!normalized) return false;

  return ['rejected', 'reject', 'failed', 'failure', 'canceled', 'cancelled', 'cancel', 'declined'].some((value) =>
    normalized.includes(value)
  );
};

const getDirectTopUpProviderPriceUsd = (requestData = {}) =>
  toPositiveNumber(
    requestData.price,
    requestData.amount,
    requestData.total_amount,
    requestData.totalAmount,
    requestData.grand_total
  );

const getDirectTopUpProviderItemCode = (item = {}) =>
  getFirstPresent(item.provider_item_code, item.providerItemCode);

const getDirectTopUpSubmissionCode = (item = {}) =>
  getFirstPresent(
    item.item_code,
    item.itemCode,
    item.provider_item_code,
    item.providerItemCode,
    item.recharge_category,
    item.rechargeCategory
  );

const getDirectTopUpLegacyCategory = (item = {}) =>
  getFirstPresent(
    item.legacy_recharge_category,
    item.legacyRechargeCategory,
    item.rechargeCategory
  );

const calculateDirectTopUpPayNetPricing = (item, exchangeRateConfig) =>
  calculatePayNetPricingFromUsd({
    saleUnitPriceUsd: toPositiveNumber(
      item?.sale_price_usd,
      item?.customer_sale_price_usd,
      item?.price_without_discount,
      item?.price_usd
    ),
    providerUnitCostUsd: toPositiveNumber(
      item?.provider_cost_usd,
      item?.providerUnitCostUsd,
      item?.prowave_unit_cost_usd,
      item?.price_usd
    ),
    qty: 1,
    exchangeRateConfig,
  });

const enrichDirectTopUpItemWithPayNetPricing = (item, exchangeRateConfig) => {
  const pricing = calculateDirectTopUpPayNetPricing(item, exchangeRateConfig);
  const itemCode = getDirectTopUpSubmissionCode(item);
  const providerItemCode = getDirectTopUpProviderItemCode(item);
  const legacyRechargeCategory = getDirectTopUpLegacyCategory(item);

  return {
    ...item,
    item_code: itemCode,
    provider_item_code: providerItemCode,
    recharge_category: itemCode,
    legacy_recharge_category: legacyRechargeCategory,
    price: pricing.unitPriceUsd,
    price_usd: pricing.saleUnitPriceUsd,
    prowave_price_usd: pricing.saleUnitPriceUsd,
    sale_price_usd: pricing.saleUnitPriceUsd,
    paynet_sale_price_usd: pricing.saleUnitPriceUsd,
    customer_sale_price_usd: pricing.saleUnitPriceUsd,
    price_without_discount: pricing.saleUnitPriceUsd,
    discount_percent: 0,
    formatted_discount_percent: 0,
    provider_cost_usd: undefined,
    raw: undefined,
    paynet_currency: PAYNET_CURRENCY,
    price_syp: pricing.unitAmountSyp,
    paynet_price_syp: pricing.unitAmountSyp,
    formatted_price: formatSypAmount(pricing.unitAmountSyp),
    paynet_formatted_price: formatSypAmount(pricing.unitAmountSyp),
    paynet_exchange_rate: pricing.exchangeRate,
    paynet_margin_percent: pricing.marginPercent,
    paynet_rounding_step: pricing.roundingStep,
    paynet_base_unit_amount_syp: pricing.baseUnitAmountSyp,
    paynet_unit_amount_before_rounding_syp: pricing.unitAmountBeforeRoundingSyp,
    paynet_pricing_source: pricing.source,
    operation_type: DIRECT_TOPUP_OPERATION,
    provider: PROWAVE_PROVIDER,
  };
};

const buildDirectTopUpResultData = ({
  requestData,
  payment,
  amountToDeduct,
  reservedUser,
  proWaveResponseData,
  proWaveMessage,
  warning,
}) => {
  const requestName = getDirectTopUpRequestName(requestData);
  const rechargeStatus = getDirectTopUpRechargeStatus(requestData);
  const customerRequestData = sanitizeDirectTopUpRequestForCustomer(requestData);

  return {
    ...customerRequestData,
    request: customerRequestData,
    name: requestName,
    request_name: requestName,
    recharge_status: rechargeStatus,
    rejection_reason: getDirectTopUpRejectionReason(requestData),
    prowave_message: proWaveMessage,
    payment_id: payment?._id,
    paynet_currency: PAYNET_CURRENCY,
    paynet_amount_syp: amountToDeduct,
    newBalance: reservedUser?.balance,
    payment: sanitizePaymentForCustomer(payment),
    warning,
  };
};

const updateDirectTopUpTransaction = async (
  transactionId,
  {
    requestData,
    responseData,
    providerBalanceBeforeResponse,
    providerBalanceAfterResponse,
    invoiceProviderDebitUsd,
    ledgerStatus = 'pending',
    failureStage,
    failureReason,
    refunded = false,
    paynetRefundedSyp,
  } = {}
) => {
  if (!transactionId) return null;

  const prowaveInvoice = getInvoiceName(requestData, responseData);
  const requestUpdate = {
    prowaveRequestName: getDirectTopUpRequestName(requestData),
    rechargeStatus: getDirectTopUpRechargeStatus(requestData),
    rejectionReason: getDirectTopUpRejectionReason(requestData),
    prowaveInvoice,
    rawProviderBalanceBefore: providerBalanceBeforeResponse,
    rawProviderBalanceAfter: providerBalanceAfterResponse,
    rawPurchaseResponse: responseData,
    rawDirectTopupStatusResponse: responseData,
  };

  await ProWaveTransaction.findByIdAndUpdate(transactionId, requestUpdate);

  if (ledgerStatus === 'completed') {
    return markCompletedTransaction(transactionId, {
      prowaveInvoice,
      providerBalanceBeforeResponse,
      providerBalanceAfterResponse,
      purchaseResponse: responseData,
      codesResponse: null,
      invoiceProviderDebitUsd,
    });
  }

  if (ledgerStatus === 'failed' || ledgerStatus === 'refunded') {
    return markFailedTransaction(transactionId, {
      failureStage,
      failureReason,
      error: responseData,
      refunded: refunded || ledgerStatus === 'refunded',
      paynetRefundedSyp,
    });
  }

  return ProWaveTransaction.findById(transactionId);
};

const refundPayNetBalanceForDirectTopUp = async (transaction) => {
  const transactionId = transaction?._id || transaction;
  const amountToRefund = Number(transaction?.paynetAmountSyp || 0);

  if (!transactionId || !transaction?.user || amountToRefund <= 0) {
    return {
      refunded: false,
      user: null,
      transaction: transactionId ? await ProWaveTransaction.findById(transactionId) : null,
    };
  }

  const lockedTransaction = await ProWaveTransaction.findOneAndUpdate(
    {
      _id: transactionId,
      operationType: DIRECT_TOPUP_OPERATION,
      $or: [
        { paynetRefundedAt: { $exists: false } },
        { paynetRefundedAt: null },
      ],
    },
    {
      $set: {
        paynetRefundedAt: new Date(),
        paynetRefundedSyp: amountToRefund,
      },
    },
    { new: true }
  );

  if (!lockedTransaction) {
    return {
      refunded: false,
      user: null,
      transaction: await ProWaveTransaction.findById(transactionId),
    };
  }

  const refreshedUser = await User.findByIdAndUpdate(
    transaction.user,
    { $inc: { balance: amountToRefund } },
    { new: true }
  );

  return {
    refunded: true,
    user: refreshedUser,
    transaction: lockedTransaction,
  };
};

const hasPayNetRefund = (transaction, payment) =>
  Boolean(
    transaction?.paynetRefundedAt ||
      transaction?.paynetRefundedSyp ||
      payment?.extra?.paynet_refunded_syp
  );

const refreshDirectTopUpTransactionStatus = async (transaction) => {
  const requestName = transaction?.prowaveRequestName;

  if (!transaction || !requestName) {
    const error = new Error('Direct top-up request name is missing');
    error.status = 400;
    throw error;
  }

  const payment = transaction.payment
    ? await Payment.findById(transaction.payment)
    : null;
  const originalPayment = payment?.toObject?.();

  const response = await postToProWave('/get_direct_topup_request', {
    name: requestName,
  });
  const responseData = response.data;

  if (!isProWaveSuccess(responseData)) {
    const error = new Error(
      getProWaveMessage(responseData, 'Failed to get ProWave direct top-up request result')
    );
    error.status = 502;
    error.responseData = responseData;
    error.stage = 'direct_topup_result';
    throw error;
  }

  const requestData = getDirectTopUpRequestPayload(responseData);
  const latestRequestName = getDirectTopUpRequestName(requestData) || requestName;
  const rechargeStatus = getDirectTopUpRechargeStatus(requestData);
  const rejectionReason = getDirectTopUpRejectionReason(requestData);
  const invoiceName = getInvoiceName(requestData, responseData);
  const invoiceAmountUsd =
    getDirectTopUpProviderPriceUsd(requestData) || getInvoiceAmountUsd(requestData);
  const isCompleted = isDirectTopUpCompletedStatus(rechargeStatus);
  const isFailed = isDirectTopUpFailedStatus(rechargeStatus);
  let refundResult = {
    refunded: false,
    user: null,
    transaction,
  };

  if (isFailed) {
    refundResult = await refundPayNetBalanceForDirectTopUp(transaction);
  }

  const refundState =
    refundResult.refunded ||
    hasPayNetRefund(refundResult.transaction, payment) ||
    hasPayNetRefund(transaction, payment);
  const refundedSyp =
    refundResult.transaction?.paynetRefundedSyp ||
    transaction.paynetRefundedSyp ||
    payment?.extra?.paynet_refunded_syp ||
    (refundState ? transaction.paynetAmountSyp : undefined);

  if (payment) {
    payment.status = isCompleted ? COMPLETED_STATUS : isFailed ? FAILED_STATUS : DIRECT_TOPUP_PENDING_STATUS;
    payment.note = isFailed
      ? rejectionReason || 'ProWave direct top-up request was rejected'
      : isCompleted
        ? ''
        : 'Awaiting ProWave direct top-up result';
    payment.extra = {
      ...payment.extra,
      prowave_request_name: latestRequestName,
      name: latestRequestName,
      recharge_status: rechargeStatus,
      rejection_reason: rejectionReason,
      sales_invoice: invoiceName,
      prowave_sales_invoice: invoiceName,
      prowave_total_amount_usd: invoiceAmountUsd,
      prowave_result_response: responseData,
      prowave_direct_topup_request: requestData,
      paynet_refunded_syp: refundState ? refundedSyp : payment.extra?.paynet_refunded_syp,
      completed_at: isCompleted
        ? payment.extra?.completed_at || new Date().toISOString()
        : payment.extra?.completed_at,
      failed_at: isFailed
        ? payment.extra?.failed_at || new Date().toISOString()
        : payment.extra?.failed_at,
    };
    await payment.save();

    if (originalPayment && originalPayment.status !== payment.status) {
      await recordPaymentStats(originalPayment, -1);
      await recordPaymentStats(payment, 1);
    }
  }

  const updatedTransaction = await updateDirectTopUpTransaction(transaction._id, {
    requestData,
    responseData,
    invoiceProviderDebitUsd: invoiceAmountUsd,
    ledgerStatus: isCompleted
      ? 'completed'
      : isFailed
        ? refundState
          ? 'refunded'
          : 'failed'
        : 'pending',
    failureStage: isFailed ? 'prowave_direct_topup' : undefined,
    failureReason: isFailed ? rejectionReason || 'ProWave direct top-up request was rejected' : undefined,
    refunded: refundState,
    paynetRefundedSyp: refundState ? refundedSyp : undefined,
  });

  return {
    responseData,
    requestData,
    transaction: updatedTransaction,
    payment,
    refunded: refundResult.refunded,
    refreshedUser: refundResult.user,
  };
};

const getAvailabilityState = (responseData) => {
  const payload = getProWavePayload(responseData);
  const candidate = getFirstPresent(
    payload?.available,
    payload?.is_available,
    payload?.availability,
    payload?.in_stock,
    payload?.status,
    payload?.message
  );

  if (typeof candidate === 'boolean') return candidate;
  if (typeof candidate === 'number') return candidate > 0;

  const normalized = String(candidate || '').trim().toLowerCase();
  if (!normalized) return null;

  if (['0', 'false', 'no', 'unavailable', 'out of stock'].includes(normalized)) {
    return false;
  }

  if (
    normalized.includes('not available') ||
    normalized.includes('unavailable') ||
    normalized.includes('out of stock')
  ) {
    return false;
  }

  if (['1', 'true', 'yes', 'available', 'in stock'].includes(normalized)) {
    return true;
  }

  if (normalized.includes('available') || normalized.includes('in stock')) {
    return true;
  }

  return null;
};

const invalidatePaymentCache = async () => {
  await cache.delByPrefix('payments:');
  await cache.delByPrefix('report:');
  await cache.delByPrefix('balance:');
};

const emitPendingPayments = async (req) => {
  const io = req.app.get('io');
  if (!io) return;

  const pendingPayments = await Payment.find(ADMIN_PENDING_PAYMENT_FILTER)
    .select(PAYMENT_FIELDS)
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();

  io.emit('pendingPaymentsUpdate', pendingPayments);
};

const getItemsPayload = (responseData) => responseData?.message?.data || {};

const getProWaveItems = async (queryArgs) => {
  const response = await postToProWave('/get_items', {
    query_args: queryArgs,
  });

  return response.data;
};

const getItemsCacheKey = ({ currency, ordered_by, sort }) =>
  JSON.stringify({ currency, ordered_by, sort });

const getAllItemsFromProWave = async ({ currency, ordered_by, sort }) => {
  const cacheKey = getItemsCacheKey({ currency, ordered_by, sort });
  const cached = itemsCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  let pageIndex = 1;
  let itemsCount = Infinity;
  let responseData = null;
  let items = [];

  while (items.length < itemsCount && pageIndex <= PROWAVE_ITEMS_MAX_PAGES) {
    const pageResponseData = await getProWaveItems({
      item_group: '',
      page_index: pageIndex,
      currency,
      ordered_by,
      sort,
    });

    const payload = getItemsPayload(pageResponseData);
    const pageItems = Array.isArray(payload.items) ? payload.items : [];

    responseData = responseData || pageResponseData;
    itemsCount = toNumber(payload.items_count, pageItems.length);
    items = items.concat(pageItems);

    if (!pageItems.length) break;

    pageIndex += 1;
  }

  const data = { responseData, items };

  itemsCache.set(cacheKey, {
    data,
    expiresAt: Date.now() + PROWAVE_ITEMS_CACHE_TTL_MS,
  });

  return data;
};

const getItemProviderCostUsd = (item) =>
  toPositiveNumber(
    item?.price_list_rate,
    item?.price,
    item?.web_item_price,
    item?.standard_rate,
    item?.rate,
    item?.amount
  );

const getItemSalePriceUsd = (item) => {
  const providerCostUsd = getItemProviderCostUsd(item);
  const priceWithoutDiscountUsd = toPositiveNumber(
    item?.price_without_discount,
    item?.priceWithoutDiscount,
    item?.old_price_usd,
    item?.oldPriceUsd
  );

  return priceWithoutDiscountUsd > providerCostUsd
    ? priceWithoutDiscountUsd
    : providerCostUsd;
};

const getProviderDiscountPricing = ({ saleUnitPriceUsd, providerUnitCostUsd }) => {
  const providerDiscountUsd = Math.max(
    0,
    Number(saleUnitPriceUsd || 0) - Number(providerUnitCostUsd || 0)
  );
  const providerDiscountPercent =
    Number(saleUnitPriceUsd || 0) > 0
      ? Number(((providerDiscountUsd / Number(saleUnitPriceUsd)) * 100).toFixed(4))
      : 0;

  return {
    providerDiscountUsd: Number(providerDiscountUsd.toFixed(4)),
    providerDiscountPercent,
  };
};

const calculatePayNetPricingFromUsd = ({
  saleUnitPriceUsd,
  providerUnitCostUsd,
  qty = 1,
  exchangeRateConfig,
}) => {
  const salePriceUsd = toPositiveNumber(saleUnitPriceUsd, providerUnitCostUsd);
  const providerCostUsd = toPositiveNumber(providerUnitCostUsd, salePriceUsd);

  if (!salePriceUsd || !providerCostUsd) return null;

  const pricing = calculateSypPricing({
    usdAmount: salePriceUsd,
    qty,
    exchangeRateConfig,
  });

  if (!pricing) return null;

  return {
    ...pricing,
    unitPriceUsd: salePriceUsd,
    saleUnitPriceUsd: salePriceUsd,
    providerUnitCostUsd: providerCostUsd,
    ...getProviderDiscountPricing({
      saleUnitPriceUsd: salePriceUsd,
      providerUnitCostUsd: providerCostUsd,
    }),
  };
};

const getItemTitle = (item) =>
  getFirstPresent(
    item?.custom_item_name_ar,
    item?.web_item_name,
    item?.item_name,
    item?.item_code
  );

const findProWaveItemByCode = async ({ item_code, currency }) => {
  const allItemsData = await getAllItemsFromProWave({
    currency,
    ordered_by: 'price',
    sort: 'ASC',
  });

  return allItemsData.items.find((item) => item.item_code === item_code);
};

const normalizeLookupText = (value) =>
  String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

const getDirectTopUpProviderGroup = (game) =>
  DIRECT_TOPUP_ITEM_GROUP_BY_GAME[normalizeDirectTopUpGame(game)] || '';

const getProviderItemsForDirectTopUpGame = async ({ game, currency }) => {
  const itemGroup = getDirectTopUpProviderGroup(game);

  if (!itemGroup) return [];

  const allItemsData = await getAllItemsFromProWave({
    currency,
    ordered_by: 'price',
    sort: 'ASC',
  });

  return allItemsData.items.filter(
    (item) => item.item_group === itemGroup && item.item_code
  );
};

const getDirectTopUpCatalogMatchTexts = (item = {}) =>
  [
    item.provider_item_code,
    item.providerItemCode,
    item.item_code,
    item.itemCode,
    item.legacy_recharge_category,
    item.legacyRechargeCategory,
    item.recharge_category,
    item.rechargeCategory,
    item.title,
    item.title_ar,
    item.item_name,
    item.web_item_name,
  ]
    .map(normalizeLookupText)
    .filter(Boolean);

const getProviderItemMatchTexts = (item = {}) =>
  [item.item_code, item.item_name, item.web_item_name, item.name]
    .map(normalizeLookupText)
    .filter(Boolean);

const extractPubgUcAmount = (value) => {
  const match = String(value || '').match(/(\d+)\s*uc/i);
  return match ? Number(match[1]) : 0;
};

const extractFreeFireDiamondSignature = (value) => {
  const text = String(value || '');
  const plusMatch = text.match(/(\d+)\s*\+\s*(\d+)/);

  if (plusMatch) {
    const first = Number(plusMatch[1]);
    const second = Number(plusMatch[2]);
    return {
      first,
      second,
      total: first + second,
    };
  }

  const diamondMatch = text.match(/(\d+)\s*(?:diamond|diamonds|جوهرة)/i);

  if (!diamondMatch) return null;

  const first = Number(diamondMatch[1]);
  return {
    first,
    second: 0,
    total: first,
  };
};

const findMatchingProviderDirectTopUpItem = (catalogItem, providerItems = []) => {
  const explicitProviderCode = normalizeLookupText(
    getDirectTopUpProviderItemCode(catalogItem)
  );

  if (explicitProviderCode) {
    const explicitMatch = providerItems.find(
      (item) => normalizeLookupText(item.item_code) === explicitProviderCode
    );

    if (explicitMatch) return explicitMatch;
  }

  const catalogTexts = getDirectTopUpCatalogMatchTexts(catalogItem);
  const exactMatch = providerItems.find((providerItem) =>
    getProviderItemMatchTexts(providerItem).some((providerText) =>
      catalogTexts.includes(providerText)
    )
  );

  if (exactMatch) return exactMatch;

  if (catalogItem.game === 'pubg') {
    const catalogUcAmount = catalogTexts.map(extractPubgUcAmount).find(Boolean);

    if (catalogUcAmount) {
      return providerItems.find((providerItem) =>
        getProviderItemMatchTexts(providerItem)
          .map(extractPubgUcAmount)
          .includes(catalogUcAmount)
      );
    }
  }

  if (catalogItem.game === 'free_fire') {
    const catalogSignature = catalogTexts
      .map(extractFreeFireDiamondSignature)
      .find(Boolean);

    if (catalogSignature) {
      return providerItems.find((providerItem) => {
        const providerSignature = getProviderItemMatchTexts(providerItem)
          .map(extractFreeFireDiamondSignature)
          .find(Boolean);

        if (!providerSignature) return false;

        return (
          providerSignature.first === catalogSignature.first ||
          providerSignature.total === catalogSignature.first ||
          providerSignature.total === catalogSignature.total
        );
      });
    }
  }

  return null;
};

const buildDirectTopUpCatalogItemFromProvider = ({
  providerItem,
  game,
  currency,
  sortOrder,
}) => {
  const itemTitle = getItemTitle(providerItem) || providerItem.item_code;
  const salePriceUsd = getItemSalePriceUsd(providerItem);
  const providerCostUsd = getItemProviderCostUsd(providerItem);

  return {
    game,
    item_code: providerItem.item_code,
    provider_item_code: providerItem.item_code,
    recharge_category: providerItem.item_code,
    legacy_recharge_category: providerItem.item_name || itemTitle,
    item_name: providerItem.item_name,
    web_item_name: providerItem.web_item_name,
    title: itemTitle,
    title_ar: providerItem.custom_item_name_ar || itemTitle,
    description: providerItem.short_description || providerItem.web_long_description || '',
    price_usd: salePriceUsd,
    sale_price_usd: salePriceUsd,
    provider_cost_usd: providerCostUsd,
    currency: currency || providerItem.currency || DEFAULT_PROWAVE_CURRENCY,
    sort_order: sortOrder,
    item_group: providerItem.item_group,
    provider_name: providerItem.name,
    website_image: providerItem.website_image,
    image: providerItem.image,
    provider_catalog_item: providerItem,
    item_code_source: 'prowave_get_items',
  };
};

const hydrateDirectTopUpCatalogItemFromProvider = (catalogItem, providerItem) => {
  const providerItemCode =
    providerItem?.item_code || getDirectTopUpProviderItemCode(catalogItem);
  const providerSalePriceUsd = providerItem ? getItemSalePriceUsd(providerItem) : 0;
  const providerCostUsd = providerItem ? getItemProviderCostUsd(providerItem) : 0;

  return {
    ...catalogItem,
    item_code: providerItemCode || catalogItem.item_code,
    provider_item_code: providerItemCode || getDirectTopUpProviderItemCode(catalogItem),
    recharge_category: providerItemCode || catalogItem.recharge_category,
    legacy_recharge_category:
      catalogItem.legacy_recharge_category ||
      catalogItem.recharge_category ||
      providerItem?.item_name,
    item_name: providerItem?.item_name || catalogItem.item_name,
    web_item_name: providerItem?.web_item_name || catalogItem.web_item_name,
    item_group: providerItem?.item_group || catalogItem.item_group,
    provider_name: providerItem?.name || catalogItem.provider_name,
    website_image: providerItem?.website_image || catalogItem.website_image,
    image: providerItem?.image || catalogItem.image,
    custom_item_name_ar:
      catalogItem.title_ar || providerItem?.custom_item_name_ar || catalogItem.custom_item_name_ar,
    custom_item_group_name_ar:
      providerItem?.custom_item_group_name_ar || catalogItem.custom_item_group_name_ar,
    price_usd: catalogItem.price_usd || providerSalePriceUsd,
    sale_price_usd: catalogItem.sale_price_usd || providerSalePriceUsd,
    provider_cost_usd: catalogItem.provider_cost_usd || providerCostUsd,
    provider_catalog_item: providerItem || catalogItem.provider_catalog_item,
    item_code_source: providerItem
      ? 'prowave_get_items'
      : providerItemCode
        ? 'configured_provider_item_code'
        : 'legacy_catalog',
  };
};

const directTopUpItemMatchesRequest = (item, requestedValue) => {
  const normalizedRequest = normalizeLookupText(requestedValue);

  if (!normalizedRequest) return false;

  return getDirectTopUpCatalogMatchTexts(item).includes(normalizedRequest);
};

const getResolvedDirectTopUpCatalogItems = async ({ game, currency } = {}) => {
  const normalizedGame = game ? normalizeDirectTopUpGame(game) : '';
  const baseItems = listDirectTopUpCatalog({ game: normalizedGame });
  const providerGroup = getDirectTopUpProviderGroup(normalizedGame);
  let providerItems = [];

  if (providerGroup) {
    try {
      providerItems = await getProviderItemsForDirectTopUpGame({
        game: normalizedGame,
        currency,
      });
    } catch (error) {
      console.error(
        `[ProWave] failed to resolve direct top-up item codes for ${normalizedGame}:`,
        getFailureMessage(error, 'Failed to fetch ProWave items')
      );
    }
  }

  const sourceItems = baseItems.length
    ? baseItems
    : providerItems.map((providerItem, index) =>
      buildDirectTopUpCatalogItemFromProvider({
        providerItem,
        game: normalizedGame || normalizeDirectTopUpGame(providerItem.item_group),
        currency,
        sortOrder: index + 1,
      })
    );
  const resolvedItems = sourceItems.map((catalogItem) =>
    hydrateDirectTopUpCatalogItemFromProvider(
      catalogItem,
      findMatchingProviderDirectTopUpItem(catalogItem, providerItems)
    )
  );
  const requiresProviderCode =
    Boolean(providerGroup) && PROWAVE_DIRECT_TOPUP_REQUIRE_PROVIDER_ITEM_CODE;

  if (!requiresProviderCode) return resolvedItems;

  return resolvedItems.filter((item) => {
    const hasConfiguredCode = Boolean(getDirectTopUpProviderItemCode(item));

    if (!providerItems.length) return hasConfiguredCode;

    return item.item_code_source === 'prowave_get_items';
  });
};

const findResolvedDirectTopUpCatalogItem = async ({
  game,
  item_code,
  recharge_category,
  currency,
}) => {
  const requestedValue = getFirstPresent(item_code, recharge_category);
  const resolvedItems = await getResolvedDirectTopUpCatalogItems({ game, currency });
  const resolvedItem = resolvedItems.find((item) =>
    directTopUpItemMatchesRequest(item, requestedValue)
  );

  if (resolvedItem) return resolvedItem;

  if (
    Boolean(getDirectTopUpProviderGroup(game)) &&
    PROWAVE_DIRECT_TOPUP_REQUIRE_PROVIDER_ITEM_CODE &&
    resolvedItems.length
  ) {
    return null;
  }

  return findDirectTopUpCatalogItem({
    game,
    item_code: requestedValue,
    recharge_category: requestedValue,
  });
};

const calculatePayNetAmountSyp = (item, qty, exchangeRateConfig) => {
  return calculatePayNetPricingFromUsd({
    saleUnitPriceUsd: getItemSalePriceUsd(item),
    providerUnitCostUsd: getItemProviderCostUsd(item),
    qty,
    exchangeRateConfig,
  });
};

const enrichItemWithPayNetPricing = (item, exchangeRateConfig) => {
  const pricing = calculatePayNetAmountSyp(item, 1, exchangeRateConfig);

  if (!pricing) {
    return {
      ...item,
      paynet_currency: PAYNET_CURRENCY,
      price_syp: 0,
      paynet_price_syp: 0,
      formatted_price: formatSypAmount(0),
      paynet_formatted_price: formatSypAmount(0),
    };
  }

  const oldPriceUsd = toPositiveNumber(item?.price_without_discount, 0);
  const oldPricing =
    oldPriceUsd > pricing.unitPriceUsd
      ? calculateSypPricing({
        usdAmount: oldPriceUsd,
        qty: 1,
        exchangeRateConfig,
      })
      : null;

  return {
    ...item,
    price_list_rate: pricing.saleUnitPriceUsd,
    price: pricing.saleUnitPriceUsd,
    web_item_price: pricing.saleUnitPriceUsd,
    standard_rate: pricing.saleUnitPriceUsd,
    rate: pricing.saleUnitPriceUsd,
    amount: pricing.saleUnitPriceUsd,
    price_usd: pricing.saleUnitPriceUsd,
    prowave_price_usd: pricing.saleUnitPriceUsd,
    sale_price_usd: pricing.saleUnitPriceUsd,
    paynet_sale_price_usd: pricing.saleUnitPriceUsd,
    customer_sale_price_usd: pricing.saleUnitPriceUsd,
    price_without_discount: pricing.saleUnitPriceUsd,
    discount_percent: 0,
    formatted_discount_percent: 0,
    exchange_rate: pricing.exchangeRate,
    price_syp: pricing.unitAmountSyp,
    paynet_price_syp: pricing.unitAmountSyp,
    paynet_currency: PAYNET_CURRENCY,
    formatted_price: formatSypAmount(pricing.unitAmountSyp),
    paynet_formatted_price: formatSypAmount(pricing.unitAmountSyp),
    old_price_syp: oldPricing?.unitAmountSyp || null,
    paynet_old_price_syp: oldPricing?.unitAmountSyp || null,
    paynet_formatted_old_price: oldPricing
      ? formatSypAmount(oldPricing.unitAmountSyp)
      : '',
    paynet_exchange_rate: pricing.exchangeRate,
    paynet_margin_percent: pricing.marginPercent,
    paynet_rounding_step: pricing.roundingStep,
    paynet_base_unit_amount_syp: pricing.baseUnitAmountSyp,
    paynet_unit_amount_before_rounding_syp: pricing.unitAmountBeforeRoundingSyp,
    paynet_pricing_source: pricing.source,
  };
};

const enrichItemsResponseWithPayNetPricing = (responseData, exchangeRateConfig) => {
  const payload = getItemsPayload(responseData);

  if (!Array.isArray(payload.items)) return responseData;

  return {
    ...responseData,
    message: {
      ...responseData.message,
      data: {
        ...payload,
        paynet_pricing: {
          currency: PAYNET_CURRENCY,
          exchange_rate: exchangeRateConfig.rate,
          margin_percent: exchangeRateConfig.marginPercent,
          rounding_step: exchangeRateConfig.roundingStep,
          source: exchangeRateConfig.source,
          updated_at: exchangeRateConfig.updatedAt,
        },
        items: payload.items.map((item) =>
          enrichItemWithPayNetPricing(item, exchangeRateConfig)
        ),
      },
    },
  };
};

const roundMoney = (value, digits = 4) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(digits)) : 0;
};

const getProviderCostPricing = ({ providerUnitCostUsd, exchangeRateConfig }) =>
  calculateSypPricing({
    usdAmount: providerUnitCostUsd,
    qty: 1,
    exchangeRateConfig: {
      ...exchangeRateConfig,
      marginPercent: 0,
    },
  });

const getItemAvailabilityStatus = (item) => {
  const availabilityState = getAvailabilityState({ message: { data: item } });
  if (availabilityState === true) return 'available';
  if (availabilityState === false) return 'unavailable';

  const stockQty = toNumber(item?.stock_qty, 0);
  if (stockQty > 0) return 'available';

  return 'unknown';
};

const getReportSearchText = (row) =>
  [
    row.item_code,
    row.item_name,
    row.item_title,
    row.item_group,
    row.item_group_label,
    row.availability_status,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

const buildAdminPriceRow = ({ item, currency, exchangeRateConfig, fetchedAt }) => {
  const providerUnitCostUsd = getItemProviderCostUsd(item);
  const saleUnitPriceUsd = getItemSalePriceUsd(item);
  const salePricing = calculatePayNetPricingFromUsd({
    saleUnitPriceUsd,
    providerUnitCostUsd,
    qty: 1,
    exchangeRateConfig,
  });
  const providerCostPricing = getProviderCostPricing({
    providerUnitCostUsd,
    exchangeRateConfig,
  });
  const providerCostSyp = providerCostPricing?.unitAmountSyp || 0;
  const salePriceSyp = salePricing?.unitAmountSyp || 0;
  const profitSyp = salePriceSyp - providerCostSyp;
  const discount = getProviderDiscountPricing({
    saleUnitPriceUsd,
    providerUnitCostUsd,
  });

  return {
    id: item.name || item.item_code,
    item_code: item.item_code,
    item_name: item.name || item.item_name || item.item_code,
    item_title: getItemTitle(item),
    item_group: item.item_group || '',
    item_group_label: item.custom_item_group_name_ar || item.item_group || '',
    currency,
    provider_cost_usd: roundMoney(providerUnitCostUsd),
    provider_cost_syp: providerCostSyp,
    formatted_provider_cost_syp: formatSypAmount(providerCostSyp),
    prowave_sale_price_usd: roundMoney(saleUnitPriceUsd),
    sale_price_syp: salePriceSyp,
    formatted_sale_price_syp: formatSypAmount(salePriceSyp),
    profit_syp: profitSyp,
    formatted_profit_syp: formatSypAmount(profitSyp),
    profit_percent: providerCostSyp > 0
      ? roundMoney((profitSyp / providerCostSyp) * 100, 2)
      : 0,
    provider_discount_usd: discount.providerDiscountUsd,
    provider_discount_percent: discount.providerDiscountPercent,
    exchange_rate: salePricing?.exchangeRate || exchangeRateConfig.rate,
    margin_percent: salePricing?.marginPercent || exchangeRateConfig.marginPercent || 0,
    rounding_step: salePricing?.roundingStep || exchangeRateConfig.roundingStep || 1,
    availability_status: getItemAvailabilityStatus(item),
    stock_qty: toNumber(item.stock_qty, 0),
    is_digital_card: Boolean(toNumber(item.is_digital_card, 0)),
    raw_price_fields: {
      price_list_rate: item.price_list_rate,
      price: item.price,
      web_item_price: item.web_item_price,
      standard_rate: item.standard_rate,
      rate: item.rate,
      amount: item.amount,
      price_without_discount: item.price_without_discount,
    },
    fetched_at: fetchedAt,
  };
};

const filterAdminPriceRows = ({ rows, itemGroup, availability, search }) => {
  const normalizedSearch = String(search || '').trim().toLowerCase();

  return rows.filter((row) => {
    if (itemGroup && row.item_group !== itemGroup) return false;
    if (availability && row.availability_status !== availability) return false;
    if (normalizedSearch && !getReportSearchText(row).includes(normalizedSearch)) return false;

    return true;
  });
};

const PRICE_REPORT_NUMERIC_SORT_KEYS = new Set([
  'provider_cost_usd',
  'provider_cost_syp',
  'prowave_sale_price_usd',
  'sale_price_syp',
  'profit_syp',
  'profit_percent',
  'provider_discount_usd',
  'provider_discount_percent',
  'stock_qty',
]);

const sortAdminPriceRows = ({ rows, sortBy = 'provider_cost_usd', sort = 'asc' }) => {
  const direction = String(sort || '').toLowerCase() === 'desc' ? -1 : 1;

  return [...rows].sort((first, second) => {
    const firstValue = first[sortBy];
    const secondValue = second[sortBy];

    if (PRICE_REPORT_NUMERIC_SORT_KEYS.has(sortBy)) {
      return (toNumber(firstValue, 0) - toNumber(secondValue, 0)) * direction;
    }

    return String(firstValue || '').localeCompare(String(secondValue || ''), 'ar', {
      numeric: true,
      sensitivity: 'base',
    }) * direction;
  });
};

const buildPriceReportSummary = (rows) => {
  const totals = rows.reduce(
    (acc, row) => {
      acc.providerCostUsd += row.provider_cost_usd || 0;
      acc.providerCostSyp += row.provider_cost_syp || 0;
      acc.saleSyp += row.sale_price_syp || 0;
      acc.profitSyp += row.profit_syp || 0;
      if (row.availability_status === 'available') acc.available += 1;
      if (row.availability_status === 'unavailable') acc.unavailable += 1;
      if (row.availability_status === 'unknown') acc.unknown += 1;
      return acc;
    },
    {
      providerCostUsd: 0,
      providerCostSyp: 0,
      saleSyp: 0,
      profitSyp: 0,
      available: 0,
      unavailable: 0,
      unknown: 0,
    }
  );

  return {
    items_count: rows.length,
    provider_cost_usd: roundMoney(totals.providerCostUsd),
    provider_cost_syp: Math.round(totals.providerCostSyp),
    sale_price_syp: Math.round(totals.saleSyp),
    profit_syp: Math.round(totals.profitSyp),
    formatted_provider_cost_syp: formatSypAmount(totals.providerCostSyp),
    formatted_sale_price_syp: formatSypAmount(totals.saleSyp),
    formatted_profit_syp: formatSypAmount(totals.profitSyp),
    available: totals.available,
    unavailable: totals.unavailable,
    unknown: totals.unknown,
  };
};

const serializeCustomerPricing = (pricing = {}) => {
  if (!pricing) return null;

  const {
    providerUnitCostUsd,
    providerCostUsd,
    providerUnitPriceUsd,
    providerDiscountUsd,
    providerDiscountPercent,
    ...customerPricing
  } = pricing;

  return customerPricing;
};

const serializePriceQuote = (quote) => {
  const plain = typeof quote?.toObject === 'function' ? quote.toObject() : quote;

  if (!plain) return null;

  return {
    id: plain._id?.toString?.() || plain.id,
    item_code: plain.itemCode,
    item_name: plain.itemName,
    item_title: plain.itemTitle,
    currency: plain.currency,
    qty: plain.qty,
    unit_price_usd: plain.unitPriceUsd,
    sale_unit_price_usd: plain.saleUnitPriceUsd || plain.unitPriceUsd,
    paynet_sale_price_usd: plain.saleUnitPriceUsd || plain.unitPriceUsd,
    exchange_rate: plain.exchangeRate,
    margin_percent: plain.marginPercent || 0,
    rounding_step: plain.roundingStep || 1,
    unit_amount_syp: plain.unitAmountSyp,
    total_amount_syp: plain.totalAmountSyp,
    formatted_unit_amount_syp: formatSypAmount(plain.unitAmountSyp),
    formatted_total_amount_syp: formatSypAmount(plain.totalAmountSyp),
    expires_at: plain.expiresAt,
    created_at: plain.createdAt,
  };
};

const buildQuotePricing = (quote) => {
  const saleUnitPriceUsd = quote.saleUnitPriceUsd || quote.unitPriceUsd;
  const providerUnitCostUsd = quote.providerUnitCostUsd || saleUnitPriceUsd;

  return {
    exchangeRate: quote.exchangeRate,
    marginPercent: quote.marginPercent || 0,
    roundingStep: quote.roundingStep || 1,
    unitPriceUsd: saleUnitPriceUsd,
    saleUnitPriceUsd,
    providerUnitCostUsd,
    providerDiscountUsd: quote.providerDiscountUsd || 0,
    providerDiscountPercent: quote.providerDiscountPercent || 0,
    qty: quote.qty,
    baseUnitAmountSyp: quote.baseUnitAmountSyp,
    unitAmountBeforeRoundingSyp: quote.unitAmountBeforeRoundingSyp,
    unitAmountSyp: quote.unitAmountSyp,
    totalAmountSyp: quote.totalAmountSyp,
    source: 'quote',
  };
};

const getValidQuotePricing = async ({
  quoteId,
  userId,
  item_code,
  currency,
  qty,
  pricedItem,
}) => {
  if (!quoteId) return null;

  if (!mongoose.Types.ObjectId.isValid(quoteId)) {
    const error = new Error('معرف عرض السعر غير صالح');
    error.status = 400;
    throw error;
  }

  const quote = await ProWavePriceQuote.findOneAndUpdate(
    {
      _id: quoteId,
      user: userId,
      itemCode: item_code,
      usedAt: { $exists: false },
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
    { new: true }
  );

  if (!quote) {
    const error = new Error('عرض السعر غير موجود أو منتهي الصلاحية أو تم استخدامه سابقا');
    error.status = 400;
    throw error;
  }

  if (quote.currency !== currency || quote.qty !== qty) {
    const error = new Error('عرض السعر لا يطابق طلب الشراء الحالي');
    error.status = 400;
    throw error;
  }

  const currentUnitPriceUsd = getItemSalePriceUsd(pricedItem);
  const currentProviderUnitCostUsd = getItemProviderCostUsd(pricedItem);
  const quoteProviderUnitCostUsd = quote.providerUnitCostUsd || quote.unitPriceUsd;

  if (Math.abs(currentUnitPriceUsd - quote.unitPriceUsd) > 0.000001) {
    const error = new Error('تغير سعر المنتج من ProWave، يرجى تحديث المنتج والمحاولة مجددا');
    error.status = 409;
    throw error;
  }

  if (Math.abs(currentProviderUnitCostUsd - quoteProviderUnitCostUsd) > 0.000001) {
    const error = new Error('ProWave provider cost changed, please refresh the product and try again');
    error.status = 409;
    throw error;
  }

  return {
    quote,
    pricing: buildQuotePricing(quote),
  };
};

const buildFilteredItemsResponse = ({
  responseData,
  items,
  item_group,
  page_index,
}) => {
  const payload = getItemsPayload(responseData);
  const pageSize = Array.isArray(payload.items) && payload.items.length
    ? payload.items.length
    : 30;
  const startIndex = (page_index - 1) * pageSize;
  const filteredItems = items.filter((item) => item.item_group === item_group);

  return {
    ...responseData,
    message: {
      ...responseData.message,
      data: {
        ...payload,
        items: filteredItems.slice(startIndex, startIndex + pageSize),
        items_count: filteredItems.length,
      },
    },
  };
};

exports.getBalance = async (req, res) => {
  try {
    const response = await getFromProWave('/get_balance');
    sendSuccess(res, response.data);
  } catch (error) {
    sendError(res, error, 'Failed to get ProWave balance');
  }
};

exports.getCategories = async (req, res) => {
  try {
    const { lang = 'ar' } = req.query;

    const response = await getFromProWave('/get_categories', {
      params: { lang },
    });
    sendSuccess(res, response.data);
  } catch (error) {
    sendError(res, error, 'Failed to get ProWave categories');
  }
};

exports.getItems = async (req, res) => {
  try {
    const {
      item_group = '',
      page_index = 1,
      currency = 'USD',
      ordered_by = 'price',
      sort = 'ASC',
    } = req.query;

    const normalizedPageIndex = toNumber(page_index, 1);
    let responseData;
    const exchangeRateConfig = await getExchangeRateConfig({
      provider: PROWAVE_PROVIDER,
      fromCurrency: currency,
      toCurrency: PAYNET_CURRENCY,
    });

    if (item_group) {
      const allItemsData = await getAllItemsFromProWave({
        currency,
        ordered_by,
        sort,
      });

      responseData = buildFilteredItemsResponse({
        ...allItemsData,
        item_group,
        page_index: normalizedPageIndex,
      });
    } else {
      responseData = await getProWaveItems({
        item_group,
        page_index: normalizedPageIndex,
        currency,
        ordered_by,
        sort,
      });
    }

    sendSuccess(res, enrichItemsResponseWithPayNetPricing(responseData, exchangeRateConfig));
  } catch (error) {
    sendError(res, error, 'Failed to get ProWave items');
  }
};

exports.getAdminPriceReport = async (req, res) => {
  try {
    const {
      item_group = '',
      availability = '',
      search = '',
      currency = DEFAULT_PROWAVE_CURRENCY,
      provider_ordered_by = 'price',
      provider_sort = 'ASC',
      sort_by = 'provider_cost_usd',
      sort = 'asc',
      refresh,
    } = req.query;
    const page = toPositiveInteger(req.query.page, 1);
    const limit = clampPositiveInteger(req.query.limit, 50, PROWAVE_PRICE_REPORT_MAX_LIMIT);
    const fetchedAt = new Date().toISOString();
    const normalizedProviderSort =
      String(provider_sort || '').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    if (['1', 'true', 'yes', 'on'].includes(String(refresh || '').toLowerCase())) {
      itemsCache.delete(
        getItemsCacheKey({
          currency,
          ordered_by: provider_ordered_by,
          sort: normalizedProviderSort,
        })
      );
    }

    const [allItemsData, exchangeRateConfig] = await Promise.all([
      getAllItemsFromProWave({
        currency,
        ordered_by: provider_ordered_by,
        sort: normalizedProviderSort,
      }),
      getExchangeRateConfig({
        provider: PROWAVE_PROVIDER,
        fromCurrency: currency,
        toCurrency: PAYNET_CURRENCY,
      }),
    ]);

    const rows = allItemsData.items.map((item) =>
      buildAdminPriceRow({
        item,
        currency,
        exchangeRateConfig,
        fetchedAt,
      })
    );
    const filteredRows = filterAdminPriceRows({
      rows,
      itemGroup: item_group,
      availability,
      search,
    });
    const sortedRows = sortAdminPriceRows({
      rows: filteredRows,
      sortBy: sort_by,
      sort,
    });
    const startIndex = (page - 1) * limit;
    const pagedRows = sortedRows.slice(startIndex, startIndex + limit);
    const totalPages = Math.max(Math.ceil(filteredRows.length / limit), 1);
    const groups = Array.from(
      new Map(
        rows
          .filter((row) => row.item_group)
          .map((row) => [
            row.item_group,
            {
              value: row.item_group,
              label: row.item_group_label || row.item_group,
            },
          ])
      ).values()
    ).sort((first, second) =>
      first.label.localeCompare(second.label, 'ar', {
        numeric: true,
        sensitivity: 'base',
      })
    );

    sendSuccess(res, {
      items: pagedRows,
      summary: buildPriceReportSummary(filteredRows),
      pagination: {
        page,
        limit,
        total: filteredRows.length,
        totalPages,
      },
      filters: {
        groups,
        availability: ['available', 'unavailable', 'unknown'],
      },
      pricing: {
        currency,
        paynet_currency: PAYNET_CURRENCY,
        exchange_rate: exchangeRateConfig.rate,
        margin_percent: exchangeRateConfig.marginPercent || 0,
        rounding_step: exchangeRateConfig.roundingStep || 1,
        source: exchangeRateConfig.source,
        updated_at: exchangeRateConfig.updatedAt,
      },
      fetched_at: fetchedAt,
      cache: {
        ttl_ms: PROWAVE_ITEMS_CACHE_TTL_MS,
        refreshed: ['1', 'true', 'yes', 'on'].includes(String(refresh || '').toLowerCase()),
      },
    });
  } catch (error) {
    sendError(res, error, 'Failed to get ProWave price report');
  }
};

exports.createQuote = async (req, res) => {
  try {
    const {
      item_code,
      item_name,
      item_title,
      currency = DEFAULT_PROWAVE_CURRENCY,
    } = req.body || {};
    const missingParams = getMissingBodyParams(req.body || {}, ['item_code']);

    if (missingParams.length) {
      return res.status(400).json({
        success: false,
        message: `${missingParams.join(', ')} is required`,
      });
    }

    const qty = toPositiveInteger(getFirstPresent(req.body.qty, req.body.quantity), 1);
    const pricedItem = await findProWaveItemByCode({ item_code, currency });

    if (!pricedItem) {
      return res.status(404).json({
        success: false,
        message: 'منتج ProWave غير موجود في قائمة المنتجات',
      });
    }

    const exchangeRateConfig = await getExchangeRateConfig({
      provider: PROWAVE_PROVIDER,
      fromCurrency: currency,
      toCurrency: PAYNET_CURRENCY,
    });
    const pricing = calculatePayNetAmountSyp(pricedItem, qty, exchangeRateConfig);

    if (!pricing?.totalAmountSyp) {
      return res.status(400).json({
        success: false,
        message: 'تعذر حساب سعر المنتج بالليرة السورية',
      });
    }

    const quote = await ProWavePriceQuote.create({
      user: req.user.id,
      itemCode: item_code,
      itemName: item_name || pricedItem.name,
      itemTitle: item_title || getItemTitle(pricedItem),
      currency,
      qty,
      unitPriceUsd: pricing.unitPriceUsd,
      saleUnitPriceUsd: pricing.saleUnitPriceUsd,
      providerUnitCostUsd: pricing.providerUnitCostUsd,
      providerDiscountUsd: pricing.providerDiscountUsd,
      providerDiscountPercent: pricing.providerDiscountPercent,
      exchangeRate: pricing.exchangeRate,
      marginPercent: pricing.marginPercent,
      roundingStep: pricing.roundingStep,
      baseUnitAmountSyp: pricing.baseUnitAmountSyp,
      unitAmountBeforeRoundingSyp: pricing.unitAmountBeforeRoundingSyp,
      unitAmountSyp: pricing.unitAmountSyp,
      totalAmountSyp: pricing.totalAmountSyp,
      expiresAt: new Date(Date.now() + PROWAVE_QUOTE_TTL_SECONDS * 1000),
    });

    sendSuccess(res, {
      quote: serializePriceQuote(quote),
      pricing: serializeCustomerPricing(pricing),
      item: enrichItemWithPayNetPricing(pricedItem, exchangeRateConfig),
    });
  } catch (error) {
    sendError(res, error, 'تعذر إنشاء عرض السعر');
  }
};

exports.getDirectTopUpCatalog = async (req, res) => {
  try {
    const { game = '', currency = DEFAULT_PROWAVE_CURRENCY } = req.query;
    const normalizedGame = game ? normalizeDirectTopUpGame(game) : '';
    const exchangeRateConfig = await getExchangeRateConfig({
      provider: PROWAVE_PROVIDER,
      fromCurrency: currency,
      toCurrency: PAYNET_CURRENCY,
    });
    const items = (await getResolvedDirectTopUpCatalogItems({
      game: normalizedGame,
      currency,
    })).map((item) =>
      enrichDirectTopUpItemWithPayNetPricing(item, exchangeRateConfig)
    );

    sendSuccess(res, {
      game: normalizedGame || undefined,
      items,
      items_count: items.length,
      paynet_pricing: {
        currency: PAYNET_CURRENCY,
        exchange_rate: exchangeRateConfig.rate,
        margin_percent: exchangeRateConfig.marginPercent,
        rounding_step: exchangeRateConfig.roundingStep,
        source: exchangeRateConfig.source,
        updated_at: exchangeRateConfig.updatedAt,
      },
    });
  } catch (error) {
    sendError(res, error, 'Failed to get ProWave direct top-up catalog');
  }
};

exports.checkAvailability = async (req, res) => {
  try {
    const missingParams = getMissingQueryParams(req.query, ['item_code']);

    if (missingParams.length) {
      return res.status(400).json({
        success: false,
        message: `${missingParams.join(', ')} is required`,
      });
    }

    const response = await getFromProWave('/check_availability', {
      params: {
        item_code: req.query.item_code,
      },
      data: {
        item_code: req.query.item_code,
      },
    });
    return sendSuccess(res, response.data);
  } catch (error) {
    return sendError(res, error, 'Failed to check item availability');
  }
};

exports.getCodes = async (req, res) => {
  try {
    const missingParams = getMissingQueryParams(req.query, [
      'invoice_name',
      'item_code',
    ]);

    if (missingParams.length) {
      return res.status(400).json({
        success: false,
        message: `${missingParams.join(' and ')} are required`,
      });
    }

    const response = await getFromProWave('/get_codes', {
      params: {
        invoice_name: req.query.invoice_name,
        item_code: req.query.item_code,
      },
      data: {
        invoice_name: req.query.invoice_name,
        item_code: req.query.item_code,
      },
    });
    return sendSuccess(res, response.data);
  } catch (error) {
    return sendError(res, error, 'Failed to get ProWave digital codes');
  }
};

exports.getInvoices = async (req, res) => {
  try {
    const { limit = 10, offset = 0 } = req.query;

    const response = await getFromProWave('/get_invoices', {
      params: {
        limit: toNumber(limit, 10),
        offset: toNumber(offset, 0),
      },
      data: {
        limit: toNumber(limit, 10),
        offset: toNumber(offset, 0),
      },
    });

    sendSuccess(res, response.data);
  } catch (error) {
    sendError(res, error, 'Failed to get ProWave invoices');
  }
};

exports.getReconciliationReport = async (req, res) => {
  try {
    const [providerBalanceResponse, report] = await Promise.all([
      getProWaveBalanceSnapshot(),
      getReconciliationReport(req.query),
    ]);

    sendSuccess(res, {
      ...report,
      providerBalance: {
        amountUsd: extractProWaveBalanceUsd(providerBalanceResponse),
        raw: providerBalanceResponse,
      },
    });
  } catch (error) {
    sendError(res, error, 'تعذر جلب تقرير مطابقة ProWave');
  }
};

const runProviderInvoiceReconciliation = async ({ limit = 100, offset = 0 } = {}) => {
  const invoicesResponse = await getFromProWave('/get_invoices', {
    params: { limit, offset },
    data: { limit, offset },
  });

  return reconcileTransactionsWithInvoices(invoicesResponse.data);
};

exports.runReconciliation = async (req, res) => {
  try {
    const limit = toNumber(req.body?.limit ?? req.query.limit, 100);
    const offset = toNumber(req.body?.offset ?? req.query.offset, 0);
    const result = await runProviderInvoiceReconciliation({ limit, offset });
    const report = await getReconciliationReport(req.query);

    sendSuccess(res, {
      result,
      report,
    });
  } catch (error) {
    sendError(res, error, 'تعذر تشغيل مطابقة ProWave');
  }
};

exports.startReconciliationScheduler = () => {
  const intervalMs = Number(process.env.PROWAVE_RECONCILIATION_INTERVAL_MS) || 0;

  if (reconciliationSchedulerStarted || intervalMs <= 0) return;

  reconciliationSchedulerStarted = true;
  const timer = setInterval(async () => {
    try {
      const result = await runProviderInvoiceReconciliation({ limit: 100, offset: 0 });
      console.log('[ProWave] scheduled reconciliation finished:', result);
    } catch (error) {
      console.error('[ProWave] scheduled reconciliation failed:', error.message);
    }
  }, intervalMs);

  timer.unref?.();
  console.log(`[ProWave] reconciliation scheduler enabled every ${intervalMs}ms`);
};

const refreshPendingDirectTopUpRequests = async ({
  limit = PROWAVE_DIRECT_TOPUP_STATUS_BATCH_LIMIT,
} = {}) => {
  if (directTopUpStatusRefreshRunning) {
    return {
      skipped: true,
      reason: 'direct top-up status refresh is already running',
      results: [],
    };
  }

  directTopUpStatusRefreshRunning = true;

  try {
    const normalizedLimit = Math.min(toPositiveInteger(limit, 25), 100);
    const transactions = await ProWaveTransaction.find({
      operationType: DIRECT_TOPUP_OPERATION,
      status: 'pending',
      prowaveRequestName: { $exists: true, $ne: '' },
    })
      .sort({ startedAt: 1, createdAt: 1 })
      .limit(normalizedLimit);
    const results = [];

    for (const transaction of transactions) {
      try {
        const result = await refreshDirectTopUpTransactionStatus(transaction);
        results.push({
          transaction_id: transaction._id,
          request_name: transaction.prowaveRequestName,
          status: result.transaction?.status,
          recharge_status: result.transaction?.rechargeStatus,
          refunded: result.refunded,
        });
      } catch (error) {
        console.error(
          `[ProWave] failed to refresh direct top-up request ${transaction.prowaveRequestName}:`,
          getFailureMessage(error, error.message)
        );
        results.push({
          transaction_id: transaction._id,
          request_name: transaction.prowaveRequestName,
          error: getFailureMessage(error, 'Failed to refresh direct top-up status'),
        });
      }
    }

    if (results.length) {
      await invalidatePaymentCache();
    }

    return {
      skipped: false,
      count: transactions.length,
      results,
    };
  } finally {
    directTopUpStatusRefreshRunning = false;
  }
};

exports.refreshPendingDirectTopUpRequests = refreshPendingDirectTopUpRequests;

exports.refreshPendingDirectTopUpRequestStatuses = async (req, res) => {
  try {
    const limit = toNumber(req.body?.limit ?? req.query.limit, PROWAVE_DIRECT_TOPUP_STATUS_BATCH_LIMIT);
    const result = await refreshPendingDirectTopUpRequests({ limit });
    sendSuccess(res, result);
  } catch (error) {
    sendError(res, error, 'Failed to refresh pending ProWave direct top-up requests');
  }
};

exports.startDirectTopUpStatusScheduler = () => {
  const intervalMs = PROWAVE_DIRECT_TOPUP_STATUS_INTERVAL_MS;

  if (directTopUpStatusSchedulerStarted || intervalMs <= 0) return;

  directTopUpStatusSchedulerStarted = true;
  const runRefresh = async () => {
    try {
      const result = await refreshPendingDirectTopUpRequests();
      if (!result.skipped && result.count) {
        console.log('[ProWave] direct top-up status refresh finished:', result);
      }
    } catch (error) {
      console.error('[ProWave] direct top-up status refresh failed:', error.message);
    }
  };
  const timer = setInterval(runRefresh, intervalMs);

  timer.unref?.();
  runRefresh();
  console.log(`[ProWave] direct top-up status scheduler enabled every ${intervalMs}ms`);
};

exports.createDirectTopUpRequest = async (req, res) => {
  let payment = null;
  let reservedUser = null;
  let userId = null;
  let amountToDeduct = 0;
  let proWaveSubmitted = false;
  let proWaveResponseData = null;
  let requestData = {};
  let proWaveMessage = '';
  let ledgerTransaction = null;
  let providerBalanceBeforeResponse = null;
  let providerBalanceAfterResponse = null;
  let invoiceProviderDebitUsd = null;
  let paynetRefunded = false;

  try {
    const {
      game,
      player_id,
      playerId,
      item_code,
      itemCode,
      recharge_category,
      rechargeCategory,
      currency = DEFAULT_PROWAVE_CURRENCY,
      email,
      paymentType = 'cash',
      extra: bodyExtra,
      ...extraFields
    } = req.body || {};
    const normalizedGame = normalizeDirectTopUpGame(game);
    const normalizedPlayerId = String(player_id || playerId || '').trim();
    const normalizedRequestedItemCode = String(
      item_code || itemCode || recharge_category || rechargeCategory || ''
    ).trim();
    const missingParams = [];

    if (!normalizedGame) missingParams.push('game');
    if (!normalizedPlayerId) missingParams.push('player_id');
    if (!normalizedRequestedItemCode) missingParams.push('item_code');

    if (missingParams.length) {
      return res.status(400).json({
        success: false,
        message: `${missingParams.join(', ')} is required`,
      });
    }

    const catalogItem = await findResolvedDirectTopUpCatalogItem({
      game: normalizedGame,
      item_code: normalizedRequestedItemCode,
      recharge_category: normalizedRequestedItemCode,
      currency,
    });

    if (!catalogItem) {
      return res.status(404).json({
        success: false,
        message: 'Direct top-up package is not configured on PayNet',
      });
    }

    const providerItemCode = getDirectTopUpSubmissionCode(catalogItem);
    const requiresProviderCode =
      Boolean(getDirectTopUpProviderGroup(normalizedGame)) &&
      PROWAVE_DIRECT_TOPUP_REQUIRE_PROVIDER_ITEM_CODE;

    if (!providerItemCode) {
      return res.status(404).json({
        success: false,
        message: 'Direct top-up package is missing an item_code',
      });
    }

    if (requiresProviderCode && !getDirectTopUpProviderItemCode(catalogItem)) {
      return res.status(404).json({
        success: false,
        message: 'Direct top-up package is missing a ProWave item_code',
      });
    }

    const exchangeRateConfig = await getExchangeRateConfig({
      provider: PROWAVE_PROVIDER,
      fromCurrency: currency,
      toCurrency: PAYNET_CURRENCY,
    });
    const pricing = calculateDirectTopUpPayNetPricing(catalogItem, exchangeRateConfig);

    if (!pricing?.totalAmountSyp) {
      return res.status(400).json({
        success: false,
        message: 'Unable to calculate direct top-up price in SYP',
      });
    }

    userId = req.user.id;
    amountToDeduct = pricing.totalAmountSyp;

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const itemTitle =
      catalogItem.title_ar ||
      catalogItem.title ||
      catalogItem.item_name ||
      catalogItem.legacy_recharge_category ||
      providerItemCode;
    const normalizedExtra = normalizeExtra(bodyExtra, extraFields);

    payment = new Payment({
      user: userId,
      landline: normalizedPlayerId,
      company: itemTitle,
      speed: providerItemCode,
      amount: amountToDeduct,
      calculatedAmount: amountToDeduct,
      paymentType,
      email: email || user.email,
      status: DIRECT_TOPUP_PENDING_STATUS,
      note: 'Awaiting ProWave direct top-up result',
      extra: {
        ...normalizedExtra,
        provider: PROWAVE_PROVIDER,
        operation_type: DIRECT_TOPUP_OPERATION,
        prowave_operation_type: DIRECT_TOPUP_OPERATION,
        game: normalizedGame,
        player_id: normalizedPlayerId,
        recharge_category: providerItemCode,
        item_code: providerItemCode,
        item_name: catalogItem.item_name || catalogItem.legacy_recharge_category,
        item_title: itemTitle,
        qty: 1,
        currency,
        paynet_currency: PAYNET_CURRENCY,
        paynet_amount_syp: amountToDeduct,
        paynet_unit_amount_syp: pricing.unitAmountSyp,
        paynet_sale_price_usd: pricing.saleUnitPriceUsd,
        paynet_exchange_rate: pricing.exchangeRate,
        paynet_margin_percent: pricing.marginPercent,
        paynet_rounding_step: pricing.roundingStep,
        paynet_base_unit_amount_syp: pricing.baseUnitAmountSyp,
        paynet_unit_amount_before_rounding_syp: pricing.unitAmountBeforeRoundingSyp,
        paynet_pricing_source: pricing.source,
        prowave_currency: currency,
        prowave_unit_price_usd: pricing.unitPriceUsd,
        prowave_unit_cost_usd: pricing.providerUnitCostUsd,
        provider_unit_cost_usd: pricing.providerUnitCostUsd,
        prowave_provider_discount_usd: pricing.providerDiscountUsd,
        prowave_provider_discount_percent: pricing.providerDiscountPercent,
        prowave_catalog_item: catalogItem,
        amount_to_deduct: amountToDeduct,
        started_at: new Date().toISOString(),
      },
    });
    await payment.save();

    ledgerTransaction = await createPendingTransaction({
      payment: payment._id,
      user: userId,
      userEmail: email || user.email,
      operationType: DIRECT_TOPUP_OPERATION,
      itemCode: providerItemCode,
      itemName: catalogItem.item_name || catalogItem.legacy_recharge_category || providerItemCode,
      itemTitle,
      game: normalizedGame,
      playerId: normalizedPlayerId,
      rechargeCategory: providerItemCode,
      qty: 1,
      currency,
      paynetAmountSyp: amountToDeduct,
      paynetUnitAmountSyp: pricing.unitAmountSyp,
      paynetBalanceBeforeSyp: user.balance,
      pricing,
    });

    payment.extra = {
      ...payment.extra,
      prowave_transaction_id: ledgerTransaction._id,
    };
    await payment.save();

    reservedUser = await User.findOneAndUpdate(
      { _id: userId, balance: { $gte: amountToDeduct } },
      { $inc: { balance: -amountToDeduct } },
      { new: true }
    );

    if (!reservedUser) {
      payment.status = FAILED_STATUS;
      payment.note = 'Insufficient PayNet balance';
      payment.extra = {
        ...payment.extra,
        failed_at: new Date().toISOString(),
        failure_stage: 'paynet_balance',
      };
      await payment.save();
      await markFailedTransaction(ledgerTransaction?._id, {
        failureStage: 'paynet_balance',
        failureReason: 'Insufficient PayNet balance',
      });
      await invalidatePaymentCache();

      return res.status(400).json({
        success: false,
        message: 'Insufficient balance',
      });
    }

    await markPayNetReserved(ledgerTransaction?._id, {
      payment: payment._id,
      paynetBalanceAfterSyp: reservedUser.balance,
    });

    const directTopUpResponse = await withProWavePurchaseLock(async () => {
      providerBalanceBeforeResponse = await getProWaveBalanceSnapshot();

      const response = await postToProWave('/create_direct_topup_request', {
        game: normalizedGame,
        player_id: normalizedPlayerId,
        recharge_category: providerItemCode,
        currency,
      });

      providerBalanceAfterResponse = await getProWaveBalanceSnapshot();

      return response;
    });

    proWaveResponseData = directTopUpResponse.data;
    logProWaveResponse('create_direct_topup_request response', proWaveResponseData);

    if (!isProWaveSuccess(proWaveResponseData)) {
      const error = new Error(
        getProWaveMessage(proWaveResponseData, 'Failed to create ProWave direct top-up request')
      );
      error.status = 502;
      error.responseData = proWaveResponseData;
      error.stage = 'direct_topup_request';
      throw error;
    }

    proWaveSubmitted = true;
    proWaveMessage = getProWaveMessage(
      proWaveResponseData,
      'Direct top-up request submitted successfully'
    );
    requestData = getDirectTopUpRequestPayload(proWaveResponseData);

    const requestName = getDirectTopUpRequestName(requestData);
    const rechargeStatus = getDirectTopUpRechargeStatus(requestData);
    const rejectionReason = getDirectTopUpRejectionReason(requestData);
    const invoiceName = getInvoiceName(requestData, proWaveResponseData);
    invoiceProviderDebitUsd =
      getDirectTopUpProviderPriceUsd(requestData) || getInvoiceAmountUsd(requestData);
    const isCompleted = isDirectTopUpCompletedStatus(rechargeStatus);
    const isFailed = isDirectTopUpFailedStatus(rechargeStatus);

    if (isFailed && ledgerTransaction) {
      const refundResult = await refundPayNetBalanceForDirectTopUp(ledgerTransaction);
      paynetRefunded = refundResult.refunded || hasPayNetRefund(refundResult.transaction, payment);
      reservedUser = refundResult.user || (paynetRefunded ? await User.findById(userId) : reservedUser);
    }

    payment.status = isCompleted ? COMPLETED_STATUS : isFailed ? FAILED_STATUS : DIRECT_TOPUP_PENDING_STATUS;
    payment.note = isFailed
      ? rejectionReason || 'ProWave direct top-up request was rejected'
      : isCompleted
        ? ''
        : 'Awaiting ProWave direct top-up result';
    payment.extra = {
      ...payment.extra,
      prowave_request_name: requestName,
      name: requestName,
      recharge_status: rechargeStatus,
      rejection_reason: rejectionReason,
      sales_invoice: invoiceName,
      prowave_sales_invoice: invoiceName,
      prowave_total_amount_usd: invoiceProviderDebitUsd,
      prowave_message: proWaveMessage,
      prowave_response: proWaveResponseData,
      prowave_direct_topup_request: requestData,
      prowave_balance_before_response: providerBalanceBeforeResponse,
      prowave_balance_after_response: providerBalanceAfterResponse,
      paynet_refunded_syp: paynetRefunded ? amountToDeduct : undefined,
      completed_at: isCompleted ? new Date().toISOString() : undefined,
      failed_at: isFailed ? new Date().toISOString() : undefined,
    };
    await payment.save();

    await updateDirectTopUpTransaction(ledgerTransaction?._id, {
      requestData,
      responseData: proWaveResponseData,
      providerBalanceBeforeResponse,
      providerBalanceAfterResponse,
      invoiceProviderDebitUsd,
      ledgerStatus: isCompleted ? 'completed' : isFailed ? (paynetRefunded ? 'refunded' : 'failed') : 'pending',
      failureStage: isFailed ? 'prowave_direct_topup' : undefined,
      failureReason: isFailed ? rejectionReason || 'ProWave direct top-up request was rejected' : undefined,
      refunded: paynetRefunded,
      paynetRefundedSyp: paynetRefunded ? amountToDeduct : undefined,
    });

    try {
      await recordPaymentStats(payment, 1);
      await invalidatePaymentCache();
      await emitPendingPayments(req);
    } catch (sideEffectError) {
      console.error('Failed to refresh direct top-up side effects:', sideEffectError);
    }

    return res.status(200).json({
      success: true,
      source: PROWAVE_PROVIDER,
      message: proWaveMessage,
      data: buildDirectTopUpResultData({
        requestData,
        payment,
        amountToDeduct,
        reservedUser,
        proWaveResponseData,
        proWaveMessage,
      }),
    });
  } catch (error) {
    console.error('Failed to create ProWave direct top-up request:', error);
    const failureMessage = getFailureMessage(
      error,
      'Failed to create ProWave direct top-up request'
    );

    if (!proWaveSubmitted && reservedUser && userId && amountToDeduct) {
      try {
        await User.findByIdAndUpdate(userId, {
          $inc: { balance: amountToDeduct },
        });
        paynetRefunded = true;
      } catch (refundError) {
        console.error('Failed to refund PayNet balance after direct top-up error:', refundError);
      }
    }

    if (payment && !proWaveSubmitted) {
      try {
        payment.status = FAILED_STATUS;
        payment.note = failureMessage;
        payment.extra = {
          ...payment.extra,
          failed_at: new Date().toISOString(),
          failure_stage: error.stage || 'prowave_direct_topup',
          prowave_error: error.responseData || error.response?.data || error.message,
          prowave_balance_before_response: providerBalanceBeforeResponse,
          prowave_balance_after_response: providerBalanceAfterResponse,
        };
        await payment.save();
        await markFailedTransaction(ledgerTransaction?._id, {
          failureStage: error.stage || 'prowave_direct_topup',
          failureReason: failureMessage,
          error: error.responseData || error.response?.data || error.message,
          refunded: paynetRefunded,
          paynetRefundedSyp: paynetRefunded ? amountToDeduct : undefined,
          providerBalanceBeforeResponse,
          providerBalanceAfterResponse,
        });
        await invalidatePaymentCache();
        await emitPendingPayments(req);
      } catch (paymentError) {
        console.error('Failed to update failed ProWave direct top-up payment:', paymentError);
      }
    }

    if (proWaveSubmitted) {
      return res.status(200).json({
        success: true,
        source: PROWAVE_PROVIDER,
        message: 'Direct top-up request was submitted, but local status update needs review',
        data: buildDirectTopUpResultData({
          requestData,
          payment,
          amountToDeduct,
          reservedUser,
          proWaveResponseData,
          proWaveMessage,
          warning: failureMessage,
        }),
      });
    }

    return sendError(res, error, 'Failed to create ProWave direct top-up request');
  }
};

exports.getDirectTopUpRequests = async (req, res) => {
  try {
    const source = { ...(req.query || {}), ...(req.body || {}) };
    const payload = {
      limit: toNumber(source.limit, 10),
      offset: toNumber(source.offset, 0),
    };

    if (source.game) payload.game = normalizeDirectTopUpGame(source.game);
    if (source.status) payload.status = source.status;

    const response = await postToProWave('/get_direct_topup_requests', payload);
    sendSuccess(res, response.data);
  } catch (error) {
    sendError(res, error, 'Failed to get ProWave direct top-up requests');
  }
};

exports.getDirectTopUpRequestResult = async (req, res) => {
  try {
    const name = String(req.body?.name || req.query?.name || '').trim();

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'name is required',
      });
    }

    const transaction = await ProWaveTransaction.findOne({
      prowaveRequestName: name,
      operationType: DIRECT_TOPUP_OPERATION,
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Direct top-up request was not found locally',
      });
    }

    const isAdmin = req.user?.role === 'admin';
    if (!isAdmin && String(transaction.user) !== String(req.user?.id)) {
      return res.status(403).json({
        success: false,
        message: 'You are not allowed to view this direct top-up request',
      });
    }

    const {
      requestData,
      responseData,
      transaction: updatedTransaction,
      payment,
      refreshedUser,
    } = await refreshDirectTopUpTransactionStatus(transaction);

    await invalidatePaymentCache();
    await emitPendingPayments(req);

    sendSuccess(res, {
      request: isAdmin ? requestData : sanitizeDirectTopUpRequestForCustomer(requestData),
      provider_response: isAdmin ? responseData : undefined,
      transaction: isAdmin
        ? updatedTransaction
        : sanitizeTransactionForCustomer(updatedTransaction),
      payment: isAdmin ? payment : sanitizePaymentForCustomer(payment),
      newBalance: refreshedUser?.balance,
    });
  } catch (error) {
    sendError(res, error, 'Failed to get ProWave direct top-up request result');
  }
};

exports.purchaseDigitalCard = async (req, res) => {
  let payment = null;
  let reservedUser = null;
  let userId = null;
  let amountToDeduct = 0;
  let proWavePurchased = false;
  let proWaveResponseData = null;
  let purchaseData = {};
  let digitalCodes = [];
  let codesResponseData = null;
  let proWaveMessage = '';
  let priceQuote = null;
  let ledgerTransaction = null;
  let providerBalanceBeforeResponse = null;
  let providerBalanceAfterResponse = null;
  let invoiceProviderDebitUsd = null;
  let paynetRefunded = false;

  try {
    const {
      item_code,
      item_name,
      item_title,
      currency = DEFAULT_PROWAVE_CURRENCY,
      email,
      paymentType = 'cash',
      customer_identifier,
      customer_contact,
      playerId,
      password,
      quote_id,
      quoteId,
      extra: bodyExtra,
      ...extraFields
    } = req.body || {};
    const missingParams = getMissingBodyParams(req.body || {}, ['item_code']);

    if (missingParams.length) {
      return res.status(400).json({
        success: false,
        message: `${missingParams.join(', ')} is required`,
      });
    }

    const qty = toPositiveInteger(getFirstPresent(req.body.qty, req.body.quantity), 1);
    const clientAmountSyp = toPositiveNumber(
      req.body.paynet_amount_syp,
      req.body.amount_syp,
      req.body.calculatedAmount,
      req.body.calculated_amount,
      req.body.price_syp,
      req.body.amount
    );

    const pricedItem = await findProWaveItemByCode({ item_code, currency });

    if (!pricedItem) {
      return res.status(404).json({
        success: false,
        message: 'منتج ProWave غير موجود في قائمة المنتجات',
      });
    }

    userId = req.user.id;
    const quotePricing = await getValidQuotePricing({
      quoteId: quote_id || quoteId,
      userId,
      item_code,
      currency,
      qty,
      pricedItem,
    });
    const exchangeRateConfig = quotePricing
      ? null
      : await getExchangeRateConfig({
        provider: PROWAVE_PROVIDER,
        fromCurrency: currency,
        toCurrency: PAYNET_CURRENCY,
      });
    const pricing = quotePricing
      ? quotePricing.pricing
      : calculatePayNetAmountSyp(pricedItem, qty, exchangeRateConfig);
    priceQuote = quotePricing?.quote || null;

    if (!pricing?.totalAmountSyp) {
      return res.status(400).json({
        success: false,
        message: 'تعذر حساب سعر المنتج بالليرة السورية',
      });
    }

    amountToDeduct = pricing.totalAmountSyp;

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'المستخدم غير موجود',
      });
    }

    const customerReference =
      customer_contact || customer_identifier || playerId || user.number || user.email;
    const normalizedExtra = normalizeExtra(bodyExtra, extraFields);

    payment = new Payment({
      user: userId,
      landline: customerReference,
      company: item_title || item_name || getItemTitle(pricedItem) || item_code,
      speed: item_code,
      amount: amountToDeduct,
      calculatedAmount: amountToDeduct,
      paymentType,
      email: email || user.email,
      status: STARTED_STATUS,
      note: 'بانتظار رد ProWave',
      extra: {
        ...normalizedExtra,
        provider: PROWAVE_PROVIDER,
        item_code,
        item_name,
        item_title,
        qty,
        currency,
        customer_identifier,
        customer_contact,
        playerId,
        password,
        paynet_currency: PAYNET_CURRENCY,
        paynet_amount_syp: amountToDeduct,
        paynet_unit_amount_syp: pricing.unitAmountSyp,
        paynet_sale_price_usd: pricing.saleUnitPriceUsd,
        paynet_exchange_rate: pricing.exchangeRate,
        paynet_margin_percent: pricing.marginPercent,
        paynet_rounding_step: pricing.roundingStep,
        paynet_base_unit_amount_syp: pricing.baseUnitAmountSyp,
        paynet_unit_amount_before_rounding_syp: pricing.unitAmountBeforeRoundingSyp,
        paynet_pricing_source: pricing.source,
        client_amount_syp: clientAmountSyp || undefined,
        prowave_currency: currency,
        prowave_unit_price_usd: pricing.unitPriceUsd,
        prowave_unit_cost_usd: pricing.providerUnitCostUsd,
        provider_unit_cost_usd: pricing.providerUnitCostUsd,
        prowave_provider_discount_usd: pricing.providerDiscountUsd,
        prowave_provider_discount_percent: pricing.providerDiscountPercent,
        prowave_priced_item: pricedItem,
        amount_to_deduct: amountToDeduct,
        quote_id: priceQuote?._id,
        quote_expires_at: priceQuote?.expiresAt,
        immediate_code_view: true,
        started_at: new Date().toISOString(),
      },
    });
    await payment.save();

    ledgerTransaction = await createPendingTransaction({
      payment: payment._id,
      user: userId,
      userEmail: email || user.email,
      itemCode: item_code,
      itemName: item_name,
      itemTitle: item_title || getItemTitle(pricedItem),
      qty,
      currency,
      paynetAmountSyp: amountToDeduct,
      paynetUnitAmountSyp: pricing.unitAmountSyp,
      paynetBalanceBeforeSyp: user.balance,
      pricing,
      quote: priceQuote?._id,
    });

    payment.extra = {
      ...payment.extra,
      prowave_transaction_id: ledgerTransaction._id,
    };
    await payment.save();

    reservedUser = await User.findOneAndUpdate(
      { _id: userId, balance: { $gte: amountToDeduct } },
      { $inc: { balance: -amountToDeduct } },
      { new: true }
    );

    if (!reservedUser) {
      payment.status = FAILED_STATUS;
      payment.note = 'الرصيد غير كاف';
      payment.extra = {
        ...payment.extra,
        failed_at: new Date().toISOString(),
        failure_stage: 'paynet_balance',
      };
      await payment.save();
      await markFailedTransaction(ledgerTransaction?._id, {
        failureStage: 'paynet_balance',
        failureReason: 'الرصيد غير كاف',
      });
      await invalidatePaymentCache();

      return res.status(400).json({
        success: false,
        message: 'الرصيد غير كاف',
      });
    }

    await markPayNetReserved(ledgerTransaction?._id, {
      payment: payment._id,
      paynetBalanceAfterSyp: reservedUser.balance,
    });

    const purchaseResponse = await withProWavePurchaseLock(async () => {
      providerBalanceBeforeResponse = await getProWaveBalanceSnapshot();

      const availabilityResponse = await getFromProWave('/check_availability', {
        params: { item_code },
        data: { item_code },
      });
      const availabilityState = getAvailabilityState(availabilityResponse.data);

      if (availabilityState === false) {
        const error = new Error(
          getProWaveMessage(availabilityResponse.data, 'هذا المنتج غير متوفر حاليا')
        );
        error.status = 400;
        error.responseData = availabilityResponse.data;
        error.stage = 'availability';
        throw error;
      }

      const response = await postToProWave('/purchase_digital_card', {
        item_code,
        qty,
        currency,
        immediate_code_view: true,
      });

      providerBalanceAfterResponse = await getProWaveBalanceSnapshot();

      return response;
    });

    proWaveResponseData = purchaseResponse.data;
    logProWaveResponse('purchase_digital_card response', proWaveResponseData);

    if (!isProWaveSuccess(proWaveResponseData)) {
      const error = new Error(
        getProWaveMessage(proWaveResponseData, 'فشل شراء منتج ProWave')
      );
      error.status = 502;
      error.responseData = proWaveResponseData;
      error.stage = 'purchase';
      throw error;
    }

    proWavePurchased = true;
    proWaveMessage = getProWaveMessage(proWaveResponseData, 'تم شراء المنتج بنجاح');
    purchaseData = getProWavePayload(proWaveResponseData);
    digitalCodes = getDigitalCodes(proWaveResponseData);

    const invoiceName = getInvoiceName(purchaseData, proWaveResponseData);
    invoiceProviderDebitUsd = getInvoiceAmountUsd(purchaseData);

    if (!digitalCodes.length && invoiceName) {
      try {
        const codesResponse = await getFromProWave('/get_codes', {
          params: {
            invoice_name: invoiceName,
            item_code,
          },
          data: {
            invoice_name: invoiceName,
            item_code,
          },
        });
        codesResponseData = codesResponse.data;
        logProWaveResponse('get_codes response', codesResponseData);
        digitalCodes = getDigitalCodes(codesResponseData);
      } catch (codesError) {
        codesResponseData = {
          success: false,
          error: codesError.response?.data || codesError.message,
        };
      }
    }

    payment.status = COMPLETED_STATUS;
    payment.note = '';
    payment.extra = {
      ...payment.extra,
      sales_invoice: invoiceName,
      prowave_sales_invoice: invoiceName,
      prowave_total_amount_usd: invoiceProviderDebitUsd || getProWaveTotalAmount(purchaseData),
      prowave_message: proWaveMessage,
      digital_codes: digitalCodes,
      prowave_response: proWaveResponseData,
      prowave_purchase_data: purchaseData,
      prowave_codes_response: codesResponseData,
      prowave_balance_before_response: providerBalanceBeforeResponse,
      prowave_balance_after_response: providerBalanceAfterResponse,
      completed_at: new Date().toISOString(),
    };
    await payment.save();

    if (priceQuote) {
      priceQuote.usedAt = new Date();
      priceQuote.payment = payment._id;
      await priceQuote.save();
    }

    try {
      await markCompletedTransaction(ledgerTransaction?._id, {
        prowaveInvoice: invoiceName,
        providerBalanceBeforeResponse,
        providerBalanceAfterResponse,
        purchaseResponse: proWaveResponseData,
        codesResponse: codesResponseData,
        invoiceProviderDebitUsd,
      });
    } catch (ledgerError) {
      console.error('Failed to update ProWave transaction ledger:', ledgerError);
    }

    try {
      await recordPaymentStats(payment, 1);
      await invalidatePaymentCache();
      await emitPendingPayments(req);
    } catch (sideEffectError) {
      console.error('Failed to refresh payment side effects:', sideEffectError);
    }

    return res.status(200).json({
      success: true,
      source: PROWAVE_PROVIDER,
      message: proWaveMessage || 'تم شراء المنتج بنجاح',
      data: buildPurchaseResultData({
        purchaseData,
        invoiceName,
        digitalCodes,
        payment,
        amountToDeduct,
        reservedUser,
        proWaveResponseData,
        codesResponseData,
        proWaveMessage,
      }),
    });
  } catch (error) {
    console.error('Failed to purchase ProWave digital card:', error);
    const failureMessage = getFailureMessage(
      error,
      'Failed to purchase ProWave product'
    );

    if (!proWavePurchased && reservedUser && userId && amountToDeduct) {
      try {
        await User.findByIdAndUpdate(userId, {
          $inc: { balance: amountToDeduct },
        });
        paynetRefunded = true;
      } catch (refundError) {
        console.error('Failed to refund PayNet balance after ProWave error:', refundError);
      }
    }

    if (payment && !proWavePurchased) {
      try {
        payment.status = FAILED_STATUS;
        payment.note = error.message || 'فشل شراء منتج ProWave';
        payment.extra = {
          ...payment.extra,
          failed_at: new Date().toISOString(),
          failure_stage: error.stage || 'prowave_purchase',
          prowave_error: error.responseData || error.response?.data || error.message,
          prowave_balance_before_response: providerBalanceBeforeResponse,
          prowave_balance_after_response: providerBalanceAfterResponse,
        };
        payment.note = failureMessage;
        await payment.save();
        await markFailedTransaction(ledgerTransaction?._id, {
          failureStage: error.stage || 'prowave_purchase',
          failureReason: error.message || 'فشل شراء منتج ProWave',
          error: error.responseData || error.response?.data || error.message,
          failureReason: failureMessage,
          refunded: paynetRefunded,
          paynetRefundedSyp: paynetRefunded ? amountToDeduct : undefined,
          providerBalanceBeforeResponse,
          providerBalanceAfterResponse,
        });
        await invalidatePaymentCache();
        await emitPendingPayments(req);
      } catch (paymentError) {
        console.error('Failed to update failed ProWave payment:', paymentError);
      }
    }

    if (proWavePurchased) {
      try {
        await markCompletedTransaction(ledgerTransaction?._id, {
          prowaveInvoice: getInvoiceName(purchaseData, proWaveResponseData),
          providerBalanceBeforeResponse,
          providerBalanceAfterResponse,
          purchaseResponse: proWaveResponseData,
          codesResponse: codesResponseData,
          invoiceProviderDebitUsd:
            invoiceProviderDebitUsd || getInvoiceAmountUsd(purchaseData),
        });
      } catch (ledgerError) {
        console.error('Failed to update ProWave ledger after partial success:', ledgerError);
      }

      return res.status(200).json({
        success: true,
        source: PROWAVE_PROVIDER,
        message: 'تم شراء المنتج بنجاح، لكن تعذر تحديث البيان المالي تلقائيا',
        data: buildPurchaseResultData({
          purchaseData,
          invoiceName: getInvoiceName(purchaseData, proWaveResponseData),
          digitalCodes,
          payment,
          amountToDeduct,
          reservedUser,
          proWaveResponseData,
          codesResponseData,
          proWaveMessage,
          warning: failureMessage,
        }),
      });
    }

    return sendError(res, error, 'فشل شراء منتج ProWave');
  }
};



/*
1. getBalance
   للتأكد أن حسابك عند ProWave فيه رصيد.

2. getCategories
   لجلب التصنيفات وعرضها في الموقع.

3. getItems
   لجلب المنتجات حسب التصنيف والصفحة والعملة.

4. checkAvailability
   عند اختيار منتج وقبل الشراء مباشرة.

5. purchase_digital_card
   هذه ستكون POST لاحقًا لتنفيذ الشراء.

6. getCodes
   بعد الشراء لجلب الكود إذا لم يرجع مباشرة.

7. getInvoices
   للمراجعة، وسجل العمليات، ومطابقة الفواتير.
   */
