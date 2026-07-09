# ZipBasket Backend — Full App Review

> **Reviewer:** Claude Code (claude-sonnet-4-6)  
> **Review Date:** 2026-05-09  
> **Scope:** Architecture, code quality, security, scalability, completeness  
> **Verdict: 6.5 / 10** — Solid foundation with critical payment and security bugs that must be fixed before production.

---

## Executive Summary

ZipBasket is a well-structured microservices grocery delivery backend for the Indian market. The architecture is thoughtful — 11 services with clean separation of concerns, a dedicated API gateway, real-time delivery tracking via Socket.io, and a sophisticated multi-vendor order routing system with batched vendor offers and cascading fallback. The developer clearly understands the domain.

However, the app has **3 critical bugs that would make it unshippable**: the PhonePe webhook is blocked by authentication (UPI payments never confirm), Apple OAuth tokens are not verified (account takeover possible), and JWT secrets are "change_me". There are also several HIGH-severity issues, placeholder implementations, and scalability gaps.

---

## Architecture

### Strengths
- **Clean microservice separation:** Each domain (auth, user, product, order, vendor, delivery, payment, notification, admin, socket) is its own independent service. Services communicate via HTTP internally, which is simple and debuggable.
- **API Gateway pattern:** Single entry point at port 3000 with centralized auth, rate limiting, and routing. Security enforcement is co-located and easy to audit.
- **Standardized response format:** `{ success, statusCode, message, data }` and `{ success, message, errorCode, details }` are used consistently via `response.util.js`. Client-side error handling is straightforward.
- **Zod validation:** Controllers that accept complex input (checkStock, placeOrder, rateOrder, updateLocation) use Zod schemas. Validation errors return structured field-level details.
- **Redis for ephemeral state:** Vendor offer state, routing metadata, and delivery job offers are stored in Redis with TTL. This is the right call — this data is transient and shouldn't clutter MongoDB.
- **Geospatial queries:** MongoDB `$nearSphere` queries with 2dsphere indexes on Vendor and Rider. The vendor and rider selection algorithms are solid.
- **Winston logging:** Structured logging with timestamps, file outputs, and error stack traces. Good operational hygiene.
- **Helmet + CORS:** Security headers configured. CORS can be locked down via `ALLOWED_ORIGINS` env var.
- **Intelligent order routing:** The batched vendor offering with cascading fallback (batch 1 → batch 2 → ... → failed) is a sophisticated and practical approach for a hyper-local marketplace.
- **Rider assignment algorithm:** 30-second offer windows with background sweep for expired offers is industry-standard for delivery apps.
- **Coupon engine:** Supports flat/percent discounts, per-user limits, date validity, min order value, and max discount cap.

### Weaknesses
- **All services share one MongoDB:** Despite being "microservices," every service imports models from other services (e.g., Order Service imports `../../user/models/Rider.model`). This creates tight coupling — services cannot be deployed independently or use different databases. True microservices should have data ownership.
- **HTTP-only service mesh:** Internal service calls are plain HTTP with no circuit breaker (no resilience4j, no Hystrix, no retry logic). If the Order Service is slow, all callers block. Fire-and-forget calls swallow failures silently.
- **No message queue:** Notifications, routing triggers, and rider assignment are all synchronous or fire-and-forget HTTP. A Redis queue (Bull) or a message broker (RabbitMQ/Kafka) would decouple these and provide retry guarantees.
- **No service discovery:** All service URLs are hardcoded as `localhost:PORT`. Moving to Docker/Kubernetes requires changing every internal call. Should use environment variables for URLs or a service registry.
- **No API versioning:** All routes are `/api/...` with no version prefix. A breaking change requires coordinated client and server deploys.

---

## Security Assessment

### Critical Issues (Must Fix Before Launch)
1. **JWT secrets are "change_me"** — Token forgery trivially possible.
2. **PhonePe webhook blocked by auth** — UPI payments will never complete.
3. **Apple OAuth skips signature verification** — Account takeover via forged tokens.
4. **Stack traces leaked in PayloadTooLargeError** — Internal paths and library versions exposed.
5. **PhonePe callback checksum uses wrong API path** — All webhook signature checks will fail.

