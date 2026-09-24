// functions/api/_guest.js
// Shared guest self-upload logic:
//   - completeGuestOrder(): give a guest order its number (used by
//     /api/guest-finalize, the Stripe webhook for paid extra magnets and
//     /api/admin-guest-resolve)
//   - extrasPaymentStatus(): has this order's "extra magnets" payment arrived?
//     (every Checkout Session ever made for the order is checked)
//   - refund bookkeeping (refundNeeded / extrasRefunded on the order)
//   - paid-extras settings (extrasConfig) and event overlay helpers
//   - a tiny Stripe client (STRIPE_API_BASE override is for local tests only)
//
// Order fields for paid extras (all amounts GBP):
//   freeCount, extrasCount, extraPrice, extrasTotal   snapshot from guest-order
//   extrasSessionIds: [id, ...]  every Checkout Session made for the order, in
//                                creation order; extrasSessionId = the latest
//   extrasPaid, extrasPaidAt, extrasAmount, extrasEmail   set when completed
//   fullAfterPayment: true       paid, but no number was left. The order is NOT
//                                finished automatically until an admin resolves
//                                it (/api/admin-guest-resolve)
//   refundNeeded: { amount, reason: "full"|"paid-after-skip"|"paid-twice", at }
//   extrasRefunded: true         the admin refunded the extras
import { hasDb, allocateNext, maxPhotosFor, GUEST_MESSAGES } from './_tickets.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FULL_MSG = 'Sorry - all numbers for this event have been taken.';
export const FULL_AFTER_PAYMENT_MSG = 'Sorry - all numbers were taken while you were paying. Please show this screen to the Magnetic Memories team for a refund.';
export const REFUNDED_MSG = 'Your payment was refunded. Please speak to the Magnetic Memories team.';
export const NOT_PAID_MSG = "We haven't received your payment yet.";
export const EXTRAS_OFF_MSG = 'Extra magnets are no longer available for this event.';
export const STRIPE_DOWN_MSG = 'Payment service unavailable, please try again.';
export const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // same limit as /api/upload for guests
export const REFUND_REASONS = ['full', 'paid-after-skip', 'paid-twice'];

// ─── Small helpers ─────────────────────────────────────────────────────────

export const toPence = (pounds) => Math.round(Number(pounds) * 100);
export const round2 = (n) => Math.round(Number(n) * 100) / 100;
export const formatGBP = (pounds) => `£${(Math.round(Number(pounds) * 100) / 100).toFixed(2)}`;

export async function loadJson(env, key) {
  const raw = await env.ORDERS_KV.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
export const loadEvent = (env, id) => (id ? loadJson(env, `event:meta:${id}`) : Promise.resolve(null));
export const loadOrder = (env, orderId) => loadJson(env, `order:${orderId}`);

// ─── Paid extra magnets: settings ──────────────────────────────────────────

export const EXTRA_PRICE_MIN = 0.3;
export const EXTRA_PRICE_MAX = 100;
export const MAX_EXTRAS_DEFAULT = 10;
export const MAX_EXTRAS_LIMIT = 50;

// GBP price with at most 2 decimals in [0.30, 100] -> number (2dp), else null.
export function parseExtraPrice(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim().replace(/^£/, ''));
  if (!Number.isFinite(n)) return null;
  const pence = Math.round(n * 100);
  if (Math.abs(n * 100 - pence) > 1e-6) return null; // more than 2 decimals
  if (pence < toPence(EXTRA_PRICE_MIN) || pence > toPence(EXTRA_PRICE_MAX)) return null;
  return pence / 100;
}

// Integer 1..50 -> number, else null.
export function parseMaxExtras(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isInteger(n) && n >= 1 && n <= MAX_EXTRAS_LIMIT ? n : null;
}

// Extras are only on when switched on, the free allowance is a real limit
// (perTicketLimit > 0) and a valid price is set. -> { price, max } | null
export function extrasConfig(event) {
  if (!event || event.extrasEnabled !== true) return null;
  const lim = Number(event.perTicketLimit);
  if (!(Number.isInteger(lim) && lim > 0)) return null;
  const price = parseExtraPrice(event.extraPrice);
  if (price == null) return null;
  return { price, max: parseMaxExtras(event.maxExtras) ?? MAX_EXTRAS_DEFAULT };
}

// ─── Event overlays ────────────────────────────────────────────────────────

