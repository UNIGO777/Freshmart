const { Router } = require('express');
const {
  toggleStatus,
  getRiderJobs,
  acceptJob,
  rejectJob,
  markPickedUp,
  markDelivered,
  updateLocation,
  getRiderEarnings,
} = require('../controllers/delivery.controller');

const router = Router();

// All /api/delivery routes require auth (enforced by API Gateway).
// Role guard (RIDER only) is handled at the gateway for these routes.

router.patch('/rider/status',          toggleStatus);
router.get('/rider/orders',            getRiderJobs);
router.patch('/rider/accept/:jobId',   acceptJob);
router.patch('/rider/reject/:jobId',   rejectJob);
router.patch('/rider/pickup/:jobId',   markPickedUp);
router.patch('/rider/deliver/:jobId',  markDelivered);
router.post('/rider/location',         updateLocation);
router.get('/rider/earnings',          getRiderEarnings);

module.exports = router;
