const { Router } = require('express');
const { getProfile, updateProfile, getAddresses, addAddress, updateAddress, deleteAddress, toggleOnline, getWishlist, addToWishlist, removeFromWishlist, getCart, syncCart, updateBankDetails, submitSupportTicket } = require('../controllers/user.controller');

const router = Router();

// Profile
router.get('/me', getProfile);
router.patch('/me', updateProfile);

// Addresses (customer-only, enforced in controller)
router.get('/me/addresses', getAddresses);
router.post('/me/addresses', addAddress);
router.put('/me/addresses/:addressId', updateAddress);
router.delete('/me/addresses/:addressId', deleteAddress);

// Wishlist (customer-only, enforced in controller)
router.get('/me/wishlist', getWishlist);
router.post('/me/wishlist', addToWishlist);
router.delete('/me/wishlist/:productId', removeFromWishlist);

// Cart (customer-only, enforced in controller)
router.get('/me/cart', getCart);
router.put('/me/cart', syncCart);

// Vendor online/offline toggle
router.patch('/toggle-online', toggleOnline);

// Rider bank details + Support ticket (any role)
router.patch('/me/bank-details', updateBankDetails);
router.post('/me/support', submitSupportTicket);

module.exports = router;
