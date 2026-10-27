const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const protocol = require('../services/proWaveProtocol.service');
const ledger = require('../services/proWaveLedger.service');
const { createOrderService } = require('../services/proWaveOrder.service');
const Transaction = require('../models/ProWaveTransaction');
const Payment = require('../models/Payment');
const Quote = require('../models/ProWavePriceQuote');
const User = require('../models/User');
const Config = require('../models/ProWaveProductConfig');
const Audit = require('../models/ProviderIntegrationAudit');
const Settings = require('../models/ProviderIntegrationSettings');
const Health = require('../models/ProviderWorkerHealth');
const Stats = require('../models/DailyStats');
let database, buyer, admin;
const models = [Transaction, Payment, Quote, User, Config, Audit, Settings, Health, Stats];
before(async () => {
  const version = '7.0.34';
  const binary = path.join(os.tmpdir(), 'paynet-monitoring-mongo', version, 'mongod.exe');
  if (process.platform === 'win32') assert(fs.existsSync(binary), 'Prepare the isolated MongoDB test binary before running these tests');
  database = await MongoMemoryReplSet.create({ binary: { version, ...(process.platform === 'win32' ? { systemBinary: binary } : {}) }, replSet: { count: 1, storageEngine: 'wiredTiger', ip: '127.0.0.1' } });
  await mongoose.connect(database.getUri(), { dbName: 'prowave_test_' + randomUUID().replaceAll('-', ''), serverSelectionTimeoutMS: 10000 });
  await Promise.all(models.map((model) => model.init()));
});
after(async () => { await mongoose.disconnect(); if (database) await database.stop(); });
beforeEach(async () => {
  await Promise.all(models.map((model) => model.deleteMany({})));
  buyer = await User.create({ email: 'prowave-buyer@test.invalid', role: 'user', balance: 1000 });
  admin = await User.create({ email: 'prowave-admin@test.invalid', role: 'admin', balance: 0 });
});
const body = (extra = {}) => ({ client_request_id: randomUUID(), item_code: 'TEST-PACK', currency: 'USD', game: 'pubg', player_id: '123456', ...extra });
const context = (input) => ({ itemCode: input.itemCode, itemTitle: 'Test package', pricing: {
  totalAmountSyp: 150 * input.quantity, unitAmountSyp: 150, saleUnitPriceUsd: 1.5, unitPriceUsd: 1.5,
  providerUnitCostUsd: 1, providerDiscountUsd: 0.5, providerDiscountPercent: 33.3333,
  qty: input.quantity, exchangeRate: 100, marginPercent: 0, roundingStep: 1, productConfigRevision: 0,
} });
function client(overrides = {}) {
  return { purchase: async () => ({ message: { data: { name: 'REQUEST-' + randomUUID(), recharge_status: 'New Request' } } }),
    check: async (name) => ({ message: { data: { name, recharge_status: 'Completed', sales_invoice: 'INVOICE-' + name, amount: 1 } } }),
    getCodes: async () => ({ message: { data: { digital_codes: ['TEST-CODE'] } } }),
    getBalance: async () => ({ message: { data: { balance: 100 } } }), ...overrides };
}
const service = (api = client(), options = {}) => createOrderService({ client: api, readContext: async (input) => context(input), ...options });

test('pending named direct topup remains pending and request name is never treated as invoice', async () => {
  const result = await service().purchase(buyer._id, body(), 'direct_topup');
  assert.equal(result.status, 'pending'); assert.equal(result.payment_status, 'قيد التنفيذ'); assert.equal(result.sales_invoice, undefined);
  assert.equal((await User.findById(buyer._id)).balance, 850);
  const transaction = await Transaction.findById(result.transaction_id);
  assert.equal(transaction.prowaveInvoice, undefined); assert.equal(transaction.stage, 'checking');
  assert.equal(protocol.inspect({ name: 'TEST', recharge_status: 'Not Completed' }, 'direct_topup').completed, false);
  assert.equal(protocol.inspect({ name: 'TEST', recharge_status: 'Unsuccessful' }, 'direct_topup').completed, false);
});

