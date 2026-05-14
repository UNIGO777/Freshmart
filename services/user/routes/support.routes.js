const { Router } = require('express');
const { authenticate } = require('../../../gateway/middleware/auth.middleware');
const {
  submitQuery,
  getMyQueries,
  customerReply,
  adminReply,
  getAllQueries,
  updateQueryStatus,
} = require('../controllers/support.controller');

const router = Router();

// All support routes require JWT auth (gateway already applies authenticate,
// but we double-check here in case routes are mounted directly)
router.use(authenticate);

// Customer endpoints
router.post('/queries', submitQuery);
router.get('/queries', getMyQueries);
router.post('/queries/:id/customer-reply', customerReply);

// Admin endpoints (controller checks ADMIN role)
router.get('/queries/all', getAllQueries);
router.post('/queries/:id/reply', adminReply);
router.patch('/queries/:id/status', updateQueryStatus);

module.exports = router;
