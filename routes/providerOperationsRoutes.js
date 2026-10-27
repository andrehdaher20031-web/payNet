const router = require('express').Router();
const auth = require('../middleware/authMiddleware');
const requireAdmin = require('../middleware/requireAdmin');
const operations = require('../services/providerOperations.service');
router.use(auth, requireAdmin);

const action = (callback) => async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { res.json({ success: true, ...await callback(req) }); }
  catch (error) { res.status(error.status || 500).json({ success: false, code: error.status ? error.code : 'OPERATIONS_UNAVAILABLE', message: error.status ? error.message : 'تعذر تنفيذ العملية، حاول مجددًا' }); }
};
const adapter = (provider) => require(operations.providerName(provider) === 'alragheb' ? '../services/alraghebOrder.service' : '../services/proWaveOrder.service');
router.get('/overview', action(async () => ({ data: await operations.overview() })));
router.get('/:provider/settings', action(async (req) => ({ data: await operations.getSettings(req.params.provider) })));
router.put('/:provider/settings', action(async (req) => ({ data: await operations.saveSettings(req.params.provider, req.user.id, req.body || {}) })));
router.get('/:provider/health', action(async (req) => ({ data: await operations.getProviderHealth(req.params.provider) })));
router.get('/:provider/audit', action((req) => operations.listAudit(req.params.provider, req.query)));
router.get('/:provider/transactions', action((req) => operations.listTransactions(req.params.provider, req.query)));
router.get('/:provider/transactions/:id', action(async (req) => ({ data: await operations.transactionDetail(req.params.provider, req.params.id) })));
router.get('/:provider/export', action((req) => operations.listTransactions(req.params.provider, req.query, true)));
router.post('/:provider/transactions/:id/check', action(async (req) => ({ data: await adapter(req.params.provider).checkTransaction(req.params.id, { actorId: req.user.id, isAdmin: true }) })));
router.post('/:provider/transactions/:id/resolve', action(async (req) => ({ data: await adapter(req.params.provider).resolveTransaction(req.params.id, { ...req.body, actorId: req.user.id, isAdmin: true }) })));

module.exports = router;
