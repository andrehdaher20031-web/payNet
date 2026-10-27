const mongoose = require('mongoose');
const { customerText } = require('../utils/customerPresentation');
const { randomUUID } = require('crypto');
const provider = require('./alraghebApi');
const catalog = require('./alraghebCatalog.service');
const pricing = require('./alraghebPricing.service');
const Config = require('../models/AlraghebProductConfig');
const Audit = require('../models/AlraghebConfigAudit');
const PricingBatch = require('../models/AlraghebPricingBatch');
const PricingRule = require('../models/AlraghebPricingRule');
const PricingRuleAudit = require('../models/AlraghebPricingRuleAudit');
const Quote = require('../models/AlraghebPriceQuote');
const Transaction = require('../models/AlraghebTransaction');
const Payment = require('../models/Payment');
const User = require('../models/User');
const { recordPaymentStats } = require('./dailyStats.service');
const { cache } = require('./cache.service');
const operations = require('./providerOperations.service');
const RECOVERABLE = ['pending', 'unknown', 'manual_review'];
const { fail } = pricing;
const objectId = (id) => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
const uuid = (id) => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);
const publicOrder = (t, admin = false) => ({
  transaction_id: String(t._id), payment_id: String(t.payment), product_id: t.productId,
  product_name: admin ? t.productName : customerText(t.productName), qty: t.qty, params: t.params, status: t.status,
  provider_status: t.providerStatus, total_amount_syp: t.totalSyp, currency: 'SYP',
  refunded_amount_syp: t.refundedAt ? t.totalSyp : '0', result: t.result ?? null,
  created_at: t.createdAt, updated_at: t.updatedAt,
  ...(admin ? { user: t.user, order_uuid: t.orderUuid, provider_order_id: t.providerOrderId,
    provider_cost_syp: t.providerCostSyp ?? null, estimated_cost_syp: t.providerCostEstimateSyp ?? null,
    markup_percent: t.markupPercent ?? null, markup_fixed_syp: t.markupFixedSyp ?? null,
    gross_profit_syp: t.status === 'refunded' ? '0' : t.status === 'completed' && t.providerCostSyp != null ? new pricing.Decimal(t.totalSyp).minus(t.providerCostSyp).toFixed() : null,
    estimated_profit_syp: t.estimatedProfitSyp ?? null,
    attempts: t.attempts, last_error: t.lastError, next_check_at: t.nextCheckAt,
    error_history: t.errorHistory || [], first_error: t.firstError || null, review_reason: t.reviewReason || '', phase: t.phase,
    revision: t.__v || 0, resolution: t.resolution || null } : {}),
});
const quoteView = (q) => ({ quote_id: String(q._id), product_id: q.productId, qty: q.qty,
  price_per_billing_unit_syp: q.saleUnitPrice ?? q.price, fixed_fee_syp: q.markupFixedSyp ?? '0', billing_unit_qty: q.billingUnitQty,
  total_before_rounding_syp: q.totalBeforeRoundingSyp, total_amount_syp: q.totalSyp,
  currency: 'SYP', expires_at: q.expiresAt, rounding_policy: q.roundingPolicy });
const publicRule = (rule) => rule ? ({
  category_id: rule.categoryId,
  category_name: rule.categoryName,
  markup_percent: rule.markupPercent,
  markup_fixed_syp: rule.markupFixedSyp,
  revision: rule.revision,
  note: rule.note,
  updated_at: rule.updatedAt,
}) : null;

function pricingRuleFor(snapshot, rules, categoryId) {
  const byCategory = new Map(rules.map((rule) => [rule.categoryId, rule]));
  const categories = Array.isArray(snapshot?.categories) ? snapshot.categories : [];
  let current = Number(categoryId);
  while (current) {
    const rule = byCategory.get(current);
    if (rule) return rule;
    const category = categories.find((item) => item.id === current);
    current = category?.parent_id || 0;
  }
  return null;
}

