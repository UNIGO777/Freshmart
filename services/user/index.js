require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('../../shared/db/mongoose');
const userRoutes = require('./routes/user.routes');
const { authenticate } = require('../../gateway/middleware/auth.middleware');
const logger = require('../../shared/utils/logger');

const app = express();
const PORT = process.env.PORT_USER || 3002;

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'user', timestamp: new Date().toISOString() });
});

// All user routes require a valid JWT — the gateway forwards the Authorization header
app.use('/', authenticate, userRoutes);

app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found', errorCode: 'NOT_FOUND' }));

app.use((err, _req, res, _next) => {
  logger.error('Unhandled user service error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

connectDB().then(() => {
  app.listen(PORT, () => logger.info(`User Service running on port ${PORT}`));
});

module.exports = app;
