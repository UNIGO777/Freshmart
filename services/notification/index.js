require('dotenv').config();

process.on('unhandledRejection', (reason) => {
  require('../../shared/utils/logger').error('Unhandled rejection:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  if (err.type === 'request.aborted' || err.message === 'request aborted') return;
  require('../../shared/utils/logger').error('Uncaught exception:', err);
  process.exit(1);
});
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('../../shared/db/mongoose');
const { authenticate } = require('../../gateway/middleware/auth.middleware');
const { notifyUser, sendPromo, updateFcmToken } = require('./controllers/notification.controller');
const logger = require('../../shared/utils/logger');

const app = express();
const PORT = process.env.PORT_NOTIFICATION || 3008;

app.use(helmet());
app.use(cors());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10kb' }));

// ── Health ─────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'notification', timestamp: new Date().toISOString() });
});

// ── Internal endpoint (service-to-service, no JWT) ─────────────────
// POST /internal/notify  { type, userId, userRole, data? }
app.post('/internal/notify', notifyUser);

// ── Routes exposed through API Gateway (JWT required — enforced by gateway) ─

// The gateway forwards the Authorization header but does NOT populate req.user in
// the upstream service — each service must decode it. `authenticate` attaches
// req.user = { id, role } from the JWT (matches every other service).

// PATCH /api/notifications/fcm-token  — any authenticated user updates their device token
app.patch('/fcm-token', authenticate, updateFcmToken);

// POST /api/notifications/promo  — ADMIN only (role guard enforced by gateway)
app.post('/promo', authenticate, sendPromo);

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
