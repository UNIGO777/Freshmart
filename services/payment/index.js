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
const paymentRoutes = require('./routes/payment.routes');
const logger = require('../../shared/utils/logger');

const app = express();
const PORT = process.env.PORT_PAYMENT || 3007;

app.use(helmet());
app.use(cors());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'payment', timestamp: new Date().toISOString() });
});

app.use('/', paymentRoutes);

// ── Internal: trigger refund when an order is cancelled post-payment ─
// Called by Order Service; no gateway JWT required (internal only).
app.post('/internal/refund-by-order', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId required' });

    const Transaction = require('./models/Transaction.model');
    const txn = await Transaction.findOne({ orderId, status: 'paid' });
    if (!txn) return res.json({ success: true, message: 'No paid transaction found — nothing to refund' });

    const crypto = require('crypto');
    const axios  = require('axios');
    const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
    const SALT_KEY    = process.env.PHONEPE_SALT_KEY;
    const SALT_INDEX  = process.env.PHONEPE_SALT_INDEX || '1';
    const PHONEPE_BASE_URL = process.env.PHONEPE_BASE_URL || 'https://api-preprod.phonepe.com/apis/pg-sandbox';

    const refundTransactionId = `REFUND_${crypto.randomUUID().replace(/-/g, '').slice(0, 30)}`;
    const payloadObj = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: refundTransactionId,
      originalTransactionId: txn.merchantTransactionId,
      amount: txn.amount,
      callbackUrl: `${process.env.APP_BASE_URL}/api/payments/callback`,
    };
    const base64Payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64');
    const hash = crypto.createHash('sha256').update(base64Payload + '/pg/v1/refund' + SALT_KEY).digest('hex');
    const checksum = `${hash}###${SALT_INDEX}`;

    const { data: phonepeRes } = await axios.post(
      `${PHONEPE_BASE_URL}/pg/v1/refund`,
      { request: base64Payload },
      { headers: { 'Content-Type': 'application/json', 'X-VERIFY': checksum } },
    );

    if (phonepeRes.success) {
      txn.status = 'refunded';
      txn.refundTransactionId = refundTransactionId;
      txn.refundedAt = new Date();
      await txn.save();
      logger.info(`Refund initiated for order ${orderId}: ${refundTransactionId}`);
    } else {
      logger.error('PhonePe refund failed:', phonepeRes);
    }

    return res.json({ success: true });
  } catch (err) {
    logger.error('internal/refund-by-order error:', err.message);
    return res.status(500).json({ success: false });
  }
});

app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found', errorCode: 'NOT_FOUND' }));

app.use((err, _req, res, _next) => {
  logger.error('Unhandled payment service error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

connectDB().then(() => {
  app.listen(PORT, () => logger.info(`Payment Service running on port ${PORT}`));
});

module.exports = app;
