const { Router } = require('express');
const { sendOtp, verifyOtp } = require('../controllers/otp.controller');
const { register } = require('../controllers/register.controller');
const { registerEmail, loginEmail, loginAdmin, refreshToken, logout, switchRole } = require('../controllers/email.controller');
const { authenticate } = require('../../../gateway/middleware/auth.middleware');
const { googleLogin, appleLogin } = require('../controllers/social.controller');
const { otpSendLimiter, loginLimiter } = require('../middleware/accountRateLimiter');

const router = Router();

// Phone OTP (sign-in flow) — rate limited PER PHONE (not per IP), so many
// different users signing in at once never trip each other's limits.
router.post('/send-otp', otpSendLimiter, sendOtp);
router.post('/verify-otp', loginLimiter, verifyOtp);

// Registration — name + email + confirmEmail + phone (no password)
router.post('/register', register);

// Legacy email/password (kept for admin panel & backwards compat)
router.post('/register-email', registerEmail);
router.post('/login-email', loginLimiter, loginEmail);
router.post('/login-admin', loginLimiter, loginAdmin);

// Social
router.post('/google', googleLogin);
router.post('/apple', appleLogin);

// Token management
router.post('/refresh', refreshToken);
router.post('/logout', logout);

// Role switching (customer ↔ vendor)
router.post('/switch-role', authenticate, switchRole);

module.exports = router;
