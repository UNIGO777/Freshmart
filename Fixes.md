# ZipBasket — Bug Fixes Log

> **Fixed On:** 2026-05-09  
> **Total Bugs:** 25 documented | 23 fixed | 2 confirmed non-issues  
> **Packages installed:** `jose`, `rate-limit-redis`, `node-cron`

---

## BUG-001 — PhonePe Webhook Blocked by JWT Auth ✅ FIXED
**File:** `gateway/routes/proxy.routes.js`  
**Approach:** Registered `POST /api/payments/callback` as a standalone route **before** the authenticated `router.use('/api/payments', authenticate, ...)` block. Express matches routes in order, so the webhook now bypasses JWT auth entirely. All other payment endpoints remain protected. This is the correct pattern for any public webhook on an otherwise-private prefix.

---

## BUG-002 — Apple OAuth: No Signature Verification ✅ FIXED
**File:** `services/auth/controllers/social.controller.js`  
**Package added:** `jose`  
**Approach:** Replaced the broken `jwt.decode()` (no-verification) flow with `jose`'s `createRemoteJWKSet` + `jwtVerify`. The `APPLE_JWKS` set is created once at module load and cached; `jose` auto-refreshes it from Apple's JWKS URL when needed. `jwtVerify` performs full RS256 signature verification plus issuer (`https://appleid.apple.com`) and audience (`APPLE_CLIENT_ID`) claim validation — exactly what Apple's documentation requires. The old ~20-line fake-PEM reconstruction was removed entirely.

---

## BUG-003 — JWT Secrets Are Weak Default Strings ✅ FIXED
**Files:** `shared/utils/jwt.util.js`, `.env`  
**Approach:** Two-part fix:
1. Added a startup guard in `jwt.util.js` that checks `ACCESS_SECRET` and `REFRESH_SECRET` against a list of known-insecure values (`change_me`, `secret`, etc.) and calls `process.exit(1)` if matched. This makes the misconfiguration fail loudly at boot rather than silently at runtime.
2. Generated two cryptographically random 256-bit secrets using `crypto.randomBytes(32).toString('hex')` and wrote them into `.env`. Production deployments should use a secrets manager (AWS Secrets Manager, Vault) instead of `.env`.

---

## BUG-004 — Stack Trace Leaked in PayloadTooLargeError ✅ FIXED
**File:** `gateway/index.js`  
**Approach:** Added a 4-argument Express global error handler `(err, _req, res, _next)` after the 404 handler. It inspects `err.type` to return structured JSON for `entity.too.large` (413) and `entity.parse.failed` (400), and a generic 500 for everything else. The stack trace is logged internally via Winston but never sent to the client. This fixes the live-test regression where a 20KB body returned raw HTML with Node.js internals.

---

## BUG-005 — `req.user.phone` Is Always `undefined` in Payment ✅ FIXED
**File:** `services/payment/controllers/payment.controller.js`  
**Approach:** Added `Customer` model import and fetched the customer record by `req.user.id` at the start of `createPaymentOrder`. The `phone` field is pulled from the DB result and passed as `mobileNumber` to PhonePe. This is a single indexed read, so overhead is minimal. The `req.user` object intentionally carries only `{ id, role }` from the JWT — phone must always come from the database.

---

## BUG-006 — PhonePe Callback Checksum Uses Wrong API Path ✅ FIXED
**File:** `services/payment/controllers/payment.controller.js`  
**Approach:** Per PhonePe's callback documentation, the webhook verification hash is `SHA256(base64Response + saltKey)` — no API path is included. The path is only part of outgoing request checksums (e.g., `/pg/v1/pay`, `/pg/v1/refund`). Removed the hardcoded `/pg/v1/status` from `verifyChecksum` so it now correctly computes `SHA256(base64Response + SALT_KEY)`.

---

## BUG-007 — IDOR: Vendor/Rider Can Access Any Order ✅ FIXED
**File:** `services/order/controllers/order.controller.js`  
**Approach:** Added role-specific access checks after the existing CUSTOMER check in `getOrderById`. VENDOR role: verifies `req.user.id` appears in at least one `subOrders[].vendorId`. RIDER role: verifies `req.user.id` appears in at least one `subOrders[].riderId`. Both return 403 FORBIDDEN if the check fails. ADMIN role has no restriction — admins need full visibility.

