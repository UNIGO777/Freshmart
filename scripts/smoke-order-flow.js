#!/usr/bin/env node
/**
 * FreshMart — Order-flow smoke test
 * ---------------------------------
 * Exercises the customer happy path end-to-end against a RUNNING API gateway:
 *
 *   health → register → send-otp → verify-otp → /users/me →
 *   list products → check-stock → place order (COD) → cod-confirm →
 *   fetch order → cancel → logout
 *
 * It also runs a NEGATIVE contract check (the exact payload shape the web
 * client used to send) to prove the backend now rejects it with 400 — this is
 * the regression guard for the v0.3.0 contract fix.
 *
 * This is a SMOKE test, not a unit test: it needs the gateway + all services +
 * MongoDB + Redis running, and ideally seeded data (`node seed.js`). When seed
 * data is incomplete (e.g. no vendors/inventory near the test address), order
 * placement is reported as a WARN/SKIP rather than a hard failure — the
 * critical assertion is only that the corrected payloads are ACCEPTED (no
 * validation error), not that a vendor happens to be available.
 *
 * Usage:
 *   node scripts/smoke-order-flow.js
 *   GATEWAY_URL=http://localhost:3000 node scripts/smoke-order-flow.js
 *
 * Env (all optional):
 *   GATEWAY_URL   default http://localhost:3000
 *   TEST_PHONE    default 9100000007   (a throwaway 10-digit number)
 *   TEST_EMAIL    default smoke+<phone>@freshmart.test
 *   TEST_LAT      default 28.6139      (New Delhi)
 *   TEST_LNG      default 77.2090
 *
 * Exit code: 0 if no hard failures, 1 otherwise.
 */

const GATEWAY_URL = (process.env.GATEWAY_URL || 'http://localhost:3000').replace(/\/$/, '');
const PHONE = process.env.TEST_PHONE || '9100000007';
const EMAIL = process.env.TEST_EMAIL || `smoke+${PHONE}@freshmart.test`;
const LAT = Number(process.env.TEST_LAT || 28.6139);
const LNG = Number(process.env.TEST_LNG || 77.2090);

// ── tiny console helpers ──────────────────────────────────────────
const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m' };
const counts = { pass: 0, fail: 0, warn: 0, skip: 0 };
const pass = (m) => { counts.pass++; console.log(`${C.green}  ✓ PASS${C.reset} ${m}`); };
const fail = (m, extra) => { counts.fail++; console.log(`${C.red}  ✗ FAIL${C.reset} ${m}${extra ? `\n${C.dim}        ${extra}${C.reset}` : ''}`); };
const warn = (m) => { counts.warn++; console.log(`${C.yellow}  ! WARN${C.reset} ${m}`); };
const skip = (m) => { counts.skip++; console.log(`${C.dim}  – SKIP ${m}${C.reset}`); };
const step = (m) => console.log(`\n${C.cyan}▸ ${m}${C.reset}`);

