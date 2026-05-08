const Order         = require('../../order/models/Order.model');
const VendorEarning = require('../../vendor/models/VendorEarning.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

/**
 * Returns the start date for a given period string.
 * @param {'day'|'week'|'month'|'year'} period
 */
const periodStart = (period) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  switch (period) {
    case 'day':   break;                           // today only
    case 'week':  d.setDate(d.getDate() - 6);     break; // last 7 days
    case 'month': d.setDate(d.getDate() - 29);    break; // last 30 days
    case 'year':  d.setMonth(d.getMonth() - 11);  break; // last 12 months
    default:      d.setDate(d.getDate() - 6);            // default: week
  }
  return d;
};

// ── GET /analytics?period=week ────────────────────────────────────
const getAnalytics = async (req, res) => {
  try {
    const period = ['day', 'week', 'month', 'year'].includes(req.query.period)
      ? req.query.period
      : 'week';

    const startDate = periodStart(period);

    // Group format: day-level for day/week/month; month-level for year
    const dateFormat = period === 'year' ? '%Y-%m' : '%Y-%m-%d';

    const [
      revenueTimeline,
      topProducts,
      topVendors,
      ordersByStatus,
      paymentMethodBreakdown,
    ] = await Promise.all([

      // Revenue & order count over time
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

      // Top 10 products by revenue
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

      // Top 10 vendors by net earnings
      VendorEarning.aggregate([
        { $match: { earningDate: { $gte: startDate } } },
        {
          $group: {
            _id:           '$vendorId',
            totalNet:      { $sum: '$netAmount' },
            totalGross:    { $sum: '$grossAmount' },
            ordersCount:   { $sum: 1 },
          },
        },
        { $sort: { totalNet: -1 } },
        { $limit: 10 },
        {
          $lookup: {
            from:         'vendors',
            localField:   '_id',
            foreignField: '_id',
            as:           'vendor',
          },
        },
        { $unwind: { path: '$vendor', preserveNullAndEmpty: true } },
        {
          $project: {
            totalNet: 1, totalGross: 1, ordersCount: 1,
            'vendor.businessName': 1, 'vendor.phone': 1,
          },
        },
      ]),

      // Order count by status
      Order.aggregate([
        { $match: { createdAt: { $gte: startDate } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      // Orders by payment method
      Order.aggregate([
        { $match: { createdAt: { $gte: startDate } } },
        { $group: { _id: '$paymentMethod', count: { $sum: 1 } } },
      ]),
    ]);

    return sendSuccess(res, 200, 'Analytics data', {
      period,
      startDate,
      revenueTimeline,
      topProducts,
      topVendors,
      ordersByStatus,
      paymentMethodBreakdown,
    });
  } catch (err) {
    logger.error('getAnalytics error:', err);
    return sendError(res, 500, 'Failed to load analytics', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { getAnalytics };
