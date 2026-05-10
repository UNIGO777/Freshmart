const { Router } = require('express');

// Controllers
const { getDashboard }                              = require('../controllers/dashboard.controller');
const { getAnalytics, getRevenueOverTime, getOrdersOverTime,
        getCategoryRevenue, getTopProducts, getPeakHours,
        getOrdersByHour }                           = require('../controllers/analytics.controller');
const { listVendors, getVendorDetail,
        approveVendor, blockVendor,
        createVendor }                              = require('../controllers/vendor-mgmt.controller');
const { listRiders, getRiderDetail,
        approveRider, blockRider,
        createRider }                               = require('../controllers/rider-mgmt.controller');
const { listCustomers, getCustomerDetail,
        blockCustomer }                             = require('../controllers/customer-mgmt.controller');
const { listOrders, getOrderDetail,
        overrideOrderStatus }                       = require('../controllers/order-mgmt.controller');
const { listPayouts, getPayoutHistory,
        getVendorPayoutHistory,
        triggerPayout }                             = require('../controllers/payout.controller');
const { getPricingOverview }                        = require('../controllers/pricing.controller');
const { createCoupon, listCoupons,
        updateCoupon, disableCoupon }               = require('../controllers/coupon.controller');

// Auth (double-checked inside the service — gateway already enforces ADMIN)
const { authenticate } = require('../../../gateway/middleware/auth.middleware');
const { requireRole } = require('../../../gateway/middleware/roleGuard');
const ROLES = require('../../../shared/constants/roles');

const router = Router();

// All admin routes require a valid JWT + ADMIN role
router.use(authenticate, requireRole(ROLES.ADMIN));

// ── Dashboard & Analytics ─────────────────────────────────────────
router.get('/dashboard',                    getDashboard);
router.get('/analytics',                    getAnalytics);
router.get('/analytics/revenue',            getRevenueOverTime);
router.get('/analytics/orders',             getOrdersOverTime);
router.get('/analytics/category-revenue',   getCategoryRevenue);
router.get('/analytics/top-products',       getTopProducts);
router.get('/analytics/peak-hours',         getPeakHours);
router.get('/analytics/orders-by-hour',     getOrdersByHour);
router.get('/pricing',                      getPricingOverview);

// ── Vendor management ─────────────────────────────────────────────
router.get('/vendors',                listVendors);
router.post('/vendors',               createVendor);
router.get('/vendors/:id',            getVendorDetail);
router.patch('/vendors/:id/approve',  approveVendor);
router.patch('/vendors/:id/block',    blockVendor);

// ── Rider management ──────────────────────────────────────────────
router.get('/riders',                 listRiders);
router.post('/riders',                createRider);
router.get('/riders/:id',             getRiderDetail);
router.patch('/riders/:id/approve',   approveRider);
router.patch('/riders/:id/block',     blockRider);

// ── Customer management ───────────────────────────────────────────
router.get('/customers',              listCustomers);
router.get('/customers/:id',          getCustomerDetail);
router.patch('/customers/:id/block',  blockCustomer);

// ── Order management ──────────────────────────────────────────────
router.get('/orders',                 listOrders);
router.get('/orders/:id',             getOrderDetail);
router.patch('/orders/:id/status',    overrideOrderStatus);

// ── Payouts ───────────────────────────────────────────────────────
router.get('/payouts',                listPayouts);
router.get('/payouts/history',        getPayoutHistory);   // must be before /:vendorId
router.get('/payouts/:vendorId',      getVendorPayoutHistory);
router.post('/payouts/:vendorId',     triggerPayout);

// ── Coupons (implemented in Phase 4) ─────────────────────────────
router.post('/coupons',               createCoupon);
router.get('/coupons',                listCoupons);
router.patch('/coupons/:id',          updateCoupon);
router.delete('/coupons/:id',         disableCoupon);

module.exports = router;
