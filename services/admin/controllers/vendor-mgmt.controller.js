const Vendor        = require('../../user/models/Vendor.model');
const Customer      = require('../../user/models/Customer.model');
const VendorEarning = require('../../vendor/models/VendorEarning.model');
const Order         = require('../../order/models/Order.model');
const Inventory     = require('../../vendor/models/Inventory.model');
const Product       = require('../../product/models/Product.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// Delete a vendor's inventory rows for products whose category is NOT in `categories`.
// Keeps inventory in sync when a vendor's served categories are reduced/changed, so the
// vendor is never offered (or shown) stock in a category they no longer serve.
const pruneVendorInventoryToCategories = async (vendorId, categories) => {
  const inv = await Inventory.find({ vendorId }).select('productId').lean();
  if (inv.length === 0) return 0;
  const productIds = inv.map((i) => i.productId);
  const products = await Product.find({ _id: { $in: productIds } }).select('_id category').lean();
  const allowed = new Set(categories);
  const toRemove = products.filter((p) => !allowed.has(p.category)).map((p) => p._id);
  if (toRemove.length === 0) return 0;
  const { deletedCount } = await Inventory.deleteMany({ vendorId, productId: { $in: toRemove } });
  logger.info(`Pruned ${deletedCount} inventory item(s) for vendor ${vendorId} outside categories [${categories.join(', ')}]`);
  return deletedCount || 0;
};

// ── GET /vendors ──────────────────────────────────────────────────
// List all vendors with optional filters: approved, active, search by name/phone
const listVendors = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter = {};
    // Support legacy approved/active params
    if (req.query.approved !== undefined) filter.isApproved = req.query.approved === 'true';
    if (req.query.active   !== undefined) filter.isActive   = req.query.active   === 'true';
    // Support status param: pending | approved | blocked
    if (req.query.status) {
      if (req.query.status === 'approved') { filter.isApproved = true; filter.isActive = true; }
      else if (req.query.status === 'blocked') { filter.isActive = false; }
      else if (req.query.status === 'pending') { filter.isApproved = false; filter.isActive = true; }
    }
    // Support category filter
    if (req.query.category) {
      filter.categories = req.query.category;
    }
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

// ── POST /vendors ─────────────────────────────────────────────────
// Accepts optional `customerId` to convert an existing customer into a vendor.
// If no customer exists with this phone, a customer account is auto-created.
const createVendor = async (req, res) => {
  try {
    const {
      businessName, ownerName, phone, email, password,
      lat, lng, address, serviceRadiusKm, categories,
      bankDetails,
      aadhaarUrl, panUrl, profilePhoto,
      customerId,
    } = req.body;

    if (!businessName || !ownerName || !phone || !password) {
      return sendError(res, 400, 'businessName, ownerName, phone and password are required', ERROR_CODES.MISSING_FIELDS);
    }
    if (!lat || !lng) {
      return sendError(res, 400, 'Shop location (lat, lng) is required', ERROR_CODES.MISSING_FIELDS);
    }

    const existing = await Vendor.findOne({ phone });
    if (existing) return sendError(res, 409, 'Phone number already registered as vendor', ERROR_CODES.ALREADY_EXISTS);

    // Auto-create customer account if one doesn't exist for this phone
    const normalizedPhone = phone.replace(/^\+?91(?=\d{10}$)/, '');
    const existingCustomer = customerId
      ? await Customer.findById(customerId)
      : await Customer.findOne({ phone: normalizedPhone });

    if (!existingCustomer) {
      await Customer.create({
        name: ownerName.trim(),
        email: email ? email.toLowerCase() : undefined,
        phone: normalizedPhone,
        authProviders: ['phone'],
      });
      logger.info(`Auto-created customer account for vendor phone ${normalizedPhone}`);
    }

    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(password, 12);

    const vendor = await Vendor.create({
      businessName, ownerName, phone: normalizedPhone, email,
      passwordHash,
      profilePhoto: profilePhoto || '',
      location: { type: 'Point', coordinates: [parseFloat(lng), parseFloat(lat)] },
      address: address || '',
      serviceRadiusKm: serviceRadiusKm ? parseFloat(serviceRadiusKm) : 5,
      categories: Array.isArray(categories) ? categories : [],
      bankDetails: bankDetails || {},
      isApproved: true,
      kyc: { aadhaarUrl: aadhaarUrl || '', panUrl: panUrl || '', status: 'pending' },
    });

    const v = vendor.toObject();
    delete v.passwordHash;
    return sendSuccess(res, 201, 'Vendor created', v);
  } catch (err) {
    logger.error('createVendor error:', err);
    return sendError(res, 500, 'Failed to create vendor', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /vendors/:id/earnings ─────────────────────────────────────
// Returns daily earning points for a vendor between from..to (ISO date strings)
const mongoose = require('mongoose');

const getVendorEarnings = async (req, res) => {
  try {
    const { id } = req.params;
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 6 * 24 * 3600 * 1000);
    const to   = req.query.to   ? new Date(req.query.to)   : new Date();
    to.setHours(23, 59, 59, 999);

    const points = await VendorEarning.aggregate([
      {
        $match: {
          vendorId:    new mongoose.Types.ObjectId(id),
          earningDate: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$earningDate' } },
          amount: { $sum: '$netAmount' },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', amount: 1 } },
    ]);

    return sendSuccess(res, 200, 'Vendor earnings', { points });
  } catch (err) {
    logger.error('getVendorEarnings error:', err);
    return sendError(res, 500, 'Failed to fetch earnings', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /vendors/:id ────────────────────────────────────────────
// Admin edits a vendor. When `categories` is changed, prune inventory to the new set —
// items in dropped categories are removed so the vendor no longer stocks/serves them.
const VENDOR_CATEGORIES = ['fruits', 'vegetables', 'spices', 'dairy', 'bakery', 'other'];
const updateVendor = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) return sendError(res, 404, 'Vendor not found', ERROR_CODES.NOT_FOUND);

    const { businessName, ownerName, serviceRadiusKm, address, categories } = req.body;
    const updates = {};
    if (businessName !== undefined)   updates.businessName = businessName;
    if (ownerName !== undefined)      updates.ownerName = ownerName;
    if (address !== undefined)        updates.address = address;
    if (serviceRadiusKm !== undefined) updates.serviceRadiusKm = parseFloat(serviceRadiusKm);

    let prunedCount = 0;
    if (categories !== undefined) {
      if (!Array.isArray(categories) || categories.some((c) => !VENDOR_CATEGORIES.includes(c))) {
        return sendError(res, 400, `categories must be a subset of: ${VENDOR_CATEGORIES.join(', ')}`, ERROR_CODES.VALIDATION_ERROR);
      }
      updates.categories = categories;
      // Prune BEFORE/together with the category change so inventory never lags behind.
      prunedCount = await pruneVendorInventoryToCategories(vendor._id, categories);
    }

    const updated = await Vendor.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true })
      .select('-passwordHash').lean();

    const msg = prunedCount > 0
      ? `Vendor updated — removed ${prunedCount} inventory item(s) in dropped categories`
      : 'Vendor updated';
    return sendSuccess(res, 200, msg, { vendor: updated, prunedInventory: prunedCount });
  } catch (err) {
    logger.error('updateVendor error:', err);
    return sendError(res, 500, 'Failed to update vendor', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { listVendors, getVendorDetail, approveVendor, blockVendor, createVendor, updateVendor, getVendorEarnings };
