const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createHealthRouter } = require('../routes/healthRoutes');

test('public deployment health identifies configuration without credentials or provider requests', async (t) => {
  let database = 1;
  const environment = { RENDER_GIT_COMMIT: 'c82b02d0c492323243fbe043855cbbd7cf275c17', ALRAGHEB_API_TOKEN: 'isolated-secret-must-never-be-returned', MONGO_URI: 'isolated-private-database-uri', JWT_SECRET: 'isolated-private-jwt-secret' };
  const app = express();
  app.use('/api/health', createHealthRouter({ databaseState: () => database, environment,
    catalogStatus: () => ({ state: 'unavailable', lastSyncedAt: null, errorCode: 'ALRAGHEB_TIMEOUT' }) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const read = () => fetch('http://127.0.0.1:' + server.address().port + '/api/health');
  let response = await read();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  let body = await response.json();
  assert.equal(body.revision, environment.RENDER_GIT_COMMIT);
  assert.equal(body.checks.chatCatalog.configuration, 'configured');
  assert.equal(body.checks.chatCatalog.errorCode, 'ALRAGHEB_TIMEOUT');
  assert.ok(!JSON.stringify(body).includes('isolated-'));
  environment.ALRAGHEB_API_TOKEN = '';
  body = await (await read()).json();
  assert.equal(body.checks.chatCatalog.configuration, 'not_configured');
  environment.ALRAGHEB_CATALOG_ENABLED = 'false';
  body = await (await read()).json();
  assert.equal(body.checks.chatCatalog.configuration, 'disabled');
  database = 0;
  response = await read();
  assert.equal(response.status, 503);
  assert.equal((await response.json()).checks.database, 'unavailable');
});
