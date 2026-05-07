require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('../../shared/db/mongoose');
const vendorRoutes = require('./routes/vendor.routes');
const logger = require('../../shared/utils/logger');

const app = express();
const PORT = process.env.PORT_VENDOR || 3005;

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'vendor', timestamp: new Date().toISOString() });
});

app.use('/', vendorRoutes);

app.use((err, _req, res, _next) => {
  logger.error('Unhandled vendor service error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

connectDB().then(() => {
  app.listen(PORT, () => logger.info(`Vendor Service running on port ${PORT}`));
});

module.exports = app;