export const OVERLAY_MODES = ['off', 'optional', 'required'];
export const MAX_OVERLAYS = 8;

export function overlayList(event) {
  return Array.isArray(event && event.overlays) ? event.overlays.filter(o => o && o.id) : [];
}

// "off" whenever there are no overlays.
export function effectiveOverlayMode(event) {
  if (!overlayList(event).length) return 'off';
  return OVERLAY_MODES.includes(event.overlayMode) ? event.overlayMode : 'off';
}

export function overlayUrl(eventId, overlayId) {
  return `/api/event-overlay?e=${encodeURIComponent(eventId)}&id=${encodeURIComponent(overlayId)}`;
}

// Public shape: never the R2 key.
export function publicOverlays(event) {
  return overlayList(event).map(o => ({ id: o.id, name: o.name, url: overlayUrl(event.id, o.id) }));
}

// Event as the public sees it (staff page, guests): no guest token, overlays in
// the public shape, overlayMode = the effective mode.
export function publicEventView(event) {
  if (!event || typeof event !== 'object') return event;
  const { guestToken, ...rest } = event;
  return { ...rest, overlays: publicOverlays(event), overlayMode: effectiveOverlayMode(event) };
}

// Event as the admin sees it: everything stored, plus a url per overlay.
export function adminEventView(event) {
  if (!event || typeof event !== 'object') return event;
  return {
    ...event,
    overlays: overlayList(event).map(o => ({ ...o, url: overlayUrl(event.id, o.id) })),
    overlayMode: OVERLAY_MODES.includes(event.overlayMode) ? event.overlayMode : 'off',
  };
}

// ─── Stripe (form-encoded REST) ────────────────────────────────────────────

export function stripeApiBase(env) {
  return String((env && env.STRIPE_API_BASE) || 'https://api.stripe.com').replace(/\/+$/, '');
}

// -> { ok, status, data, replayed }  (throws only when Stripe is unreachable)
// headers: extra request headers (e.g. Idempotency-Key). replayed: Stripe
// answered from its idempotency cache (the request was made before).
export async function stripeRequest(env, method, path, params, headers = {}) {
  const init = { method, headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...headers } };
  if (params) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = params.toString();
  }
  const res = await fetch(`${stripeApiBase(env)}${path}`, init);
  const data = await res.json().catch(() => null);
  const replayed = String((res.headers && res.headers.get('Idempotent-Replayed')) || '').toLowerCase() === 'true';
  return { ok: res.ok, status: res.status, data, replayed };
}

const SESSION_ID_RE = /^[A-Za-z0-9_]{1,255}$/;

