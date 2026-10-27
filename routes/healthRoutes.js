const express = require('express');
const mongoose = require('mongoose');
const catalog = require('../services/alraghebCatalog.service');

function createHealthRouter({ databaseState = () => mongoose.connection.readyState, environment = process.env, catalogStatus = () => catalog.getStatus() } = {}) {
  const router = express.Router();
  router.get('/', (_req, res) => {
    const databaseReady = databaseState() === 1;
    const catalogEnabled = !['0', 'false', 'off', 'no'].includes(String(environment.ALRAGHEB_CATALOG_ENABLED || '').trim().toLowerCase());
    const configured = Boolean(String(environment.ALRAGHEB_API_TOKEN || '').trim());
    const revision = /^[a-f0-9]{40}$/i.test(environment.RENDER_GIT_COMMIT || '') ? environment.RENDER_GIT_COMMIT : null;
    // No upstream calls, account details, balances, connection strings or secrets.
    res.set('Cache-Control', 'no-store').status(databaseReady ? 200 : 503).json({
      status: databaseReady ? 'ok' : 'unavailable', revision,
      checks: { database: databaseReady ? 'connected' : 'unavailable',
        chatCatalog: { configuration: !catalogEnabled ? 'disabled' : configured ? 'configured' : 'not_configured', ...catalogStatus() },
        chatPurchasing: { environmentEnabled: environment.ALRAGHEB_PURCHASE_ENABLED === 'true', roundingReady: environment.ALRAGHEB_ROUNDING_POLICY === 'syp_2dp' } },
    });
  });
  return router;
}

module.exports = createHealthRouter();
module.exports.createHealthRouter = createHealthRouter;
