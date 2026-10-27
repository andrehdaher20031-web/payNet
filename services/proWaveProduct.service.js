const Config = require('../models/ProWaveProductConfig');
const mongoose = require('mongoose');
const { Decimal } = require('./proWaveProtocol.service');
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
async function getConfig(itemCode, operationType = 'digital_card', currency = 'USD') {
  return Config.findOne({ itemCode, operationType, currency }).lean();
}
function applyPricing(pricing, config) {
  if (config?.purchaseEnabled === false) fail('شراء هذا المنتج متوقف مؤقتاً', 503);
  const sale = new Decimal(config?.salePriceUsd ?? pricing.saleUnitPriceUsd ?? pricing.unitPriceUsd);
  const cost = new Decimal(pricing.providerUnitCostUsd);
  if (!sale.isFinite() || sale.lte(0) || sale.lt(cost)) fail('سعر بيع المنتج أقل من تكلفة المزوّد؛ يحتاج مراجعة', 409);
  const margin = config?.marginPercent ?? pricing.marginPercent ?? 0;
  const base = sale.mul(pricing.exchangeRate);
  const beforeRounding = base.mul(new Decimal(1).plus(new Decimal(margin).div(100)));
  const step = new Decimal(pricing.roundingStep || 1);
  const unit = beforeRounding.div(step).ceil().mul(step);
  const total = unit.mul(pricing.qty || 1);
  if (!total.isFinite() || !Number.isSafeInteger(total.toNumber()) || total.lte(0)) fail('قيمة الشراء خارج المجال المسموح');
  return { ...pricing, unitPriceUsd: sale.toNumber(), saleUnitPriceUsd: sale.toNumber(), marginPercent: margin,
    baseUnitAmountSyp: base.toNumber(), unitAmountBeforeRoundingSyp: beforeRounding.toNumber(), unitAmountSyp: unit.toNumber(),
    totalAmountSyp: total.toNumber(), providerDiscountUsd: sale.minus(cost).toNumber(),
    providerDiscountPercent: sale.minus(cost).div(sale).mul(100).toDecimalPlaces(4).toNumber(), productConfigRevision: config?.revision || 0 };
}
async function updateConfig(itemCode, input, actor) {
  if (typeof itemCode !== 'string' || !itemCode.trim() || itemCode.length > 256) fail('معرّف المنتج غير صالح');
  const operationType = input.operationType || 'digital_card';
  if (!['digital_card', 'direct_topup'].includes(operationType) || (input.currency || 'USD') !== 'USD') fail('نوع العملية أو العملة غير صالح');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) fail('نسخة الإعدادات مطلوبة');
  if (typeof input.note !== 'string' || input.note.trim().length < 10) fail('سبب التغيير يجب ألا يقل عن 10 أحرف');
  const changes = { updatedBy: actor, note: input.note.trim() };
  if (input.purchaseEnabled !== undefined) {
    if (typeof input.purchaseEnabled !== 'boolean') fail('حالة الشراء غير صالحة');
    changes.purchaseEnabled = input.purchaseEnabled;
  }
  if (input.salePriceUsd !== undefined) {
    if (input.salePriceUsd === null) changes.salePriceUsd = null;
    else { try { const value = new Decimal(input.salePriceUsd); if (!value.isFinite() || value.lte(0) || value.gt(100000)) fail('سعر البيع غير صالح'); changes.salePriceUsd = value.toFixed(); } catch { fail('سعر البيع غير صالح'); } }
  }
  if (input.marginPercent !== undefined) {
    if (input.marginPercent !== null && (!Number.isFinite(input.marginPercent) || input.marginPercent < 0 || input.marginPercent > 1000)) fail('الهامش غير صالح');
    changes.marginPercent = input.marginPercent;
  }
  const query = { itemCode, operationType, currency: 'USD' };
  const before = await Config.findOne(query).lean();
  if ((before?.revision || 0) !== input.revision) fail('تغيرت الإعدادات؛ حدّث الصفحة وأعد المحاولة', 409);
  let updated;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      updated = await Config.findOneAndUpdate({ ...query, revision: input.revision }, { $set: changes, $inc: { revision: 1 } }, { upsert: !before, new: true, runValidators: true, session });
      if (!updated) fail('تغيرت الإعدادات؛ حدّث الصفحة وأعد المحاولة', 409);
      await require('./providerOperations.service').recordAudit({ provider: 'prowave', actor, action: 'product_config_updated', target: itemCode, note: changes.note, before, after: updated.toObject() }, session);
    });
  } catch (error) { if (error.code === 11000) fail('تغيرت الإعدادات؛ حدّث الصفحة وأعد المحاولة', 409); throw error; }
  finally { await session.endSession(); }
  return updated;
}
module.exports = { getConfig, applyPricing, updateConfig, listConfigs: () => Config.find({}).sort({ itemCode: 1 }).lean() };
