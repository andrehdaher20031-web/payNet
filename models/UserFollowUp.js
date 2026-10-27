const mongoose = require('mongoose');
const entry = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  at: { type: Date, required: true },
  note: String,
  status: String,
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  dueAt: { type: Date, default: null },
  confirmedGoal: String,
  dropOffReason: String,
}, { _id: true });
const schema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String, enum: ['new', 'in_progress', 'waiting', 'resolved'], default: 'new' },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  dueAt: { type: Date, default: null },
  confirmedGoal: { type: String, default: '' },
  dropOffReason: { type: String, default: 'unknown' },
  revision: { type: Number, default: 0 },
  history: { type: [entry], default: [] },
}, { timestamps: true, versionKey: false });
schema.index({ status: 1, dueAt: 1 });
schema.index({ owner: 1, status: 1 });
module.exports = mongoose.model('UserFollowUp', schema);
