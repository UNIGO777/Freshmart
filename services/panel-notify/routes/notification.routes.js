const { Router } = require('express');
const {
  createNotification,
  listNotifications,
  markOneRead,
  markAllRead,
  deleteNotification,
} = require('../controllers/notification.controller');

const router = Router();

// Internal — called by other services, no auth
router.post('/internal/create', createNotification);

// Public (auth enforced at gateway)
router.get('/notifications',               listNotifications);
router.patch('/notifications/read-all',    markAllRead);   // must be before /:id
router.patch('/notifications/:id/read',    markOneRead);
router.delete('/notifications/:id',        deleteNotification);

module.exports = router;
