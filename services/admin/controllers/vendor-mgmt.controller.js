const Vendor        = require('../../user/models/Vendor.model');
const VendorEarning = require('../../vendor/models/VendorEarning.model');
const Order         = require('../../order/models/Order.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// ── GET /vendors ──────────────────────────────────────────────────
// List all vendors with optional filters: approved, active, search by name/phone
const listVendors = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.approved !== undefined) filter.isApproved = req.query.approved === 'true';
    if (req.query.active   !== undefined) filter.isActive   = req.query.active   === 'true';
    if (req.query.search) {
      const re = new RegExp(req.query.search, 'i');
      filter.$or = [{ businessName: re }, { ownerName: re }, { phone: re }];
    }

    const [vendors, total] = await Promise.all([
      Vendor.find(filter)
        .select('-passwordHash')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Vendor.countDocuments(filter),
    ]);

    return sendSuccess(res, 200, 'Vendors fetched', { vendors, total, page, limit });
  } catch (err) {
    logger.error('listVendors error:', err);
    return sendError(res, 500, 'Failed to fetch vendors', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /vendors/:id ──────────────────────────────────────────────
// Vendor detail + earnings summary
const getVendorDetail = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id).select('-passwordHash').lean();
    if (!vendor) return sendError(res, 404, 'Vendor not found', ERROR_CODES.NOT_FOUND);

    const [earningsSummary, recentOrders] = await Promise.all([
      VendorEarning.aggregate([
        { $match: { vendorId: vendor._id } },
        {
          $group: {
            _id: '$status',
            totalNet: { $sum: '$netAmount' },
            count:    { $sum: 1 },
          },
        },
      ]),

      Order.find({ 'subOrders.vendorId': vendor._id })
        .select('status totalAmount createdAt deliveryAddress')
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
    ]);

    const earnings = { pending: 0, paid: 0, pendingCount: 0, paidCount: 0 };
    for (const e of earningsSummary) {
      if (e._id === 'pending') { earnings.pending = e.totalNet; earnings.pendingCount = e.count; }
      if (e._id === 'paid')    { earnings.paid    = e.totalNet; earnings.paidCount    = e.count; }
    }

    return sendSuccess(res, 200, 'Vendor detail', { vendor, earnings, recentOrders });
  } catch (err) {
    logger.error('getVendorDetail error:', err);
    return sendError(res, 500, 'Failed to fetch vendor', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /vendors/:id/approve ────────────────────────────────────
const approveVendor = async (req, res) => {
  try {
    const vendor = await Vendor.findByIdAndUpdate(
      req.params.id,
      { isApproved: true, isActive: true },
      { new: true, select: '-passwordHash' },
    );
    if (!vendor) return sendError(res, 404, 'Vendor not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, 200, 'Vendor approved', vendor);
  } catch (err) {
    logger.error('approveVendor error:', err);
    return sendError(res, 500, 'Failed to approve vendor', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /vendors/:id/block ──────────────────────────────────────
const blockVendor = async (req, res) => {
  try {
    const vendor = await Vendor.findByIdAndUpdate(
      req.params.id,
      { isApproved: false, isActive: false },
      { new: true, select: '-passwordHash' },
    );
    if (!vendor) return sendError(res, 404, 'Vendor not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, 200, 'Vendor blocked', vendor);
  } catch (err) {
    logger.error('blockVendor error:', err);
    return sendError(res, 500, 'Failed to block vendor', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { listVendors, getVendorDetail, approveVendor, blockVendor };
