const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
const options = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const hashPassword = async (password) => {
  if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024) throw Object.assign(new Error('كلمة المرور غير صالحة'), { status: 400 });
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, options);
  return `scrypt$16384$8$1$${salt}$${key.toString('hex')}`;
};
const verifyPassword = async (password, user) => {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024) return false;
  if (typeof user.password === 'string' && user.password) {
    const expected = Buffer.from(user.password), actual = Buffer.from(password);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  if (user.passwordHash) {
    const parts = String(user.passwordHash).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt' || parts[1] !== '16384' || parts[2] !== '8' || parts[3] !== '1' || !/^[a-f0-9]{32}$/.test(parts[4]) || !/^[a-f0-9]{128}$/.test(parts[5])) return false;
    const expected = Buffer.from(parts[5], 'hex');
    const actual = await derive(password, parts[4], expected.length, options);
    return timingSafeEqual(expected, actual);
  }
  return false;
};
module.exports = { hashPassword, verifyPassword };
