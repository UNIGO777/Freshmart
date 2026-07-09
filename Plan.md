# ZipBasket — Backend Architecture & Development Plan

> **Stack:** Node.js + Express · MongoDB · Socket.io · Redis · Firebase FCM · PhonePe PG · Google Maps API  
> **Architecture:** Microservices (service-based, single codebase, one deployment per service)  
> **Serves:** Customer Mobile App · Vendor Mobile App · Delivery Mobile App · Admin Web Panel

---

## Architecture Overview

All services share one MongoDB cluster and one Redis instance. They communicate via an internal API Gateway that routes requests from all clients (mobile + web) to the correct service. No service is exposed directly to the internet — everything goes through the gateway.

```
┌─────────────────────────────────────────────────────────┐
│                     CLIENTS                              │
│  Customer App  │  Vendor App  │  Rider App  │  Admin Web │
└────────────────────────┬────────────────────────────────┘
                         │ HTTPS
                ┌────────▼────────┐
                │   API Gateway   │  (Express + rate limit + auth verify)
                └────────┬────────┘
        ┌────────────────┼─────────────────┐
        │                │                 │
   ┌────▼────┐    ┌──────▼──────┐   ┌──────▼──────┐
   │  Auth   │    │   Order     │   │   Product   │
   │ Service │    │  Service    │   │   Service   │
   └─────────┘    └─────────────┘   └─────────────┘
        │                │                 │
   ┌────▼────┐    ┌──────▼──────┐   ┌──────▼──────┐
   │  User   │    │  Delivery   │   │  Notif.     │
   │ Service │    │  Service    │   │  Service    │
   └─────────┘    └─────────────┘   └─────────────┘
        │                │                 │
   ┌────▼────┐    ┌──────▼──────┐   ┌──────▼──────┐
   │ Payment │    │  Vendor     │   │  Admin      │
   │ Service │    │  Service    │   │  Service    │
   └─────────┘    └─────────────┘   └─────────────┘
                         │
                ┌────────▼────────┐
                │  Socket Server  │  (Real-time: tracking, order status)
                └─────────────────┘
                         │
          ┌──────────────┼──────────────┐
     ┌────▼────┐   ┌─────▼─────┐  ┌────▼────┐
     │ MongoDB │   │   Redis   │  │Firebase │
     │ Cluster │   │  Cache    │  │  FCM    │
     └─────────┘   └───────────┘  └─────────┘
```

---

## Services Directory

| Service | Port | Responsibility | Key Tech |
|---|---|---|---|
| **API Gateway** | 3000 | Route, rate-limit, JWT verify | Express, express-rate-limit |
| **Auth Service** | 3001 | OTP, email, Google, Apple login | FastToSms, Firebase Auth, JWT |
| **User Service** | 3002 | Customer / vendor / rider profiles, addresses | Mongoose |
| **Product Service** | 3003 | Products, categories, daily pricing, availability | Mongoose, Redis |
| **Order Service** | 3004 | Order lifecycle, smart routing, splitting logic | Mongoose, Redis, Socket.io |
| **Vendor Service** | 3005 | Vendor inventory, stock, earnings | Mongoose |
| **Delivery Service** | 3006 | Rider assignment, 30s window, live location | Socket.io, Google Maps |
| **Payment Service** | 3007 | PhonePe UPI, COD, refunds, payouts | PhonePe PG API, crypto |
| **Notification Service** | 3008 | Push (FCM), order alerts, promo pushes | Firebase FCM |
| **Admin Service** | 3009 | Dashboard, analytics, reports, coupon mgmt | Mongoose, aggregations |
| **Socket Server** | 3010 | Real-time: order tracking, rider location | Socket.io |

---

## Folder Structure

