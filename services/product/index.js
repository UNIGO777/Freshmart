require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('../../shared/db/mongoose');
const { connectRedis } = require('../../shared/db/redis');
const productRoutes = require('./routes/product.routes');
const logger = require('../../shared/utils/logger');

const app = express();
const PORT = process.env.PORT_PRODUCT || 3003;

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'product', timestamp: new Date().toISOString() });
});

app.use('/', productRoutes);

app.use((err, _req, res, _next) => {
  logger.error('Unhandled product service error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

Promise.all([connectDB(), connectRedis()]).then(() => {
  app.listen(PORT, () => logger.info(`Product Service running on port ${PORT}`));
});

module.exports = app;
