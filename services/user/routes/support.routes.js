const { Router } = require('express');
const { authenticate } = require('../../../gateway/middleware/auth.middleware');
const { submitQuery, getMyQueries, adminReply, getAllQueries } = require('../controllers/support.controller');

const router = Router();

// Customer endpoints — require JWT auth
router.post('/queries', authenticate, submitQuery);
router.get('/queries', authenticate, getMyQueries);

// Admin endpoints — protected by x-admin-secret header (no JWT required)
router.get('/queries/all', getAllQueries);
router.post('/queries/:id/reply', adminReply);

module.exports = router;