```
zipbasket-backend/
├── gateway/                  # API Gateway
│   ├── index.js
│   ├── middleware/
│   │   ├── auth.middleware.js
│   │   ├── rateLimiter.js
│   │   └── roleGuard.js
│   └── routes/
│       └── proxy.routes.js
│
├── services/
│   ├── auth/
│   │   ├── index.js
│   │   ├── controllers/
│   │   │   ├── otp.controller.js
│   │   │   ├── email.controller.js
│   │   │   └── social.controller.js
│   │   ├── routes/auth.routes.js
│   │   └── models/OtpSession.model.js
│   │
│   ├── user/
│   │   ├── index.js
│   │   ├── controllers/user.controller.js
│   │   ├── routes/user.routes.js
│   │   └── models/
│   │       ├── Customer.model.js
│   │       ├── Vendor.model.js
│   │       └── Rider.model.js
│   │
│   ├── product/
│   │   ├── index.js
│   │   ├── controllers/product.controller.js
│   │   ├── routes/product.routes.js
│   │   └── models/
│   │       ├── Product.model.js
│   │       └── Category.model.js
│   │
│   ├── order/
│   │   ├── index.js
│   │   ├── controllers/order.controller.js
│   │   ├── routes/order.routes.js
│   │   ├── logic/
│   │   │   ├── vendorRouter.js       # Smart vendor routing logic
│   │   │   ├── orderSplitter.js      # Split order across vendors
│   │   │   └── stockChecker.js       # Pre-payment stock validation
│   │   └── models/Order.model.js
│   │
│   ├── vendor/
│   │   ├── index.js
│   │   ├── controllers/vendor.controller.js
│   │   ├── routes/vendor.routes.js
│   │   └── models/
│   │       ├── Inventory.model.js
│   │       └── VendorEarning.model.js
│   │
│   ├── delivery/
│   │   ├── index.js
│   │   ├── controllers/delivery.controller.js
│   │   ├── routes/delivery.routes.js
│   │   ├── logic/
│   │   │   ├── riderAssigner.js      # 30s window + cascade logic
│   │   │   └── nearbyFinder.js       # Geo query for nearby riders
│   │   └── models/
│   │       ├── DeliveryJob.model.js
│   │       └── RiderLocation.model.js
│   │
│   ├── payment/
│   │   ├── index.js
│   │   ├── controllers/payment.controller.js
│   │   ├── routes/payment.routes.js
│   │   └── models/Transaction.model.js
│   │
│   ├── notification/
│   │   ├── index.js
│   │   ├── controllers/notification.controller.js
│   │   └── helpers/
│   │       ├── fcm.helper.js
│   │       └── templates.js
│   │
│   ├── admin/
│   │   ├── index.js
│   │   ├── controllers/
│   │   │   ├── dashboard.controller.js
│   │   │   ├── coupon.controller.js
│   │   │   ├── pricing.controller.js
│   │   │   └── payout.controller.js
│   │   └── routes/admin.routes.js
│   │
│   └── socket/
│       ├── index.js
│       ├── handlers/
│       │   ├── orderTracking.handler.js
│       │   └── riderLocation.handler.js
│       └── rooms.js
│
├── shared/
│   ├── db/
│   │   ├── mongoose.js               # Shared DB connection
│   │   └── redis.js                  # Shared Redis client
│   ├── utils/
│   │   ├── jwt.util.js
│   │   ├── response.util.js
│   │   ├── geoDistance.util.js
│   │   └── logger.js
│   └── constants/
│       ├── roles.js                  # CUSTOMER, VENDOR, RIDER, ADMIN
│       ├── orderStatus.js
│       └── errorCodes.js
│
├── .env
├── .env.example
├── docker-compose.yml
└── package.json
```

---

## Database Models (MongoDB)

### Customer
```js
{
  _id, name, phone, email,
  authProviders: ['phone', 'google', 'apple'],
  addresses: [{ label, lat, lng, fullAddress }],
  language: 'hi' | 'en',
  fcmToken, isActive, createdAt
}
```

### Vendor
```js
{
  _id, businessName, ownerName, phone, email,
  location: { type: 'Point', coordinates: [lng, lat] },
  serviceRadiusKm: 5,
  categories: ['fruits', 'vegetables', 'spices'],
  isApproved, isActive, fcmToken,
  bankDetails: { accountNo, ifsc, upiId },
  commissionPercent, createdAt
}
```

### Rider
```js
{
  _id, name, phone,
  currentLocation: { type: 'Point', coordinates: [lng, lat] },
  isOnline, isOnDelivery,
  fcmToken, vehicleType,
  earnings: { today, thisWeek, total },
  rating: { average, count }, createdAt
}
```

