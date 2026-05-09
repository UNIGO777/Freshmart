# FreshMart — Non-Working / Broken APIs

> **Test Date:** 2026-05-09  
> **Method:** Live gateway test (port 3000) + static code analysis  
> **Status:** Gateway (port 3000) is UP. All backend microservices (3001–3010) are DOWN due to MongoDB Atlas DNS resolution failure (`querySrv EREFUSED`) and Redis Upstash connection timeout in the current local environment.

---

## CRITICAL — Broken by Design (Code Bugs)

### 1. `POST /api/payments/callback` — PhonePe Webhook Blocked by Auth
**Status:** BROKEN  
**Severity:** CRITICAL  
**Root cause:** `gateway/routes/proxy.routes.js` line 51 applies `authenticate` middleware to ALL `/api/payments/*` routes:
```js
router.use('/api/payments', authenticate, proxy(SERVICE_URLS.payment));
```
PhonePe's server-to-server callback carries **no JWT token**, so every callback returns:
```json
{"success":false,"message":"No token provided","errorCode":"UNAUTHORIZED"}
```
**Impact:** UPI payments will **never confirm**. Orders will be stuck in `awaiting_payment` forever. The entire UPI payment flow is broken.  
**Fix:**
```js
// Route the webhook BEFORE the authenticated block
router.post('/api/payments/callback', proxy(SERVICE_URLS.payment));
router.use('/api/payments', authenticate, proxy(SERVICE_URLS.payment));
```

---

