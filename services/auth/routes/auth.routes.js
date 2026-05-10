const { Router } = require('express');
const { sendOtp, verifyOtp } = require('../controllers/otp.controller');
const { registerEmail, loginEmail, loginAdmin, refreshToken, logout } = require('../controllers/email.controller');
const { googleLogin, appleLogin } = require('../controllers/social.controller');

const router = Router();

// Phone OTP
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);

// Email / password
router.post('/register-email', registerEmail);
router.post('/login-email', loginEmail);
router.post('/login-admin', loginAdmin);

// Social
router.post('/google', googleLogin);
router.post('/apple', appleLogin);

// Token management
router.post('/refresh', refreshToken);
router.post('/logout', logout);

module.exports = router;
