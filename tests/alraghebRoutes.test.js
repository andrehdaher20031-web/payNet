const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const catalog = require('../services/alraghebCatalog.service');
const provider = require('../services/alraghebApi');

test('authenticated catalog and admin routes enforce access and response boundaries', async (t) => {
  process.env.JWT_SECRET = 'alragheb-isolated-test-secret';
  delete process.env.ALRAGHEB_CATALOG_ENABLED;
  const userId = '507f1f77bcf86cd799439011';
  const disabledId = '507f1f77bcf86cd799439012';
  t.mock.method(User, 'findById', (id) => ({ select: () => ({ lean: async () => ({ role: 'user', card: { cardapplication: id !== disabledId } }) }) }));
  t.mock.method(catalog, 'getCatalog', async () => ({
    synced_at: new Date().toISOString(), categories: [{ id: 1, name: 'Chat', parent_id: 0 }],
    products: [{ id: 57, name: 'AHLAN', category_id: 1, available: true, params: [], quantity_rules: { mode: 'fixed', defaultQty: 1 }, provider_price: 2, provider_base_price: 1 }],
  }));
  t.mock.method(provider, 'getProfile', async () => ({ balance: '50', email: 'test@example.invalid', privateField: 'hidden' }));
  const app = express();
  app.use(express.json());
  app.use('/api/alragheb', require('../routes/alraghebRoutes'));
  app.use('/api/admin/alragheb', require('../routes/alraghebAdminRoutes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, role, id = userId) => fetch(base + path, { headers: role ? { Authorization: `Bearer ${jwt.sign({ id, role }, process.env.JWT_SECRET)}` } : {} });

  assert.equal((await get('/api/alragheb/products')).status, 401);
  assert.equal((await get('/api/alragheb/profile', 'user')).status, 403);
  assert.equal((await get('/api/admin/alragheb/products', 'user')).status, 403);
  for (const path of ['preview', 'apply']) {
    const response = await fetch(`${base}/api/admin/alragheb/pricing/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${jwt.sign({ id: userId, role: 'user' }, process.env.JWT_SECRET)}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403);
  }
  assert.equal((await get('/api/admin/alragheb/pricing/rules', 'user')).status, 403);
  assert.equal((await get('/api/alragheb/products', 'user', disabledId)).status, 403);
  const response = await get('/api/alragheb/products', 'user');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(Object.hasOwn((await response.json()).data[0], 'provider_price'), false);
  assert.equal((await (await get('/api/admin/alragheb/products', 'admin')).json()).data[0].provider_price, 2);
  assert.equal(Object.hasOwn((await (await get('/api/alragheb/profile', 'admin')).json()).data, 'privateField'), false);
  assert.equal((await get('/api/alragheb/products/999', 'user')).status, 404);
  assert.equal((await get('/api/alragheb/content/2', 'user')).status, 404);
  assert.equal((await get('/api/alragheb/products?limit=500', 'user')).status, 400);
  process.env.ALRAGHEB_CATALOG_ENABLED = 'false';
  assert.equal((await get('/api/alragheb/products', 'user')).status, 503);
});
