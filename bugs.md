# FreshMart — Bug Report

> **Audit Date:** 2026-05-09  
> **Coverage:** All 11 services, gateway middleware, shared utilities  
> **Testing:** Static code analysis + live API tests on port 3000

---

## SEVERITY: CRITICAL

### BUG-001 — PhonePe Webhook Blocked by JWT Auth
**File:** `gateway/routes/proxy.routes.js:51`  
**Code:**
```js
router.use('/api/payments', authenticate, proxy(SERVICE_URLS.payment));
```
**Problem:** `POST /api/payments/callback` is PhonePe's server-to-server webhook. It carries no JWT. The `authenticate` middleware runs on ALL `/api/payments/*` routes, so PhonePe's server gets a 401 and retries indefinitely. UPI payments **never confirm**. Orders stick in `awaiting_payment` forever.  
**Fix:** Register the callback route before the authenticated payment block:
```js
router.post('/api/payments/callback', proxy(SERVICE_URLS.payment));
router.use('/api/payments', authenticate, proxy(SERVICE_URLS.payment));
```

---

### BUG-002 — Apple OAuth: Token Decoded Without Signature Verification
**File:** `services/auth/controllers/social.controller.js:41–47`  
**Code:**
```js
const publicKey = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(JSON.stringify(matchingKey)).toString('base64')}\n-----END PUBLIC KEY-----`;
const decoded = jwt.decode(idToken); // jwt.decode = no verification
```
**Problem:** The constructed "PEM" is not a valid PEM — it base64-encodes raw JSON, not DER-encoded key bytes. `jwt.decode()` is then used instead of `jwt.verify()`, meaning the signature is **never checked**. An attacker can craft a token with any `sub`/`email` and gain access to any account.  
**Fix:** Use the `jose` library:
```js
import { createRemoteJWKSet, jwtVerify } from 'jose';
const JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const { payload } = await jwtVerify(idToken, JWKS, { issuer: 'https://appleid.apple.com', audience: process.env.APPLE_CLIENT_ID });
```

---

### BUG-003 — JWT Secrets Are Weak Default Strings
**File:** `.env:18–19`  
**Code:**
```
JWT_SECRET=change_me
JWT_REFRESH_SECRET=change_me
```
**Problem:** Both secrets are hardcoded placeholder strings. Any attacker who knows this default (e.g., from a leaked `.env.example`) can forge valid tokens for any userId/role, including ADMIN.  
**Fix:** Generate cryptographically random 256-bit secrets and store in a secrets manager:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

### BUG-004 — Stack Trace Leaked in PayloadTooLarge Error
**File:** `gateway/index.js` (missing error handler)  
**Reproduced:** Live test with 20KB+ body returns raw HTML with full Node.js stack trace:
```html
<pre>PayloadTooLargeError: request entity too large
    at readStream (.../raw-body/index.js:163:17) ...</pre>
