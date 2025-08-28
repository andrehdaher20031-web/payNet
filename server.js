const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();
const saveBalanceRoutes = require("./routes/saveBalance");
const adminRoutes = require("./routes/admin");
const point = require("./routes/point");
const http = require('http'); // جديد
const { Server } = require('socket.io'); // جديد


const app = express();

const server = http.createServer(app); // جديد
const io = new Server(server, {
  cors: {
    origin: "*", // يمكن تخصيصه حسب الدومين
    methods: ["GET", "POST"],
  },
});

// تخزين سوكيت للعملاء
io.on("connection", (socket) => {
  console.log("✅ عميل جديد متصل عبر سوكيت");

    socket.on("joinRoom", (email) => {
    socket.join(email);
    console.log(`Client ${socket.id} joined room: ${email}`);
  });

  socket.on("disconnect", () => {
    console.log("❌ تم فصل الاتصال بالعميل");
  });
});

// إتاحة الـ io للوصول من أي مكان
app.set("io", io); // مهم جداً


// Middlewares
app.use(cors());
app.use(express.json());

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
const authRoutes = require("./routes/authRoutes");
app.use("/api", authRoutes);
app.use("/api/point", point);


app.use("/api/user", require("./routes/userRoutes"));

//عملية التسديد
app.use("/api/payment", require("./routes/paymentRoutes"));

// حفظ عملية التسديد في قاعدة البيانات


app.use("/api/saveBalance", saveBalanceRoutes);


//ترحيل العمليات
app.use("/api/admin", adminRoutes);




// Connect DB and start server
const startServer = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB connected');
    server.listen(process.env.PORT, () => {
      console.log(`Server running on http://localhost:${process.env.PORT}`);
    });
  } catch (err) {
    console.error(err.message);
  }
};

startServer();
