// functions/api/guest-pay.js
// Public: pay for a guest's extra magnets with Stripe Checkout.
//   POST { t, orderId, keys?: [r2Key, ...] }
//     -> { url }        send the guest to Stripe Checkout
//     -> { paid: true } already paid: call /api/guest-finalize
// Possession of the (random UUID) orderId is the authorisation, as for
// /api/guest-finalize. The photo list is saved on the order (pendingKeys) so the
// webhook can finish the order even if the guest never comes back. keys may be
// left out once pendingKeys is saved (the saved list is then used).
// Errors: { error } with
//   400 (bad request / photo list), 403, 404,
//   409 { extrasOff: true } extras no longer sold, 409 { full: true } no number
//       left (we never take money when full), 409 { complete: true, number },
//       409 { full: true, paid: true } paid but the event filled up (refund),
//       409 { refunded: true } the extras were refunded,
//   502 Stripe failed / unreachable (never a second session then),
//   503 payments / guest uploads not set up.
//
// One live Checkout Session per order: every session made is kept in
// order.extrasSessionIds (extrasSessionId = the latest) and checked for
// payment; an open one is reused; a new one is created with an Idempotency-Key
// derived from the order ("guest-extras-{orderId}-{sessions so far}") and a
// deterministic expires_at, so overlapping requests get the SAME session.
//
// The Checkout Session must never look like a shop order to webhook.js: no
// "orderId" parameter in the success/cancel URLs (the order travels as "ref")
// and no metadata[orderId]. It carries metadata[guestExtras]=true,
// metadata[guestOrderId], metadata[eventId].
import { jsonResponse } from './_shared.js';
import { hasDb, lowestFree, GUEST_MESSAGES } from './_tickets.js';
import {
  UUID_RE, FULL_MSG, FULL_AFTER_PAYMENT_MSG, REFUNDED_MSG, EXTRAS_OFF_MSG, STRIPE_DOWN_MSG,
  loadOrder, loadEvent, extrasConfig, extrasPaymentStatus, checkPhotoKeys, sessionPaysOrder,
  retrieveSessionChecked, orderSessionIds, expireSession, expireOpenSessions, stripeRequest, toPence,
} from './_guest.js';

