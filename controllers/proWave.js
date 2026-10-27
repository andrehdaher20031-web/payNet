const axios = require('axios');
const proWaveOrders = require('../services/proWaveOrder.service');
const proWaveProtocol = require('../services/proWaveProtocol.service');
const proWaveProducts = require('../services/proWaveProduct.service');
const mongoose = require('mongoose');
const User = require('../models/User');
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
  extractProWaveBalanceUsd,
  getInvoiceAmountUsd,
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
const PROWAVE_DIRECT_TOPUP_FOLLOW_UP_REFRESH_DELAYS_MS = String(
  process.env.PROWAVE_DIRECT_TOPUP_FOLLOW_UP_REFRESH_DELAYS_MS || '10000,30000,60000'
)
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
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
let reconciliationSchedulerStarted = false;

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
    code: error.code,
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

const enrichDirectTopUpItemWithPayNetPricing = (item, exchangeRateConfig, configuredPricing) => {
  const pricing = configuredPricing || calculateDirectTopUpPayNetPricing(item, exchangeRateConfig);
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
    provider_catalog_item: undefined,
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

const getItemsPayload = (responseData) => responseData?.message?.data || {};

const getProWaveItems = async (queryArgs) => {
  const response = await postToProWave('/get_items', {
    query_args: queryArgs,
  });

  return response.data;
};

const getItemsCacheKey = ({ currency, ordered_by, sort }) =>
  JSON.stringify({ currency, ordered_by, sort });

const getAllItemsFromProWave = async ({ currency, ordered_by, sort, forceRefresh = false }) => {
  const cacheKey = getItemsCacheKey({ currency, ordered_by, sort });
  const cached = itemsCache.get(cacheKey);

  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
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

const findProWaveItemByCode = async ({ item_code, currency, forceRefresh = false }) => {
  const allItemsData = await getAllItemsFromProWave({
    currency,
    ordered_by: 'price',
    sort: 'ASC',
    forceRefresh,
  });

  return allItemsData.items.find((item) => item.item_code === item_code);
};

const normalizeLookupText = (value) =>
  String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

const getDirectTopUpProviderGroup = (game) =>
  DIRECT_TOPUP_ITEM_GROUP_BY_GAME[normalizeDirectTopUpGame(game)] || '';

const getProviderItemsForDirectTopUpGame = async ({ game, currency, forceRefresh = false }) => {
  const itemGroup = getDirectTopUpProviderGroup(game);

  if (!itemGroup) return [];

  const allItemsData = await getAllItemsFromProWave({
    currency,
    ordered_by: 'price',
    sort: 'ASC',
    forceRefresh,
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
    price_usd: Math.max(catalogItem.price_usd || providerSalePriceUsd, providerCostUsd),
    sale_price_usd: Math.max(catalogItem.sale_price_usd || providerSalePriceUsd, providerCostUsd),
    provider_cost_usd: providerCostUsd || catalogItem.provider_cost_usd,
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

const getResolvedDirectTopUpCatalogItems = async ({ game, currency, requireFresh = false } = {}) => {
  const normalizedGame = game ? normalizeDirectTopUpGame(game) : '';
  const baseItems = listDirectTopUpCatalog({ game: normalizedGame });
  const providerGroup = getDirectTopUpProviderGroup(normalizedGame);
  let providerItems = [];

  if (providerGroup) {
    try {
      providerItems = await getProviderItemsForDirectTopUpGame({
        game: normalizedGame,
        currency,
        forceRefresh: requireFresh,
      });
    } catch (error) {
      if (requireFresh) throw error;
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

const enrichItemWithPayNetPricing = (item, exchangeRateConfig, configuredPricing) => {
  const pricing = configuredPricing || calculatePayNetAmountSyp(item, 1, exchangeRateConfig);

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

const enrichItemsResponseWithPayNetPricing = async (responseData, exchangeRateConfig) => {
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
        items: await pricePublicCatalogItems(payload.items, exchangeRateConfig, 'digital_card'),
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

    sendSuccess(res, await enrichItemsResponseWithPayNetPricing(responseData, exchangeRateConfig));
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

    const configs = await proWaveProducts.listConfigs();
    const rows = allItemsData.items.map((item) => {
      const config = configs.find((entry) => entry.itemCode === item.item_code && entry.operationType === 'digital_card');
      const row = buildAdminPriceRow({ item, currency, exchangeRateConfig, fetchedAt });
      const base = calculatePayNetAmountSyp(item, 1, exchangeRateConfig);
      try {
        const pricing = proWaveProducts.applyPricing(base, { ...config, purchaseEnabled: true });
        row.sale_price_syp = pricing.unitAmountSyp; row.profit_syp = pricing.unitAmountSyp - row.provider_cost_syp;
        row.formatted_sale_price_syp = formatSypAmount(pricing.unitAmountSyp);
        row.formatted_profit_syp = formatSypAmount(row.profit_syp);
      } catch { row.pricing_needs_review = true; }
      return { ...row, operation_type: 'digital_card', purchaseEnabled: config?.purchaseEnabled !== false, config: config || null };
    });
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

    const qty = Number(getFirstPresent(req.body.qty, req.body.quantity, 1));
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 100) return res.status(400).json({ success: false, message: 'الكمية غير صالحة' });
    const context = await exports.getProWavePurchaseContext({ itemCode: item_code, operationType: 'digital_card', currency: String(currency).toUpperCase(), quantity: qty });
    const pricedItem = context.item;

    if (!pricedItem) {
      return res.status(404).json({
        success: false,
        message: 'منتج ProWave غير موجود في قائمة المنتجات',
      });
    }

    const exchangeRateConfig = context.exchangeRateConfig;
    const pricing = context.pricing;

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
      productConfigRevision: pricing.productConfigRevision,
      expiresAt: new Date(Date.now() + PROWAVE_QUOTE_TTL_SECONDS * 1000),
    });

    sendSuccess(res, {
      quote: serializePriceQuote(quote),
      pricing: serializeCustomerPricing(pricing),
      item: (await pricePublicCatalogItems([pricedItem], exchangeRateConfig, 'digital_card'))[0],
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
    const items = await pricePublicCatalogItems(await getResolvedDirectTopUpCatalogItems({
      game: normalizedGame,
      currency,
    }), exchangeRateConfig, 'direct_topup');

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

    const transaction = await ProWaveTransaction.findOne({ prowaveInvoice: String(req.query.invoice_name), itemCode: String(req.query.item_code), operationType: 'digital_card' });
    if (!transaction) return res.status(404).json({ success: false, message: 'عملية الشراء غير موجودة' });
    const result = await proWaveOrders.checkTransaction(transaction._id, { actorId: req.user.id, isAdmin: req.user.role === 'admin' });
    return sendSuccess(res, { digital_codes: result.digital_codes, payment_id: result.payment_id, transaction_id: result.transaction_id, status: result.status });
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
        currency: 'USD',
      },
    });
  } catch (error) {
    sendError(res, error, 'تعذر جلب تقرير مطابقة ProWave');
  }
};

let reconciliationRunning = false;
const runProviderInvoiceReconciliation = async ({ limit = 100 } = {}) => {
  if (reconciliationRunning) return { skipped: true };
  reconciliationRunning = true;
  try {
    const pageSize = Math.min(500, Math.max(1, Math.trunc(Number(limit)) || 100));
    const invoices = new Map();
    let completeCoverage = false;
    for (let offset = 0; offset < 100000; offset += pageSize) {
      const response = await getFromProWave('/get_invoices', { params: { limit: pageSize, offset } });
      const page = require('../services/proWaveLedger.service').extractProviderInvoices(response.data);
      let added = 0;
      for (const invoice of page) {
        const name = proWaveProtocol.invoiceName(invoice) || invoice.name || invoice.id;
        if (name && !invoices.has(String(name))) { invoices.set(String(name), invoice); added++; }
      }
      if (page.length < pageSize) { completeCoverage = true; break; }
      if (!added) break; // A provider that ignores offset must not create false missing-invoice alerts.
    }
    return await reconcileTransactionsWithInvoices({ invoices: [...invoices.values()] }, { completeCoverage });
  } finally { reconciliationRunning = false; }
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
  const intervalMs = process.env.PROWAVE_RECONCILIATION_INTERVAL_MS === undefined ? 5 * 60000 : Number(process.env.PROWAVE_RECONCILIATION_INTERVAL_MS);

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

exports.refreshPendingDirectTopUpRequests = (options) => proWaveOrders.tick(options);
exports.refreshPendingDirectTopUpRequestStatuses = async (req, res) => {
  try { sendSuccess(res, await proWaveOrders.tick({ limit: req.body?.limit || req.query.limit })); }
  catch (error) { sendError(res, error, 'تعذر تحديث عمليات المزوّد'); }
};

const CUSTOMER_CATALOG_KEYS = new Set(['name', 'item_code', 'item_name', 'item_group', 'web_item_name', 'custom_item_name_ar', 'custom_item_group_name_ar', 'website_image', 'image', 'description', 'short_description', 'web_long_description', 'is_stock_item', 'in_stock', 'stock_qty', 'available', 'game', 'title', 'title_ar', 'recharge_category', 'legacy_recharge_category', 'provider_item_code', 'item_code_source', 'sort_order', 'price', 'price_usd', 'prowave_price_usd', 'sale_price_usd', 'customer_sale_price_usd', 'price_without_discount', 'price_list_rate', 'web_item_price', 'standard_rate', 'rate', 'amount', 'discount_percent', 'formatted_discount_percent', 'exchange_rate', 'currency', 'formatted_price', 'old_price_syp', 'formatted_old_price', 'purchaseEnabled', 'operation_type', 'provider']);
const customerCatalogItem = (item) => Object.fromEntries(Object.entries(item).filter(([key, value]) => (CUSTOMER_CATALOG_KEYS.has(key) || key.startsWith('paynet_') || key === 'price_syp') && (value === null || typeof value !== 'object')));
const pricePublicCatalogItems = async (items, exchange, operationType) => {
  const configs = await proWaveProducts.listConfigs();
  return items.map((item) => {
    const config = configs.find((entry) => entry.itemCode === item.item_code && entry.operationType === operationType && entry.currency === 'USD');
    const base = operationType === 'direct_topup' ? calculateDirectTopUpPayNetPricing(item, exchange) : calculatePayNetAmountSyp(item, 1, exchange);
    let pricing, enabled = config?.purchaseEnabled !== false;
    try { pricing = proWaveProducts.applyPricing(base, { ...config, purchaseEnabled: true }); } catch { enabled = false; pricing = { ...base, unitAmountSyp: 0, totalAmountSyp: 0 }; }
    const enriched = operationType === 'direct_topup' ? enrichDirectTopUpItemWithPayNetPricing(item, exchange, pricing) : enrichItemWithPayNetPricing(item, exchange, pricing);
    return customerCatalogItem({ ...enriched, operation_type: operationType, purchaseEnabled: enabled });
  });
};
exports.startDirectTopUpStatusScheduler = () => proWaveOrders.start();

const purchaseWithProvider = (operationType) => async (req, res) => {
  try {
    const result = await proWaveOrders.purchase(req.user.id, req.body || {}, operationType);
    const status = ['completed', 'failed', 'refunded'].includes(result.status) ? 200 : 202;
    return res.status(status).json({ success: true, source: 'prowave', message: result.status === 'completed' ? 'تم تنفيذ الشراء' : 'تم حفظ محاولة الشراء؛ يجري التحقق من النتيجة', data: result });
  } catch (error) { return res.status(error.status || 500).json({ success: false, code: error.code || 'PURCHASE_ERROR', message: error.status ? error.message : 'تعذر تنفيذ الشراء؛ يمكنك استعادة المحاولة بمعرّفها' }); }
};
exports.createDirectTopUpRequest = purchaseWithProvider('direct_topup');

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
    if (!name) return res.status(400).json({ success: false, message: 'name is required' });
    const transaction = await ProWaveTransaction.findOne({ prowaveRequestName: name, operationType: 'direct_topup' });
    if (!transaction) return res.status(404).json({ success: false, message: 'العملية غير موجودة' });
    sendSuccess(res, await proWaveOrders.checkTransaction(transaction._id, { actorId: req.user.id, isAdmin: req.user.role === 'admin' }));
  } catch (error) { res.status(error.status || 500).json({ success: false, message: error.status ? error.message : 'تعذر استعادة حالة العملية' }); }
};

exports.purchaseDigitalCard = purchaseWithProvider('digital_card');

exports.getAttempt = async (req, res) => {
  try { sendSuccess(res, await proWaveOrders.findAttempt(req.user.id, req.params.clientRequestId, req.query.operation_type)); }
  catch (error) { res.status(error.status || 500).json({ success: false, message: error.status ? error.message : 'تعذر استعادة محاولة الشراء' }); }
};
exports.listProductConfigs = async (req, res) => {
  try { sendSuccess(res, { configs: await proWaveProducts.listConfigs() }); }
  catch { res.status(500).json({ success: false, message: 'تعذر تحميل إعدادات المنتجات' }); }
};
exports.updateProductConfig = async (req, res) => {
  try { sendSuccess(res, await proWaveProducts.updateConfig(req.params.itemCode, req.body || {}, req.user.id)); }
  catch (error) { res.status(error.status || 500).json({ success: false, message: error.status ? error.message : 'تعذر تحديث إعدادات المنتج' }); }
};

exports.getProWavePurchaseContext = async (input) => {
  if (input.currency !== 'USD') throw Object.assign(new Error('عملة الشراء غير مدعومة'), { status: 400, code: 'UNSUPPORTED_CURRENCY' });
  let item;
  if (input.operationType === 'direct_topup') {
    if (!getDirectTopUpProviderGroup(input.game)) throw Object.assign(new Error('اللعبة غير مدعومة'), { status: 400, code: 'UNSUPPORTED_GAME' });
    const items = await getResolvedDirectTopUpCatalogItems({ game: input.game, currency: input.currency, requireFresh: true });
    item = items.find((entry) => directTopUpItemMatchesRequest(entry, input.itemCode) && entry.provider_catalog_item);
  } else item = await findProWaveItemByCode({ item_code: input.itemCode, currency: input.currency, forceRefresh: true });
  if (!item) throw Object.assign(new Error('المنتج غير متوفر في كتالوج المزوّد الحالي'), { status: 404, code: 'ITEM_NOT_FOUND' });
  if (input.operationType === 'digital_card') {
    const response = await getFromProWave('/check_availability', { params: { item_code: input.itemCode } });
    if (getAvailabilityState(response.data) === false) throw Object.assign(new Error('المنتج غير متوفر حالياً'), { status: 409, code: 'ITEM_UNAVAILABLE' });
  }
  const exchange = await getExchangeRateConfig({ provider: 'prowave', fromCurrency: 'USD', toCurrency: 'SYP' });
  if (exchange.isActive === false) throw Object.assign(new Error('تسعير المزوّد متوقف'), { status: 503, code: 'PRICING_DISABLED' });
  const base = input.operationType === 'direct_topup' ? calculateDirectTopUpPayNetPricing(item, exchange) : calculatePayNetAmountSyp(item, input.quantity, exchange);
  if (!base) throw Object.assign(new Error('تعذر التحقق من السعر الحالي'), { status: 503, code: 'PRICE_UNAVAILABLE' });
  const itemCode = item.item_code;
  const config = await proWaveProducts.getConfig(itemCode, input.operationType, input.currency);
  const pricing = proWaveProducts.applyPricing(base, config);
  return { itemCode, itemTitle: getItemTitle(item) || item.title_ar || item.title || itemCode, item, exchangeRateConfig: exchange, pricing };
};
