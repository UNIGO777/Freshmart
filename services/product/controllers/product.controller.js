require('dotenv').config();
const { z } = require('zod');
const Product = require('../models/Product.model');
const Category = require('../models/Category.model');
const { redisClient } = require('../../../shared/db/redis');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// ── Redis cache helpers ───────────────────────────────────────────
const CACHE_TTL = 60 * 60; // 1 hour in seconds

const cacheKey = (category) =>
  category ? `products:today:${category}` : 'products:today';

const getFromCache = async (key) => {
  try {
    const cached = await redisClient.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null; // Cache miss is non-fatal
  }
};

const setCache = async (key, data) => {
  try {
    await redisClient.setEx(key, CACHE_TTL, JSON.stringify(data));
  } catch (err) {
    logger.warn('Redis set failed:', err.message);
  }
};

/** Invalidate all product cache keys */
const invalidateProductCache = async () => {
  try {
    const keys = await redisClient.keys('products:today*');
    if (keys.length) await redisClient.del(keys);
  } catch (err) {
    logger.warn('Redis invalidation failed:', err.message);
  }
};

// ── GET /api/products ─────────────────────────────────────────────
// Public. Supports ?category=fruits|vegetables|spices and ?lang=hi|en
const getProducts = async (req, res) => {
  try {
    const { category, lang = 'en', search } = req.query;

    // Search bypasses cache
    if (search) {
      const products = await Product.find(
        { isAvailableToday: true, $text: { $search: search } },
        { score: { $meta: 'textScore' } },
      )
        .sort({ score: { $meta: 'textScore' } })
        .lean();

      return sendSuccess(res, 200, 'Search results', localiseProducts(products, lang));
    }

    const key = cacheKey(category);
    const cached = await getFromCache(key);
    if (cached) return sendSuccess(res, 200, 'Products fetched (cache)', cached);

    const filter = { isAvailableToday: true };
    if (category) {
      if (!['fruits', 'vegetables', 'spices'].includes(category)) {
        return sendError(res, 400, 'Invalid category', ERROR_CODES.VALIDATION_ERROR);
      }
      filter.category = category;
    }

    const products = await Product.find(filter).sort({ category: 1, name: 1 }).lean();
    const response = localiseProducts(products, lang);

    await setCache(key, response);
    return sendSuccess(res, 200, 'Products fetched', response);
  } catch (err) {
    logger.error('getProducts error:', err);
    return sendError(res, 500, 'Failed to fetch products', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/products/categories ─────────────────────────────────
const getCategories = async (req, res) => {
  try {
    const { lang = 'en' } = req.query;
    const cached = await getFromCache('categories');
    if (cached) return sendSuccess(res, 200, 'Categories fetched (cache)', cached);

    const categories = await Category.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
    const response = categories.map((c) => ({
      slug: c.slug,
      name: lang === 'hi' && c.nameHi ? c.nameHi : c.name,
      icon: c.icon,
    }));

    await redisClient.setEx('categories', CACHE_TTL, JSON.stringify(response)).catch(() => {});
    return sendSuccess(res, 200, 'Categories fetched', response);
  } catch (err) {
    logger.error('getCategories error:', err);
    return sendError(res, 500, 'Failed to fetch categories', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/products/:id ─────────────────────────────────────────
const getProductById = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return sendError(res, 404, 'Product not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, 200, 'Product fetched', product);
  } catch (err) {
    logger.error('getProductById error:', err);
    return sendError(res, 500, 'Failed to fetch product', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /api/products  (Admin) ───────────────────────────────────
const createProductSchema = z.object({
  name: z.string().min(1),
  nameHi: z.string().optional(),
  category: z.enum(['fruits', 'vegetables', 'spices']),
  unit: z.enum(['kg', 'g', 'piece', 'dozen']),
  image: z.string().url().optional(),
  buyingPrice: z.number().min(0),
  sellingPrice: z.number().min(0),
  isAvailableToday: z.boolean().optional(),
});

const createProduct = async (req, res) => {
  try {
    const parsed = createProductSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const product = await Product.create({ ...parsed.data, lastPricedAt: new Date() });
    await invalidateProductCache();
    return sendSuccess(res, 201, 'Product created', product);
  } catch (err) {
    logger.error('createProduct error:', err);
    return sendError(res, 500, 'Failed to create product', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PUT /api/products/:id  (Admin) ────────────────────────────────
const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  nameHi: z.string().optional(),
  category: z.enum(['fruits', 'vegetables', 'spices']).optional(),
  unit: z.enum(['kg', 'g', 'piece', 'dozen']).optional(),
  image: z.string().url().optional(),
  buyingPrice: z.number().min(0).optional(),
  sellingPrice: z.number().min(0).optional(),
  isAvailableToday: z.boolean().optional(),
});

const updateProduct = async (req, res) => {
  try {
    const parsed = updateProductSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const updates = parsed.data;
    // Track when pricing was last changed
    if (updates.buyingPrice !== undefined || updates.sellingPrice !== undefined) {
      updates.lastPricedAt = new Date();
    }

    const product = await Product.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });
    if (!product) return sendError(res, 404, 'Product not found', ERROR_CODES.NOT_FOUND);

    await invalidateProductCache();
    return sendSuccess(res, 200, 'Product updated', product);
  } catch (err) {
    logger.error('updateProduct error:', err);
    return sendError(res, 500, 'Failed to update product', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /api/products/:id/toggle  (Admin) ───────────────────────
// Toggle isAvailableToday — the carry-forward model means whatever is set
// persists until admin explicitly changes it again.
const toggleAvailability = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return sendError(res, 404, 'Product not found', ERROR_CODES.NOT_FOUND);

    product.isAvailableToday = !product.isAvailableToday;
    await product.save();

    await invalidateProductCache();
    return sendSuccess(res, 200, `Product ${product.isAvailableToday ? 'enabled' : 'disabled'} for today`, {
      id: product._id,
      isAvailableToday: product.isAvailableToday,
    });
  } catch (err) {
    logger.error('toggleAvailability error:', err);
    return sendError(res, 500, 'Failed to toggle availability', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PUT /api/products/bulk-prices  (Admin) ────────────────────────
// Body: { updates: [{ id, buyingPrice, sellingPrice }] }
const bulkUpdatePrices = async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return sendError(res, 400, 'updates array is required', ERROR_CODES.MISSING_FIELDS);
    }

    const ops = updates.map(({ id, buyingPrice, sellingPrice }) => ({
      updateOne: {
        filter: { _id: id },
        update: {
          $set: {
            ...(buyingPrice !== undefined && { buyingPrice }),
            ...(sellingPrice !== undefined && { sellingPrice }),
            lastPricedAt: new Date(),
          },
        },
      },
    }));

    const result = await Product.bulkWrite(ops);
    await invalidateProductCache();

    return sendSuccess(res, 200, 'Bulk prices updated', {
      matched: result.matchedCount,
      modified: result.modifiedCount,
    });
  } catch (err) {
    logger.error('bulkUpdatePrices error:', err);
    return sendError(res, 500, 'Bulk update failed', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── Carry-forward helper (called by Admin Service in Phase 7) ─────
// Returns products that haven't been priced today (for admin dashboard warnings).
const getStaleProducts = async (req, res) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const stale = await Product.find({
      lastPricedAt: { $lt: startOfToday },
      isAvailableToday: true,
    })
      .select('name category buyingPrice sellingPrice lastPricedAt')
      .lean();

    return sendSuccess(res, 200, 'Stale products fetched', stale);
  } catch (err) {
    logger.error('getStaleProducts error:', err);
    return sendError(res, 500, 'Failed to fetch stale products', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── Internal: localise product list based on lang header ──────────
const localiseProducts = (products, lang) =>
  products.map((p) => ({
    ...p,
    name: lang === 'hi' && p.nameHi ? p.nameHi : p.name,
  }));

module.exports = {
  getProducts,
  getCategories,
  getProductById,
  createProduct,
  updateProduct,
  toggleAvailability,
  bulkUpdatePrices,
  getStaleProducts,
};
