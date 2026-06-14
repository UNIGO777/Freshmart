const { Router } = require('express');
const {
  getCatalog,
  getInventory,
  upsertInventory,
  toggleInventoryAvailability,
  bulkUpdateInventory,
  getEarnings,
  getAvailableInventory,
} = require('../controllers/vendor.controller');
const { authenticate } = require('../../../gateway/middleware/auth.middleware');
const { requireRole } = require('../../../gateway/middleware/roleGuard');
const ROLES = require('../../../shared/constants/roles');

const router = Router();

// All vendor routes require JWT + vendor role (enforced at gateway for /api/vendors,
// but re-checked here in case service is hit directly).
const vendorAuth = [authenticate, requireRole(ROLES.VENDOR, ROLES.ADMIN)];

// Internal route — used by Order Service (no role restriction, internal traffic only)
router.get('/inventory/available', getAvailableInventory);

// Vendor inventory management
router.get('/inventory/catalog', ...vendorAuth, getCatalog);
router.get('/inventory', ...vendorAuth, getInventory);
router.put('/inventory/bulk', ...vendorAuth, bulkUpdateInventory);
router.put('/inventory/:productId', ...vendorAuth, upsertInventory);
router.patch('/inventory/:productId/toggle', ...vendorAuth, toggleInventoryAvailability);

// Vendor earnings
router.get('/earnings', ...vendorAuth, getEarnings); // ?period=today|week|all

module.exports = router;
