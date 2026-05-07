const { z } = require('zod');
const Inventory = require('../models/Inventory.model');
const VendorEarning = require('../models/VendorEarning.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

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
  quantityAvailable: z.number().min(0),
  isAvailable: z.boolean().optional(),
});

const upsertInventory = async (req, res) => {
  try {
    const parsed = upsertInventorySchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const { quantityAvailable, isAvailable } = parsed.data;

    const record = await Inventory.findOneAndUpdate(
      { vendorId: req.user.id, productId: req.params.productId },
      {
        quantityAvailable,
        ...(isAvailable !== undefined && { isAvailable }),
      },
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

// ── PUT /api/vendors/inventory/bulk ──────────────────────────────
// Vendor: bulk update stock for multiple products at once
// Body: { items: [{ productId, quantityAvailable, isAvailable? }] }
const bulkUpdateInventory = async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return sendError(res, 400, 'items array is required', ERROR_CODES.MISSING_FIELDS);
    }

    const ops = items.map(({ productId, quantityAvailable, isAvailable }) => ({
      updateOne: {
        filter: { vendorId: req.user.id, productId },
        update: {
          $set: {
            quantityAvailable,
            ...(isAvailable !== undefined && { isAvailable }),
          },
        },
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
    const { period = 'all' } = req.query; // today | week | all

    const filter = { vendorId: req.user.id };

    if (period === 'today') {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      filter.earningDate = { $gte: start };
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
            totalGross: { $sum: '$grossAmount' },
            totalCommission: { $sum: '$commissionAmount' },
            totalNet: { $sum: '$netAmount' },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    return sendSuccess(res, 200, 'Earnings fetched', {
      summary: totals[0] || { totalGross: 0, totalCommission: 0, totalNet: 0, count: 0 },
      records,
    });
  } catch (err) {
    logger.error('getEarnings error:', err);
    return sendError(res, 500, 'Failed to fetch earnings', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/vendors/inventory/available ──────────────────────────
// Internal helper used by Order Service (Phase 3) to check vendor stock.
// Returns vendors with available inventory for a given set of productIds.
const getAvailableInventory = async (req, res) => {
  try {
    const { productIds, vendorId } = req.query;

    const filter = {
      isAvailable: true,
      quantityAvailable: { $gt: 0 },
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

module.exports = {
  getInventory,
  upsertInventory,
  toggleInventoryAvailability,
  bulkUpdateInventory,
  getEarnings,
  getAvailableInventory,
};
