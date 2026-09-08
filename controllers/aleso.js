const { randomUUID } = require('crypto');

const Payment = require('../models/Payment');
const User = require('../models/User');
const AlesoPriceQuote = require('../models/AlesoPriceQuote');
const AlesoTransaction = require('../models/AlesoTransaction');
const { cache, cacheKey, getOrSet } = require('../services/cache.service');
const { recordPaymentStats } = require('../services/dailyStats.service');
const {
  calculateSypPricing,
  formatSypAmount,
  getExchangeRateConfig,
} = require('../services/exchangeRate.service');
const {
  ALESO_BASE_URL,
  checkAlesoOrders,
  createAlesoOrder,
  getAlesoContent,
  getAlesoProducts,
  getAlesoProfile,
  isAlesoAxiosError,
} = require('../services/alesoClient.service');

const ALESO_PROVIDER = 'aleso';
const DEFAULT_ALESO_CURRENCY = 'USD';
const PAYNET_CURRENCY = 'SYP';
const QUOTE_TTL_SECONDS = Number(process.env.ALESO_QUOTE_TTL_SECONDS) || 300;
const PRODUCT_CACHE_TTL_SECONDS =
  Number(process.env.ALESO_PRODUCT_CACHE_TTL_SECONDS) || 120;
const CONTENT_CACHE_TTL_SECONDS =
  Number(process.env.ALESO_CONTENT_CACHE_TTL_SECONDS) || 120;
const ORDER_STATUS_INTERVAL_MS =
  Number(process.env.ALESO_ORDER_STATUS_INTERVAL_MS) || 0;
const ORDER_STATUS_BATCH_LIMIT =
  Number(process.env.ALESO_ORDER_STATUS_BATCH_LIMIT) || 25;
const ALESO_ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

const isAlesoApiEnabled = () =>
  ALESO_ENABLED_VALUES.has(String(process.env.ALESO_API_ENABLED || '').trim().toLowerCase());

const PAYMENT_FIELDS =
  'landline company speed email amount calculatedAmount paymentType status note extra createdAt updatedAt user';
const PENDING_STATUSES = ['جاري التسديد', 'بدء التسديد'];
const ADMIN_PENDING_PAYMENT_FILTER = {
  status: { $in: PENDING_STATUSES },
  $nor: [
    { 'extra.provider': 'prowave', 'extra.operation_type': 'direct_topup' },
    { 'extra.provider': 'prowave', 'extra.prowave_operation_type': 'direct_topup' },
  ],
};
const STARTED_STATUS = 'بدء التسديد';
const COMPLETED_STATUS = 'تم التسديد';
const FAILED_STATUS = 'غير مسددة';

const SECTION_LABELS = {
  play: 'قسم الألعاب',
  viewapp: 'تطبيقات المشاهدة',
  ai: 'قسم الذكاء الاصطناعي',
  software: 'البرامج والتطبيقات',
  digital_cards: 'بطاقات رقمية',
};

const SECTION_RULES = [
  {
    key: 'digital_cards',
    words: [
      'steam',
      'itunes',
      'playstation',
      'play station',
      'psn',
      'بلاي ستيشن',
      'بطاقات رقمية',
    ],
  },
  {
    key: 'ai',
    words: ['chatgpt', 'gemini', 'grok', 'claude', 'ذكاء', 'الذكاء', 'باقات التوفير'],
  },
  {
    key: 'viewapp',
    words: ['netflix', 'شاهد', 'انغامي', 'ترفيه', 'الترفيه', 'shahid'],
  },
  {
    key: 'software',
    words: [
      'vpn',
      'office',
      'capcut',
      'canva',
      'faceapp',
      'proton',
      'surfshark',
      'nord',
      'برامج',
      'برنامج',
      'التصميم',
      'المونتاج',
      'الهندسة',
      'اللغات',
      'كانفا',
      'كاب كت',
    ],
  },
  {
    key: 'play',
    words: [
      'pubg',
      'free fire',
      'mobile legends',
      'jawaker',
      'uc',
      'فري فاير',
      'ببجي',
      'جواكر',
      'الألعاب',
      'العاب',
    ],
  },
];

const ERROR_CODE_MESSAGES = {
  100: 'رصيد Aleso غير كاف',
  105: 'الكمية غير متوفرة لدى Aleso',
  106: 'الكمية غير مسموحة لهذا المنتج',
  107: 'معرف اللاعب محظور لدى Aleso',
  108: 'هذا المنتج يحتاج تحقق 2FA',
  109: 'المنتج محذوف أو غير موجود لدى Aleso',
  110: 'المنتج غير متوفر حاليا لدى Aleso',
  111: 'يرجى المحاولة بعد دقيقة',
  112: 'الكمية أصغر من الحد المسموح',
  113: 'الكمية أكبر من الحد المسموح',
  114: 'خطأ غير معروف من Aleso',
  120: 'توكن Aleso مطلوب',
  121: 'توكن Aleso غير صحيح',
  122: 'حساب Aleso غير مسموح له باستخدام API',
  123: 'عنوان IP غير مسموح له باستخدام Aleso API',
  127: 'تم تجاوز حد الطلبات لدى Aleso، يرجى المحاولة لاحقا',
  130: 'Aleso تحت الصيانة حاليا',
  500: 'خطأ غير معروف من Aleso',
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toPositiveNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toPositiveInteger = (value, fallback = 1) => {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getFirstPresent = (...values) =>
  values.find((value) => value !== undefined && value !== null && value !== '');

const normalizeText = (value) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .trim();

const compactObject = (value = {}) =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== '')
  );

const normalizeAlesoSection = (section) => {
  const normalized = normalizeText(section).replace(/[\s-]+/g, '_');

  if (!normalized) return '';
  if (normalized === 'software' || normalized === 'programs') return 'software';
  if (normalized === 'digital' || normalized === 'digital_cards' || normalized === 'cards') {
    return 'digital_cards';
  }
  if (normalized === 'viewapp' || normalized === 'view_app' || normalized === 'entertainment') {
    return 'viewapp';
  }

  return normalized;
};