### High Issues
6. **No CSRF protection** — Though stateless JWTs reduce risk, browser-based clients remain vulnerable if tokens are stored in localStorage.
7. **Rate limiter uses in-memory store** — Ineffective across multiple gateway instances.
8. **No idempotency on payment creation** — Double-charge risk.
9. **Vendor can view any order** — IDOR vulnerability on `/api/orders/:id`.
10. **`/api/vendors/inventory/available` leaks competitor data** — Any vendor can query another vendor's stock.

### Passed Checks
- Auth endpoints have stricter rate limiting (10/10min vs 200/15min general).
- JWT expiry is short (15 min access, 30 day refresh) — good.
- Password hashing uses bcryptjs with salt 12 — correct.
- PhonePe checksum is verified (though path is wrong — see above).
- Input size capped at 10KB for JSON — confirmed working (PayloadTooLargeError on large payloads).
- Mongoose ODM protects against most NoSQL injection for standard operations.
- Role-based access at gateway level (CUSTOMER / VENDOR / RIDER / ADMIN).

---

## Code Quality

### Good
- Controller functions are well-scoped — each does one thing.
- Business logic is separated from route handlers (vendorRouter, riderAssigner, stockChecker, couponEngine, orderSplitter are all standalone modules).
- Consistent async/await with try/catch in all controllers.
- Meaningful error codes (36 defined in `shared/constants/errorCodes.js`).
- i18n support via language middleware and `nameHi` fields on products/categories.
- Rider rating uses a correct incremental average formula with MongoDB aggregation pipeline update.
- `cancelledAt` → needs to be added to Order schema (currently silently dropped).

### Needs Improvement
- **No tests at all.** `package.json` test script: `"echo \"No tests configured yet\""`. For a financial/payment system this is a serious gap. Core logic (couponEngine, vendorRouter, riderAssigner, stockChecker) should have unit tests.
- **`require('axios')` inside functions** in `vendorRouter.js` (lines 22, 278). This works but is unusual — should be at the top of the file.
- **`deliveryFee` is hardcoded at ₹30** in `placeOrder` with comment "distance-based logic goes in Phase 5". This means all orders cost ₹30 regardless of distance.
- **Placeholder implementations:** `listVendorPayouts` and `triggerVendorPayout` return stub data. Admin payout flow is non-functional.
- **No `.nvmrc` or `engines` field** in `package.json`. Node version is unspecified — version mismatches between dev and prod.
- **`morgan('dev')`** colorized logging in production.
- **No PM2/process manager config** for production deployment.

---

## Performance & Scalability

### Strengths
- Redis caching for product listing and categories — reduces DB load for high-read endpoints.
- Geospatial indexes on Vendor and Rider collections — `$nearSphere` queries are efficient.
- `Promise.all()` used correctly for parallel DB queries (dashboard, rider earnings).
- `select('-routingMeta')` on order queries — avoids sending large internal metadata to clients.
- Pagination on customer order history (`page`/`limit`).

### Weaknesses
- **Admin list endpoints have no pagination** — returning all vendors/riders/customers at scale causes OOM.
- **Rate limiter is per-instance** — doesn't scale horizontally without Redis store.
- **No connection pooling config** for MongoDB — Mongoose defaults may not be optimal for high concurrency.
- **Background sweep runs every 15 seconds** on the delivery service — this queries MongoDB for all OFFERED jobs with expired `offerExpiresAt`. At 10,000 active deliveries, this is an expensive full-collection scan without a compound index on `(status, offerExpiresAt)`.
- **Socket.io broadcasts rider location to all trackers** — at lakh-scale, broadcasting individual GPS updates per active delivery can overwhelm the socket server. Consider throttling to once per 5 seconds and using Redis pub/sub for multi-instance socket servers.
- **Fire-and-forget internal HTTP calls** — if the Socket Service or Notification Service is slow, delivery controllers block. Use queues.
- **No DB query timeouts configured** — slow MongoDB queries will block Node.js event loop indefinitely.
- **Dashboard runs 10 parallel aggregations** — at scale with unpaginated results, admin dashboard may time out.

---

## Feature Completeness