// -> { session, failed }. session: the Checkout Session, or null when Stripe
// doesn't know it. failed: Stripe could not be asked (network error, 5xx, 429,
// unreadable answer, no key) - the session may exist and even be paid.
export async function retrieveSessionChecked(env, sessionId) {
  if (!sessionId || !SESSION_ID_RE.test(String(sessionId))) return { session: null, failed: false };
  if (!env.STRIPE_SECRET_KEY) return { session: null, failed: true };
  try {
    const r = await stripeRequest(env, 'GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
    if (r.ok && r.data && r.data.id) return { session: r.data, failed: false };
    if (r.status >= 500 || r.status === 429 || !r.data) {
      console.error('Stripe session retrieve failed:', r.status, sessionId);
      return { session: null, failed: true };
    }
    return { session: null, failed: false }; // 4xx: no such session
  } catch (err) {
    console.error('Stripe session retrieve failed:', err);
    return { session: null, failed: true };
  }
}

// Checkout Session or null (unknown / Stripe unreachable / no key).
export async function retrieveSession(env, sessionId) {
  return (await retrieveSessionChecked(env, sessionId)).session;
}

// Stop an open session from being paid. -> true when it is no longer payable.
export async function expireSession(env, sessionId) {
  if (!env.STRIPE_SECRET_KEY || !sessionId) return false;
  try {
    const r = await stripeRequest(env, 'POST', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`);
    return !!(r.ok && r.data && r.data.status === 'expired');
  } catch (err) {
    console.error('Stripe session expire failed:', err);
    return false;
  }
}

// Every Checkout Session id made for this order, oldest first (the list, plus
// the older single extrasSessionId field).
export function orderSessionIds(order) {
  const ids = [];
  const add = (id) => { if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id); };
  if (order && Array.isArray(order.extrasSessionIds)) order.extrasSessionIds.forEach(add);
  if (order) add(order.extrasSessionId);
  return ids;
}

// Retrieve every session of the order (in parallel).
// -> { sessions: Map(id -> session | null), failed } (failed: at least one could
// not be checked with Stripe)
export async function retrieveOrderSessions(env, order) {
  const ids = orderSessionIds(order);
  const got = await Promise.all(ids.map(id => retrieveSessionChecked(env, id)));
  const sessions = new Map();
  let failed = false;
  ids.forEach((id, i) => {
    sessions.set(id, got[i].session);
    if (got[i].failed) failed = true;
  });
  return { sessions, failed };
}

// Expire every open session in the map (updates the map). A session that
// could not be expired is looked at again: it may have just been paid.
export async function expireOpenSessions(env, sessions) {
  for (const [id, s] of sessions) {
    if (!s || s.status !== 'open') continue;
    if (await expireSession(env, id)) {
      sessions.set(id, { ...s, status: 'expired' });
    } else {
      const again = await retrieveSessionChecked(env, id);
      if (again.session) sessions.set(id, again.session);
    }
  }
  return sessions;
}

const isGbp = (currency) => !currency || String(currency).toLowerCase() === 'gbp';

// Does this Stripe session pay for this order's extras?
export function sessionPaysOrder(session, order) {
  return !!(session
    && session.payment_status === 'paid'
    && session.metadata && session.metadata.guestOrderId === order.orderId
    && isGbp(session.currency)
    && Number(session.amount_total) >= toPence(order.extrasTotal || 0));
}

// Has the extras payment for this order been received?
//   1. the order already says so, 2. KV guestpay:{orderId} (written by the
//   webhook; GBP only), 3. any of the order's Stripe Checkout Sessions
//   (payment_status "paid") - an older session paid late counts too.
// A refunded order (extrasRefunded) is never paid.
// opts.sessions: Map(id -> session|null) already retrieved (retrieveOrderSessions).
// -> { paid, via?, sessionId?, amount? (GBP), email?, paidAt?,
//      sessions (Map), failed (a session could not be checked with Stripe) }
export async function extrasPaymentStatus(env, order, opts = {}) {
  if (!order) return { paid: false, sessions: new Map(), failed: false };
  if (order.extrasRefunded === true) return { paid: false, refunded: true, sessions: new Map(), failed: false };
  const expected = toPence(order.extrasTotal || 0);
  if (order.extrasPaid === true) {
    return {
      paid: true, via: 'order', sessionId: order.extrasSessionId || null,
      amount: order.extrasAmount ?? null, email: order.extrasEmail || null, paidAt: order.extrasPaidAt || null,
    };
  }

  try {
    const rec = await loadJson(env, `guestpay:${order.orderId}`);
    if (rec && isGbp(rec.currency) && Number(rec.amountPence ?? toPence(rec.amount)) >= expected) {
      return {
        paid: true, via: 'kv', sessionId: rec.sessionId || null,
        amount: rec.amount ?? null, email: rec.email || null, paidAt: rec.paidAt || null,
      };
    }
  } catch (err) {
    console.error('guestpay read failed:', err);
  }

  let sessions = opts.sessions;
  let failed = false;
  if (!(sessions instanceof Map)) ({ sessions, failed } = await retrieveOrderSessions(env, order));
  for (const session of [...sessions.values()].reverse()) {
    if (sessionPaysOrder(session, order)) {
      return {
        paid: true, via: 'stripe', sessionId: session.id,
        amount: round2(Number(session.amount_total) / 100),
        email: (session.customer_details && session.customer_details.email) || null,
        paidAt: null,
      };
    }
  }
  return { paid: false, sessions, failed };
}

// ─── Refund bookkeeping ─────────────────────────────────────────────────────

// Add a refund that is owed to order.refundNeeded (mutates the order).
// Idempotent per Stripe session: the same session is never counted twice. A
// second refund for another session adds its amount (the first reason stays).
// -> true when the order changed.
export function addRefundNeeded(order, { amount, reason, sessionId = null, at = new Date().toISOString() }) {
  const cur = order.refundNeeded && typeof order.refundNeeded === 'object' ? order.refundNeeded : null;
  const ids = cur ? (Array.isArray(cur.sessionIds) ? cur.sessionIds : (cur.sessionId ? [cur.sessionId] : [])) : [];
  if (cur && (sessionId ? ids.includes(sessionId) : cur.reason === reason)) return false;
  const amt = round2(Number(amount) || 0);
  if (cur) {
    order.refundNeeded = {
      ...cur,
      amount: round2((Number(cur.amount) || 0) + amt),
      ...(sessionId ? { sessionIds: [...ids, sessionId] } : {}),
    };
  } else {
    order.refundNeeded = { amount: amt, reason, at, ...(sessionId ? { sessionId, sessionIds: [sessionId] } : {}) };
  }
  return true;
}

// ─── Photo list checks (shared by finalize and /api/guest-pay) ─────────────

// -> { ok: true, heads } | { ok: false, status, body }
export async function checkPhotoKeys(env, orderId, keys, { min = 1, max, exact } = {}) {
  const plural = (n) => (n > 1 ? 's' : '');
  if (exact != null) {
    if (!Array.isArray(keys) || keys.length !== exact) {
      return { ok: false, status: 400, body: { error: `Please send all ${exact} photo${plural(exact)}.` } };
    }
  } else if (!Array.isArray(keys) || keys.length < min || keys.length > max) {
    return { ok: false, status: 400, body: { error: `Please send between 1 and ${max} photo${plural(max)}.` } };
  }
  const prefix = `orders/${orderId}/`;
  const seen = new Set();
  for (const k of keys) {
    if (typeof k !== 'string' || !k.startsWith(prefix) || k.length > 1024 || seen.has(k)) {
      return { ok: false, status: 400, body: { error: 'Invalid photo list.' } };
    }
    seen.add(k);
  }
  const heads = await Promise.all(keys.map(k => env.R2_BUCKET.head(k)));
  const missing = [];
  heads.forEach((h, i) => { if (!h) missing.push(i + 1); });
  if (missing.length) {
    return {
      ok: false, status: 400,
      body: { error: `Photo ${missing.join(', ')} didn't finish uploading. Please try again.`, missing },
    };
  }
  // Only JPEG photos (as stored by /api/upload for guests), max 15 MB each
  const invalid = [];
  heads.forEach((h, i) => {
    const type = String((h.httpMetadata && h.httpMetadata.contentType) || '').split(';')[0].trim().toLowerCase();
    const size = Number(h.size);
    if (type !== 'image/jpeg' || !Number.isFinite(size) || size > MAX_PHOTO_BYTES) invalid.push(i + 1);
  });
  if (invalid.length) {
    return {
      ok: false, status: 400,
      body: { error: `Photo ${invalid.join(', ')} isn't a photo we can use. Please choose it again.`, invalid },
    };
  }
  return { ok: true, heads };
}

// Every R2 object key under a prefix (all pages)
async function listObjects(env, prefix) {
  const keys = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const res = await env.R2_BUCKET.list(cursor ? { prefix, cursor } : { prefix });
    for (const obj of (res && res.objects) || []) keys.push(obj.key);
    if (!res || !res.truncated || !res.cursor) break;
    cursor = res.cursor;
  }
  return keys;
}

