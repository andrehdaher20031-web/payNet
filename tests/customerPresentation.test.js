const test = require('node:test');
const assert = require('node:assert/strict');
const { customerPayment } = require('../utils/customerPayment');
const { normalizeProduct, serializeProduct, selectContent } = require('../services/alraghebCatalog.service');

test('legacy customer receipts hide supplier labels without editing stored records or delivery codes', () => {
  const original = { _id: 'receipt-id', company: 'Alragheb', speed: 'https://alragheb-store.com/category/21',
    note: 'Alragheb rejected the request', amount: 10.25,
    extra: { provider: 'alragheb', transaction_id: 'original-reference', product_name: 'Alragheb package', digital_codes: ['ALRAGHEB-OPAQUE-DELIVERY-CODE'] } };
  const before = JSON.stringify(original);
  const receipt = customerPayment(original);
  assert.equal(receipt.company, 'تطبيقات الدردشة');
  assert.equal(receipt.speed, 'PayNet');
  assert.doesNotMatch(receipt.note + receipt.extra.product_name, /alragheb/i);
  assert.deepEqual(receipt.extra.digital_codes, original.extra.digital_codes);
  assert.equal(receipt.extra.transaction_id, 'original-reference');
  assert.equal(receipt.extra.provider, 'alragheb');
  assert.equal(receipt.amount, 10.25);
  assert.equal(JSON.stringify(original), before);
});

test('customer catalog names and breadcrumbs are neutral while administrative product data retain their source', () => {
  const product = normalizeProduct({ id: 57, parent_id: 13, name: 'Alragheb Package', category_name: 'الراغب',
    params: ['Alragheb account ID'], available: true, product_type: 'package', qty_values: null, price: '1.2345' }, 13);
  const visible = serializeProduct(product);
  assert.doesNotMatch(visible.name + visible.category_name + visible.params.join(' '), /alragheb|الراغب/i);
  assert.equal(serializeProduct(product, true).name, 'Alragheb Package');
  const content = selectContent({ categories: [{ id: 1, parent_id: 0, name: 'Alragheb Chat' }, { id: 13, parent_id: 1, name: 'الراغب Packages' }], products: [product], synced_at: new Date().toISOString() }, 13);
  assert.doesNotMatch(content.data.category.name + content.data.breadcrumbs.map((c) => c.name).join(' '), /alragheb|الراغب/i);
  assert.equal(product.provider_price, '1.2345');
});

test('unrelated providers, prices and credentials are preserved in customer history', () => {
  const original = { company: 'Internet service', speed: '100 Mbps', amount: 12.55, extra: { provider: 'prowave', digital_codes: ['voucher-123'] } };
  const receipt = customerPayment(original);
  assert.equal(receipt.company, original.company);
  assert.equal(receipt.speed, original.speed);
  assert.equal(receipt.amount, original.amount);
  assert.deepEqual(receipt.extra.digital_codes, original.extra.digital_codes);
});