### Product
```js
{
  _id, name, nameHi,
  category: 'fruits' | 'vegetables' | 'spices',
  unit: 'kg' | 'g' | 'piece' | 'dozen',
  image,
  buyingPrice,      // Admin sets — visible to vendor
  sellingPrice,     // Admin sets — visible to customer
  isAvailableToday: true,   // Admin toggles daily
  updatedAt         // Carries forward from yesterday if not changed
}
```

### Inventory (per Vendor)
```js
{
  _id, vendorId, productId,
  quantityAvailable,
  isAvailable: true,
  updatedAt
}
```

### Order
```js
{
  _id, customerId,
  items: [{ productId, quantity, sellingPrice }],
  subOrders: [
    {
      vendorId,
      items: [{ productId, quantity }],
      riderId,
      status: 'pending' | 'vendor_accepted' | 'rider_assigned' |
              'picked' | 'delivered',
      pickupLocation, dropLocation
    }
  ],
  deliveryAddress: { lat, lng, fullAddress },
  paymentMethod: 'upi' | 'cod',
  paymentStatus: 'pending' | 'paid' | 'failed',
  couponCode, discountAmount,
  deliveryFee,    // Distance-based
  totalAmount,
  status: 'stock_check' | 'awaiting_payment' | 'confirmed' |
          'partially_delivered' | 'delivered' | 'failed',
  ratings: { product, rider },
  createdAt
}
```

### Transaction
```js
{
  _id, orderId, customerId,
  merchantTransactionId,     // Our internal ID sent to PhonePe
  phonepeTransactionId,      // PhonePe's transaction ID (filled on success)
  amount,                    // In paise (₹1 = 100)
  method: 'upi' | 'cod',
  status: 'created' | 'paid' | 'refunded' | 'failed',
  callbackPayload,           // Raw PhonePe callback snapshot
  refundTransactionId,
  refundedAt,
  createdAt
}
```

### Coupon
```js
{
  _id, code, discountType: 'flat' | 'percent',
  discountValue, minOrderValue,
  maxUses, usedCount,
  validFrom, validTo, isActive
}
```

---

## Smart Order Routing Logic

```
Customer places order
        │
        ▼
[1] stockChecker.js — query all vendors within 5km radius
    who have at least one full category matching the order
        │
        ├── No vendors found? → Return "Not serviceable" (no payment shown)
        │
        ▼
[2] Show payment options to customer (UPI / COD)
        │
        ▼
[3] vendorRouter.js — send order to nearest 3 vendors
    Each vendor sees: items in their category + buying price
        │
        ├── Vendor accepts partial/full items
        ├── 3 nearest don't cover all items?
        │       → orderSplitter.js splits to multiple vendors
        ├── Still uncovered? → escalate to next 3 farther vendors
        └── Still fails? → Order marked FAILED, payment not charged
        │
        ▼
[4] Order confirmed — payment processed
        │
        ▼
[5] riderAssigner.js — find 3 nearest online riders to vendor
    Send request simultaneously, 30s acceptance window
        │
        ├── First accept → assigned
        └── No accept in 30s → next 3 riders
```

---

## API Endpoints Reference

### Auth Service `/api/auth`
| Method | Endpoint | Description |
|---|---|---|
| POST | `/send-otp` | Send OTP to phone number |
| POST | `/verify-otp` | Verify OTP, return JWT |
| POST | `/login-email` | Email + password login |
| POST | `/register-email` | Email + password register |
| POST | `/google` | Google OAuth login |
| POST | `/apple` | Apple Sign-In |
| POST | `/refresh` | Refresh JWT token |
| POST | `/logout` | Invalidate refresh token |

### Product Service `/api/products`
| Method | Endpoint | Description |
|---|---|---|
| GET | `/` | All available products today (with category filter) |
| GET | `/categories` | List all categories (fruits/veg/spices) |
| GET | `/:id` | Single product detail |
| POST | `/` | Admin: add new product |
| PUT | `/:id` | Admin: update price or availability |
| PATCH | `/:id/toggle` | Admin: toggle availability today |
| PUT | `/bulk-prices` | Admin: bulk update prices |

