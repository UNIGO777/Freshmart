require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('../../shared/db/mongoose');
const { connectRedis } = require('../../shared/db/redis');
const orderRoutes = require('./routes/order.routes');
const Order = require('./models/Order.model');
const Product = require('../product/models/Product.model');
const { initiateRouting } = require('./logic/vendorRouter');
const logger = require('../../shared/utils/logger');

const app = express();
const PORT = process.env.PORT_ORDER || 3004;

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'order', timestamp: new Date().toISOString() });
});

app.use('/', orderRoutes);

// ── Internal endpoint — called by Payment Service after UPI success ─
// Not exposed through gateway; only reachable service-to-service.
app.post('/internal/start-routing', async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false });

    const productIds = order.items.map((i) => i.productId.toString());
    const requiredCategories = [...new Set(order.items.map((i) => i.category).filter(Boolean))];

    // Non-blocking — fire and forget; routing state tracked in Redis
    initiateRouting(order, order.deliveryAddress, productIds, requiredCategories).catch((err) =>
      logger.error(`start-routing failed for order ${orderId}:`, err),
    );

    return res.json({ success: true });
  } catch (err) {
    logger.error('internal/start-routing error:', err);
    return res.status(500).json({ success: false });
  }
});

app.use((err, _req, res, _next) => {
  logger.error('Unhandled order service error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

Promise.all([connectDB(), connectRedis()]).then(() => {
  app.listen(PORT, () => logger.info(`Order Service running on port ${PORT}`));
});

module.exports = app;
