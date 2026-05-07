const { Router } = require('express');
const {
  checkStockController,
  placeOrder,
  getOrders,
  getOrderById,
  cancelOrder,
  rateOrder,
  getVendorIncoming,
  vendorAcceptOrder,
  vendorRejectOrder,
  validateCouponController,
} = require('../controllers/order.controller');
const { authenticate } = require('../../../gateway/middleware/auth.middleware');
const { requireRole } = require('../../../gateway/middleware/roleGuard');
const ROLES = require('../../../shared/constants/roles');

const router = Router();

// All order routes require authentication
router.use(authenticate);

// ── Customer routes ───────────────────────────────────────────────
router.post('/check-stock', requireRole(ROLES.CUSTOMER), checkStockController);
router.post('/validate-coupon', requireRole(ROLES.CUSTOMER), validateCouponController);
router.post('/', requireRole(ROLES.CUSTOMER), placeOrder);
router.get('/', requireRole(ROLES.CUSTOMER), getOrders);
router.get('/:id', getOrderById);                                  // Customer + vendor + rider
router.patch('/:id/cancel', requireRole(ROLES.CUSTOMER), cancelOrder);
router.post('/:id/rate', requireRole(ROLES.CUSTOMER), rateOrder);

// ── Vendor routes ─────────────────────────────────────────────────
router.get('/vendor/incoming', requireRole(ROLES.VENDOR), getVendorIncoming);
router.patch('/vendor/:id/accept', requireRole(ROLES.VENDOR), vendorAcceptOrder);
router.patch('/vendor/:id/reject', requireRole(ROLES.VENDOR), vendorRejectOrder);

module.exports = router;