const TOKEN_RE = /^[A-Za-z0-9]{8,64}$/;
const START_FAILED_MSG = 'Could not start the payment. Please try again.';
// An unpaid checkout link stops working 40-60 minutes after it was made:
// expires_at is the end of the 20-minute time slot 2 slots after "now", so
// requests made at nearly the same moment send identical parameters.
const EXPIRY_SLOT_SECONDS = 20 * 60;
const EXPIRY_SLOTS_AHEAD = 3;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function onRequestPost({ request, env }) {
  try {
    if (!hasDb(env)) return jsonResponse({ error: GUEST_MESSAGES['not-setup'] }, 503);
    if (!env.STRIPE_SECRET_KEY) return jsonResponse({ error: 'Payments are not set up.' }, 503);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return jsonResponse({ error: 'Bad request.' }, 400);
    const orderId = String(body.orderId || '').trim();
    if (!UUID_RE.test(orderId)) return jsonResponse({ error: 'Missing or invalid upload id.' }, 400);
    const t = String(body.t || '').trim();
    if (!TOKEN_RE.test(t)) return jsonResponse({ error: "This upload link isn't valid." }, 400);

    const order = await loadOrder(env, orderId);
    if (!order) return jsonResponse({ error: 'Upload not found. Please start again.' }, 404);
    if (order.source !== 'guest') return jsonResponse({ error: 'This is not a guest upload.' }, 403);
    if (order.raffleNumber != null) {
      return jsonResponse({ error: 'This upload is already complete.', complete: true, number: Number(order.raffleNumber) }, 409);
    }
    if (order.extrasRefunded === true) return jsonResponse({ error: REFUNDED_MSG, refunded: true }, 409);
    if (order.fullAfterPayment === true) return jsonResponse({ error: FULL_AFTER_PAYMENT_MSG, full: true, paid: true }, 409);
    const extrasCount = Math.floor(Number(order.extrasCount) || 0);
    if (!(extrasCount > 0) || order.extrasSkipped === true) {
      return jsonResponse({ error: 'There are no extra magnets to pay for on this upload.' }, 400);
    }

    const event = await loadEvent(env, order.eventId);
    if (!event) return jsonResponse({ error: 'This event no longer exists.' }, 404);

    // The full photo list (free + extras), same checks as finalize. Left out:
    // the list already saved on the order.
    const saved = Array.isArray(order.pendingKeys) && order.pendingKeys.length ? order.pendingKeys : null;
    const keys = body.keys === undefined || body.keys === null ? saved : body.keys;
    const check = await checkPhotoKeys(env, orderId, keys, { exact: Number(order.packSize) });
    if (!check.ok) return jsonResponse(check.body, check.status);

    // Already paid? (order / webhook record / ANY of the order's sessions)
    const pay = await extrasPaymentStatus(env, order);
    if (pay.paid) return jsonResponse({ paid: true });
    // A known session we could not check might be open or paid: never make a
    // second one on top of it.
    if (pay.failed) return jsonResponse({ error: STRIPE_DOWN_MSG }, 502);
    const sessions = pay.sessions;
    const isOpen = (s) => !!(s && s.status === 'open' && s.metadata && s.metadata.guestOrderId === orderId);
    const open = [...sessions.values()].filter(isOpen);

    // Extras switched off, or no number left: don't take any money.
    if (!extrasConfig(event)) {
      await expireOpenSessions(env, sessions);
      return jsonResponse({ error: EXTRAS_OFF_MSG, extrasOff: true }, 409);
    }
    if ((await lowestFree(env, event)) == null) {
      await expireOpenSessions(env, sessions);
      return jsonResponse({ error: FULL_MSG, full: true }, 409);
    }

    // Saves pendingKeys (+ session ids) onto the LATEST order record, so a
    // completion that landed meanwhile is never overwritten.
    const saveOrder = async ({ pendingKeys, sessionIds = [], latest = null, idemNext = null }) => {
      const fresh = await loadOrder(env, orderId);
      if (!fresh || fresh.raffleNumber != null) return false;
      const ids = orderSessionIds(fresh);
      for (const sid of sessionIds) if (sid && !ids.includes(sid)) ids.push(sid);
      if (pendingKeys) fresh.pendingKeys = pendingKeys;
      if (ids.length) fresh.extrasSessionIds = ids;
      if (latest) fresh.extrasSessionId = latest;
      // First Idempotency-Key index not burnt by a Stripe 5xx (see the loop below)
      if (Number.isInteger(idemNext) && idemNext > (Number(fresh.extrasIdemNext) || 0)) fresh.extrasIdemNext = idemNext;
      fresh.updatedAt = new Date().toISOString();
      await env.ORDERS_KV.put(`order:${orderId}`, JSON.stringify(fresh));
      return true;
    };
    const sameKeys = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((k, i) => k === b[i]);
    const alreadyComplete = () => jsonResponse({ error: 'This upload is already complete.', complete: true }, 409);

    // Still-open checkout for this order: send the guest back to it (the
    // newest; any older open one is expired - one live session per order).
    if (open.length) {
      const live = open[open.length - 1];
      for (const s of open.slice(0, -1)) await expireSession(env, s.id);
      if (!sameKeys(order.pendingKeys, keys) && !(await saveOrder({ pendingKeys: keys }))) return alreadyComplete();
      if (live.url) return jsonResponse({ url: live.url });
      await expireSession(env, live.id); // unusable without a url: replaced below
    }

    // New Checkout Session - amount from the ORDER snapshot, never the live price
    const unitAmount = toPence(order.extraPrice);
    if (!(unitAmount > 0)) return jsonResponse({ error: EXTRAS_OFF_MSG, extrasOff: true }, 409);
    const origin = new URL(request.url).origin;
    const back = `${origin}/guest?t=${encodeURIComponent(t)}`;
    const eventName = String(event.name || 'Event').slice(0, 200);
    const productName = `Extra magnet${extrasCount === 1 ? '' : 's'} - ${eventName}`;
    const buildParams = (expiresAt) => {
      const params = new URLSearchParams();
      params.append('mode', 'payment');
      params.append('success_url', `${back}&paid=1&ref=${orderId}`);
      params.append('cancel_url', `${back}&cancelled=1&ref=${orderId}`);
      params.append('payment_method_types[0]', 'card'); // no delayed methods; Apple/Google Pay still work
      params.append('adaptive_pricing[enabled]', 'false'); // always charged in GBP
      params.append('line_items[0][quantity]', String(extrasCount));
      params.append('line_items[0][price_data][currency]', 'gbp');
      params.append('line_items[0][price_data][unit_amount]', String(unitAmount));
      params.append('line_items[0][price_data][product_data][name]', productName);
      params.append('metadata[guestExtras]', 'true');
      params.append('metadata[guestOrderId]', orderId);
      params.append('metadata[eventId]', String(event.id));
      params.append('payment_intent_data[description]', `${productName} (order ${orderId.slice(0, 8)})`);
      params.append('expires_at', String(expiresAt));
      return params;
    };
    const slot = Math.floor(Date.now() / 1000 / EXPIRY_SLOT_SECONDS);
    const expiresFor = (s) => (s + EXPIRY_SLOTS_AHEAD) * EXPIRY_SLOT_SECONDS;

    const known = [...sessions.keys()];      // every session id made for this order
    // -> the idempotency key for the next one (skipping keys a Stripe 5xx burnt)
    let n = Math.max(known.length, Number.isInteger(order.extrasIdemNext) ? order.extrasIdemNext : 0);
    let reread = false;
    let burnt = 0;                           // keys skipped because Stripe stored a 5xx
    for (let round = 0; round < 4; round++) {
      const idemKey = `guest-extras-${orderId}-${n}`;
      let res = await createSession(env, buildParams(expiresFor(slot)), idemKey);
      if (res.mismatch) {
        // This key was used a moment ago by an overlapping request that fell in
        // the neighbouring time slot: repeat its exact request to get ITS session.
        for (const s of [slot - 1, slot + 1]) {
          res = await createSession(env, buildParams(expiresFor(s)), idemKey);
          if (!res.mismatch) break;
        }
      }
      if (res.mismatch) {
        // Used by an older, different request. Another request may have saved
        // its session by now: look at the order once more before moving on.
        if (!reread) {
          reread = true;
          const fresh = await loadOrder(env, orderId);
          if (fresh && fresh.raffleNumber != null) return alreadyComplete();
          const freshIds = orderSessionIds(fresh).filter(id => !known.includes(id));
          if (freshIds.length) {
            for (const sid of freshIds) {
              const r = await retrieveSessionChecked(env, sid);
              if (r.failed) return jsonResponse({ error: STRIPE_DOWN_MSG }, 502);
              known.push(sid);
              if (r.session && sessionPaysOrder(r.session, order)) return jsonResponse({ paid: true });
              if (isOpen(r.session) && r.session.url) {
                if (!sameKeys(fresh.pendingKeys, keys) && !(await saveOrder({ pendingKeys: keys }))) return alreadyComplete();
                return jsonResponse({ url: r.session.url });
              }
            }
            n = Math.max(n, known.length);
            continue;
          }
        }
        n++;
        continue;
      }
      if (!res.ok) {
        console.error('guest-pay: Stripe error:', res.status, res.data);
        // Stripe stores a 5xx under its Idempotency-Key and replays it for 24h, so
        // that key can never work again: move on (a 5xx means no session was made;
        // network errors keep the same key so a session that WAS made is replayed).
        // Skips don't use up the normal rounds, and the next unused index is saved
        // so a later tap doesn't replay the same stored errors first.
        if (res.status >= 500 && burnt < 12) {
          n++; burnt++; round--;
          continue;
        }
        if (burnt) await saveOrder({ idemNext: n }).catch(e => console.error('guest-pay: save failed:', e));
        return jsonResponse({ error: START_FAILED_MSG }, 502);
      }

      let session = res.session;
      const seenBefore = known.includes(session.id);
      if (res.replayed || seenBefore) {
        // An earlier request with this key made it: use its CURRENT state
        const cur = await retrieveSessionChecked(env, session.id);
        if (cur.failed) return jsonResponse({ error: STRIPE_DOWN_MSG }, 502);
        if (cur.session) session = cur.session;
      }
      if (!seenBefore) known.push(session.id);

      if (sessionPaysOrder(session, order)) {
        await saveOrder({ sessionIds: known, idemNext: burnt ? n : null }).catch(err => console.error('guest-pay: save failed:', err));
        return jsonResponse({ paid: true });
      }
      if (session.status === 'open' && session.url) {
        if (!(await saveOrder({ pendingKeys: keys, sessionIds: known, latest: session.id, idemNext: burnt ? n : null }))) {
          await expireSession(env, session.id);
          return alreadyComplete();
        }
        return jsonResponse({ url: session.url });
      }
      // That session can no longer be paid (expired): the next key makes a new one
      n = Math.max(n + 1, known.length);
    }
    console.error('guest-pay: could not get a usable Checkout Session for', orderId);
    if (burnt) await saveOrder({ idemNext: n }).catch(e => console.error('guest-pay: save failed:', e));
    return jsonResponse({ error: START_FAILED_MSG }, 502);
  } catch (err) {
    console.error('guest-pay error:', err);
    return jsonResponse({ error: START_FAILED_MSG }, 500);
  }
}

