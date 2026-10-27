const router = require('express').Router();
const mongoose = require('mongoose');
const User = require('../models/User');
const Activity = require('../models/UserActivity');
const Operation = require('../models/UserOperation');
const Settings = require('../models/MonitoringSettings');
const FollowUp = require('../models/UserFollowUp');
const monitoring = require('../services/userMonitoring.service');
const retention = require('../services/userRetention.service');
const activity = require('../services/userActivity.service');
const auth = require('../middleware/authMiddleware');

const fail = (message = 'معايير البحث غير صحيحة') => Object.assign(new Error(message), { status: 400 });
const handler = (action) => async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { await action(req, res); }
  catch (e) { if (!e.status) console.warn('User monitoring request failed'); res.status(e.status || 500).json({ message: e.status ? e.message : 'تعذر تحميل بيانات المتابعة' }); }
};
router.use(auth, async (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  try {
    const user = await User.findById(req.user.id).select('role').lean();
    if (!user || user.role !== 'admin') return res.status(403).json({ message: 'هذه البيانات متاحة للإدارة فقط' });
    next();
  } catch { res.status(503).json({ message: 'تعذر التحقق من صلاحية الإدارة' }); }
});

function queryParams(query) {
  const q = {};
  const allowed = new Set(['page', 'limit', 'search', 'activity', 'provider', 'role', 'purchased', 'attention', 'sort', 'status', 'type', 'from', 'to', 'seenBefore', 'risk', 'segment', 'followUp', 'due', 'owner', 'goal']);
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key) || typeof value !== 'string' || value.length > 150) throw fail();
    q[key] = value;
  }
  for (const [key, choices] of Object.entries({ risk: ['high', 'medium', 'low', 'unknown'], segment: ['repeat', 'first_purchase', 'prospect', 'unobserved'], followUp: ['new', 'in_progress', 'waiting', 'resolved'], due: ['true', 'false'], goal: ['unknown', 'browsing', 'pricing', 'checkout', 'abandoned', 'blocked', 'submitted', 'pending', 'completed'], activity: ['active', 'returning', 'inactive', 'unobserved'], provider: ['paynet', 'alragheb', 'prowave', 'aleso'], role: ['admin', 'user', 'user-point'], purchased: ['yes', 'no'], attention: ['true', 'false'], sort: ['lastSeenAt', 'lastLoginAt', 'lastOperation', 'email', 'priority', 'dueAt', 'lastPurchaseAt'], status: ['completed', 'pending', 'failed', 'refunded', 'mismatch'], type: ['login_success', 'login_failed', 'logout', 'page_view', 'product_view', 'catalog_filter', 'checkout_started', 'quote_created', 'request_failed', 'request_accepted', 'operation_recorded', 'operation_updated', 'admin_action'] })) {
    if (q[key] && !(key === 'type' && q[key] === 'checkout_failed') && !choices.includes(q[key])) throw fail();
  }
  if (q.owner && q.owner !== 'unassigned' && !/^[a-f0-9]{24}$/i.test(q.owner)) throw fail();
  for (const key of ['from', 'to', 'seenBefore']) if (q[key] && (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(q[key]) || !Number.isFinite(Date.parse(q[key])))) throw fail();
  if (q.from && q.to && Date.parse(q.from) > Date.parse(q.to)) throw fail();
  const page = Number(q.page || 1), limit = Number(q.limit || 25);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw fail();
  return { ...q, page, limit };
}
function dates(q) {
  if (!q.from && !q.to) return {};
  return { occurredAt: { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lt: new Date(Date.parse(q.to) + (/^\d{4}-\d{2}-\d{2}$/.test(q.to) ? 86400000 : 1)) } : {}) } };
}
function paging(data, total, q) { return { data, pagination: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } }; }
const sortFor = (q) => q.sort === 'email' ? { email: 1, _id: 1 } : q.sort === 'priority' ? { followUpPriority: -1, followUpDue: -1, 'followUp.dueAt': 1, _id: -1 } : q.sort === 'dueAt' ? { followUpDue: -1, 'followUp.dueAt': 1, _id: -1 } : { [q.sort === 'lastOperation' ? 'lastOperation.occurredAt' : q.sort === 'lastPurchaseAt' ? 'retention.lastPurchaseAt' : q.sort || 'lastSeenAt']: -1, _id: -1 };
async function existingUser(id) {
  if (!/^[a-f0-9]{24}$/i.test(id)) throw fail('معرّف المستخدم غير صحيح');
  if (!await User.exists({ _id: id })) throw Object.assign(new Error('المستخدم غير موجود'), { status: 404 });
}

