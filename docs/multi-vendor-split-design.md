# Multi-Vendor Order Split — Design Doc

Status: **DESIGN — not built.** Review before implementation.
Scope: routing + offer + split layer. Does **not** touch the working phone-off FCM
siren, the lock-screen popup, or "Order from <name>" — those are done and reused as-is.

---

## 0. The headline finding: the engine already exists, dormant

The partial-cover, multi-vendor split model you described is **already implemented**
in `services/order/logic/orderSplitter.js` + `vendorRouter.js` — it's just **never
wired to real (COD) orders**, and the accept endpoint does whole-order instead of
feeding it.

`orderSplitter.js` (the coverage model):
- `initCoverageState(items)` → per-productId slot `{ needed, assigned, price, category, vendorAllocations[] }`.
- `applyVendorAcceptance(state, vendorId, acceptedItems)` → a vendor takes a **subset**;
  each item takes `min(quantity, remaining)`; records `vendorAllocations`; returns `allCovered`.
- `getUncoveredItems(state)` → productIds still open.
- `buildSubOrders(state, drop)` → **one sub-order per vendor**, grouped by allocations.

`vendorRouter.js`: `initiateRouting` (sets up coverage + Redis routing state),
`offerToBatch`, `handleVendorResponse` (cascade on all-responded), `recordVendorAcceptance`
(partial accept → coverage). `Order.model.subOrders` is already an **array** with
per-sub-order `vendorId`, `riderId`, `status`, timestamps; pickup OTPs are per-job in
the `DeliveryOtp` model. `assign-rider` is already called **per sub-order**.

**So ~70% of the backbone is present.** What's missing is the wiring + three genuinely
new behaviours (partial atomic accept, live-offer-updates, per-part timeout).

### What is NOT wired / NOT built (the delta)
| Piece | State today | Needed |
|---|---|---|
| COD placement uses the coverage engine | ❌ `placeOrder` uses its own single-vendor inline path (`eligibleVendors[0]`); `initiateRouting` is only called by `/internal/start-routing` (payment flow) + `resumeStuckOrders` | Route COD through the split engine |
| Accept feeds coverage | ❌ `vendorAcceptOrder` takes the **whole** order (one sub-order, all items); `recordVendorAcceptance` is imported but **never called** | Partial accept → `recordVendorAcceptance` |
| Per-item atomic claim | ❌ atomic claim (just built, commit af5ff73) is **whole-order** (`subOrders.0` absent) | Per-item-group atomic claim |
| Live offer updates | ❌ engine cascades to the *next batch* on all-responded; never live-updates *concurrent* vendors | Real-time re-offer of remaining items |
| Offer to ALL at once | ❌ batches of `BATCH_SIZE=3`, cascade batch-by-batch | Offer all relevant vendors simultaneously |
| Max-3-per-category cap | ❌ `fetchSortedVendors` returns *all* in-area category vendors; `BATCH_SIZE=3` is per-batch, not per-category | Cap 3 per category |
| Offer FCM siren | ❌ engine's `sendDataOnly` push is dead code (never runs for COD) | Reuse the proven siren push |
| Stand-down FCM | ❌ `job:cancelled`-style stand-down is socket-only (rider); vendor has none | FCM stand-down to filled/losing vendors |
| Multi-pickup tracking | ⚠ schema supports it; customer app renders single pickup | Render N pickups |

---

## 1. Cart → splits — the partitioning rule

Items are **not** pre-partitioned by category on the server. The split is **emergent
from which vendors accept which items** — the coverage model. Precisely:

1. **Eligibility (per order):** `fetchSortedVendors(customerLoc, requiredCategories, productIds)`
   — vendors that are `isOnline`, approved, active, within 5km (`$nearSphere`), whose
   `categories` intersect the order's categories, **and** hold live inventory
   (`isAvailable`) for ≥1 of the order's products. Sorted by distance.
2. **Per-category cap (NEW):** from that sorted list, keep at most **3 vendors per
   category** (a vendor covering multiple categories counts toward each). Union = the
   offer set.
