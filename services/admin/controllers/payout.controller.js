const mongoose = require('mongoose');
const VendorEarning = require('../../vendor/models/VendorEarning.model');
const Vendor        = require('../../user/models/Vendor.model');
const Admin         = require('../models/Admin.model');
const PayoutRecord  = require('../models/PayoutRecord.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const { notifyAdmin } = require('../../../shared/utils/notifyAdmin');
const logger = require('../../../shared/utils/logger');

// Returns Monday 00:00:00 UTC of the week containing `date`
function isoWeekStart(date) {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function isoWeekEnd(weekStart) {
  const d = new Date(weekStart);
  d.setUTCDate(d.getUTCDate() + 6);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

// ── GET /payouts ──────────────────────────────────────────────────
// Returns pending earnings grouped by vendor × ISO week, sorted by weekStart desc then pendingAmount desc.
const listPayouts = async (req, res) => {
  try {
    const rows = await VendorEarning.aggregate([
      { $match: { status: 'pending' } },
      {
        $addFields: {
          // Compute ISO week start (Monday) from earningDate
          dayOfWeek: { $dayOfWeek: '$earningDate' }, // 1=Sun..7=Sat
        },
      },
      {
        $addFields: {
          // Offset back to Monday: Sun(-6), Mon(0), Tue(-1)... Sat(-5)
          daysToMonday: {
            $switch: {
              branches: [
                { case: { $eq: ['$dayOfWeek', 1] }, then: -6 },
                { case: { $eq: ['$dayOfWeek', 2] }, then: 0 },
                { case: { $eq: ['$dayOfWeek', 3] }, then: -1 },
                { case: { $eq: ['$dayOfWeek', 4] }, then: -2 },
                { case: { $eq: ['$dayOfWeek', 5] }, then: -3 },
                { case: { $eq: ['$dayOfWeek', 6] }, then: -4 },
                { case: { $eq: ['$dayOfWeek', 7] }, then: -5 },
              ],
              default: 0,
            },
          },
        },
      },
      {
        $addFields: {
          weekStart: {
            $dateFromParts: {
              year:  { $year:  '$earningDate' },
              month: { $month: '$earningDate' },
              day:   { $add:   [{ $dayOfMonth: '$earningDate' }, '$daysToMonday'] },
            },
          },
        },
      },
      {
        $group: {
          _id:           { vendorId: '$vendorId', weekStart: '$weekStart' },
          pendingAmount: { $sum: '$netAmount' },
          orderCount:    { $sum: 1 },
          weekStart:     { $first: '$weekStart' },
          vendorId:      { $first: '$vendorId' },
        },
      },
      { $sort: { weekStart: -1, pendingAmount: -1 } },
      {
        $lookup: {
          from: 'vendors', localField: 'vendorId', foreignField: '_id', as: 'vendor',
        },
      },
      { $unwind: { path: '$vendor', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          vendorId:      1,
          pendingAmount: 1,
          orderCount:    1,
          weekStart:     1,
          'vendor.businessName': 1,
          'vendor.phone':        1,
          'vendor.bankDetails':  1,
        },
      },
    ]);

    return sendSuccess(res, rows);
  } catch (err) {
    logger.error('listPayouts error:', err);
    return sendError(res, 500, 'Failed to fetch payouts', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /payouts ─────────────────────────────────────────────────
// Body: { vendorId, weekStart }
// Approves the pending payout for that vendor+week. Records admin info.
const triggerPayout = async (req, res) => {
  const { vendorId, weekStart: weekStartRaw } = req.body;
  if (!vendorId || !weekStartRaw) {
    return sendError(res, 400, 'vendorId and weekStart are required', ERROR_CODES.VALIDATION_ERROR);
  }

  const weekStart = isoWeekStart(weekStartRaw);
  const weekEnd   = isoWeekEnd(weekStart);

  try {
    const [vendor, admin] = await Promise.all([
      Vendor.findById(vendorId).select('businessName bankDetails').lean(),
      Admin.findById(req.user.id).select('name email').lean(),
    ]);

    if (!vendor) return sendError(res, 404, 'Vendor not found', ERROR_CODES.NOT_FOUND);

    // Sum pending earnings for this vendor in this week
    const summary = await VendorEarning.aggregate([
      {
        $match: {
          vendorId:    new mongoose.Types.ObjectId(vendorId),
          status:      'pending',
          earningDate: { $gte: weekStart, $lte: weekEnd },
        },
      },
      { $group: { _id: null, total: { $sum: '$netAmount' }, count: { $sum: 1 } } },
    ]);

    if (!summary.length || summary[0].count === 0) {
      return sendError(res, 400, 'No pending earnings for this vendor in the selected week', ERROR_CODES.VALIDATION_ERROR);
    }

    const { total: amount, count: orderCount } = summary[0];
    const paidAt = new Date();

    // Mark those earnings as paid
    await VendorEarning.updateMany(
      {
        vendorId:    new mongoose.Types.ObjectId(vendorId),
        status:      'pending',
        earningDate: { $gte: weekStart, $lte: weekEnd },
      },
      { $set: { status: 'paid', paidAt } },
    );

    // Create audit record
    const record = await PayoutRecord.create({
      vendorId,
      vendorName:     vendor.businessName,
      amount,
      orderCount,
      weekStart,
      weekEnd,
      approvedBy:     req.user.id,
      approvedByName: admin?.name ?? admin?.email ?? 'Admin',
      paidAt,
    });

    logger.info(`[PAYOUT] ₹${amount} approved for ${vendor.businessName} (week ${weekStart.toISOString().slice(0,10)}) by ${record.approvedByName}`);

    notifyAdmin(
      'payout_approved',
      `Payout of ₹${amount} Approved`,
      `${vendor.businessName} — ${orderCount} orders (week of ${weekStart.toISOString().slice(0, 10)})`,
      { vendorId: vendorId.toString(), vendorName: vendor.businessName, amount, weekStart },
    );

    return sendSuccess(res, {
      record,
      vendorName:  vendor.businessName,
      amount,
      orderCount,
      weekStart,
      weekEnd,
      paidAt,
      bankDetails: vendor.bankDetails,
    });
  } catch (err) {
    if (err.code === 11000) {
      return sendError(res, 409, 'Payout for this vendor and week already processed', ERROR_CODES.CONFLICT);
    }
    logger.error('triggerPayout error:', err);
    return sendError(res, 500, 'Failed to process payout', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /payouts/history ──────────────────────────────────────────
// Returns PayoutRecord docs sorted by paidAt desc
const getPayoutHistory = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip  = (page - 1) * limit;

    const [records, total] = await Promise.all([
      PayoutRecord.find()
        .sort({ paidAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PayoutRecord.countDocuments(),
    ]);

    return sendSuccess(res, { data: records, total, page, limit });
  } catch (err) {
    logger.error('getPayoutHistory error:', err);
    return sendError(res, 500, 'Failed to fetch payout history', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /payouts/:vendorId ────────────────────────────────────────
// Per-vendor payout history (PayoutRecords for one vendor)
const getVendorPayoutHistory = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const [vendor, records, total] = await Promise.all([
      Vendor.findById(req.params.vendorId).select('businessName phone bankDetails').lean(),
      PayoutRecord.find({ vendorId: req.params.vendorId })
        .sort({ paidAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      PayoutRecord.countDocuments({ vendorId: req.params.vendorId }),
    ]);

    if (!vendor) return sendError(res, 404, 'Vendor not found', ERROR_CODES.NOT_FOUND);

    return sendSuccess(res, { vendor, records, total, page, limit });
  } catch (err) {
    logger.error('getVendorPayoutHistory error:', err);
    return sendError(res, 500, 'Failed to fetch payout history', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { listPayouts, getPayoutHistory, getVendorPayoutHistory, triggerPayout };
