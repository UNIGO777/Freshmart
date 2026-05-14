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
  panelNotify: `http://localhost:${process.env.PORT_PANEL_NOTIFY || 3012}`,
};

const proxy = (target, stripPrefix) =>
  createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: stripPrefix ? { [`^${stripPrefix}`]: '' } : undefined,
    on: {
      error: (err, req, res) => {
        res.status(502).json({ success: false, message: 'Service unavailable', errorCode: 'SERVICE_UNAVAILABLE' });
      },
    },
  });

// ── Public routes (no auth required) ──────────────────────────────
// Skip rate limiter in development/test so repeated login attempts don't get blocked.
const isDev = process.env.NODE_ENV !== 'production';
router.use('/api/auth', ...(isDev ? [] : [authLimiter]), proxy(SERVICE_URLS.auth, '/api/auth'));

// ── Public user routes ────────────────────────────────────────────
router.get('/api/users/check-serviceability', proxy(SERVICE_URLS.user, '/api/users'));

// Public banners + deal of the day (no auth) — served from admin service
router.get('/api/banners', proxy(SERVICE_URLS.admin));
router.get('/api/deal-of-day', proxy(SERVICE_URLS.admin));

// ── Protected routes ───────────────────────────────────────────────
router.use('/api/users', authenticate, proxy(SERVICE_URLS.user, '/api/users'));

// Support — admin endpoints (queries/all, queries/:id/reply) use x-admin-secret; customer endpoints use JWT
router.use('/api/support', authenticate, proxy(SERVICE_URLS.user, '/api/support'));

router.use(
  '/api/products',
  (req, res, next) => {
    // GET requests are public; write operations require auth
    if (req.method === 'GET') return next();
    authenticate(req, res, next);
  },
  proxy(SERVICE_URLS.product, '/api/products'),
);

router.use('/api/orders', authenticate, proxy(SERVICE_URLS.order, '/api/orders'));

// PhonePe server-to-server webhook carries no JWT — must be before the authenticated block
router.post('/api/payments/callback', proxy(SERVICE_URLS.payment, '/api/payments'));
router.use('/api/payments', authenticate, proxy(SERVICE_URLS.payment, '/api/payments'));
router.use('/api/delivery', authenticate, proxy(SERVICE_URLS.delivery, '/api/delivery'));
// Promo push requires ADMIN; FCM token update is open to any authenticated role
router.use('/api/notifications/promo', authenticate, requireRole(ROLES.ADMIN), proxy(SERVICE_URLS.notification, '/api/notifications'));
router.use('/api/notifications', authenticate, proxy(SERVICE_URLS.notification, '/api/notifications'));

router.use(
  '/api/vendors',
  authenticate,
  requireRole(ROLES.VENDOR, ROLES.ADMIN),
  proxy(SERVICE_URLS.vendor, '/api/vendors'),
);

router.use(
  '/api/admin',
  authenticate,
  requireRole(ROLES.ADMIN),
  proxy(SERVICE_URLS.admin, '/api/admin'),
);

router.use(
  '/api/panel-notify',
  authenticate,
  requireRole(ROLES.ADMIN),
  proxy(SERVICE_URLS.panelNotify, '/api/panel-notify'),
);

module.exports = router;
