const mongoose = require('mongoose');
const Decimal = require('decimal.js');
const Settings = require('../models/ProviderIntegrationSettings');
const Audit = require('../models/ProviderIntegrationAudit');
const Health = require('../models/ProviderWorkerHealth');
const User = require('../models/User');

const PROVIDERS = ['alragheb', 'prowave'];
const ACTIVE = ['pending', 'unknown', 'manual_review', 'delivery_pending'];
const DEFAULTS = { purchaseEnabled: true, lowBalanceThreshold: '0', reviewAfterMinutes: 30, workerConcurrency: 3 };
const fail = (code, message, status = 400) => { throw Object.assign(new Error(message), { code, status }); };
const providerName = (value) => {
  if (!PROVIDERS.includes(value)) fail('INVALID_PROVIDER', 'المزوّد غير موجود', 404);
  return value;
};
const modelFor = (provider) => require(providerName(provider) === 'alragheb' ? '../models/AlraghebTransaction' : '../models/ProWaveTransaction');
const settingsView = (provider, row) => ({ provider, ...DEFAULTS, ...(row ? {
  purchaseEnabled: row.purchaseEnabled, lowBalanceThreshold: row.lowBalanceThreshold,
  reviewAfterMinutes: row.reviewAfterMinutes, workerConcurrency: row.workerConcurrency,
  revision: row.revision, updatedAt: row.updatedAt,
} : { revision: 0 }) });
const safeCode = (value) => typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value) ? value : 'PROVIDER_UNAVAILABLE';
const cleanNote = (value, min = 3) => {
  if (typeof value !== 'string' || value.trim().length < min || value.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail('INVALID_NOTE', 'أدخل سببًا واضحًا للعملية');
  return value.trim();
};
// Filter calendar days in the same business timezone used by the dashboard.
const dayBoundary = (value, followingDay = false) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('INVALID_QUERY', 'التاريخ غير صالح');
  const utc = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(utc.getTime()) || utc.toISOString().slice(0, 10) !== value) fail('INVALID_QUERY', 'التاريخ غير صالح');
  if (followingDay) utc.setUTCDate(utc.getUTCDate() + 1);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Damascus', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(utc);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  const offset = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second) - utc.getTime();
  return new Date(utc.getTime() - offset);
};
const reviewPredicate = () => ({ $or: [
  { status: { $in: ['unknown', 'manual_review', 'delivery_pending'] } },
  { internalReviewStatus: 'needs_review' }, { status: 'mismatch', reviewResolvedAt: null },
  { invoiceMatchStatus: { $in: ['missing', 'mismatch'] }, reviewResolvedAt: null },
  { providerBalanceStatus: 'mismatch', reviewResolvedAt: null },
] });
const isReview = (row) => ['unknown', 'manual_review', 'delivery_pending'].includes(row.status) || row.internalReviewStatus === 'needs_review'
  || !row.reviewResolvedAt && (row.status === 'mismatch' || ['missing', 'mismatch'].includes(row.invoiceMatchStatus) || row.providerBalanceStatus === 'mismatch');
const confirmedProfit = (provider, row) => {
  if (row.status === 'refunded') return '0';
  if (row.status !== 'completed') return null;
  const cost = provider === 'alragheb' ? row.providerCostSyp : row.actualCostSyp;
  if (cost == null) return null;
  try {
    const sale = new Decimal(row.totalSyp ?? row.paynetAmountSyp), actual = new Decimal(cost);
    return sale.isFinite() && actual.isFinite() && actual.gte(0) ? sale.minus(actual).toFixed() : null;
  } catch { return null; }
};
const auditValue = (value, depth = 0) => {
  if (depth > 6 || value == null) return value == null ? value : null;
  if (value instanceof Date) return value;
  if (value instanceof mongoose.Types.ObjectId) return String(value);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => auditValue(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|token|secret|authorization|raw|digital.?codes|params|result/i.test(key))
    .slice(0, 100).map(([key, item]) => [key, auditValue(item, depth + 1)]));
  return typeof value === 'string' ? value.slice(0, 2000) : value;
};

