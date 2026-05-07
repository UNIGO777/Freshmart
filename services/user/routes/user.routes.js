const { Router } = require('express');
const { getProfile, updateProfile, getAddresses, addAddress, deleteAddress } = require('../controllers/user.controller');

const router = Router();

// Profile
router.get('/me', getProfile);
router.patch('/me', updateProfile);

// Addresses (customer-only, enforced in controller)
router.get('/me/addresses', getAddresses);
router.post('/me/addresses', addAddress);
router.delete('/me/addresses/:addressId', deleteAddress);

module.exports = router;
