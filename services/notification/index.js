require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('../../shared/db/mongoose');
const { notifyUser, sendPromo, updateFcmToken } = require('./controllers/notification.controller');
const logger = require('../../shared/utils/logger');

const app = express();
const PORT = process.env.PORT_NOTIFICATION || 3008;

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

// ── Health ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'notification', timestamp: new Date().toISOString() });
});

// ── Internal endpoint (service-to-service, no JWT) ─────────────────
// POST /internal/notify  { type, userId, userRole, data? }
app.post('/internal/notify', notifyUser);

// ── Routes exposed through API Gateway (JWT required — enforced by gateway) ─

// PATCH /api/notifications/fcm-token  — any authenticated user updates their device token
app.patch('/fcm-token', updateFcmToken);

// POST /api/notifications/promo  — ADMIN only (role guard enforced by gateway)
app.post('/promo', sendPromo);

// ── Global error handler ───────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found', errorCode: 'NOT_FOUND' }));

app.use((err, _req, res, _next) => {
  logger.error('Unhandled notification service error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ── Bootstrap ──────────────────────────────────────────────────────
// Notification service only needs MongoDB (to look up FCM tokens)
connectDB().then(() => {
  app.listen(PORT, () => logger.info(`Notification Service running on port ${PORT}`));
});

module.exports = app;
