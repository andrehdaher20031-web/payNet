const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const User = require('../models/User');
const Operation = require('../models/UserOperation');
const Settings = require('../models/MonitoringSettings');
const activity = require('./userActivity.service');
const retention = require('./userRetention.service');
const sources = ['Payment', 'Balance', 'AlraghebTransaction', 'ProWaveTransaction', 'AlesoTransaction'];
const defaults = { activeHours: 24, inactiveDays: 7, pendingMinutes: 30, failedThreshold: 3 };
const asMoney = (value) => { try { const d = new Decimal(value ?? 0); return d.isFinite() ? d.toFixed(2) : '0.00'; } catch { return '0.00'; } };
let running;

async function settings() {
  return { ...defaults, ...await Settings.findById('default').lean() };
}

function normalize(model, row) {
  const provider = model === 'AlraghebTransaction' ? 'alragheb' : model === 'ProWaveTransaction' ? 'prowave' : model === 'AlesoTransaction' ? 'aleso' : row.extra?.provider || 'paynet';
  const status = model === 'Payment'
    ? row.status === 'تم التسديد' ? 'completed' : row.status === 'غير مسددة' ? 'failed' : 'pending'
    : model === 'Balance' ? row.isConfirmed ? 'completed' : 'pending' : row.status;
  const paymentId = model === 'Payment' ? String(row._id) : row.payment ? String(row.payment) : undefined;
  return {
    key: paymentId ? `payment:${paymentId}` : `${model}:${row._id}`,
    user: row.user, sourceModel: model, referenceId: String(row._id), paymentId,
    provider, kind: model === 'Balance' ? 'balance_credit' : 'purchase',
    productId: String(row.productId || row.itemCode || row.extra?.product_id || ''),
    productName: String(row.productName || row.itemName || row.itemTitle || row.company || '').slice(0, 120),
    quantity: row.qty || 1, amountSyp: asMoney(model === 'AlraghebTransaction' ? row.totalSyp : row.paynetAmountSyp ?? row.calculatedAmount ?? row.amount),
    refundedSyp: asMoney(model === 'AlraghebTransaction' && row.refundedAt ? row.totalSyp : row.paynetRefundedSyp),
    status: ['pending', 'completed', 'failed', 'refunded', 'mismatch'].includes(status) ? status : 'pending',
    errorCode: activity.safeCode(row.lastError || row.failureCode) || (status === 'failed' ? 'OPERATION_FAILED' : status === 'refunded' ? 'PROVIDER_REJECTED_REFUNDED' : undefined),
    occurredAt: row.createdAt || row.date || row._id.getTimestamp(),
    sourceUpdatedAt: row.updatedAt || row.createdAt || row.date || row._id.getTimestamp(),
    observedAt: new Date(),
  };
}

async function saveOperation(op, historical) {
  if (op.sourceModel === 'Payment' && op.provider === 'paynet') {
    const context = await require('../models/UserActivity').findOne({ user: op.user, referenceId: op.referenceId, eventType: 'request_accepted', provider: 'paynet' }).select('productId productName').lean();
    if (context?.productId) op.productId = context.productId;
    if (context?.productName) op.productName = context.productName;
  }
  const old = await Operation.findOne({ key: op.key }).lean();
  if (old && op.sourceModel === 'Payment' && old.sourceModel !== 'Payment') return;
  if (old && old.sourceModel === op.sourceModel && +old.sourceUpdatedAt > +op.sourceUpdatedAt) return;
  if (old && old.sourceModel === op.sourceModel && +old.sourceUpdatedAt === +op.sourceUpdatedAt && old.status === op.status && old.amountSyp === op.amountSyp && old.refundedSyp === op.refundedSyp && old.errorCode === op.errorCode && old.productId === op.productId && old.productName === op.productName) return;
  const changed = old && (old.status !== op.status || old.refundedSyp !== op.refundedSyp);
  try { await Operation.updateOne({ key: op.key }, { $set: op }, { upsert: true }); }
  catch (error) { if (error.code !== 11000) throw error; return; }
  if (!old || changed) {
    await activity.record({
      user: op.user, eventKey: `operation:${op.key}:${op.status}:${op.refundedSyp}`,
      eventType: old ? 'operation_updated' : 'operation_recorded',
      source: historical || !old ? 'history' : 'server',
      provider: op.provider, productId: op.productId, productName: op.productName,
      referenceId: op.referenceId, status: op.status, errorCode: op.errorCode,
      // Legacy records describe the observed state, not an invented historical transition.
      occurredAt: old ? op.sourceUpdatedAt : op.occurredAt,
    });
  }
}

