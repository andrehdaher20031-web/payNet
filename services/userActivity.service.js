const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const Activity = require('../models/UserActivity');
const User = require('../models/User');
const RETENTION_DAYS = 180;
const safeCode = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,70}$/.test(value) ? value : undefined;
const text = (value, max = 120) => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g, '').slice(0, max) : undefined;

async function record(event) {
  const now = new Date();
  const occurredAt = event.occurredAt || now;
  const data = {
    user: event.user || null, actor: event.actor, eventKey: event.eventKey || randomUUID(),
    eventType: event.eventType, source: event.source || 'server', occurredAt,
    expiresAt: new Date(+occurredAt + RETENTION_DAYS * 86400000),
    provider: text(event.provider, 24), productId: text(String(event.productId || ''), 80),
    productName: text(event.productName), categoryId: text(String(event.categoryId || ''), 80),
    route: text(event.route, 120), status: text(event.status, 24), errorCode: safeCode(event.errorCode),
    referenceId: text(String(event.referenceId || ''), 80), sessionId: text(event.sessionId, 80),
    device: text(event.device, 40), httpStatus: event.httpStatus,
  };
  try { return await Activity.updateOne({ eventKey: data.eventKey }, { $setOnInsert: data }, { upsert: true }); }
  catch (error) { if (error.code !== 11000) throw error; return { upsertedCount: 0 }; }
}

async function safeRecord(event) {
  try { return await record(event); }
  catch { console.warn('User activity write failed'); return null; }
}

function deviceLabel(agent = '') {
  const os = /Android/i.test(agent) ? 'Android' : /iPhone|iPad/i.test(agent) ? 'iOS' : /Windows/i.test(agent) ? 'Windows' : /Mac/i.test(agent) ? 'macOS' : 'Other';
  const browser = /Edg/i.test(agent) ? 'Edge' : /Firefox/i.test(agent) ? 'Firefox' : /Chrome/i.test(agent) ? 'Chrome' : /Safari/i.test(agent) ? 'Safari' : 'Other';
  return `${os} / ${browser}`;
}

// Only explicit, visible browser activity is a visit; polling and provider workers are not.
async function touch(user) {
  const now = new Date();
  return User.updateOne({ _id: user, $or: [{ lastSeenAt: null }, { lastSeenAt: { $lt: new Date(+now - 60000) } }] },
    { $max: { lastSeenAt: now } });
}

function observeRequests(req, res, next) {
  const requestId = randomUUID();
  res.set('X-Request-Id', requestId);
  const originalJson = res.json;
  let result;
  res.json = function (body) { result = body; return originalJson.call(this, body); };
  res.once('finish', () => {
    if (!mongoose.isValidObjectId(req.user?.id) || req.path.includes('user-monitoring') || req.path.includes('/activity') || req.path === '/api/login') return;
    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (!mutation) return;
    const provider = /^\/api\/(alragheb|prowave|aleso)\//.exec(req.path)?.[1] || (req.path === '/api/payment/internet-full' ? 'paynet' : undefined);
    const data = result?.data || result || {};
    const quote = /\/quote$/.test(req.path);
    const admin = req.path.startsWith('/api/admin/');
    const success = res.statusCode < 400;
    const purchase = /\/(order|purchase|internet-full|requests)$/.test(req.path);
    const suppliedId = req.get('X-Monitoring-Product');
    const productId = quote || purchase ? data.product_id || data.itemCode || req.body?.product_id || req.body?.productId || req.body?.itemCode || req.body?.item_code || (typeof suppliedId === 'string' && /^[\w.-]{1,80}$/.test(suppliedId) ? suppliedId : undefined) : undefined;
    let suppliedName;
    if (provider === 'paynet') {
      try { suppliedName = decodeURIComponent(req.get('X-Monitoring-Name') || ''); } catch {}
    }
    const eventType = !success ? 'request_failed' : quote ? 'quote_created' : admin ? 'admin_action' : 'request_accepted';
    const event = {
      eventKey: requestId, user: req.user.id, actor: req.user.id, eventType, provider,
      route: req.path.replace(/[a-f0-9]{24}/gi, ':id').slice(0, 120),
      status: success ? 'accepted' : 'failed', httpStatus: res.statusCode,
      errorCode: safeCode(result?.code) || (success ? undefined : result?.message === 'الرصيد غير كافٍ' ? 'INSUFFICIENT_BALANCE' : `HTTP_${res.statusCode}`),
      productId,
      productName: quote || purchase ? data.product_name || data.productName || data.itemName || suppliedName : undefined,
      referenceId: data.transaction_id || data.quote_id || result?.payment?._id,
    };
    const target = /^\/api\/admin\/(?:updateuser|addbatch|deleteuser)\/([a-f0-9]{24})$/i.exec(req.originalUrl.split('?')[0]);
    if (target) { event.user = target[1]; event.referenceId = target[1]; }
    void safeRecord(event);
  });
  next();
}

module.exports = { record, safeRecord, touch, deviceLabel, observeRequests, safeCode, RETENTION_DAYS };