---

## BUG-008 — `verifyOtp` Accepts `role` from Request Body ✅ FIXED
**File:** `services/auth/controllers/otp.controller.js`  
**Approach:** Removed `role` from the destructured `req.body`. The OTP flow always creates/returns a CUSTOMER — the `role` parameter was never used, but its presence was a footgun for future developers who might wire it up and accidentally enable privilege escalation. Clean removal closes the gap permanently.

---

## BUG-009 — Bulk Inventory Update Has No Item-Level Validation ✅ FIXED
**File:** `services/vendor/controllers/vendor.controller.js`  
**Approach:** Added `bulkInventorySchema` Zod object before `bulkUpdateInventory`. The schema validates: `items` must be an array of 1–500 entries (prevents unbounded bulkWrite), each item has `productId` as a non-empty string, `quantityAvailable` as 0–99999 (prevents negative stock), and optional `isAvailable` boolean. `safeParse` replaces the old existence check, returning structured 400 errors with field-level details.

---

## BUG-010 — Order Cancellation Doesn't Trigger Refund ✅ FIXED
**Files:** `services/order/controllers/order.controller.js`, `services/payment/index.js`  
**Approach:** Two-part fix:
1. In `cancelOrder`: after saving the cancelled order, checks `order.paymentStatus === 'paid'` and fires a non-blocking HTTP call to the new internal endpoint `POST /internal/refund-by-order` on the Payment Service.
2. Added `POST /internal/refund-by-order` to `services/payment/index.js`: looks up the paid transaction, constructs a PhonePe refund request with proper SHA256 checksum (`base64Payload + /pg/v1/refund + SALT_KEY`), calls PhonePe, and marks the transaction as `refunded`. Fire-and-forget so cancellation succeeds even if PhonePe API is slow.

---

## BUG-011 — Rate Limiter Uses In-Memory Store ✅ FIXED
**File:** `gateway/middleware/rateLimiter.js`  
**Package added:** `rate-limit-redis`  
**Approach:** Replaced the default in-memory store with `RedisStore` from `rate-limit-redis`, wired to the existing shared `redisClient` via its `sendCommand` interface. A `makeStore(prefix)` helper wraps construction in try/catch — if Redis is unavailable at module load, it falls back to `undefined` (express-rate-limit uses in-memory as fallback), preventing gateway crash. In production with Redis, all gateway instances share the same counter namespace (`rl:general:`, `rl:auth:`), making limits effective across horizontal scaling.

---

## BUG-012 — OTP Stored Before SMS Is Sent ✅ FIXED
**File:** `services/auth/controllers/otp.controller.js`  
**Approach:** Swapped the order: SMS is sent **first** (with an 8-second timeout), and the OTP session is upserted to MongoDB **only if the SMS succeeds**. If Fast2SMS returns an error or times out, the function falls into `catch` and returns 500 — no phantom OTP session is created. This prevents a scenario where the OTP exists in DB but was never delivered, which could be exploited by brute-forcing it.

---

## BUG-013 — 404 Handler Missing `errorCode` Field ✅ FIXED
**File:** `gateway/index.js`  
**Approach:** Added `errorCode: 'ROUTE_NOT_FOUND'` to the gateway's 404 response JSON, making it consistent with all microservice 404 handlers and with every other error response in the system that uses the `errorCode` field.

---

## BUG-014 — Rider Earnings `today`/`thisWeek` Never Reset ✅ FIXED
**File:** `services/delivery/index.js`  
**Package added:** `node-cron`  
**Approach:** Added two `cron.schedule` jobs inside `Promise.all([connectDB(), connectRedis()]).then(...)` so they only start after the DB is connected:
- **Daily** (`30 18 * * *` = 00:00 IST): `Rider.updateMany({}, { $set: { 'earnings.today': 0 } })`
- **Weekly** (`30 18 * * 0` = 00:00 IST on Monday): `Rider.updateMany({}, { $set: { 'earnings.thisWeek': 0 } })`
Both jobs log the count of affected riders and catch errors without crashing the process.

---