// Delete everything under the order's prefix that isn't one of its photos
// (leftovers from retried uploads, extras that were not paid for, or a late
// upload that raced the finish). Never fails the request.
export async function sweepOrphans(env, prefix, wanted) {
  try {
    const orphans = (await listObjects(env, prefix)).filter(k => !wanted.has(k));
    for (let i = 0; i < orphans.length; i += 1000) {
      await env.R2_BUCKET.delete(orphans.slice(i, i + 1000));
    }
  } catch (err) {
    console.error('guest order: orphan cleanup failed:', err);
  }
}

// Delete known keys directly (no listing), with one retry. Never throws.
export async function deleteKeys(env, keys) {
  if (!keys.length) return true;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await env.R2_BUCKET.delete(keys);
      return true;
    } catch (err) {
      console.error(`guest order: deleting dropped photos failed (attempt ${attempt}):`, err);
    }
  }
  return false;
}

// ─── Finish a guest order ──────────────────────────────────────────────────

const result = (status, body, order = null, extra = {}) => ({ status, body, order, ...extra });

// Give a guest order its number. Idempotent: a finished order returns the same
// number and is left untouched.
//   keys:       the photo list sent by the page (optional; ignored when the
//               order has pendingKeys, saved by /api/guest-pay - that list is
//               the truth)
//   skipExtras: finish with only the free photos (the extras were not paid)
// Blocked (409) while the order waits for an admin: fullAfterPayment (paid but
// no number was left) or extrasRefunded.
// -> { status, body, order, refundRecorded? } - body is what
//    /api/guest-finalize returns; order is the order as it now stands and
//    refundRecorded (full after payment only) whether that was saved on the
//    order (internal, for the webhook).
export async function completeGuestOrder(env, orderId, { keys: clientKeys, skipExtras = false } = {}) {
  if (!hasDb(env)) return result(503, { error: GUEST_MESSAGES['not-setup'] });

  const id = String(orderId || '').trim();
  if (!UUID_RE.test(id)) return result(400, { error: 'Missing or invalid upload id.' });

  const kvKey = `order:${id}`;
  const prefix = `orders/${id}/`;
  const order = await loadOrder(env, id);
  if (!order) return result(404, { error: 'Upload not found. Please start again.' });
  if (order.source !== 'guest') return result(403, { error: 'This is not a guest upload.' });

  // Already finished -> same answer again (order, incl. completedAt, untouched)
  if (order.raffleNumber != null) {
    // Free-only finish: the unpaid extras must not stay in R2. The first sweep
    // may have failed, so every later call (guest retry, webhook) sweeps again.
    if (order.extrasSkipped === true) {
      const recorded = (Array.isArray(order.images) ? order.images : [])
        .map(im => im && im.key).filter(k => typeof k === 'string' && k);
      if (recorded.length) await sweepOrphans(env, prefix, new Set(recorded));
    }
    const body = { number: Number(order.raffleNumber) };
    if (order.extrasPaid === true && Number(order.extrasCount) > 0) body.paidExtras = Number(order.extrasCount);
    return result(200, body, order);
  }

  // Waiting for an admin decision (/api/admin-guest-resolve)
  if (order.extrasRefunded === true) return result(409, { error: REFUNDED_MSG, refunded: true }, order);
  if (order.fullAfterPayment === true) return result(409, { error: FULL_AFTER_PAYMENT_MSG, full: true, paid: true }, order);

  const event = await loadEvent(env, order.eventId);
  if (!event) return result(404, { error: 'This event no longer exists.' });

  // Free allowance snapshot from when the order was started (older orders: the event's)
  const snapFree = Number(order.freeCount);
  const freeCount = Number.isInteger(snapFree) && snapFree > 0 ? snapFree : maxPhotosFor(event);
  const extrasCount = order.extrasSkipped === true ? 0 : Math.max(0, Math.floor(Number(order.extrasCount) || 0));

  // ── Extras: paid, or explicitly skipped ─────────────────────────
  let pay = null;
  let skipping = false;
  if (extrasCount > 0) {
    if (skipExtras) {
      // Make sure no checkout made for this order can be paid after we drop
      // the extras: expire every open one.
      const { sessions } = await retrieveOrderSessions(env, order);
      await expireOpenSessions(env, sessions);
      const status = await extrasPaymentStatus(env, order, { sessions });
      if (status.paid) {
        return result(409, {
          error: 'Your extra magnets are already paid for - sending all your photos.',
          alreadyPaid: true,
        }, order);
      }
      skipping = true;
    } else {
      pay = await extrasPaymentStatus(env, order);
      if (!pay.paid) return result(402, { error: NOT_PAID_MSG, needsPayment: true }, order);
    }
  }

  // ── Photo list ──────────────────────────────────────────────────
  const pending = Array.isArray(order.pendingKeys) && order.pendingKeys.length ? order.pendingKeys : null;
  const listed = pending || clientKeys;
  let keys = listed;
  let dropped = [];
  if (skipping && Array.isArray(listed)) {
    keys = listed.slice(0, freeCount);
    // The unpaid extras (this order's own objects only), deleted directly
    // after the completing write - not left to the sweep alone.
    const keep = new Set(keys);
    const extra = [...listed.slice(freeCount), ...(Array.isArray(clientKeys) && clientKeys !== listed ? clientKeys.slice(freeCount) : [])];
    dropped = [...new Set(extra)].filter(k => typeof k === 'string' && k.startsWith(prefix) && k.length <= 1024 && !keep.has(k));
  }
  const allowed = freeCount + (pay && pay.paid ? extrasCount : 0);
  const check = await checkPhotoKeys(env, id, keys, { max: allowed });
  if (!check.ok) return result(check.status, check.body, order);
  const heads = check.heads;
  const wanted = new Set(keys);

  // ── Give out the number (atomic, idempotent per order) ──────────
  const number = await allocateNext(env, event, id, 'guest');
  if (number == null) {
    if (pay && pay.paid) {
      // Money taken but no number left: record it for the refund and stop
      // finishing this order automatically until an admin decides.
      let refundRecorded = false;
      try {
        const fresh = (await loadOrder(env, id)) || order;
        if (fresh.raffleNumber == null) {
          const now = new Date().toISOString();
          Object.assign(fresh, paidFields(pay, fresh, now), { fullAfterPayment: true, updatedAt: now });
          addRefundNeeded(fresh, { amount: fresh.extrasAmount, reason: 'full', sessionId: pay.sessionId || null, at: now });
          await env.ORDERS_KV.put(kvKey, JSON.stringify(fresh));
        }
        refundRecorded = true;
      } catch (err) {
        console.error('guest order: could not record full-after-payment:', err);
      }
      return result(409, { error: FULL_AFTER_PAYMENT_MSG, full: true, paid: true }, order, { refundRecorded });
    }
    return result(409, { error: FULL_MSG, full: true }, order);
  }

  const fallbackUploadedAt = new Date().toISOString();
  const previous = new Map((Array.isArray(order.images) ? order.images : [])
    .filter(im => im && im.key)
    .map(im => [im.key, im]));
  order.images = keys.map((key, i) => {
    const uploaded = heads[i] && heads[i].uploaded ? new Date(heads[i].uploaded) : null;
    return {
      key,
      name: `Ticket-${number}-${i + 1}.jpg`,
      uploadedAt: previous.get(key)?.uploadedAt
        || (uploaded && !Number.isNaN(uploaded.getTime()) ? uploaded.toISOString() : fallbackUploadedAt),
    };
  });
  order.raffleNumber = number;
  order.status = 'paid';
  order.packSize = keys.length;
  if (skipping) {
    order.extrasSkipped = true;
    order.extrasCount = 0;
  }

  // completedAt = when this completing write happens (the admin's capture order)
  const completedAt = new Date().toISOString();
  if (pay && pay.paid) Object.assign(order, paidFields(pay, order, completedAt));
  order.completedAt = completedAt;
  order.updatedAt = completedAt;
  await env.ORDERS_KV.put(kvKey, JSON.stringify(order));

  // Only now remove leftovers: the known unpaid extras first (direct delete,
  // works even when listing fails), then a sweep - an upload that slipped in
  // while we were finishing (after its own "already complete?" check) is
  // removed too.
  if (dropped.length) await deleteKeys(env, dropped);
  await sweepOrphans(env, prefix, wanted);

  // Paid: no other checkout for this order may stay payable (one live session)
  if (pay && pay.paid) await expireOtherSessions(env, order, pay.sessionId);

  // History / back-compat with the legacy KV ticket keys
  try {
    await env.ORDERS_KV.put(`event:ticket:${order.eventId}:${number}`, id);
  } catch (err) {
    console.error('guest order: ticket key write failed:', err);
  }

  const body = { number };
  if (pay && pay.paid && extrasCount > 0) body.paidExtras = extrasCount;
  return result(200, body, order);
}

// Expire every open session of the order except the one that paid.
// Best-effort (never throws); no Stripe call when the paid one is the only one.
async function expireOtherSessions(env, order, paidSessionId) {
  try {
    const others = orderSessionIds(order).filter(id => id !== paidSessionId);
    if (!others.length) return;
    const sessions = new Map();
    for (const id of others) sessions.set(id, (await retrieveSessionChecked(env, id)).session);
    await expireOpenSessions(env, sessions);
  } catch (err) {
    console.error('guest order: could not expire the other checkouts:', err);
  }
}

// extrasAmount is always GBP.
function paidFields(pay, order, now) {
  const out = {
    extrasPaid: true,
    extrasPaidAt: pay.paidAt || order.extrasPaidAt || now,
    extrasAmount: pay.amount != null ? round2(pay.amount) : round2(order.extrasTotal || 0),
    extrasEmail: pay.email || order.extrasEmail || null,
  };
  const ids = orderSessionIds(order);
  if (pay.sessionId && !ids.includes(pay.sessionId)) out.extrasSessionIds = [...ids, pay.sessionId];
  if (pay.sessionId && !order.extrasSessionId) out.extrasSessionId = pay.sessionId;
  return out;
}
