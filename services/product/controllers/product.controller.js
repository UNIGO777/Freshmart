require('dotenv').config();
const { z } = require('zod');
const Product = require('../models/Product.model');
const Category = require('../models/Category.model');
const { redisClient } = require('../../../shared/db/redis');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');
const Vendor = require('../../user/models/Vendor.model');
const Inventory = require('../../vendor/models/Inventory.model');

// ── Redis cache helpers ───────────────────────────────────────────
const CACHE_TTL = 60; // 60 seconds — writes call invalidateProductCache() immediately

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

// ── Nearby inventory helpers ─────────────────────────────────────
// Pre-filter upper bound only. Each vendor is STILL gated by its own
// serviceRadiusKm below, so real vendors stay local — but a vendor that
// deliberately sets a very large radius (e.g. the demo/test store) can serve
// from anywhere. Kept large so the per-vendor radius is the real limit.
const MAX_SEARCH_RADIUS_KM = 20000;

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Returns a Set of product IDs available from at least one vendor
 * whose service area covers the customer's location.
 */
async function getNearbyAvailableProductIds(lat, lng) {
  // 1. Find all vendors within the max possible radius
  const candidates = await Vendor.find({
    isApproved: true,
    isActive: true,
    isOnline: true,
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: MAX_SEARCH_RADIUS_KM * 1000,
      },
    },
  })
    .select('_id location serviceRadiusKm')
    .lean();

  if (candidates.length === 0) return new Set();

  // 2. Filter by each vendor's own serviceRadiusKm
  const nearbyVendors = candidates.filter((v) => {
    const [vLng, vLat] = v.location.coordinates;
    const distKm = haversineKm(lat, lng, vLat, vLng);
    return distKm <= (v.serviceRadiusKm || 5);
  });

  if (nearbyVendors.length === 0) return new Set();

  // 3. Get stocked product IDs from those vendors' inventory
  const vendorIds = nearbyVendors.map((v) => v._id);
  const records = await Inventory.find({
    vendorId: { $in: vendorIds },
    isAvailable: true,
  })
    .select('productId')
    .lean();

  return new Set(records.map((r) => r.productId.toString()));
}

// ── Search helpers ────────────────────────────────────────────────

/**
 * Bigram similarity between two lowercase strings.
 * Returns 0–1: 1 = identical, 0 = no shared bigrams.
 * Catches single-char typos well (e.g. "tamoto" → "tomato").
 */
function bigramSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b)  return 1;

  const bigrams = (s) => {
    const set = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      set.set(bg, (set.get(bg) || 0) + 1);
    }
    return set;
  };

  const aMap = bigrams(a);
  const bMap = bigrams(b);
  let intersection = 0;
  for (const [bg, count] of aMap) {
    intersection += Math.min(count, bMap.get(bg) || 0);
  }
  return (2 * intersection) / (a.length + b.length - 2);
}

/**
 * Score a product against a search term.
 * Returns a number:
 *   ≥ 80  → strong match  (exact / prefix)
 *   40–79 → partial match  (substring / word boundary)
 *   1–39  → fuzzy match   (bigram similarity above threshold)
 *   0     → no match      (still returned at the end as fallback)
 */
function scoreProduct(product, term) {
  const t = term.toLowerCase().trim();
  if (!t) return 0;

  const FIELDS = [
    { value: product.name,        weight: 10 },
    { value: product.nameHi || '', weight: 9  },
    { value: product.category,    weight: 4  },
    { value: product.description || '', weight: 2 },
  ];

  let best = 0;

  for (const { value, weight } of FIELDS) {
    if (!value) continue;
    const v = value.toLowerCase();

    // Exact match
    if (v === t) { best = Math.max(best, weight * 10); continue; }

    // Starts with term
    if (v.startsWith(t)) { best = Math.max(best, weight * 8); continue; }

    // Term starts with value (user typed the whole name and more)
    if (t.startsWith(v)) { best = Math.max(best, weight * 7); continue; }

    // Contains term as a substring
    if (v.includes(t)) { best = Math.max(best, weight * 6); continue; }

    // Word-boundary: any word in the value starts with the term
    const wordMatch = v.split(/\s+/).some(w => w.startsWith(t));
    if (wordMatch) { best = Math.max(best, weight * 5); continue; }

    // Multi-word query: every word in the term appears somewhere in the value
    const termWords = t.split(/\s+/);
    if (termWords.length > 1 && termWords.every(tw => v.includes(tw))) {
      best = Math.max(best, weight * 4); continue;
    }

    // Fuzzy: bigram similarity (catches typos like "tamoto" → "tomato")
    const sim = bigramSimilarity(v, t);
    if (sim > 0.4) best = Math.max(best, weight * sim * 3);
  }

  return Math.round(best);
}

