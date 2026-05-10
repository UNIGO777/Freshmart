const Order         = require('../../order/models/Order.model');
const VendorEarning = require('../../vendor/models/VendorEarning.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// ── Helpers ────────────────────────────────────────────────────────

const parseRange = (req) => {
  const now = new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(now - 7 * 24 * 3600 * 1000);
  const to   = req.query.to   ? new Date(req.query.to)   : now;
  return { from, to };
};

const daysFromParam = (req) => {
  const d = parseInt(req.query.days) || 7;
  const to = new Date();
  const from = new Date(to - d * 24 * 3600 * 1000);
  return { from, to };
};

// ── GET /analytics/revenue ─────────────────────────────────────────
// Supports ?from=ISO&to=ISO (analytics page) and ?days=N (dashboard)
const getRevenueOverTime = async (req, res) => {
  try {
    const { from, to } = req.query.from ? parseRange(req) : daysFromParam(req);

    const data = await Order.aggregate([
      { $match: { paymentStatus: 'paid', createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id:     { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          revenue: { $sum: '$totalAmount' },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', revenue: 1 } },
    ]);

    return sendSuccess(res, 200, 'Revenue over time', data);
  } catch (err) {
    logger.error('getRevenueOverTime error:', err);
    return sendError(res, 500, 'Failed to fetch revenue data', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /analytics/orders ──────────────────────────────────────────
const getOrdersOverTime = async (req, res) => {
  try {
    const { from, to } = parseRange(req);

    const data = await Order.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id:    { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', orders: 1 } },
    ]);

    return sendSuccess(res, 200, 'Orders over time', data);
  } catch (err) {
    logger.error('getOrdersOverTime error:', err);
    return sendError(res, 500, 'Failed to fetch orders data', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /analytics/category-revenue ───────────────────────────────
const getCategoryRevenue = async (req, res) => {
  try {
    const { from, to } = parseRange(req);

    const data = await Order.aggregate([
      { $match: { paymentStatus: 'paid', createdAt: { $gte: from, $lte: to } } },
      { $unwind: '$items' },
      {
        $lookup: {
          from: 'products',
          localField: 'items.productId',
          foreignField: '_id',
          as: 'product',
        },
      },
      { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id:   { $ifNull: ['$product.category', 'other'] },
          value: { $sum: { $multiply: ['$items.quantity', '$items.sellingPrice'] } },
        },
      },
      { $sort: { value: -1 } },
      { $project: { _id: 0, name: '$_id', value: 1 } },
    ]);

    return sendSuccess(res, 200, 'Category revenue', data);
  } catch (err) {
    logger.error('getCategoryRevenue error:', err);
    return sendError(res, 500, 'Failed to fetch category revenue', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /analytics/top-products ───────────────────────────────────
const getTopProducts = async (req, res) => {
  try {
    const { from, to } = parseRange(req);

    const data = await Order.aggregate([
      { $match: { paymentStatus: 'paid', createdAt: { $gte: from, $lte: to } } },
      { $unwind: '$items' },
      {
        $group: {
          _id:     '$items.productId',
          name:    { $first: '$items.name' },
          revenue: { $sum: { $multiply: ['$items.quantity', '$items.sellingPrice'] } },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 10 },
      { $project: { _id: 0, name: 1, revenue: 1 } },
    ]);

    return sendSuccess(res, 200, 'Top products', data);
  } catch (err) {
    logger.error('getTopProducts error:', err);
    return sendError(res, 500, 'Failed to fetch top products', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /analytics/peak-hours ──────────────────────────────────────
const getPeakHours = async (req, res) => {
  try {
    const { from, to } = parseRange(req);

    const data = await Order.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id:    { $hour: '$createdAt' },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, hour: '$_id', orders: 1 } },
    ]);

    return sendSuccess(res, 200, 'Peak hours', data);
  } catch (err) {
    logger.error('getPeakHours error:', err);
    return sendError(res, 500, 'Failed to fetch peak hours', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /analytics/orders-by-hour (dashboard alias) ───────────────
const getOrdersByHour = async (req, res) => {
  // Last 7 days
  const to   = new Date();
  const from = new Date(to - 7 * 24 * 3600 * 1000);

  try {
    const data = await Order.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id:   { $hour: '$createdAt' },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, hour: '$_id', count: 1 } },
    ]);

    return sendSuccess(res, 200, 'Orders by hour', data);
  } catch (err) {
    logger.error('getOrdersByHour error:', err);
    return sendError(res, 500, 'Failed to fetch orders by hour', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /analytics (legacy — full analytics summary) ──────────────
const getAnalytics = async (req, res) => {
  try {
    const period = ['day', 'week', 'month', 'year'].includes(req.query.period)
      ? req.query.period
      : 'week';

    const d = new Date();
    d.setHours(0, 0, 0, 0);
    switch (period) {
      case 'day':   break;
      case 'week':  d.setDate(d.getDate() - 6);     break;
      case 'month': d.setDate(d.getDate() - 29);    break;
      case 'year':  d.setMonth(d.getMonth() - 11);  break;
    }
    const startDate = d;
    const dateFormat = period === 'year' ? '%Y-%m' : '%Y-%m-%d';

    const [
      revenueTimeline,
      topProducts,
      topVendors,
      ordersByStatus,
      paymentMethodBreakdown,
    ] = await Promise.all([
      Order.aggregate([
        { $match: { paymentStatus: 'paid', createdAt: { $gte: startDate } } },
        {
          $group: {
            _id:      { $dateToString: { format: dateFormat, date: '$createdAt' } },
            revenue:  { $sum: '$totalAmount' },
            orders:   { $sum: 1 },
            discount: { $sum: '$discountAmount' },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Order.aggregate([
        { $match: { paymentStatus: 'paid', createdAt: { $gte: startDate } } },
        { $unwind: '$items' },
        {
          $group: {
            _id:      '$items.productId',
            name:     { $first: '$items.name' },
            totalQty: { $sum: '$items.quantity' },
            revenue:  { $sum: { $multiply: ['$items.quantity', '$items.sellingPrice'] } },
          },
        },
        { $sort: { revenue: -1 } },
        { $limit: 10 },
      ]),
      VendorEarning.aggregate([
        { $match: { earningDate: { $gte: startDate } } },
        {
          $group: {
            _id:         '$vendorId',
            totalNet:    { $sum: '$netAmount' },
            totalSales:  { $sum: '$salesAmount' },
            totalMargin: { $sum: '$marginAmount' },
            ordersCount: { $sum: 1 },
          },
        },
        { $sort: { totalNet: -1 } },
        { $limit: 10 },
        { $lookup: { from: 'vendors', localField: '_id', foreignField: '_id', as: 'vendor' } },
        { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },
        { $project: { totalNet: 1, totalSales: 1, totalMargin: 1, ordersCount: 1, 'vendor.businessName': 1, 'vendor.phone': 1 } },
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: startDate } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: startDate } } },
        { $group: { _id: '$paymentMethod', count: { $sum: 1 } } },
      ]),
    ]);

    return sendSuccess(res, 200, 'Analytics data', {
      period, startDate, revenueTimeline, topProducts, topVendors, ordersByStatus, paymentMethodBreakdown,
    });
  } catch (err) {
    logger.error('getAnalytics error:', err);
    return sendError(res, 500, 'Failed to load analytics', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = {
  getAnalytics,
  getRevenueOverTime,
  getOrdersOverTime,
  getCategoryRevenue,
  getTopProducts,
  getPeakHours,
  getOrdersByHour,
};
