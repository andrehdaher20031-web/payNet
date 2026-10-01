const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const provider = require('./alraghebApi');
const catalog = require('./alraghebCatalog.service');
const pricing = require('./alraghebPricing.service');
const Config = require('../models/AlraghebProductConfig');
const Audit = require('../models/AlraghebConfigAudit');
const PricingBatch = require('../models/AlraghebPricingBatch');
const PricingRule = require('../models/AlraghebPricingRule');
const Quote = require('../models/AlraghebPriceQuote');
const Transaction = require('../models/AlraghebTransaction');
const Payment = require('../models/Payment');
const User = require('../models/User');
const { recordPaymentStats } = require('./dailyStats.service');
const { cache } = require('./cache.service');
const { fail } = pricing;
const objectId = (id) => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
const uuid = (id) => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);
const publicOrder = (t, admin = false) => ({
  transaction_id: String(t._id), payment_id: String(t.payment), product_id: t.productId,
  product_name: t.productName, qty: t.qty, params: t.params, status: t.status,
  provider_status: t.providerStatus, total_amount_syp: t.totalSyp, currency: 'SYP',
  refunded_amount_syp: t.refundedAt ? t.totalSyp : '0', result: t.result ?? null,
  created_at: t.createdAt, updated_at: t.updatedAt,
  ...(admin ? { user: t.user, order_uuid: t.orderUuid, provider_order_id: t.providerOrderId,
    provider_cost_syp: t.providerCostSyp ?? null, estimated_cost_syp: t.providerCostEstimateSyp ?? null,
    markup_percent: t.markupPercent ?? null, markup_fixed_syp: t.markupFixedSyp ?? null,
    gross_profit_syp: t.status === 'refunded' ? '0' : t.status === 'completed' && t.providerCostSyp != null ? new pricing.Decimal(t.totalSyp).minus(t.providerCostSyp).toFixed() : null,
    estimated_profit_syp: t.estimatedProfitSyp ?? null,
    attempts: t.attempts, last_error: t.lastError, next_check_at: t.nextCheckAt } : {}),
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
    const existing = await PricingRule.findOne({ categoryId: id }).lean();
    const values = { categoryId: id, categoryName: category.name, ...markup, note: body.note.trim(), updatedBy: actor };
    const rule = existing
      ? await PricingRule.findOneAndUpdate({ _id: existing._id, revision: existing.revision }, { $set: values, $inc: { revision: 1 } }, { new: true })
      : await PricingRule.create(values);
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
    const snapshot = admin ? { categories: categories.length ? categories : products.map((p) => ({ id: p.category_id, parent_id: catalog.ROOT_ID })).concat([{ id: catalog.ROOT_ID, parent_id: 0 }]) } : null;
    return products.map((p) => {
      const config = configs.find((c) => c.productId === p.id);
      return { ...catalog.serializeProduct(p, admin), ...pricing.decorate(p, config, stale),
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
  async function settle(t, data) {
    if (!data || !['accept', 'wait', 'reject'].includes(data.status) || typeof data.order_id !== 'string' || (t.providerOrderId && t.providerOrderId !== data.order_id)) fail('INVALID_ORDER_RESPONSE', 'تعذر تأكيد نتيجة المزوّد', 502);
    const update = { providerStatus: data.status, providerOrderId: data.order_id, phase: 'checking',
      leaseUntil: new Date(0), leaseToken: null, nextCheckAt: new Date(Date.now() + Math.min(300000, 30000 * 2 ** Math.min(t.attempts, 4))), lastError: null };
    try { const cost = new pricing.Decimal(data.price); if (cost.isFinite() && cost.gte(0)) update.providerCostSyp = cost.toFixed(); } catch { /* Cost is optional, not a new customer charge. */ }
    if (data.status === 'wait') return Transaction.updateOne({ _id: t._id, leaseToken: t.leaseToken, status: 'pending' }, { $set: update });
    update.phase = 'done';
    update.status = data.status === 'accept' ? 'completed' : 'refunded';
    // Keep provider fulfilment text bounded and render it as text only.
    update.result = data.replay_api == null ? null : JSON.stringify(data.replay_api).slice(0, 4000);
    await atomic(async (session) => {
      const locked = await Transaction.findOne({ _id: t._id, status: 'pending', leaseToken: t.leaseToken }).session(session);
      if (!locked) return;
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
      await Transaction.updateOne({ _id: t._id, leaseToken: t.leaseToken }, { $set: update }, { session });
    });
    await changed().catch(() => {});
  }
  async function processOrder(id) {
    const token = randomUUID();
    const t = await Transaction.findOneAndUpdate({ _id: id, status: 'pending', leaseUntil: { $lte: new Date() } },
      { $set: { leaseToken: token, leaseUntil: new Date(Date.now() + 90000) }, $inc: { attempts: 1 } }, { new: true }).lean();
    if (!t) return;
    try {
      let data;
      if (t.phase === 'queued') {
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
      await Transaction.updateOne({ _id: t._id, status: 'pending', leaseToken: token }, { $set: { phase: 'checking', leaseToken: null,
        leaseUntil: new Date(0), nextCheckAt: new Date(Date.now() + 60000), lastError: error.status ? error.code : 'RECONCILIATION_FAILED' } });
    }
  }
  async function reconcile() {
    const pending = await Transaction.find({ status: 'pending', nextCheckAt: { $lte: new Date() }, leaseUntil: { $lte: new Date() } }).sort({ nextCheckAt: 1 }).limit(20).select('_id').lean();
    for (const t of pending) await processOrder(String(t._id));
    return pending.length;
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
      if (!['pending', 'completed', 'refunded'].includes(query.status)) fail('INVALID_QUERY', 'الحالة غير صالحة');
      filter.status = query.status;
    }
    if (query.product_id) {
      if (!pricing.positiveInt(query.product_id)) fail('INVALID_QUERY', 'المنتج غير صالح');
      filter.productId = Number(query.product_id);
    }
    for (const key of ['from', 'to']) {
      if (query[key]) {
        if (typeof query[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(query[key]) || !Number.isFinite(Date.parse(query[key]))) fail('INVALID_QUERY', 'التاريخ غير صالح');
        filter.createdAt ||= {};
        filter.createdAt[key === 'from' ? '$gte' : '$lt'] = new Date(Date.parse(query[key]) + (key === 'to' ? 86400000 : 0));
      }
    }
    const total = await Transaction.countDocuments(filter);
    const orders = await Transaction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
    return { data: orders.map((t) => publicOrder(t, admin)), meta: { total, page, limit, total_pages: Math.max(1, Math.ceil(total / limit)) } };
  }
  async function summary() {
    const rows = await Transaction.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: { $toDecimal: '$totalSyp' } }, oldest: { $min: '$createdAt' } } }]);
    return { currency: 'SYP', purchase_enabled: pricing.enabled() && pricing.moneyReady(),
      configured_products: await Config.countDocuments({ purchaseEnabled: true }),
      statuses: Object.fromEntries(rows.map((r) => [r._id, { count: r.count, amount_syp: r.amount.toString(), oldest: r.oldest }])) };
  }
  return { createQuote, submit, saveConfig, previewMarkup, applyMarkup, listPricingRules, savePricingRule, decorateProducts, getOrder, listOrders, processOrder, reconcile, checkDatabase, summary };
}
module.exports = { ...createOrderService(), createOrderService, publicOrder };
