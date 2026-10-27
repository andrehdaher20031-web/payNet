// Reads the real provider catalog; all browser authentication and order history are isolated fixtures.
// Never connects to the application database or calls a provider financial endpoint.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const frontend = path.resolve(process.env.PAYNET_FRONTEND_DIR || path.join(__dirname, '../../payNet-frontend-main'));
const frontendRequire = createRequire(path.join(frontend, 'package.json'));
const { chromium } = frontendRequire('@playwright/test');
const build = path.join(frontend, 'build');
const output = path.resolve(process.env.PAYNET_DISPLAY_ARTIFACTS || path.join(__dirname, '../reports/alragheb-chat-display-2026-10-26'));
const catalog = require('../services/alraghebCatalog.service');
const provider = require('../services/alraghebApi');
const operations = require('../services/providerOperations.service');
const User = require('../models/User');
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2' };

async function main() {
  assert.ok(fs.existsSync(path.join(build, 'index.html')), 'Build the frontend before verification');
  assert.equal(mongoose.connection.readyState, 0);
  const liveStarted = Date.now();
  const snapshot = await catalog.getCatalog({ force: true });
  const liveReadMs = Date.now() - liveStarted;
  const report = { passed: false, chatProducts: snapshot.products.length, categories: snapshot.categories.length - 1,
    liveReadMs, financialRequests: 0, databaseConnections: 0, checks: [] };
  let clock = Date.now(), stored = snapshot, gate = null, unavailable = false, contentRequests = 0;
  const rawProduct = (p) => ({ id: p.id, parent_id: p.category_id, name: p.name, category_name: p.category_name,
    product_type: p.product_type, params: p.params, available: p.available, price: p.provider_price,
    base_price: p.provider_base_price, category_img: p.image_url,
    qty_values: p.quantity_rules.mode === 'choices' ? p.quantity_rules.values : p.quantity_rules.mode === 'fixed' && p.quantity_rules.defaultQty === 1 ? null : { min: p.quantity_rules.min, max: p.quantity_rules.max } });
  const runtime = catalog.createCatalogService({
    now: () => clock,
    storage: { get: async () => stored, set: async (_key, value) => { stored = value; } },
    client: { getContent: async (id) => {
      if (gate) await gate;
      if (unavailable) throw provider.alraghebError('ALRAGHEB_TIMEOUT', 'انتهت مهلة الاتصال بالمزوّد', 504);
      return { products: snapshot.products.filter((p) => p.category_id === id).map(rawProduct),
        categories: snapshot.categories.filter((c) => c.parent_id === id) };
    } },
  });
  catalog.getCatalog = (options) => runtime.getCatalog(options);
  operations.getSettings = async () => ({ purchaseEnabled: true });
  User.findById = (id) => ({ select: () => ({ lean: async () => ({ _id: id, email: 'display-test@example.invalid', role: 'admin', authVersion: 0, card: { cardapplication: true } }) }) });
  provider.getProfile = async () => ({ balance: '100', email: 'display-test@example.invalid' });
  provider.newOrder = async () => { report.financialRequests += 1; throw new Error('Financial provider request forbidden'); };
  process.env.JWT_SECRET = 'isolated-catalog-display-test-secret';

  const app = express();
  app.use(require('cors')());
  app.use(express.json());
  app.use((req, _res, next) => { if (req.path.startsWith('/api/alragheb/content/')) contentRequests += 1; next(); });
  app.get('/api/alragheb/orders', (_req, res) => res.json({ success: true, source: 'alragheb', data: [], meta: { total: 0, page: 1, total_pages: 1 } }));
  app.use('/api/alragheb', require('../routes/alraghebRoutes'));
  app.use('/api/admin/alragheb', require('../routes/alraghebAdminRoutes'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiOrigin = 'http://127.0.0.1:' + server.address().port;
  const origin = 'http://paynet-display.test';
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Damascus' });
  const token = jwt.sign({ id: '507f1f77bcf86cd799439011', email: 'display-test@example.invalid', role: 'admin', av: 0 }, process.env.JWT_SECRET, { expiresIn: '15m' });
  await context.addInitScript((value) => {
    localStorage.setItem('token', value);
    sessionStorage.setItem('paynet:new-services-announcement:2026-09-inquiry:dismissed-session', 'true');
  }, token);
  await context.routeWebSocket(/.*/, (socket) => socket.close());
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      } });
      if (request.method() !== 'GET') {
        if (!url.pathname.startsWith('/api/activity')) report.financialRequests += 1;
        return route.fulfill({ json: { success: true } });
      }
      if (url.pathname.startsWith('/api/alragheb/') || url.pathname === '/api/admin/alragheb/products') {
        return route.fulfill({ response: await route.fetch({ url: apiOrigin + url.pathname + url.search }) });
      }
      if (url.pathname === '/api/user/balance') return route.fulfill({ json: { balance: 100 } });
      if (url.pathname === '/api/user/daen') return route.fulfill({ json: { daen: 0 } });
      if (url.pathname.includes('profile')) return route.fulfill({ json: { _id: '507f1f77bcf86cd799439011', role: 'admin', name: 'Display test', balance: 100, card: { cardapplication: true } } });
      return route.fulfill({ json: { success: true, data: [], meta: { total: 0, page: 1, total_pages: 1 } } });
    }
    if (url.origin === origin) {
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const requested = path.resolve(build, relative || 'index.html');
      if (!requested.startsWith(build + path.sep)) return route.fulfill({ status: 403, body: '' });
      const file = fs.existsSync(requested) && fs.statSync(requested).isFile() ? requested : path.join(build, 'index.html');
      return route.fulfill({ contentType: mime[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
    }
    return route.abort();
  });
  fs.mkdirSync(output, { recursive: true });
  const page = await context.newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  const cards = () => page.getByRole('link', { name: /^تفاصيل / });
  const layout = async () => {
    const value = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
    assert.ok(value.width <= value.viewport + 1, JSON.stringify(value));
  };
  try {
    await page.goto(origin + '/chat-apps');
    await cards().first().waitFor();
    assert.equal(await cards().count(), 24);
    await layout();
    await page.screenshot({ path: path.join(output, 'catalog-desktop.png'), fullPage: true });
    report.checks.push('desktop catalog, categories and pagination');
    await page.goto(origin + '/chat-apps?category=21');
    await cards().first().waitFor();
    assert.equal(await cards().count(), 24);
    await page.getByRole('button', { name: 'الصفحة التالية', exact: true }).click();
    await page.waitForURL('**page=2');
    await page.getByRole('navigation', { name: 'صفحات المنتجات' }).getByText(/^2 \/ /).waitFor();
    report.checks.push('ZNET second page');
    await page.goto(origin + '/chat-apps?search=AHLAN');
    await page.getByRole('link', { name: /تفاصيل AHLAN/ }).first().waitFor();
    await page.getByRole('link', { name: /تفاصيل AHLAN/ }).first().click();
    await page.locator('article').waitFor();
    report.checks.push('search and product details');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin + '/chat-apps');
    await cards().first().waitFor();
    await layout();
    await page.screenshot({ path: path.join(output, 'catalog-mobile.png'), fullPage: true });
    report.checks.push('mobile layout without horizontal overflow');
    await page.goto(origin + '/adminAlraghebPrices');
    await page.locator('tbody tr').first().waitFor();
    await layout();
    await page.screenshot({ path: path.join(output, 'admin-mobile.png'), fullPage: true });
    report.checks.push('admin catalog');

    let release;
    gate = new Promise((resolve) => { release = resolve; });
    clock += 121000;
    const started = Date.now();
    await page.goto(origin + '/chat-apps');
    await cards().first().waitFor();
    await page.getByText(/جاري تحديث التطبيقات، آخر بيانات متاحة/).waitFor();
    report.cachedDisplayMs = Date.now() - started;
    assert.equal(await cards().count(), 24);
    await page.screenshot({ path: path.join(output, 'background-refresh-mobile.png'), fullPage: true });
    gate = null; release();
    await page.getByText(/جاري تحديث التطبيقات، آخر بيانات متاحة/).waitFor({ state: 'hidden' });
    report.checks.push('complete catalog remains visible during a blocked refresh, then updates');

    unavailable = true; clock += 121000;
    await page.reload();
    await cards().first().waitFor();
    await page.getByText(/تعذر التحديث، آخر بيانات متاحة/).waitFor();
    assert.equal(await cards().count(), 24);
    report.checks.push('provider timeout retains every cached product');
    await page.screenshot({ path: path.join(output, 'provider-timeout-mobile.png'), fullPage: true });

    stored = null; clock += 3600001;
    const before = contentRequests;
    await page.reload();
    await page.getByRole('alert').filter({ hasText: 'انتهت مهلة الاتصال بالمزوّد' }).waitFor();
    await page.waitForTimeout(1600);
    assert.equal(contentRequests - before, 1, 'A provider timeout must not start another long automatic loading cycle');
    report.checks.push('cold timeout shows a clear error without automatic retry loop');
    assert.equal(report.financialRequests, 0);
    assert.equal(mongoose.connection.readyState, 0);
    report.passed = true;
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'verification-failure.png'), fullPage: true }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ browserErrors, pageText: (await page.locator('body').innerText().catch(() => '')).slice(0, 2500) }, null, 2));
    throw error;
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error.code || error.name, error.name === 'AssertionError' || error.name === 'TimeoutError' ? error.message : 'Display verification failed'); process.exitCode = 1; });
