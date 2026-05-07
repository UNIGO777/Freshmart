require('dotenv').config();
const { Router } = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { authenticate } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/roleGuard');
const { authLimiter } = require('../middleware/rateLimiter');
const ROLES = require('../../shared/constants/roles');

const router = Router();

const SERVICE_URLS = {
  auth: `http://localhost:${process.env.PORT_AUTH || 3001}`,
  user: `http://localhost:${process.env.PORT_USER || 3002}`,
  product: `http://localhost:${process.env.PORT_PRODUCT || 3003}`,
  order: `http://localhost:${process.env.PORT_ORDER || 3004}`,
  vendor: `http://localhost:${process.env.PORT_VENDOR || 3005}`,
  delivery: `http://localhost:${process.env.PORT_DELIVERY || 3006}`,
  payment: `http://localhost:${process.env.PORT_PAYMENT || 3007}`,
  notification: `http://localhost:${process.env.PORT_NOTIFICATION || 3008}`,
  admin: `http://localhost:${process.env.PORT_ADMIN || 3009}`,
};

const proxy = (target) =>
  createProxyMiddleware({
    target,
    changeOrigin: true,
    on: {
      error: (err, req, res) => {
        res.status(502).json({ success: false, message: 'Service unavailable', errorCode: 'SERVICE_UNAVAILABLE' });
      },
    },
  });

// ── Public routes (no auth required) ──────────────────────────────
router.use('/api/auth', authLimiter, proxy(SERVICE_URLS.auth));

// ── Protected routes ───────────────────────────────────────────────
router.use('/api/users', authenticate, proxy(SERVICE_URLS.user));

router.use(
  '/api/products',
  (req, res, next) => {
    // GET requests are public; write operations require auth
    if (req.method === 'GET') return next();
    authenticate(req, res, next);
  },
  proxy(SERVICE_URLS.product),
);

router.use('/api/orders', authenticate, proxy(SERVICE_URLS.order));
router.use('/api/payments', authenticate, proxy(SERVICE_URLS.payment));
router.use('/api/delivery', authenticate, proxy(SERVICE_URLS.delivery));
router.use('/api/notifications', authenticate, proxy(SERVICE_URLS.notification));

router.use(
  '/api/vendors',
  authenticate,
  requireRole(ROLES.VENDOR, ROLES.ADMIN),
  proxy(SERVICE_URLS.vendor),
);

router.use(
  '/api/admin',
  authenticate,
  requireRole(ROLES.ADMIN),
  proxy(SERVICE_URLS.admin),
);

module.exports = router;