test('same request concurrently reserves once; conflicting reuse is rejected', async () => {
  let purchases = 0;
  const orderService = service(client({ purchase: async () => { purchases++; return { name: 'CONCURRENT-REQUEST', recharge_status: 'New Request' }; } }));
  const input = body();
  const results = await Promise.all(Array.from({ length: 8 }, () => orderService.purchase(buyer._id, input, 'direct_topup')));
  assert.equal(purchases, 1); assert.equal(await Transaction.countDocuments(), 1); assert.equal(await Payment.countDocuments(), 1);
  assert.equal(new Set(results.map((row) => row.transaction_id)).size, 1); assert.equal((await User.findById(buyer._id)).balance, 850);
  await assert.rejects(orderService.purchase(buyer._id, { ...input, player_id: 'different-player' }, 'direct_topup'), (error) => error.code === 'REQUEST_ID_CONFLICT' && error.status === 409);
  await assert.rejects(orderService.purchase(buyer._id, { ...input, client_request_id: undefined }, 'direct_topup'), (error) => error.code === 'REQUEST_ID_REQUIRED');
});

test('network timeout retains reservation and retries do not resend', async () => {
  let purchases = 0;
  const orderService = service(client({ purchase: async () => { purchases++; throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); } }));
  const input = body();
  const first = await orderService.purchase(buyer._id, input, 'direct_topup');
  assert.equal(first.status, 'unknown'); assert.equal((await User.findById(buyer._id)).balance, 850);
  const second = await orderService.purchase(buyer._id, input, 'direct_topup');
  assert.equal(second.transaction_id, first.transaction_id); assert.equal(purchases, 1);
  await orderService.checkTransaction(first.transaction_id, { actorId: buyer._id });
  assert.equal(purchases, 1); assert.equal((await User.findById(buyer._id)).balance, 850);
  assert.equal((await Transaction.findById(first.transaction_id)).errorHistory.length >= 1, true);
});

test('refund wallet failure rolls back refund claim; subsequent check refunds exactly once', async () => {
  const orderService = service(client({ check: async (name) => ({ name, recharge_status: 'Rejected', rejection_reason: 'Invalid player' }) }));
  const result = await orderService.purchase(buyer._id, body(), 'direct_topup');
  const update = User.findByIdAndUpdate;
  User.findByIdAndUpdate = function (...args) {
    if (args[1]?.$inc?.balance > 0) throw new Error('simulated wallet credit failure');
    return update.apply(this, args);
  };
  try { await orderService.checkTransaction(result.transaction_id, { actorId: buyer._id }); }
  finally { User.findByIdAndUpdate = update; }
  assert.equal((await User.findById(buyer._id)).balance, 850);
  assert.equal((await Transaction.findById(result.transaction_id)).paynetRefundedAt, undefined);
  const refunded = await orderService.checkTransaction(result.transaction_id, { actorId: buyer._id });
  assert.equal(refunded.status, 'refunded'); assert.equal((await User.findById(buyer._id)).balance, 1000);
  await Promise.all(Array.from({ length: 5 }, () => orderService.checkTransaction(result.transaction_id, { actorId: buyer._id })));
  assert.equal((await User.findById(buyer._id)).balance, 1000);
});

test('delayed digital codes recover durably and completion requires enough codes', async () => {
  let checks = 0;
  const orderService = service(client({ purchase: async () => ({ sales_invoice: 'DIGITAL-INVOICE', total_amount: 2 }), getCodes: async () => ({ digital_codes: ++checks === 1 ? ['CODE-ONE'] : ['CODE-ONE', 'CODE-TWO'] }) }));
  const result = await orderService.purchase(buyer._id, body({ qty: 2 }), 'digital_card');
  assert.equal(result.status, 'delivery_pending'); assert.equal((await User.findById(buyer._id)).balance, 700);
  assert.equal((await orderService.checkTransaction(result.transaction_id, { actorId: buyer._id })).status, 'delivery_pending');
  const recovered = await orderService.checkTransaction(result.transaction_id, { actorId: buyer._id });
  assert.equal(recovered.status, 'completed'); assert.equal(recovered.digital_codes.length, 2);
  assert.equal((await Transaction.findById(result.transaction_id)).profitSyp, 100);
});

test('quote validation and insufficient funds leave quote unused with no orphan payment', async () => {
  const quote = await Quote.create({ user: buyer._id, itemCode: 'TEST-PACK', currency: 'USD', qty: 1, unitPriceUsd: 1.5, providerUnitCostUsd: 1, exchangeRate: 100, unitAmountSyp: 150, totalAmountSyp: 150, expiresAt: new Date(Date.now() + 60000) });
  await User.updateOne({ _id: buyer._id }, { $set: { balance: 100 } });
  await assert.rejects(service().purchase(buyer._id, body({ quote_id: String(quote._id) }), 'digital_card'), (error) => error.code === 'INSUFFICIENT_BALANCE');
  assert.equal((await Quote.findById(quote._id)).usedAt, undefined); assert.equal(await Payment.countDocuments(), 0); assert.equal(await Transaction.countDocuments(), 0);
  await assert.rejects(service().purchase(buyer._id, body({ paynet_amount_syp: 120 }), 'digital_card'), (error) => error.code === 'PRICE_CHANGED');
});