async function syncImpl({ full = false } = {}) {
  await Settings.updateOne({ _id: 'default' }, { $setOnInsert: { ...defaults, trackingStartedAt: new Date() } }, { upsert: true });
  const config = await settings();
  const started = new Date();
  const since = !full && config.syncedAt ? new Date(+config.syncedAt - 120000) : null;
  let count = 0;
  for (const model of sources) {
    const Source = require(`../models/${model}`);
    const filter = since ? { $or: [{ updatedAt: { $gte: since } }, { createdAt: { $gte: since } }] } : {};
    const fields = 'user payment status isConfirmed createdAt updatedAt date productId productName itemCode itemName itemTitle qty totalSyp paynetAmountSyp calculatedAmount amount paynetRefundedSyp refundedAt lastError failureCode speed company extra.provider extra.product_id destination name';
    for await (const row of Source.find(filter).select(fields).sort({ _id: 1 }).lean().cursor({ batchSize: 200 })) {
      const op = normalize(model, row);
      if (model === 'Balance') {
        const point = await require('../models/Point').findById(row.user).select('username email').lean();
        if (point) {
          const [sender, recipient] = await Promise.all([
            User.findOne({ email: point.email }).select('_id').lean(),
            User.findOne({ email: point.username }).select('_id').lean(),
          ]);
          if (sender) await saveOperation({ ...op, key: `${op.key}:debit`, user: sender._id, kind: 'transfer_out', productName: 'تحويل إلى نقطة بيع' }, !since);
          if (recipient) await saveOperation({ ...op, key: `${op.key}:credit`, user: recipient._id, kind: 'transfer_in', productName: 'رصيد وارد إلى نقطة بيع' }, !since);
          count++; continue;
        }
      }
      if (mongoose.isValidObjectId(op.user)) await saveOperation(op, !since);
      count++;
    }
  }
  await Settings.updateOne({ _id: 'default' }, { $set: { syncedAt: started, syncError: false } });
  return { count, syncedAt: started };
}

function sync(options) {
  if (running) return running;
  running = syncImpl(options).catch(async (error) => {
    await Settings.updateOne({ _id: 'default' }, { $set: { syncError: true } }).catch(() => {});
    throw error;
  }).finally(() => { running = null; });
  return running;
}

function start() {
  const run = () => sync().catch(() => console.warn('User monitoring sync failed; financial processing is unaffected'));
  void run();
  const timer = setInterval(run, 30000);
  timer.unref();
  return () => clearInterval(timer);
}

