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
  label: z.string().optional(),
  lat: z.number(),
  lng: z.number(),
  fullAddress: z.string().min(5),
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

module.exports = { getProfile, updateProfile, getAddresses, addAddress, deleteAddress };
