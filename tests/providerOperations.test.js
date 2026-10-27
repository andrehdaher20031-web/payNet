const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const operations = require('../services/providerOperations.service');
const Settings = require('../models/ProviderIntegrationSettings');
const Audit = require('../models/ProviderIntegrationAudit');
const Health = require('../models/ProviderWorkerHealth');
const User = require('../models/User');
const Alragheb = require('../models/AlraghebTransaction');
const ProWave = require('../models/ProWaveTransaction');

test('business day filters include Damascus midnight and reject impossible dates', () => {
  assert.equal(operations.dayBoundary('2026-10-05').toISOString(), '2026-10-04T21:00:00.000Z');
  assert.equal(operations.dayBoundary('2026-10-05', true).toISOString(), '2026-10-05T21:00:00.000Z');
  assert.throws(() => operations.dayBoundary('2026-02-30'), { code: 'INVALID_QUERY' });
});
test('dashboard reports realized profit only after confirmed completion and never retains refunded estimated profit', () => {
  const row = { _id: 'fixture', user: 'fixture-user', paynetAmountSyp: 500, profitSyp: 999, actualCostSyp: 400 };
  assert.equal(operations.normalizeTransaction('prowave', { ...row, status: 'refunded' }).gross_profit_syp, '0');
  for (const status of ['pending', 'unknown', 'manual_review', 'failed']) assert.equal(operations.normalizeTransaction('prowave', { ...row, status }).gross_profit_syp, null);
  assert.equal(operations.normalizeTransaction('prowave', { ...row, status: 'completed', actualCostSyp: undefined }).gross_profit_syp, null);
  assert.equal(operations.normalizeTransaction('prowave', { ...row, status: 'completed' }).gross_profit_syp, '100');
});

