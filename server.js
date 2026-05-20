require('dotenv').config();
const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');

const authRoutes    = require('./src/routes/auth');
const adminRoutes   = require('./src/routes/admin');
const reportRoutes  = require('./src/routes/reports');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: '*' })); // restrict to your domain in production
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));

// Rate limiting — 100 requests per 15 minutes per IP
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many requests. Try again later.' },
}));

// Stricter limit on OTP endpoint — 5 per 15 minutes
app.use('/api/auth/send-otp', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many OTP requests.' },
}));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',    authRoutes);
app.use('/api/admin',   adminRoutes);
app.use('/api/reports', reportRoutes);

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date() }));

// 404
app.use((_, res) => res.status(404).json({ success: false, message: 'Route not found.' }));

// ── Connect MongoDB then start server ─────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ MongoDB Atlas connected');
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });
