const { Router } = require('express');
const { getProfile, updateProfile, getAddresses, addAddress, deleteAddress, toggleOnline, getWishlist, addToWishlist, removeFromWishlist } = require('../controllers/user.controller');

const router = Router();

// Profile
router.get('/me', getProfile);
router.patch('/me', updateProfile);

// Addresses (customer-only, enforced in controller)
router.get('/me/addresses', getAddresses);
router.post('/me/addresses', addAddress);
router.delete('/me/addresses/:addressId', deleteAddress);

// Wishlist (customer-only, enforced in controller)
router.get('/me/wishlist', getWishlist);
router.post('/me/wishlist', addToWishlist);
router.delete('/me/wishlist/:productId', removeFromWishlist);

// Vendor online/offline toggle
router.patch('/toggle-online', toggleOnline);

module.exports = router;
