const Customer = require('../../user/models/Customer.model');
const Vendor   = require('../../user/models/Vendor.model');
const Rider    = require('../../user/models/Rider.model');
const Order    = require('../../order/models/Order.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// ── GET /customers ────────────────────────────────────────────────
const listCustomers = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.active !== undefined) filter.isActive = req.query.active === 'true';
    if (req.query.search) {
      const re = new RegExp(req.query.search, 'i');
      filter.$or = [{ name: re }, { phone: re }, { email: re }];
    }

    const [customers, total] = await Promise.all([
      Customer.find(filter)
        .select('-passwordHash')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Customer.countDocuments(filter),
    ]);

    // The list view shows Orders + Total Spent per customer, but those aren't stored on
    // the Customer doc. Compute them in ONE grouped aggregation over just this page's
    // customers (totalSpent = sum of PAID orders, matching the detail endpoint).
    const customerIds = customers.map((c) => c._id);
    if (customerIds.length > 0) {
      const orderStats = await Order.aggregate([
        { $match: { customerId: { $in: customerIds } } },
        {
          $group: {
            _id: '$customerId',
            totalOrders: { $sum: 1 },
            totalSpent: {
              $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$totalAmount', 0] },
            },
          },
        },
      ]);
      const statsById = new Map(orderStats.map((s) => [String(s._id), s]));
      for (const c of customers) {
        const s = statsById.get(String(c._id));
        c.totalOrders = s?.totalOrders ?? 0;
        c.totalSpent  = s?.totalSpent ?? 0;
      }
    }

    return sendSuccess(res, 200, 'Customers fetched', { customers, total, page, limit });
  } catch (err) {
    logger.error('listCustomers error:', err);
    return sendError(res, 500, 'Failed to fetch customers', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /customers/:id ────────────────────────────────────────────
const getCustomerDetail = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id)
      .select('-passwordHash')
      .populate('referredBy', 'name phone referralCode')
      .lean();
    if (!customer) return sendError(res, 404, 'Customer not found', ERROR_CODES.NOT_FOUND);

    // Backfill own referral code for legacy accounts so admin always sees one.
    if (!customer.referralCode) {
      customer.referralCode = await Customer.generateUniqueReferralCode(customer.name);
      await Customer.updateOne({ _id: customer._id }, { referralCode: customer.referralCode });
    }

    const [orderCount, totalSpentResult, recentOrders] = await Promise.all([
      Order.countDocuments({ customerId: customer._id }),
      Order.aggregate([
        { $match: { customerId: customer._id, paymentStatus: 'paid' } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]),
      Order.find({ customerId: customer._id })
        .select('status totalAmount paymentMethod createdAt')
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
    ]);

    // Check if this customer is also registered as vendor or rider
    const [vendorRecord, riderRecord] = await Promise.all([
      customer.phone ? Vendor.findOne({ phone: customer.phone }).select('_id').lean() : null,
      customer.phone ? Rider.findOne({ phone: customer.phone }).select('_id').lean() : null,
    ]);

    return sendSuccess(res, 200, 'Customer detail', {
      customer,
      stats: {
        orderCount,
        totalSpent: totalSpentResult[0]?.total ?? 0,
      },
      recentOrders,
      isAlsoVendor: !!vendorRecord,
      vendorId: vendorRecord?._id || null,
      isAlsoRider: !!riderRecord,
      riderId: riderRecord?._id || null,
    });
  } catch (err) {
    logger.error('getCustomerDetail error:', err);
    return sendError(res, 500, 'Failed to fetch customer', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /customers/:id/block ────────────────────────────────────
const blockCustomer = async (req, res) => {
  try {
    const customer = await Customer.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true, select: '-passwordHash' },
    );
    if (!customer) return sendError(res, 404, 'Customer not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, 200, 'Customer blocked', customer);
  } catch (err) {
    logger.error('blockCustomer error:', err);
    return sendError(res, 500, 'Failed to block customer', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { listCustomers, getCustomerDetail, blockCustomer };