// POST /v1/checkout/sessions with an Idempotency-Key.
// -> { ok: true, session, replayed }
//  | { ok: false, mismatch: true }  the key was used with other parameters
//  | { ok: false, status, data }    Stripe error / unreachable
// Safe to repeat: with the same key Stripe never makes a second session. A
// request still in flight with the same key (409) is waited for.
async function createSession(env, params, idemKey) {
  let last = { ok: false, status: 0, data: null };
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    try {
      r = await stripeRequest(env, 'POST', '/v1/checkout/sessions', params, { 'Idempotency-Key': idemKey });
    } catch (err) {
      console.error('guest-pay: Stripe unreachable:', err);
      last = { ok: false, status: 0, data: null };
      if (attempt < 1) continue; // one retry: the same key can't make a second session
      return last;
    }
    const err = (r.data && r.data.error) || {};
    const msg = String(err.message || '');
    const isIdem = err.type === 'idempotency_error' || /idempot/i.test(msg);
    if (!r.ok && isIdem && /parameters/i.test(msg)) return { ok: false, mismatch: true };
    if (r.status === 409) {
      // the other request with this key is still running: wait for its result
      last = { ok: false, status: r.status, data: r.data };
      await sleep(250 * (attempt + 1));
      continue;
    }
    if (!r.ok || !r.data || !r.data.id) return { ok: false, status: r.status, data: r.data };
    return { ok: true, session: r.data, replayed: r.replayed };
  }
  return last;
}