const classifyAlesoProduct = (product = {}) => {
  const text = normalizeText(
    [product.category_name, product.name, product.product_type].filter(Boolean).join(' ')
  );

  const matchedRule = SECTION_RULES.find((rule) =>
    rule.words.some((word) => text.includes(normalizeText(word)))
  );

  return matchedRule?.key || 'software';
};

const DIRECT_TOPUP_ONLY_MESSAGE =
  'هذا المنتج يجب أن يرسل عبر مسار الشحن المباشر فقط';

const isReservedDirectTopUpProduct = (product = {}) => {
  const text = normalizeText(
    [product.category_name, product.name, product.product_type].filter(Boolean).join(' ')
  ).replace(/[_-]+/g, ' ');
  const compactText = text.replace(/\s+/g, '');

  return (
    /\bpubg\b/.test(text) ||
    text.includes('ببجي') ||
    text.includes('بوبجي') ||
    /\bfree\s*fire\b/.test(text) ||
    compactText.includes('freefire') ||
    text.includes('فري فاير')
  );
};

const filterReservedDirectTopUpProducts = (products = []) =>
  products.filter((product) => !isReservedDirectTopUpProduct(product));

const getAlesoImageUrl = (path) => {
  const imagePath = String(path || '').trim();
  if (!imagePath) return '';
  if (imagePath.startsWith('http')) return imagePath;
  if (imagePath.startsWith('//')) return `https:${imagePath}`;

  try {
    return new URL(imagePath.replace(/^\/+/, ''), `${ALESO_BASE_URL}/`).toString();
  } catch {
    return imagePath;
  }
};

const sendSuccess = (res, data, status = 200) =>
  res.status(status).json({
    success: true,
    source: ALESO_PROVIDER,
    data,
  });

const getAlesoPayload = (responseData) => {
  if (Array.isArray(responseData)) return responseData;
  if (Array.isArray(responseData?.data)) return responseData.data;
  if (Array.isArray(responseData?.products)) return responseData.products;
  if (Array.isArray(responseData?.data?.products)) return responseData.data.products;
  if (responseData?.data && typeof responseData.data === 'object') return responseData.data;

  return responseData || {};
};

const getAlesoProductsList = (responseData) => {
  const payload = getAlesoPayload(responseData);

  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.products)) return payload.products;
  if (payload?.id) return [payload];

  return [];
};

const getContentPayload = (responseData) => {
  const payload = getAlesoPayload(responseData);

  return {
    ...payload,
    categories: Array.isArray(payload?.categories) ? payload.categories : [],
    products: Array.isArray(payload?.products) ? payload.products : [],
  };
};

const getOrderPayload = (responseData) => {
  if (responseData?.data && typeof responseData.data === 'object') {
    const orderData = responseData.data;
    if (orderData.order_id || orderData.status || orderData.price !== undefined) {
      return orderData;
    }
  }

  const payload = getAlesoPayload(responseData);
  if (payload?.order_id || payload?.status || payload?.price !== undefined) return payload;

  return payload?.data && typeof payload.data === 'object' ? payload.data : payload;
};

const getCheckOrdersPayload = (responseData) => {
  const payload = getAlesoPayload(responseData);
  const data = Array.isArray(payload?.data) ? payload.data : payload;

  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return [data];

  return [];
};

const getProviderErrorCode = (error) => {
  const details = error.responseData || error.response?.data || error.details || {};
  return details.code || details.error_code || details.providerCode || error.providerCode;
};

const getErrorMessage = (error, fallback) => {
  const details = error.responseData || error.response?.data || error.details || {};
  const providerCode = getProviderErrorCode(error);

  return (
    ERROR_CODE_MESSAGES[providerCode] ||
    details.message ||
    details.error ||
    error.message ||
    fallback
  );
};

const getErrorStatus = (error) => {
  const status = error.response?.status || error.status || 500;

  if (isAlesoAxiosError(error) && status >= 500) return 502;

  return status;
};

const sendError = (res, error, fallback) =>
  res.status(getErrorStatus(error)).json({
    success: false,
    source: ALESO_PROVIDER,
    message: getErrorMessage(error, fallback),
    fallbackMessage: fallback,
    stage: error.stage,
    providerCode: getProviderErrorCode(error),
    error: error.responseData || error.response?.data || error.details || error.message,
  });

const getCachedAlesoProducts = ({ products_id, base } = {}) =>
  getOrSet(
    cacheKey('aleso:products', { products_id: products_id || '', base: base || '' }),
    PRODUCT_CACHE_TTL_SECONDS,
    async () => {
      const response = await getAlesoProducts({ products_id, base });
      return response.data;
    }
  );

const getCachedAlesoContent = (categoryId = 0) =>
  getOrSet(cacheKey('aleso:content', { categoryId }), CONTENT_CACHE_TTL_SECONDS, async () => {
    const response = await getAlesoContent(categoryId);
    return response.data;
  });

const normalizeAlesoParams = (params) =>
  Array.isArray(params)
    ? params.map((param) => String(param || '').trim()).filter(Boolean)
    : [];

const normalizeQtyValues = (qtyValues) => {
  if (qtyValues === undefined || qtyValues === null || qtyValues === '') return null;

  if (Array.isArray(qtyValues)) {
    return qtyValues
      .map((value) => toPositiveInteger(value, 0))
      .filter((value) => value > 0);
  }

  if (typeof qtyValues === 'object') {
    return {
      min: toPositiveInteger(qtyValues.min, 1),
      max: toPositiveInteger(qtyValues.max, 1),
    };
  }

  return null;
};

const getQuantityRules = (product = {}) => {
  const qtyValues = normalizeQtyValues(product.qty_values);

  if (Array.isArray(qtyValues) && qtyValues.length) {
    return {
      mode: 'choices',
      values: qtyValues,
      defaultQty: qtyValues[0],
    };
  }

  if (qtyValues && typeof qtyValues === 'object') {
    return {
      mode: 'range',
      min: qtyValues.min,
      max: qtyValues.max,
      defaultQty: qtyValues.min,
    };
  }

  return {
    mode: 'fixed',
    min: 1,
    max: 1,
    defaultQty: 1,
  };
};