| Feature | Status | Notes |
|---------|--------|-------|
| Phone OTP auth | Partial | OTP stored but SMS won't deliver (empty Fast2SMS creds) |
| Email/password auth | Complete | Bcrypt, validation, refresh tokens |
| Google OAuth | Complete | Proper RS256 verification via googleapis |
| Apple OAuth | Broken | No signature verification |
| Product catalog (i18n) | Complete | EN/HI, categories, search, Redis cache |
| Stock check | Complete | Geo-based, multi-vendor coverage |
| Coupon engine | Complete | Flat/%, per-user limits, date validity |
| Order placement | Complete | Stock re-check, price snapshot, delivery fee |
| Vendor routing | Complete | Batched offers, cascade, Redis state |
| UPI payment (PhonePe) | Broken | Webhook blocked by auth |
| COD payment | Complete | Confirmed at placement, routing immediate |
| Rider assignment | Complete | Geo-based, 30s window, cascade |
| Real-time tracking | Complete | Socket.io + FCM, rider location broadcast |
| Order cancellation | Partial | No refund triggered |
| Order rating | Complete | Zod validated, incremental rider avg |
| Vendor inventory mgmt | Complete | Upsert, bulk, toggle |
| Vendor earnings | Complete | today/week/all periods |
| Vendor payout | Placeholder | Returns stub data |
| Admin dashboard | Complete | 10 KPIs in parallel |
| Admin analytics | Present | (controller exists, not fully reviewed) |
| Admin vendor/rider mgmt | Complete | Approve, block |
| Admin coupon CRUD | Complete | Full lifecycle |
| Admin order override | Complete | Status override |
| Notifications (FCM) | Complete | Push to customer/vendor/rider |
| SMS OTP delivery | Broken | Empty Fast2SMS credentials |
| Rider earnings reset | Missing | No cron for daily/weekly reset |
| Tests | Missing | Zero test coverage |

---

## Recommendations — Priority Order

### P0 — Fix Before Any Real Traffic
1. **Fix PaymentCallback auth** (`notWorkingapi.md` BUG-001)
2. **Fix Apple token verification** (use `jose`)
3. **Rotate JWT secrets** to cryptographically random values
4. **Fix PhonePe callback checksum path** (BUG-006)
5. **Add global error handler** to prevent stack trace leaks (BUG-004)
6. **Add Fast2SMS credentials** to env

### P1 — Fix Before Production Launch
7. Fix `req.user.phone` undefined in payment (BUG-005)
8. Fix vendor/rider IDOR on `GET /api/orders/:id` (BUG-007)
9. Add idempotency to `POST /api/payments/create-order` (BUG-019)
10. Implement refund on order cancellation (BUG-010)
11. Implement rider earnings daily/weekly reset (BUG-014)
12. Add `cancelledAt` to Order schema (BUG-017)
13. Implement actual vendor payout via PhonePe Payouts API

### P2 — Before Scaling to 10K+ Users
14. Switch rate limiter to Redis store (BUG-011)
15. Add pagination to all admin list endpoints (BUG-021)
16. Add compound index on `(status, offerExpiresAt)` for DeliveryJob sweep
17. Add Zod validation to bulk inventory endpoint (BUG-009)
18. Implement Bull/BullMQ queue for notifications and rider assignment
19. Add `unhandledRejection` process handlers (BUG-025)
20. Write unit tests for couponEngine, vendorRouter, riderAssigner, stockChecker

### P3 — Good Engineering Hygiene
21. Add API versioning (`/api/v1/`)
22. Add `.nvmrc` and `engines` in `package.json`
23. Add PM2 ecosystem config
24. Switch `morgan('dev')` to `morgan('combined')` in production
25. Add circuit breaker (e.g., `opossum`) for internal HTTP calls
26. Use Docker Compose / Kubernetes for service discovery instead of hardcoded localhost

---

## Overall Score Breakdown

| Dimension | Score | Notes |
|-----------|-------|-------|
| Architecture design | 8/10 | Clean separation, good patterns |
| Code quality | 7/10 | Well-structured, readable, missing tests |
| Security | 4/10 | 3 critical, 5 high vulnerabilities |
| Feature completeness | 6/10 | Core done, payment/payout broken |
| Scalability | 6/10 | Good foundations, known bottlenecks |
| **Overall** | **6.5/10** | Fix critical bugs to reach 8/10 |