// ── GET /api/products ─────────────────────────────────────────────
// Public. Supports ?category=fruits|vegetables|spices and ?lang=hi|en
const getProducts = async (req, res) => {
  try {
    const { category, search } = req.query;
    const lang = req.lang || 'en'; // set by langMiddleware (query param > Accept-Language header)
    // Admin surfaces (product list, bulk pricing) pass ?available=all to include
    // products that are not available today. Storefront callers omit it.
    const includeAll = req.query.available === 'all';

    // ── Location-based inventory filter ──────────────────────────
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const hasLocation = !includeAll && !isNaN(lat) && !isNaN(lng) &&
      lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

    let nearbyProductIds = null;
    if (hasLocation) {
      nearbyProductIds = await getNearbyAvailableProductIds(lat, lng);
    }

    // ── Search path (bypasses cache) ──────────────────────────────
    if (search) {
      const term = search.trim();
      if (!term) {
        return sendSuccess(res, 200, 'Search results', []);
      }

      // Fetch all available products (optionally filtered by category).
      // We do the relevance scoring in JS so we can apply fuzzy logic
      // without needing a search engine. The collection is small enough
      // that a full collection scan here is fine; add Atlas Search later
      // if the catalogue grows beyond a few thousand SKUs.
      const baseFilter = includeAll ? {} : { active: true, isAvailableToday: true };
      if (category) {
        const normalised = category.toLowerCase();
        baseFilter.category = normalised;
      }

      let allProducts = await Product.find(baseFilter).lean();

      // Filter by nearby vendor inventory
      if (nearbyProductIds) {
        allProducts = allProducts.filter(p => nearbyProductIds.has(p._id.toString()));
      }

      // Score every product
      const scored = allProducts
        .map(p => ({ ...p, _score: scoreProduct(p, term) }))
        .sort((a, b) => {
          // Primary: score descending
          if (b._score !== a._score) return b._score - a._score;
          // Secondary: alphabetical for stable order
          return a.name.localeCompare(b.name);
        });

      // Separate into matched (score > 0) and unmatched
      const matched   = scored.filter(p => p._score > 0);
      const unmatched = scored.filter(p => p._score === 0);

      // Always return matched first; append unmatched at end as fallback
      // so the UI always has something to show
      const results = [...matched, ...unmatched].map(({ _score, ...p }) => p);

      logger.info(`Search "${term}": ${matched.length} matched, ${unmatched.length} fallback`);
      return sendSuccess(res, 200, 'Search results', localiseProducts(results, lang));
    }

    // Skip cache when location is provided — inventory/vendor status changes
    // in real time (vendor goes online/offline) and cached results go stale instantly.
    const key = cacheKey(category);
    const useCache = !includeAll && !hasLocation;
    const cached = useCache ? await getFromCache(key) : null;
    if (cached) return sendSuccess(res, 200, 'Products fetched (cache)', cached);

    const VALID_CATEGORIES = ['fruits', 'vegetables', 'spices', 'dairy', 'bakery', 'other'];
    const filter = includeAll ? {} : { active: true, isAvailableToday: true };
    if (category) {
      const normalised = category.toLowerCase();
      if (!VALID_CATEGORIES.includes(normalised)) {
        return sendError(res, 400, 'Invalid category', ERROR_CODES.VALIDATION_ERROR);
      }
      filter.category = normalised;
    }

    let products = await Product.find(filter).sort({ category: 1, name: 1 }).lean();

    // Filter by nearby vendor inventory
    if (nearbyProductIds) {
      products = products.filter(p => nearbyProductIds.has(p._id.toString()));
    }

    const response = localiseProducts(products, lang);

    if (useCache) await setCache(key, response);
    return sendSuccess(res, 200, 'Products fetched', response);
  } catch (err) {
    logger.error('getProducts error:', err);
    return sendError(res, 500, 'Failed to fetch products', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/products/categories ─────────────────────────────────
const getCategories = async (req, res) => {
  try {
    const lang = req.lang || 'en';
    const cached = await getFromCache('categories');
    if (cached) return sendSuccess(res, 200, 'Categories fetched (cache)', cached);

    const categories = await Category.find({ isActive: true }).sort({ sortOrder: 1 }).lean();
    const response = categories.map((c) => ({
      slug: c.slug,
      name: lang === 'hi' && c.nameHi ? c.nameHi : c.name,
      icon: c.icon,
    }));

    await redisClient.setEx('categories', 60 * 60, JSON.stringify(response)).catch(() => {}); // categories change rarely
    return sendSuccess(res, 200, 'Categories fetched', response);
  } catch (err) {
    logger.error('getCategories error:', err);
    return sendError(res, 500, 'Failed to fetch categories', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/products/:id ─────────────────────────────────────────
const getProductById = async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, active: true }).lean();
    if (!product) return sendError(res, 404, 'Product not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, 200, 'Product fetched', product);
  } catch (err) {
    logger.error('getProductById error:', err);
    return sendError(res, 500, 'Failed to fetch product', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/products/:id/similar ─────────────────────────────────
// Returns similar products (same category) filtered by vendor availability
const getSimilarProducts = async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, active: true }).lean();
    if (!product) return sendError(res, 404, 'Product not found', ERROR_CODES.NOT_FOUND);

    const lang = req.lang || 'en';
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const hasLocation = !isNaN(lat) && !isNaN(lng) &&
      lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

    let similar = await Product.find({
      _id: { $ne: product._id },
      category: product.category,
      active: true,
      isAvailableToday: true,
    }).lean();

    // Filter by nearby vendor inventory when location is provided
    if (hasLocation) {
      const nearbyProductIds = await getNearbyAvailableProductIds(lat, lng);
      similar = similar.filter(p => nearbyProductIds.has(p._id.toString()));
    }

    const results = localiseProducts(similar.slice(0, 10), lang);
    return sendSuccess(res, 200, 'Similar products fetched', results);
  } catch (err) {
    logger.error('getSimilarProducts error:', err);
    return sendError(res, 500, 'Failed to fetch similar products', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /api/products  (Admin) ───────────────────────────────────
const createProductSchema = z.object({
  name: z.string().min(1),
  nameHi: z.string().optional(),
  category: z.enum(['fruits', 'vegetables', 'spices', 'dairy', 'bakery', 'other']),
  unit: z.literal('kg').default('kg'),
  description: z.string().optional().default(''),
  availableSeason: z.enum(['summer', 'winter', 'rain', 'all']).optional().default('all'),
  images: z.array(z.string().url()).optional().default([]),
  coverImage: z.string().optional().default(''),
  listedPrice: z.coerce.number().min(0).optional().default(0),
  buyingPrice: z.coerce.number().min(0),
  sellingPrice: z.coerce.number().min(0),
  isAvailableToday: z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' ? false : v),
    z.boolean().optional().default(true),
  ),
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
  category: z.enum(['fruits', 'vegetables', 'spices', 'dairy', 'bakery', 'other']).optional(),
  unit: z.literal('kg').optional(),
  description: z.string().optional(),
  availableSeason: z.enum(['summer', 'winter', 'rain', 'all']).optional(),
  images: z.array(z.string().url()).optional(),
  coverImage: z.string().optional(),
  listedPrice: z.coerce.number().min(0).optional(),
  buyingPrice: z.coerce.number().min(0).optional(),
  sellingPrice: z.coerce.number().min(0).optional(),
  isAvailableToday: z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' ? false : v),
    z.boolean().optional(),
  ),
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
// Toggle isAvailableToday
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

// ── PATCH /api/products/:id/active  (Admin) ───────────────────────
// Toggle active — activates or deactivates a product from the catalogue entirely
const toggleActive = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return sendError(res, 404, 'Product not found', ERROR_CODES.NOT_FOUND);

    product.active = !product.active;
    await product.save();

    await invalidateProductCache();
    return sendSuccess(res, 200, `Product ${product.active ? 'activated' : 'deactivated'}`, {
      id: product._id,
      active: product.active,
    });
  } catch (err) {
    logger.error('toggleActive error:', err);
    return sendError(res, 500, 'Failed to toggle active status', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PUT /api/products/bulk-prices  (Admin) ────────────────────────
// Body: { updates: [{ id, buyingPrice, sellingPrice, isAvailableToday }] }
const bulkUpdatePrices = async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || updates.length === 0) {
      return sendError(res, 400, 'updates array is required', ERROR_CODES.MISSING_FIELDS);
    }

    const ops = updates.map(({ id, buyingPrice, sellingPrice, isAvailableToday }) => {
      const $set = {};
      if (buyingPrice      !== undefined) $set.buyingPrice      = buyingPrice;
      if (sellingPrice     !== undefined) $set.sellingPrice     = sellingPrice;
      if (isAvailableToday !== undefined) $set.isAvailableToday = isAvailableToday;
      // Only stamp lastPricedAt when an actual price changed.
      if (buyingPrice !== undefined || sellingPrice !== undefined) $set.lastPricedAt = new Date();
      return { updateOne: { filter: { _id: id }, update: { $set } } };
    });

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

// ── DELETE /api/products/:id  (Admin) ─────────────────────────────
const deleteProduct = async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return sendError(res, 404, 'Product not found', ERROR_CODES.NOT_FOUND);

    await invalidateProductCache();
    return sendSuccess(res, 200, 'Product deleted', { id: req.params.id });
  } catch (err) {
    logger.error('deleteProduct error:', err);
    return sendError(res, 500, 'Failed to delete product', ERROR_CODES.INTERNAL_ERROR);
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
      active: true,
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
  getSimilarProducts,
  createProduct,
  updateProduct,
  toggleAvailability,
  toggleActive,
  bulkUpdatePrices,
  deleteProduct,
  getStaleProducts,
};