### Order Service `/api/orders`
| Method | Endpoint | Description |
|---|---|---|
| POST | `/check-stock` | Pre-payment stock check |
| POST | `/` | Place order (after payment) |
| GET | `/` | Customer: order history |
| GET | `/:id` | Order detail + sub-order status |
| PATCH | `/:id/cancel` | Cancel order (if not picked) |
| POST | `/:id/rate` | Rate product + rider |
| GET | `/vendor/incoming` | Vendor: incoming order requests |
| PATCH | `/vendor/:id/accept` | Vendor: accept with item selection |
| PATCH | `/vendor/:id/reject` | Vendor: reject order |

### Delivery Service `/api/delivery`
| Method | Endpoint | Description |
|---|---|---|
| PATCH | `/rider/status` | Toggle online/offline |
| GET | `/rider/orders` | Rider: current + pending jobs |
| PATCH | `/rider/accept/:jobId` | Accept delivery job (30s window) |
| PATCH | `/rider/pickup/:jobId` | Mark as picked up |
| PATCH | `/rider/deliver/:jobId` | Mark as delivered |
| POST | `/rider/location` | Update live location (every 5s) |
| GET | `/rider/earnings` | Rider earnings summary |

### Payment Service `/api/payments`
| Method | Endpoint | Description |
|---|---|---|
| POST | `/create-order` | Initiate PhonePe UPI payment, returns paymentUrl |
| POST | `/callback` | PhonePe server-to-server payment callback (webhook) |
| GET | `/status/:merchantTransactionId` | Poll payment status from PhonePe |
| POST | `/cod-confirm` | Confirm COD order |
| POST | `/refund/:transactionId` | Admin: initiate PhonePe refund |
| GET | `/vendor/payouts` | Admin: vendor payout list |
| POST | `/vendor/payout/:vendorId` | Admin: trigger vendor payout |

### Admin Service `/api/admin`
| Method | Endpoint | Description |
|---|---|---|
| GET | `/dashboard` | Key metrics (orders, revenue, users) |
| GET | `/vendors` | List all vendors |
| PATCH | `/vendors/:id/approve` | Approve vendor |
| PATCH | `/vendors/:id/block` | Block vendor |
| GET | `/riders` | List all riders |
| PATCH | `/riders/:id/approve` | Approve rider |
| GET | `/customers` | List all customers |
| GET | `/orders` | All orders with filters |
| GET | `/analytics` | Revenue, orders, top products |
| POST | `/coupons` | Create coupon |
| GET | `/coupons` | List coupons |
| PATCH | `/coupons/:id` | Update/disable coupon |

---

## Socket Events (Real-time)

### Customer receives:
| Event | Payload | When |
|---|---|---|
| `order:status` | `{ orderId, status, subOrderId }` | Every status change |
| `rider:location` | `{ lat, lng, riderId }` | Every 5 seconds while in delivery |
| `order:confirmed` | `{ orderId }` | After vendor accepts + payment |
| `order:failed` | `{ reason }` | No vendor/stock found |

### Rider receives:
| Event | Payload | When |
|---|---|---|
| `job:request` | `{ jobId, pickupAddress, dropAddress, items }` | New delivery assigned |
| `job:expired` | `{ jobId }` | 30s window expired |
| `job:cancelled` | `{ jobId }` | Order cancelled |

### Vendor receives:
| Event | Payload | When |
|---|---|---|
| `order:incoming` | `{ orderId, items, buyingCost }` | New order routed to vendor |
| `order:timeout` | `{ orderId }` | Order rerouted away |

---

## Environment Variables

