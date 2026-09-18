const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Models
const User = require('./models/User');
const Invoice = require('./models/Invoice');
const Payment = require('./models/Payment');
const Point = require('./models/Point');
const Product = require('./models/Product');
const ProductOnline = require('./models/ProductOnline');
const Balance = require('./models/Balance');
const saveNumber = require('./models/saveNumber');

const backupCollections = [
    { name: 'users', model: User },
    { name: 'invoices', model: Invoice },
    { name: 'payments', model: Payment },
    { name: 'points', model: Point },
    { name: 'products', model: Product },
    { name: 'productsOnline', model: ProductOnline },
    { name: 'balances', model: Balance },
    { name: 'saveNumbers', model: saveNumber },
];

const runBackup = async () => {
    try {
        const uri = process.env.MONGO_URI;
        if (!uri) {
            throw new Error('MONGO_URI غير معرف في .env');
        }

        await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
        console.log('✅ متصل بقاعدة البيانات');

        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const snapshotDir = path.join(backupDir, `backup-${timestamp}`);
        fs.mkdirSync(snapshotDir);

        const meta = { createdAt: new Date().toISOString(), collections: [] };

        for (const col of backupCollections) {
            const docs = await col.model.find().lean();
            const filePath = path.join(snapshotDir, `${col.name}.json`);
            fs.writeFileSync(filePath, JSON.stringify(docs, null, 2), 'utf-8');
            meta.collections.push({ name: col.name, count: docs.length, file: `${col.name}.json` });
            console.log(`📦 ${col.name} (${docs.length})`);
        }

        fs.writeFileSync(path.join(snapshotDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

        console.log(`✅ تم انشاء النسخة الاحتياطية في: ${snapshotDir}`);
        await mongoose.disconnect();
    } catch (error) {
        console.error('❌ فشل النسخ الاحتياطي:', error.message);
        process.exit(1);
    }
};

runBackup();
