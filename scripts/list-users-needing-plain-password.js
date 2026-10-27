require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is missing');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const users = await mongoose.connection.collection('users')
    .find(
      {},
      { projection: { email: 1, name: 1, role: 1, password: 1, passwordHash: 1 } }
    )
    .sort({ email: 1 })
    .toArray();

  const rows = users.map((user) => ({
    email: user.email,
    name: user.name || '',
    role: user.role || '',
    hasPlainPassword: typeof user.password === 'string' && user.password.length > 0,
    needsReset: !(typeof user.password === 'string' && user.password.length > 0),
    hasOldHash: typeof user.passwordHash === 'string' && user.passwordHash.length > 0,
  }));

  console.table(rows);
  const resetCount = rows.filter((row) => row.needsReset || row.hasOldHash).length;
  console.log(`Users needing plain-password reset: ${resetCount}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
