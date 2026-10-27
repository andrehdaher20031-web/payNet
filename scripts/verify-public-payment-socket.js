// Both production builds, real Socket.IO, and in-memory fixtures only.
// No production API, database, login, purchase, or refund is executed.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/authMiddleware');
const { configureSocketSecurity } = require('../services/socketSecurity.service');
const { publishPendingPayments } = require('../services/pendingPaymentsEvents.service');
const frontend = path.resolve(__dirname, '../../payNet-frontend-main');
const { chromium, expect } = createRequire(path.join(frontend, 'package.json'))('@playwright/test');
const daherBuild = path.resolve(process.env.DAHER_BUILD_DIR || path.join(__dirname, '../../Daher.Net/Daher.Net/dist'));
const paynetBuild = path.join(frontend, 'build');
const output = path.resolve(__dirname, '../dist/public-socket-verification');
const fixture = n => ({ _id: `507f1f77bcf86cd7994390${n}`, landline: `01100000${n}`, company: 'خدمة اختبار', speed: '1 Mbps', amount: 100, calculatedAmount: 100, email: 'private-fixture@test.invalid', status: 'جاري التسديد', extra: {}, createdAt: '2026-10-27T10:00:00Z' });
const mime = { '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

async function main() {
  for (const root of [daherBuild, paynetBuild]) assert.ok(fs.existsSync(path.join(root, 'index.html')), 'Build both frontends first');
  assert.equal(mongoose.connection.readyState, 0);
  fs.mkdirSync(output, { recursive: true });
  const originalFind = User.findById, originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'isolated-public-socket-verification';
  const admin = { _id: '1'.repeat(24), email: 'admin@fixture.invalid', role: 'admin', authVersion: 0 };
  User.findById = id => ({ select: () => ({ lean: async () => String(id) === admin._id ? admin : null }) });
  let origin, rows = [fixture('11')], reads = 0, browser, guest;
  const errors = [], guestFrames = [];
  const report = { passed: false, checks: [], productionRequests: 0, databaseConnections: 0 };
  const server = http.createServer(async (req, res) => {
    const json = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/admin/pending') {
        try { const user = await authenticateToken(/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1]); assert.equal(user.role, 'admin'); }
        catch { return json({ code: 'UNAUTHORIZED' }, 401); }
        reads += 1;
        return json(rows);
      }
      if (url.pathname.startsWith('/api/')) return json({ data: [], companies: {}, balance: 1000, daen: 0 });
      const isDaher = url.pathname.startsWith('/Daher.Net/');
      const root = isDaher ? daherBuild : paynetBuild;
      const relative = isDaher ? url.pathname.slice('/Daher.Net'.length) : url.pathname;
      const candidate = path.resolve(root, '.' + decodeURIComponent(relative));
      const file = candidate.startsWith(root + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : path.join(root, 'index.html');
      let body = fs.readFileSync(file);
      if (file.endsWith('.js')) body = Buffer.from(body.toString('utf8').replaceAll('https://paynet-1.onrender.com', origin).replaceAll('https://daherserver-zgmy.onrender.com', origin));
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (error) { errors.push(error.message); if (!res.destroyed) json({ error: 'Fixture failure' }, 500); }
  });
  const io = configureSocketSecurity(new Server(server));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    guest = new WebSocket(origin.replace('http:', 'ws:') + '/socket.io/?EIO=4&transport=websocket');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Anonymous connection timed out')), 10000);
      guest.addEventListener('message', event => {
        const frame = String(event.data);
        if (frame.startsWith('0')) guest.send('40');
        else if (frame.startsWith('40')) { clearTimeout(timer); resolve(); }
        else if (frame.startsWith('42')) guestFrames.push(frame);
        else if (frame === '2') guest.send('3');
        else if (frame.startsWith('44')) { clearTimeout(timer); reject(new Error('Anonymous connection rejected')); }
      });
    });
    assert.equal((await fetch(origin + '/api/admin/pending')).status, 401);
    report.checks.push('socket connects without a token while payment HTTP requests remain authenticated');
    browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
    const contexts = await Promise.all([0, 1].map(async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(token => {
        localStorage.setItem('token', token);
        localStorage.setItem('DaherUser', JSON.stringify({ id: 'fixture-user', username: 'Fixture Admin', role: 'admin' }));
        localStorage.setItem('session:lastActivityAt', String(Date.now()));
        sessionStorage.setItem('paynet:new-services-announcement:2026-09-inquiry:dismissed-session', 'true');
      }, jwt.sign({ id: admin._id, email: admin.email, role: 'admin', av: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' }));
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { if (url.pathname.startsWith('/api/')) report.productionRequests += 1; return route.abort(); }
        return route.continue();
      });
      return context;
    }));
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    pages.forEach(page => page.on('pageerror', error => errors.push(error.message)));
    await Promise.all([pages[0].goto(origin + '/adminpending'), pages[1].goto(origin + '/Daher.Net/#/PendingTransactions')]);
    const cell = (page, n) => page.getByRole('cell', { name: fixture(n).landline, exact: true });
    for (const page of pages) await expect(cell(page, '11')).toBeVisible({ timeout: 15000 });
    await expect.poll(() => io.sockets.sockets.size).toBe(3);
    assert.equal([...io.sockets.sockets.values()].filter(socket => !socket.data.user).length, 2);
    assert.equal(io.sockets.adapter.rooms.get('admins').size, 1);
    rows.push(fixture('12')); publishPendingPayments(io, rows);
    for (const page of pages) await expect(cell(page, '12')).toBeVisible();
    rows = [fixture('12')]; publishPendingPayments(io, rows);
    for (const page of pages) await expect(cell(page, '11')).toHaveCount(0);
    report.checks.push('both actual frontends update added and rejected numbers without F5');
    const daherSocket = [...io.sockets.sockets.values()].find(socket => !socket.data.user && socket.conn.transport.name !== 'websocket') || [...io.sockets.sockets.values()].filter(socket => !socket.data.user).at(-1);
    daherSocket.conn.close();
    rows = [fixture('13')]; publishPendingPayments(io, rows);
    for (const page of pages) await expect(cell(page, '13')).toBeVisible({ timeout: 15000 });
    report.checks.push('the anonymous second frontend resynchronizes changes missed during reconnection');
    await pages[1].waitForTimeout(16000);
    rows.push(fixture('14')); publishPendingPayments(io, rows);
    for (const page of pages) await expect(cell(page, '14')).toBeVisible();
    assert.equal(guest.readyState, WebSocket.OPEN);
    assert.ok(guestFrames.length >= 4);
    assert.ok(guestFrames.every(frame => frame === '42["pendingPaymentsChanged"]'));
    assert.equal(report.productionRequests, 0);
    assert.equal(mongoose.connection.readyState, 0);
    assert.deepEqual(errors, []);
    report.checks.push('anonymous connections survive periodic checks and receive no payment details');
    for (let i = 0; i < pages.length; i++) await pages[i].screenshot({ path: path.join(output, `${i ? 'daher' : 'paynet'}-pending.png`), fullPage: true });
    Object.assign(report, { passed: true, pendingReads: reads, anonymousFrames: guestFrames.length, browserErrors: errors });
    fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, artifacts: output }, null, 2));
  } finally {
    guest?.close();
    if (browser) await browser.close();
    await new Promise(resolve => io.close(resolve));
    User.findById = originalFind;
    if (originalSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalSecret;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
