const Order    = require('../../order/models/Order.model');
const Customer = require('../../user/models/Customer.model');
const Vendor   = require('../../user/models/Vendor.model');
const Rider    = require('../../user/models/Rider.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// ── GET /dashboard ────────────────────────────────────────────────
const getDashboard = async (_req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [
      ordersToday,
      revenueTodayResult,
      totalRevenueResult,
      totalOrders,
      pendingOrders,
      activeRiders,
      onlineRiders,
      activeVendors,
      totalCustomers,
      newCustomersToday,
    ] = await Promise.all([
      Order.countDocuments({ createdAt: { $gte: todayStart } }),

      Order.aggregate([
        { $match: { paymentStatus: 'paid', createdAt: { $gte: todayStart } } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]),

      Order.aggregate([
        { $match: { paymentStatus: 'paid' } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]),

      Order.countDocuments(),

      Order.countDocuments({ status: { $in: ['confirmed', 'partially_delivered'] } }),

      Rider.countDocuments({ isApproved: true, isActive: true }),
      Rider.countDocuments({ isOnline: true }),

      Vendor.countDocuments({ isApproved: true, isActive: true }),

      Customer.countDocuments({ isActive: true }),
      Customer.countDocuments({ isActive: true, createdAt: { $gte: todayStart } }),
    ]);

    return sendSuccess(res, 200, 'Dashboard data', {
      orders: {
        today:   ordersToday,
        total:   totalOrders,
        pending: pendingOrders,
      },
      revenue: {
        today: revenueTodayResult[0]?.total ?? 0,
        total: totalRevenueResult[0]?.total ?? 0,
      },
      riders: {
        total:  activeRiders,
        online: onlineRiders,
      },
      vendors: {
        active: activeVendors,
      },
      customers: {
        total:    totalCustomers,
        newToday: newCustomersToday,
      },
    });
  } catch (err) {
    logger.error('getDashboard error:', err);
    return sendError(res, 500, 'Failed to load dashboard', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { getDashboard };
