require('dotenv').config();
const Vendor = require('../../user/models/Vendor.model');
const Inventory = require('../../vendor/models/Inventory.model');
const Product = require('../../product/models/Product.model');
const logger = require('../../../shared/utils/logger');

const SEARCH_RADIUS_KM = Number(process.env.VENDOR_SEARCH_RADIUS_KM) || 5;

/**
 * Pre-payment stock check.
 *
 * Answers: "Can FreshMart fulfil this order from vendors near the customer?"
 *
 * Steps:
 *  1. Resolve product categories for all ordered items.
 *  2. Geo-query vendors within SEARCH_RADIUS_KM that are approved + active
 *     and cover at least one required category.
 *  3. For each qualifying vendor check their live inventory against ordered items.
 *  4. Aggregate coverage — if together the vendors can cover every ordered item
 *     (considering quantity), the order is serviceable.
 *
 * @param {{ lat: number, lng: number }} customerLocation
 * @param {Array<{ productId: string, quantity: number }>} items
 * @returns {Promise<{
 *   serviceable: boolean,
 *   coveredCategories: string[],
 *   missingCategories: string[],
 *   eligibleVendors: Array<{ vendorId, distance, categories, location }>,
 * }>}
 */
const checkStock = async (customerLocation, items) => {
  const { lat, lng } = customerLocation;

  // ── 1. Resolve products & group by category ───────────────────
  const productIds = items.map((i) => i.productId);
  const products = await Product.find({
    _id: { $in: productIds },
    active: true,
    isAvailableToday: true,
  }).lean();

  if (products.length !== productIds.length) {
    // Some products are not available today
    const foundIds = new Set(products.map((p) => p._id.toString()));
    const missingIds = productIds.filter((id) => !foundIds.has(id.toString()));
    logger.warn('stockChecker: products not available today', missingIds);
    return { serviceable: false, reason: 'some_products_unavailable', eligibleVendors: [] };
  }

  // Map productId → { category, sellingPrice }
  const productMap = Object.fromEntries(products.map((p) => [p._id.toString(), p]));
  const requiredCategories = [...new Set(products.map((p) => p.category))];

  // Required quantity per product
  const requiredQty = Object.fromEntries(items.map((i) => [i.productId.toString(), i.quantity]));

  // ── 2. Geo-query vendors within radius ────────────────────────
  const nearbyVendors = await Vendor.find({
    isApproved: true,
    isActive: true,
    isOnline: true,
    categories: { $in: requiredCategories },
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: SEARCH_RADIUS_KM * 1000, // metres
      },
    },
  })
    .select('_id businessName location categories serviceRadiusKm')
    .lean();

  if (nearbyVendors.length === 0) {
    return { serviceable: false, reason: 'no_vendors_nearby', eligibleVendors: [] };
  }

  // ── 3. Check inventory for each nearby vendor ─────────────────
  const vendorIds = nearbyVendors.map((v) => v._id);

  const inventoryRecords = await Inventory.find({
    vendorId: { $in: vendorIds },
    productId: { $in: productIds },
    isAvailable: true,
  }).lean();

  // inventorySet: vendorId → Set of productIds the vendor has available
  const inventorySet = {};
  for (const rec of inventoryRecords) {
    const vid = rec.vendorId.toString();
    const pid = rec.productId.toString();
    if (!inventorySet[vid]) inventorySet[vid] = new Set();
    inventorySet[vid].add(pid);
  }

  // ── 4. Compute aggregate coverage across all vendors ─────────
  const coverageByProduct = {};
  const eligibleVendors = [];

  for (const vendor of nearbyVendors) {
    const vid = vendor._id.toString();
    const vendorProducts = inventorySet[vid] || new Set();
    const vendorCanSupply = {};

    for (const pid of productIds) {
      const pidStr = pid.toString();
      const product = productMap[pidStr];

      if (vendor.categories.includes(product.category) && vendorProducts.has(pidStr)) {
        vendorCanSupply[pidStr] = true;
        coverageByProduct[pidStr] = true;
      }
    }

    if (Object.keys(vendorCanSupply).length > 0) {
      const [vLng, vLat] = vendor.location.coordinates;
      const distance = haversineKm(lat, lng, vLat, vLng);

      eligibleVendors.push({
        vendorId: vendor._id,
        businessName: vendor.businessName,
        distance,
        categories: vendor.categories,
        location: vendor.location,
        canSupply: vendorCanSupply,
      });
    }
  }

  // ── 5. Determine serviceability ───────────────────────────────
  const coveredCategories = [];
  const missingCategories = [];

  for (const category of requiredCategories) {
    const categoryProductIds = products
      .filter((p) => p.category === category)
      .map((p) => p._id.toString());

    const categoryCovered = categoryProductIds.every(
      (pid) => !!coverageByProduct[pid],
    );

    if (categoryCovered) {
      coveredCategories.push(category);
    } else {
      missingCategories.push(category);
    }
  }

  const serviceable = missingCategories.length === 0;

  // Sort eligible vendors by distance for use in routing
  eligibleVendors.sort((a, b) => a.distance - b.distance);

  return {
    serviceable,
    coveredCategories,
    missingCategories,
    eligibleVendors,
    productMap,
  };
};

// ── Haversine helper ──────────────────────────────────────────────
const haversineKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

module.exports = { checkStock };
