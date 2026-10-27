'use strict';
// Audit-only reproduction: in-memory models and provider stubs; no dotenv,
// database connection, server listener, provider request, or production writes.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const projectRoot = path.resolve(process.argv[2] || 'C:/andreh/payNet-main');
const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
process.env.REDIS_URL = '';
const mongoose = projectRequire('mongoose');
assert.equal(mongoose.connection.readyState, 0, 'Audit must run without database connection');
mongoose.connect = async () => { throw new Error('Database access prohibited in audit'); };
mongoose.startSession = async () => { throw new Error('Database access prohibited in audit'); };
const Transaction = projectRequire('./models/AlraghebTransaction');
const { createOrderService } = projectRequire('./services/alraghebOrder.service');
const originalMethods = { findOneAndUpdate: Transaction.findOneAndUpdate, updateOne: Transaction.updateOne };
let row;
let newCalls = 0;
let checkCalls = 0;
Transaction.findOneAndUpdate = (filter, change) => ({ lean: async () => {
  if (!row || filter._id !== row._id || row.status !== filter.status || row.leaseUntil > filter.leaseUntil.$lte) return null;
  Object.assign(row, change.$set || {});
  row.attempts += change.$inc?.attempts || 0;
  return { ...row };
} });
Transaction.updateOne = async (filter, change) => {
  if (filter._id !== row._id || (filter.status && filter.status !== row.status) || (filter.leaseToken && filter.leaseToken !== row.leaseToken)) return { matchedCount: 0 };
  Object.assign(row, change.$set || {});
  return { matchedCount: 1 };
};
const service = createOrderService({ client: {
  newOrder: async () => {
    newCalls++;
    throw Object.assign(new Error('Provider declined request before creating an order (stub)'), { status: 502, code: 'ALRAGHEB_PROVIDER_ERROR' });
  },
  checkOrder: async () => { checkCalls++; return { status: 'OK', data: [] }; }
} });
const initialRow = (phase, attempts = 0) => ({
  _id: 'audit-only', status: 'pending', phase, attempts,
  leaseUntil: new Date(0), nextCheckAt: new Date(0),
  totalSyp: '500.00', orderUuid: 'audit-only-provider-id', productId: 57, qty: 2500, params: { playerId: 'audit-only-account' }
});
const snapshot = (scenario) => ({ scenario, status: row.status, phase: row.phase, newCalls, checkCalls, attempts: row.attempts, lastError: row.lastError });
(async () => {
  row = initialRow('queued');
  for (let i = 0; i < 4; i++) await service.processOrder(row._id);
  assert.equal(row.status, 'pending'); assert.equal(row.phase, 'checking');
  assert.equal(newCalls, 1); assert.equal(checkCalls, 3); assert.equal(row.lastError, 'ORDER_UNCONFIRMED');
  console.log(JSON.stringify(snapshot('provider_rejection_before_order_created')));
  row = initialRow('sending', 1);
  newCalls = 0; checkCalls = 0;
  for (let i = 0; i < 3; i++) await service.processOrder(row._id);
  assert.equal(row.status, 'pending'); assert.equal(row.phase, 'checking');
  assert.equal(newCalls, 0); assert.equal(checkCalls, 3); assert.equal(row.lastError, 'ORDER_UNCONFIRMED');
  console.log(JSON.stringify(snapshot('crash_after_phase_sending_before_network_send')));
  assert.equal(mongoose.connection.readyState, 0);
  console.log(JSON.stringify({ passed: true, databaseConnections: 0, databaseWrites: 0, liveProviderCalls: 0, projectEdits: 0 }));
})().finally(() => Object.assign(Transaction, originalMethods)).catch(error => { console.error(error.message); process.exitCode = 1; });
