// Read-only verification. Never invokes newOrder or writes to the application DB.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const provider = require('../services/alraghebApi');
const catalog = require('../services/alraghebCatalog.service');
const pricing = require('../services/alraghebPricing.service');
(async () => {
  const snapshot = await catalog.getCatalog({ force: true });
  const products = await provider.getProducts();
  assert.ok(Array.isArray(products));
  const categoryIds = new Set(snapshot.categories.map((c) => c.id));
  const expected = products.filter((p) => categoryIds.has(Number(p.parent_id)));
  const byId = new Map(snapshot.products.map((p) => [p.id, p]));
  assert.equal(byId.size, snapshot.products.length);
  assert.equal(expected.length, snapshot.products.length);
  let pricedProducts = 0;
  const distinctPrices = new Set();
  for (const raw of expected) {
    const actual = byId.get(Number(raw.id));
    assert.ok(actual, `Missing product ${raw.id}`);
    assert.equal(actual.provider_price, String(raw.price), `Price changed for ${raw.id}; rerun if provider changed during reads`);
    assert.deepEqual(actual.quantity_rules, catalog.normalizeQuantity(raw.qty_values));
    assert.equal(actual.available, raw.available === true);
    const preview = pricing.decorate(actual, null).pricing_preview;
    if (preview) {
      assert.equal(preview.price_per_billing_unit_syp, new pricing.Decimal(raw.price).toFixed());
      assert.equal(preview.total_amount_syp, new pricing.Decimal(raw.price).times(preview.qty).toFixed(2, pricing.Decimal.ROUND_HALF_UP));
      distinctPrices.add(preview.price_per_billing_unit_syp);
      pricedProducts += 1;
    }
  }
  const first = snapshot.products.find((p) => p.id === 57) || snapshot.products[0];
  const filtered = await provider.getProduct(first.id);
  assert.equal(String(filtered.price), first.provider_price);
  console.log(JSON.stringify({ passed: true, allProviderProducts: products.length, chatProducts: expected.length,
    checkedPrices: expected.length, checkedQuantities: expected.length, categories: snapshot.categories.length - 1,
    independentPricePreviews: pricedProducts, distinctUnitPrices: distinctPrices.size,
    filterVerified: true, financialRequests: 0, checkedAt: new Date().toISOString() }));
})().catch((error) => { console.error(error.name === 'AssertionError' ? error.message : error.code || 'LIVE_READ_FAILED'); process.exitCode = 1; });