const validateQuantity = (product = {}, requestedQty = 1) => {
  const rules = getQuantityRules(product);
  const qty = toPositiveInteger(requestedQty, rules.defaultQty || 1);

  if (rules.mode === 'fixed') {
    if (qty !== 1) {
      const error = new Error('كمية هذا المنتج يجب أن تكون 1');
      error.status = 400;
      error.providerCode = 106;
      throw error;
    }

    return 1;
  }

  if (rules.mode === 'choices') {
    if (!rules.values.includes(qty)) {
      const error = new Error('هذه الكمية غير مسموحة لهذا المنتج');
      error.status = 400;
      error.providerCode = 106;
      throw error;
    }

    return qty;
  }

  if (qty < rules.min) {
    const error = new Error(`الكمية يجب ألا تقل عن ${rules.min}`);
    error.status = 400;
    error.providerCode = 112;
    throw error;
  }

  if (qty > rules.max) {
    const error = new Error(`الكمية يجب ألا تزيد عن ${rules.max}`);
    error.status = 400;
    error.providerCode = 113;
    throw error;
  }

  return qty;
};

const calculateAlesoPricing = (product, qty, exchangeRateConfig) => {
  const saleUnitPriceUsd = toPositiveNumber(product?.price);
  const providerUnitCostUsd = toPositiveNumber(product?.base_price, saleUnitPriceUsd);
  const pricing = calculateSypPricing({
    usdAmount: saleUnitPriceUsd,
    qty,
    exchangeRateConfig,
  });

  if (!pricing) return null;

  return {
    ...pricing,
    saleUnitPriceUsd,
    providerUnitCostUsd,
    expectedProviderDebitUsd: Number((saleUnitPriceUsd * pricing.qty).toFixed(8)),
  };
};

const serializeQuote = (quote) => {
  const plain = typeof quote?.toObject === 'function' ? quote.toObject() : quote;

  if (!plain) return null;

  return {
    id: plain._id?.toString?.() || plain.id,
    product_id: plain.productId,
    product_name: plain.productName,
    category_name: plain.categoryName,
    product_type: plain.productType,
    qty: plain.qty,
    currency: plain.currency,
    unit_price_usd: plain.unitPriceUsd,
    sale_unit_price_usd: plain.saleUnitPriceUsd,
    exchange_rate: plain.exchangeRate,
    margin_percent: plain.marginPercent || 0,
    rounding_step: plain.roundingStep || 1,
    unit_amount_syp: plain.unitAmountSyp,
    total_amount_syp: plain.totalAmountSyp,
    formatted_unit_amount_syp: formatSypAmount(plain.unitAmountSyp),
    formatted_total_amount_syp: formatSypAmount(plain.totalAmountSyp),
    params: plain.paramsDefinition || [],
    qty_values: plain.qtyValues,
    expires_at: plain.expiresAt,
    created_at: plain.createdAt,
  };
};

const serializeCustomerPricing = (pricing = {}) => {
  if (!pricing) return null;

  const {
    providerUnitCostUsd,
    expectedProviderDebitUsd,
    ...customerPricing
  } = pricing;

  return customerPricing;
};

const enrichProductWithPayNetPricing = (product = {}, exchangeRateConfig) => {
  const qtyRules = getQuantityRules(product);
  const qty = qtyRules.defaultQty || 1;
  const pricing = calculateAlesoPricing(product, qty, exchangeRateConfig);
  const section = classifyAlesoProduct(product);
  const priceSyp = pricing?.unitAmountSyp || 0;
  const totalAmountSyp = pricing?.totalAmountSyp || 0;

  return {
    ...product,
    id: toPositiveInteger(product.id, 0),
    product_id: toPositiveInteger(product.id, 0),
    aleso_product_id: toPositiveInteger(product.id, 0),
    name: String(product.name || ''),
    category_name: String(product.category_name || ''),
    product_type: String(product.product_type || '').toLowerCase(),
    available: product.available !== false,
    params: normalizeAlesoParams(product.params),
    qty_values: normalizeQtyValues(product.qty_values),
    quantity_rules: qtyRules,
    section,
    section_label: SECTION_LABELS[section] || section,
    image_url: getAlesoImageUrl(product.category_img || product.image || product.image_url),
    price_usd: pricing?.saleUnitPriceUsd || toNumber(product.price),
    aleso_price_usd: pricing?.saleUnitPriceUsd || toNumber(product.price),
    paynet_currency: PAYNET_CURRENCY,
    paynet_price_syp: priceSyp,
    paynet_total_amount_syp: totalAmountSyp,
    paynet_formatted_price: formatSypAmount(priceSyp),
    paynet_formatted_total_amount: formatSypAmount(totalAmountSyp),
    paynet_exchange_rate: pricing?.exchangeRate || exchangeRateConfig?.rate,
    paynet_margin_percent: pricing?.marginPercent || exchangeRateConfig?.marginPercent || 0,
    paynet_rounding_step: pricing?.roundingStep || exchangeRateConfig?.roundingStep || 1,
    paynet_pricing_source: pricing?.source || exchangeRateConfig?.source,
  };
};

const buildSectionsSummary = (products = []) => {
  const sections = Object.entries(SECTION_LABELS).map(([key, label]) => ({
    key,
    label,
    count: 0,
    available: 0,
  }));
  const sectionByKey = new Map(sections.map((section) => [section.key, section]));

  products.forEach((product) => {
    const key = classifyAlesoProduct(product);
    if (!sectionByKey.has(key)) {
      sectionByKey.set(key, {
        key,
        label: SECTION_LABELS[key] || key,
        count: 0,
        available: 0,
      });
      sections.push(sectionByKey.get(key));
    }

    const summary = sectionByKey.get(key);
    summary.count += 1;
    if (product.available !== false) summary.available += 1;
  });

  return sections;
};

const filterProducts = (products, query = {}) => {
  const section = normalizeAlesoSection(query.section);
  const categoryName = normalizeText(query.category_name || query.categoryName);
  const availability = normalizeText(query.available);
  const search = normalizeText(query.search);

  return products.filter((product) => {
    if (section && classifyAlesoProduct(product) !== section) return false;
    if (categoryName && normalizeText(product.category_name) !== categoryName) return false;
    if (availability === 'true' && product.available === false) return false;
    if (availability === 'false' && product.available !== false) return false;
    if (
      search &&
      !normalizeText([product.name, product.category_name, product.product_type].join(' ')).includes(search)
    ) {
      return false;
    }

    return true;
  });
};