router.get('/settings', handler(async (_req, res) => res.json(await monitoring.settings())));
router.put('/settings', handler(async (req, res) => {
  const input = req.body || {};
  const ranges = { activeHours: [1, 72], inactiveDays: [1, 365], pendingMinutes: [1, 10080], failedThreshold: [1, 100] };
  if (Object.keys(input).some((key) => !ranges[key])) throw fail();
  const next = { ...await monitoring.settings() };
  for (const [key, value] of Object.entries(input)) {
    if (!Number.isInteger(value) || value < ranges[key][0] || value > ranges[key][1]) throw fail();
    next[key] = value;
  }
  if (next.activeHours >= next.inactiveDays * 24) throw fail('مدة الانقطاع يجب أن تتجاوز مدة النشاط');
  await Settings.updateOne({ _id: 'default' }, { $set: Object.fromEntries(Object.keys(ranges).map(k => [k, next[k]])) }, { upsert: true });
  await activity.safeRecord({ user: req.user.id, actor: req.user.id, eventType: 'admin_action', route: '/monitoring/settings' });
  res.json(await monitoring.settings());
}));

router.get('/summary', handler(async (_req, res) => {
  const config = await monitoring.settings();
  const [row] = await User.aggregate([...monitoring.userPipeline(config), { $group: {
    _id: null, total: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ['$activityStatus', 'active'] }, 1, 0] } },
    returning: { $sum: { $cond: [{ $eq: ['$activityStatus', 'returning'] }, 1, 0] } },
    inactive: { $sum: { $cond: [{ $eq: ['$activityStatus', 'inactive'] }, 1, 0] } },
    unobserved: { $sum: { $cond: [{ $eq: ['$activityStatus', 'unobserved'] }, 1, 0] } },
    needsAttention: { $sum: { $cond: ['$needsAttention', 1, 0] } },
    buyers: { $sum: { $cond: [{ $gt: ['$stats.successfulPurchases', 0] }, 1, 0] } },
    repeatBuyers: { $sum: { $cond: [{ $gte: ['$stats.successfulPurchases', 2] }, 1, 0] } },
    atRisk: { $sum: { $cond: [{ $eq: ['$retention.risk', 'high'] }, 1, 0] } },
    dueFollowUps: { $sum: { $cond: ['$followUpDue', 1, 0] } },
    incompleteCheckouts: { $sum: { $cond: [{ $eq: ['$goalStage', 'abandoned'] }, 1, 0] } },
    purchaseDecline: { $sum: { $cond: ['$purchaseDecline', 1, 0] } },
  } }]).option({ maxTimeMS: 15000 });
  res.json({ total: 0, active: 0, returning: 0, inactive: 0, unobserved: 0, needsAttention: 0, buyers: 0, repeatBuyers: 0, atRisk: 0, dueFollowUps: 0, incompleteCheckouts: 0, purchaseDecline: 0, ...row, settings: config });
}));

router.get('/owners', handler(async (_req, res) => res.json(await User.find({ role: 'admin' }).select('name email').sort({ name: 1, _id: 1 }).lean())));

