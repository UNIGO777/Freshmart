const { z } = require('zod');
const Customer = require('../models/Customer.model');
const Vendor = require('../models/Vendor.model');
const Rider = require('../models/Rider.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const ROLES = require('../../../shared/constants/roles');
const logger = require('../../../shared/utils/logger');

// ── Helper — pick the right model for the authenticated user ──────
const getModel = (role) => {
  if (role === ROLES.CUSTOMER) return Customer;
  if (role === ROLES.VENDOR) return Vendor;
  if (role === ROLES.RIDER) return Rider;
  return null;
};

// ── GET /api/users/me ─────────────────────────────────────────────
const getProfile = async (req, res) => {
  try {
    const Model = getModel(req.user.role);
    if (!Model) return sendError(res, 400, 'Unknown role', ERROR_CODES.VALIDATION_ERROR);

    const user = await Model.findById(req.user.id).lean();
    if (!user) return sendError(res, 404, 'User not found', ERROR_CODES.USER_NOT_FOUND);

    return sendSuccess(res, 200, 'Profile fetched', user);
  } catch (err) {
    logger.error('getProfile error:', err);
    return sendError(res, 500, 'Failed to fetch profile', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /api/users/me ───────────────────────────────────────────
const updateProfile = async (req, res) => {
  try {
    const Model = getModel(req.user.role);
    if (!Model) return sendError(res, 400, 'Unknown role', ERROR_CODES.VALIDATION_ERROR);

    // Whitelist updatable fields per role
    const allowedFields = {
      [ROLES.CUSTOMER]: ['name', 'language', 'fcmToken'],
      [ROLES.VENDOR]: ['businessName', 'ownerName', 'fcmToken', 'bankDetails', 'categories'],
      [ROLES.RIDER]: ['name', 'fcmToken', 'vehicleType'],
    };

    const updates = {};
    for (const field of allowedFields[req.user.role] || []) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    const updated = await Model.findByIdAndUpdate(req.user.id, updates, { new: true, runValidators: true }).lean();
    if (!updated) return sendError(res, 404, 'User not found', ERROR_CODES.USER_NOT_FOUND);

    return sendSuccess(res, 200, 'Profile updated', updated);
  } catch (err) {
    logger.error('updateProfile error:', err);
    return sendError(res, 500, 'Failed to update profile', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/users/me/addresses  (Customer only) ──────────────────
const getAddresses = async (req, res) => {
  try {
    if (req.user.role !== ROLES.CUSTOMER) {
      return sendError(res, 403, 'Only customers have addresses', ERROR_CODES.FORBIDDEN);
    }

    const customer = await Customer.findById(req.user.id, 'addresses').lean();
    if (!customer) return sendError(res, 404, 'User not found', ERROR_CODES.USER_NOT_FOUND);

    return sendSuccess(res, 200, 'Addresses fetched', customer.addresses);
  } catch (err) {
    logger.error('getAddresses error:', err);
    return sendError(res, 500, 'Failed to fetch addresses', ERROR_CODES.INTERNAL_ERROR);
  }
};

const addressSchema = z.object({
  label:       z.string().optional(),
  lat:         z.number().optional(),
  lng:         z.number().optional(),
  fullAddress: z.string().min(3),
  flat:        z.string().optional(),
  floor:       z.string().optional(),
  landmark:    z.string().optional(),
  street:      z.string().optional(),
  city:        z.string().optional(),
  state:       z.string().optional(),
  zip:         z.string().optional(),
});

// ── POST /api/users/me/addresses ──────────────────────────────────
const addAddress = async (req, res) => {
  try {
    if (req.user.role !== ROLES.CUSTOMER) {
      return sendError(res, 403, 'Only customers can add addresses', ERROR_CODES.FORBIDDEN);
    }

    const parsed = addressSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const customer = await Customer.findByIdAndUpdate(
      req.user.id,
      { $push: { addresses: parsed.data } },
      { new: true },
    ).lean();

    if (!customer) return sendError(res, 404, 'User not found', ERROR_CODES.USER_NOT_FOUND);

    return sendSuccess(res, 201, 'Address added', customer.addresses);
  } catch (err) {
    logger.error('addAddress error:', err);
    return sendError(res, 500, 'Failed to add address', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── DELETE /api/users/me/addresses/:addressId ──────────────────────
const deleteAddress = async (req, res) => {
  try {
    if (req.user.role !== ROLES.CUSTOMER) {
      return sendError(res, 403, 'Only customers can delete addresses', ERROR_CODES.FORBIDDEN);
    }

    const customer = await Customer.findByIdAndUpdate(
      req.user.id,
      { $pull: { addresses: { _id: req.params.addressId } } },
      { new: true },
    ).lean();

    if (!customer) return sendError(res, 404, 'User not found', ERROR_CODES.USER_NOT_FOUND);

    return sendSuccess(res, 200, 'Address deleted', customer.addresses);
  } catch (err) {
    logger.error('deleteAddress error:', err);
    return sendError(res, 500, 'Failed to delete address', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PUT /api/users/me/addresses/:addressId ────────────────────────
const updateAddress = async (req, res) => {
  try {
    if (req.user.role !== ROLES.CUSTOMER) {
      return sendError(res, 403, 'Only customers can update addresses', ERROR_CODES.FORBIDDEN);
    }

    const parsed = addressSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const customer = await Customer.findOneAndUpdate(
      { _id: req.user.id, 'addresses._id': req.params.addressId },
      { $set: { 'addresses.$': { _id: req.params.addressId, ...parsed.data } } },
      { new: true },
    ).lean();

    if (!customer) return sendError(res, 404, 'Address not found', ERROR_CODES.USER_NOT_FOUND);

    return sendSuccess(res, 200, 'Address updated', customer.addresses);
  } catch (err) {
    logger.error('updateAddress error:', err);
    return sendError(res, 500, 'Failed to update address', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /check-serviceability?lat=...&lng=...  (Public — no auth) ─────
const RADIUS_TIERS = [
  { maxKm: 5,  estimatedMinutes: 15 },
  { maxKm: 10, estimatedMinutes: 30 },
  { maxKm: 15, estimatedMinutes: 45 },
];

const ALL_CATEGORIES = ['fruits', 'vegetables', 'spices', 'dairy', 'bakery', 'other'];

const checkServiceability = async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return sendError(res, 400, 'Valid lat and lng query params required', ERROR_CODES.VALIDATION_ERROR);
    }

    const availableCategories = [];
    const unavailableCategories = [];

    // For each category, find the closest vendor that serves it
    for (const category of ALL_CATEGORIES) {
      let found = false;

      for (const tier of RADIUS_TIERS) {
        const vendors = await Vendor.find({
          isApproved: true,
          isActive: true,
          isOnline: true,
          categories: category,
          location: {
            $nearSphere: {
              $geometry: { type: 'Point', coordinates: [lng, lat] },
              $maxDistance: tier.maxKm * 1000,
            },
          },
        })
          .limit(1)
          .select('_id')
          .lean();

        if (vendors.length > 0) {
          availableCategories.push({
            category,
            radiusKm: tier.maxKm,
            estimatedMinutes: tier.estimatedMinutes,
          });
          found = true;
          break;
        }
      }

      if (!found) {
        unavailableCategories.push(category);
      }
    }

    const serviceable = availableCategories.length > 0;
    const message = serviceable ? 'Delivery available' : 'Delivery not available';

    return sendSuccess(res, 200, message, {
      serviceable,
      availableCategories,
      unavailableCategories,
    });
  } catch (err) {
    logger.error('checkServiceability error:', err);
    return sendError(res, 500, 'Failed to check serviceability', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /toggle-online  (Vendor only) ──────────────────────────────
const axios = require('axios');
const SOCKET_URL = `http://localhost:${process.env.PORT_SOCKET || 3010}`;

const emitToCustomer = (customerId, event, payload) =>
  axios.post(`${SOCKET_URL}/internal/emit`, {
    room: `customer:${customerId}`,
    event,
    payload,
  }, { timeout: 3000 }).catch((err) => logger.warn(`Failed to emit ${event}:`, err.message));

const toggleOnline = async (req, res) => {
  try {
    if (req.user.role !== ROLES.VENDOR) {
      return sendError(res, 403, 'Only vendors can toggle online status', ERROR_CODES.FORBIDDEN);
    }

    const vendor = await Vendor.findById(req.user.id);
    if (!vendor) return sendError(res, 404, 'Vendor not found', ERROR_CODES.USER_NOT_FOUND);

    vendor.isOnline = !vendor.isOnline;
    await vendor.save();

    // Notify all customers in real-time so they re-check serviceability
    try {
      await axios.post(`${SOCKET_URL}/internal/emit`, {
        room: 'serviceability:broadcast',
        event: 'vendor:availability',
        payload: {
          vendorId: vendor._id,
          isOnline: vendor.isOnline,
          location: vendor.location,
          serviceRadiusKm: vendor.serviceRadiusKm,
          categories: vendor.categories,
        },
      }, { timeout: 3000 });
    } catch (socketErr) {
      logger.warn('Failed to emit vendor:availability socket event:', socketErr.message);
    }

    return sendSuccess(res, 200, `You are now ${vendor.isOnline ? 'online' : 'offline'}`, {
      isOnline: vendor.isOnline,
    });
  } catch (err) {
    logger.error('toggleOnline error:', err);
    return sendError(res, 500, 'Failed to toggle status', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /me/wishlist  (Customer only) ─────────────────────────────
const getWishlist = async (req, res) => {
  try {
    if (req.user.role !== ROLES.CUSTOMER) {
      return sendError(res, 403, 'Only customers have a wishlist', ERROR_CODES.FORBIDDEN);
    }

    const customer = await Customer.findById(req.user.id).select('wishlist').lean();
    if (!customer) return sendError(res, 404, 'User not found', ERROR_CODES.USER_NOT_FOUND);

    return sendSuccess(res, 200, 'Wishlist fetched', customer.wishlist);
  } catch (err) {
    logger.error('getWishlist error:', err);
    return sendError(res, 500, 'Failed to fetch wishlist', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /me/wishlist  (Customer only) ────────────────────────────
const addToWishlist = async (req, res) => {
  try {
    if (req.user.role !== ROLES.CUSTOMER) {
      return sendError(res, 403, 'Only customers can manage wishlist', ERROR_CODES.FORBIDDEN);
    }

    const { productId, name, sellingPrice, coverImage, category } = req.body;
    if (!productId || !name || sellingPrice === undefined) {
      return sendError(res, 400, 'productId, name, and sellingPrice are required', ERROR_CODES.VALIDATION_ERROR);
    }

    // Prevent duplicates
    const existing = await Customer.findOne({ _id: req.user.id, 'wishlist.productId': productId }).lean();
    if (existing) {
      return sendError(res, 409, 'Product already in wishlist', ERROR_CODES.CONFLICT);
    }

    const customer = await Customer.findByIdAndUpdate(
      req.user.id,
      { $push: { wishlist: { productId, name, sellingPrice, coverImage, category } } },
      { new: true },
    ).lean();

    if (!customer) return sendError(res, 404, 'User not found', ERROR_CODES.USER_NOT_FOUND);

    emitToCustomer(req.user.id, 'wishlist:toggled', { productId, action: 'add' });
    return sendSuccess(res, 201, 'Added to wishlist', customer.wishlist);
  } catch (err) {
    logger.error('addToWishlist error:', err);
    return sendError(res, 500, 'Failed to add to wishlist', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── DELETE /me/wishlist/:productId  (Customer only) ───────────────
const removeFromWishlist = async (req, res) => {
  try {
    if (req.user.role !== ROLES.CUSTOMER) {
      return sendError(res, 403, 'Only customers can manage wishlist', ERROR_CODES.FORBIDDEN);
    }

    const customer = await Customer.findByIdAndUpdate(
      req.user.id,
      { $pull: { wishlist: { productId: req.params.productId } } },
      { new: true },
    ).lean();

    if (!customer) return sendError(res, 404, 'User not found', ERROR_CODES.USER_NOT_FOUND);

    emitToCustomer(req.user.id, 'wishlist:toggled', { productId: req.params.productId, action: 'remove' });
    return sendSuccess(res, 200, 'Removed from wishlist', customer.wishlist);
  } catch (err) {
    logger.error('removeFromWishlist error:', err);
    return sendError(res, 500, 'Failed to remove from wishlist', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /me/cart  (Customer only) ─────────────────────────────────
const getCart = async (req, res) => {
  try {
    if (req.user.role !== ROLES.CUSTOMER) {
      return sendError(res, 403, 'Only customers have a cart', ERROR_CODES.FORBIDDEN);
    }
    const customer = await Customer.findById(req.user.id).select('cart').lean();
    if (!customer) return sendError(res, 404, 'User not found', ERROR_CODES.USER_NOT_FOUND);
    return sendSuccess(res, 200, 'Cart fetched', customer.cart);
  } catch (err) {
    logger.error('getCart error:', err);
    return sendError(res, 500, 'Failed to fetch cart', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PUT /me/cart  (Customer only) — replaces entire cart ──────────
const syncCart = async (req, res) => {
  try {
    if (req.user.role !== ROLES.CUSTOMER) {
      return sendError(res, 403, 'Only customers have a cart', ERROR_CODES.FORBIDDEN);
    }
    const items = req.body.items;
    if (!Array.isArray(items)) {
      return sendError(res, 400, 'items must be an array', ERROR_CODES.VALIDATION_ERROR);
    }
    const cart = items
      .filter((i) => i.productId && i.name && i.sellingPrice != null)
      .map(({ productId, name, sellingPrice, coverImage, unit, qty }) => ({
        productId,
        name,
        sellingPrice,
        coverImage: coverImage || '',
        unit: unit || '',
        qty: Math.max(1, Number(qty) || 1),
      }));

    const customer = await Customer.findByIdAndUpdate(
      req.user.id,
      { $set: { cart } },
      { new: true },
    ).lean();
    if (!customer) return sendError(res, 404, 'User not found', ERROR_CODES.USER_NOT_FOUND);
    return sendSuccess(res, 200, 'Cart synced', customer.cart);
  } catch (err) {
    logger.error('syncCart error:', err);
    return sendError(res, 500, 'Failed to sync cart', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { getProfile, updateProfile, getAddresses, addAddress, updateAddress, deleteAddress, checkServiceability, toggleOnline, getWishlist, addToWishlist, removeFromWishlist, getCart, syncCart };
