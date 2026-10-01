const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const pricing = require('../services/alraghebPricing.service');
const catalog = require('../services/alraghebCatalog.service');
const { createOrderService } = require('../services/alraghebOrder.service');
const User = require('../models/User');
const Payment = require('../models/Payment');
const Quote = require('../models/AlraghebPriceQuote');
const Config = require('../models/AlraghebProductConfig');
const Transaction = require('../models/AlraghebTransaction');
const Audit = require('../models/AlraghebConfigAudit');
const PricingBatch = require('../models/AlraghebPricingBatch');
const PricingRule = require('../models/AlraghebPricingRule');
const DailyStats = require('../models/DailyStats');
const Balance = require('../models/Balance');
const Point = require('../models/Point');

test('SYP pricing and strict quantity contracts', () => {
  assert.equal(pricing.calculate('0.2', 2500, 1).totalSyp, '500.00');
  assert.equal(pricing.calculate('200', 2500, 1000).totalSyp, '500.00');
  assert.equal(pricing.calculate('0.05207935795263217', 3000, 1).totalBeforeRoundingSyp, '156.23807385789651');
  assert.equal(pricing.calculate('0.05207935795263217', 3000, 1).totalSyp, '156.24');
  assert.throws(() => pricing.calculate('0.000000000000000001', 1000000, 1), { code: 'INVALID_PRICING' });
  assert.equal(pricing.calculate('1.005', 1, 1).totalSyp, '1.01');
  assert.equal(pricing.calculate('1.004', 1, 1).totalSyp, '1.00');
  const rules = catalog.normalizeQuantity({ min: 1000, max: 10000 });
  for (const qty of [1000, 1001, 1500, 10000]) assert.equal(pricing.validateQuantity(rules, qty), qty);
  for (const qty of [0, -1, 999, 10001, 1000.5, true, '1e3', '', [1000], { qty: 1000 }]) assert.throws(() => pricing.validateQuantity(rules, qty));
  assert.throws(() => pricing.validateQuantity(catalog.normalizeQuantity(null), 2));
  assert.throws(() => pricing.validateQuantity(catalog.normalizeQuantity([100, 150]), 101));
  for (const price of [null, undefined, 0, -1, 'NaN', 'Infinity']) assert.throws(() => pricing.calculate(price, 10, 1));
  assert.throws(() => pricing.calculate('999999999999999999', 1, 1));
});

test('each chat app keeps its own unit price and quantity instead of a shared rate', () => {
  const examples = [
    { id: 4, price: '0.23977917611178512', qty: 2000, total: '479.56' },
    { id: 203, price: '0.014918810289389068', qty: 10000, total: '149.19' },
    { id: 143, price: '0.02046460624385496', qty: 5000, total: '102.32' },
    { id: 25, price: '479.55835222357024', qty: 1, total: '479.56' },
  ];
  for (const product of examples) {
    const result = pricing.calculate(product.price, product.qty, 1);
    assert.equal(result.price, product.price, `Product ${product.id} unit price must remain unrounded`);
    assert.equal(result.totalSyp, product.total, `Product ${product.id} total`);
  }
});

test('markup uses independent costs, adds fixed fee once, and rounds only final sale', () => {
  const p = pricing.calculate('0.2', 2500, 1, { markupPercent: '10', markupFixedSyp: '2.50' });
  assert.equal(p.totalSyp, '552.50'); assert.equal(p.price, '0.2'); assert.equal(p.saleUnitPrice, '0.22');
  assert.equal(p.providerCostEstimateSyp, '500'); assert.equal(p.estimatedProfitSyp, '52.5');
  assert.equal(pricing.calculate('0.23977917611178512', 2000, 1, { markupPercent: '10' }).totalSyp, '527.51');
  for (const v of [-1, '', null, '1e2', 'NaN', Infinity, [], true, '1.001', '1001']) assert.throws(() => pricing.validateMarkup({ markupPercent: v }), { code: 'INVALID_MARKUP' });
  assert.throws(() => pricing.validateMarkup({ markupFixedSyp: '1000000001' }), { code: 'INVALID_MARKUP' });
  assert.throws(() => pricing.calculate('0', 1, 1, { markupFixedSyp: '5' }), { code: 'INVALID_PRICING' });
});