const findAlesoProductById = async (productId) => {
  const responseData = await getCachedAlesoProducts({ products_id: String(productId) });
  let products = getAlesoProductsList(responseData);
  let product = products.find((item) => toPositiveInteger(item.id, 0) === productId);

  if (!product) {
    const allProducts = getAlesoProductsList(await getCachedAlesoProducts());
    product = allProducts.find((item) => toPositiveInteger(item.id, 0) === productId);
  }

  return product || null;
};

const createQuoteForProduct = async ({ userId, product, qty, exchangeRateConfig }) => {
  const pricing = calculateAlesoPricing(product, qty, exchangeRateConfig);

  if (!pricing?.totalAmountSyp) {
    const error = new Error('تعذر حساب سعر منتج Aleso بالليرة السورية');
    error.status = 400;
    throw error;
  }

  const quote = await AlesoPriceQuote.create({
    user: userId,
    productId: toPositiveInteger(product.id, 0),
    productName: product.name,
    categoryName: product.category_name,
    productType: product.product_type,
    paramsDefinition: normalizeAlesoParams(product.params),
    qtyValues: normalizeQtyValues(product.qty_values),
    currency: DEFAULT_ALESO_CURRENCY,
    qty,
    unitPriceUsd: pricing.unitPriceUsd,
    saleUnitPriceUsd: pricing.saleUnitPriceUsd,
    providerUnitCostUsd: pricing.providerUnitCostUsd,
    expectedProviderDebitUsd: pricing.expectedProviderDebitUsd,
    exchangeRate: pricing.exchangeRate,
    marginPercent: pricing.marginPercent,
    roundingStep: pricing.roundingStep,
    baseUnitAmountSyp: pricing.baseUnitAmountSyp,
    unitAmountBeforeRoundingSyp: pricing.unitAmountBeforeRoundingSyp,
    unitAmountSyp: pricing.unitAmountSyp,
    totalAmountSyp: pricing.totalAmountSyp,
    rawProduct: product,
    expiresAt: new Date(Date.now() + QUOTE_TTL_SECONDS * 1000),
  });

  return {
    quote,
    pricing,
  };
};

const resolveQuoteForPurchase = async ({ userId, product, qty, quoteId, exchangeRateConfig }) => {
  if (!quoteId) {
    return createQuoteForProduct({ userId, product, qty, exchangeRateConfig });
  }

  const quote = await AlesoPriceQuote.findOne({
    _id: quoteId,
    user: userId,
    productId: toPositiveInteger(product.id, 0),
    qty,
    usedAt: { $exists: false },
    expiresAt: { $gt: new Date() },
  });

  if (!quote) {
    const error = new Error('انتهت صلاحية عرض السعر، يرجى تحديث المنتج والمحاولة مجددا');
    error.status = 400;
    throw error;
  }

  const currentPriceUsd = toPositiveNumber(product.price);
  if (currentPriceUsd && Math.abs(currentPriceUsd - quote.unitPriceUsd) > 0.000001) {
    const error = new Error('تغير سعر منتج Aleso، يرجى تحديث المنتج والمحاولة مجددا');
    error.status = 409;
    throw error;
  }

  return {
    quote,
    pricing: {
      exchangeRate: quote.exchangeRate,
      marginPercent: quote.marginPercent,
      roundingStep: quote.roundingStep,
      unitPriceUsd: quote.unitPriceUsd,
      saleUnitPriceUsd: quote.saleUnitPriceUsd,
      providerUnitCostUsd: quote.providerUnitCostUsd,
      qty: quote.qty,
      baseUnitAmountSyp: quote.baseUnitAmountSyp,
      unitAmountBeforeRoundingSyp: quote.unitAmountBeforeRoundingSyp,
      unitAmountSyp: quote.unitAmountSyp,
      totalAmountSyp: quote.totalAmountSyp,
      expectedProviderDebitUsd: quote.expectedProviderDebitUsd,
    },
  };
};

const normalizeOrderParams = (body = {}) => {
  const rawParams = {
    ...(body.params && typeof body.params === 'object' ? body.params : {}),
    ...(body.extra && typeof body.extra === 'object' ? body.extra : {}),
  };
  const legacyPlayerId = getFirstPresent(body.playerId, body.player_id, body.customer_identifier);

  if (legacyPlayerId) rawParams.playerId = legacyPlayerId;

  const blockedKeys = new Set(['qty', 'quantity', 'order_uuid', 'orderUuid', 'product_id', 'productId']);
  const cleanParams = {};

  Object.entries(rawParams).forEach(([key, value]) => {
    const cleanKey = String(key || '').trim().slice(0, 80);
    if (!cleanKey || blockedKeys.has(cleanKey)) return;
    if (value === undefined || value === null || value === '') return;

    cleanParams[cleanKey] =
      typeof value === 'string' ? value.trim().slice(0, 1000) : String(value).slice(0, 1000);
  });

  return cleanParams;
};

const assertRequiredParams = (product, params) => {
  const requiredParams = normalizeAlesoParams(product.params);
  if (!requiredParams.length) return;

  const values = Object.values(params).filter((value) => String(value || '').trim());
  if (values.length >= requiredParams.length) return;

  const error = new Error('يرجى إدخال كل البيانات المطلوبة لهذا المنتج');
  error.status = 400;
  throw error;
};

const getOrderTarget = (params = {}, user = {}) =>
  getFirstPresent(
    params.playerId,
    params.player_id,
    Object.values(params).find((value) => String(value || '').trim()),
    user.number,
    user.email
  );

const normalizeProviderStatus = (value) => {
  const normalized = String(value || '').trim().toLowerCase();

  if (normalized === 'accept' || normalized === 'accepted' || normalized === 'success') return 'accept';
  if (normalized === 'reject' || normalized === 'rejected' || normalized === 'failed') return 'reject';
  if (normalized === 'wait' || normalized === 'waiting' || normalized === 'pending') return 'wait';

  return normalized || 'unknown';
};

