require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');
const Transaction = require('../models/Transaction.model');
const Order = require('../../order/models/Order.model');
const Customer = require('../../user/models/Customer.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const { PAYMENT_STATUS, ORDER_STATUS } = require('../../../shared/constants/orderStatus');
const logger = require('../../../shared/utils/logger');

// ── Internal: confirm a UPI-paid order and kick off vendor routing ─
const confirmUpiOrder = async (txn) => {
  try {
    const order = await Order.findById(txn.orderId);
    if (!order) return logger.warn(`confirmUpiOrder: order ${txn.orderId} not found`);

    order.paymentStatus = PAYMENT_STATUS.PAID;
    order.status = ORDER_STATUS.CONFIRMED;
    await order.save();

    // Call Order Service to start vendor routing via internal HTTP
    const orderServiceUrl = `http://localhost:${process.env.PORT_ORDER || 3004}`;
    await axios
      .post(`${orderServiceUrl}/internal/start-routing`, { orderId: txn.orderId.toString() })
      .catch((err) => logger.warn('start-routing call failed (non-fatal):', err.message));
  } catch (err) {
    logger.error('confirmUpiOrder error:', err);
  }
};

const PHONEPE_BASE_URL = process.env.PHONEPE_BASE_URL || 'https://api-preprod.phonepe.com/apis/pg-sandbox';
const MERCHANT_ID = process.env.PHONEPE_MERCHANT_ID;
const SALT_KEY = process.env.PHONEPE_SALT_KEY;
const SALT_INDEX = process.env.PHONEPE_SALT_INDEX || '1';

/** Build PhonePe X-VERIFY checksum for a given path + base64 payload */
const buildChecksum = (base64Payload, apiPath) => {
  const hash = crypto
    .createHash('sha256')
    .update(base64Payload + apiPath + SALT_KEY)
    .digest('hex');
  return `${hash}###${SALT_INDEX}`;
};

/**
 * Verify a PhonePe callback/webhook checksum.
 * Per PhonePe docs the callback hash is: SHA256(base64Response + saltKey)
 * No API path is included in the callback hash (unlike outgoing requests).
 */
const verifyChecksum = (base64Response, receivedChecksum) => {
  const hash = crypto
    .createHash('sha256')
    .update(base64Response + SALT_KEY)
    .digest('hex');
  const expected = `${hash}###${SALT_INDEX}`;
  return expected === receivedChecksum;
};

/**
 * POST /api/payments/create-order
 * Initiate a PhonePe UPI payment.
 * Body: { orderId, amount, redirectUrl, callbackUrl }
 */
const createPaymentOrder = async (req, res) => {
  try {
    const { orderId, amount, redirectUrl, callbackUrl } = req.body;

    if (!orderId || !amount) {
      return sendError(res, 400, 'orderId and amount are required', ERROR_CODES.MISSING_FIELDS);
    }

    // BUG-019: Idempotency — if a 'created' transaction already exists for this
    // order, return it instead of creating a duplicate and charging twice.
    const existing = await Transaction.findOne({ orderId, status: 'created' });
    if (existing) {
      return sendSuccess(res, 200, 'Payment already initiated', {
        merchantTransactionId: existing.merchantTransactionId,
        paymentUrl: null, // client should re-poll /status or use stored URL
      });
    }

    // BUG-005: req.user only carries { id, role }. Fetch phone from DB.
    const customer = await Customer.findById(req.user.id).select('phone').lean();

    const merchantTransactionId = `TXN_${crypto.randomUUID().replace(/-/g, '').slice(0, 34)}`;
    const amountInPaise = Math.round(amount * 100);

    const payloadObj = {
      merchantId: MERCHANT_ID,
      merchantTransactionId,
      merchantUserId: req.user.id,
      amount: amountInPaise,
      redirectUrl: redirectUrl || `${process.env.APP_BASE_URL}/payment/status`,
      redirectMode: 'REDIRECT',
      callbackUrl: callbackUrl || `${process.env.APP_BASE_URL}/api/payments/callback`,
      mobileNumber: customer?.phone,
      paymentInstrument: { type: 'PAY_PAGE' },
    };

    const base64Payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64');
    const checksum = buildChecksum(base64Payload, '/pg/v1/pay');

    const { data: phonepeRes } = await axios.post(
      `${PHONEPE_BASE_URL}/pg/v1/pay`,
      { request: base64Payload },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': checksum,
        },
      },
    );

    if (!phonepeRes.success) {
      logger.error('PhonePe initiate failed:', phonepeRes);
      return sendError(res, 502, 'Payment initiation failed', ERROR_CODES.PAYMENT_FAILED);
    }

    // Persist transaction record in created state
    await Transaction.create({
      orderId,
      customerId: req.user.id,
      merchantTransactionId,
      amount: amountInPaise,
      method: 'upi',
      status: 'created',
    });

    const paymentUrl = phonepeRes.data?.instrumentResponse?.redirectInfo?.url;

    return sendSuccess(res, 200, 'Payment initiated', {
      merchantTransactionId,
      paymentUrl,
    });
  } catch (err) {
    logger.error('createPaymentOrder error:', err?.response?.data || err.message);
    return sendError(res, 500, 'Failed to create payment order', ERROR_CODES.INTERNAL_ERROR);
  }
};

