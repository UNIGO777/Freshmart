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
const notificationRoutes = require('./routes/notification.routes');
const logger = require('../../shared/utils/logger');

const app = express();
const PORT = process.env.PORT_PANEL_NOTIFY || 3012;

app.use(helmet());
app.use(cors());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'panel-notify', timestamp: new Date().toISOString() });
});

app.use('/', notificationRoutes);

app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found', errorCode: 'NOT_FOUND' }));

app.use((err, _req, res, _next) => {
  logger.error('Unhandled panel-notify error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

connectDB().then(() => {
  app.listen(PORT, () => logger.info(`Panel-Notify Service running on port ${PORT}`));
});

module.exports = app;
