const { Router } = require('express');

// Controllers
const { getDashboard }                              = require('../controllers/dashboard.controller');
const { getAnalytics, getRevenueOverTime, getOrdersOverTime,
        getCategoryRevenue, getTopProducts, getPeakHours,
        getOrdersByHour }                           = require('../controllers/analytics.controller');
const { listVendors, getVendorDetail,
        approveVendor, blockVendor,
        createVendor, getVendorEarnings }           = require('../controllers/vendor-mgmt.controller');
const { listRiders, getRiderDetail,
        approveRider, blockRider,
        createRider, getRiderEarnings }             = require('../controllers/rider-mgmt.controller');
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
const { uploadFile }                                = require('../controllers/upload.controller');
const { listBanners, createBanner, updateBanner,
        deleteBanner, toggleBanner,
        reorderBanners }                            = require('../controllers/banner.controller');
const { listDeals, createDeal, updateDeal,
        toggleDeal, deleteDeal }                    = require('../controllers/deal.controller');
const { getDeliveryConfig, updateRate,
        updateSurge, updateFees,
        getCustomerDeliveryConfig }                 = require('../controllers/delivery-config.controller');
const { listRiderWallets, getWalletStats,
        getRiderWalletDetail, processWithdrawal,
        processDeduction, settleCredit }            = require('../controllers/riderWallet.controller');
const { listVendorWallets, getVendorWalletStats,
        getVendorWalletDetail, processVendorPayout } = require('../controllers/vendorWallet.controller');

// Auth (double-checked inside the service — gateway already enforces ADMIN)
const { authenticate } = require('../../../gateway/middleware/auth.middleware');
const { requireRole } = require('../../../gateway/middleware/roleGuard');
const ROLES = require('../../../shared/constants/roles');

const router = Router();

// All admin routes require a valid JWT + ADMIN role
router.use(authenticate, requireRole(ROLES.ADMIN));

// ── File Upload (Cloudinary via backend) ─────────────────────────
router.post('/upload', uploadFile);

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
router.get('/vendors/:id/earnings',   getVendorEarnings);
router.patch('/vendors/:id/approve',  approveVendor);
router.patch('/vendors/:id/block',    blockVendor);

// ── Rider management ──────────────────────────────────────────────
router.get('/riders',                 listRiders);
router.post('/riders',                createRider);
router.get('/riders/:id',             getRiderDetail);
router.get('/riders/:id/earnings',    getRiderEarnings);
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
router.post('/payouts',               triggerPayout);       // body: { vendorId, weekStart }
router.get('/payouts/history',        getPayoutHistory);    // must be before /:vendorId
router.get('/payouts/:vendorId',      getVendorPayoutHistory);

// ── Coupons (implemented in Phase 4) ─────────────────────────────
router.post('/coupons',               createCoupon);
router.get('/coupons',                listCoupons);
router.patch('/coupons/:id',          updateCoupon);
router.delete('/coupons/:id',         disableCoupon);

// ── Banners ───────────────────────────────────────────────────────
router.get('/banners',              listBanners);
router.post('/banners',             createBanner);
router.put('/banners/reorder',      reorderBanners);   // must be before /:id
router.patch('/banners/:id',        updateBanner);
router.patch('/banners/:id/toggle', toggleBanner);
router.delete('/banners/:id',       deleteBanner);

// ── Rider Wallets ─────────────────────────────────────────────────
router.get('/rider-wallets/stats',             getWalletStats);      // must be before :riderId
router.get('/rider-wallets',                   listRiderWallets);
router.get('/rider-wallets/:riderId',          getRiderWalletDetail);
router.post('/rider-wallets/:riderId/withdraw', processWithdrawal);
router.post('/rider-wallets/:riderId/deduct',   processDeduction);
router.post('/rider-wallets/:riderId/settle-credit', settleCredit);

// ── Vendor Wallets (manual payouts) ──────────────────────────────
router.get('/vendor-wallets/stats',              getVendorWalletStats); // before :vendorId
router.get('/vendor-wallets',                    listVendorWallets);
router.get('/vendor-wallets/:vendorId',          getVendorWalletDetail);
router.post('/vendor-wallets/:vendorId/payout',  processVendorPayout);

// ── Delivery Config (rate + surge + fees) ────────────────────────
router.get('/delivery-config',           getDeliveryConfig);
router.patch('/delivery-config/rate',    updateRate);
router.patch('/delivery-config/surge',   updateSurge);
router.patch('/delivery-config/fees',    updateFees);

// ── Deal of the Day ───────────────────────────────────────────────
router.get('/deals',                listDeals);
router.post('/deals',               createDeal);
router.patch('/deals/:id',          updateDeal);
router.patch('/deals/:id/toggle',   toggleDeal);
router.delete('/deals/:id',         deleteDeal);

module.exports = router;
