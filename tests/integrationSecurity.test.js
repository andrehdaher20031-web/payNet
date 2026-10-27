const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const express = require('express');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { Server } = require('socket.io');
const http = require('node:http');
const User = require('../models/User');
const Balance = require('../models/Balance');
const Payment = require('../models/Payment');
const Adjustment = require('../models/WalletAdjustment');
const Stats = require('../models/DailyStats');
const { confirmPaymentService, refundManualPayment } = require('../services/payments.services');
const { authenticateToken } = require('../middleware/authMiddleware');

test('financial boundaries, current permissions and socket privacy on an isolated replica set', { timeout: 180000 }, async (t) => {
  process.env.JWT_SECRET = 'isolated-security-test-secret';
  process.env.REDIS_URL = '';
  const version = '7.0.34';
  let binary = process.env.MONGOMS_SYSTEM_BINARY || path.join(os.tmpdir(), 'paynet-monitoring-mongo', version, 'mongod.exe');
  if (!fs.existsSync(binary)) binary = process.platform === 'win32' ? await require('./helpers/monitoringMongo').windowsBinary(version) : undefined;
  const db = await MongoMemoryReplSet.create({ binary: { version, ...(binary ? { systemBinary: binary } : {}) }, replSet: { count: 1 }, instanceOpts: [{ ip: '127.0.0.1' }] });
  const dbName = 'security_test_' + randomUUID().replaceAll('-', '');
  await mongoose.connect(db.getUri(), { dbName });
  const models = [User, Balance, Payment, Adjustment, Stats];
  for (const model of models) await model.init();
  const app = express(); app.use(express.json());
  app.use('/api', require('../routes/authRoutes'));
  app.use('/api/admin', require('../routes/admin'));
  app.use('/api/prowave', require('../routes/proWave'));
  app.use('/api/saveBalance', require('../routes/saveBalance'));
  app.use('/api/point', require('../routes/point'));
  const server = http.createServer(app);
  const io = new Server(server);
  require('../services/socketSecurity.service').configureSocketSecurity(io);
  app.set('io', io); app.use((req, _res, next) => { req.io = io; next(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { await new Promise(resolve => io.close(resolve)); await mongoose.disconnect(); await db.stop(); });
  const admin = await User.create({ email: 'admin@security.invalid', role: 'admin', password: 'strong-admin-password', balance: 1000 });
  const owner = await User.create({ email: 'owner@security.invalid', role: 'user', password: 'strong-user-password', balance: 100 });
  const other = await User.create({ email: 'other@security.invalid', role: 'user', balance: 50 });
  const token = (user, overrides = {}) => jwt.sign({ id: String(user._id), email: user.email, role: user.role, av: user.authVersion || 0, ...overrides }, process.env.JWT_SECRET);
  const request = (url, user, method = 'GET', body) => fetch(base + url, { method, headers: { ...(user ? { Authorization: 'Bearer ' + token(user) } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  await t.test('anonymous administration and provider secrets are denied before any mutation', async () => {
    for (const [url, method] of [['/api/admin/confirm-payment', 'POST'], ['/api/admin/reject/' + owner._id, 'POST'], ['/api/admin/confirm/' + owner._id, 'PATCH'], ['/api/admin/start/' + owner._id, 'PATCH'], ['/api/admin/payment/' + owner._id, 'PUT'], ['/api/admin/delete/' + owner._id, 'DELETE'], ['/api/admin/user/allconfirmed', 'GET'], ['/api/saveBalance/all-admin', 'GET'], ['/api/point/add-balance/' + owner._id, 'PUT'], ['/api/prowave/codes', 'GET'], ['/api/prowave/invoices', 'GET'], ['/api/prowave/balance', 'GET']]) {
      assert.equal((await request(url, null, method, method === 'GET' ? undefined : {})).status, 401, url);
    }
    assert.equal((await User.findById(owner._id)).balance, 100);
  });

  await t.test('regular users and forged administrator claims cannot read administrator reports', async () => {
    for (const url of ['/api/admin/user/allconfirmed', '/api/admin/pending', '/api/admin/all-user', '/api/saveBalance/all-admin', '/api/prowave/invoices', '/api/prowave/balance']) assert.equal((await request(url, owner)).status, 403, url);
    const forged = await fetch(base + '/api/admin/all-user', { headers: { Authorization: 'Bearer ' + token(owner, { role: 'admin' }) } });
    assert.equal(forged.status, 403);
  });

  await t.test('concurrent confirmation credits the stored owner and amount exactly once', async () => {
    const deposit = await Balance.create({ user: owner._id, name: other.email, amount: 10.25 });
    const results = await Promise.all(Array.from({ length: 5 }, () => confirmPaymentService({ id: String(deposit._id), amount: 10.25, actorId: admin._id })));
    assert.equal(results.filter(r => !r.duplicate).length, 1);
    assert.equal((await User.findById(owner._id)).balance, 110.25);
    assert.equal((await User.findById(other._id)).balance, 50);
    assert.equal(await Adjustment.countDocuments({ key: 'deposit:' + deposit._id }), 1);
    assert.equal((await Balance.findById(deposit._id)).isConfirmed, true);
    await assert.rejects(confirmPaymentService({ id: String(deposit._id), amount: 9999 }), { code: 'AMOUNT_MISMATCH' });
  });

  await t.test('journal failure rolls back confirmation and wallet together; a retry then succeeds', async () => {
    const deposit = await Balance.create({ user: other._id, name: other.email, amount: 5 });
    const mocked = t.mock.method(Adjustment, 'create', async () => { throw new Error('simulated journal failure'); });
    await assert.rejects(confirmPaymentService({ id: String(deposit._id) }), /journal failure/);
    assert.equal((await Balance.findById(deposit._id)).isConfirmed, false);
    assert.equal((await User.findById(other._id)).balance, 50);
    mocked.mock.restore();
    await confirmPaymentService({ id: String(deposit._id) });
    assert.equal((await User.findById(other._id)).balance, 55);
  });

  await t.test('administrative cash credit retries are idempotent and editing account data cannot rewrite funds', async () => {
    const key = randomUUID();
    const body = { amount: 5.25, client_request_id: key };
    assert.equal((await request('/api/admin/addbatch/' + other._id, owner, 'PUT', body)).status, 403);
    assert.equal((await request('/api/admin/addbatch/' + other._id, admin, 'PUT', body)).status, 201);
    const retry = await request('/api/admin/addbatch/' + other._id, admin, 'PUT', body);
    assert.equal(retry.status, 200); assert.equal((await retry.json()).duplicate, true);
    assert.equal((await User.findById(other._id)).balance, 60.25);
    assert.equal((await request('/api/admin/addbatch/' + other._id, admin, 'PUT', { ...body, amount: 7 })).status, 409);
    assert.equal((await request('/api/admin/updateuser/' + other._id, admin, 'PUT', { name: 'Changed', balance: 100000 })).status, 400);
    assert.equal((await User.findById(other._id)).balance, 60.25);
  });

  await t.test('all provider payment types are immutable through manual refund/start/confirm', async () => {
    for (const provider of ['prowave', 'alragheb', 'aleso']) {
      const payment = await Payment.create({ user: owner._id, status: 'جاري التسديد', calculatedAmount: 20, extra: { provider, operation_type: 'digital_card' } });
      for (const [action, method] of [['reject', 'POST'], ['start', 'PATCH'], ['confirm', 'PATCH']]) assert.equal((await request('/api/admin/' + action + '/' + payment._id, admin, method, { reason: 'operator test', email: other.email })).status, 409);
    }
    assert.equal((await User.findById(owner._id)).balance, 110.25);
  });

  await t.test('manual refunds bind to owner and execute once even under concurrent requests', async () => {
    const payment = await Payment.create({ user: owner._id, status: 'جاري التسديد', calculatedAmount: 2.55 });
    const results = await Promise.all(Array.from({ length: 3 }, () => refundManualPayment({ id: String(payment._id), actorId: admin._id, reason: 'تعذر تنفيذ الطلب' })));
    assert.equal(results.filter(r => !r.duplicate).length, 1);
    assert.equal((await User.findById(owner._id)).balance, 112.8);
    assert.equal((await User.findById(other._id)).balance, 60.25);
    assert.equal((await Payment.findById(payment._id)).status, 'غير مسددة');
  });

  await t.test('manual rejection refunds the stored amount when calculatedAmount is missing or null', async () => {
    const customer = await User.create({ email: 'refund-fallback@security.invalid', role: 'user', balance: 25 });
    let expectedBalance = 25;
    for (const fields of [{ amount: 12.5 }, { amount: 7.25, calculatedAmount: null }]) {
      const payment = await Payment.create({ user: customer._id, email: customer.email, status: 'جاري التسديد', ...fields });
      const reject = () => request('/api/admin/reject/' + payment._id, admin, 'POST', {
        reason: 'Invalid account information', amount: 999999, email: other.email,
      });
      const results = await Promise.all(Array.from({ length: 3 }, reject));
      for (const result of results) assert.equal(result.status, 200);
      const responses = await Promise.all(results.map(result => result.json()));
      assert.equal(responses.filter(result => !result.duplicate).length, 1);
      expectedBalance += fields.amount;
      assert.equal((await User.findById(customer._id)).balance, expectedBalance);
      assert.equal((await User.findById(other._id)).balance, 60.25);
      const saved = await Payment.findById(payment._id);
      assert.equal(saved.status, 'غير مسددة');
      assert.equal(saved.extra.manual_refunded_syp, fields.amount.toFixed(2));
      const entries = await Adjustment.find({ key: 'manual-refund:' + payment._id }).lean();
      assert.equal(entries.length, 1);
      assert.equal(String(entries[0].user), String(customer._id));
      assert.equal(entries[0].amountSyp, fields.amount.toFixed(2));
    }
  });

  await t.test('manual refunds preserve the charged total and reject absent or invalid stored amounts', async () => {
    const customer = await User.create({ email: 'refund-total@security.invalid', role: 'user', balance: 10 });
    const charged = await Payment.create({ user: customer._id, amount: 99, calculatedAmount: 3.75, status: 'جاري التسديد' });
    const response = await request('/api/admin/reject/' + charged._id, admin, 'POST', { reason: 'Invalid account information', amount: 999999 });
    assert.equal(response.status, 200);
    assert.equal((await User.findById(customer._id)).balance, 13.75);
    for (const fields of [{}, { amount: 8, calculatedAmount: 0 }]) {
      const payment = await Payment.create({ user: customer._id, status: 'جاري التسديد', ...fields });
      const result = await request('/api/admin/reject/' + payment._id, admin, 'POST', { reason: 'Invalid account information', amount: 999999 });
      assert.equal(result.status, 400);
      assert.equal((await User.findById(customer._id)).balance, 13.75);
      assert.equal((await Payment.findById(payment._id)).status, 'جاري التسديد');
      assert.equal(await Adjustment.countDocuments({ key: 'manual-refund:' + payment._id }), 0);
    }
  });

  await t.test('customer history excludes other owners and raw supplier data but retains purchased codes', async () => {
    const chat = await Payment.create({ user: owner._id, company: 'Alragheb', speed: 'Alragheb Package', calculatedAmount: 1, status: 'تم التسديد', extra: { provider: 'alragheb', product_name: 'Package' } });
    await Payment.create({ user: owner._id, calculatedAmount: 1, status: 'تم التسديد', extra: { provider: 'prowave', digital_codes: ['OWNED-CODE'], prowave_response: { secret: 'SUPPLIER-PRIVATE' }, provider_unit_cost_usd: 0.1 } });
    await Payment.create({ user: other._id, calculatedAmount: 1, status: 'تم التسديد', extra: { digital_codes: ['OTHER-CODE'] } });
    const response = await request('/api/admin/user/confirmed', owner);
    assert.equal(response.status, 200); const body = await response.text();
    assert.match(body, /OWNED-CODE/); assert.doesNotMatch(body, /OTHER-CODE|SUPPLIER-PRIVATE|provider_unit_cost_usd/);
    const visible = JSON.parse(body).data.find((row) => String(row._id) === String(chat._id));
    assert.equal(visible.company, 'تطبيقات الدردشة');
    assert.equal(visible.operationType, 'تطبيقات الدردشة');
    assert.doesNotMatch(visible.speed, /alragheb/i);
    assert.equal((await Payment.findById(chat._id)).company, 'Alragheb');
  });

  await t.test('new passwords stay plain; old hashes migrate on login without revealing credentials', async () => {
    const stored = await User.findById(owner._id).select('+password +passwordHash').lean();
    assert.equal(stored.password, 'strong-user-password'); assert.equal(stored.passwordHash, undefined);
    const legacy = await User.create({ email: 'legacy@security.invalid', role: 'user' });
    const oldHash = await require('../utils/passwords').hashPassword('legacy-password');
    await User.collection.updateOne({ _id: legacy._id }, { $set: { passwordHash: oldHash, passwordScheme: 'scrypt' } });
    const response = await request('/api/login', null, 'POST', { email: legacy.email, password: 'legacy-password' });
    assert.equal(response.status, 200);
    const loginBody = await response.text();
    assert.doesNotMatch(loginBody, /legacy-password|passwordHash/);
    assert.equal((await authenticateToken(JSON.parse(loginBody).token)).email, legacy.email);
    const migrated = await User.findById(legacy._id).select('+password +passwordHash').lean();
    assert.equal(migrated.password, 'legacy-password'); assert.equal(migrated.passwordHash, undefined);
    await User.collection.updateOne({ _id: legacy._id }, { $set: { passwordHash: oldHash, passwordScheme: 'scrypt' }, $unset: { password: 1 } });
    const edited = await User.findById(legacy._id).select('+passwordHash +passwordScheme');
    edited.password = 'saved-password';
    await edited.save();
    const saved = await User.findById(legacy._id).select('+password +passwordHash +passwordScheme').lean();
    assert.equal(saved.password, 'saved-password'); assert.equal(saved.passwordHash, undefined); assert.equal(saved.passwordScheme, undefined);
  });

  await t.test('role removal and password changes immediately revoke privilege and old session versions', async () => {
    const old = token(admin);
    await User.updateOne({ _id: admin._id }, { $set: { role: 'user' } });
    const response = await fetch(base + '/api/admin/all-user', { headers: { Authorization: 'Bearer ' + old } });
    assert.equal(response.status, 403);
    await User.updateOne({ _id: admin._id }, { $set: { role: 'admin', password: 'replacement-password' } });
    const changed = await User.findById(admin._id).select('+password +passwordHash +passwordScheme').lean();
    assert.equal(changed.password, 'replacement-password'); assert.equal(changed.passwordHash, undefined); assert.equal(changed.passwordScheme, undefined);
    await assert.rejects(authenticateToken(old), { status: 401 });
    admin.authVersion = (await User.findById(admin._id)).authVersion;
  });

  const socketConnect = (credential) => new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
    const timer = setTimeout(() => { ws.close(); reject(new Error('Socket test timed out')); }, 5000);
    ws.addEventListener('message', event => {
      const frame = String(event.data);
      if (frame.startsWith('0')) ws.send('40' + JSON.stringify(credential ? { token: credential } : {}));
      else if (frame.startsWith('40')) { clearTimeout(timer); resolve({ ws, id: JSON.parse(frame.slice(2)).sid }); }
      else if (frame.startsWith('44')) { clearTimeout(timer); ws.close(); reject(new Error('UNAUTHORIZED')); }
      else if (frame === '2') ws.send('3');
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Socket transport failed')); });
  });

  await t.test('socket authentication and identity-derived rooms prevent cross-customer subscriptions', async () => {
    await assert.rejects(socketConnect('invalid-socket-token'), /UNAUTHORIZED/);
    const guest = await socketConnect();
    const client = await socketConnect(token(owner));
    const manager = await socketConnect(token(admin));
    const frames = new Map([guest, client, manager].map(socket => [socket, []]));
    for (const socket of [guest, client, manager]) socket.ws.addEventListener('message', event => {
      if (String(event.data).startsWith('42')) frames.get(socket).push(String(event.data));
    });
    try {
      const guestRooms = io.sockets.sockets.get(guest.id).rooms;
      assert.deepEqual([...guestRooms], [guest.id]);
      const guestAck = new Promise(resolve => guest.ws.addEventListener('message', event => { if (String(event.data).startsWith('431')) resolve(JSON.parse(String(event.data).slice(3))[0]); }));
      guest.ws.send('421' + JSON.stringify(['joinRoom', 'admins']));
      assert.deepEqual(await guestAck, { success: false });
      const ack = new Promise(resolve => client.ws.addEventListener('message', event => { if (String(event.data).startsWith('431')) resolve(JSON.parse(String(event.data).slice(3))[0]); }));
      client.ws.send('421' + JSON.stringify(['joinRoom', other.email]));
      assert.deepEqual(await ack, { success: false });
      const connected = io.sockets.sockets.get(client.id);
      assert.ok(connected.rooms.has(owner.email)); assert.equal(connected.rooms.has(other.email), false); assert.equal(connected.rooms.has('admins'), false);
      assert.ok(io.sockets.sockets.get(manager.id).rooms.has('admins'));
      const payments = [{ _id: 'private-payment', email: 'private-customer@socket.invalid', landline: 'PRIVATE-NUMBER', amount: 123 }];
      require('../services/pendingPaymentsEvents.service').publishPendingPayments(io, payments);
      await new Promise(resolve => setTimeout(resolve, 100));
      for (const socket of [guest, client]) {
        assert.deepEqual(frames.get(socket), ['42["pendingPaymentsChanged"]']);
        assert.doesNotMatch(frames.get(socket).join(''), /private-payment|private-customer|PRIVATE-NUMBER|123/);
      }
      assert.ok(frames.get(manager).some(frame => frame.includes('pendingPaymentsUpdate') && frame.includes('private-payment')));
      await User.updateOne({ _id: admin._id }, { $set: { role: 'user' } });
      const managerAck = new Promise(resolve => manager.ws.addEventListener('message', event => { if (String(event.data).startsWith('431')) resolve(true); }));
      manager.ws.send('421' + JSON.stringify(['joinRoom', admin.email])); await managerAck;
      assert.equal(io.sockets.sockets.get(manager.id).rooms.has('admins'), false);
      frames.set(manager, []);
      require('../services/pendingPaymentsEvents.service').publishPendingPayments(io, payments);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.deepEqual(frames.get(manager), ['42["pendingPaymentsChanged"]']);
    } finally { guest.ws.close(); client.ws.close(); manager.ws.close(); }
  });
});
