const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCatalogService, normalizeQuantity, parseQuery, selectContent, selectProducts,
} = require('../services/alraghebCatalog.service');

const product = (id, parent, overrides = {}) => ({
  id, parent_id: parent, name: `App ${id}`, category_name: parent === 1 ? 'Applications' : 'IMO',
  available: true, product_type: 'amount', params: ['Account ID'],
  qty_values: { min: '10', max: '500' }, price: 0.03, base_price: null,
  category_img: 'https://api.alragheb-store.com/', ...overrides,
});

const fixture = () => {
  let now = 1000000;
  let stored = null;
  const calls = [];
  const data = {
    1: { products: [product(57, 1)], categories: [{ id: 13, name: 'IMO', parent_id: 1 }] },
    13: { products: [product(245, 13, { available: false })], categories: [{ id: 99, name: 'Nested', parent_id: 13 }] },
    99: { products: [product(999, 99)], categories: [] },
  };
  const service = createCatalogService({
    client: { getContent: async (id) => { calls.push(id); if (data[id] instanceof Error) throw data[id]; return data[id]; } },
    storage: { get: async () => stored, set: async (_key, value) => { stored = value; } },
    now: () => now,
  });
  return { service, data, calls, advance: () => { now += 121000; } };
};

test('imports every descendant, de-duplicates concurrent refreshes and uses the cache', async () => {
  const setup = fixture();
  const [first, second] = await Promise.all([setup.service.getCatalog(), setup.service.getCatalog()]);
  assert.deepEqual(first, second);
  assert.equal(first.products.length, 3);
  assert.equal(first.categories.length, 3);
  assert.deepEqual(setup.calls, [1, 13, 99]);
  await setup.service.getCatalog();
  assert.equal(setup.calls.length, 3);
});

test('keeps a complete snapshot on partial provider failure and marks it stale', async () => {
  const setup = fixture();
  await setup.service.getCatalog();
  setup.advance();
  setup.data[99] = new Error('provider unavailable');
  const stale = await setup.service.getCatalog();
  assert.equal(stale.stale, true);
  assert.equal(stale.products.length, 3);
  await assert.rejects(setup.service.getCatalog({ force: true }));
});

test('rejects malformed content and category cycles instead of publishing a partial catalog', async () => {
  const setup = fixture();
  setup.data[13] = { error: 'failed' };
  await assert.rejects(setup.service.getCatalog(), { code: 'ALRAGHEB_INVALID_RESPONSE' });
  setup.data[13] = { products: [], categories: [{ id: 1, name: 'cycle', parent_id: 13 }] };
  await assert.rejects(setup.service.getCatalog({ force: true }), { code: 'ALRAGHEB_INVALID_RESPONSE' });
});

test('lists direct products, searches descendants and builds breadcrumbs', async () => {
  const { service } = fixture();
  const snapshot = await service.getCatalog();
  const root = selectContent(snapshot, 1);
  assert.deepEqual(root.data.products.map((p) => p.id), [57]);
  assert.equal(root.data.categories[0].product_count, 2);
  assert.equal(root.data.category.product_count, 3);
  assert.equal(selectContent(snapshot, 1, { search: '999' }).data.products[0].id, 999);
  assert.equal(selectContent(snapshot, 1, { scope: 'all' }).meta.total, 3);
  assert.deepEqual(selectContent(snapshot, 99).data.breadcrumbs.map((c) => c.id), [1, 13, 99]);
  assert.throws(() => selectContent(snapshot, 2), { status: 404 });
});

test('applies filters before pagination and never leaks supplier prices to customers', async () => {
  const { service } = fixture();
  const snapshot = await service.getCatalog();
  const page = selectProducts(snapshot, { limit: '1', page: '2' });
  assert.equal(page.meta.total, 3);
  assert.equal(page.data.length, 1);
  assert.equal(page.meta.page, 2);
  const all = selectProducts(snapshot, {});
  for (const item of all.data) {
    assert.equal(Object.hasOwn(item, 'provider_price'), false);
    assert.equal(Object.hasOwn(item, 'provider_base_price'), false);
    assert.equal(item.purchasable, false);
    assert.equal(item.image_url, '');
  }
  assert.equal(selectProducts(snapshot, {}, { admin: true }).data[0].provider_base_price, null);
  assert.equal(selectProducts(snapshot, { available: 'false' }).meta.total, 1);
  assert.deepEqual(selectProducts(snapshot, { products_id: '57,999' }).data.map((p) => p.id), [57, 999]);
});

test('quantity rules preserve valid choices and reject unsupported or fractional constraints', () => {
  assert.equal(normalizeQuantity(null).defaultQty, 1);
  assert.equal(normalizeQuantity({ min: 1, max: '1' }).mode, 'fixed');
  assert.deepEqual(normalizeQuantity(['100', '150', '100']).values, [100, 150]);
  assert.equal(normalizeQuantity({ min: '10', max: '500' }).mode, 'range');
  for (const value of [undefined, [], ['bad'], [1.5], { min: 500, max: 10 }]) {
    assert.equal(normalizeQuantity(value).mode, 'unsupported');
  }
});

test('rejects invalid filters, array query injection and unbounded pages', () => {
  for (const query of [{ limit: '10000' }, { page: '1.5' }, { available: 'yes' }, { search: ['secret'] }, { products_id: '57,no' }]) {
    assert.throws(() => parseQuery(query), { status: 400 });
  }
});
