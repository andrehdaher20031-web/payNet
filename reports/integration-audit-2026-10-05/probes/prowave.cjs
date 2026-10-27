
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const workspace = process.argv[2] || 'C:/andreh/payNet-main';
const localRequire = createRequire(path.join(workspace, 'package.json'));
const source = fs.readFileSync(path.join(workspace, 'controllers', 'proWave.js'), 'utf8');
function block(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, 'Cannot find helper source boundaries');
  return source.slice(first, last);
}
function extract(parts, expression, globals = {}) {
  return vm.runInNewContext(parts.join('\n') + '\n' + expression, globals);
}
async function main() {
  const helpers = extract([
    block('const getFirstPresent =', 'const normalizeClientRequestId ='),
    block('const getInvoiceName =', 'const getProWaveTotalAmount ='),
    block('const normalizeStatusText =', 'const getDirectTopUpProviderPriceUsd ='),
  ], '({ getInvoiceName, isDirectTopUpCompletedResult })');
  const request = { name: 'DIRECT-TOPUP-AUDIT-TEST', recharge_status: 'New Request' };
  const derivedInvoice = helpers.getInvoiceName(request);
  const completed = helpers.isDirectTopUpCompletedResult({ rechargeStatus: request.recharge_status, invoiceName: derivedInvoice });
  assert.equal(derivedInvoice, request.name);
  assert.equal(completed, true);
  console.log('REPRODUCED pending_named_request_is_completed: New Request -> completed=true; invoice=request name');

  let claimCount = 0;
  let creditAttempts = 0;
  let creditedAmount = 0;
  const record = { _id: 'audit-order', user: 'audit-user', paynetAmountSyp: 150 };
  const model = {
    findOneAndUpdate: async () => { if (claimCount) return null; claimCount++; return { ...record, paynetRefundedAt: new Date(), paynetRefundedSyp: 150 }; },
    findById: async () => ({ ...record, paynetRefundedAt: claimCount ? new Date() : undefined }),
  };
  const user = { findByIdAndUpdate: async () => { creditAttempts++; throw new Error('simulated database credit failure'); } };
  const refund = extract([
    block('const refundPayNetBalanceForDirectTopUp =', 'const hasPayNetRefund ='),
  ], 'refundPayNetBalanceForDirectTopUp', { ProWaveTransaction: model, User: user, DIRECT_TOPUP_OPERATION: 'direct_topup' });
  await assert.rejects(refund(record), /simulated database credit failure/);
  const retry = await refund(record);
  assert.equal(claimCount, 1);
  assert.equal(creditAttempts, 1);
  assert.equal(creditedAmount, 0);
  assert.equal(retry.refunded, false);
  console.log('REPRODUCED refund_claim_blocks_retry: wallet credit failed; retry skipped; credited=0');

  const sanitize = extract([
    block('const CUSTOMER_HIDDEN_PAYMENT_EXTRA_KEYS =', 'const CUSTOMER_HIDDEN_TRANSACTION_KEYS ='),
    block('const sanitizePaymentForCustomer =', 'const sanitizeDirectTopUpRequestForCustomer ='),
  ], 'sanitizePaymentForCustomer', { isPlainObject: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value) });
  const sanitized = sanitize({ extra: {
    prowave_response: { provider_cost_usd: 1 },
    prowave_direct_topup_request: { name: 'audit-request', price: 1 },
    prowave_result_response: { message: { data: { price: 1 } } },
  } });
  assert.equal(sanitized.extra.prowave_response, undefined);
  assert.equal(sanitized.extra.prowave_direct_topup_request.price, 1);
  assert.equal(sanitized.extra.prowave_result_response.message.data.price, 1);
  console.log('REPRODUCED customer_sanitizer_leak: nested provider prices survive in two raw response fields');

  if (process.argv.includes('--skip-mongo')) return;
  const binary = path.join(os.tmpdir(), 'paynet-monitoring-mongo', '7.0.34', 'mongod.exe');
  assert(fs.existsSync(binary), 'Isolated MongoDB test binary is unavailable');
  const { MongoMemoryServer } = localRequire('mongodb-memory-server');
  const { MongoClient } = localRequire('mongodb');
  let server;
  let client;
  try {
    server = await MongoMemoryServer.create({ binary: { systemBinary: binary, version: '7.0.34' }, instance: { dbName: 'prowave_isolated_audit' } });
    const uri = server.getUri();
    assert(/^mongodb:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(uri), 'Only isolated loopback MongoDB is allowed');
    client = new MongoClient(uri);
    await client.connect();
    const collection = client.db('prowave_isolated_audit').collection('orders');
    const schema = localRequire('./models/ProWaveTransaction').schema;
    const compoundIndex = schema.indexes().find(([keys]) => keys.user && keys.operationType && keys.clientRequestId);
    assert(compoundIndex, 'Compound idempotency schema index missing');
    await collection.createIndex(compoundIndex[0], { unique: compoundIndex[1].unique, sparse: compoundIndex[1].sparse });
    await collection.insertOne({ user: 'synthetic-audit-user', operationType: 'digital_card' });
    await assert.rejects(collection.insertOne({ user: 'synthetic-audit-user', operationType: 'digital_card' }), (error) => error.code === 11000);
    console.log('REPRODUCED sparse_unique_index: second unkeyed digital-card order -> E11000 in isolated MongoDB 7.0.34');
  } finally {
    if (client) await client.close();
    if (server) await server.stop();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
