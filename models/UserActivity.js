const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  eventKey: { type: String, required: true, unique: true },
  eventType: { type: String, required: true },
  source: { type: String, enum: ['server', 'browser', 'history'], required: true },
  provider: String, productId: String, productName: String, categoryId: String,
  route: String, status: String, errorCode: String, httpStatus: Number,
  referenceId: String, sessionId: String, device: String,
  occurredAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
}, { versionKey: false });
schema.index({ user: 1, occurredAt: -1, _id: -1 });
schema.index({ eventType: 1, occurredAt: -1 });
schema.index({ user: 1, referenceId: 1, eventType: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('UserActivity', schema);