test('purchase integration on an isolated replica set (no live provider orders)', { timeout: 420000 }, async (t) => {
  process.env.ALRAGHEB_PURCHASE_ENABLED = 'true';
  process.env.ALRAGHEB_ROUNDING_POLICY = 'syp_2dp';
  process.env.ALRAGHEB_CATALOG_ENABLED = 'true';
  const external = process.env.ALRAGHEB_TEST_MONGO_URI;
  const dbName = `alragheb_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  let db;
  t.after(async () => {
    try {
      if (mongoose.connection.readyState === 1 && mongoose.connection.name === dbName) {
        for (const model of [User, Payment, Quote, Config, Transaction, Audit, PricingBatch, PricingRule, DailyStats, Balance, Point]) await model.deleteMany({});
      }
    } finally {
      await mongoose.disconnect();
      if (db) await db.stop();
    }
  });
  if (!external) db = await MongoMemoryReplSet.create({ binary: { version: '7.0.34' }, replSet: { count: 1 }, instanceOpts: [{ ip: '127.0.0.1' }] });
  await mongoose.connect(external || db.getUri(), { dbName, serverSelectionTimeoutMS: 15000 });
  assert.equal(mongoose.connection.name, dbName);
  for (const model of [User, Payment, Quote, Config, Transaction, Audit, PricingBatch, PricingRule, DailyStats, Balance, Point]) await model.init();
  async function fixture(balance = 1000) {
    for (const model of [User, Payment, Quote, Config, Transaction, Audit, PricingBatch, PricingRule, DailyStats, Balance, Point]) await model.deleteMany({});
    const user = await User.create({ email: 'buyer@example.invalid', balance, role: 'user' });
    const other = await User.create({ email: 'other@example.invalid', balance: 1000, role: 'user' });
    const raw = { id: 57, name: 'Test chat', parent_id: 1, params: ['Account ID'], product_type: 'amount', available: true,
      qty_values: { min: 1000, max: 10000 }, price: '0.2', base_price: '101' };
    let outcome = 'accept';
    let checking = 'accept';
    const calls = [];
    const dependencies = { readCatalog: async () => ({ products: [catalog.normalizeProduct(raw, 1)], categories: [{ id: 1, parent_id: 0, name: 'Chat' }] }), client: {
      getProduct: async () => raw,
      newOrder: async (id, qty, params, uuid) => { calls.push({ id, qty, params, uuid }); if (outcome === 'timeout') throw new Error('simulated network interruption');
        return { status: 'OK', data: { order_id: 'provider-1', status: outcome, price: '500', replay_api: ['Delivered'] } }; },
      checkOrder: async () => ({ status: 'OK', data: checking === 'empty' ? [] : [{ order_id: 'provider-1', status: checking, price: '500' }] }),
    } };
    const service = createOrderService(dependencies);
    await service.saveConfig(user._id, 57, { purchaseEnabled: true, billingUnitQty: 1, fieldSchema: [{ key: 'playerId', required: true }], note: 'Isolated provider contract', revision: 0 });
    const quote = () => service.createQuote(String(user._id), { product_id: 57, qty: 2500, params: { playerId: '001234' } });
    const buy = async (q, id = randomUUID()) => service.submit(String(user._id), { quote_id: q.quote_id, client_request_id: id });
    return { service, restart: () => createOrderService(dependencies), user, other, raw, calls, quote, buy, outcome: (v) => { outcome = v; }, checking: (v) => { checking = v; }, balance: async () => (await User.findById(user._id)).balance };
  }
  await t.test('quote and successful order preserve price, quantity, account and one debit', async () => {
    const f = await fixture(); const q = await f.quote();
    assert.equal(q.currency, 'SYP'); assert.equal(q.total_amount_syp, '500.00');
    const result = await f.buy(q);
    assert.equal(result.status, 'completed'); assert.equal(await f.balance(), 500);
    assert.equal(f.calls[0].params.playerId, '001234'); assert.equal(f.calls[0].qty, 2500);
    const payment = await Payment.findById(result.payment_id);
    assert.equal(payment.calculatedAmount, 500); assert.equal(payment.status, 'تم التسديد');
    assert.equal((await DailyStats.findOne()).payments.total.count, 1);
  });
  await t.test('parallel duplicate clicks and retry after quote expiry never duplicate debit/order', async () => {
    const f = await fixture(); const q = await f.quote(); const id = randomUUID();
    const results = await Promise.all([f.buy(q, id), f.buy(q, id)]);
    assert.equal(results[0].transaction_id, results[1].transaction_id);
    await Quote.deleteMany({});
    assert.equal((await f.buy(q, id)).transaction_id, results[0].transaction_id);
    assert.equal(f.calls.length, 1); assert.equal(await f.balance(), 500); assert.equal(await Payment.countDocuments(), 1);
  });
  await t.test('two request keys cannot consume the same quote', async () => {
    const f = await fixture(); const q = await f.quote();
    const results = await Promise.allSettled([f.buy(q), f.buy(q)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await f.balance(), 500); assert.equal(f.calls.length, 1);
  });
  await t.test('same request key for another quote is rejected', async () => {
    const f = await fixture(); const id = randomUUID(); await f.buy(await f.quote(), id);
    await assert.rejects(f.buy(await f.quote(), id), { code: 'IDEMPOTENCY_CONFLICT' });
  });
  await t.test('concurrent purchases cannot overdraw the wallet', async () => {
    const f = await fixture(500); const a = await f.quote(); const b = await f.quote();
    const results = await Promise.allSettled([f.buy(a), f.buy(b)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(await f.balance(), 0); assert.equal(await Transaction.countDocuments(), 1);
  });
  await t.test('changed price is rejected without debit or provider request', async () => {
    const f = await fixture(); const q = await f.quote(); f.raw.price = '0.3';
    await assert.rejects(f.buy(q), { code: 'QUOTE_CHANGED' }); assert.equal(await f.balance(), 1000); assert.equal(f.calls.length, 0);
  });
  await t.test('unavailable product and changed field contract are rejected', async () => {
    const f = await fixture(); const q = await f.quote(); f.raw.available = false;
    await assert.rejects(f.buy(q), { code: 'PRODUCT_UNAVAILABLE' }); f.raw.available = true; f.raw.params.push('Server');
    await assert.rejects(f.buy(q), { code: 'PRODUCT_NOT_CONFIGURED' }); assert.equal(await f.balance(), 1000);
  });
  await t.test('expired/foreign quotes and reserved fields are rejected', async () => {
    const f = await fixture(); const q = await f.quote();
    await assert.rejects(f.service.submit(String(f.other._id), { quote_id: q.quote_id, client_request_id: randomUUID() }), { code: 'QUOTE_EXPIRED' });
    await Quote.updateOne({ _id: q.quote_id }, { expiresAt: new Date(Date.now() - 1000) });
    await assert.rejects(f.buy(q), { code: 'QUOTE_EXPIRED' });
    await assert.rejects(f.service.createQuote(String(f.user._id), { product_id: 57, qty: 2500, params: { playerId: '0', order_uuid: 'injected' } }), { code: 'INVALID_FIELDS' });
  });
  await t.test('timeout and empty check retain debit, later acceptance completes same UUID', async () => {
    const f = await fixture(); f.outcome('timeout'); const result = await f.buy(await f.quote());
    assert.equal(result.status, 'pending'); f.checking('empty'); await f.service.processOrder(result.transaction_id);
    assert.equal(await f.balance(), 500); assert.equal((await Transaction.findById(result.transaction_id)).status, 'pending');
    f.checking('accept'); await f.service.processOrder(result.transaction_id);
    assert.equal((await Transaction.findById(result.transaction_id)).status, 'completed'); assert.equal(f.calls.length, 1);
  });
  await t.test('wait then reject refunds once under concurrent workers', async () => {
    const f = await fixture(); f.outcome('wait'); const result = await f.buy(await f.quote());
    f.checking('reject'); await Promise.all([f.service.processOrder(result.transaction_id), f.service.processOrder(result.transaction_id)]);
    await f.service.processOrder(result.transaction_id);
    assert.equal(await f.balance(), 1000); assert.equal((await Transaction.findById(result.transaction_id)).status, 'refunded');
    assert.equal((await Payment.findById(result.payment_id)).status, 'غير مسددة');
  });
  await t.test('instant rejection refunds exactly the originally charged SYP total', async () => {
    const f = await fixture(); f.outcome('reject'); const result = await f.buy(await f.quote());
    assert.equal(result.refunded_amount_syp, '500.00'); assert.equal(await f.balance(), 1000);
  });
  await t.test('existing history and pending settlement work with new purchasing disabled', async () => {
    const f = await fixture(); f.outcome('wait'); const q = await f.quote(); const id = randomUUID(); const result = await f.buy(q, id);
    process.env.ALRAGHEB_PURCHASE_ENABLED = 'false';
    try {
      assert.equal((await f.buy(q, id)).transaction_id, result.transaction_id);
      await f.service.processOrder(result.transaction_id);
      assert.equal((await f.service.getOrder(String(f.user._id), result.transaction_id)).status, 'completed');
      await assert.rejects(f.service.getOrder(String(f.other._id), result.transaction_id), { status: 404 });
      await assert.rejects(f.quote(), { code: 'PURCHASE_DISABLED' });
    } finally { process.env.ALRAGHEB_PURCHASE_ENABLED = 'true'; }
  });
  await t.test('configuration edits are audited and reject stale revisions', async () => {
    const f = await fixture(); const body = { purchaseEnabled: false, billingUnitQty: 1, fieldSchema: [{ key: 'playerId', required: true }], note: 'Reviewed configuration', revision: 1 };
    await f.service.saveConfig(f.user._id, 57, body);
    await assert.rejects(f.service.saveConfig(f.user._id, 57, body), { code: 'CONFIG_CHANGED' });
    assert.equal(await Audit.countDocuments(), 2);
    const decorated = await f.service.decorateProducts([catalog.normalizeProduct(f.raw, 1)]);
    assert.equal(decorated[0].pricing_preview.total_amount_syp, '200.00'); assert.equal(decorated[0].purchasable, false);
    assert.equal(Object.hasOwn(decorated[0], 'provider_base_price'), false);
  });
  await t.test('payment insert failure rolls back debit, quote consumption and transaction', async (t) => {
    const f = await fixture(); const q = await f.quote();
    t.mock.method(Payment, 'create', async () => { throw new Error('Simulated database write failure'); });
    await assert.rejects(f.buy(q));
    assert.equal(await f.balance(), 1000); assert.equal(await Transaction.countDocuments(), 0);
    assert.equal((await Quote.findById(q.quote_id)).usedAt, undefined); assert.equal(f.calls.length, 0);
  });
  await t.test('failed refund is retried without marking payment refunded early', async (t) => {
    const f = await fixture(); f.outcome('reject');
    const original = User.updateOne;
    const mocked = t.mock.method(User, 'updateOne', function(filter, update, options) {
      if (Array.isArray(update)) throw new Error('Simulated refund write failure');
      return original.call(this, filter, update, options);
    });
    const result = await f.buy(await f.quote());
    assert.equal(result.status, 'pending'); assert.equal(await f.balance(), 500);
    mocked.mock.restore(); f.checking('reject'); await f.service.processOrder(result.transaction_id);
    assert.equal(await f.balance(), 1000); assert.equal((await Transaction.findById(result.transaction_id)).status, 'refunded');
  });
  await t.test('new service instance recovers persisted pending order without resending it', async () => {
    const f = await fixture(); f.outcome('timeout'); const result = await f.buy(await f.quote());
    await Transaction.updateOne({ _id: result.transaction_id }, { nextCheckAt: new Date(0), leaseUntil: new Date(0) });
    const restarted = f.restart(); await restarted.reconcile();
    assert.equal((await restarted.getOrder(String(f.user._id), result.transaction_id)).status, 'completed');
    assert.equal(f.calls.length, 1); assert.equal(await f.balance(), 500);
  });
  await t.test('legacy wallet credit concurrent with provider purchase is not overwritten', async () => {
    const f = await fixture(); const q = await f.quote();
    const balance = await Balance.create({ user: f.user._id, name: f.user.email, amount: 250, isConfirmed: false });
    const { confirmPaymentService } = require('../services/payments.services');
    await Promise.all([f.buy(q), confirmPaymentService({ id: String(balance._id), amount: 250 })]);
    assert.equal(await f.balance(), 750);
  });
  const serve = async (t, path, router) => {
    const app = require('express')(); app.use(require('express').json()); app.use(path, router);
    const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    return `http://127.0.0.1:${server.address().port}`;
  };
  await t.test('legacy payment and provider purchase debit the shared wallet without lost updates', async (t) => {
    const f = await fixture(); const q = await f.quote();
    process.env.JWT_SECRET = 'isolated-shared-wallet-test';
    const url = await serve(t, '/payment', require('../routes/paymentRoutes'));
    const token = require('jsonwebtoken').sign({ id: String(f.user._id), role: 'user' }, process.env.JWT_SECRET);
    const [result, response] = await Promise.all([f.buy(q), fetch(`${url}/payment/internet-full`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ landline: '001122', company: 'test-company', speed: 'test', email: f.user.email, amount: 250, calculatedAmount: 250, paymentType: 'cash' }),
    })]);
    assert.equal(result.status, 'completed'); assert.ok(response.ok); assert.equal(await f.balance(), 250);
    assert.equal(await Payment.countDocuments(), 2);
  });
  await t.test('point transfer remains atomic alongside a provider purchase', async (t) => {
    const f = await fixture(); const q = await f.quote();
    const point = await Point.create({ username: f.other.email, owner: 'test', email: f.user.email, balance: 0 });
    await Balance.create({ user: f.user._id, amountDaen: 0, amount: 0 });
    const url = await serve(t, '/point', require('../routes/point'));
    const [result, response] = await Promise.all([f.buy(q), fetch(`${url}/point/add-balance/${point._id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 250, email: f.user.email, username: f.other.email, owner: 'test' }),
    })]);
    assert.equal(result.status, 'completed'); assert.ok(response.ok); assert.equal(await f.balance(), 250);
    assert.equal((await User.findById(f.other._id)).balance, 1250);
    assert.equal((await Point.findById(point._id)).balance, 250);
  });
  await t.test('screenshot price, fractional debit and refund use the same two decimal total', async () => {
    const f = await fixture(); f.raw.price = '0.23977917611178512';
    const q = await f.service.createQuote(String(f.user._id), { product_id: 57, qty: 2000, params: { playerId: 'test-only' } });
    assert.equal(q.total_amount_syp, '479.56'); assert.equal(q.rounding_policy, 'syp_2dp');
    f.outcome('wait'); const result = await f.buy(q);
    assert.equal(await f.balance(), 520.44);
    assert.equal((await Payment.findById(result.payment_id)).amount, 479.56);
    f.checking('reject'); await f.service.processOrder(result.transaction_id);
    assert.equal(await f.balance(), 1000);
    assert.equal((await f.service.getOrder(String(f.user._id), result.transaction_id)).refunded_amount_syp, '479.56');
  });
  await t.test('quotes always fetch the selected product price and preserve its independent configuration', async () => {
    const f = await fixture(); const second = { ...f.raw, id: 58, price: '0.23977917611178512', name: 'Second chat' };
    const service = createOrderService({ readCatalog: async () => ({ products: [f.raw, second].map(p => catalog.normalizeProduct(p, 1)) }),
      client: { getProduct: async (id) => id === 57 ? f.raw : second } });
    await service.saveConfig(f.user._id, 58, { purchaseEnabled: true, billingUnitQty: 1, fieldSchema: [{ key: 'playerId', required: true }], note: 'Independent app pricing test', revision: 0 });
    const quoteFor = (id) => service.createQuote(String(f.user._id), { product_id: id, qty: 2000, params: { playerId: 'test-only' }, price: '0.01' });
    assert.equal((await quoteFor(57)).total_amount_syp, '400.00');
    assert.equal((await quoteFor(58)).total_amount_syp, '479.56');
    second.price = '0.3';
    assert.equal((await quoteFor(58)).total_amount_syp, '600.00');
    assert.equal((await quoteFor(57)).total_amount_syp, '400.00');
  });
  await t.test('repeated fractional charges do not accumulate binary wallet drift', async () => {
    const f = await fixture(1); f.raw.price = '0.00004';
    for (let i = 0; i < 3; i++) await f.buy(await f.quote());
    assert.equal(await f.balance(), 0.7);
    const q = await f.quote(); f.outcome('reject'); await f.buy(q);
    assert.equal(await f.balance(), 0.7);
  });
  await t.test('a quote from the previous rounding policy cannot charge the wallet', async () => {
    const f = await fixture(); const q = await f.quote();
    await Quote.updateOne({ _id: q.quote_id }, { $unset: { roundingPolicy: 1 } });
    await assert.rejects(f.buy(q), { code: 'QUOTE_CHANGED' });
    assert.equal(await f.balance(), 1000); assert.equal(f.calls.length, 0);
  });
  await t.test('markup quote equals displayed sale and wallet debit; margins remain admin-only', async () => {
    const f = await fixture(); const old = await f.quote();
    const config = await Config.findOne({ productId: 57 }).lean();
    await f.service.saveConfig(f.user._id, 57, { ...config, markupPercent: '10', markupFixedSyp: '2.50', note: 'Profit test' });
    await assert.rejects(f.buy(old), { code: 'QUOTE_CHANGED' });
    const q = await f.quote(); assert.equal(q.total_amount_syp, '552.50'); assert.equal(q.price_per_billing_unit_syp, '0.22'); assert.equal(q.fixed_fee_syp, '2.5');
    const [product] = await f.service.decorateProducts([catalog.normalizeProduct(f.raw, 1)]);
    assert.equal(product.pricing_preview.total_amount_syp, '222.50'); assert.equal(product.config, undefined);
    const result = await f.buy(q); assert.equal(await f.balance(), 447.5); assert.equal(result.gross_profit_syp, undefined);
    const admin = await f.service.getOrder(String(f.user._id), result.transaction_id, true);
    assert.equal(admin.gross_profit_syp, '52.5'); assert.equal(admin.markup_percent, '10');
    assert.equal((await Payment.findById(result.payment_id)).amount, 552.5);
    const saved = await Config.findOne({ productId: 57 }).lean(); delete saved.markupPercent; delete saved.markupFixedSyp;
    const preserved = await f.service.saveConfig(f.user._id, 57, { ...saved, note: 'Legacy editor preserves markup' });
    assert.equal(preserved.markupPercent, '10'); assert.equal(preserved.markupFixedSyp, '2.5');
  });
  await t.test('pending rejection refunds original sale including markup after configuration changes', async () => {
    const f = await fixture();
    await Config.updateOne({ productId: 57 }, { markupPercent: '10', markupFixedSyp: '2.50' });
    f.outcome('wait'); const result = await f.buy(await f.quote());
    assert.equal(await f.balance(), 447.5);
    await Config.updateOne({ productId: 57 }, { markupPercent: '99', markupFixedSyp: '50', $inc: { revision: 1 } });
    f.checking('reject'); await f.service.processOrder(result.transaction_id); await f.service.processOrder(result.transaction_id);
    const admin = await f.service.getOrder(String(f.user._id), result.transaction_id, true);
    assert.equal(await f.balance(), 1000); assert.equal(admin.refunded_amount_syp, '552.50'); assert.equal(admin.gross_profit_syp, '0'); assert.equal(admin.markup_percent, '10');
  });
  await t.test('bulk markup spans every page, preserves custom margins and disabled products, and audits once', async () => {
    const f = await fixture();
    const raw = Array.from({ length: 107 }, (_, i) => ({ ...f.raw, id: 1000 + i, name: `Bulk ${i}`, price: String((i + 1) / 10) }));
    const products = raw.map(p => catalog.normalizeProduct(p, 1));
    await Config.insertMany(products.slice(0, 106).map(p => ({ productId: p.id, purchaseEnabled: false, billingUnitQty: 1, fieldSchema: [{ key: 'playerId', label: 'Account ID', required: true }], contractHash: pricing.contractHash(p), note: 'Bulk fixture', markupPercent: p.id === 1000 ? '7' : '0' })));
    const service = createOrderService({ readCatalog: async () => ({ products, categories: [{ id: 1, parent_id: 0 }] }) });
    const preview = await service.previewMarkup(f.user._id, { scope: 'filtered', filters: { search: 'Bulk' }, onlyWithoutMarkup: true, markupPercent: '10', markupFixedSyp: '1.25' });
    assert.equal(preview.total, 107); assert.equal(preview.rows.length, 105); assert.equal(preview.skipped.length, 2);
    assert.equal((await Config.findOne({ productId: 1001 })).markupPercent, '0');
    assert.equal(preview.rows[0].new_total_syp, '221.25');
    const apply = { batch_id: preview.batch_id, note: 'Bulk margin approval' };
    await assert.rejects(service.applyMarkup(f.other._id, apply), { code: 'BATCH_EXPIRED' });
    assert.equal((await service.applyMarkup(f.user._id, apply)).updated, 105);
    assert.equal((await service.applyMarkup(f.user._id, apply)).already_applied, true);
    const config = await Config.findOne({ productId: 1105 });
    assert.equal(config.markupPercent, '10'); assert.equal(config.markupFixedSyp, '1.25'); assert.equal(config.purchaseEnabled, false); assert.equal(config.revision, 2);
    assert.equal((await Config.findOne({ productId: 1000 })).markupPercent, '7');
    assert.equal(await Audit.countDocuments(), 106);
    assert.equal(await f.balance(), 1000); assert.equal(f.calls.length, 0);
  });
  await t.test('bulk preview rejects price/revision changes, expired batches, and rolls back audit failures', async (t) => {
    const f = await fixture();
    const preview = () => f.service.previewMarkup(f.user._id, { scope: 'selected', productIds: [57], onlyWithoutMarkup: false, markupPercent: '5', markupFixedSyp: '0' });
    const apply = batch => f.service.applyMarkup(f.user._id, { batch_id: batch.batch_id, note: 'Checked bulk changes' });
    const stalePrice = await preview(); f.raw.price = '0.3';
    await assert.rejects(apply(stalePrice), { code: 'BATCH_CHANGED' }); f.raw.price = '0.2';
    const staleConfig = await preview(); await Config.updateOne({ productId: 57 }, { $inc: { revision: 1 } });
    await assert.rejects(apply(staleConfig), { code: 'CONFIG_CHANGED' });
    const expired = await preview(); await PricingBatch.updateOne({ _id: expired.batch_id }, { expiresAt: new Date(0) });
    await assert.rejects(apply(expired), { code: 'BATCH_EXPIRED' });
    const batch = await preview();
    const mock = t.mock.method(Audit, 'insertMany', async () => { throw new Error('Audit failure'); });
    await assert.rejects(apply(batch)); mock.mock.restore();
    assert.equal((await Config.findOne({ productId: 57 })).markupPercent, '0');
    assert.equal((await PricingBatch.findById(batch.batch_id)).usedAt, undefined);
    assert.equal((await apply(batch)).updated, 1);
  });
  await t.test('category pricing rules are saved and can prefill new product approvals', async () => {
    const f = await fixture();
    const rule = await f.service.savePricingRule(f.user._id, 1, { markupPercent: '5', markupFixedSyp: '0', note: 'Chat applications default profit' });
    assert.equal(rule.rule.markup_percent, '5');
    assert.equal(rule.product_count, 1);
    const listed = await f.service.listPricingRules();
    assert.equal(listed.categories.find((category) => category.id === 1).rule.markup_percent, '5');
    const raw = { ...f.raw, id: 58, name: 'New chat product', price: '100' };
    const service = createOrderService({ readCatalog: async () => ({ products: [f.raw, raw].map(p => catalog.normalizeProduct(p, 1)), categories: [{ id: 1, parent_id: 0, name: 'Chat' }] }),
      client: { getProduct: async (id) => id === 58 ? raw : f.raw } });
    await service.saveConfig(f.user._id, 58, { purchaseEnabled: true, billingUnitQty: 1, fieldSchema: [{ key: 'playerId', required: true }], note: 'Use category default', revision: 0, markupSource: 'category' });
    const config = await Config.findOne({ productId: 58 }).lean();
    assert.equal(config.markupPercent, '5');
    assert.equal(config.markupFixedSyp, '0');
    const [adminProduct] = await service.decorateProducts([catalog.normalizeProduct(raw, 1)], true, false, [{ id: 1, parent_id: 0, name: 'Chat' }]);
    assert.equal(adminProduct.category_pricing_rule.markup_percent, '5');
  });
});
