const provider = require('../services/alraghebApi');
const catalog = require('../services/alraghebCatalog.service');
const orders = require('../services/alraghebOrder.service');
const pricing = require('../services/alraghebPricing.service');

const decorateResult = async (snapshot, result, admin = false) => {
  const list = Array.isArray(result.data) ? result.data : result.data.products;
  const ids = new Set(list.map((p) => p.id));
  const decorated = await orders.decorateProducts(snapshot.products.filter((p) => ids.has(p.id)), admin, snapshot.stale, snapshot.categories);
  const values = list.map((p) => decorated.find((item) => item.id === p.id));
  if (Array.isArray(result.data)) result.data = values; else result.data.products = values;
  result.meta.purchase_enabled = pricing.enabled() && pricing.moneyReady();
  result.meta.currency = 'SYP';
  result.meta.rounding_policy = pricing.ROUNDING_POLICY;
  return result;
};

const sendError = (res, error) => res.status(error.status || 502).json({
  success: false,
  source: 'alragheb',
  code: error.status ? error.code : 'ALRAGHEB_UNAVAILABLE',
  message: error.status ? error.message : 'تعذر تحميل تطبيقات الدردشة، يرجى المحاولة لاحقًا',
});

const handler = (action) => async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  if (!provider.isCatalogEnabled()) {
    return sendError(res, provider.alraghebError('ALRAGHEB_DISABLED', 'خدمة تطبيقات الدردشة متوقفة مؤقتًا', 503));
  }
  try {
    return res.json({ success: true, source: 'alragheb', ...await action(req) });
  } catch (error) {
    return sendError(res, error);
  }
};

exports.getProfile = handler(async () => {
  const data = await provider.getProfile();
  if (!Object.hasOwn(data, 'balance')) throw provider.alraghebError('ALRAGHEB_INVALID_RESPONSE', 'تعذر قراءة بيانات حساب المزوّد');
  return { data: { balance: data.balance, email: data.email || '', currency: 'SYP' } };
});

exports.getProducts = handler(async (req) => {
  catalog.parseQuery(req.query);
  const snapshot = await catalog.getCatalog();
  return decorateResult(snapshot, catalog.selectProducts(snapshot, req.query));
});

exports.getContent = handler(async (req) => {
  const id = catalog.integer(req.params.categoryId);
  if (!id) throw provider.alraghebError('INVALID_CATEGORY', 'معرّف التصنيف غير صالح', 400);
  catalog.parseQuery(req.query);
  const snapshot = await catalog.getCatalog();
  return decorateResult(snapshot, catalog.selectContent(snapshot, id, req.query));
});

exports.getProduct = handler(async (req) => {
  const id = catalog.integer(req.params.productId);
  if (!id) throw provider.alraghebError('INVALID_PRODUCT', 'معرّف المنتج غير صالح', 400);
  const snapshot = await catalog.getCatalog();
  const product = snapshot.products.find((item) => item.id === id);
  if (!product) throw provider.alraghebError('PRODUCT_NOT_FOUND', 'المنتج غير موجود ضمن تطبيقات الدردشة', 404);
  return {
    data: (await orders.decorateProducts([product], false, snapshot.stale))[0],
    meta: { synced_at: snapshot.synced_at, stale: Boolean(snapshot.stale), purchase_enabled: pricing.enabled() && pricing.moneyReady() },
  };
});

exports.getAdminProducts = handler(async (req) => {
  catalog.parseQuery(req.query);
  const snapshot = await catalog.getCatalog();
  const result = catalog.selectProducts(snapshot, req.query, { admin: true });
  result.meta.categories = snapshot.categories.map((category) => catalog.categorySummary(snapshot, category));
  return decorateResult(snapshot, result, true);
});

let nextRefreshAt = 0;
exports.refreshCatalog = handler(async () => {
  if (Date.now() < nextRefreshAt) {
    throw provider.alraghebError('REFRESH_COOLDOWN', 'يمكن تحديث الكتالوج مرة كل 30 ثانية', 429);
  }
  nextRefreshAt = Date.now() + 30000;
  const snapshot = await catalog.getCatalog({ force: true });
  return { data: { total: snapshot.products.length, synced_at: snapshot.synced_at } };
});

// Financial/history routes remain available when catalog browsing is disabled.
const purchaseHandler = (action) => async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    const result = await action(req);
    res.status(result.data?.status === 'pending' ? 202 : 200).json({ success: true, source: 'alragheb', ...result });
  } catch (error) { sendError(res, error); }
};
exports.quote = purchaseHandler(async (req) => ({ data: await orders.createQuote(req.user.id, req.body || {}) }));
exports.order = purchaseHandler(async (req) => ({ data: await orders.submit(req.user.id, req.body || {}) }));
exports.orderList = purchaseHandler((req) => orders.listOrders(req.user.id, req.query));
exports.orderDetail = purchaseHandler(async (req) => ({ data: await orders.getOrder(req.user.id, req.params.id) }));
exports.saveConfig = purchaseHandler(async (req) => ({ data: await orders.saveConfig(req.user.id, req.params.productId, req.body || {}) }));
exports.previewMarkup = purchaseHandler(async (req) => ({ data: await orders.previewMarkup(req.user.id, req.body || {}) }));
exports.applyMarkup = purchaseHandler(async (req) => ({ data: await orders.applyMarkup(req.user.id, req.body || {}) }));
exports.pricingRules = purchaseHandler(async () => ({ data: await orders.listPricingRules() }));
exports.savePricingRule = purchaseHandler(async (req) => ({ data: await orders.savePricingRule(req.user.id, req.params.categoryId, req.body || {}) }));
exports.adminOrderList = purchaseHandler((req) => orders.listOrders(req.user.id, req.query, true));
exports.summary = purchaseHandler(async () => ({ data: await orders.summary() }));
exports.checkOrder = purchaseHandler(async (req) => {
  const order = await orders.getOrder(req.user.id, req.params.id, true);
  if (order.next_check_at && Date.parse(order.next_check_at) > Date.now()) throw provider.alraghebError('CHECK_COOLDOWN', 'يرجى انتظار موعد التحقق التالي', 429);
  await orders.processOrder(req.params.id);
  return { data: await orders.getOrder(req.user.id, req.params.id, true) };
});
exports.configHistory = purchaseHandler(async (req) => {
  const id = catalog.integer(req.params.productId);
  if (!id) throw provider.alraghebError('INVALID_PRODUCT', 'معرّف المنتج غير صالح', 400);
  return { data: await require('../models/AlraghebConfigAudit').find({ productId: id }).sort({ createdAt: -1 }).limit(20).lean() };
});
