const VendorEarning = require('../../vendor/models/VendorEarning.model');
const Vendor        = require('../../user/models/Vendor.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// ── GET /payouts ──────────────────────────────────────────────────
// List all vendors that have pending earnings, showing payout-ready amounts.
// Optional filter: ?vendorId=, ?status=pending|paid
const listPayouts = async (req, res) => {
  try {
    const matchStage = {};
    if (req.query.status) matchStage.status = req.query.status;
    if (req.query.vendorId) matchStage.vendorId = require('mongoose').Types.ObjectId(req.query.vendorId);

    const payouts = await VendorEarning.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id:           '$vendorId',
          pendingAmount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$netAmount', 0] } },
          paidAmount:    { $sum: { $cond: [{ $eq: ['$status', 'paid'] },    '$netAmount', 0] } },
          pendingCount:  { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          paidCount:     { $sum: { $cond: [{ $eq: ['$status', 'paid'] },    1, 0] } },
          lastEarning:   { $max: '$earningDate' },
        },
      },
      { $sort: { pendingAmount: -1 } },
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
          pendingAmount: 1, paidAmount: 1,
          pendingCount:  1, paidCount:  1,
          lastEarning:   1,
          'vendor.businessName': 1,
          'vendor.phone':        1,
          'vendor.bankDetails':  1,
          'vendor.commissionPercent': 1,
        },
      },
    ]);

    return sendSuccess(res, 200, 'Payouts fetched', payouts);
  } catch (err) {
    logger.error('listPayouts error:', err);
    return sendError(res, 500, 'Failed to fetch payouts', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /payouts/:vendorId ────────────────────────────────────────
// Detailed earning history for a specific vendor
const getVendorPayoutHistory = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter = { vendorId: req.params.vendorId };
    if (req.query.status) filter.status = req.query.status;

    const [vendor, earnings, total] = await Promise.all([
      Vendor.findById(req.params.vendorId).select('businessName phone bankDetails commissionPercent').lean(),
      VendorEarning.find(filter)
        .sort({ earningDate: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      VendorEarning.countDocuments(filter),
    ]);

    if (!vendor) return sendError(res, 404, 'Vendor not found', ERROR_CODES.NOT_FOUND);

    return sendSuccess(res, 200, 'Payout history', { vendor, earnings, total, page, limit });
  } catch (err) {
    logger.error('getVendorPayoutHistory error:', err);
    return sendError(res, 500, 'Failed to fetch payout history', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /payouts/:vendorId ───────────────────────────────────────
// Mark all pending earnings for this vendor as paid.
// In production: call payment gateway transfer API here before marking paid.
const triggerPayout = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.vendorId)
      .select('businessName bankDetails')
      .lean();
    if (!vendor) return sendError(res, 404, 'Vendor not found', ERROR_CODES.NOT_FOUND);

    // Sum pending earnings before marking paid
    const summary = await VendorEarning.aggregate([
      { $match: { vendorId: require('mongoose').Types.ObjectId(req.params.vendorId), status: 'pending' } },
      { $group: { _id: null, total: { $sum: '$netAmount' }, count: { $sum: 1 } } },
    ]);

    if (!summary.length || summary[0].count === 0) {
      return sendError(res, 400, 'No pending earnings for this vendor', ERROR_CODES.VALIDATION_ERROR);
    }

    const { total: payoutAmount, count: earningCount } = summary[0];

    // Mark all pending earnings as paid
    const paidAt = new Date();
    await VendorEarning.updateMany(
      { vendorId: req.params.vendorId, status: 'pending' },
      { $set: { status: 'paid', paidAt } },
    );

    logger.info(`Payout of ₹${payoutAmount} triggered for vendor ${vendor.businessName} (${req.params.vendorId})`);

    return sendSuccess(res, 200, 'Payout processed', {
      vendorId:    req.params.vendorId,
      vendor:      vendor.businessName,
      payoutAmount,
      earningCount,
      paidAt,
      bankDetails: vendor.bankDetails,
    });
  } catch (err) {
    logger.error('triggerPayout error:', err);
    return sendError(res, 500, 'Failed to process payout', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { listPayouts, getVendorPayoutHistory, triggerPayout };
