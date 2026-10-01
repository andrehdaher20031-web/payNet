const test = require('node:test');
const assert = require('node:assert/strict');
const { activationConfig } = require('../scripts/activate-alragheb');
const { normalizeProduct } = require('../services/alraghebCatalog.service');

const product = (overrides = {}) => normalizeProduct({ id: 754, name: 'Package', parent_id: 21, price: '1.4336827499999998',
  params: [], product_type: 'package', qty_values: null, available: true, ...overrides }, 21);

test('activates fixed packages and single documented account fields per product', () => {
  const pack = activationConfig(product());
  assert.equal(pack.productId, 754);
  assert.equal(pack.billingUnitQty, 1);
  assert.equal(pack.purchaseEnabled, true);
  assert.deepEqual(pack.fieldSchema, []);
  const chat = activationConfig(product({ id: 4, name: 'SOULHILL', params: ['Please enter your user ID'], product_type: 'amount', qty_values: { min: 1000, max: 1000000 }, price: '0.23977917611178512' }));
  assert.equal(chat.productId, 4);
  assert.deepEqual(chat.fieldSchema, [{ key: 'playerId', label: 'Please enter your user ID', required: true }]);
  assert.notEqual(pack.contractHash, chat.contractHash);
  assert.equal(Object.hasOwn(chat, 'price'), false);
});

test('does not invent mappings for duplicate, unknown or missing account labels', () => {
  assert.equal(activationConfig(product({ params: ['Please enter your user ID', 'Please enter your user ID'] })), null);
  assert.equal(activationConfig(product({ params: ['Server ID'] })), null);
  assert.equal(activationConfig(product({ product_type: 'amount', qty_values: { min: 1, max: 100 } })), null);
  assert.throws(() => activationConfig(product({ price: '0' })), { code: 'INVALID_PRICING' });
});