const isCompletedStatus = (status) => status === 'accept';
const isFailedStatus = (status) => status === 'reject';
const isPendingStatus = (status) => status === 'wait' || status === 'pending' || status === 'unknown';

const formatOrdersParam = (orders) => {
  if (Array.isArray(orders)) {
    return `[${orders.map((order) => String(order || '').trim()).filter(Boolean).join(',')}]`;
  }

  const value = String(orders || '').trim();
  if (!value) return '';
  if (value.startsWith('[')) return value;
  if (value.includes(',')) return `[${value}]`;

  return value;
};

const markPaymentStatus = async (payment, status, statsDirection = 1) => {
  payment.status = status;
  await payment.save();
  await recordPaymentStats(payment, statsDirection);
};

const updateRecordedPaymentStatus = async (payment, nextStatus) => {
  const original = payment.toObject();
  payment.status = nextStatus;
  await payment.save();

  if (original.status !== payment.status) {
    await recordPaymentStats(original, -1);
    await recordPaymentStats(payment, 1);
  }
};

const invalidatePaymentCache = async () => {
  await cache.delByPrefix('payments:');
  await cache.delByPrefix('report:');
  await cache.delByPrefix('balance:');
};

const invalidateAlesoCache = async () => {
  await cache.delByPrefix('aleso:');
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

const sanitizePaymentForCustomer = (payment) => {
  const plain = typeof payment?.toObject === 'function' ? payment.toObject() : payment;
  if (!plain) return plain;

  const extra = { ...(plain.extra || {}) };
  delete extra.aleso_raw_product;
  delete extra.provider_unit_cost_usd;
  delete extra.aleso_unit_cost_usd;

  return {
    ...plain,
    extra,
  };
};

const refundPayNetBalance = async ({ userId, amount, transaction, payment, reason }) => {
  if (!userId || !amount || transaction?.paynetRefundedAt) return false;

  await User.findByIdAndUpdate(userId, { $inc: { balance: amount } });

  if (transaction) {
    transaction.paynetRefundedSyp = amount;
    transaction.paynetRefundedAt = new Date();
    transaction.status = 'refunded';
    transaction.failureReason = reason || transaction.failureReason;
    await transaction.save();
  }

  if (payment) {
    payment.extra = {
      ...payment.extra,
      paynet_refunded_syp: amount,
      paynet_refunded_at: new Date().toISOString(),
    };
  }

  return true;
};

const applyProviderResultToPayment = ({ payment, transaction, orderData, responseData }) => {
  const providerStatus = normalizeProviderStatus(orderData?.status);
  const alesoOrderId = String(orderData?.order_id || orderData?.id || '').trim();
  const actualProviderDebitUsd = toPositiveNumber(orderData?.price, transaction.expectedProviderDebitUsd);
  const completedAt = isCompletedStatus(providerStatus) ? new Date() : null;
  const failedAt = isFailedStatus(providerStatus) ? new Date() : null;
  const paynetAmount = transaction.paynetAmountSyp || 0;
  const actualCostSyp = transaction.exchangeRate
    ? Math.ceil(actualProviderDebitUsd * transaction.exchangeRate)
    : 0;
  const profitSyp = isCompletedStatus(providerStatus)
    ? paynetAmount - actualCostSyp
    : 0;

  payment.status = isCompletedStatus(providerStatus)
    ? COMPLETED_STATUS
    : isFailedStatus(providerStatus)
      ? FAILED_STATUS
      : STARTED_STATUS;
  payment.note = isPendingStatus(providerStatus)
    ? 'بانتظار رد Aleso'
    : isFailedStatus(providerStatus)
      ? 'تم رفض الطلب من Aleso'
      : '';
  payment.extra = {
    ...payment.extra,
    aleso_order_id: alesoOrderId,
    aleso_status: providerStatus,
    aleso_order_data: orderData,
    aleso_response: responseData,
    replay_api: orderData?.replay_api,
    ...(completedAt ? { completed_at: completedAt.toISOString() } : {}),
    ...(failedAt ? { failed_at: failedAt.toISOString() } : {}),
  };

  transaction.alesoOrderId = alesoOrderId;
  transaction.providerStatus = providerStatus;
  transaction.actualProviderDebitUsd = actualProviderDebitUsd;
  transaction.actualCostSyp = actualCostSyp;
  transaction.profitSyp = profitSyp;
  transaction.profitPercent = paynetAmount > 0 ? (profitSyp / paynetAmount) * 100 : 0;
  transaction.rawOrderResponse = responseData || transaction.rawOrderResponse;
  transaction.status = isCompletedStatus(providerStatus)
    ? 'completed'
    : isFailedStatus(providerStatus)
      ? 'failed'
      : 'pending';
  transaction.completedAt = completedAt || transaction.completedAt;
  transaction.failedAt = failedAt || transaction.failedAt;

  return providerStatus;
};

const getPaymentType = (value) => (value === 'credit' ? 'credit' : 'cash');

exports.getProfile = async (req, res) => {
  try {
    const response = await getAlesoProfile();
    sendSuccess(res, response.data);
  } catch (error) {
    sendError(res, error, 'تعذر جلب رصيد Aleso');
  }
};

exports.getProducts = async (req, res) => {
  try {
    const responseData = await getCachedAlesoProducts({
      products_id: req.query.products_id,
      base: req.query.base,
    });
    const products = filterReservedDirectTopUpProducts(getAlesoProductsList(responseData));
    const filteredProducts = filterProducts(products, req.query);
    const exchangeRateConfig = await getExchangeRateConfig({
      provider: ALESO_PROVIDER,
      fromCurrency: DEFAULT_ALESO_CURRENCY,
      toCurrency: PAYNET_CURRENCY,
    });
    const items = filteredProducts.map((product) =>
      enrichProductWithPayNetPricing(product, exchangeRateConfig)
    );

    sendSuccess(res, {
      items,
      products: items,
      count: items.length,
      total: products.length,
      sections: buildSectionsSummary(products),
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
    sendError(res, error, 'تعذر جلب منتجات Aleso');
  }
};

exports.getContent = async (req, res) => {
  try {
    const categoryId = req.params.categoryId || 0;
    const responseData = await getCachedAlesoContent(categoryId);
    const payload = getContentPayload(responseData);
    const exchangeRateConfig = await getExchangeRateConfig({
      provider: ALESO_PROVIDER,
      fromCurrency: DEFAULT_ALESO_CURRENCY,
      toCurrency: PAYNET_CURRENCY,
    });
    const products = filterProducts(
      filterReservedDirectTopUpProducts(payload.products),
      req.query
    ).map((product) =>
      enrichProductWithPayNetPricing(product, exchangeRateConfig)
    );

    sendSuccess(res, {
      ...payload,
      categories: payload.categories.map((category) => ({
        ...category,
        image_url: getAlesoImageUrl(category.category_img || category.image || category.image_url),
      })),
      products,
      count: products.length,
    });
  } catch (error) {
    sendError(res, error, 'تعذر جلب محتوى Aleso');
  }
};

exports.createQuote = async (req, res) => {
  try {
    const productId = toPositiveInteger(
      getFirstPresent(req.body?.product_id, req.body?.productId),
      0
    );

    if (!productId) {
      return res.status(400).json({
        success: false,
        source: ALESO_PROVIDER,
        message: 'product_id is required',
      });
    }

    const product = await findAlesoProductById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        source: ALESO_PROVIDER,
        message: 'منتج Aleso غير موجود',
      });
    }

    if (isReservedDirectTopUpProduct(product)) {
      return res.status(400).json({
        success: false,
        source: ALESO_PROVIDER,
        message: DIRECT_TOPUP_ONLY_MESSAGE,
      });
    }

    if (product.available === false) {
      return res.status(400).json({
        success: false,
        source: ALESO_PROVIDER,
        message: 'هذا المنتج غير متوفر حاليا لدى Aleso',
      });
    }

    const qty = validateQuantity(
      product,
      getFirstPresent(req.body?.qty, req.body?.quantity)
    );
    const exchangeRateConfig = await getExchangeRateConfig({
      provider: ALESO_PROVIDER,
      fromCurrency: DEFAULT_ALESO_CURRENCY,
      toCurrency: PAYNET_CURRENCY,
    });
    const { quote, pricing } = await createQuoteForProduct({
      userId: req.user.id,
      product,
      qty,
      exchangeRateConfig,
    });

    sendSuccess(res, {
      quote: serializeQuote(quote),
      pricing: serializeCustomerPricing(pricing),
      item: enrichProductWithPayNetPricing(product, exchangeRateConfig),
    });
  } catch (error) {
    sendError(res, error, 'تعذر إنشاء عرض سعر Aleso');
  }
};

