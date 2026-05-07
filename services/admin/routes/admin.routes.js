const { Router } = require('express');
const { getDashboard } = require('../controllers/dashboard.controller');
const { listPayouts, triggerPayout } = require('../controllers/payout.controller');
const { getPricingOverview } = require('../controllers/pricing.controller');
const { createCoupon, listCoupons, updateCoupon, disableCoupon } = require('../controllers/coupon.controller');
const { authenticate } = require('../../../gateway/middleware/auth.middleware');
const { requireRole } = require('../../../gateway/middleware/roleGuard');
const ROLES = require('../../../shared/constants/roles');

const router = Router();

// All admin routes require ADMIN role
router.use(authenticate, requireRole(ROLES.ADMIN));

// Dashboard
router.get('/dashboard', getDashboard);

// Coupons  (Phase 4)
router.post('/coupons', createCoupon);
router.get('/coupons', listCoupons);
router.patch('/coupons/:id', updateCoupon);
router.delete('/coupons/:id', disableCoupon);

// Pricing overview
router.get('/pricing', getPricingOverview);

// Payouts (Phase 7)
router.get('/payouts', listPayouts);
router.post('/payouts/:vendorId', triggerPayout);

module.exports = router;
