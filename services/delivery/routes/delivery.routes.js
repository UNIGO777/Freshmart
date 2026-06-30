const { Router } = require('express');
const {
  toggleStatus,
  getRiderJobs,
  acceptJob,
  rejectJob,
  markPickedUp,
  markDelivered,
  updateLocation,
  getRiderEarnings,
  getRiderWallet,
  getWalletTransactions,
  getWalletWithdrawals,
  getDailyEarnings,
  getRiderPerformance,
  getSurgeStatus,
  getOnlineHours,
  getTodayCompleted,
  requestRiderCancel,
  confirmReturn,
  resetAllJobs,
  getVendorActiveOtps,
  getCustomerActiveOtps,
} = require('../controllers/delivery.controller');

const router = Router();

// All /api/delivery routes require auth (enforced by API Gateway).
// Role guard (RIDER only) is handled at the gateway for these routes.

router.patch('/rider/status',          toggleStatus);
router.get('/rider/orders',            getRiderJobs);
router.patch('/rider/accept/:jobId',   acceptJob);
router.patch('/rider/reject/:jobId',   rejectJob);
router.patch('/rider/pickup/:jobId',   markPickedUp);
router.patch('/rider/deliver/:jobId',         markDelivered);
router.patch('/rider/cancel-request/:jobId', requestRiderCancel);
router.patch('/rider/confirm-return/:jobId', confirmReturn);
router.post('/rider/location',               updateLocation);
router.get('/rider/earnings',          getRiderEarnings);

// Wallet
router.get('/rider/wallet',                getRiderWallet);
router.get('/rider/wallet/transactions',   getWalletTransactions);
router.get('/rider/wallet/withdrawals',    getWalletWithdrawals);

// Analytics & performance
router.get('/rider/earnings/daily',        getDailyEarnings);
router.get('/rider/performance',           getRiderPerformance);
router.get('/rider/surge-status',          getSurgeStatus);
router.get('/rider/online-hours',          getOnlineHours);
router.get('/rider/today-completed',       getTodayCompleted);

// OTP fetch (survives app restart)
router.get('/vendor/active-otps',          getVendorActiveOtps);
router.get('/customer/active-otps',        getCustomerActiveOtps);

// Test mode
router.post('/rider/reset-all-jobs',       resetAllJobs);

module.exports = router;