/** Perform a request and return { status, body, ok }. Never throws on HTTP errors. */
async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res, json;
  try {
    res = await fetch(`${GATEWAY_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return { status: 0, body: null, ok: false, networkError: err.message };
  }
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json, ok: res.ok };
}

/** Unwrap the backend's { success, message, data } envelope. */
const data = (r) => (r.body && typeof r.body === 'object' && 'data' in r.body ? r.body.data : r.body);

async function main() {
  console.log(`${C.cyan}FreshMart order-flow smoke test${C.reset}`);
  console.log(`${C.dim}gateway=${GATEWAY_URL}  phone=${PHONE}  coords=${LAT},${LNG}${C.reset}`);

  // ── 1. Gateway health ───────────────────────────────────────────
  step('Gateway health');
  const health = await call('GET', '/health');
  if (health.networkError) {
    fail(`gateway unreachable at ${GATEWAY_URL}`, health.networkError);
    console.log(`\n${C.red}Is the backend running? Try: npm run dev${C.reset}`);
    return finish();
  }
  health.status === 200 && health.body?.success
    ? pass('GET /health → 200')
    : fail(`GET /health → ${health.status}`, JSON.stringify(health.body));

  // ── 2. Register (idempotent: 201 new, or 409 already exists) ─────
  step('Register customer');
  const reg = await call('POST', '/api/auth/register', {
    body: { name: 'Smoke Test', email: EMAIL, confirmEmail: EMAIL, phone: PHONE },
  });
  if (reg.status === 201) pass('POST /api/auth/register → 201 (new account)');
  else if (reg.status === 409) pass('POST /api/auth/register → 409 (already exists, OK for re-runs)');
  else fail(`POST /api/auth/register → ${reg.status}`, JSON.stringify(reg.body));

  // ── 3. Send OTP (dev mode returns devOtp) ───────────────────────
  step('Request OTP');
  const send = await call('POST', '/api/auth/send-otp', { body: { phone: PHONE } });
  if (send.status !== 200) {
    fail(`POST /api/auth/send-otp → ${send.status}`, JSON.stringify(send.body));
    return finish();
  }
  pass('POST /api/auth/send-otp → 200');
  const devOtp = data(send)?.devOtp;
  if (!devOtp) {
    warn('no devOtp in response — server is in production/SMS mode; cannot complete auth-gated steps');
    skip('verify-otp, profile, order flow, logout (no OTP available)');
    return finish();
  }

  // ── 4. Verify OTP → tokens ──────────────────────────────────────
  step('Verify OTP');
  const verify = await call('POST', '/api/auth/verify-otp', { body: { phone: PHONE, otp: devOtp } });
  const auth = data(verify);
  const token = auth?.accessToken;
  const refreshToken = auth?.refreshToken;
  if (verify.status === 200 && token) pass('POST /api/auth/verify-otp → 200 + accessToken');
  else { fail(`POST /api/auth/verify-otp → ${verify.status}`, JSON.stringify(verify.body)); return finish(); }

  // ── 5. Authenticated profile ────────────────────────────────────
  step('Fetch profile');
  const me = await call('GET', '/api/users/me', { token });
  me.status === 200 ? pass('GET /api/users/me → 200 (token accepted)')
                    : fail(`GET /api/users/me → ${me.status}`, JSON.stringify(me.body));

  // ── 6. Product catalog ──────────────────────────────────────────
  step('List products');
  const prods = await call('GET', '/api/products?limit=5', { token });
  const list = (() => { const d = data(prods); return Array.isArray(d) ? d : (d?.products || d?.items || []); })();
  let productId = null;
  if (prods.status === 200 && list.length) {
    productId = list[0]._id || list[0].id;
    pass(`GET /api/products → 200 (${list.length} products, using ${productId})`);
  } else if (prods.status === 200) {
    warn('product list empty — run `node seed.js` to seed the catalog');
  } else {
    fail(`GET /api/products → ${prods.status}`, JSON.stringify(prods.body));
  }

  // ── 7. NEGATIVE contract check (the OLD broken web payload) ─────
  // Old web client sent { items:[{productId, qty}] } with NO deliveryAddress.
  // The backend MUST reject this with 400 — this guards the v0.3.0 fix.
  step('Negative contract check (legacy payload must be rejected)');
  if (productId) {
    const bad = await call('POST', '/api/orders/check-stock', {
      token,
      body: { items: [{ productId, qty: 1 }] }, // wrong: `qty`, no deliveryAddress
    });
    bad.status === 400
      ? pass('check-stock rejects legacy {qty, no deliveryAddress} payload → 400')
      : fail(`legacy payload not rejected (got ${bad.status}) — contract guard failed`, JSON.stringify(bad.body));
  } else {
    skip('negative contract check (no product to reference)');
  }

  // ── 8. check-stock with the CORRECT payload ─────────────────────
  step('Check stock (corrected contract)');
  const deliveryAddress = { lat: LAT, lng: LNG, fullAddress: 'Smoke Test Address, New Delhi' };
  let serviceable = false;
  if (productId) {
    const stock = await call('POST', '/api/orders/check-stock', {
      token,
      body: { items: [{ productId, quantity: 1 }], deliveryAddress },
    });
    if (stock.status === 200 && data(stock) && typeof data(stock).serviceable === 'boolean') {
      serviceable = data(stock).serviceable;
      pass(`check-stock accepted corrected payload → 200 (serviceable=${serviceable})`);
      if (!serviceable) warn(`area not serviceable: ${data(stock).reason || 'no vendors near test coords'} — seed vendors/inventory to exercise placement`);
    } else if (stock.status === 400 && stock.body?.errorCode === 'VALIDATION_ERROR') {
      fail('check-stock rejected the CORRECTED payload with VALIDATION_ERROR — contract regression!', JSON.stringify(stock.body));
    } else {
      fail(`POST /api/orders/check-stock → ${stock.status}`, JSON.stringify(stock.body));
    }
  } else {
    skip('check-stock (no product available)');
  }

  // ── 9. Place + confirm + fetch + cancel (only if serviceable) ───
  let orderId;
  step('Place order (COD)');
  if (productId && serviceable) {
    const place = await call('POST', '/api/orders', {
      token,
      body: { items: [{ productId, quantity: 1 }], deliveryAddress, paymentMethod: 'cod' },
    });
    orderId = data(place)?.orderId || data(place)?._id;
    if (place.status === 201 && orderId) pass(`POST /api/orders → 201 (orderId=${orderId}, status=${data(place)?.status})`);
    else fail(`POST /api/orders → ${place.status}`, JSON.stringify(place.body));

    if (orderId) {
      step('Confirm COD');
      const cod = await call('POST', '/api/payments/cod-confirm', { token, body: { orderId } });
      cod.status === 200 ? pass('POST /api/payments/cod-confirm → 200')
                         : warn(`cod-confirm → ${cod.status} (${cod.body?.message || ''})`);

      step('Fetch order');
      const got = await call('GET', `/api/orders/${orderId}`, { token });
      got.status === 200 ? pass(`GET /api/orders/${orderId} → 200 (status=${data(got)?.status})`)
                         : fail(`GET /api/orders/${orderId} → ${got.status}`, JSON.stringify(got.body));

      step('Cancel order (cleanup)');
      const cancel = await call('PATCH', `/api/orders/${orderId}/cancel`, { token, body: { reason: 'smoke_test_cleanup' } });
      cancel.status === 200 ? pass('PATCH /api/orders/:id/cancel → 200')
                            : warn(`cancel → ${cancel.status} (${cancel.body?.message || ''})`);
    }
  } else {
    skip('order placement (not serviceable or no product) — contract was still validated above');
  }

  // ── 10. Logout (revokes refresh token) ──────────────────────────
  step('Logout');
  const logout = await call('POST', '/api/auth/logout', { token, body: { refreshToken } });
  logout.status === 200 ? pass('POST /api/auth/logout → 200')
                        : fail(`POST /api/auth/logout → ${logout.status}`, JSON.stringify(logout.body));

  return finish();
}

function finish() {
  console.log(`\n${C.cyan}── Summary ──${C.reset}`);
  console.log(`${C.green}${counts.pass} passed${C.reset}  ${C.red}${counts.fail} failed${C.reset}  ${C.yellow}${counts.warn} warnings${C.reset}  ${C.dim}${counts.skip} skipped${C.reset}`);
  if (counts.fail > 0) { console.log(`${C.red}SMOKE TEST FAILED${C.reset}`); process.exit(1); }
  console.log(`${C.green}SMOKE TEST PASSED${C.reset}`);
  process.exit(0);
}

main().catch((err) => { console.error(`${C.red}Unexpected error:${C.reset}`, err); process.exit(1); });