```env
# App
NODE_ENV=development
PORT_GATEWAY=3000

# Service Ports
PORT_AUTH=3001
PORT_USER=3002
PORT_PRODUCT=3003
PORT_ORDER=3004
PORT_VENDOR=3005
PORT_DELIVERY=3006
PORT_PAYMENT=3007
PORT_NOTIFICATION=3008
PORT_ADMIN=3009
PORT_SOCKET=3010

# Database
MONGO_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/freshmart
REDIS_URL=redis://localhost:6379

# Auth
JWT_SECRET=your_jwt_secret
JWT_REFRESH_SECRET=your_refresh_secret
JWT_EXPIRY=15m
JWT_REFRESH_EXPIRY=30d

# OTP
FastToSms_ACCOUNT_SID=
FastToSms_AUTH_TOKEN=
FastToSms_PHONE=

# Social Auth
GOOGLE_CLIENT_ID=
APPLE_CLIENT_ID=

# Payments (PhonePe)
PHONEPE_MERCHANT_ID=
PHONEPE_SALT_KEY=
PHONEPE_SALT_INDEX=1
PHONEPE_BASE_URL=https://api-preprod.phonepe.com/apis/pg-sandbox

# Firebase
FIREBASE_PROJECT_ID=
FIREBASE_PRIVATE_KEY=
FIREBASE_CLIENT_EMAIL=

# Maps
GOOGLE_MAPS_API_KEY=

# Delivery
VENDOR_SEARCH_RADIUS_KM=5
RIDER_ASSIGNMENT_TIMEOUT_SEC=30
MAX_VENDOR_ATTEMPTS=3
```

---

## Development Phases

---

### Phase 1 — Foundation & Auth
**Duration: 4–5 days**

| Task | Description | Days |
|---|---|---|
| Project scaffold | Init monorepo, folder structure, Docker Compose, shared DB + Redis connections | 1 |
| API Gateway | Express proxy, JWT middleware, role guard, rate limiter | 1 |
| Auth Service | Phone OTP (FastToSms), Email/password, JWT issue + refresh | 1.5 |
| Social Auth | Google OAuth + Apple Sign-In integration | 1 |
| User models | Customer, Vendor, Rider Mongoose schemas | 0.5 |

**Deliverable:** Any role can register, log in via any method, and get a valid JWT. Gateway verifies the token on all routes.

---

### Phase 2 — Products & Admin Pricing
**Duration: 3–4 days**

| Task | Description | Days |
|---|---|---|
| Product Service | Product + Category models, CRUD APIs | 1 |
| Admin pricing | Buying price vs selling price, daily availability toggle | 0.5 |
| Carry-forward logic | If admin doesn't update today, prices + availability stay from yesterday | 0.5 |
| Category tabs API | Filter products by Fruits / Vegetables / Spices | 0.5 |
| Redis caching | Cache today's product list, invalidate on admin update | 0.5 |
| Vendor inventory | Vendor sets stock quantity per product | 1 |

**Deliverable:** Admin can manage all products and prices. Customers and vendors can query today's catalogue.

---

### Phase 3 — Smart Order Routing (Core Logic)
**Duration: 6–7 days**

| Task | Description | Days |
|---|---|---|
| Stock checker | Pre-payment geo query — find vendors within 5km with matching categories | 1.5 |
| Vendor router | Send order to nearest 3 vendors, manage accept/reject with item selection | 2 |
| Order splitter | If items split across vendors, create sub-orders per vendor | 1.5 |
| Cascade logic | Escalate to farther vendors if nearby 3 can't cover all items | 1 |
| Order fail handler | Gracefully fail before payment if no vendor can fulfill | 0.5 |
| Order model + APIs | Full Order schema, place order, get order, order history | 0.5 |

**Deliverable:** Full smart order routing working end-to-end before any payment is processed.

---

### Phase 4 — Payments
**Duration: 3 days**

| Task | Description | Days |
|---|---|---|
| PhonePe integration | Initiate payment, build checksum, return paymentUrl to client | 1 |
| Callback & status check | Verify PhonePe server-to-server callback checksum, poll status API | 0.5 |
| COD flow | Confirm COD order, mark as pending collection | 0.5 |
| Coupon engine | Validate coupon code, apply discount at checkout | 0.5 |
| Refund API | Admin-triggered refund via PhonePe refund API | 0.5 |

**Deliverable:** Customers can pay via UPI or COD. Coupons apply at checkout. Admin can issue refunds.

---

### Phase 5 — Delivery Assignment & Live Tracking
**Duration: 5–6 days**