test('partial request index permits legacy missing keys and prevents duplicate nonempty keys', async () => {
  const legacy = { user: buyer._id, operationType: 'digital_card', itemCode: 'TEST', paynetAmountSyp: 1, unitPriceUsd: 1, expectedProviderDebitUsd: 1, exchangeRate: 100 };
  await Transaction.create([legacy, legacy]);
  await Transaction.create({ ...legacy, clientRequestId: 'unique-key' });
  await assert.rejects(Transaction.create({ ...legacy, clientRequestId: 'unique-key' }), (error) => error.code === 11000);
});

test('reconciliation preserves expected historic cost and separates realized profit from refund/pending amounts', async () => {
  const api = client({ purchase: async () => ({ sales_invoice: 'FINANCIAL-INVOICE', digital_codes: ['FINANCIAL-CODE'], total_amount: 1 }) });
  const completed = await service(api).purchase(buyer._id, body(), 'digital_card');
  const pending = await service().purchase(buyer._id, body(), 'direct_topup');
  await ledger.reconcileTransactionsWithInvoices({ invoices: [] }, { completeCoverage: false });
  assert.notEqual((await Transaction.findById(completed.transaction_id)).invoiceMatchStatus, 'missing');
  await ledger.reconcileTransactionsWithInvoices({ invoices: [{ name: 'FINANCIAL-INVOICE', grand_total: 2 }] }, { completeCoverage: true });
  const transaction = await Transaction.findById(completed.transaction_id);
  assert.equal(transaction.expectedProviderDebitUsd, 1); assert.equal(transaction.profitSyp, -50);
  const report = await ledger.getReconciliationReport();
  assert.equal(report.summary.paynetAmountSyp, 150); assert.equal(report.summary.reservedAmountSyp, 150); assert.equal(report.summary.profitSyp, -50);
  const reviews = await ledger.getReconciliationReport({ status: 'mismatch' });
  assert(reviews.transactions.some((row) => String(row._id) === completed.transaction_id));
  assert.equal((await Transaction.findById(pending.transaction_id)).status, 'pending');
});

test('customer serializers whitelist fields and reject nested supplier price/password/raw payloads', () => {
  const payment = protocol.customerPayment({ extra: { digital_codes: ['OWN-CODE'], provider: 'prowave', password: 'SECRET', prowave_direct_topup_request: { price: 1 }, prowave_result_response: { cost: 1 } } });
  assert.deepEqual(payment.extra, { provider: 'prowave', digital_codes: ['OWN-CODE'] });
  const transaction = protocol.customerTransaction({ _id: 'test', providerRequest: { password: 'secret' }, rawPurchaseResponse: { token: 'secret' }, providerUnitCostUsd: 1 });
  assert.equal(transaction.providerRequest, undefined); assert.equal(transaction.providerUnitCostUsd, undefined);
  assert.equal(ledger.extractProWaveBalanceUsd({ balance: null }), null);
});

test('manual support resolution is audited atomically and rejects stale revision/contrary provider evidence', async () => {
  const orderService = service(client({ purchase: async () => { throw new Error('timeout'); } }));
  const result = await orderService.purchase(buyer._id, body(), 'direct_topup');
  await Transaction.updateOne({ _id: result.transaction_id }, { $set: { status: 'manual_review' } });
  const current = await Transaction.findById(result.transaction_id);
  const evidence = { source: 'provider_support', ticketReference: 'TICKET-AUDIT', confirmedOutcome: 'rejected', checkedAt: new Date().toISOString() };
  await assert.rejects(orderService.resolveTransaction(result.transaction_id, { action: 'resolve_failed', actorId: admin._id, note: 'Provider confirmed no order', providerEvidence: evidence, revision: current.__v + 1 }), (error) => error.code === 'REVISION_CONFLICT');
  const refunded = await orderService.resolveTransaction(result.transaction_id, { action: 'resolve_failed', actorId: admin._id, note: 'Provider confirmed no order', providerEvidence: evidence, revision: current.__v });
  assert.equal(refunded.status, 'refunded'); assert.equal((await User.findById(buyer._id)).balance, 1000);
  assert.equal(await Audit.countDocuments({ action: 'resolve_failed', target: result.transaction_id }), 1);
});

