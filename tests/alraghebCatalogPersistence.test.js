const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Snapshot = require('../models/AlraghebCatalogSnapshot');
const snapshots = require('../services/alraghebCatalogSnapshot.service');
const { createCatalogService } = require('../services/alraghebCatalog.service');

test('catalog survives process-cache replacement without mixing provider accounts', { timeout: 120000 }, async (t) => {
  const oldToken = process.env.ALRAGHEB_API_TOKEN;
  process.env.ALRAGHEB_API_TOKEN = 'isolated-snapshot-account-a';
  const version = '7.0.34';
  let binary = process.env.MONGOMS_SYSTEM_BINARY || path.join(os.tmpdir(), 'paynet-monitoring-mongo', version, 'mongod.exe');
  if (!fs.existsSync(binary)) binary = process.platform === 'win32' ? await require('./helpers/monitoringMongo').windowsBinary(version) : undefined;
  const db = await MongoMemoryReplSet.create({ binary: { version, ...(binary ? { systemBinary: binary } : {}) }, replSet: { count: 1 }, instanceOpts: [{ ip: '127.0.0.1' }] });
  t.after(async () => {
    if (oldToken === undefined) delete process.env.ALRAGHEB_API_TOKEN; else process.env.ALRAGHEB_API_TOKEN = oldToken;
    await mongoose.disconnect();
    await db.stop();
  });
  const dbName = 'catalog_snapshot_test_' + randomUUID().replaceAll('-', '');
  await mongoose.connect(db.getUri(), { dbName });
  assert.equal(mongoose.connection.name, dbName);
  await Snapshot.init();
  const saved = {
    categories: [{ id: 1, parent_id: 0, name: 'Chat applications' }],
    products: [{ id: 57, category_id: 1, name: 'Test app', provider_price: '1.25' }],
    synced_at: new Date().toISOString(),
  };
  await snapshots.save(saved);
  assert.deepEqual(await snapshots.load(), saved);
  const service = createCatalogService({
    storage: { get: async () => null, set: async () => {} }, snapshots,
    client: { getContent: async () => { throw new Error('provider must not be called for a fresh persisted catalog'); } },
  });
  assert.deepEqual(await service.getCatalog(), saved);
  process.env.ALRAGHEB_API_TOKEN = 'isolated-snapshot-account-b';
  assert.equal(await snapshots.load(), null);
  await snapshots.save({ ...saved, products: [{ id: 58, name: 'Separate account product' }] });
  process.env.ALRAGHEB_API_TOKEN = 'isolated-snapshot-account-a';
  assert.deepEqual(await snapshots.load(), saved);
  const rows = await Snapshot.find({}).lean();
  assert.equal(rows.length, 2);
  assert.ok(!JSON.stringify(rows).includes('isolated-snapshot-account-'));
  await Snapshot.updateOne({ _id: snapshots.namespace() }, { $set: { version: 2 } });
  assert.equal(await snapshots.load(), null);
});