## BUG-015 — `confirmCod` Doesn't Validate Order Status ✅ FIXED
**File:** `services/payment/controllers/payment.controller.js`  
**Approach:** Added two guards after the existing payment method check:
1. `order.status !== ORDER_STATUS.CONFIRMED` → 400 (prevents confirming cancelled or already-delivered orders)
2. `Transaction.findOne({ orderId })` → if a transaction already exists, returns it with 200 (idempotent — prevents duplicate COD records from double-submit)

---

## BUG-016 — `getAvailableInventory` Exposes Competitor Stock ✅ FIXED
**File:** `services/vendor/controllers/vendor.controller.js`  
**Approach:** Added a role check at the start of `getAvailableInventory`. When `req.user.role === ROLES.VENDOR`, the `vendorId` filter is **forced** to `req.user.id`, ignoring any `?vendorId=` query parameter. A vendor can only see their own inventory. ADMIN users retain the ability to query any vendor. Internal Order Service calls (no `req.user`) are unaffected.

---

## BUG-017 — `cancelledAt` Not in Order Schema ✅ CONFIRMED NON-ISSUE
**File:** `services/order/models/Order.model.js`  
**Finding:** The field `cancelledAt: Date` is already present at line 120 of the schema alongside `cancelReason`. The audit report was incorrect. No change needed.

---

## BUG-018 — Socket.io CORS Allows All Origins ✅ FIXED
**File:** `services/socket/index.js`  
**Approach:** Replaced hardcoded `origin: '*'` with a value derived from the `ALLOWED_ORIGINS` env var (same pattern as the gateway). In production with no `ALLOWED_ORIGINS` set, the origin list is an empty array — Socket.io rejects all cross-origin connections. In development, falls back to `'*'`. Added `credentials: true` for cookie-based auth flows.

---

## BUG-019 — No Idempotency on Payment Creation ✅ FIXED
**File:** `services/payment/controllers/payment.controller.js`  
**Approach:** Added a DB-level idempotency check at the start of `createPaymentOrder`: queries `Transaction.findOne({ orderId, status: 'created' })`. If a pending transaction already exists for this order, the existing `merchantTransactionId` is returned immediately without creating a new PhonePe payment or DB record. Covers the most common double-submit scenario (network retry, UI double-click).

---

## BUG-020 — Redis Routing State Lost on Service Crash ✅ FIXED
**File:** `services/order/index.js`  
**Approach:** Added `resumeStuckOrders()` called once immediately after the server starts listening. It queries MongoDB for orders in `confirmed`/`awaiting_payment` status with a non-empty `offeredVendorIds` array — these are orders that were mid-routing when the service crashed. For each one, it re-calls `initiateRouting()` to re-fetch eligible vendors and restart the batched offer process. Runs as fire-and-forget after startup to avoid delaying the listen event.

---

## BUG-021 — No Pagination on Admin List Endpoints ✅ CONFIRMED NON-ISSUE
**Files:** `services/admin/controllers/vendor-mgmt.controller.js`, `rider-mgmt.controller.js`, `customer-mgmt.controller.js`  
**Finding:** All three controllers already implement `page`/`limit`/`skip` with `Math.max`/`Math.min` bounds (max 100 per page). The audit report was incorrect. No change needed.

---

## BUG-022 — `validateCoupon` Accepts Unsafe Number Strings ✅ FIXED
**File:** `services/order/controllers/order.controller.js`  
**Approach:** Replaced the bare `if (!code || !orderSubtotal)` check with a Zod schema validating `code` as a non-empty string (max 50 chars) and `orderSubtotal` as a positive number with a max of 1,000,000. `Number("1e308")` (Infinity) and `Number("abc")` (NaN) are now rejected because Zod's `z.number()` only accepts JS number primitives, not strings, and the `max(1_000_000)` cap prevents absurd values. Returns field-level errors on failure.

---

## BUG-023 — Morgan Uses `dev` Format in Production ✅ FIXED
**Files:** `gateway/index.js` + all 9 `services/*/index.js` files (10 total)  
**Approach:** Replaced `morgan('dev')` with `morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev')` in all 10 entry points using a `perl -i -pe` one-liner. In production, `combined` format gives Apache Combined Log Format — machine-parseable, no ANSI colors, includes response time and user-agent for log aggregation tools (CloudWatch, Datadog). In development, `dev` is retained for readable colorized output.

---

