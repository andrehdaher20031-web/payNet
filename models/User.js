const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
  },
  password: {
    type: String,
    select: false,
  },
  passwordHash: { type: String, select: false },
  passwordScheme: { type: String, select: false },
  authVersion: { type: Number, default: 0, min: 0 },
  name: {
    type: String,
  },
  number: {
    type: String,
  },
  card: {
    cardInternet: { type: Boolean, default: true },
    cardSyriatel: { type: Boolean, default: true },
    cardPlay: { type: Boolean, default: true },
    cardapplication: { type: Boolean, default: true },
    usdtpay: { type: Boolean, default: true },
    viewapp: { type: Boolean, default: true },
    ai: { type: Boolean, default: true },
    cardPronet: { type: Boolean, default: false },
    cardHifi: { type: Boolean, default: false },
  },

  role: {
    type: String,
    required: true,
    default: "user"
  },
  balance: { type: Number, default: 0 }, // رصيد المشترك
  lastLoginAt: Date,
  lastSeenAt: Date,
  loginCount: { type: Number, default: 0 },
}, { timestamps: true });

userSchema.set('toJSON', { transform: (_doc, value) => { delete value.password; delete value.passwordHash; delete value.passwordScheme; return value; } });

userSchema.pre('save', function () {
  if (!this.isModified('password') || !this.password) return;
  if (typeof this.password !== 'string' || Buffer.byteLength(this.password) > 1024) throw Object.assign(new Error('Invalid password'), { status: 400 });
  this.passwordHash = undefined;
  this.passwordScheme = undefined;
  if (!this.isNew) this.authVersion = Number(this.authVersion || 0) + 1;
});

userSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function () {
  const update = this.getUpdate();
  if (!update || Array.isArray(update)) return;
  const password = update.$set?.password ?? update.password;
  if (typeof password !== 'string' || !password) return;
  if (Buffer.byteLength(password) > 1024) throw Object.assign(new Error('Invalid password'), { status: 400 });
  update.$set = { ...update.$set, password };
  delete update.password;
  delete update.$set.passwordHash;
  delete update.$set.passwordScheme;
  update.$unset = { ...update.$unset, passwordHash: 1, passwordScheme: 1 };
  update.$inc = { ...update.$inc, authVersion: (update.$inc?.authVersion || 0) + 1 };
  this.setUpdate(update);
});

userSchema.index({ role: 1 });
userSchema.index({ lastSeenAt: -1 });
userSchema.index({ lastLoginAt: -1 });

module.exports = mongoose.model("User", userSchema);