3. **Coverage init:** `initCoverageState(order.items)` — every item starts `needed=qty, assigned=0`.
4. **Offer:** every vendor in the offer set is offered the **whole item list**, but with
   a per-vendor `inventoryContext` flagging which items they actually stock
   (`inStock:true/false`). A vendor accepts only the items they can supply (their
   in-stock subset) — see §4.
5. **Split = the vendorAllocations** that accumulate in `coverageState`. `buildSubOrders`
   turns them into one sub-order per accepting vendor.

So "3 veg + 5 fruit" is **not** hard-split into a veg-group and a fruit-group up front.
A veg-only vendor accepts the 3 veg (all it stocks); a multi-category vendor could
accept all 8; a fruit-only vendor accepts the 5 fruit. The **coverage state** is the
single source of truth for "who has what / what's still open."

**Decision needed:** category cap counts a multi-category vendor toward each of its
categories — confirm that's the intent (a veg+fruit vendor uses one of the 3 veg
slots *and* one of the 3 fruit slots).

---

## 2. The dormant engine — reuse vs delta

**Reuse (backbone):** `orderSplitter.js` coverage model + `recordVendorAcceptance` +
`buildSubOrders` + `getUncoveredItems`. This is exactly "first vendor covers what it
can, remaining stays open." It already handles multi-vendor allocation and produces
per-vendor sub-orders.

**Do NOT reuse `handleVendorResponse`'s batch-cascade as-is** — it's built for
"offer batch 1 → all respond → offer batch 2," which is the *sequential* model you're
replacing with *offer-all-at-once + live-update*. We keep the coverage state, drop the
batching.

**Delta to make it the launch feature:**
- **Wire COD → engine.** `placeOrder` currently does single-vendor inline. Two options
  (decide in Milestone 1):
  - (2a) Route COD through `initiateRouting` (adopt the Redis routing state) — unifies
    the two routing systems (this is the tracked "Path A" from the earlier cascade
    work); larger blast radius.
  - (2b) A new `initiateMultiVendorRouting` beside `placeOrder` that reuses
    `orderSplitter` but keeps COD state on the order doc (mirrors the single-vendor
    inline style). Smaller, no Redis-routing adoption, but a second engine to maintain.
  - **Recommendation:** (2a). We're already committing to the split model as the launch
    feature; maintaining two routing engines is the thing that has bitten us twice
    (dead reject-cascade, disconnected `recordVendorAcceptance`). Do it once, properly.
- **Accept becomes partial** (§4).
- **Add live-offer-update** on each partial accept (§3) — the engine has no equivalent.
- **All-at-once + per-category cap** (§1) instead of `BATCH_SIZE` batching.

---

## 3. Live offer updates — the genuinely new part

**State model:** the authoritative "what's still open" is `coverageState` in Redis
(`routingKey(orderId)`), updated atomically on each partial accept (§4). Derived view:
`openItems = getUncoveredItems(coverageState)`.