function normalizeTransaction(provider, row, detail = false) {
  const user = row.user && typeof row.user === 'object' && row.user.email ? row.user : null;
  const errorHistory = Array.isArray(row.errorHistory) ? row.errorHistory.map((entry) => ({
    at: entry.at, code: safeCode(entry.code), phase: entry.phase, outcome: entry.outcome,
  })) : [];
  return {
    id: String(row._id), transaction_id: String(row._id), provider,
    payment_id: row.payment ? String(row.payment) : null,
    user_id: String(user?._id || row.user || ''), user_email: user?.email || row.userEmail || '', customer: user?.name || '',
    product_id: row.productId ?? row.itemCode, product_name: row.productName || row.itemName || row.itemTitle || '',
    qty: row.qty, provider_ref: row.providerOrderId || row.prowaveInvoice || row.prowaveRequestName || null,
    order_uuid: row.orderUuid || null, status: row.status, phase: row.phase || row.stage || null,
    provider_status: row.providerStatus || row.rechargeStatus || null,
    review: isReview(row), review_reason: row.reviewReason || row.internalReviewReason || row.mismatchReason || row.failureReason || '',
    total_amount_syp: String(row.totalSyp ?? row.paynetAmountSyp ?? '0'), currency: 'SYP',
    refunded_amount_syp: String(row.refundedAt ? row.totalSyp : row.paynetRefundedSyp || '0'),
    provider_cost: row.providerCostSyp ?? row.actualProviderDebitUsd ?? null,
    provider_currency: provider === 'alragheb' ? 'SYP' : 'USD',
    estimated_cost: row.providerCostEstimateSyp ?? row.expectedProviderDebitUsd ?? null,
    gross_profit_syp: confirmedProfit(provider, row),
    attempts: row.attempts || 0, last_error: row.lastError || row.lastErrorCode || row.failureCode || null,
    error_history: errorHistory, first_error: row.firstError || null, next_check_at: row.nextCheckAt, created_at: row.createdAt, updated_at: row.updatedAt,
    revision: row.__v || 0,
    ...(detail ? { params: row.params || (row.playerId ? { playerId: row.playerId } : {}), result: row.result ?? row.digitalCodes ?? null,
      resolution: row.resolution || null, invoice_match_status: row.invoiceMatchStatus, balance_match_status: row.providerBalanceStatus } : {}),
  };
}

