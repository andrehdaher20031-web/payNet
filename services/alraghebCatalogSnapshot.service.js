const { createHash } = require('node:crypto');
const mongoose = require('mongoose');
const Snapshot = require('../models/AlraghebCatalogSnapshot');

// Prices are account specific. A rotated token must not reuse another account's catalog.
const namespace = () => {
  const token = process.env.ALRAGHEB_API_TOKEN;
  return token ? createHash('sha256').update(token).digest('hex') : 'unconfigured';
};
const available = () => Boolean(process.env.ALRAGHEB_API_TOKEN) && mongoose.connection.readyState === 1;

async function load() {
  if (!available()) return null;
  const row = await Snapshot.findById(namespace()).maxTimeMS(3000).lean();
  if (!row || row.version !== 1 || !Array.isArray(row.categories) || !Array.isArray(row.products)) return null;
  return { categories: row.categories, products: row.products, synced_at: row.synced_at };
}

async function save(catalog) {
  if (!available()) return;
  // Called only after every descendant has been validated. Never persist partial refreshes.
  await Snapshot.updateOne({ _id: namespace() }, {
    $set: { version: 1, categories: catalog.categories, products: catalog.products, synced_at: catalog.synced_at },
  }, { upsert: true, maxTimeMS: 3000 });
}

module.exports = { namespace, load, save };
