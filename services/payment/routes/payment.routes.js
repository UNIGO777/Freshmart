const { Router } = require('express');
const {
  createPaymentOrder,
  handleCallback,
  checkPaymentStatus,
  confirmCod,
  initiateRefund,
  listVendorPayouts,
  triggerVendorPayout,
} = require('../controllers/payment.controller');
const { authenticate } = require('../../../gateway/middleware/auth.middleware');
const { requireRole } = require('../../../gateway/middleware/roleGuard');
const ROLES = require('../../../shared/constants/roles');

const router = Router();

// PhonePe server-to-server callback — no auth (PhonePe hits this directly)
router.post('/callback', handleCallback);

// Customer routes
router.post('/create-order', authenticate, createPaymentOrder);
router.post('/cod-confirm', authenticate, confirmCod);
router.get('/status/:merchantTransactionId', authenticate, checkPaymentStatus);

// Admin routes
router.post('/refund/:transactionId', authenticate, requireRole(ROLES.ADMIN), initiateRefund);
router.get('/vendor/payouts', authenticate, requireRole(ROLES.ADMIN), listVendorPayouts);
router.post('/vendor/payout/:vendorId', authenticate, requireRole(ROLES.ADMIN), triggerVendorPayout);

module.exports = router;