exports.purchaseProduct = async (req, res) => {
  let payment = null;
  let transaction = null;
  let reservedUser = null;
  let priceQuote = null;
  let amountToDeduct = 0;
  let orderUuid = '';
  let statsRecorded = false;

  try {
    const body = req.body || {};
    const productId = toPositiveInteger(getFirstPresent(body.product_id, body.productId), 0);

    if (!productId) {
      return res.status(400).json({
        success: false,
        source: ALESO_PROVIDER,
        message: 'product_id is required',
      });
    }

    const [user, product] = await Promise.all([
      User.findById(req.user.id).select('email number balance').lean(),
      findAlesoProductById(productId),
    ]);

    if (!user) {
      return res.status(404).json({
        success: false,
        source: ALESO_PROVIDER,
        message: 'المستخدم غير موجود',
      });
    }

    if (!product) {
      return res.status(404).json({
        success: false,
        source: ALESO_PROVIDER,
        message: 'منتج Aleso غير موجود',
      });
    }

    if (isReservedDirectTopUpProduct(product)) {
      return res.status(400).json({
        success: false,
        source: ALESO_PROVIDER,
        message: DIRECT_TOPUP_ONLY_MESSAGE,
      });
    }

    if (product.available === false) {
      return res.status(400).json({
        success: false,
        source: ALESO_PROVIDER,
        message: 'هذا المنتج غير متوفر حاليا لدى Aleso',
      });
    }

    const qty = validateQuantity(product, getFirstPresent(body.qty, body.quantity));
    const orderParams = normalizeOrderParams(body);
    assertRequiredParams(product, orderParams);

    const exchangeRateConfig = await getExchangeRateConfig({
      provider: ALESO_PROVIDER,
      fromCurrency: DEFAULT_ALESO_CURRENCY,
      toCurrency: PAYNET_CURRENCY,
    });
    const quoteResult = await resolveQuoteForPurchase({
      userId: req.user.id,
      product,
      qty,
      quoteId: getFirstPresent(body.quote_id, body.quoteId),
      exchangeRateConfig,
    });
    priceQuote = quoteResult.quote;
    const pricing = quoteResult.pricing;
    amountToDeduct = Math.ceil(toPositiveNumber(pricing.totalAmountSyp));
    orderUuid = String(body.order_uuid || body.orderUuid || randomUUID()).trim();
    const paymentType = getPaymentType(body.paymentType);
    const orderTarget = getOrderTarget(orderParams, user);

    payment = new Payment({
      user: req.user.id,
      landline: orderTarget,
      company: product.name,
      speed: `Aleso #${productId}`,
      amount: amountToDeduct,
      calculatedAmount: amountToDeduct,
      paymentType,
      email: user.email,
      status: STARTED_STATUS,
      note: 'بانتظار رد Aleso',
      extra: {
        provider: ALESO_PROVIDER,
        product_id: productId,
        product_name: product.name,
        category_name: product.category_name,
        product_type: product.product_type,
        qty,
        params: orderParams,
        order_uuid: orderUuid,
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
        aleso_currency: DEFAULT_ALESO_CURRENCY,
        aleso_unit_price_usd: pricing.unitPriceUsd,
        aleso_unit_cost_usd: pricing.providerUnitCostUsd,
        provider_unit_cost_usd: pricing.providerUnitCostUsd,
        aleso_expected_debit_usd: pricing.expectedProviderDebitUsd,
        quote_id: priceQuote?._id,
        quote_expires_at: priceQuote?.expiresAt,
        started_at: new Date().toISOString(),
      },
    });
    await payment.save();

    transaction = await AlesoTransaction.create({
      payment: payment._id,
      user: req.user.id,
      userEmail: user.email,
      productId,
      productName: product.name,
      categoryName: product.category_name,
      productType: product.product_type,
      qty,
      params: orderParams,
      orderUuid,
      providerStatus: 'pending',
      paynetAmountSyp: amountToDeduct,
      paynetUnitAmountSyp: pricing.unitAmountSyp,
      paynetBalanceBeforeSyp: user.balance,
      currency: DEFAULT_ALESO_CURRENCY,
      unitPriceUsd: pricing.unitPriceUsd,
      saleUnitPriceUsd: pricing.saleUnitPriceUsd,
      providerUnitCostUsd: pricing.providerUnitCostUsd,
      expectedProviderDebitUsd: pricing.expectedProviderDebitUsd,
      exchangeRate: pricing.exchangeRate,
      marginPercent: pricing.marginPercent,
      roundingStep: pricing.roundingStep,
      expectedCostSyp: Math.ceil(pricing.providerUnitCostUsd * pricing.qty * pricing.exchangeRate),
      quote: priceQuote?._id,
      startedAt: new Date(),
    });

    payment.extra = {
      ...payment.extra,
      aleso_transaction_id: transaction._id,
    };
    await payment.save();

    reservedUser = await User.findOneAndUpdate(
      { _id: req.user.id, balance: { $gte: amountToDeduct } },
      { $inc: { balance: -amountToDeduct } },
      { new: true }
    );

    if (!reservedUser) {
      payment.note = 'الرصيد غير كاف';
      payment.extra = {
        ...payment.extra,
        failed_at: new Date().toISOString(),
        failure_stage: 'paynet_balance',
      };
      await markPaymentStatus(payment, FAILED_STATUS);
      statsRecorded = true;

      transaction.status = 'failed';
      transaction.failureStage = 'paynet_balance';
      transaction.failureReason = 'الرصيد غير كاف';
      transaction.failedAt = new Date();
      await transaction.save();
      await invalidatePaymentCache();

      return res.status(400).json({
        success: false,
        source: ALESO_PROVIDER,
        message: 'الرصيد غير كاف',
      });
    }

    transaction.paynetBalanceAfterSyp = reservedUser.balance;
    await transaction.save();

    const orderResponse = await createAlesoOrder({
      productId,
      qty,
      orderUuid,
      params: orderParams,
    });
    const orderResponseData = orderResponse.data;
    const orderData = getOrderPayload(orderResponseData);
    const providerStatus = applyProviderResultToPayment({
      payment,
      transaction,
      orderData,
      responseData: orderResponseData,
    });

    if (isFailedStatus(providerStatus)) {
      await refundPayNetBalance({
        userId: req.user.id,
        amount: amountToDeduct,
        transaction,
        payment,
        reason: payment.note,
      });
    }

    await payment.save();
    await transaction.save();
    await recordPaymentStats(payment, 1);
    statsRecorded = true;

    if (priceQuote) {
      priceQuote.usedAt = new Date();
      priceQuote.payment = payment._id;
      await priceQuote.save();
    }

    await invalidatePaymentCache();
    await invalidateAlesoCache();
    await emitPendingPayments(req);

    const statusCode = isFailedStatus(providerStatus) ? 400 : 200;
    return res.status(statusCode).json({
      success: !isFailedStatus(providerStatus),
      source: ALESO_PROVIDER,
      message: isCompletedStatus(providerStatus)
        ? 'تم تنفيذ طلب Aleso بنجاح'
        : isFailedStatus(providerStatus)
          ? payment.note
          : 'تم إرسال طلب Aleso وهو بانتظار التنفيذ',
      data: {
        status: providerStatus,
        order: orderData,
        replay_api: orderData?.replay_api,
        payment: sanitizePaymentForCustomer(payment),
        newBalance: reservedUser.balance,
      },
    });
  } catch (error) {
    console.error('Failed to purchase Aleso product:', error);
    const failureMessage = getErrorMessage(error, 'فشل شراء منتج Aleso');
    let unresolvedProviderOrder = false;

    if (reservedUser && orderUuid && transaction) {
      try {
        const checkResponse = await checkAlesoOrders({
          orders: formatOrdersParam([orderUuid]),
          uuid: true,
        });
        const checkData = getCheckOrdersPayload(checkResponse.data)[0];
        if (checkData) {
          const providerStatus = applyProviderResultToPayment({
            payment,
            transaction,
            orderData: checkData,
            responseData: checkResponse.data,
          });
          transaction.rawCheckResponse = checkResponse.data;

          if (isFailedStatus(providerStatus)) {
            await refundPayNetBalance({
              userId: req.user.id,
              amount: amountToDeduct,
              transaction,
              payment,
              reason: payment.note,
            });
          }

          unresolvedProviderOrder = isPendingStatus(providerStatus);
        } else {
          await refundPayNetBalance({
            userId: req.user.id,
            amount: amountToDeduct,
            transaction,
            payment,
            reason: failureMessage,
          });
        }
      } catch (checkError) {
        unresolvedProviderOrder = true;
        transaction.providerStatus = 'unknown';
        transaction.status = 'pending';
        transaction.failureStage = error.stage || 'aleso_order';
        transaction.failureReason = failureMessage;
        transaction.rawCheckResponse = checkError.response?.data || checkError.message;
        if (payment) {
          payment.status = STARTED_STATUS;
          payment.note = 'حالة طلب Aleso غير مؤكدة، يرجى مراجعة الطلب لاحقا';
          payment.extra = {
            ...payment.extra,
            aleso_order_error: error.responseData || error.response?.data || error.message,
            aleso_check_error: checkError.response?.data || checkError.message,
          };
        }
      }
    } else if (reservedUser) {
      await refundPayNetBalance({
        userId: req.user.id,
        amount: amountToDeduct,
        transaction,
        payment,
        reason: failureMessage,
      });
    }

    if (payment) {
      if (!unresolvedProviderOrder && payment.status !== COMPLETED_STATUS) {
        payment.status = FAILED_STATUS;
        payment.note = failureMessage;
        payment.extra = {
          ...payment.extra,
          failed_at: new Date().toISOString(),
          failure_stage: error.stage || 'aleso_order',
          aleso_error: error.responseData || error.response?.data || error.message,
        };
      }

      await payment.save();
      if (!statsRecorded) await recordPaymentStats(payment, 1);
    }

    if (transaction && !unresolvedProviderOrder && transaction.status !== 'completed') {
      transaction.status = transaction.paynetRefundedAt ? 'refunded' : 'failed';
      transaction.providerStatus = transaction.providerStatus === 'pending' ? 'reject' : transaction.providerStatus;
      transaction.failureStage = error.stage || 'aleso_order';
      transaction.failureReason = failureMessage;
      transaction.failureCode = String(getProviderErrorCode(error) || '');
      transaction.failedAt = new Date();
      await transaction.save();
    } else if (transaction) {
      await transaction.save();
    }

    await invalidatePaymentCache();
    await emitPendingPayments(req);

    if (unresolvedProviderOrder) {
      return res.status(202).json({
        success: true,
        source: ALESO_PROVIDER,
        message: 'تم إنشاء الطلب لكن حالة Aleso غير مؤكدة حاليا',
        data: {
          status: 'wait',
          order_uuid: orderUuid,
          payment: sanitizePaymentForCustomer(payment),
        },
      });
    }

    return sendError(res, error, 'فشل شراء منتج Aleso');
  }
};

