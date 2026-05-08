const Product  = require('../../product/models/Product.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// ── GET /pricing ──────────────────────────────────────────────────
// Overview: counts of products priced today vs stale, available vs unavailable.
// Helps admin see what still needs to be priced for the day.
const getPricingOverview = async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [byCategory, staleProducts, unavailableProducts, totalProducts] = await Promise.all([
      // Count priced today vs stale, grouped by category
      Product.aggregate([
        {
          $group: {
            _id:         '$category',
            total:       { $sum: 1 },
            pricedToday: {
              $sum: {
                $cond: [{ $gte: ['$lastPricedAt', todayStart] }, 1, 0],
              },
            },
            available: {
              $sum: { $cond: ['$isAvailableToday', 1, 0] },
            },
          },
        },
        { $sort: { _id: 1 } },
      ]),

      // Products whose price hasn't been updated today
      Product.find({ $or: [{ lastPricedAt: { $lt: todayStart } }, { lastPricedAt: null }] })
        .select('name nameHi category sellingPrice buyingPrice lastPricedAt isAvailableToday')
        .sort({ category: 1, name: 1 })
        .lean(),

      // Products toggled unavailable today
      Product.find({ isAvailableToday: false })
        .select('name nameHi category')
        .sort({ category: 1 })
        .lean(),

      Product.countDocuments(),
    ]);

    return sendSuccess(res, 200, 'Pricing overview', {
      totalProducts,
      byCategory,
      staleCount:       staleProducts.length,
      unavailableCount: unavailableProducts.length,
      staleProducts,
      unavailableProducts,
    });
  } catch (err) {
    logger.error('getPricingOverview error:', err);
    return sendError(res, 500, 'Failed to load pricing overview', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { getPricingOverview };