function createOrderService({ client = provider, readCatalog = (options) => catalog.getCatalog(options), onChange = async () => {} } = {}) {
  let topologyCheckedAt = 0;
  async function checkDatabase() {
    if (Date.now() - topologyCheckedAt < 60000) return;
    if (mongoose.connection.readyState !== 1) fail('DATABASE_UNAVAILABLE', 'قاعدة البيانات غير متاحة', 503);
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') fail('TRANSACTIONS_REQUIRED', 'الدفع يحتاج قاعدة تدعم المعاملات', 503);
    topologyCheckedAt = Date.now();
  }
  async function changed() {
    for (const prefix of ['balance:', 'users:', 'payments:', 'report:', 'dailyStats:']) await cache.delByPrefix(prefix);
    await onChange();
  }
  async function atomic(fn) {
    await checkDatabase();
    const session = await mongoose.startSession();
    try { return await session.withTransaction(() => fn(session)); }
    finally { await session.endSession(); }
  }
  async function freshProductContext(id) {
    if (!pricing.positiveInt(id)) fail('INVALID_PRODUCT', 'معرّف المنتج غير صالح');
    const snapshot = await readCatalog();
    const existing = snapshot.products.find((p) => p.id === Number(id));
    if (!existing) fail('PRODUCT_NOT_FOUND', 'المنتج ليس ضمن تطبيقات الدردشة', 404);
    if (snapshot.stale) fail('STALE_CATALOG', 'تعذر تحديث كتالوج التطبيقات', 503);
    const raw = await client.getProduct(Number(id));
    if (!Array.isArray(raw.params) || raw.params.some((field) => typeof field !== 'string' || !field.trim())) fail('INVALID_PRODUCT_FIELDS', 'تعذر التحقق من حقول شحن المنتج', 502);
    return { product: catalog.normalizeProduct(raw, existing.category_id), snapshot };
  }
  const freshProduct = async (id) => (await freshProductContext(id)).product;
  async function permission(userId) {
    const user = await User.findById(userId).lean();
    if (!user || (user.role !== 'admin' && user.card?.cardapplication !== true)) fail('FORBIDDEN', 'شراء التطبيقات غير متاح لهذا الحساب', 403);
    return user;
  }
  function purchaseGate() {
    if (!pricing.enabled() || !pricing.moneyReady() || !provider.isCatalogEnabled()) fail('PURCHASE_DISABLED', 'الشراء متوقف مؤقتًا', 503);
  }
  async function priced(id, qty, params) {
    const product = await freshProduct(id);
    const config = await Config.findOne({ productId: product.id }).lean();
    if (!config?.purchaseEnabled || config.contractHash !== pricing.contractHash(product)) fail('PRODUCT_NOT_CONFIGURED', 'إعدادات شراء المنتج غير معتمدة', 409);
    if (!product.available) fail('PRODUCT_UNAVAILABLE', 'المنتج غير متوفر حاليًا', 409);
    qty = pricing.validateQuantity(product.quantity_rules, qty);
    return { product, config, qty, params: pricing.validateFields(config.fieldSchema, params), ...pricing.calculate(product.provider_price, qty, config.billingUnitQty, config) };
  }
  async function createQuote(userId, body) {
    purchaseGate();
    await operations.assertPurchasingAllowed('alragheb');
    await permission(userId);
    const recent = await Quote.countDocuments({ user: userId, createdAt: { $gte: new Date(Date.now() - 60000) } });
    if (recent >= 20) fail('RATE_LIMITED', 'يرجى الانتظار قبل طلب سعر جديد', 429);
    const value = await priced(body.product_id, body.qty, body.params);
    const q = await Quote.create({ user: userId, productId: value.product.id, productName: value.product.name,
      qty: value.qty, params: value.params, configRevision: value.config.revision,
      contractHash: value.config.contractHash, price: value.price, billingUnitQty: value.config.billingUnitQty,
      totalBeforeRoundingSyp: value.totalBeforeRoundingSyp, totalSyp: value.totalSyp,
      saleUnitPrice: value.saleUnitPrice, markupPercent: value.markupPercent, markupFixedSyp: value.markupFixedSyp,
      providerCostEstimateSyp: value.providerCostEstimateSyp, estimatedProfitSyp: value.estimatedProfitSyp,
      roundingPolicy: pricing.ROUNDING_POLICY,
      expiresAt: new Date(Date.now() + 120000) });
    return quoteView(q);
  }
  async function saveConfig(actor, productId, body) {
    const { product, snapshot } = await freshProductContext(productId);
    return atomic(async (session) => {
      const before = await Config.findOne({ productId: product.id }).session(session).lean();
      if ((before?.revision || 0) !== body.revision) fail('CONFIG_CHANGED', 'تغير إعداد المنتج، أعد تحميله', 409);
      const useCategoryRule = body.markupSource === 'category' || (!before && body.markupPercent === undefined && body.markupFixedSyp === undefined);
      const categoryRule = useCategoryRule
        ? pricingRuleFor(snapshot, await PricingRule.find({}).session(session).lean(), product.category_id)
        : null;
      const clean = pricing.validateConfig({ ...body,
        markupPercent: body.markupPercent === undefined ? categoryRule?.markupPercent ?? before?.markupPercent ?? '0' : body.markupPercent,
        markupFixedSyp: body.markupFixedSyp === undefined ? categoryRule?.markupFixedSyp ?? before?.markupFixedSyp ?? '0' : body.markupFixedSyp }, product);
      const [after] = before ? [await Config.findOneAndUpdate({ _id: before._id, revision: before.revision },
        { $set: { ...clean, updatedBy: actor }, $inc: { revision: 1 } }, { new: true, session })]
        : await Config.create([{ ...clean, updatedBy: actor }], { session });
      await Audit.create([{ productId: product.id, actor, before, after: after.toObject() }], { session });
      return after.toObject();
    });
  }
  async function previewMarkup(actor, body) {
    const markup = pricing.validateMarkup(body);
    if (typeof body.onlyWithoutMarkup !== 'boolean' || !['selected', 'filtered'].includes(body.scope)) fail('INVALID_SCOPE', 'حدد نطاق تعديل الأرباح');
    const snapshot = await readCatalog({ force: true });
    if (snapshot.stale) fail('STALE_CATALOG', 'تعذر تحديث الكتالوج', 503);
    let products;
    if (body.scope === 'selected') {
      if (!Array.isArray(body.productIds) || !body.productIds.length || body.productIds.length > 2000 || body.productIds.some(id => !pricing.positiveInt(id))) fail('INVALID_PRODUCTS', 'حدد منتجات صالحة');
      const ids = new Set(body.productIds.map(Number));
      products = snapshot.products.filter(p => ids.has(p.id));
      if (products.length !== ids.size) fail('PRODUCT_NOT_FOUND', 'أحد المنتجات ليس ضمن تطبيقات الدردشة', 404);
    } else {
      if (!body.filters || typeof body.filters !== 'object' || Array.isArray(body.filters) || Object.keys(body.filters).some(key => !['search', 'category_id', 'available'].includes(key))) fail('INVALID_QUERY', 'مرشحات النطاق غير صالحة');
      const ids = new Set();
      let result;
      for (let page = 1; !result || page <= result.meta.total_pages; page++) {
        result = catalog.selectProducts(snapshot, { ...body.filters, page: String(page), limit: '100' });
        result.data.forEach(p => ids.add(p.id));
      }
      products = snapshot.products.filter(p => ids.has(p.id));
    }
    if (products.length > 2000) fail('INVALID_SCOPE', 'اختر تصنيفًا أو مجموعة أصغر');
    const configs = new Map((await Config.find({ productId: { $in: products.map(p => p.id) } }).lean()).map(c => [c.productId, c]));
    const rows = [], skipped = [], targets = [];
    for (const p of products) {
      const config = configs.get(p.id);
      if (!config || config.contractHash !== pricing.contractHash(p)) { skipped.push({ product_id: p.id, reason: 'not_configured' }); continue; }
      const current = pricing.validateMarkup(config);
      if (body.onlyWithoutMarkup && (current.markupPercent !== '0' || current.markupFixedSyp !== '0')) { skipped.push({ product_id: p.id, reason: 'custom_markup' }); continue; }
      if (current.markupPercent === markup.markupPercent && current.markupFixedSyp === markup.markupFixedSyp) { skipped.push({ product_id: p.id, reason: 'unchanged' }); continue; }
      try {
        const qty = p.quantity_rules.mode === 'choices' ? Math.min(...p.quantity_rules.values) : p.quantity_rules.defaultQty;
        const before = pricing.calculate(p.provider_price, qty, config.billingUnitQty, current);
        const after = pricing.calculate(p.provider_price, qty, config.billingUnitQty, markup);
        rows.push({ product_id: p.id, name: p.name, qty, purchase_enabled: config.purchaseEnabled,
          cost_syp: after.providerCostEstimateSyp, old_total_syp: before.totalSyp, new_total_syp: after.totalSyp,
          profit_syp: after.estimatedProfitSyp, old_markup_percent: current.markupPercent, old_markup_fixed_syp: current.markupFixedSyp });
        targets.push({ productId: p.id, revision: config.revision, contractHash: config.contractHash, providerPrice: before.price });
      } catch (error) {
        if (error.code !== 'INVALID_PRICING') throw error;
        skipped.push({ product_id: p.id, reason: 'invalid_price' });
      }
    }
    const batch = targets.length ? await PricingBatch.create({ actor, ...markup, products: targets, expiresAt: new Date(Date.now() + 300000) }) : null;
    return { batch_id: batch ? String(batch._id) : null, expires_at: batch?.expiresAt, ...markup, total: products.length, rows, skipped };
  }
  async function listPricingRules() {
    const snapshot = await readCatalog();
    const rules = await PricingRule.find({}).lean();
    return {
      categories: snapshot.categories.map((category) => {
        const exact = rules.find((rule) => rule.categoryId === category.id);
        const inherited = exact ? null : pricingRuleFor(snapshot, rules, category.id);
        return { ...catalog.categorySummary(snapshot, category), rule: publicRule(exact), inherited_rule: publicRule(inherited) };
      }),
      rules: rules.map(publicRule),
      synced_at: snapshot.synced_at,
      stale: Boolean(snapshot.stale),
    };
  }
  async function savePricingRule(actor, categoryId, body) {
    const id = catalog.integer(categoryId);
    if (!id) fail('INVALID_CATEGORY', 'معرّف التصنيف غير صالح');
    const snapshot = await readCatalog({ force: true });
    if (snapshot.stale) fail('STALE_CATALOG', 'تعذر تحديث الكتالوج', 503);
    const category = snapshot.categories.find((item) => item.id === id);
    if (!category) fail('CATEGORY_NOT_FOUND', 'التصنيف غير موجود ضمن تطبيقات الدردشة', 404);
    if (typeof body.note !== 'string' || body.note.trim().length < 3 || body.note.length > 500) fail('INVALID_RULE', 'سبب تعديل قاعدة الربح مطلوب');
    const markup = pricing.validateMarkup(body);
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) fail('INVALID_RULE', 'إصدار قاعدة الربح مطلوب');
    const rule = await atomic(async (session) => {
      const existing = await PricingRule.findOne({ categoryId: id }).session(session).lean();
      if ((existing?.revision || 0) !== body.revision) fail('RULE_CHANGED', 'تغيرت قاعدة الربح، أعد تحميلها', 409);
      const values = { categoryId: id, categoryName: category.name, ...markup, note: body.note.trim(), updatedBy: actor };
      const saved = existing
        ? await PricingRule.findOneAndUpdate({ _id: existing._id, revision: existing.revision }, { $set: values, $inc: { revision: 1 } }, { new: true, session })
        : (await PricingRule.create([values], { session }))[0];
      if (!saved) fail('RULE_CHANGED', 'تغيرت قاعدة الربح، أعد تحميلها', 409);
      await PricingRuleAudit.create([{ categoryId: id, actor, note: body.note.trim(), before: existing, after: saved.toObject() }], { session });
      await operations.recordAudit({ provider: 'alragheb', actor, action: 'category_pricing_updated', target: `category:${id}`,
        note: body.note.trim(), before: publicRule(existing), after: publicRule(saved) }, session);
      return saved;
    });
    await onChange();
    return { rule: publicRule(rule), product_count: catalog.categorySummary(snapshot, category).product_count };
  }
  async function applyMarkup(actor, body) {
    if (!objectId(body.batch_id) || typeof body.note !== 'string' || body.note.trim().length < 3 || body.note.length > 500) fail('INVALID_BATCH', 'المعاينة وسبب التعديل مطلوبان');
    const batch = await PricingBatch.findOne({ _id: body.batch_id, actor }).lean();
    if (!batch) fail('BATCH_EXPIRED', 'المعاينة غير متاحة، أعد معاينة الأسعار', 409);
    if (batch.usedAt) return { updated: batch.products.length, already_applied: true };
    if (batch.expiresAt <= new Date()) fail('BATCH_EXPIRED', 'انتهت صلاحية المعاينة', 409);
    const snapshot = await readCatalog({ force: true });
    if (snapshot.stale) fail('STALE_CATALOG', 'تعذر تحديث الكتالوج', 503);
    for (const target of batch.products) {
      const product = snapshot.products.find(p => p.id === target.productId);
      if (!product || pricing.contractHash(product) !== target.contractHash || !new pricing.Decimal(product.provider_price).eq(target.providerPrice)) fail('BATCH_CHANGED', 'تغير سعر المزوّد أو بيانات منتج، أعد المعاينة', 409);
    }
    return atomic(async (session) => {
      const locked = await PricingBatch.findOne({ _id: batch._id, actor }).session(session).lean();
      if (!locked || locked.expiresAt <= new Date()) fail('BATCH_EXPIRED', 'انتهت صلاحية المعاينة', 409);
      if (locked.usedAt) return { updated: locked.products.length, already_applied: true };
      const configs = new Map((await Config.find({ productId: { $in: batch.products.map(p => p.productId) } }).session(session).lean()).map(c => [c.productId, c]));
      const updates = [], audits = [];
      for (const target of batch.products) {
        const before = configs.get(target.productId);
        if (!before || before.revision !== target.revision || before.contractHash !== target.contractHash) fail('CONFIG_CHANGED', 'تغير إعداد أحد المنتجات، أعد المعاينة', 409);
        const values = { markupPercent: batch.markupPercent, markupFixedSyp: batch.markupFixedSyp, note: body.note.trim(), updatedBy: actor };
        updates.push({ updateOne: { filter: { _id: before._id, revision: before.revision }, update: { $set: values, $inc: { revision: 1 } } } });
        audits.push({ productId: target.productId, actor, before, after: { ...before, ...values, revision: before.revision + 1, updatedAt: new Date() } });
      }
      // One bulk write keeps large catalog changes within the transaction time limit.
      const result = await Config.bulkWrite(updates, { session });
      if (result.matchedCount !== updates.length) fail('CONFIG_CHANGED', 'تغير إعداد أحد المنتجات، أعد المعاينة', 409);
      await Audit.insertMany(audits, { session });
      await PricingBatch.updateOne({ _id: batch._id, usedAt: null }, { $set: { usedAt: new Date() } }, { session });
      return { updated: updates.length, already_applied: false };
    });
  }
  async function decorateProducts(products, admin = false, stale = false, categories = []) {
    const configs = mongoose.connection.readyState === 1 ? await Config.find({ productId: { $in: products.map((p) => p.id) } }).lean() : [];
    const rules = admin && mongoose.connection.readyState === 1 ? await PricingRule.find({}).lean() : [];
    const durableEnabled = mongoose.connection.readyState === 1 ? (await operations.getSettings('alragheb')).purchaseEnabled : true;
    const snapshot = admin ? { categories: categories.length ? categories : products.map((p) => ({ id: p.category_id, parent_id: catalog.ROOT_ID })).concat([{ id: catalog.ROOT_ID, parent_id: 0 }]) } : null;
    return products.map((p) => {
      const config = configs.find((c) => c.productId === p.id);
      const decorated = pricing.decorate(p, config, stale);
      return { ...catalog.serializeProduct(p, admin), ...decorated,
        ...(!durableEnabled && decorated.purchase_status === 'ready' ? { purchasable: false, purchase_status: 'purchase_disabled' } : {}),
        ...(admin ? { config: config || null, category_pricing_rule: publicRule(pricingRuleFor(snapshot, rules, p.category_id)) } : {}) };
    });
  }
  async function submit(userId, body) {
    if (!objectId(body.quote_id) || !uuid(body.client_request_id)) fail('INVALID_ORDER', 'بيانات تأكيد الطلب غير صالحة');
    const findPrevious = () => Transaction.findOne({ user: userId, clientRequestId: body.client_request_id }).lean();
    const previous = await findPrevious();
    if (previous) {
      if (String(previous.quote) !== body.quote_id) fail('IDEMPOTENCY_CONFLICT', 'معرّف المحاولة مستخدم لطلب مختلف', 409);
      return publicOrder(previous);
    }
    purchaseGate();
    await operations.assertPurchasingAllowed('alragheb');
    await permission(userId);
    const q = await Quote.findOne({ _id: body.quote_id, user: userId }).lean();
    if (!q || q.expiresAt <= new Date() || q.usedAt) {
      const committed = await findPrevious();
      if (committed) {
        if (String(committed.quote) !== body.quote_id) fail('IDEMPOTENCY_CONFLICT', 'معرّف المحاولة مستخدم لطلب مختلف', 409);
        return publicOrder(committed);
      }
      fail('QUOTE_EXPIRED', 'انتهى عرض السعر أو تم استخدامه', 409);
    }
    const current = await priced(q.productId, q.qty, q.params);
    if (q.roundingPolicy !== pricing.ROUNDING_POLICY || current.config.revision !== q.configRevision || current.price !== q.price || current.totalSyp !== q.totalSyp || current.config.contractHash !== q.contractHash) fail('QUOTE_CHANGED', 'تغير السعر أو إعداد المنتج، يرجى مراجعة عرض جديد', 409);
    let transaction;
    try {
      transaction = await atomic(async (session) => {
        const consumed = await Quote.findOneAndUpdate({ _id: q._id, user: userId, usedAt: null, expiresAt: { $gt: new Date() } }, { $set: { usedAt: new Date() } }, { new: true, session });
        if (!consumed) fail('QUOTE_EXPIRED', 'انتهى عرض السعر أو تم استخدامه', 409);
        // Lock the configuration against a concurrent administrator change.
        const conf = await Config.updateOne({ productId: q.productId, revision: q.configRevision, purchaseEnabled: true }, { $inc: { orderSequence: 1 } }, { session, timestamps: false });
        if (!conf.matchedCount) fail('QUOTE_CHANGED', 'تغير إعداد المنتج', 409);
        const amount = Number(q.totalSyp);
        const user = await User.findOneAndUpdate({ _id: userId, balance: { $gte: amount, $lte: pricing.MAX_WALLET_SYP },
          $or: [{ role: 'admin' }, { 'card.cardapplication': true }] }, pricing.walletAdjustment(`-${q.totalSyp}`), { new: true, session });
        if (!user) fail('INSUFFICIENT_BALANCE', 'رصيد المحفظة غير كاف أو صلاحية الشراء متوقفة', 409);
        const transactionId = new mongoose.Types.ObjectId();
        const [payment] = await Payment.create([{ user: userId, email: user.email, company: 'Alragheb', landline: Object.values(q.params || {}).join(' / '),
          amount, calculatedAmount: amount, paymentType: 'cash', status: 'قيد التنفيذ',
          extra: { provider: 'alragheb', transaction_id: String(transactionId), product_id: q.productId, product_name: q.productName, qty: q.qty, currency: 'SYP' } }], { session });
        const [t] = await Transaction.create([{ _id: transactionId, user: userId, payment: payment._id, quote: q._id,
          clientRequestId: body.client_request_id, orderUuid: randomUUID(), productId: q.productId, productName: q.productName,
          qty: q.qty, params: q.params, totalSyp: q.totalSyp, price: q.price, billingUnitQty: q.billingUnitQty, roundingPolicy: q.roundingPolicy,
          markupPercent: q.markupPercent, markupFixedSyp: q.markupFixedSyp, providerCostEstimateSyp: q.providerCostEstimateSyp, estimatedProfitSyp: q.estimatedProfitSyp }], { session });
        await recordPaymentStats(payment, 1, session);
        return t;
      });
    } catch (error) {
      const duplicate = await findPrevious();
      if (!duplicate) throw error;
      if (String(duplicate.quote) !== body.quote_id) fail('IDEMPOTENCY_CONFLICT', 'معرّف المحاولة مستخدم لطلب مختلف', 409);
      return publicOrder(duplicate);
    }
    await changed().catch(() => {});
    await processOrder(String(transaction._id));
    return publicOrder(await Transaction.findById(transaction._id).lean());
  }
  async function settle(t, data, resolution = null) {
    const supportEvidence = resolution?.evidence?.source === 'provider_support';
    if (!data || !['accept', 'wait', 'reject'].includes(data.status) || (!supportEvidence && (typeof data.order_id !== 'string' || !data.order_id))
      || (t.providerOrderId && data.order_id && t.providerOrderId !== data.order_id) || (data.order_uuid && data.order_uuid !== t.orderUuid)) fail('INVALID_ORDER_RESPONSE', 'تعذر تأكيد نتيجة المزوّد', 502);
    const update = { providerStatus: data.status, ...(data.order_id ? { providerOrderId: data.order_id } : {}), phase: 'checking',
      leaseUntil: new Date(0), leaseToken: null, nextCheckAt: new Date(Date.now() + Math.min(300000, 30000 * 2 ** Math.min(t.attempts, 4))), lastError: null };
    try { const cost = new pricing.Decimal(data.price); if (cost.isFinite() && cost.gte(0)) update.providerCostSyp = cost.toFixed(); } catch { /* Cost is optional, not a new customer charge. */ }
    if (data.status === 'wait') return Transaction.updateOne({ _id: t._id, leaseToken: t.leaseToken, status: { $in: RECOVERABLE } },
      [{ $set: { ...update, status: { $cond: [{ $eq: ['$status', 'manual_review'] }, 'manual_review', 'pending'] },
        __v: { $add: [{ $ifNull: ['$__v', 0] }, 1] } } }]);
    update.phase = 'done';
    update.status = data.status === 'accept' ? 'completed' : 'refunded';
    // Preserve every delivered value; the UI renders this as text and can collapse long output.
    update.result = data.replay_api == null ? t.result ?? null : JSON.stringify(data.replay_api);
    update.reviewReason = null;
    if (resolution) update.resolution = resolution;
    await atomic(async (session) => {
      const locked = await Transaction.findOne({ _id: t._id, status: { $in: RECOVERABLE }, leaseToken: t.leaseToken }).session(session);
      if (!locked) fail('ORDER_CHANGED', 'تغيرت حالة الطلب، أعد تحميله', 409);
      const payment = await Payment.findById(t.payment).session(session);
      if (!payment) fail('PAYMENT_MISSING', 'السجل المالي بحاجة للمراجعة', 500);
      await recordPaymentStats(payment, -1, session);
      if (data.status === 'reject') {
        const maxBalance = new pricing.Decimal(pricing.MAX_WALLET_SYP).minus(t.totalSyp).toNumber();
        const refunded = await User.updateOne({ _id: t.user, balance: { $lte: maxBalance } }, pricing.walletAdjustment(t.totalSyp), { session });
        if (!refunded.matchedCount) fail('REFUND_FAILED', 'تعذر تسوية الرصيد', 500);
        update.refundedAt = new Date();
        payment.note = 'رفض المزوّد، أعيد المبلغ إلى المحفظة';
      }
      payment.status = data.status === 'accept' ? 'تم التسديد' : 'غير مسددة';
      await payment.save({ session });
      await recordPaymentStats(payment, 1, session);
      await Transaction.updateOne({ _id: t._id, leaseToken: t.leaseToken }, { $set: update, $inc: { __v: 1 } }, { session });
      if (resolution) await operations.recordAudit({ provider: 'alragheb', actor: resolution.actor, action: resolution.action,
        target: String(t._id), note: resolution.note, before: { status: locked.status, amount: locked.totalSyp },
        after: { status: update.status, refunded: Boolean(update.refundedAt) }, evidence: resolution.evidence }, session);
    });
    await changed().catch(() => {});
  }
  async function processOrder(id) {
    const token = randomUUID();
    const t = await Transaction.findOneAndUpdate({ _id: id, status: { $in: RECOVERABLE }, leaseUntil: { $lte: new Date() } },
      { $set: { leaseToken: token, leaseUntil: new Date(Date.now() + 90000) }, $inc: { attempts: 1, __v: 1 } }, { new: true }).lean();
    if (!t) return;
    try {
      let data;
      if (t.phase === 'queued') {
        // A durable stop also pauses an order that was reserved but has not been sent.
        try { purchaseGate(); await operations.assertPurchasingAllowed('alragheb'); }
        catch (error) { error.requestOutcome = 'not_sent'; throw error; }
        const sent = await Transaction.updateOne({ _id: t._id, leaseToken: token }, { $set: { phase: 'sending' } });
        if (!sent.matchedCount) return;
        data = (await client.newOrder(t.productId, t.qty, t.params, t.orderUuid))?.data;
      } else {
        const response = await client.checkOrder(t.orderUuid);
        if (!Array.isArray(response?.data) || response.data.length !== 1) fail('ORDER_UNCONFIRMED', 'نتيجة الطلب غير محسومة', 502);
        data = response.data[0];
      }
      await settle(t, data);
    } catch (error) {
      const settings = await operations.getSettings('alragheb');
      const notSent = t.phase === 'queued' && error.requestOutcome === 'not_sent';
      const since = t.uncertainSince || t.createdAt || new Date();
      const aged = Date.now() - new Date(since).getTime() >= settings.reviewAfterMinutes * 60000;
      const status = t.status === 'manual_review' || aged ? 'manual_review' : notSent ? 'pending' : 'unknown';
      const code = operations.safeCode(error.status ? error.code : 'RECONCILIATION_FAILED');
      await Transaction.updateOne({ _id: t._id, status: { $in: RECOVERABLE }, leaseToken: token }, {
        $set: { status, phase: notSent ? 'queued' : 'checking', leaseToken: null, leaseUntil: new Date(0),
          nextCheckAt: new Date(Date.now() + Math.min(300000, 30000 * 2 ** Math.min(t.attempts, 4))), lastError: code,
          ...(!notSent ? { uncertainSince: t.uncertainSince || new Date() } : {}),
          ...(!t.firstError?.code ? { firstError: { at: new Date(), code, phase: t.phase, outcome: notSent ? 'not_sent' : 'unknown' } } : {}),
          ...(status === 'manual_review' ? { reviewSince: t.reviewSince || new Date(), reviewReason: notSent ? 'DISPATCH_NOT_SENT' : 'PROVIDER_OUTCOME_UNCONFIRMED' } : {}),
        }, $push: { errorHistory: { $each: [{ at: new Date(), code, phase: t.phase, outcome: notSent ? 'not_sent' : 'unknown' }], $slice: -100 } }, $inc: { __v: 1 },
      });
    }
  }
  async function reconcile() {
    const settings = await operations.getSettings('alragheb');
    const cutoff = new Date(Date.now() - settings.reviewAfterMinutes * 60000);
    await Transaction.updateMany({ status: { $in: ['pending', 'unknown'] }, createdAt: { $lte: cutoff } }, {
      $set: { status: 'manual_review', reviewSince: new Date(), reviewReason: 'ORDER_AGE_EXCEEDED' }, $inc: { __v: 1 },
    });
    const pending = await Transaction.find({ status: { $in: RECOVERABLE }, nextCheckAt: { $lte: new Date() }, leaseUntil: { $lte: new Date() } }).sort({ nextCheckAt: 1 }).limit(20).select('_id').lean();
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(settings.workerConcurrency, pending.length) }, async () => {
      while (cursor < pending.length) { const index = cursor++; await processOrder(String(pending[index]._id)); }
    }));
    return pending.length;
  }
  async function checkTransaction(id, { actorId, isAdmin = false } = {}) {
    if (!isAdmin || !objectId(String(actorId))) fail('FORBIDDEN', 'هذه العملية مخصصة للمسؤول', 403);
    const before = await getOrder(actorId, id, true);
    if (before.next_check_at && Date.parse(before.next_check_at) > Date.now()) fail('CHECK_COOLDOWN', 'انتظر موعد الفحص التالي', 429);
    await processOrder(id);
    const after = await getOrder(actorId, id, true);
    await operations.recordAudit({ provider: 'alragheb', actor: actorId, action: 'order_checked', target: id,
      note: 'فحص المسؤول حالة الطلب لدى المزوّد', before: { status: before.status }, after: { status: after.status } });
    return after;
  }
  async function resolveTransaction(id, body = {}) {
    if (!body.isAdmin || !objectId(String(body.actorId))) fail('FORBIDDEN', 'هذه العملية مخصصة للمسؤول', 403);
    if (!objectId(id) || !['resolve_failed', 'resolve_completed'].includes(body.action) || !Number.isSafeInteger(body.revision)) fail('INVALID_RESOLUTION', 'بيانات التسوية غير صالحة');
    const note = operations.cleanNote(body.note, 10);
    const existing = await Transaction.findById(id).lean();
    if (!existing) fail('ORDER_NOT_FOUND', 'الطلب غير موجود', 404);
    if (!RECOVERABLE.includes(existing.status)) {
      if (existing.resolution?.action === body.action) return publicOrder(existing, true);
      fail('ORDER_FINAL', 'الطلب محسوم ولا يحتاج تسوية', 409);
    }
    if ((existing.__v || 0) !== body.revision) fail('ORDER_CHANGED', 'تغير الطلب، أعد تحميله', 409);
    const evidence = body.providerEvidence;
    const expected = body.action === 'resolve_failed' ? 'rejected' : 'completed';
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || !['provider_api', 'provider_support'].includes(evidence.source)
      || ![existing.orderUuid, existing.providerOrderId].filter(Boolean).includes(evidence.providerReference)
      || evidence.confirmedOutcome !== expected || typeof evidence.checkedAt !== 'string' || !Number.isFinite(Date.parse(evidence.checkedAt))
      || Date.parse(evidence.checkedAt) > Date.now() + 300000
      || (evidence.source === 'provider_support' && (typeof evidence.ticketReference !== 'string' || evidence.ticketReference.trim().length < 3 || evidence.ticketReference.length > 200))) {
      fail('INVALID_EVIDENCE', 'يلزم مرجع المزوّد ونتيجة مؤكدة وتاريخ التحقق، مع رقم تذكرة الدعم عند المراجعة اليدوية');
    }
    const cleanEvidence = { source: evidence.source, providerReference: evidence.providerReference, confirmedOutcome: expected,
      checkedAt: new Date(evidence.checkedAt), ...(evidence.source === 'provider_support' ? { ticketReference: evidence.ticketReference.trim() } : {}) };
    let data;
    try {
      const response = await client.checkOrder(existing.orderUuid);
      if (Array.isArray(response?.data) && response.data.length === 1) data = response.data[0];
    } catch (error) {
      if (evidence.source !== 'provider_support') throw error;
    }
    if (data && ['accept', 'reject', 'wait'].includes(data.status)) {
      if (data.status !== (expected === 'rejected' ? 'reject' : 'accept')) fail('PROVIDER_EVIDENCE_CONFLICT', 'حالة المزوّد لا تطابق التسوية المطلوبة', 409);
      cleanEvidence.source = 'provider_api';
      cleanEvidence.providerOrderId = data.order_id;
    } else {
      if (evidence.source !== 'provider_support' || existing.status !== 'manual_review') fail('ORDER_UNCONFIRMED', 'النتيجة غير مؤكدة؛ يلزم مراجعة الطلب وتأكيد موثق من دعم المزوّد', 409);
      data = { status: expected === 'rejected' ? 'reject' : 'accept', ...(existing.providerOrderId ? { order_id: existing.providerOrderId } : {}) };
    }
    const token = randomUUID();
    const versionFilter = existing.__v == null ? { $or: [{ __v: body.revision }, { __v: { $exists: false } }] } : { __v: body.revision };
    const locked = await Transaction.findOneAndUpdate({ _id: id, status: { $in: RECOVERABLE }, leaseUntil: { $lte: new Date() }, ...versionFilter },
      { $set: { leaseToken: token, leaseUntil: new Date(Date.now() + 90000) }, $inc: { __v: 1 } }, { new: true }).lean();
    if (!locked) fail('ORDER_CHANGED', 'تغير الطلب أو يجري فحصه، أعد تحميله', 409);
    try { await settle(locked, data, { actor: body.actorId, action: body.action, note, at: new Date(), evidence: cleanEvidence }); }
    finally { await Transaction.updateOne({ _id: id, leaseToken: token }, { $set: { leaseToken: null, leaseUntil: new Date(0) } }); }
    return getOrder(body.actorId, id, true);
  }
  async function getOrder(userId, id, admin = false) {
    if (!objectId(id)) fail('ORDER_NOT_FOUND', 'الطلب غير موجود', 404);
    const order = await Transaction.findOne({ _id: id, ...(admin ? {} : { user: userId }) }).lean();
    if (!order) fail('ORDER_NOT_FOUND', 'الطلب غير موجود', 404);
    return publicOrder(order, admin);
  }
  async function listOrders(userId, query = {}, admin = false) {
    const page = query.page === undefined ? 1 : Number(query.page);
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_QUERY', 'التصفح غير صالح');
    const filter = admin ? {} : { user: userId };
    if (query.status) {
      if (!['pending', 'unknown', 'manual_review', 'completed', 'refunded'].includes(query.status)) fail('INVALID_QUERY', 'الحالة غير صالحة');
      filter.status = query.status;
    }
    if (query.product_id) {
      if (!pricing.positiveInt(query.product_id)) fail('INVALID_QUERY', 'المنتج غير صالح');
      filter.productId = Number(query.product_id);
    }
    for (const key of ['from', 'to']) {
      if (query[key]) {
        filter.createdAt ||= {};
        filter.createdAt[key === 'from' ? '$gte' : '$lt'] = operations.dayBoundary(query[key], key === 'to');
      }
    }
    const total = await Transaction.countDocuments(filter);
    const orders = await Transaction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
    return { data: orders.map((t) => publicOrder(t, admin)), meta: { total, page, limit, total_pages: Math.max(1, Math.ceil(total / limit)) } };
  }
  async function summary() {
    const rows = await Transaction.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: { $toDecimal: '$totalSyp' } }, oldest: { $min: '$createdAt' } } }]);
    return { currency: 'SYP', purchase_enabled: pricing.enabled() && pricing.moneyReady() && provider.isCatalogEnabled() && (await operations.getSettings('alragheb')).purchaseEnabled,
      configured_products: await Config.countDocuments({ purchaseEnabled: true }),
      statuses: Object.fromEntries(rows.map((r) => [r._id, { count: r.count, amount_syp: r.amount.toString(), oldest: r.oldest }])) };
  }
  return { createQuote, submit, saveConfig, previewMarkup, applyMarkup, listPricingRules, savePricingRule, decorateProducts, getOrder, listOrders, processOrder, reconcile, checkTransaction, resolveTransaction, checkDatabase, summary };
}
module.exports = { ...createOrderService(), createOrderService, publicOrder };
