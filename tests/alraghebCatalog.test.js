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
  assert.equal(setup.service.getStatus().state, 'ready');
});

test('loads prices once and traverses every nested category through lightweight indexes', async () => {
  const calls = [];
  const content = {
    1: { products: [{ id: '57', name: 'App 57' }], categories: [{ id: 13, name: 'IMO', parent_id: 1 }] },
    13: { products: [{ id: '245', name: 'App 245' }], categories: [{ id: 99, name: 'Nested', parent_id: 13 }] },
    99: { products: [{ id: '999', name: 'App 999' }], categories: [] },
  };
  const service = createCatalogService({
    storage: { get: async () => null, set: async () => {} },
    client: {
      getProducts: async () => { calls.push('prices'); return [product(57, 1, { price: '0.123456789' }), product(245, 13), product(999, 99), product(101, 8)]; },
      getContentIndex: async (id) => { calls.push(id); return content[id]; },
      getContent: async () => { throw new Error('The heavy content endpoint must not block catalog browsing'); },
    },
  });
  const snapshot = await service.getCatalog();
  assert.deepEqual(calls, ['prices', 1, 13, 99]);
  assert.equal(snapshot.products.length, 3);
  assert.equal(snapshot.categories.length, 3);
  assert.equal(snapshot.products.find((p) => p.id === 57).provider_price, '0.123456789');
  assert.deepEqual(selectContent(snapshot, 99).data.breadcrumbs.map((c) => c.id), [1, 13, 99]);
});

test('an index with a missing or differently scoped product cannot publish partial prices', async () => {
  let rows = [product(57, 13)];
  let published = 0;
  const service = createCatalogService({
    storage: { get: async () => null, set: async () => { published += 1; } },
    client: {
      getProducts: async () => rows,
      getContentIndex: async () => ({ products: [{ id: 57, name: 'App' }], categories: [] }),
    },
  });
  await assert.rejects(service.getCatalog(), { code: 'ALRAGHEB_INVALID_RESPONSE' });
  rows = [];
  await assert.rejects(service.getCatalog({ force: true }), { code: 'ALRAGHEB_INVALID_RESPONSE' });
  rows = [product(57, 1), product(58, 1)];
  await assert.rejects(service.getCatalog({ force: true }), { code: 'ALRAGHEB_INVALID_RESPONSE' });
  assert.equal(published, 0);
});

test('keeps a complete snapshot on partial provider failure and marks it stale', async () => {
  const setup = fixture();
  await setup.service.getCatalog();
  setup.advance();
  setup.data[99] = new Error('provider unavailable');
  const stale = await setup.service.getCatalog();
  assert.equal(stale.stale, true);
  assert.equal(stale.products.length, 3);
  assert.equal(setup.service.getStatus().state, 'degraded');
  await assert.rejects(setup.service.getCatalog({ force: true }));
});

test('browsing returns the complete cached catalog immediately while one refresh runs', async () => {
  const setup = fixture();
  await setup.service.getCatalog();
  setup.advance();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  setup.data[13] = gate;
  const browsing = await setup.service.getCatalog({ background: true });
  const second = await setup.service.getCatalog({ background: true });
  assert.equal(browsing.products.length, 3);
  assert.equal(browsing.stale, true);
  assert.equal(browsing.refreshing, true);
  assert.equal(setup.service.getStatus().state, 'refreshing');
  assert.equal(selectContent(browsing, 1).meta.refreshing, true);
  assert.equal(second.refreshing, true);
  const fresh = setup.service.getCatalog();
  release({ products: [product(245, 13)], categories: [{ id: 99, name: 'Nested', parent_id: 13 }] });
  const result = await fresh;
  assert.equal(result.stale, undefined);
  assert.equal(result.products.length, 3);
  assert.equal(setup.calls.filter((id) => id === 13).length, 2);
});

test('a failed background refresh retains every product and observes the retry cooldown', async () => {
  const setup = fixture();
  await setup.service.getCatalog();
  setup.advance();
  setup.data[99] = Object.assign(new Error('slow provider category'), { code: 'ALRAGHEB_TIMEOUT' });
  const refreshing = await setup.service.getCatalog({ background: true });
  assert.equal(refreshing.products.length, 3);
  await assert.rejects(setup.service.getCatalog({ force: true }), { code: 'ALRAGHEB_TIMEOUT' });
  const callCount = setup.calls.length;
  const retained = await setup.service.getCatalog({ background: true });
  assert.equal(retained.stale, true);
  assert.equal(retained.refreshing, false);
  assert.equal(retained.products.length, 3);
  assert.equal(setup.calls.length, callCount);
});

test('a new service restores the last complete snapshot after restart and never publishes a partial tree', async () => {
  const setup = fixture();
  const saved = await setup.service.getCatalog();
  let published = 0;
  let stored = null;
  let providerCalls = 0;
  const service = createCatalogService({
    now: () => Date.parse(saved.synced_at) + 121000,
    storage: { get: async () => stored, set: async (_key, value) => { stored = value; } },
    snapshots: { namespace: () => 'isolated-account', load: async () => saved, save: async () => { published += 1; } },
    client: { getContent: async (id) => {
      providerCalls += 1;
      if (id === 1) return { products: [product(57, 1)], categories: [{ id: 13, name: 'IMO', parent_id: 1 }] };
      throw Object.assign(new Error('slow nested category'), { code: 'ALRAGHEB_TIMEOUT' });
    } },
  });
  const restored = await service.getCatalog();
  assert.equal(restored.stale, true);
  assert.equal(restored.products.length, 3);
  assert.equal(stored.products.length, 3);
  assert.equal(providerCalls, 2);
  assert.equal(published, 0);
});

test('a cold failed refresh is shared and does not repeatedly hammer the provider', async () => {
  let calls = 0;
  const service = createCatalogService({
    storage: { get: async () => null, set: async () => {} },
    client: { getContent: async () => { calls += 1; throw Object.assign(new Error('unavailable'), { code: 'ALRAGHEB_TIMEOUT' }); } },
  });
  await assert.rejects(service.getCatalog(), { code: 'ALRAGHEB_TIMEOUT' });
  await assert.rejects(service.getCatalog(), { code: 'ALRAGHEB_TIMEOUT' });
  assert.equal(calls, 1);
  assert.equal(service.getStatus().state, 'unavailable');
  assert.equal(service.getStatus().errorCode, 'ALRAGHEB_TIMEOUT');
  await assert.rejects(service.getCatalog({ force: true }), { code: 'ALRAGHEB_TIMEOUT' });
  assert.equal(calls, 2);
});

test('a snapshot older than one hour cannot become a current or purchasable catalog', async () => {
  const setup = fixture();
  const saved = await setup.service.getCatalog();
  const service = createCatalogService({
    now: () => Date.parse(saved.synced_at) + 3600001,
    storage: { get: async () => null, set: async () => {} },
    snapshots: { load: async () => saved, save: async () => {} },
    client: { getContent: async () => { throw Object.assign(new Error('unavailable'), { code: 'ALRAGHEB_TIMEOUT' }); } },
  });
  await assert.rejects(service.getCatalog(), { code: 'ALRAGHEB_TIMEOUT' });
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