/**
 * POST /api/payments/callback
 * PhonePe server-to-server callback (webhook).
 * PhonePe sends: { response: "<base64>" } with X-VERIFY header
 */
const handleCallback = async (req, res) => {
  try {
    const receivedChecksum = req.headers['x-verify'];
    const { response: base64Response } = req.body;

    if (!base64Response || !receivedChecksum) {
      return res.status(400).json({ success: false });
    }

    if (!verifyChecksum(base64Response, receivedChecksum)) {
      logger.warn('PhonePe callback checksum mismatch');
      return res.status(400).json({ success: false, message: 'Checksum mismatch' });
    }

    const decoded = JSON.parse(Buffer.from(base64Response, 'base64').toString('utf8'));
    const { merchantTransactionId, transactionId, state } = decoded.data || {};

    const txn = await Transaction.findOne({ merchantTransactionId });
    if (!txn) {
      logger.warn(`Callback for unknown txn: ${merchantTransactionId}`);
      return res.status(200).json({ success: true }); // Acknowledge to avoid retries
    }

    if (state === 'COMPLETED') {
      txn.status = 'paid';
      txn.phonepeTransactionId = transactionId;
      txn.callbackPayload = decoded;
      await txn.save();
      // Confirm order and kick off vendor routing for UPI payments
      confirmUpiOrder(txn).catch((err) => logger.error('confirmUpiOrder async error:', err));
    } else if (state === 'FAILED') {
      txn.status = 'failed';
      txn.callbackPayload = decoded;
      await txn.save();
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    logger.error('handleCallback error:', err);
    return res.status(500).json({ success: false });
  }
};

/**
 * GET /api/payments/status/:merchantTransactionId
 * Poll payment status from PhonePe (used if callback is delayed).
 */
const checkPaymentStatus = async (req, res) => {
  try {
    const { merchantTransactionId } = req.params;

    const checksum = buildChecksum('', `/pg/v1/status/${MERCHANT_ID}/${merchantTransactionId}`);

    const { data: phonepeRes } = await axios.get(
      `${PHONEPE_BASE_URL}/pg/v1/status/${MERCHANT_ID}/${merchantTransactionId}`,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': checksum,
          'X-MERCHANT-ID': MERCHANT_ID,
        },
      },
    );

    const txn = await Transaction.findOne({ merchantTransactionId }).lean();

    return sendSuccess(res, 200, 'Payment status fetched', {
      phonepeStatus: phonepeRes?.data?.state,
      transaction: txn,
    });
  } catch (err) {
    logger.error('checkPaymentStatus error:', err?.response?.data || err.message);
    return sendError(res, 500, 'Failed to fetch payment status', ERROR_CODES.INTERNAL_ERROR);
  }
};

/**
 * POST /api/payments/cod-confirm
 * Confirm a Cash-on-Delivery order.
 * Body: { orderId }
 */
