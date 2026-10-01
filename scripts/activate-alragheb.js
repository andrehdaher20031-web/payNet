const pricing = require('../services/alraghebPricing.service');

function activationConfig(product) {
  if (!['amount', 'package', 'specificPackage'].includes(product.product_type)) return null;
  let fieldSchema;
  if (product.params.length === 0 && product.product_type === 'package' && product.quantity_rules.mode === 'fixed' && product.quantity_rules.defaultQty === 1) {
    fieldSchema = [];
  } else if (product.params.length === 1 && product.params[0].trim().toLowerCase() === 'please enter your user id') {
    fieldSchema = [{ key: 'playerId', required: true }];
  } else return null;
  return pricing.validateConfig({
    purchaseEnabled: true, billingUnitQty: 1, fieldSchema, revision: 0,
    note: 'Owner-authorized activation via maintenance CLI. Independent provider price * qty, SYP rounded to 2 decimals. Provider API documentation: playerId for a single user ID; fixed packages with no params send qty=1. No shared markup.',
  }, product);
}

async function run(apply) {
  require('dotenv').config({ quiet: true });
  const mongoose = require('mongoose');
  const catalog = require('../services/alraghebCatalog.service');
  const Config = require('../models/AlraghebProductConfig');
  const Audit = require('../models/AlraghebConfigAudit');
  const orders = require('../services/alraghebOrder.service');
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
    const snapshot = await catalog.getCatalog({ force: true });
    if (snapshot.stale) throw Object.assign(new Error(), { code: 'STALE_CATALOG' });
    const proposals = [], review = [];
    for (const product of snapshot.products) {
      try {
        const config = activationConfig(product);
        if (config) proposals.push(config);
        else review.push({ productId: product.id, name: product.name, reason: 'FIELD_CONTRACT_NEEDS_REVIEW' });
      } catch (error) { review.push({ productId: product.id, name: product.name, reason: error.code || 'INVALID_CONFIG' }); }
    }
    let created = 0;
    if (apply) {
      if (!pricing.enabled() || !pricing.moneyReady()) throw Object.assign(new Error(), { code: 'PURCHASE_DISABLED' });
      await orders.checkDatabase();
      await Config.init(); await Audit.init();
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          // Preserve all existing product decisions, including explicit administrator disables.
          const existing = new Set((await Config.find({}).select('productId').session(session).lean()).map(c => c.productId));
          const pending = proposals.filter(c => !existing.has(c.productId));
          created = pending.length;
          if (!pending.length) return;
          const inserted = await Config.insertMany(pending, { session });
          await Audit.insertMany(inserted.map(config => ({ productId: config.productId, before: null, after: config.toObject() })), { session });
        });
      } finally { await session.endSession(); }
    }
    const existing = new Set((await Config.find({}).select('productId').lean()).map(c => c.productId));
    console.log(JSON.stringify({ applied: apply, totalProducts: snapshot.products.length, supportedProducts: proposals.length,
      created, remainingNew: proposals.filter(c => !existing.has(c.productId)).length,
      enabledConfigurations: await Config.countDocuments({ purchaseEnabled: true }), manualReview: review }));
  } finally { await mongoose.disconnect(); }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply') || args.length > 1) {
    console.error('Usage: node scripts/activate-alragheb.js [--apply]');
    process.exitCode = 1;
  } else run(args.includes('--apply')).catch(error => { console.error(error.code || 'ACTIVATION_FAILED'); process.exitCode = 1; });
}

module.exports = { activationConfig };