```
**Problem:** Express 5 propagates the `PayloadTooLargeError` to the default error handler which renders an HTML stack trace, leaking internal file paths and library versions.  
**Fix:** Add a global error handler in `gateway/index.js` before the 404 handler:
```js
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Request too large', errorCode: 'PAYLOAD_TOO_LARGE' });
  }
  logger.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error', errorCode: 'INTERNAL_ERROR' });
});
```
The same error handler is missing from all 10 microservices as well.

---

## SEVERITY: HIGH

### BUG-005 — `req.user.phone` Is Always `undefined` in Payment
**File:** `services/payment/controllers/payment.controller.js:79`  
**Code:**
```js
mobileNumber: req.user.phone,
```
**Problem:** The JWT payload is `{ id, role }` only. The auth middleware sets `req.user = { id, role }` — there is no `phone` field. `mobileNumber` is sent to PhonePe as `undefined` (omitted from JSON), which means UPI payments won't pre-fill the user's phone number. Some PhonePe configurations may reject the request entirely.  
**Fix:** Fetch the user's phone from the database or pass it in the request body from the client.

---

### BUG-006 — PhonePe Callback Checksum Uses Wrong API Path
**File:** `services/payment/controllers/payment.controller.js:46–52`  
**Code:**
```js
const verifyChecksum = (base64Response, receivedChecksum) => {
  const hash = crypto.createHash('sha256')
    .update(base64Response + '/pg/v1/status' + SALT_KEY)
    .digest('hex');
```
**Problem:** PhonePe's webhook/callback verification uses the callback endpoint path, not `/pg/v1/status`. The hardcoded path `/pg/v1/status` is for payment status polling, not for callback verification. All incoming PhonePe callbacks will fail checksum validation and be rejected with `"Checksum mismatch"`.  
**Fix:** PhonePe callback verification does not use an API path in the hash — verify using only the base64 response and salt key, per PhonePe's documentation.

---

### BUG-007 — `GET /api/orders/:id` — Vendor/Rider Can Access Any Order
**File:** `services/order/controllers/order.controller.js:230–233`  
**Code:**
```js
if (req.user.role === ROLES.CUSTOMER && order.customerId.toString() !== req.user.id) {
  return sendError(res, 403, 'Access denied', ERROR_CODES.FORBIDDEN);
}
```
**Problem:** Access control is only enforced for CUSTOMER role. A VENDOR or RIDER can access **any order** by its ID — including orders from other vendors and customers they've never interacted with. This leaks sensitive delivery addresses, phone numbers, and payment details.  
**Fix:**
```js
if (req.user.role === ROLES.CUSTOMER && order.customerId.toString() !== req.user.id) {
  return sendError(res, 403, 'Access denied', ERROR_CODES.FORBIDDEN);
}
if (req.user.role === ROLES.VENDOR) {
  const isAssigned = order.subOrders.some(so => so.vendorId?.toString() === req.user.id);
  if (!isAssigned) return sendError(res, 403, 'Access denied', ERROR_CODES.FORBIDDEN);
}
if (req.user.role === ROLES.RIDER) {
  const isAssigned = order.subOrders.some(so => so.riderId?.toString() === req.user.id);
  if (!isAssigned) return sendError(res, 403, 'Access denied', ERROR_CODES.FORBIDDEN);
}
```

---

### BUG-008 — `verifyOtp` Accepts Any Role in Body
**File:** `services/auth/controllers/otp.controller.js:63`  
**Code:**
```js
const { phone, otp, role = ROLES.CUSTOMER } = req.body;
```
**Problem:** The `role` parameter is accepted from the request body but **never used** — the token is always signed with `ROLES.CUSTOMER` (line 104). However, if this logic were changed, a user could self-elevate to VENDOR or ADMIN by passing `role: "ADMIN"` in the OTP verification payload. The parameter should be removed to prevent confusion and future privilege escalation.  
**Fix:** Remove `role` from the destructured body entirely since it's unused.

---

### BUG-009 — Vendor Bulk Inventory Update Has No Item Validation
**File:** `services/vendor/controllers/vendor.controller.js:83–110`  
**Code:**
```js
const { items } = req.body;
if (!Array.isArray(items) || items.length === 0) { ... }

const ops = items.map(({ productId, quantityAvailable, isAvailable }) => ({ ... }));
```
**Problem:** No Zod/schema validation on individual items. A vendor can submit `quantityAvailable: -999` or `quantityAvailable: null`. Negative quantities could break the stock checker's `$gt: 0` filter logic. No cap on array size — a vendor could send 10,000 items and cause a massive bulkWrite.  
**Fix:** Add Zod validation:
```js
const bulkSchema = z.object({
  items: z.array(z.object({
    productId: z.string(),
    quantityAvailable: z.number().min(0).max(99999),
    isAvailable: z.boolean().optional(),
  })).min(1).max(500),
});
```

---

### BUG-010 — Order Cancellation Doesn't Trigger Refund
**File:** `services/order/controllers/order.controller.js:267`  
**Code:**
```js
// TODO Phase 4: trigger refund if already paid
```
**Problem:** A customer can cancel a confirmed, UPI-paid order. The order is marked cancelled and routing is cleared, but the payment is **never refunded**. This is a legal/financial bug — customers pay but receive no money back on cancellation.  
**Fix:** Before saving the cancelled order, check `order.paymentStatus === 'paid'` and call the Payment Service's refund endpoint.

---

### BUG-011 — Rate Limiter Uses In-Memory Store (Breaks at Scale)
**File:** `gateway/middleware/rateLimiter.js`  
**Code:**
```js
const rateLimit = require('express-rate-limit');
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10 ... });
```
**Problem:** `express-rate-limit` defaults to an in-memory store. With multiple gateway instances (horizontal scaling), each instance has its own counter — a user can make `10 × N` auth requests across `N` instances, completely defeating the rate limit. Also, counters reset on restart.  
**Fix:** Use `rate-limit-redis` with the shared Redis client:
```js
const RedisStore = require('rate-limit-redis');
const authLimiter = rateLimit({ store: new RedisStore({ sendCommand: (...args) => redisClient.sendCommand(args) }), ... });
```

---

### BUG-012 — Fast2SMS OTP: OTP Is Stored Even When SMS Fails
**File:** `services/auth/controllers/otp.controller.js:33–54`  
**Code:**
```js
await OtpSession.findOneAndUpdate(...); // OTP saved to DB
await axios.get('https://www.fast2sms.com/...'); // then SMS sent
```
**Problem:** The OTP is upserted to the database **before** the SMS is sent. If the SMS call fails (e.g., empty credentials in `.env`), the OTP exists in the DB but the user never received it. The response still says "OTP sent successfully" because the error is caught and returns 500 only from the `catch`, but the OTP session remains, potentially allowing attacks. Also, the SMS auth token is empty in `.env`.  
**Fix:** Send the SMS first, save to DB only if SMS succeeds. Return proper 500 if SMS fails.

---

### BUG-013 — 404 Handler Missing `errorCode` Field (Inconsistent Response)
**File:** `gateway/index.js:34`  
**Code:**
```js
res.status(404).json({ success: false, message: 'Route not found' });
```
**Problem:** All other error responses include `errorCode` (e.g., `"ROUTE_NOT_FOUND"`), but the 404 handler doesn't. The live test showed the actual 404 from services returns `"code":"ROUTE_NOT_FOUND"` while the gateway's own 404 uses a different structure. Clients expecting a consistent `errorCode` field will break.  
**Fix:**
```js
res.status(404).json({ success: false, message: 'Route not found', errorCode: 'ROUTE_NOT_FOUND' });
```

---

## SEVERITY: MEDIUM

### BUG-014 — Rider Earnings `today`/`thisWeek` Never Reset
**File:** `services/delivery/controllers/delivery.controller.js:150–157`  
**Problem:** `Rider.earnings.today` and `Rider.earnings.thisWeek` are incremented on delivery completion but there is no scheduled task to reset them. After 1 day, `today` shows all-time earnings. After 7 days, `thisWeek` is also wrong.  
**Fix:** Add a cron job (or use node-cron) to reset `earnings.today` at midnight and `earnings.thisWeek` on Monday morning.

---

### BUG-015 — `confirmCod` Doesn't Validate Order Status
**File:** `services/payment/controllers/payment.controller.js:210–241`  
**Code:**
```js
const order = await Order.findOne({ _id: orderId, customerId: req.user.id });
if (!order) return sendError(res, 404, ...);
if (order.paymentMethod !== 'cod') return sendError(res, 400, ...);
// Creates transaction without checking order.status
```
**Problem:** If the order is already `cancelled`, `delivered`, or has an existing transaction, `confirmCod` will happily create another transaction record. A customer could call this multiple times and create duplicate COD transaction records.  
**Fix:** Check `order.status === ORDER_STATUS.CONFIRMED` and verify no existing transaction for this order before creating a new one.

---

### BUG-016 — `getAvailableInventory` Exposes All Vendor Stock Via Gateway
**File:** `services/vendor/controllers/vendor.controller.js:162–185`  
**Problem:** `GET /api/vendors/inventory/available` is an internal endpoint meant for the Order Service. However, it's exposed through the gateway at `/api/vendors/inventory/available` with only VENDOR/ADMIN auth. A VENDOR can query `?vendorId=<other_vendor_id>` and see another vendor's stock levels — revealing competitor inventory data.  
**Fix:** Remove this route from the public gateway proxy or validate that `req.query.vendorId === req.user.id` for VENDOR role.

---

### BUG-017 — `order.cancelledAt` Is Not in Mongoose Schema
**File:** `services/order/controllers/order.controller.js:261`  
**Code:**
```js
order.cancelledAt = new Date();
```
**Problem:** `Order.model.js` does not define a `cancelledAt` field. Setting it on a Mongoose document without `strict: false` will silently discard the value — it won't be saved to MongoDB. Cancellation timestamp is lost.  
**Fix:** Add `cancelledAt: { type: Date }` to the Order schema.

---

### BUG-018 — Socket.io CORS Allows All Origins
**File:** `services/socket/index.js` (inferred from exploration)  
**Code:**
```js
cors: { origin: '*', methods: ['GET', 'POST'] }
```
**Problem:** Any website can establish a WebSocket connection to the Socket.io server, potentially intercepting real-time order tracking events or rider locations by guessing room names.  
**Fix:** Set `origin` to a whitelist of allowed app domains.

---

### BUG-019 — No Idempotency on `POST /api/payments/create-order`
**File:** `services/payment/controllers/payment.controller.js:60–122`  
**Problem:** There is no idempotency key check. If a client double-submits (network retry, UI bug), two `Transaction` records are created for the same order, both sent to PhonePe. The customer might be charged twice.  
**Fix:** Accept an `Idempotency-Key` header and cache/deduplicate based on it via Redis. Alternatively, check for an existing `created` transaction for the same `orderId` before creating a new one.

---

### BUG-020 — Redis Routing State Has No Cleanup on Service Crash
**File:** `services/order/logic/vendorRouter.js:115`  
**Code:**
```js
await redisClient.set(routingKey(orderId), JSON.stringify(routingState), { EX: 3600 });
```
**Problem:** Routing state TTL is 1 hour. Per-vendor offer TTLs are `VENDOR_OFFER_TTL` seconds (90s). If the Order Service crashes mid-routing, the Redis state persists but the in-memory sweep that would cascade it is gone. Orders can get stuck waiting for vendor responses that will never come, even after the service restarts.  
**Fix:** On service startup, query all orders in `confirmed` status with a non-empty `offeredVendorIds` and re-trigger routing.

---

## SEVERITY: LOW

### BUG-021 — No Pagination on Admin List Endpoints
**File:** `services/admin/controllers/vendor-mgmt.controller.js`, `rider-mgmt.controller.js`, `customer-mgmt.controller.js`  
**Problem:** Admin endpoints (`GET /api/admin/vendors`, `GET /api/admin/riders`, `GET /api/admin/customers`) likely return all records without pagination. At 1 lakh users, this returns 100,000 documents in a single response, causing OOM/timeout.  
**Fix:** Add `page`/`limit` query params and `.skip().limit()` as done in `getOrders`.

---

### BUG-022 — `validateCoupon` Endpoint Accepts Arbitrary Number Strings
**File:** `services/order/controllers/order.controller.js:497`  
**Code:**
```js
const result = await validateCoupon(code, Number(orderSubtotal), req.user.id);
```
**Problem:** `Number("1e308")` = `Infinity`, `Number("abc")` = `NaN`. If `orderSubtotal` is `"1e308"`, discount calculations will produce `Infinity`. No Zod schema guards this input.  
**Fix:** Use `z.number().positive().max(1000000)` to validate `orderSubtotal`.

---

### BUG-023 — Morgan Logs to Console in Production
**File:** `gateway/index.js:21`  
**Code:**
```js
app.use(morgan('dev'));
```
**Problem:** `morgan('dev')` format is colorized and verbose, designed for development. In production, it logs to stdout unnecessarily and without structured JSON, making log aggregation (CloudWatch, Datadog) harder.  
**Fix:** Use `morgan('combined')` or pipe to Winston in production.

---

### BUG-024 — `offerToBatch` in `vendorRouter` Doesn't Reset `offeredVendorIds` Before New Batch
**File:** `services/order/logic/vendorRouter.js:138`  
**Code:**
```js
order.routingMeta.offeredVendorIds = batch.map((v) => v._id);
```
**Problem:** When cascading to the next batch, `offeredVendorIds` is **replaced** rather than **appended**. The vendor incoming orders endpoint filters by `offeredVendorIds`:
```js
Order.find({ 'routingMeta.offeredVendorIds': req.user.id, ... })
```
If batch 2 replaces batch 1's IDs, vendors in batch 1 who accepted late can no longer see the order (since their ID was removed from `offeredVendorIds`). This could cause acceptance to fail silently.

---

### BUG-025 — No Error Handler in Any Microservice for Unhandled Promise Rejections
**Problem:** None of the `services/*/index.js` files have `process.on('unhandledRejection', ...)` handlers. Unhandled promise rejections in Node.js (v15+) crash the process by default. A single failed DB operation not caught in a try/catch will take down the entire microservice.  
**Fix:** Add to each service's entry point:
```js
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
  process.exit(1); // Let PM2/Docker restart
});
```
