const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const User = require('../../models/User');
const Operation = require('../../models/UserOperation');
const Activity = require('../../models/UserActivity');
const Settings = require('../../models/MonitoringSettings');
const Payment = require('../../models/Payment');
const Balance = require('../../models/Balance');
const Alragheb = require('../../models/AlraghebTransaction');
const ProWave = require('../../models/ProWaveTransaction');
const Aleso = require('../../models/AlesoTransaction');
const Point = require('../../models/Point');
const FollowUp = require('../../models/UserFollowUp');
const monitoring = require('../../services/userMonitoring.service');
const activity = require('../../services/userActivity.service');

async function fixture() {
  process.env.JWT_SECRET = 'isolated-monitoring-test-only';
  const external = process.env.MONITORING_TEST_MONGO_URI;
  const version = process.env.MONGOMS_VERSION || '7.0.14';
  const systemBinary = process.env.MONGOMS_SYSTEM_BINARY || (process.platform === 'win32' && !external ? await require('./monitoringMongo').windowsBinary(version) : undefined);
  const db = external ? null : await MongoMemoryServer.create({ binary: { version, ...(systemBinary ? { systemBinary } : {}) }, instance: { ip: '127.0.0.1' } });
  const dbName = `monitoring_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const models = [User, Operation, Activity, Settings, Payment, Balance, Alragheb, ProWave, Aleso, Point, FollowUp];
  const cleanup = async () => {
    try {
      if (mongoose.connection.readyState === 1 && mongoose.connection.name === dbName && /^monitoring_test_[a-f0-9]{20}$/.test(dbName)) {
        for (const model of models) {
          try {
            await model.collection.deleteMany({});
          } catch (_) {}
        }
        try {
          await mongoose.connection.dropDatabase();
        } catch (_) {}
      }
    } finally { await mongoose.disconnect(); if (db) await db.stop(); }
  };
  try {
  await mongoose.connect(external || db.getUri(), { dbName, serverSelectionTimeoutMS: 10000 });
  for (const model of models) await model.init();
  const now = new Date(), day = 86400000;
  const admin = await User.create({ email: 'admin@test.invalid', name: 'مدير الاختبار', password: 'Test-pass-123', role: 'admin', balance: 1000 });
  const buyer = await User.create({ email: 'and@test.invalid', name: 'مستخدم الاختبار', password: 'Test-pass-123', role: 'user', balance: 479.56, lastSeenAt: now, lastLoginAt: now });
  const inactive = await User.create({ email: 'inactive@test.invalid', name: 'مستخدم منقطع', role: 'user', balance: 0, lastSeenAt: new Date(+now - 10 * day) });
  const unknown = await User.create({ email: 'unknown@test.invalid', name: 'حساب بلا زيارات', role: 'user' });
  const recipient = await User.create({ email: 'point@test.invalid', name: 'نقطة بيع', role: 'user-point' });
  const point = await Point.create({ username: recipient.email, email: buyer.email, owner: buyer.name });
  const completed = await Payment.create({ user: buyer._id, company: 'Alragheb', amount: 479.56, calculatedAmount: 479.56, status: 'تم التسديد', extra: { provider: 'alragheb', secret: 'never-copy-this' } });
  const alragheb = new mongoose.Types.ObjectId();
  await Alragheb.collection.insertOne({ _id: alragheb, user: buyer._id, payment: completed._id, quote: new mongoose.Types.ObjectId(), orderUuid: 'test-order-1', productId: 4, productName: 'SOULHILL CRYSTAL', qty: 2000, totalSyp: '479.56', status: 'completed', createdAt: now, updatedAt: now, params: { password: 'never-copy-params' }, result: 'never-copy-codes' });
  const pending = await Payment.create({ user: buyer._id, company: 'Internet', amount: 15, calculatedAmount: 15.5, createdAt: new Date(+now - day), status: 'جاري التسديد' });
  const failed = await Payment.create({ user: buyer._id, company: 'Internet', calculatedAmount: 10, status: 'غير مسددة' });
  await ProWave.collection.insertOne({ _id: new mongoose.Types.ObjectId(), user: buyer._id, itemCode: 'game-1', itemName: 'Game card', paynetAmountSyp: 25.25, status: 'refunded', paynetRefundedSyp: 25.25, qty: 1, createdAt: now, updatedAt: now });
  await Aleso.collection.insertOne({ _id: new mongoose.Types.ObjectId(), user: buyer._id, productId: 22, productName: 'AI subscription', paynetAmountSyp: 50.1, qty: 1, status: 'completed', createdAt: now, updatedAt: now });
  await Balance.create({ user: point._id, destination: buyer.email, name: recipient.email, amount: 100, isConfirmed: true });
  await monitoring.sync({ full: true });
  const app = express();
  app.use(require('cors')());
  app.use(express.json());
  app.use(activity.observeRequests);
  app.use('/api', require('../../routes/authRoutes'));
  app.use('/api/activity', require('../../routes/activity'));
  app.use('/api/admin/user-monitoring', require('../../routes/userMonitoring'));
  app.use('/api/admin', require('../../routes/admin'));
  app.use('/api/user', require('../../routes/userRoutes'));
  app.post('/api/alragheb/quote', require('../../middleware/authMiddleware'), (_req, res) => res.json({ data: { product_id: 4, product_name: 'SOULHILL CRYSTAL', quote_id: 'fixture-quote' } }));
  app.post('/api/alragheb/order', require('../../middleware/authMiddleware'), (_req, res) => res.status(400).json({ code: 'INSUFFICIENT_BALANCE', message: 'not enough', private: 'never-copy-error' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = (user, role = user.role) => jwt.sign({ id: user._id, email: user.email, role }, process.env.JWT_SECRET);
  const request = (path, user = admin, options = {}) => fetch(base + path, { ...options, headers: { ...(user ? { Authorization: `Bearer ${token(user)}` } : {}), 'Content-Type': 'application/json', ...options.headers } });
  const close = async () => { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); await cleanup(); };
  return { app, base, db, server, admin, buyer, inactive, unknown, recipient, completed, pending, failed, alragheb, token, request, close };
  } catch (error) { await cleanup(); throw error; }
}
module.exports = { fixture };