exports.checkOrders = async (req, res) => {
  try {
    const orders = getFirstPresent(req.body?.orders, req.query.orders);
    const uuid = Boolean(req.body?.uuid || req.query.uuid);
    const ordersParam = formatOrdersParam(orders);

    if (!ordersParam) {
      return res.status(400).json({
        success: false,
        source: ALESO_PROVIDER,
        message: 'orders is required',
      });
    }

    const response = await checkAlesoOrders({
      orders: ordersParam,
      uuid,
    });

    sendSuccess(res, response.data);
  } catch (error) {
    sendError(res, error, 'تعذر التحقق من طلبات Aleso');
  }
};

const applyCheckedStatusToTransaction = async ({ transaction, checkData, responseData }) => {
  const payment = transaction.payment
    ? await Payment.findById(transaction.payment)
    : null;

  transaction.rawCheckResponse = responseData;

  if (!payment) {
    transaction.providerStatus = normalizeProviderStatus(checkData?.status);
    transaction.status = isCompletedStatus(transaction.providerStatus)
      ? 'completed'
      : isFailedStatus(transaction.providerStatus)
        ? 'failed'
        : 'pending';
    await transaction.save();
    return { transaction, payment: null, changed: false };
  }

  const previousStatus = payment.toObject();
  const providerStatus = applyProviderResultToPayment({
    payment,
    transaction,
    orderData: checkData,
    responseData,
  });

  if (isFailedStatus(providerStatus) && !transaction.paynetRefundedAt) {
    await refundPayNetBalance({
      userId: transaction.user,
      amount: transaction.paynetAmountSyp,
      transaction,
      payment,
      reason: payment.note,
    });
  }

  await payment.save();
  await transaction.save();

  if (previousStatus.status !== payment.status) {
    await recordPaymentStats(previousStatus, -1);
    await recordPaymentStats(payment, 1);
  }

  return { transaction, payment, changed: previousStatus.status !== payment.status };
};