| Task | Description | Days |
|---|---|---|
| Rider location updates | Rider app sends location every 5s via Socket.io | 1 |
| Nearby rider finder | Geo query for 3 nearest online riders to vendor | 1 |
| 30s assignment window | Emit job:request to 3 riders, set Redis TTL, cascade if expired | 1.5 |
| Delivery status updates | picked → delivered status chain, emit to customer | 1 |
| Live tracking to customer | Stream rider lat/lng to customer via Socket.io room | 1 |
| Rider earnings | Calculate per-delivery earnings, daily/weekly summary | 0.5 |

**Deliverable:** Orders auto-assign to nearest rider, customer sees live map tracking, rider sees navigation details.

---

### Phase 6 — Notifications
**Duration: 2 days**

| Task | Description | Days |
|---|---|---|
| FCM setup | Firebase Admin SDK, FCM token storage per user | 0.5 |
| Order notifications | Push on: confirmed, picked, delivered, failed | 0.5 |
| Vendor notifications | Push on: new order incoming, order rerouted | 0.5 |
| Promo notifications | Admin triggers bulk push for offers | 0.5 |

**Deliverable:** All roles get push notifications for all relevant events.

---

### Phase 7 — Admin Service & Analytics
**Duration: 4 days**

| Task | Description | Days |
|---|---|---|
| Dashboard API | Live counts: orders today, revenue today, active riders, active vendors | 1 |
| Vendor management | Approve/block vendors, view vendor details + earnings | 0.5 |
| Rider management | Approve/block riders, view rider details + earnings | 0.5 |
| Order management | All orders with status filter, manual override | 0.5 |
| Analytics & reports | Revenue by day/week/month, top products, top vendors | 1 |
| Payout management | Calculate vendor payouts (selling price - buying price - commission), trigger transfer | 0.5 |

**Deliverable:** Admin web panel has full operational control over the entire platform.

---

### Phase 8 — Ratings, Language & Polish ✅
**Duration: 2–3 days**

| Task | Description | Status |
|---|---|---|
| Ratings system | Customer rates product (1–5) and rider (1–5) after delivery. Rider average updated atomically via aggregation pipeline. | ✅ Done |
| Hindi support | `nameHi` on Product + Category. `langMiddleware` reads `?lang` / `Accept-Language`. `localiseProducts()` swaps name. | ✅ Done |
| Error handling | Global `(err, req, res, next)` handler + structured 404 handler in all 10 services. | ✅ Done |
| Logging | Winston logger (`shared/utils/logger.js`) + Morgan request logs (`dev` format) across all services. | ✅ Done |
| Security | Helmet, CORS, `express.json({ limit: '10kb' })`, Zod validation, rate limiter at gateway. | ✅ Done |
| API documentation | Postman Collection v2.1 — 60+ requests across 9 folders with pre-request scripts, variable auto-capture, and inline docs. | ✅ Done |

**Deliverable:** Production-ready, secure, documented backend. 🎉

---

## Timeline Summary

| Phase | Focus | Days |
|---|---|---|
| Phase 1 | Foundation & Auth | 4–5 |
| Phase 2 | Products & Pricing | 3–4 |
| Phase 3 | Smart Order Routing | 6–7 |
| Phase 4 | Payments | 3 |
| Phase 5 | Delivery & Tracking | 5–6 |
| Phase 6 | Notifications | 2 |
| Phase 7 | Admin & Analytics | 4 |
| Phase 8 | Ratings, Language & Polish | 2–3 |
| **Total** | | **29–34 days** |

---

## Third-Party Services Required

| Service | Purpose | Cost |
|---|---|---|
| **FastToSms** | OTP SMS delivery | Pay per SMS (~₹0.15/SMS) |
| **Firebase** | Google Auth + Push Notifications (FCM) | Free tier generous |
| **phonepay** | UPI payments, payouts | 2% per transaction |
| **Google Maps API** | Geocoding, distance matrix, live map | Pay per API call |
| **MongoDB Atlas** | Cloud database | From ₹0 (M0 free) → paid as needed |
| **Redis Cloud** | Caching, session, TTL for rider assignment | Free tier available |

---

*Document version 1.0 · ZipBasket Backend Plan · May 2026*