test('persistent provider controls, audit, health, privacy and permissions on an isolated replica set', { timeout: 180000 }, async (t) => {
  const dbName = `provider_ops_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const binary = { version: '7.0.34', ...(process.env.MONGOMS_SYSTEM_BINARY ? { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } : {}) };
  const db = await MongoMemoryReplSet.create({ binary, replSet: { count: 1 }, instanceOpts: [{ ip: '127.0.0.1' }] });
  const models = [Settings, Audit, Health, User, Alragheb, ProWave];
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    try {
      if (mongoose.connection.name === dbName && /^provider_ops_test_[a-f0-9]+$/.test(dbName)) await mongoose.connection.dropDatabase();
    } finally { await mongoose.disconnect(); await db.stop(); }
  });
  await mongoose.connect(db.getUri(), { dbName });
  for (const model of models) await model.init();
  const admin = await User.create({ email: 'admin@provider-test.invalid', role: 'admin' });
  const buyer = await User.create({ email: 'buyer@provider-test.invalid', name: 'Customer', role: 'user' });
  let balanceCalls = 0;
  const service = operations.createProviderOperationsService({ balanceReaders: {
    alragheb: async () => { balanceCalls++; return { amount: '50.25', currency: 'SYP' }; },
    prowave: async () => ({ amount: '11.50', currency: 'USD' }),
  } });
  await t.test('a durable stop is audited and rejects stale editor revisions', async () => {
    assert.equal((await service.getSettings('alragheb')).revision, 0);
    const stopped = await service.saveSettings('alragheb', admin._id, { revision: 0, purchaseEnabled: false, lowBalanceThreshold: '100', reviewAfterMinutes: 10, note: 'Maintenance stop for provider review' });
    assert.equal(stopped.purchaseEnabled, false); assert.equal(stopped.revision, 1);
    await assert.rejects(service.assertPurchasingAllowed('alragheb'), { code: 'PURCHASE_DISABLED' });
    await assert.rejects(service.saveSettings('alragheb', admin._id, { revision: 0, purchaseEnabled: true, note: 'Outdated editor save' }), { code: 'SETTINGS_CHANGED' });
    assert.equal(await Audit.countDocuments({ action: 'settings_updated' }), 1);
    assert.equal((await operations.getSettings('alragheb')).purchaseEnabled, false);
    await service.saveSettings('alragheb', admin._id, { revision: 1, purchaseEnabled: true, note: 'Provider maintenance completed' });
    await service.assertPurchasingAllowed('alragheb');
  });
  await t.test('audit write failure rolls back the settings change', async (t) => {
    const before = await service.getSettings('alragheb');
    const mock = t.mock.method(Audit, 'create', async () => { throw new Error('simulated audit write failure'); });
    await assert.rejects(service.saveSettings('alragheb', admin._id, { revision: before.revision, purchaseEnabled: false, note: 'Audited maintenance pause' }));
    mock.mock.restore();
    assert.equal((await service.getSettings('alragheb')).purchaseEnabled, true);
    assert.equal((await service.getSettings('alragheb')).revision, before.revision);
  });
  await t.test('operation audit keeps review evidence but excludes credentials and purchased codes', async () => {
    const audit = await service.recordAudit({ provider: 'alragheb', actor: admin._id, action: 'audit_privacy_check', note: 'Verified provider evidence privacy',
      before: { status: 'unknown', rawProviderResponse: { token: 'private-token' } }, after: { status: 'completed', digital_codes: ['private-code'] },
      evidence: { providerReference: 'provider-ref', source: 'provider_support', ticketReference: 'support-ref', apiToken: 'private-token' } });
    const serialized = JSON.stringify(audit.toObject());
    assert.equal(serialized.includes('private-token'), false); assert.equal(serialized.includes('private-code'), false); assert.ok(serialized.includes('support-ref'));
  });
  await t.test('worker health and balance are persisted, deduplicated and produce actionable alerts', async () => {
    await service.recordWorkerHeartbeat('alragheb', { state: 'started' });
    await service.recordWorkerHeartbeat('alragheb', { state: 'succeeded', processed: 3 });
    const states = await Promise.all([service.getProviderHealth('alragheb'), service.getProviderHealth('alragheb')]);
    assert.equal(balanceCalls, 1); assert.equal(states[0].balance.amount, '50.25');
    assert.equal(states[0].worker.stale, false); assert.equal(states[0].worker.lastProcessed, 3);
    assert.ok(states[0].alerts.some((alert) => alert.code === 'LOW_BALANCE'));
    await service.getProviderHealth('alragheb'); assert.equal(balanceCalls, 1);
    await service.recordWorkerHeartbeat('alragheb', { state: 'failed', errorCode: 'PROVIDER_TIMEOUT' });
    assert.equal((await Health.findOne({ provider: 'alragheb' })).consecutiveFailures, 1);
  });
  const alraghebId = new mongoose.Types.ObjectId();
  await Alragheb.collection.insertOne({ _id: alraghebId, user: buyer._id, payment: new mongoose.Types.ObjectId(), quote: new mongoose.Types.ObjectId(),
    orderUuid: randomUUID(), clientRequestId: randomUUID(), productId: 57, productName: 'Reviewed application', totalSyp: '500.00', status: 'manual_review', phase: 'checking',
    params: { playerId: 'private-account-value' }, result: 'private-delivery-value', createdAt: new Date('2026-10-04T22:00:00Z'), updatedAt: new Date(), errorHistory: [{ code: 'PROVIDER_TIMEOUT', at: new Date() }] });
  await ProWave.collection.insertOne({ _id: new mongoose.Types.ObjectId(), user: buyer._id, userEmail: buyer.email, itemCode: 'item1', itemName: 'Reviewed completed card',
    paynetAmountSyp: 20, status: 'completed', internalReviewStatus: 'needs_review', invoiceMatchStatus: 'mismatch', rawCodesResponse: { codes: ['private-code'] }, createdAt: new Date(), updatedAt: new Date() });
  await t.test('review filters include completed mismatches and summaries never export private fulfillment', async () => {
    const cards = await service.listTransactions('prowave', { review: 'true' }); assert.equal(cards.meta.total, 1); assert.equal(cards.data[0].review, true);
    const orders = await service.listTransactions('alragheb', { from: '2026-10-05', to: '2026-10-05', search: buyer.email });
    assert.equal(orders.meta.total, 1); assert.equal(orders.data[0].user_email, buyer.email);
    assert.equal(JSON.stringify(orders).includes('private-account-value'), false); assert.equal(JSON.stringify(orders).includes('private-delivery-value'), false);
    const exported = await service.listTransactions('alragheb', {}, true); assert.equal(exported.meta.truncated, false); assert.equal(exported.data[0].result, undefined);
    assert.equal((await service.transactionDetail('alragheb', String(alraghebId))).result, 'private-delivery-value');
    assert.ok((await service.getProviderHealth('alragheb')).alerts.some((alert) => alert.code === 'ORDERS_NEED_REVIEW'));
    await ProWave.updateMany({}, { $set: { internalReviewStatus: 'clear', reviewResolvedAt: new Date() } });
    assert.equal((await service.listTransactions('prowave', { review: 'true' })).meta.total, 0);
    await ProWave.updateMany({}, { $set: { internalReviewStatus: 'needs_review' } });
    assert.equal((await service.listTransactions('prowave', { review: 'true' })).meta.total, 1);
  });
  await t.test('generic dashboard routes deny anonymous users and a forged stale admin role', async (t) => {
    process.env.JWT_SECRET = 'isolated-provider-operations-test';
    t.mock.method(operations, 'overview', () => service.overview());
    const app = require('express')(); app.use(require('express').json());
    app.use('/api/admin/integrations', require('../routes/providerOperationsRoutes'));
    server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/admin/integrations`;
    const token = (user, role = user.role) => require('jsonwebtoken').sign({ id: user._id, role }, process.env.JWT_SECRET);
    assert.equal((await fetch(`${base}/overview`)).status, 401);
    assert.equal((await fetch(`${base}/overview`, { headers: { Authorization: `Bearer ${token(buyer, 'admin')}` } })).status, 403);
    const response = await fetch(`${base}/overview`, { headers: { Authorization: `Bearer ${token(admin)}` } });
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
    const body = await response.json(); assert.equal(body.data.providers.length, 2); assert.equal(body.data.providers[0].health.balance.currency, 'SYP');
  });
});
