const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const authMiddleware = require('../middleware/auth');

// Models to backup
const User = require('../models/User');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const Point = require('../models/Point');
const Product = require('../models/Product');
const ProductOnline = require('../models/ProductOnline');
const Balance = require('../models/Balance');
const saveNumber = require('../models/saveNumber');

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

router.post('/backup', authMiddleware, async (req, res) => {
    try {
        const backupDir = path.join(__dirname, '..', 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const snapshotDir = path.join(backupDir, `backup-${timestamp}`);
        fs.mkdirSync(snapshotDir);

        const meta = {
            createdAt: new Date().toISOString(),
            collections: [],
        };

        for (const col of backupCollections) {
            const docs = await col.model.find().lean();
            const outFile = path.join(snapshotDir, `${col.name}.json`);
            fs.writeFileSync(outFile, JSON.stringify(docs, null, 2), 'utf-8');
            meta.collections.push({
                name: col.name,
                count: docs.length,
                file: `${col.name}.json`,
            });
        }

        fs.writeFileSync(path.join(snapshotDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

        return res.status(200).json({
            message: 'تم إنشاء النسخة الاحتياطية بنجاح',
            backupPath: snapshotDir,
            meta,
        });
    } catch (error) {
        console.error('Backup failed', error);
        return res.status(500).json({ message: 'فشل إنشاء النسخة الاحتياطية', error: error.message });
    }
});

// Restore route (optional)
router.post('/restore', authMiddleware, async (req, res) => {
    try {
        const { backupFolder } = req.body;
        if (!backupFolder) {
            return res.status(400).json({ message: 'يرجى إرسال backupFolder في جسم الطلب' });
        }

        const backupPath = path.isAbsolute(backupFolder)
            ? backupFolder
            : path.join(__dirname, '..', 'backups', backupFolder);

        if (!fs.existsSync(backupPath)) {
            return res.status(404).json({ message: 'المجلد المطلوب غير موجود' });
        }

        const restoreReport = [];
        for (const col of backupCollections) {
            const filePath = path.join(backupPath, `${col.name}.json`);
            if (!fs.existsSync(filePath)) continue;

            const raw = fs.readFileSync(filePath, 'utf-8');
            const docs = JSON.parse(raw);

            if (!Array.isArray(docs)) {
                continue;
            }

            // يمكن تعديل هذا السلوك لـ replace / append
            await col.model.deleteMany({});
            if (docs.length > 0) {
                await col.model.insertMany(docs);
            }

            restoreReport.push({ name: col.name, restored: docs.length });
        }

        return res.status(200).json({
            message: 'تمت عملية الاستعادة بنجاح',
            restored: restoreReport,
        });
    } catch (error) {
        console.error('Restore failed', error);
        return res.status(500).json({ message: 'فشل عملية الاستعادة', error: error.message });
    }
});

module.exports = router;
