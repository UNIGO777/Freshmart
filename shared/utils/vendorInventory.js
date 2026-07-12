const Inventory = require('../../services/vendor/models/Inventory.model');
const Product = require('../../services/product/models/Product.model');
const logger = require('./logger');

/**
 * Delete a vendor's inventory rows for products whose category is NOT in `categories`.
 * Keeps inventory in sync when a vendor's served categories are reduced/changed, so the
 * vendor is never offered (routing eligibility checks what they carry), or shown, stock
 * in a category they no longer serve. Idempotent.
 *
 * @param {ObjectId|string} vendorId
 * @param {string[]} categories  the vendor's NEW category set
 * @returns {Promise<number>} how many inventory items were removed
 */
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

module.exports = { pruneVendorInventoryToCategories };