**Sync flow** when vendor A accepts the veg part:
1. Atomic coverage update (§4) → veg slots `assigned=needed`.
2. Compute `openItems` (now just the fruit part).
3. For every **still-offered, not-yet-fully-satisfied** vendor B:
   - **Socket** (app foreground): emit `order:offer-updated { orderId, openItems, inventoryContext }`
     → the in-app overlay re-renders to show only the fruit part ("veg already filled").
   - **FCM data push** (app backgrounded/killed): `sendDataOnly({ type:'ORDER_UPDATED',
     orderId, openItems })` → the app updates the stored incoming-order + popup, siren
     keeps ringing (there's still an open part for B).
   - If B stocked **only** veg (nothing left open for B) → B is **stood down** (§7):
     `ORDER_UPDATED` with empty openItems for B → app stops B's siren + clears its popup.
4. When `getUncoveredItems` is empty → order fully covered → `buildSubOrders` → create
   the sub-orders → stand down any vendor still ringing → each accepted vendor's
   sub-order proceeds to `assign-rider` (§ two riders).

**Per-vendor open view:** B's "open items" = `openItems ∩ B.inStock`. A fruit-only
vendor whose only items got filled is done; a multi-category vendor sees the residual.
This is a per-vendor projection of the shared coverage state — computed on each update,
not stored per vendor.

**Race note:** the coverage update (§4) must be the serialization point. Socket/FCM
updates are *derived* from the post-update state, so two accepts landing together each
produce a consistent "openItems" for the other.

---

## 4. Per-part accept + atomicity

The whole-order atomic claim (af5ff73) becomes a **per-item-group atomic claim**. Two
options:

- (4a) **Redis atomic on coverage** — `recordVendorAcceptance` runs inside a Redis
  transaction / Lua script (or optimistic `WATCH` on `routingKey`): read coverage →
  `applyVendorAcceptance` → if any of *this vendor's* accepted items still had
  `remaining>0`, commit; write back. Two vendors grabbing veg → the second sees
  `remaining=0` for veg and takes nothing. This is the natural fit — coverage already
  lives in Redis.
- (4b) **DB per-slot conditional** — model coverage on the order doc and use
  `findOneAndUpdate` with array-filter conditions per item. Heavier, and fights Mongo's
  lack of multi-field-array atomicity.

**Recommendation: (4a)**, with the coverage write as the single atomic step. The
sub-order for the vendor's *won* items is created from the committed allocation. The
existing whole-order guard (af5ff73) stays as the **degenerate case** — a single vendor
taking everything is just "all slots to one vendor" — so single-vendor orders keep
working through the same path.

**Accept endpoint change:** `vendorAcceptOrder` gains an `acceptedItems` input (defaults
to "all items I stock" from the vendor's `inventoryContext`) → `recordVendorAcceptance`
(atomic) → if it won ≥1 item, append/build its sub-order + trigger its rider; if it won
nothing (someone beat it to every item it stocked) → `409 "already taken."`

---

## 5. Per-part timeout + the failure rule

**Per-part window:** each **open item** carries its own deadline. Simplest correct
model: one `stageDeadline` per order reset whenever coverage *advances* (someone
accepts something) — but that lets a slow-but-progressing order run long. Cleaner:
track `openedAt` per coverage slot; a slot is "timed out" when `now - openedAt >
PER_PART_TTL` (45s). The sweep (keyed on this, not `createdAt`) evaluates open slots.

**The failure rule — decision needed. My recommendation: ALL-OR-NOTHING at launch.**
If **any** item-group is still open when its window closes → **fail the whole order**,
cancel, notify the customer "Some items couldn't be fulfilled — order cancelled, please
try again." Reasons:
- You dropped the "confirm reduced order" prompt, so there's no consented partial.
- Per-part fulfilment means partial delivery + partial charge/refund + a delivered
  order that's missing items — a lot of new money/state surface 2–3 weeks before launch.
- Any already-accepted vendor for that order must be **released** (their sub-order
  cancelled + stood down) — clean because nothing shipped yet.

Partial-fulfilment ("deliver what's available, refund the rest") is a **post-launch**
enhancement, tracked in §8. If you want per-part-fail-only instead, say so — it's a
bigger build (partial refunds, multi-outcome tracking).

---

## 6. Failure / termination — invariants

- **No double-claim:** the per-item atomic coverage update (§4) is the only place
  `assigned` increases; `min(quantity, remaining)` + atomic commit means an item can
  never be assigned beyond `needed`.
- **No infinite loop:** offer set is fixed at placement (all-at-once, capped). There is
  no re-fan-out to new vendors mid-flight in the launch scope — coverage only advances
  or times out. `respondedVendorIds`/rejected shrink the live set monotonically.
- **No half-accepted-forever:** the per-part sweep is the backstop. Either coverage
  completes → sub-orders built, or a part times out → all-or-nothing fail → order
  terminal. Redis routing state has a 3600s hard EX; `resumeStuckOrders` re-drives on
  restart.
- **Termination proof:** every path ends in one of {all covered → sub-orders created},
  {a part times out → order failed}, {no eligible vendors at placement → order failed}.
  No unbounded work.

---

## 7. FCM — offers + stand-downs (reusing the proven path)

- **Offer:** every vendor in the offer set gets the **working** data-only siren push
  `sendDataOnly({ type:'NEW_ORDER'/'INCOMING_ORDER', orderId, expiresAt, customerName,
  openItems })`. Same native siren + popup + "Order from <name>" — no changes to that
  layer.
- **Live update:** `sendDataOnly({ type:'ORDER_UPDATED', orderId, openItems })` when a
  part is filled but the vendor still has open items — app updates the popup, siren
  keeps ringing.
- **Stand-down (the part that must reach a backgrounded phone):** when a vendor has
  nothing left to win (all its stocked items filled, or the order completed/failed) →
  `sendDataOnly({ type:'ORDER_CANCELLED', orderId })` → the app's router hits
  `stopSiren()` (already built). This is the exact gap that exists on the rider side
  today (stand-down is socket-only). **Every stand-down goes over FCM, not just socket.**
- App router (`fcm-background.ts routeDataMessage`) gains `ORDER_UPDATED` (and, if we
  rename, `INCOMING_ORDER`) cases. `ORDER_CANCELLED` + `stopSiren` already exist.

---

## 8. What breaks / regressions to watch

The siren/popup/name layer is untouched, but the routing rewrite touches shared code:

1. **Single-vendor orders must keep working** — the common case (one nearby vendor with
   everything) must flow through the new engine as the degenerate "one vendor wins all
   slots" path. Regression test: place a 1-vendor-covers-all order → one sub-order,
   one rider, one pickup, exactly as today.
2. **The atomic accept (af5ff73)** — currently whole-order; it changes to per-item. The
   single-vendor path must still 409 a double-accept.
3. **Customer tracking** — moves from 1 pickup to N. `subOrders` is already an array,
   but the tracking screen + `order:status` events assume one sub-order/one rider in
   places. Audit every `subOrders[0]` reference (there are several) — they become loops.
4. **assign-rider / OTP** — already per-sub-order, but now fires N times per order.
   Watch: N riders, N pickup OTPs, N `DeliveryOtp` rows, N `assign-rider` calls; the
   vendor pickup-OTP display keys on `orderId` in places → must key on sub-order.
5. **Inventory deduct** — currently deducts the whole order for one vendor; becomes
   per-sub-order deduct for each vendor's won items.
6. **Coupons / totals / delivery fee** — one order, N sub-orders: delivery fee and
   coupon are order-level. Confirm the customer isn't charged N delivery fees; confirm
   refund-on-fail returns the whole order.
7. **The sweep** — changing its key from `createdAt` to per-part deadline affects the
   single-vendor timeout too. Verify a lone unanswered order still fails cleanly.
8. **The two-routing-systems split** — if we go (2a), `/internal/start-routing` (payment
   flow) and COD converge; verify the prepaid path still works.

---

## Rider model — ONE rider, multi-pickup (REVISED 2026-07-11)

**SUPERSEDES the earlier "two independent riders" decision.** A split order is
served by **ONE rider** who visits every vendor then the customer:

- **One DeliveryJob per ORDER** (not per sub-order), holding an **ordered list of
  pickup stops** (one per accepted vendor sub-order, each with its own vendorId +
  `pickupLocation` + its own **pickup OTP**) and one drop (the customer).
- **Route:** the rider goes to the vendor **closest to the rider first**, then the
  next-nearest, … then the customer. Ordering is greedy nearest-first, computed
  **when a rider accepts** (from that rider's location), since the rider isn't known
  until then. For 2 vendors it's just "closer vendor first."
- **When to assign:** only once **ALL** category-groups are claimed (all pickup
  points known). Until then the order sits in "finding_vendor / partially accepted."
  If a group never gets accepted → M3 all-or-nothing fail → no rider assigned.
- **One delivery fee** for the whole multi-pickup trip — this **fixes** the earlier
  economics flag (was: N rider fees for 1 collected fee). Optional small multi-pickup
  bonus is a pricing decision.
- **Per-vendor pickup OTP stays** — the rider collects from each vendor with that
  vendor's OTP (N pickup OTPs, one drop confirmation).

**This changes M0(c):** it currently fires `assign-rider` **per sub-order** (→ two
riders). Under this model, accept does NOT assign a rider directly; instead, on the
accept that completes coverage (all groups claimed), we fire **one** order-level
assign-rider with all pickup stops. That work lives in the new **MR** milestone below.

**New surface this touches:** `DeliveryJob` schema (single pickup → ordered pickup
array), `riderAssigner.js` (per-order job + nearest-first route on accept), the rider
app active-delivery UI (multi-stop: "Pickup 1 of 2 → Pickup 2 of 2 → Deliver", one
OTP per stop), and the pickup/`markPicked` flow (per-stop). Open decisions: multi-pickup
bonus? max pickups per rider? re-route if rider skips a stop?

---

## Milestone breakdown (each independently testable, shippable in order)

**MR — ONE rider, multi-pickup (delivery-layer; see "Rider model" above)**
- Assign one order-level DeliveryJob once all groups accepted; ordered pickup stops
  (nearest-vendor-to-rider first, finalized on rider accept); per-stop OTP; one fee.
- Rewire M0(c) so accept-completing-coverage triggers the single assignment (not
  per-sub-order). Rider app: multi-stop active-delivery.
- Test: 2-vendor order fully accepted → ONE rider offered → accepts → route visits the
  nearer vendor first, then the other, then the customer; two pickup OTPs, one drop.

**M0 — Foundations (no behaviour change)**
- Per-item atomic coverage claim in Redis (`recordVendorAcceptance` becomes atomic).
- Keep single-vendor whole-order path working through it (degenerate case).
- Test: unit — two concurrent partial accepts on overlapping items → each wins disjoint,
  never over-assigned.

**M1 — Wire COD into the split engine (offer-all-at-once, no live-update yet)**
- `placeOrder` (COD) → `initiateRouting` (decision 2a) with per-category-3 cap +
  offer-all-at-once + the working FCM siren push to every offered vendor.
- Accept = partial (vendor's in-stock subset) → coverage → build sub-order(s) when
  fully covered.
- Test: 2 seeded vendors, split order (veg vendor + fruit vendor) → both accept → two
  sub-orders, two riders, one order completes. Single-vendor order still one sub-order.

**M2 — Live offer updates**
- On each partial accept: recompute openItems → socket `order:offer-updated` + FCM
  `ORDER_UPDATED` to still-open vendors; stand-down (`ORDER_CANCELLED` over FCM) to
  vendors with nothing left.
- App: `routeDataMessage` handles `ORDER_UPDATED`; overlay/popup re-render open items.
- Test (the one you want proven): vendor A (backgrounded, siren ringing) is a veg-only
  vendor; vendor B takes veg first → A gets FCM stand-down → **A's siren stops on the
  backgrounded phone.**

**M3 — Per-part timeout + all-or-nothing failure**
- Per-part deadline; sweep keyed on it; any open part at window close → whole order
  fails, release accepted sub-orders, notify customer.
- Test: 2-part order, only 1 part accepted, other times out → whole order cancelled,
  accepted vendor released + stood down, customer told "some items unavailable."

**M4 — Customer multi-pickup tracking**
- Tracking renders N pickups / N riders; audit `subOrders[0]` assumptions.
- Test: split order in flight → customer sees both pickup points + both riders.

**M5 — Remove auto-offline-on-disconnect (the earlier decision, now safe under the new engine)**
- Only the Go-Offline toggle flips `isOnline`; the per-part sweep + all-or-nothing is
  the backstop for a genuinely-dead vendor.
- Test: backgrounded vendor stays online, gets offered + FCM siren; dead vendor's part
  times out → order fails cleanly (no black hole).

**Post-launch (tracked, not in scope):** partial-fulfilment (deliver+refund per part);
single-rider multi-pickup batching; revisit stock policy 1a→1b with real data;
finish unifying the two routing systems if we chose (2b).

---

## Open decisions for you before M0
1. **2a vs 2b** — unify onto `initiateRouting` (recommended) or a parallel COD engine.
2. **Failure rule** — all-or-nothing (recommended) vs per-part-fail-only (bigger build).
3. **Category-cap semantics** — does a multi-category vendor consume a slot in *each*
   category (recommended) or count once?
4. **Per-part TTL** — 45s (matches the vendor window we set) confirmed?