exports.refreshPendingOrderStatuses = async ({ limit = ORDER_STATUS_BATCH_LIMIT } = {}) => {
  const normalizedLimit = Math.min(toPositiveInteger(limit, ORDER_STATUS_BATCH_LIMIT), 100);
  const transactions = await AlesoTransaction.find({
    status: 'pending',
    orderUuid: { $exists: true, $ne: '' },
    providerStatus: { $in: ['pending', 'wait', 'unknown'] },
  })
    .sort({ createdAt: 1 })
    .limit(normalizedLimit);

  const refreshed = [];

  for (const transaction of transactions) {
    try {
      const response = await checkAlesoOrders({
        orders: formatOrdersParam([transaction.orderUuid]),
        uuid: true,
      });
      const checkData = getCheckOrdersPayload(response.data)[0];
      if (!checkData) continue;

      const result = await applyCheckedStatusToTransaction({
        transaction,
        checkData,
        responseData: response.data,
      });

      refreshed.push({
        id: transaction._id,
        orderUuid: transaction.orderUuid,
        providerStatus: result.transaction.providerStatus,
        paymentStatus: result.payment?.status,
        changed: result.changed,
      });
    } catch (error) {
      console.error(`Failed to refresh Aleso order ${transaction.orderUuid}:`, error.message);
      refreshed.push({
        id: transaction._id,
        orderUuid: transaction.orderUuid,
        error: getErrorMessage(error, 'تعذر تحديث حالة الطلب'),
      });
    }
  }

  if (refreshed.length) {
    await invalidatePaymentCache();
  }

  return {
    checked: transactions.length,
    refreshed,
  };
};

exports.refreshPendingOrders = async (req, res) => {
  try {
    const result = await exports.refreshPendingOrderStatuses({
      limit: getFirstPresent(req.body?.limit, req.query.limit, ORDER_STATUS_BATCH_LIMIT),
    });

    await emitPendingPayments(req);
    sendSuccess(res, result);
  } catch (error) {
    sendError(res, error, 'تعذر تحديث طلبات Aleso المعلقة');
  }
};

exports.startAlesoOrderStatusScheduler = () => {
  if (!isAlesoApiEnabled()) return;

  const intervalMs = ORDER_STATUS_INTERVAL_MS;
  if (!intervalMs) return;

  setInterval(async () => {
    try {
      const result = await exports.refreshPendingOrderStatuses();
      if (result.checked) {
        console.log('[Aleso] pending order status refresh finished:', result);
      }
    } catch (error) {
      console.error('[Aleso] pending order status refresh failed:', error.message);
    }
  }, intervalMs);

  console.log(`[Aleso] pending order status scheduler enabled every ${intervalMs}ms`);
};
