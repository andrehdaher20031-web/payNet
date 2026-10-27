const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const provider = require('../services/alraghebApi');

test('financial requests distinguish a connection never established from an uncertain timeout and redact credentials', async (t) => {
  const previous = process.env.ALRAGHEB_API_TOKEN;
  process.env.ALRAGHEB_API_TOKEN = 'isolated-fake-provider-token';
  t.after(() => { if (previous === undefined) delete process.env.ALRAGHEB_API_TOKEN; else process.env.ALRAGHEB_API_TOKEN = previous; });
  let code = 'ENOTFOUND';
  t.mock.method(axios, 'get', async () => { throw Object.assign(new Error('Secret upstream response'), { code, config: { headers: { 'api-token': 'isolated-fake-provider-token' } } }); });
  await assert.rejects(provider.newOrder(57, 1, {}, 'fake-order-uuid'), (error) => error.requestOutcome === 'not_sent' && !JSON.stringify(error).includes('isolated-fake-provider-token'));
  code = 'ECONNABORTED';
  await assert.rejects(provider.newOrder(57, 1, {}, 'fake-order-uuid'), { requestOutcome: 'unknown', code: 'ALRAGHEB_TIMEOUT' });
});

test('provider top-level errors never authorize a timeout refund or a blind financial resend', async (t) => {
  const previous = process.env.ALRAGHEB_API_TOKEN;
  process.env.ALRAGHEB_API_TOKEN = 'isolated-fake-provider-token';
  t.after(() => { if (previous === undefined) delete process.env.ALRAGHEB_API_TOKEN; else process.env.ALRAGHEB_API_TOKEN = previous; });
  t.mock.method(axios, 'get', async () => ({ data: { error: 'provider-declined' } }));
  await assert.rejects(provider.newOrder(57, 1, {}, 'fake-order-uuid'), { requestOutcome: 'unknown', code: 'ALRAGHEB_PROVIDER_ERROR' });
});

test('large read-only content requests have a separate timeout from financial operations', async (t) => {
  const previousToken = process.env.ALRAGHEB_API_TOKEN;
  const previousEnabled = process.env.ALRAGHEB_CATALOG_ENABLED;
  process.env.ALRAGHEB_API_TOKEN = 'isolated-fake-provider-token';
  process.env.ALRAGHEB_CATALOG_ENABLED = 'true';
  t.after(() => {
    if (previousToken === undefined) delete process.env.ALRAGHEB_API_TOKEN; else process.env.ALRAGHEB_API_TOKEN = previousToken;
    if (previousEnabled === undefined) delete process.env.ALRAGHEB_CATALOG_ENABLED; else process.env.ALRAGHEB_CATALOG_ENABLED = previousEnabled;
  });
  const calls = [];
  t.mock.method(axios, 'get', async (path, config) => { calls.push({ path, timeout: config.timeout, params: config.params }); return { data: {} }; });
  await provider.getContent(21);
  await provider.getContentIndex(21);
  await provider.getProduct(57).catch(() => {});
  await provider.newOrder(57, 1, {}, 'fake-order-uuid');
  await provider.checkOrder('fake-order-uuid');
  assert.deepEqual(calls.map((call) => call.timeout), [45000, 45000, 20000, 20000, 20000]);
  assert.deepEqual(calls[1].params, { base: 1 });
});
