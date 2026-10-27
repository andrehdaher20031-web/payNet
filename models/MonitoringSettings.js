const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: { type: String, default: 'default' },
  activeHours: { type: Number, default: 24 },
  inactiveDays: { type: Number, default: 7 },
  pendingMinutes: { type: Number, default: 30 },
  failedThreshold: { type: Number, default: 3 },
  trackingStartedAt: Date,
  syncedAt: Date,
  syncError: Boolean,
}, { versionKey: false });
module.exports = mongoose.model('MonitoringSettings', schema);
