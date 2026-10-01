const test = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('../services/alraghebPricing.service');
const { normalizeProduct } = require('../services/alraghebCatalog.service');

test('catalog estimates have independent provider prices without enabling unconfigured purchases', () => {
  const app = (id, price) => normalizeProduct({ id, name: `App ${id}`, parent_id: 1, params: [], product_type: 'amount', available: true, price, qty_values: { min: 2000, max: 10000 } }, 1);
  const first = pricing.decorate(app(4, '0.23977917611178512'), null);
  const second = pricing.decorate(app(143, '0.02046460624385496'), null);
  assert.equal(first.pricing_preview.total_amount_syp, '479.56');
  assert.equal(second.pricing_preview.total_amount_syp, '40.93');
  assert.equal(first.purchasable, false);
  assert.equal(first.purchase_status, 'not_configured');
  assert.equal(second.purchasable, false);
  const product = app(8, '10');
  const reviewed = pricing.decorate(product, { contractHash: pricing.contractHash(product), billingUnitQty: 1000, purchaseEnabled: false });
  assert.equal(reviewed.pricing_preview.total_amount_syp, '20.00');
  assert.equal(pricing.decorate(product, { contractHash: 'outdated', billingUnitQty: 1000 }).pricing_preview, null);
});

test('specificPackage products preserve the provider choice quantities and their own prices', () => {
  const product = normalizeProduct({ id: 817, name: 'FALLA', parent_id: 1, params: [], available: true,
    price: '0.000173990625', product_type: 'specificPackage', qty_values: ['170000', '340000'] }, 1);
  assert.equal(product.product_type, 'specificPackage');
  const preview = pricing.decorate(product, null).pricing_preview;
  assert.equal(preview.qty, 170000);
  assert.equal(preview.total_amount_syp, '29.58');
  assert.equal(pricing.calculate(product.provider_price, 340000, 1).totalSyp, '59.16');
  assert.throws(() => pricing.validateQuantity(product.quantity_rules, 170001), { code: 'INVALID_QUANTITY' });
});
