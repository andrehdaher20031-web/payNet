require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI);
  try {
    for (const name of ['UserActivity', 'UserOperation', 'MonitoringSettings']) await require(`../models/${name}`).init();
    const result = await require('../services/userMonitoring.service').sync({ full: true });
    console.log(JSON.stringify(result));
  } finally { await mongoose.disconnect(); }
})().catch(() => { console.error('Monitoring backfill failed'); process.exitCode = 1; });
