const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
if (require.main === module) require('dotenv').config();
const saveBalanceRoutes = require('./routes/saveBalance');
const invoiceRoutes = require('./routes/invoice');
const adminRoutes = require('./routes/admin');
const point = require('./routes/point');
const http = require('http'); // جديد
const productOnline = require('./routes/productOnline')
const proWaveRoutes = require('./routes/proWave');
const alraghebRoutes = require('./routes/alraghebRoutes');
const alesoRoutes = require('./routes/aleso');
const {
  startDirectTopUpStatusScheduler,
  startReconciliationScheduler,
} = require('./controllers/proWave');
const { startAlesoOrderStatusScheduler } = require('./controllers/aleso');
//const Product = require("./models/Product");
const { Server } = require('socket.io'); // جديد

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const MONGO_URI = process.env.MONGO_URI;

const server = http.createServer(app); // جديد
const io = new Server(server, {
  cors: {
    origin: '*', // يمكن تخصيصه حسب الدومين
    methods: ['GET', 'POST'],
  },
});

require('./services/socketSecurity.service').configureSocketSecurity(io);

// إتاحة الـ io للوصول من أي مكان
app.set('io', io); // مهم جداً

// Middlewares
app.use(cors());
app.use(express.json());
app.use('/api/health', require('./routes/healthRoutes'));
app.use(require('./services/userActivity.service').observeRequests);
app.use('/api/activity', require('./routes/activity'));
app.use('/api/admin/user-monitoring', require('./routes/userMonitoring'));

// تمرير io لكل request
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Routes
app.get('/', (req, res) => {
  res.send('API is running...');
});

// Routes
const authRoutes = require('./routes/authRoutes');
app.use('/api', authRoutes);
app.use('/api/point', point);

app.use('/api/user', require('./routes/userRoutes'));

//عملية التسديد
app.use('/api/payment', require('./routes/paymentRoutes'));
app.use('/api/invoice', invoiceRoutes);
app.use('/api/productonline', productOnline)
app.use('/api/prowave', proWaveRoutes);
app.use('/api/aleso', alesoRoutes);
app.use('/api/alragheb', alraghebRoutes);
// حفظ عملية التسديد في قاعدة البيانات

app.use('/api/saveBalance', saveBalanceRoutes);

// Backup routes
app.use('/api/backup', require('./routes/backup'));

//ترحيل العمليات
app.use('/api/admin/alragheb', require('./routes/alraghebAdminRoutes'));
app.use('/api/admin/integrations', require('./routes/providerOperationsRoutes'));
app.use('/api/admin', adminRoutes);
app.use('/api/product', require('./routes/product'));

mongoose.connection.on('connected', () => {
  console.log('MongoDB connected');
});

mongoose.connection.on('error', (error) => {
  console.error('MongoDB connection error:', error);
});

mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB disconnected');
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

// Connect DB and start server
const startServer = async () => {
  if (!MONGO_URI) {
    console.error('MONGO_URI is missing');
    process.exit(1);
  }

  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
    });
    const topology = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!topology.setName && topology.msg !== 'isdbgrid') throw new Error('MongoDB replica set is required for safe wallet transactions');
    await Promise.all(['AlraghebCatalogSnapshot', 'AlraghebProductConfig', 'AlraghebPriceQuote', 'AlraghebTransaction', 'AlraghebConfigAudit', 'AlraghebPricingBatch', 'AlraghebPricingRule', 'AlraghebPricingRuleAudit', 'ProWaveProductConfig', 'ProWaveTransaction', 'ProWavePriceQuote', 'ProviderIntegrationSettings', 'ProviderIntegrationAudit', 'ProviderWorkerHealth', 'WalletAdjustment', 'UserActivity', 'UserOperation', 'MonitoringSettings', 'UserFollowUp']
      .map((name) => require(`./models/${name}`).init()));

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
      if (process.env.ALRAGHEB_API_TOKEN && require('./services/alraghebApi').isCatalogEnabled()) {
        require('./services/alraghebCatalog.service').getCatalog({ background: true })
          .catch((error) => console.warn('Alragheb catalog warm-up unavailable:', error.code || 'CATALOG_UNAVAILABLE'));
      }
      startReconciliationScheduler();
      startDirectTopUpStatusScheduler();
      startAlesoOrderStatusScheduler();
      require('./services/alraghebReconciliation.service').start();
      require('./services/userMonitoring.service').start();
    });
  } catch (err) {
    console.error('Failed to start server');
    console.error(err);
    process.exit(1);
  }
};

if (require.main === module) startServer();
module.exports = { app, server, io, startServer };
