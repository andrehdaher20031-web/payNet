require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

function readPasswordMap(filePath) {
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (Array.isArray(parsed)) return parsed.map((row) => [row.email, row.password]);
  return Object.entries(parsed);
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) throw new Error('Usage: node scripts/reset-plain-passwords.js password-reset.json');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is missing');

  const entries = readPasswordMap(filePath);
  if (!entries.length) throw new Error('Password file is empty');

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const users = mongoose.connection.collection('users');

  let matched = 0;
  let updated = 0;
  for (const [email, password] of entries) {
    if (typeof email !== 'string' || !email.trim() || email.length > 200) {
      throw new Error('Invalid email/username in password file');
    }
    if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024) {
      throw new Error(`Invalid password for ${email}`);
    }
    const result = await users.updateOne(
      { email: email.trim().toLowerCase() },
      {
        $set: { password },
        $inc: { authVersion: 1 },
        $unset: { passwordHash: '', passwordScheme: '' },
        $currentDate: { updatedAt: true },
      }
    );
    matched += result.matchedCount;
    updated += result.modifiedCount;
  }

  console.log(`Matched users: ${matched}`);
  console.log(`Updated users: ${updated}`);
  console.log('Passwords were not printed.');
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
