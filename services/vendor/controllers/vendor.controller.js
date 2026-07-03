const { z } = require('zod');
const Inventory = require('../models/Inventory.model');
const VendorEarning = require('../models/VendorEarning.model');
const VendorWallet = require('../models/VendorWallet.model');
const VendorNotification = require('../models/VendorNotification.model');
const Vendor = require('../../user/models/Vendor.model');
const Product = require('../../product/models/Product.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// ── GET /api/vendors/inventory/catalog ───────────────────────────
// Vendor: get ALL active products in their categories, merged with their
// current inventory. Products with no inventory record get quantityAvailable=0.
// This is the primary endpoint for the inventory management screen.
const getCatalog = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.user.id).select('categories').lean();
    if (!vendor) return sendError(res, 404, 'Vendor not found', ERROR_CODES.NOT_FOUND);

    const { categories } = vendor;
    if (!categories || categories.length === 0) {
      return sendSuccess(res, 200, 'Catalog fetched', []);
    }

    const [products, inventoryRecords] = await Promise.all([
      Product.find({ category: { $in: categories }, active: true })
        .select('name nameHi category unit buyingPrice sellingPrice coverImage isAvailableToday')
        .sort({ category: 1, name: 1 })
        .lean(),
      Inventory.find({ vendorId: req.user.id })
        .select('productId isAvailable')
        .lean(),
    ]);

    // Build map: productId → inventory record for O(1) merge
    const invMap = new Map();
    for (const inv of inventoryRecords) {
      invMap.set(inv.productId.toString(), inv);
    }

    const catalog = products.map((p) => {
      const inv = invMap.get(p._id.toString());
      return {
        ...p,
        isAvailable: inv ? inv.isAvailable : false,
        hasRecord: !!inv,
      };
    });

    return sendSuccess(res, 200, 'Catalog fetched', catalog);
  } catch (err) {
    logger.error('getCatalog error:', err);
    return sendError(res, 500, 'Failed to fetch catalog', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/vendors/inventory ────────────────────────────────────
// Vendor: view their full inventory (all products they've set stock for)
const getInventory = async (req, res) => {
  try {
    const inventory = await Inventory.find({ vendorId: req.user.id })
      .populate('productId', 'name nameHi category unit sellingPrice buyingPrice isAvailableToday')
      .lean();

    return sendSuccess(res, 200, 'Inventory fetched', inventory);
  } catch (err) {
    logger.error('getInventory error:', err);
    return sendError(res, 500, 'Failed to fetch inventory', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PUT /api/vendors/inventory/:productId ─────────────────────────
// Vendor: set or update stock quantity for a product.
// Creates the record if it doesn't exist (upsert).
const upsertInventorySchema = z.object({
  isAvailable: z.boolean(),
});

const upsertInventory = async (req, res) => {
  try {
    const parsed = upsertInventorySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const { isAvailable } = parsed.data;

    const record = await Inventory.findOneAndUpdate(
      { vendorId: req.user.id, productId: req.params.productId },
      { isAvailable },
      { upsert: true, new: true, runValidators: true },
    ).populate('productId', 'name category unit');

    return sendSuccess(res, 200, 'Inventory updated', record);
  } catch (err) {
    logger.error('upsertInventory error:', err);
    return sendError(res, 500, 'Failed to update inventory', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /api/vendors/inventory/:productId/toggle ────────────────
// Vendor: toggle isAvailable for a specific product
const toggleInventoryAvailability = async (req, res) => {
  try {
    const record = await Inventory.findOne({
      vendorId: req.user.id,
      productId: req.params.productId,
    });

    if (!record) return sendError(res, 404, 'Inventory record not found', ERROR_CODES.NOT_FOUND);

    record.isAvailable = !record.isAvailable;
    await record.save();

    return sendSuccess(res, 200, `Product ${record.isAvailable ? 'enabled' : 'disabled'} in your inventory`, {
      productId: record.productId,
      isAvailable: record.isAvailable,
    });
  } catch (err) {
    logger.error('toggleInventoryAvailability error:', err);
    return sendError(res, 500, 'Failed to toggle inventory', ERROR_CODES.INTERNAL_ERROR);
  }
};

const bulkInventorySchema = z.object({
  items: z.array(
    z.object({
      productId: z.string().min(1),
      isAvailable: z.boolean(),
    }),
  ).min(1).max(500),
});

// ── PUT /api/vendors/inventory/bulk ──────────────────────────────
// Vendor: bulk update availability for multiple products at once
// Body: { items: [{ productId, isAvailable }] }
const bulkUpdateInventory = async (req, res) => {
  try {
    const parsed = bulkInventorySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }
    const { items } = parsed.data;

    const ops = items.map(({ productId, isAvailable }) => ({
      updateOne: {
        filter: { vendorId: req.user.id, productId },
        update: { $set: { isAvailable } },
        upsert: true,
      },
    }));

    const result = await Inventory.bulkWrite(ops);
    return sendSuccess(res, 200, 'Inventory bulk updated', {
      upserted: result.upsertedCount,
      modified: result.modifiedCount,
    });
  } catch (err) {
    logger.error('bulkUpdateInventory error:', err);
    return sendError(res, 500, 'Bulk inventory update failed', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/vendors/earnings ─────────────────────────────────────
// Vendor: view their earnings summary + recent records
const getEarnings = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const { period = 'all' } = req.query; // today | yesterday | week | all

    const filter = { vendorId: new mongoose.Types.ObjectId(req.user.id), status: { $ne: 'reversed' } };

    if (period === 'today') {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      filter.earningDate = { $gte: start };
    } else if (period === 'yesterday') {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const yesterdayStart = new Date(todayStart);
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);
      filter.earningDate = { $gte: yesterdayStart, $lt: todayStart };
    } else if (period === 'week') {
      const start = new Date();
      start.setDate(start.getDate() - 7);
      start.setHours(0, 0, 0, 0);
      filter.earningDate = { $gte: start };
    }

    const [records, totals] = await Promise.all([
      VendorEarning.find(filter).sort({ earningDate: -1 }).limit(50).lean(),
      VendorEarning.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalSales: { $sum: '$salesAmount' },
            totalMargin: { $sum: '$marginAmount' },
            totalNet: { $sum: '$netAmount' },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    return sendSuccess(res, 200, 'Earnings fetched', {
      summary: totals[0] || { totalSales: 0, totalMargin: 0, totalNet: 0, count: 0 },
      records,
    });
  } catch (err) {
    logger.error('getEarnings error:', err);
    return sendError(res, 500, 'Failed to fetch earnings', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/vendors/wallet ───────────────────────────────────────
const getWallet = async (req, res) => {
  try {
    const vendorId = req.user.id;
    let wallet = await VendorWallet.findOne({ vendorId }).lean();
    if (!wallet) {
      wallet = await VendorWallet.create({ vendorId });
      wallet = wallet.toObject();
    }
    return sendSuccess(res, 200, 'Wallet fetched', { wallet });
  } catch (err) {
    logger.error('getWallet error:', err);
    return sendError(res, 500, 'Failed to fetch wallet', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/vendors/inventory/available ──────────────────────────
// Internal helper used by Order Service (Phase 3) to check vendor stock.
// Returns vendors with available inventory for a given set of productIds.
// BUG-016: VENDOR role may only query their own inventory, not competitors'.
const getAvailableInventory = async (req, res) => {
  try {
    const ROLES = require('../../../shared/constants/roles');
    const { productIds } = req.query;
    let { vendorId } = req.query;

    // Enforce scope: a VENDOR can only query their own stock
    if (req.user && req.user.role === ROLES.VENDOR) {
      vendorId = req.user.id;
    }

    const filter = {
      isAvailable: true,
    };
    if (productIds) filter.productId = { $in: productIds.split(',') };
    if (vendorId) filter.vendorId = vendorId;

    const inventory = await Inventory.find(filter)
      .populate('productId', 'name category buyingPrice sellingPrice isAvailableToday')
      .lean();

    // Filter out products the admin has marked unavailable today
    const activeInventory = inventory.filter((i) => i.productId?.isAvailableToday !== false);

    return sendSuccess(res, 200, 'Available inventory fetched', activeInventory);
  } catch (err) {
    logger.error('getAvailableInventory error:', err);
    return sendError(res, 500, 'Failed to fetch available inventory', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/vendors/notifications ──────────────────────────────
const getNotifications = async (req, res) => {
  try {
    const notifications = await VendorNotification.find({ vendorId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    return sendSuccess(res, 200, 'Notifications fetched', notifications);
  } catch (err) {
    logger.error('getNotifications error:', err);
    return sendError(res, 500, 'Failed to fetch notifications', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /api/vendors/notifications/read-all ──────────────────
const markAllNotificationsRead = async (req, res) => {
  try {
    await VendorNotification.updateMany(
      { vendorId: req.user.id, isRead: false },
      { $set: { isRead: true } },
    );
    return sendSuccess(res, 200, 'All notifications marked as read');
  } catch (err) {
    logger.error('markAllNotificationsRead error:', err);
    return sendError(res, 500, 'Failed', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /internal/vendor-notification (called by other services) ──
const createNotification = async (req, res) => {
  try {
    const { vendorId, type, title, body, orderId, data } = req.body;
    if (!vendorId || !type || !title || !body) {
      return res.status(400).json({ success: false, message: 'vendorId, type, title, body required' });
    }
    await VendorNotification.create({ vendorId, type, title, body, orderId, data });
    return res.json({ success: true });
  } catch (err) {
    logger.error('createNotification error:', err);
    return res.status(500).json({ success: false });
  }
};

module.exports = {
  getCatalog,
  getInventory,
  upsertInventory,
  toggleInventoryAvailability,
  bulkUpdateInventory,
  getEarnings,
  getWallet,
  getAvailableInventory,
  getNotifications,
  markAllNotificationsRead,
  createNotification,
};
