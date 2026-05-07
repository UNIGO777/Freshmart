require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('../../shared/db/mongoose');
const paymentRoutes = require('./routes/payment.routes');
const logger = require('../../shared/utils/logger');

const app = express();
const PORT = process.env.PORT_PAYMENT || 3007;

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'payment', timestamp: new Date().toISOString() });
});

app.use('/', paymentRoutes);

app.use((err, _req, res, _next) => {
  logger.error('Unhandled payment service error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

connectDB().then(() => {
  app.listen(PORT, () => logger.info(`Payment Service running on port ${PORT}`));
});

module.exports = app;