function userPipeline(config, query = {}, now = new Date()) {
  const match = {};
  if (query.id) match._id = new mongoose.Types.ObjectId(query.id);
  if (query.role) match.role = query.role;
  if (query.search) {
    const regex = String(query.search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    match.$or = ['name', 'email', 'number'].map((field) => ({ [field]: { $regex: regex, $options: 'i' } }));
  }
  const recent = new Date(+now - 30 * 86400000);
  const previous = new Date(+now - 60 * 86400000);
  const stalled = new Date(+now - config.pendingMinutes * 60000);
  const successfulPurchase = { $and: [{ $eq: ['$kind', 'purchase'] }, { $eq: ['$status', 'completed'] }] };
  return [
    { $match: match },
    { $project: { name: 1, email: 1, number: 1, role: 1, balance: 1, createdAt: 1, lastLoginAt: 1, lastSeenAt: 1, loginCount: 1 } },
    { $lookup: { from: Operation.collection.name, localField: '_id', foreignField: 'user', pipeline: [
      { $group: { _id: null, count: { $sum: 1 },
        purchases: { $sum: { $cond: [{ $eq: ['$kind', 'purchase'] }, 1, 0] } },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $in: ['$status', ['failed', 'refunded', 'mismatch']] }, 1, 0] } },
        recentFailed: { $sum: { $cond: [{ $and: [{ $gte: ['$occurredAt', recent] }, { $in: ['$status', ['failed', 'refunded', 'mismatch']] }] }, 1, 0] } },
        stalled: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'pending'] }, { $lt: ['$occurredAt', stalled] }] }, 1, 0] } },
        spent: { $sum: { $cond: [{ $and: [{ $eq: ['$kind', 'purchase'] }, { $eq: ['$status', 'completed'] }] }, { $toDecimal: '$amountSyp' }, 0] } },
        successfulPurchases: { $sum: { $cond: [successfulPurchase, 1, 0] } },
        firstPurchaseAt: { $min: { $cond: [successfulPurchase, '$occurredAt', null] } },
        lastPurchaseAt: { $max: { $cond: [successfulPurchase, '$occurredAt', null] } },
        recentPurchases: { $sum: { $cond: [{ $and: [successfulPurchase, { $gte: ['$occurredAt', recent] }] }, 1, 0] } },
        previousPurchases: { $sum: { $cond: [{ $and: [successfulPurchase, { $gte: ['$occurredAt', previous] }, { $lt: ['$occurredAt', recent] }] }, 1, 0] } },
        providers: { $addToSet: '$provider' },
      } }, { $set: { spent: { $toString: '$spent' } } },
    ], as: 'stats' } },
    { $lookup: { from: Operation.collection.name, localField: '_id', foreignField: 'user', pipeline: [{ $sort: { occurredAt: -1, _id: -1 } }, { $limit: 1 }], as: 'last' } },
    { $lookup: { from: require('../models/UserActivity').collection.name, localField: '_id', foreignField: 'user', pipeline: [
      { $match: { occurredAt: { $gte: recent }, eventType: { $in: ['request_failed', 'login_failed'] } } }, { $count: 'count' },
    ], as: 'errors' } },
    { $set: { stats: { $ifNull: [{ $first: '$stats' }, { count: 0, purchases: 0, completed: 0, failed: 0, recentFailed: 0, stalled: 0, spent: '0', providers: [], successfulPurchases: 0, recentPurchases: 0, previousPurchases: 0, firstPurchaseAt: null, lastPurchaseAt: null }] }, lastOperation: { $first: '$last' }, recentErrors: { $ifNull: [{ $first: '$errors.count' }, 0] } } },
    { $set: { activityStatus: { $switch: { branches: [
      { case: { $eq: [{ $ifNull: ['$lastSeenAt', null] }, null] }, then: 'unobserved' },
      { case: { $gte: ['$lastSeenAt', new Date(+now - config.activeHours * 3600000)] }, then: 'active' },
      { case: { $gte: ['$lastSeenAt', new Date(+now - config.inactiveDays * 86400000)] }, then: 'returning' },
    ], default: 'inactive' } },
    needsAttention: { $or: [{ $gt: ['$stats.stalled', 0] }, { $gte: ['$stats.recentFailed', config.failedThreshold] }, { $gte: ['$recentErrors', config.failedThreshold] }] } } },
    ...retention.stages(config, now),
    { $match: { ...(query.activity ? { activityStatus: query.activity } : {}), ...(query.attention === 'true' ? { needsAttention: true } : {}), ...(query.provider ? { $or: [{ 'stats.providers': query.provider }, { 'intent.provider': query.provider }] } : {}), ...(query.purchased === 'yes' ? { 'stats.purchases': { $gt: 0 } } : query.purchased === 'no' ? { 'stats.purchases': 0 } : {}), ...(query.seenBefore ? { lastSeenAt: { $lte: new Date(query.seenBefore) } } : {}) } },
    { $match: { ...(query.risk ? { 'retention.risk': query.risk } : {}), ...(query.segment ? { 'retention.segment': query.segment } : {}),
      ...(query.followUp ? { 'followUp.status': query.followUp } : {}), ...(query.due === 'true' ? { followUpDue: true } : {}),
      ...(query.owner ? { 'followUp.owner': query.owner === 'unassigned' ? null : new mongoose.Types.ObjectId(query.owner) } : {}),
      ...(query.goal ? { goalStage: query.goal } : {}) } },
    { $unset: ['last', 'errors'] },
  ];
}

module.exports = { sync, start, settings, defaults, normalize, userPipeline };
