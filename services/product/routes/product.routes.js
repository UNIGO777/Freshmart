const { Router } = require('express');
const {
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
} = require('../controllers/product.controller');
const { authenticate } = require('../../../gateway/middleware/auth.middleware');
const { requireRole } = require('../../../gateway/middleware/roleGuard');
const ROLES = require('../../../shared/constants/roles');

const router = Router();
const adminOnly = [authenticate, requireRole(ROLES.ADMIN)];

// ── Public / customer routes ──────────────────────────────────────
router.get('/', getProducts);             // ?category= ?lang= ?search=
router.get('/categories', getCategories); // ?lang=
router.get('/stale', ...adminOnly, getStaleProducts); // Must be before /:id
router.get('/:id/similar', getSimilarProducts);       // Must be before /:id
router.get('/:id', getProductById);

// ── Admin-only write routes ───────────────────────────────────────
router.post('/', ...adminOnly, createProduct);
router.put('/bulk-prices', ...adminOnly, bulkUpdatePrices);
router.put('/:id', ...adminOnly, updateProduct);
router.patch('/:id/toggle', ...adminOnly, toggleAvailability);
router.patch('/:id/active', ...adminOnly, toggleActive);
router.delete('/:id',       ...adminOnly, deleteProduct);

module.exports = router;