router.get('/analytics', handler(async (_req, res) => {
  const since = new Date(Date.now() - 30 * 86400000);
  const [events, purchases, days, reasons, cohortRows] = await Promise.all([
    Activity.aggregate([{ $match: { occurredAt: { $gte: since }, user: { $ne: null }, eventType: { $in: ['product_view', 'quote_created', 'checkout_started'] } } },
      { $group: { _id: { type: '$eventType', user: '$user' }, count: { $sum: 1 } } },
      { $group: { _id: '$_id.type', users: { $sum: 1 }, events: { $sum: '$count' } } }]),
    Operation.aggregate([{ $match: { kind: 'purchase', status: 'completed', occurredAt: { $gte: since } } },
      { $group: { _id: '$user', count: { $sum: 1 }, spent: { $sum: { $toDecimal: '$amountSyp' } } } },
      { $group: { _id: null, users: { $sum: 1 }, repeatBuyers: { $sum: { $cond: [{ $gte: ['$count', 2] }, 1, 0] } }, count: { $sum: '$count' }, spent: { $sum: '$spent' } } },
      { $set: { spent: { $toString: '$spent' } } }]),
    Operation.aggregate([{ $match: { kind: 'purchase', status: 'completed', occurredAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { date: '$occurredAt', format: '%Y-%m-%d', timezone: 'Asia/Damascus' } }, count: { $sum: 1 }, spent: { $sum: { $toDecimal: '$amountSyp' } } } },
      { $set: { spent: { $toString: '$spent' } } }, { $sort: { _id: 1 } }]),
    FollowUp.aggregate([{ $match: { dropOffReason: { $ne: 'unknown' } } }, { $group: { _id: '$dropOffReason', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    Activity.aggregate([
      { $match: { eventType: 'page_view', user: { $ne: null }, source: 'browser' } },
      { $group: { _id: { user: '$user', day: { $dateTrunc: { date: '$occurredAt', unit: 'day', timezone: 'Asia/Damascus' } } } } },
      { $group: { _id: '$_id.user', firstAt: { $min: '$_id.day' }, days: { $addToSet: '$_id.day' } } },
      { $match: { firstAt: { $gte: new Date(Date.now() - 90 * 86400000) } } },
      { $lookup: { from: User.collection.name, localField: '_id', foreignField: '_id', pipeline: [{ $project: { role: 1 } }], as: 'account' } },
      { $match: { 'account.role': { $in: ['user', 'user-point'] } } },
      { $set: Object.fromEntries([7, 30].flatMap(day => {
        const end = day + 7;
        return [[`eligible${day}`, { $lte: [{ $add: ['$firstAt', end * 86400000] }, new Date()] }],
          [`returned${day}`, { $gt: [{ $size: { $filter: { input: '$days', as: 'date', cond: { $and: [
            { $gte: ['$$date', { $add: ['$firstAt', day * 86400000] }] }, { $lt: ['$$date', { $add: ['$firstAt', end * 86400000] }] },
          ] } } } }, 0] }]];
      })) },
      { $group: { _id: { $dateToString: { date: { $dateTrunc: { date: '$firstAt', unit: 'week', startOfWeek: 'monday', timezone: 'Asia/Damascus' } }, format: '%Y-%m-%d', timezone: 'Asia/Damascus' } }, users: { $sum: 1 },
        eligible7: { $sum: { $cond: ['$eligible7', 1, 0] } }, returned7: { $sum: { $cond: [{ $and: ['$eligible7', '$returned7'] }, 1, 0] } },
        eligible30: { $sum: { $cond: ['$eligible30', 1, 0] } }, returned30: { $sum: { $cond: [{ $and: ['$eligible30', '$returned30'] }, 1, 0] } },
      } }, { $sort: { _id: -1 } },
    ]).option({ maxTimeMS: 15000, allowDiskUse: true }),
  ]);
  const totals = purchases[0] || { users: 0, repeatBuyers: 0, count: 0, spent: '0' };
  const cohorts = cohortRows.map(row => ({ ...row, rate7: row.eligible7 ? Math.round(row.returned7 / row.eligible7 * 1000) / 10 : null,
    rate30: row.eligible30 ? Math.round(row.returned30 / row.eligible30 * 1000) / 10 : null }));
  res.json({ since, events, purchases: totals, days, reasons, cohorts,
    repeatPurchaseRate: totals.users ? Math.round(totals.repeatBuyers / totals.users * 1000) / 10 : null });
}));

router.get('/users', handler(async (req, res) => {
  const q = queryParams(req.query), config = await monitoring.settings();
  const [result] = await User.aggregate([...monitoring.userPipeline(config, q), { $facet: {
    data: [{ $sort: sortFor(q) }, { $skip: (q.page - 1) * q.limit }, { $limit: q.limit }], total: [{ $count: 'count' }],
  } }]).option({ maxTimeMS: 15000 });
  res.json(paging(result.data.map(retention.present), result.total[0]?.count || 0, q));
}));

const csvCell = (value) => {
  let str = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(str)) str = `'${str}`;
  return `"${str.replaceAll('"', '""')}"`;
};
router.get('/export', handler(async (req, res) => {
  const q = queryParams(req.query);
  const rows = await User.aggregate([...monitoring.userPipeline(await monitoring.settings(), q), { $sort: sortFor(q) }, { $limit: 5001 }]).option({ maxTimeMS: 15000 });
  if (rows.length > 5000) return res.status(413).json({ message: 'ضيّق نطاق البحث لتصدير 5000 مستخدم كحد أقصى' });
  const fields = ['name', 'email', 'role', 'balance', 'lastLoginAt', 'lastSeenAt', 'activityStatus', 'needsAttention', 'goal.stage', 'goal.productName', 'retention.risk', 'retention.successfulPurchases', 'retention.lastPurchaseAt', 'followUp.status', 'followUp.owner', 'followUp.dueAt', 'followUp.confirmedGoal'];
  res.type('text/csv; charset=utf-8').attachment('paynet-user-monitoring.csv').send('\uFEFF' + [fields, ...rows.map(retention.present).map(row => fields.map(k => {
    const value = k.split('.').reduce((current, key) => current?.[key], row);
    return value instanceof Date ? value.toISOString() : value;
  }))].map(row => row.map(csvCell).join(',')).join('\r\n'));
}));

router.get('/logins', handler(async (req, res) => {
  const q = queryParams(req.query), filter = { eventType: { $in: ['login_success', 'login_failed'] }, ...dates(q) };
  const [data, total] = await Promise.all([Activity.find(filter).sort({ occurredAt: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).populate('user', 'name email').lean(), Activity.countDocuments(filter)]);
  res.json(paging(data, total, q));
}));

router.get('/users/:id', handler(async (req, res) => {
  await existingUser(req.params.id);
  const [user] = await User.aggregate(monitoring.userPipeline(await monitoring.settings(), { id: req.params.id }));
  const id = new mongoose.Types.ObjectId(req.params.id);
  const [interests, purchaseInterests, lastQuote, lastAction] = await Promise.all([
    Activity.aggregate([{ $match: { user: id, occurredAt: { $gte: new Date(Date.now() - 30 * 86400000) }, productId: { $nin: ['', null] }, eventType: { $in: ['product_view', 'quote_created', 'checkout_started'] } } },
      { $sort: { occurredAt: -1 } }, { $group: { _id: { provider: '$provider', productId: '$productId' }, name: { $first: '$productName' }, lastAt: { $max: '$occurredAt' }, views: { $sum: { $cond: [{ $eq: ['$eventType', 'product_view'] }, 1, 0] } }, quotes: { $sum: { $cond: [{ $eq: ['$eventType', 'quote_created'] }, 1, 0] } }, checkouts: { $sum: { $cond: [{ $eq: ['$eventType', 'checkout_started'] }, 1, 0] } } } }, { $sort: { lastAt: -1 } }, { $limit: 30 }]),
    Operation.aggregate([{ $match: { user: id, kind: 'purchase', status: 'completed', occurredAt: { $gte: new Date(Date.now() - 30 * 86400000) } } }, { $group: { _id: { provider: '$provider', productId: '$productId' }, name: { $first: '$productName' }, purchases: { $sum: 1 }, lastAt: { $max: '$occurredAt' } } }, { $sort: { lastAt: -1 } }, { $limit: 30 }]),
    Activity.findOne({ user: id, eventType: 'quote_created' }).sort({ occurredAt: -1 }).lean(),
    Activity.findOne({ user: id, eventType: { $nin: ['operation_recorded', 'operation_updated', 'login_failed', 'admin_action'] } }).sort({ occurredAt: -1 }).lean(),
  ]);
  const merged = new Map(interests.map(row => [`${row._id.provider}:${row._id.productId}`, { views: 0, quotes: 0, checkouts: 0, purchases: 0, ...row }]));
  for (const row of purchaseInterests) {
    const key = `${row._id.provider}:${row._id.productId}`;
    merged.set(key, { views: 0, quotes: 0, checkouts: 0, ...merged.get(key), ...row, name: row.name || merged.get(key)?.name });
  }
  let uncompletedQuote = null;
  if (lastQuote && +lastQuote.occurredAt < Date.now() - 30 * 60000 && !await Operation.exists({ user: id, provider: lastQuote.provider, productId: lastQuote.productId, occurredAt: { $gte: lastQuote.occurredAt } })) uncompletedQuote = { occurredAt: lastQuote.occurredAt, productId: lastQuote.productId, productName: lastQuote.productName };
  res.json({ ...retention.present(user), lastAction, interests: [...merged.values()], uncompletedQuote });
}));

router.get('/users/:id/follow-up', handler(async (req, res) => {
  await existingUser(req.params.id);
  const data = await FollowUp.findById(req.params.id).populate('owner history.actor history.owner', 'name email').lean();
  res.json(data || { status: 'new', owner: null, dueAt: null, confirmedGoal: '', dropOffReason: 'unknown', revision: 0, history: [] });
}));

router.put('/users/:id/follow-up', handler(async (req, res) => {
  await existingUser(req.params.id);
  const input = req.body || {};
  if (Object.keys(input).some(key => !['revision', 'status', 'owner', 'dueAt', 'confirmedGoal', 'dropOffReason', 'note'].includes(key))) throw fail();
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 || !['new', 'in_progress', 'waiting', 'resolved'].includes(input.status)) throw fail();
  if (typeof input.confirmedGoal !== 'string' || input.confirmedGoal.length > 300 || typeof input.note !== 'string' || input.note.length > 2000) throw fail();
  if (!['unknown', 'balance', 'price', 'availability', 'technical', 'no_need', 'other'].includes(input.dropOffReason)) throw fail();
  if (input.owner !== null && (typeof input.owner !== 'string' || !/^[a-f0-9]{24}$/i.test(input.owner) || !await User.exists({ _id: input.owner, role: 'admin' }))) throw fail('مسؤول المتابعة يجب أن يكون مديراً');
  if (input.dueAt !== null && (typeof input.dueAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(input.dueAt) || !Number.isFinite(Date.parse(input.dueAt)))) throw fail('موعد المتابعة غير صحيح');
  const next = { status: input.status, owner: input.owner, dueAt: input.status === 'resolved' || !input.dueAt ? null : new Date(input.dueAt),
    confirmedGoal: input.confirmedGoal.trim(), dropOffReason: input.dropOffReason };
  const entry = { ...next, actor: req.user.id, at: new Date(), note: input.note.trim() };
  let saved;
  try {
    saved = await FollowUp.findOneAndUpdate({ _id: req.params.id, revision: input.revision },
      { $set: next, $inc: { revision: 1 }, $push: { history: { $each: [entry], $slice: -200 } } },
      { upsert: input.revision === 0, new: true, runValidators: true, setDefaultsOnInsert: false }).lean();
  } catch (error) { if (error.code !== 11000) throw error; }
  if (!saved) throw Object.assign(new Error('تم تعديل المتابعة بواسطة مدير آخر؛ حدّث البيانات وراجع التغييرات قبل الحفظ'), { status: 409 });
  await activity.safeRecord({ user: req.params.id, actor: req.user.id, eventType: 'admin_action', route: '/monitoring/follow-up' });
  res.json(saved);
}));

router.get('/users/:id/journeys', handler(async (req, res) => {
  await existingUser(req.params.id);
  const q = queryParams(req.query);
  const [result] = await Activity.aggregate(retention.journeyPipeline(new mongoose.Types.ObjectId(req.params.id), q, dates(q))).option({ maxTimeMS: 15000, allowDiskUse: true });
  res.json(paging(result.data, result.total[0]?.count || 0, q));
}));

router.get('/users/:id/:section', handler(async (req, res) => {
  await existingUser(req.params.id);
  const q = queryParams(req.query), section = req.params.section;
  if (!['activity', 'logins', 'operations'].includes(section)) return res.sendStatus(404);
  const Model = section === 'operations' ? Operation : Activity;
  const filter = { user: req.params.id, ...dates(q), ...(q.provider ? { provider: q.provider } : {}), ...(q.status ? { status: q.status } : {}),
    ...(section === 'logins' ? { eventType: { $in: ['login_success', 'login_failed', 'logout'] } } : q.type ? { eventType: q.type } : {}) };
  const [data, total] = await Promise.all([Model.find(filter).sort({ occurredAt: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(), Model.countDocuments(filter)]);
  res.json(paging(data, total, q));
}));

module.exports = router;
module.exports.csvCell = csvCell;
