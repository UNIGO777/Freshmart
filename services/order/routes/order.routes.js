const { Router } = require('express');
const {
  checkStockController,
  placeOrder,
  getOrders,
  getOrderById,
  cancelOrder,
  rateOrder,
  getVendorIncoming,
  getVendorHistory,
  getVendorStats,
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

// ── Vendor routes (before /:id to avoid conflict) ────────────────
router.get('/vendor/incoming', requireRole(ROLES.VENDOR), getVendorIncoming);
router.get('/vendor/history', requireRole(ROLES.VENDOR), getVendorHistory);
router.get('/vendor/stats', requireRole(ROLES.VENDOR), getVendorStats);
router.patch('/vendor/:id/accept', requireRole(ROLES.VENDOR), vendorAcceptOrder);
router.patch('/vendor/:id/reject', requireRole(ROLES.VENDOR), vendorRejectOrder);

// ── Customer routes ───────────────────────────────────────────────
router.post('/check-stock', requireRole(ROLES.CUSTOMER), checkStockController);
router.post('/validate-coupon', requireRole(ROLES.CUSTOMER), validateCouponController);
router.post('/', requireRole(ROLES.CUSTOMER), placeOrder);
router.get('/', requireRole(ROLES.CUSTOMER), getOrders);
router.get('/:id', getOrderById);                                  // Customer + vendor + rider
router.patch('/:id/cancel', requireRole(ROLES.CUSTOMER), cancelOrder);
router.post('/:id/rate', requireRole(ROLES.CUSTOMER), rateOrder);

module.exports = router;
