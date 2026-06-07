const { Router } = require('express');
const { sendOtp, verifyOtp } = require('../controllers/otp.controller');
const { register } = require('../controllers/register.controller');
const { registerEmail, loginEmail, loginAdmin, refreshToken, logout, switchRole } = require('../controllers/email.controller');
const { authenticate } = require('../../../gateway/middleware/auth.middleware');
const { googleLogin, appleLogin } = require('../controllers/social.controller');

const router = Router();

// Phone OTP (sign-in flow)
router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);

// Registration — name + email + confirmEmail + phone (no password)
router.post('/register', register);

// Legacy email/password (kept for admin panel & backwards compat)
router.post('/register-email', registerEmail);
router.post('/login-email', loginEmail);
router.post('/login-admin', loginAdmin);

// Social
router.post('/google', googleLogin);
router.post('/apple', appleLogin);

// Token management
router.post('/refresh', refreshToken);
router.post('/logout', logout);

// Role switching (customer ↔ vendor)
router.post('/switch-role', authenticate, switchRole);

module.exports = router;
