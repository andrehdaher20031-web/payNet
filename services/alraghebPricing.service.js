const Decimal = require('decimal.js').clone({ precision: 50 });
const { createHash } = require('crypto');
const { alraghebError } = require('./alraghebApi');
const fail = (code, message, status = 400) => { throw alraghebError(code, message, status); };
const enabled = () => process.env.ALRAGHEB_PURCHASE_ENABLED === 'true';
const ROUNDING_POLICY = 'syp_2dp';
const MAX_WALLET_SYP = 1000000000000;
const moneyReady = () => process.env.ALRAGHEB_ROUNDING_POLICY === ROUNDING_POLICY;
const contractHash = (p) => createHash('sha256').update(JSON.stringify([p.params, p.quantity_rules, p.product_type])).digest('hex');
const positiveInt = (v) => ['number', 'string'].includes(typeof v) && /^\d+$/.test(String(v)) && Number.isSafeInteger(Number(v)) && Number(v) > 0;
function validateQuantity(rules, qty) {
  if (!positiveInt(qty)) fail('INVALID_QUANTITY', 'الكمية يجب أن تكون عددًا صحيحًا موجبًا');
  qty = Number(qty);
  const valid = rules?.mode === 'fixed' ? qty === rules.defaultQty
    : rules?.mode === 'choices' ? rules.values.includes(qty)
      : rules?.mode === 'range' && qty >= rules.min && qty <= rules.max;
  if (!valid) fail('INVALID_QUANTITY', 'الكمية خارج القيم المسموحة للمنتج');
  return qty;
}
function validateMarkup(body = {}) {
  const result = {};
  for (const [key, max] of [['markupPercent', 1000], ['markupFixedSyp', 1000000000]]) {
    const value = body[key] === undefined ? '0' : body[key];
    if (!['string', 'number'].includes(typeof value) || !/^\d{1,10}(\.\d{1,2})?$/.test(String(value)) || new Decimal(value).gt(max)) {
      fail('INVALID_MARKUP', 'الربح يجب أن يكون قيمة موجبة أو صفرًا بمنزلتين عشريتين؛ الحد الأقصى للنسبة 1000% وللإضافة مليار ليرة');
    }
    result[key] = new Decimal(value).toFixed();
  }
  return result;
}
function calculate(price, qty, billingUnitQty, markup = {}) {
  if (!positiveInt(qty) || !positiveInt(billingUnitQty)) fail('INVALID_PRICING', 'وحدة التسعير غير معتمدة');
  let unit;
  try { unit = new Decimal(price); } catch { fail('INVALID_PRICING', 'سعر المنتج غير صالح'); }
  if (!unit.isFinite() || !unit.gt(0)) fail('INVALID_PRICING', 'سعر المنتج غير صالح');
  const rule = validateMarkup(markup);
  const providerCost = unit.times(qty).div(billingUnitQty);
  const saleUnit = unit.times(new Decimal(rule.markupPercent).div(100).plus(1));
  const raw = saleUnit.times(qty).div(billingUnitQty).plus(rule.markupFixedSyp);
  const total = raw.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (total.gt(MAX_WALLET_SYP) || total.lte(0)) fail('INVALID_PRICING', 'المبلغ خارج الحدود المسموحة');
  return { price: unit.toFixed(), saleUnitPrice: saleUnit.toFixed(), ...rule,
    providerCostEstimateSyp: providerCost.toFixed(), estimatedProfitSyp: total.minus(providerCost).toFixed(),
    totalBeforeRoundingSyp: raw.toFixed(), totalSyp: total.toFixed(2) };
}
// Decimal arithmetic inside the atomic update avoids binary drift in the legacy Number wallet.
const walletAdjustment = (amount) => [{ $set: { balance: { $toDouble: {
  $add: [{ $toDecimal: '$balance' }, { $toDecimal: String(amount) }],
} } } }];
const reserved = new Set(['qty', 'product_id', 'order_uuid', '__proto__', 'constructor', 'prototype', 'api-token']);
function validateFields(schema, params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail('INVALID_FIELDS', 'بيانات الشحن غير صالحة');
  if (Object.keys(params).some((key) => reserved.has(key) || !schema.some((f) => f.key === key))) fail('INVALID_FIELDS', 'حقل شحن غير مسموح');
  const clean = {};
  for (const field of schema) {
    const value = params[field.key];
    if (value !== undefined && typeof value !== 'string') fail('INVALID_FIELDS', 'بيانات الحساب يجب أن تكون نصًا');
    const text = (value || '').trim();
    if ((field.required && !text) || text.length > 200 || /[\x00-\x1f]/.test(text)) fail('INVALID_FIELDS', `قيمة غير صالحة: ${field.label}`);
    if (text) clean[field.key] = text;
  }
  return clean;
}
function validateConfig(body, product) {
  if (typeof body.purchaseEnabled !== 'boolean' || !positiveInt(body.billingUnitQty) || !Number.isInteger(body.revision)) fail('INVALID_CONFIG', 'إعداد المنتج غير صالح');
  if (typeof body.note !== 'string' || body.note.trim().length < 3 || body.note.length > 500) fail('INVALID_CONFIG', 'أدخل مرجع اعتماد وحدة السعر والحقول');
  if (!Array.isArray(body.fieldSchema) || body.fieldSchema.length !== product.params.length || body.fieldSchema.length > 20) fail('INVALID_CONFIG', 'يجب اعتماد مفتاح لكل حقل شحن');
  const keys = new Set();
  const fields = body.fieldSchema.map((field, index) => {
    if (!field || typeof field.key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(field.key) || reserved.has(field.key) || keys.has(field.key) || typeof field.required !== 'boolean') fail('INVALID_CONFIG', 'مفاتيح الشحن غير صالحة أو مكررة');
    keys.add(field.key);
    return { key: field.key, label: product.params[index], required: field.required };
  });
  validateQuantity(product.quantity_rules, product.quantity_rules.defaultQty);
  const markup = validateMarkup(body);
  calculate(product.provider_price, product.quantity_rules.defaultQty, body.billingUnitQty, markup);
  return { productId: product.id, purchaseEnabled: body.purchaseEnabled, billingUnitQty: Number(body.billingUnitQty), ...markup, fieldSchema: fields, contractHash: contractHash(product), note: body.note.trim() };
}
function decorate(product, config, stale = false) {
  const matching = config && config.contractHash === contractHash(product);
  let preview = null;
  if (matching || (!config && ['amount', 'package', 'specificPackage'].includes(product.product_type))) {
    try {
      const qty = product.quantity_rules.mode === 'choices' ? Math.min(...product.quantity_rules.values) : product.quantity_rules.defaultQty;
      // The provider storefront multiplies this product's price by quantity; reviewed overrides stay per product.
      const billingUnitQty = matching ? config.billingUnitQty : 1;
      const price = calculate(product.provider_price, qty, billingUnitQty, matching ? config : {});
      preview = { currency: 'SYP', qty, price_per_billing_unit_syp: price.saleUnitPrice, fixed_fee_syp: price.markupFixedSyp, billing_unit_qty: billingUnitQty, total_amount_syp: price.totalSyp, rounding_policy: ROUNDING_POLICY };
    } catch { /* Invalid supplier prices never become a zero-priced offer. */ }
  }
  const reason = !matching || !preview ? 'not_configured' : !product.available ? 'unavailable' : stale ? 'stale' : !config.purchaseEnabled ? 'product_disabled' : !enabled() || !moneyReady() ? 'purchase_disabled' : 'ready';
  return { currency: 'SYP', pricing_preview: preview, input_fields: matching ? config.fieldSchema : [], purchasable: reason === 'ready', purchase_status: reason };
}
module.exports = { Decimal, ROUNDING_POLICY, MAX_WALLET_SYP, walletAdjustment, fail, enabled, moneyReady, positiveInt, contractHash, validateQuantity, validateFields, validateConfig, validateMarkup, calculate, decorate };