test('manual settlement rolls back wallet credit when its audit insert fails', async () => {
  const orderService = service(client({ purchase: async () => { throw new Error('timeout'); } }));
  const result = await orderService.purchase(buyer._id, body(), 'direct_topup');
  await Transaction.updateOne({ _id: result.transaction_id }, { $set: { status: 'manual_review' } });
  const current = await Transaction.findById(result.transaction_id);
  const create = Audit.create;
  Audit.create = async () => { throw new Error('simulated audit failure'); };
  try {
    await assert.rejects(orderService.resolveTransaction(result.transaction_id, { action: 'resolve_failed', actorId: admin._id, note: 'Provider confirmed no order', revision: current.__v,
      providerEvidence: { source: 'provider_support', ticketReference: 'TICKET-FAIL', confirmedOutcome: 'rejected', checkedAt: new Date().toISOString() } }), /simulated audit failure/);
  } finally { Audit.create = create; }
  assert.equal((await User.findById(buyer._id)).balance, 850);
  assert.equal((await Transaction.findById(result.transaction_id)).paynetRefundedAt, undefined);
  assert.equal(await Audit.countDocuments(), 0);
});

test('durable worker escalates an expired sending lease without resubmitting the provider purchase', async () => {
  let purchases = 0;
  const orderService = service(client({ purchase: async () => { purchases++; throw new Error('timeout'); } }));
  const result = await orderService.purchase(buyer._id, body(), 'direct_topup');
  const old = new Date(Date.now() - 3600000);
  await Transaction.updateOne({ _id: result.transaction_id }, { $set: { status: 'pending', stage: 'sending', startedAt: old, nextCheckAt: old, leaseOwner: 'crashed-process', leaseUntil: old } });
  const resultTick = await orderService.tick();
  assert.equal(resultTick.count, 1); assert.equal(purchases, 1);
  const current = await Transaction.findById(result.transaction_id);
  assert.equal(current.status, 'manual_review'); assert.equal(current.internalReviewStatus, 'needs_review'); assert.equal(current.leaseOwner, undefined);
  assert.equal((await User.findById(buyer._id)).balance, 850);
});

test('product stop and revision changes block reservations; product update and audit commit together', async () => {
  const products = require('../services/proWaveProduct.service');
  const configured = await products.updateConfig('TEST-PACK', { operationType: 'digital_card', purchaseEnabled: false, revision: 0, note: 'Pause product for supplier review' }, admin._id);
  assert.equal(configured.revision, 1); assert.equal(await Audit.countDocuments({ action: 'product_config_updated' }), 1);
  await assert.rejects(service().purchase(buyer._id, body(), 'digital_card'), (error) => error.code === 'PRODUCT_DISABLED');
  await assert.rejects(products.updateConfig('TEST-PACK', { operationType: 'digital_card', purchaseEnabled: true, revision: 0, note: 'Stale product setting edit' }, admin._id), (error) => error.status === 409);
  assert.equal((await User.findById(buyer._id)).balance, 1000); assert.equal(await Payment.countDocuments(), 0);
});

test('public invoice/balance/code endpoints require authorization and codes require ownership', async () => {
  const express = require('express'), jwt = require('jsonwebtoken');
  process.env.JWT_SECRET = 'isolated-prowave-http-tests';
  const fulfilled = await service(client({ purchase: async () => ({ sales_invoice: 'OWNED-INVOICE', digital_codes: ['OWNED-CODE'], amount: 1 }) })).purchase(buyer._id, body(), 'digital_card');
  const stranger = await User.create({ email: 'stranger@test.invalid', role: 'user' });
  const app = express(); app.use(express.json()); app.use('/api/prowave', require('../routes/proWave'));
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (url, user) => fetch(base + '/api/prowave' + url, { headers: user ? { Authorization: 'Bearer ' + jwt.sign({ id: String(user._id), role: user.role, av: user.authVersion || 0 }, process.env.JWT_SECRET) } : {} });
  try {
    for (const url of ['/balance', '/invoices', '/codes?invoice_name=OWNED-INVOICE&item_code=TEST-PACK']) assert.equal((await request(url)).status, 401);
    assert.equal((await request('/invoices', buyer)).status, 403);
    assert.equal((await request('/codes?invoice_name=OWNED-INVOICE&item_code=TEST-PACK', stranger)).status, 403);
    const own = await request('/codes?invoice_name=OWNED-INVOICE&item_code=TEST-PACK', buyer);
    assert.equal(own.status, 200); assert.deepEqual((await own.json()).data.digital_codes, ['OWNED-CODE']);
    const attempt = await Transaction.findById(fulfilled.transaction_id);
    assert.equal((await request('/attempts/' + attempt.clientRequestId, stranger)).status, 404);
    assert.equal((await request('/attempts/' + attempt.clientRequestId, buyer)).status, 200);
  } finally { await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); }
});