const confirmCod = async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return sendError(res, 400, 'orderId required', ERROR_CODES.MISSING_FIELDS);

    const merchantTransactionId = `COD_${crypto.randomUUID().replace(/-/g, '').slice(0, 34)}`;

    const order = await Order.findOne({ _id: orderId, customerId: req.user.id });
    if (!order) return sendError(res, 404, 'Order not found', ERROR_CODES.NOT_FOUND);
    if (order.paymentMethod !== 'cod') {
      return sendError(res, 400, 'Order payment method is not COD', ERROR_CODES.VALIDATION_ERROR);
    }
    // BUG-015: Only allow confirmation for orders in CONFIRMED state
    if (order.status !== ORDER_STATUS.CONFIRMED) {
      return sendError(res, 400, 'Order is not in a confirmable state', ERROR_CODES.VALIDATION_ERROR);
    }
    // BUG-015: Prevent duplicate COD transaction records
    const existingTxn = await Transaction.findOne({ orderId });
    if (existingTxn) {
      return sendSuccess(res, 200, 'COD order already confirmed', { transactionId: existingTxn._id });
    }

    const txn = await Transaction.create({
      orderId,
      customerId: req.user.id,
      merchantTransactionId,
      amount: order.totalAmount * 100, // stored in paise; collected at delivery
      method: 'cod',
      status: 'created',
    });

    // COD orders are already routed at placement; just update payment status
    order.paymentStatus = PAYMENT_STATUS.PENDING; // Collected at delivery
    await order.save();

    return sendSuccess(res, 200, 'COD order confirmed', { transactionId: txn._id });
  } catch (err) {
    logger.error('confirmCod error:', err);
    return sendError(res, 500, 'COD confirmation failed', ERROR_CODES.INTERNAL_ERROR);
  }
};

/**
 * POST /api/payments/refund/:transactionId
 * Admin: initiate a PhonePe refund.
 */
const initiateRefund = async (req, res) => {
  try {
    const txn = await Transaction.findById(req.params.transactionId);
    if (!txn) return sendError(res, 404, 'Transaction not found', ERROR_CODES.NOT_FOUND);
    if (txn.status !== 'paid') return sendError(res, 400, 'Only paid transactions can be refunded', ERROR_CODES.REFUND_FAILED);

    const refundTransactionId = `REFUND_${crypto.randomUUID().replace(/-/g, '').slice(0, 30)}`;

    const payloadObj = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: refundTransactionId,
      originalTransactionId: txn.merchantTransactionId,
      amount: txn.amount,
      callbackUrl: `${process.env.APP_BASE_URL}/api/payments/callback`,
    };

    const base64Payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64');
    const checksum = buildChecksum(base64Payload, '/pg/v1/refund');

    const { data: phonepeRes } = await axios.post(
      `${PHONEPE_BASE_URL}/pg/v1/refund`,
      { request: base64Payload },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-VERIFY': checksum,
        },
      },
    );

    if (!phonepeRes.success) {
      logger.error('PhonePe refund failed:', phonepeRes);
      return sendError(res, 502, 'Refund initiation failed', ERROR_CODES.REFUND_FAILED);
    }

    txn.status = 'refunded';
    txn.refundTransactionId = refundTransactionId;
    txn.refundedAt = new Date();
    await txn.save();

    return sendSuccess(res, 200, 'Refund initiated', { refundTransactionId });
  } catch (err) {
    logger.error('initiateRefund error:', err?.response?.data || err.message);
    return sendError(res, 500, 'Refund failed', ERROR_CODES.INTERNAL_ERROR);
  }
};

/**
 * GET /api/payments/vendor/payouts
 * Admin: list pending vendor payouts.
 */
const listVendorPayouts = async (req, res) => {
  // Placeholder — full implementation in Phase 7 (Admin Service)
  return sendSuccess(res, 200, 'Vendor payouts (placeholder)', []);
};

/**
 * POST /api/payments/vendor/payout/:vendorId
 * Admin: trigger a PhonePe payout to vendor UPI.
 */
const triggerVendorPayout = async (req, res) => {
  // Placeholder — full implementation in Phase 7
  return sendSuccess(res, 200, 'Payout triggered (placeholder)', { vendorId: req.params.vendorId });
};

module.exports = {
  createPaymentOrder,
  handleCallback,
  checkPaymentStatus,
  confirmCod,
  initiateRefund,
  listVendorPayouts,
  triggerVendorPayout,
};