### 2. `POST /api/auth/apple` — Apple Token Signature Not Verified
**Status:** BROKEN / INSECURE  
**Severity:** CRITICAL  
**Root cause:** `services/auth/controllers/social.controller.js` lines 41–47:
```js
// Reconstructs a fake PEM from raw JWK JSON (not a valid PEM)
const publicKey = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(JSON.stringify(matchingKey)).toString('base64')}\n-----END PUBLIC KEY-----`;
// Then immediately ignores it and just decodes without verification:
const decoded = jwt.decode(idToken);  // NO SIGNATURE CHECK
```
**Impact:** Any attacker can forge an Apple ID token with arbitrary `sub`/`email` and create or hijack accounts.  
**Fix:** Use `jose` or `jwks-rsa` library to properly verify RS256 signature against Apple's public keys.

---

### 3. `GET /api/payments/vendor/payouts` — Returns Empty Placeholder
**Status:** NOT IMPLEMENTED  
**Severity:** HIGH  
**Root cause:** `services/payment/controllers/payment.controller.js` line 299:
```js
const listVendorPayouts = async (req, res) => {
  return sendSuccess(res, 200, 'Vendor payouts (placeholder)', []);
};
```
**Impact:** Admin cannot view vendor payout queue. Always returns empty array.

---

### 4. `POST /api/payments/vendor/payout/:vendorId` — Placeholder, No Actual Payout
**Status:** NOT IMPLEMENTED  
**Severity:** HIGH  
**Root cause:** `services/payment/controllers/payment.controller.js` line 307:
```js
const triggerVendorPayout = async (req, res) => {
  return sendSuccess(res, 200, 'Payout triggered (placeholder)', { vendorId: req.params.vendorId });
};
```
**Impact:** No money is ever transferred to vendors via this endpoint. Payout is silently faked.

---

## BROKEN AT RUNTIME — Services Crash on Startup

All the following endpoints are unreachable because their backing microservice crashes immediately on startup due to external dependency failures:

| Service | Port | Crash Reason | Affected Endpoints |
|---------|------|-------------|-------------------|
| Auth | 3001 | MongoDB `querySrv EREFUSED` | `/api/auth/*` |
| User | 3002 | MongoDB `querySrv EREFUSED` | `/api/users/*` |
| Product | 3003 | MongoDB + Redis timeout | `/api/products/*` |
| Order | 3004 | MongoDB + Redis timeout | `/api/orders/*` |
| Vendor | 3005 | MongoDB `querySrv EREFUSED` | `/api/vendors/*` |
| Delivery | 3006 | MongoDB + Redis timeout | `/api/delivery/*` |
| Payment | 3007 | MongoDB `querySrv EREFUSED` | `/api/payments/*` |
| Notification | 3008 | MongoDB `querySrv EREFUSED` | `/api/notifications/*` |
| Admin | 3009 | MongoDB `querySrv EREFUSED` | `/api/admin/*` |
| Socket | 3010 | MongoDB `querySrv EREFUSED` | WebSocket connections |

**All `/api/auth/*`, `/api/users/*`, `/api/products/*`, `/api/orders/*`, `/api/vendors/*`, `/api/delivery/*`, `/api/payments/*`, `/api/notifications/*`, `/api/admin/*` return:**
```json
{"success":false,"message":"Service unavailable","errorCode":"SERVICE_UNAVAILABLE"}
```

> **Note:** These failures are environment-specific (no network access to MongoDB Atlas / Redis Upstash from this machine). In a properly connected environment, the services would start correctly — except for the code-level bugs listed above.

---

## PARTIALLY WORKING — Logic Gaps

### 5. `PATCH /api/orders/:id/cancel` — No Refund Triggered
**Status:** INCOMPLETE  
**Severity:** MEDIUM  
**Root cause:** `services/order/controllers/order.controller.js` line 267:
```js
// TODO Phase 4: trigger refund if already paid
```
If a customer cancels a confirmed, UPI-paid order, no refund is initiated. Money is taken but not returned.

---

### 6. `POST /api/auth/send-otp` — SMS Will Always Fail
**Status:** BROKEN  
**Severity:** HIGH  
**Root cause:** `.env` has empty Fast2SMS credentials:
```
FASTTOSMS_ACCOUNT_SID=
FASTTOSMS_AUTH_TOKEN=
FASTTOSMS_PHONE=
```
OTP session is saved to DB, but the Axios call to Fast2SMS will fail or return an auth error. OTP is stored but never delivered to the user's phone.

---

### 7. `POST /api/payments/create-order` — `req.user.phone` is Always `undefined`
**Status:** BUG  
**Severity:** MEDIUM  
**Root cause:** `services/payment/controllers/payment.controller.js` line 79:
```js
mobileNumber: req.user.phone,  // req.user only has { id, role } from JWT
```
JWT payload is `{ id, role }` — no `phone` field. PhonePe receives `mobileNumber: undefined`, which may cause payment initiation to fail or the UPI intent to not pre-fill the mobile number.

---

### 8. Rider Earnings Reset — No Cron Job
**Status:** INCOMPLETE  
**Severity:** MEDIUM  
**Root cause:** `Rider.earnings.today` and `Rider.earnings.thisWeek` are incremented on delivery but **never reset**. There is no scheduled task to zero `today` at midnight or `thisWeek` at week start.  
**Impact:** Rider earnings dashboard shows inflated/incorrect figures.

---

## SUMMARY TABLE

| # | Endpoint | Method | Status | Severity |
|---|----------|--------|--------|----------|
| 1 | `/api/payments/callback` | POST | BROKEN (auth blocks webhook) | CRITICAL |
| 2 | `/api/auth/apple` | POST | BROKEN (no signature verify) | CRITICAL |
| 3 | `/api/payments/vendor/payouts` | GET | NOT IMPLEMENTED | HIGH |
| 4 | `/api/payments/vendor/payout/:vendorId` | POST | NOT IMPLEMENTED | HIGH |
| 5 | `/api/auth/send-otp` | POST | SMS never delivered | HIGH |
| 6 | `/api/payments/create-order` | POST | `mobileNumber` always undefined | MEDIUM |
| 7 | `/api/orders/:id/cancel` | PATCH | No refund on cancellation | MEDIUM |
| 8 | `/api/delivery/rider/earnings` | GET | `today`/`thisWeek` never reset | MEDIUM |
| — | All `/api/*` (except `/health`) | ALL | SERVICE_UNAVAILABLE (env issue) | ENV |