function createProviderOperationsService({ balanceReaders = {} } = {}) {
  const balanceReads = new Map();
  async function getSettings(provider, session) {
    providerName(provider);
    const query = Settings.findOne({ provider });
    if (session) query.session(session);
    return settingsView(provider, await query.lean());
  }
  async function assertPurchasingAllowed(provider) {
    if (!(await getSettings(provider)).purchaseEnabled) fail('PURCHASE_DISABLED', 'أوقف المسؤول الشراء من هذا المزوّد مؤقتًا', 503);
  }
  async function recordAudit(values, session) {
    providerName(values.provider);
    const [audit] = await Audit.create([{ provider: values.provider, actor: values.actor, action: values.action, target: values.target,
      note: cleanNote(values.note), before: auditValue(values.before), after: auditValue(values.after), evidence: auditValue(values.evidence) }], session ? { session } : {});
    return audit;
  }
  async function saveSettings(provider, actor, body = {}) {
    providerName(provider);
    if (!Number.isSafeInteger(body.revision) || body.revision < 0 || Object.keys(body).some((key) => !['revision', 'note', ...Object.keys(DEFAULTS)].includes(key))) fail('INVALID_SETTINGS', 'إعدادات المزوّد غير صالحة');
    const note = cleanNote(body.note);
    const values = {};
    if (body.purchaseEnabled !== undefined) {
      if (typeof body.purchaseEnabled !== 'boolean') fail('INVALID_SETTINGS', 'حالة الشراء غير صالحة');
      values.purchaseEnabled = body.purchaseEnabled;
    }
    if (body.lowBalanceThreshold !== undefined) {
      if (!['number', 'string'].includes(typeof body.lowBalanceThreshold) || !/^\d{1,13}(\.\d{1,2})?$/.test(String(body.lowBalanceThreshold)) || new Decimal(body.lowBalanceThreshold).gt('1000000000000')) fail('INVALID_SETTINGS', 'حد تنبيه الرصيد غير صالح');
      values.lowBalanceThreshold = new Decimal(body.lowBalanceThreshold).toFixed();
    }
    for (const [key, max] of [['reviewAfterMinutes', 10080], ['workerConcurrency', 5]]) {
      if (body[key] !== undefined) {
        if (!Number.isSafeInteger(body[key]) || body[key] < 1 || body[key] > max) fail('INVALID_SETTINGS', 'مدة المراجعة أو عدد المعالجات غير صالح');
        values[key] = body[key];
      }
    }
    if (!Object.keys(values).length) fail('INVALID_SETTINGS', 'لم تحدد إعدادًا لتعديله');
    const session = await mongoose.startSession();
    try {
      return await session.withTransaction(async () => {
        const before = await getSettings(provider, session);
        if (before.revision !== body.revision) fail('SETTINGS_CHANGED', 'تغيرت الإعدادات، أعد تحميلها', 409);
        const after = before.revision ? await Settings.findOneAndUpdate({ provider, revision: before.revision }, {
          $set: { ...values, updatedBy: actor }, $inc: { revision: 1 },
        }, { new: true, session }) : (await Settings.create([{ provider, ...DEFAULTS, ...values, updatedBy: actor }], { session }))[0];
        if (!after) fail('SETTINGS_CHANGED', 'تغيرت الإعدادات، أعد تحميلها', 409);
        const view = settingsView(provider, after);
        await recordAudit({ provider, actor, action: 'settings_updated', target: provider, note, before, after: view }, session);
        return view;
      });
    } finally { await session.endSession(); }
  }
  async function recordWorkerHeartbeat(provider, event = {}) {
    providerName(provider);
    const now = new Date();
    const values = event.state === 'started' ? { lastStartedAt: now, leaseUntil: new Date(Date.now() + Math.min(600000, event.leaseMs || 120000)) }
      : { lastFinishedAt: now, leaseUntil: new Date(0), lastProcessed: Math.max(0, Number(event.processed) || 0),
        ...(event.state === 'succeeded' ? { lastSuccessAt: now, lastError: null, consecutiveFailures: 0 } : { lastError: safeCode(event.errorCode) }) };
    await Health.updateOne({ provider }, { $set: values, ...(event.state === 'failed' ? { $inc: { consecutiveFailures: 1 } } : {}) }, { upsert: true });
  }
  async function readBalance(provider, current) {
    if (current?.balance?.checkedAt && Date.now() - new Date(current.balance.checkedAt).getTime() < 60000) return current;
    if (balanceReads.has(provider)) return balanceReads.get(provider);
    const promise = (async () => {
      const currency = provider === 'alragheb' ? 'SYP' : 'USD';
      try {
        const reader = balanceReaders[provider] || (provider === 'alragheb'
          ? async () => ({ amount: (await require('./alraghebApi').getOperationalProfile()).balance, currency })
          : () => require('./proWaveOrder.service').readProviderBalance());
        const result = await reader();
        let amount;
        try { amount = new Decimal(result.amount); } catch { fail('INVALID_BALANCE_RESPONSE', 'تعذر التحقق من رصيد المزوّد', 502); }
        if (!amount.isFinite() || amount.lt(0) || result.currency !== currency) fail('INVALID_BALANCE_RESPONSE', 'تعذر التحقق من رصيد المزوّد', 502);
        return Health.findOneAndUpdate({ provider }, { $set: { balance: { amount: amount.toFixed(), currency, observedAt: new Date(), checkedAt: new Date(), status: 'available' } } }, { upsert: true, new: true }).lean();
      } catch (error) {
        return Health.findOneAndUpdate({ provider }, { $set: {
          'balance.checkedAt': new Date(), 'balance.status': 'unavailable', 'balance.errorCode': safeCode(error.code), 'balance.currency': currency,
        } }, { upsert: true, new: true }).lean();
      }
    })().finally(() => balanceReads.delete(provider));
    balanceReads.set(provider, promise);
    return promise;
  }
  async function getProviderHealth(provider, { refreshBalance = true } = {}) {
    providerName(provider);
    const settings = await getSettings(provider);
    let row = await Health.findOne({ provider }).lean();
    if (refreshBalance) row = await readBalance(provider, row);
    const balance = row?.balance || { currency: provider === 'alragheb' ? 'SYP' : 'USD', status: 'unavailable' };
    const balanceStale = !balance.observedAt || Date.now() - new Date(balance.observedAt).getTime() > 180000;
    const workerStale = !row?.lastSuccessAt || Date.now() - new Date(row.lastSuccessAt).getTime() > 300000;
    const worker = { lastStartedAt: row?.lastStartedAt, lastFinishedAt: row?.lastFinishedAt, lastSuccessAt: row?.lastSuccessAt,
      running: Boolean(row?.leaseUntil && new Date(row.leaseUntil) > new Date()), stale: workerStale,
      lastError: row?.lastError || null, lastProcessed: row?.lastProcessed || 0, consecutiveFailures: row?.consecutiveFailures || 0 };
    const transactions = modelFor(provider);
    const [counts, reviewCount, agedCount] = await Promise.all([
      transactions.aggregate([{ $group: { _id: '$status', count: { $sum: 1 }, oldestAt: { $min: '$createdAt' } } }]),
      transactions.countDocuments(reviewPredicate()),
      transactions.countDocuments({ status: { $in: ACTIVE }, createdAt: { $lt: new Date(Date.now() - settings.reviewAfterMinutes * 60000) } }),
    ]);
    const orders = { byStatus: Object.fromEntries(counts.map((item) => [item._id, { count: item.count, oldestAt: item.oldestAt }])),
      active: counts.filter((item) => ACTIVE.includes(item._id)).reduce((sum, item) => sum + item.count, 0), review: reviewCount, aged: agedCount };
    const alerts = [];
    const configured = provider === 'alragheb' ? Boolean(process.env.ALRAGHEB_API_TOKEN)
      : Boolean(process.env.PROWAVE_API_KEY && process.env.PROWAVE_API_SECRET);
    const providerGate = provider === 'alragheb' ? require('./alraghebPricing.service').enabled() && require('./alraghebPricing.service').moneyReady() && require('./alraghebApi').isCatalogEnabled() : true;
    const purchasing = { allowed: settings.purchaseEnabled && configured && providerGate, configured,
      reason: !settings.purchaseEnabled ? 'admin_stopped' : !configured ? 'connection_not_configured' : !providerGate ? 'provider_stopped' : 'ready' };
    if (!settings.purchaseEnabled) alerts.push({ code: 'PURCHASE_STOPPED', severity: 'info', message: 'الشراء متوقف بقرار المسؤول' });
    else if (!purchasing.allowed) alerts.push({ code: 'PURCHASE_UNAVAILABLE', severity: 'warning', message: configured ? 'الشراء متوقف في إعدادات اتصال المزوّد' : 'الاتصال بالمزوّد يحتاج تهيئة قبل الشراء' });
    if (balance.status !== 'available' || balanceStale) alerts.push({ code: 'BALANCE_UNAVAILABLE', severity: 'warning', message: 'رصيد المزوّد يحتاج تحديثًا' });
    else if (new Decimal(balance.amount).lte(settings.lowBalanceThreshold)) alerts.push({ code: 'LOW_BALANCE', severity: 'warning', message: 'رصيد المزوّد عند حد التنبيه أو أقل' });
    if (workerStale) alerts.push({ code: 'WORKER_STALE', severity: 'warning', message: 'لم ينجح فحص الطلبات خلال آخر خمس دقائق' });
    if (reviewCount) alerts.push({ code: 'ORDERS_NEED_REVIEW', severity: 'warning', count: reviewCount, message: 'طلبات تحتاج مراجعة المسؤول' });
    if (agedCount) alerts.push({ code: 'AGED_ORDERS', severity: 'warning', count: agedCount, message: 'طلبات تجاوزت مدة الانتظار المحددة' });
    return { worker, balance: { ...balance, stale: balanceStale }, purchasing, orders, alerts };
  }
  async function overview() {
    const providers = await Promise.all(PROVIDERS.map(async (provider) => ({ provider,
      label: provider === 'alragheb' ? 'الراغب Alragheb' : 'ProWave', settings: await getSettings(provider),
      health: await getProviderHealth(provider),
    })));
    return { providers: providers.map((row) => ({ ...row, orders: row.health.orders, alerts: row.health.alerts })), generatedAt: new Date().toISOString() };
  }
  async function transactionFilter(provider, query = {}) {
    providerName(provider);
    const filter = {};
    if (query.status) {
      if (!['pending', 'unknown', 'manual_review', 'delivery_pending', 'completed', 'failed', 'refunded', 'mismatch'].includes(query.status)) fail('INVALID_QUERY', 'حالة الطلب غير صالحة');
      filter.status = query.status;
    }
    if (query.review !== undefined) {
      if (!['true', 'false'].includes(query.review)) fail('INVALID_QUERY', 'مرشح المراجعة غير صالح');
      filter.$and = [query.review === 'true' ? reviewPredicate() : { $nor: reviewPredicate().$or }];
    }
    if (query.user) {
      if (!mongoose.isValidObjectId(query.user)) fail('INVALID_QUERY', 'معرّف المستخدم غير صالح');
      filter.user = query.user;
    }
    for (const key of ['from', 'to']) if (query[key]) {
      filter.createdAt ||= {};
      filter.createdAt[key === 'from' ? '$gte' : '$lt'] = dayBoundary(query[key], key === 'to');
    }
    if (query.search) {
      if (typeof query.search !== 'string' || query.search.length > 120) fail('INVALID_QUERY', 'نص البحث غير صالح');
      const regex = new RegExp(query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const users = await User.find({ $or: [{ email: regex }, { name: regex }] }).select('_id').limit(200).lean();
      filter.$or = [{ productName: regex }, { itemName: regex }, { itemTitle: regex }, { providerOrderId: regex }, { orderUuid: regex },
        { prowaveInvoice: regex }, { prowaveRequestName: regex }, { userEmail: regex }, { user: { $in: users.map((row) => row._id) } }];
      if (mongoose.isValidObjectId(query.search)) filter.$or.push({ _id: query.search });
    }
    return filter;
  }
  const LIST_FIELDS = '-params -result -digitalCodes -providerRequest -rawPurchaseResponse -rawCodesResponse -rawInvoice -rawDirectTopupStatusResponse -rawProviderBalanceBefore -rawProviderBalanceAfter';
  async function listTransactions(provider, query = {}, exporting = false) {
    const page = query.page === undefined ? 1 : Number(query.page);
    const limit = exporting ? 5000 : query.limit === undefined ? 20 : Number(query.limit);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(limit) || limit < 1 || (!exporting && limit > 100)) fail('INVALID_QUERY', 'التصفح غير صالح');
    const filter = await transactionFilter(provider, query);
    const model = modelFor(provider);
    const [total, rows] = await Promise.all([model.countDocuments(filter), model.find(filter).select(LIST_FIELDS).populate('user', 'email name').sort({ createdAt: -1 }).skip(exporting ? 0 : (page - 1) * limit).limit(limit).lean()]);
    return { data: rows.map((row) => normalizeTransaction(provider, row)), meta: { total, page: exporting ? 1 : page, limit, total_pages: Math.max(1, Math.ceil(total / limit)), truncated: exporting && total > limit } };
  }
  async function transactionDetail(provider, id) {
    if (!mongoose.isValidObjectId(id)) fail('ORDER_NOT_FOUND', 'الطلب غير موجود', 404);
    const row = await modelFor(provider).findById(id).populate('user', 'email name').lean();
    if (!row) fail('ORDER_NOT_FOUND', 'الطلب غير موجود', 404);
    const audits = await Audit.find({ provider, target: id }).sort({ createdAt: -1 }).limit(50).populate('actor', 'email name').lean();
    return { ...normalizeTransaction(provider, row, true), audit: audits };
  }
  async function listAudit(provider, query = {}) {
    providerName(provider);
    const page = query.page === undefined ? 1 : Number(query.page), limit = query.limit === undefined ? 20 : Number(query.limit);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_QUERY', 'التصفح غير صالح');
    const filter = { provider };
    const [total, rows] = await Promise.all([Audit.countDocuments(filter), Audit.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('actor', 'email name').lean()]);
    return { data: rows, meta: { total, page, limit, total_pages: Math.max(1, Math.ceil(total / limit)) } };
  }
  return { getSettings, assertPurchasingAllowed, saveSettings, recordAudit, recordWorkerHeartbeat, getProviderHealth, overview, listTransactions, transactionDetail, listAudit };
}
module.exports = { ...createProviderOperationsService(), createProviderOperationsService, normalizeTransaction, providerName, cleanNote, safeCode, dayBoundary, ACTIVE, DEFAULTS };