## BUG-024 — `offerToBatch` Replaces Instead of Appending `offeredVendorIds` ✅ FIXED
**File:** `services/order/logic/vendorRouter.js`  
**Approach:** Changed `order.routingMeta.offeredVendorIds = batch.map(...)` to a set-union merge: collects existing IDs and new batch IDs, deduplicates via `new Set(...)`, and writes the merged array back. Vendor IDs from previous batches are preserved so their late-acceptance attempts remain valid, and `GET /api/orders/vendor/incoming` (which filters by `offeredVendorIds`) continues to surface the order to vendors from earlier batches until routing is fully resolved.

---

## BUG-025 — No `unhandledRejection`/`uncaughtException` Handlers ✅ FIXED
**Files:** All 11 entry points (gateway + 10 services)  
**Approach:** Added both `process.on('unhandledRejection', ...)` and `process.on('uncaughtException', ...)` handlers to every entry point via a `perl -i` script. Both handlers log the error via Winston and call `process.exit(1)`. Calling `exit(1)` is intentional — in a managed environment (PM2, Docker, Kubernetes) the process manager will restart the service. The gateway uses `../shared/utils/logger` (one level up) while services use `../../shared/utils/logger` (two levels up) — corrected after the automated insertion.

---

## Summary Table

| Bug | Severity | Status | Files Changed |
|-----|----------|--------|---------------|
| BUG-001 PhonePe webhook blocked | CRITICAL | ✅ Fixed | `gateway/routes/proxy.routes.js` |
| BUG-002 Apple OAuth no sig verify | CRITICAL | ✅ Fixed | `services/auth/controllers/social.controller.js` |
| BUG-003 Weak JWT secrets | CRITICAL | ✅ Fixed | `.env`, `shared/utils/jwt.util.js` |
| BUG-004 Stack trace leak | CRITICAL | ✅ Fixed | `gateway/index.js` |
| BUG-005 req.user.phone undefined | HIGH | ✅ Fixed | `services/payment/controllers/payment.controller.js` |
| BUG-006 Wrong callback checksum | HIGH | ✅ Fixed | `services/payment/controllers/payment.controller.js` |
| BUG-007 IDOR on order endpoint | HIGH | ✅ Fixed | `services/order/controllers/order.controller.js` |
| BUG-008 role in OTP body | HIGH | ✅ Fixed | `services/auth/controllers/otp.controller.js` |
| BUG-009 Bulk inventory no validation | HIGH | ✅ Fixed | `services/vendor/controllers/vendor.controller.js` |
| BUG-010 Cancel order no refund | HIGH | ✅ Fixed | `services/order/controllers/order.controller.js`, `services/payment/index.js` |
| BUG-011 In-memory rate limiter | HIGH | ✅ Fixed | `gateway/middleware/rateLimiter.js` |
| BUG-012 OTP saved before SMS | HIGH | ✅ Fixed | `services/auth/controllers/otp.controller.js` |
| BUG-013 404 missing errorCode | HIGH | ✅ Fixed | `gateway/index.js` |
| BUG-014 Rider earnings never reset | MEDIUM | ✅ Fixed | `services/delivery/index.js` |
| BUG-015 COD no status validation | MEDIUM | ✅ Fixed | `services/payment/controllers/payment.controller.js` |
| BUG-016 Competitor stock exposed | MEDIUM | ✅ Fixed | `services/vendor/controllers/vendor.controller.js` |
| BUG-017 cancelledAt not in schema | MEDIUM | ✅ Non-issue | Already in schema at line 120 |
| BUG-018 Socket CORS too permissive | MEDIUM | ✅ Fixed | `services/socket/index.js` |
| BUG-019 No payment idempotency | MEDIUM | ✅ Fixed | `services/payment/controllers/payment.controller.js` |
| BUG-020 Redis state lost on crash | MEDIUM | ✅ Fixed | `services/order/index.js` |
| BUG-021 No admin pagination | LOW | ✅ Non-issue | Already implemented |
| BUG-022 Unsafe coupon subtotal | LOW | ✅ Fixed | `services/order/controllers/order.controller.js` |
| BUG-023 Morgan dev in production | LOW | ✅ Fixed | All 10 `index.js` entry points |
| BUG-024 offeredVendorIds replaced | LOW | ✅ Fixed | `services/order/logic/vendorRouter.js` |
| BUG-025 No process crash handlers | LOW | ✅ Fixed | All 11 `index.js` entry points |
