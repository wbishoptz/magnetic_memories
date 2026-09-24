// functions/api/admin-guest-resolve.js
// Admin-only: decide what happens to a guest order that is owed a refund
// (refundNeeded) or is waiting because it was paid after the event filled up
// (fullAfterPayment).
//   POST /api/admin-guest-resolve   Authorization: Bearer <ADMIN_KEY>
//   { orderId, action: "honour" | "refunded" }
//
//   honour    keep the payment: clear fullAfterPayment / refundNeeded and
//             finish the order with its paid extras (completeGuestOrder)
//             -> { number, paidExtras? }, or the 409 { full: true, paid: true }
//             answer when there is still no number left (the order goes back
//             to waiting), or completeGuestOrder's other errors.
//   refunded  the money was given back (in the Stripe dashboard):
//             extrasRefunded: true, extrasPaid: false, fullAfterPayment: false,
//             refundNeeded cleared, resolvedAt -> { success: true }.
//             An unfinished order stays unfinished (the guest page and the
//             webhook can't finish it any more; it is ignored for printing).
//             A finished order keeps its number and photos; when the refund
//             was for a second payment ("paid-twice") its paid extras stay paid.
// Guest orders only. Errors: { error } 400 / 401 / 403 / 404.
import { jsonResponse } from './_shared.js';
import { UUID_RE, loadOrder, completeGuestOrder } from './_guest.js';

const ACTIONS = ['honour', 'refunded'];

export async function onRequestPost({ request, env }) {
  try {
    const auth = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!env.ADMIN_KEY || auth !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return jsonResponse({ error: 'Bad request.' }, 400);
    const orderId = String(body.orderId || '').trim();
    if (!UUID_RE.test(orderId)) return jsonResponse({ error: 'Missing or invalid orderId.' }, 400);
    const action = String(body.action || '');
    if (!ACTIONS.includes(action)) return jsonResponse({ error: 'action must be "honour" or "refunded".' }, 400);

    const kvKey = `order:${orderId}`;
    const order = await loadOrder(env, orderId);
    if (!order) return jsonResponse({ error: 'Order not found.' }, 404);
    if (order.source !== 'guest') return jsonResponse({ error: 'Only guest uploads can be resolved here.' }, 403);

    const now = new Date().toISOString();
    const history = (entry) => [...(Array.isArray(order.refundHistory) ? order.refundHistory : []), entry];
    const owed = order.refundNeeded && typeof order.refundNeeded === 'object' ? order.refundNeeded : null;

    if (action === 'honour') {
      if (order.fullAfterPayment === true || owed) {
        // Honouring settles only the payment that buys these extras. Anything else
        // folded into the same record (a duplicate payment) is still owed back.
        let keep = null;
        if (owed) {
          if (owed.reason === 'full') {
            const rest = Math.round(((Number(owed.amount) || 0) - (Number(order.extrasAmount) || 0)) * 100) / 100;
            if (rest > 0) {
              let primary = null;
              try { primary = JSON.parse((await env.ORDERS_KV.get(`guestpay:${orderId}`)) || 'null')?.sessionId || null; } catch {}
              const ids = Array.isArray(owed.sessionIds) ? owed.sessionIds : (owed.sessionId ? [owed.sessionId] : []);
              const restIds = ids.filter(id => id && id !== primary);
              keep = { amount: rest, reason: 'paid-twice', at: now, ...(restIds.length ? { sessionId: restIds[0], sessionIds: restIds } : {}) };
            }
          } else {
            keep = owed; // not caused by the event filling up - still owed
          }
        }
        order.fullAfterPayment = false;
        order.refundNeeded = keep;
        order.resolvedAt = now;
        order.resolution = 'honour';
        order.refundHistory = history({ action: 'honour', at: now, refundNeeded: owed });
        order.updatedAt = now;
        await env.ORDERS_KV.put(kvKey, JSON.stringify(order));
      }
      const res = await completeGuestOrder(env, orderId, {});
      return jsonResponse(res.body, res.status);
    }

    // refunded
    const complete = order.raffleNumber != null;
    if (!complete) {
      order.extrasRefunded = true;
      order.extrasPaid = false;
      order.fullAfterPayment = false;
    } else if (!(owed && owed.reason === 'paid-twice')) {
      // finished with free photos only (paid after skipping), or a full refund
      order.extrasRefunded = true;
    }
    order.refundNeeded = null;
    order.resolvedAt = now;
    order.resolution = 'refunded';
    order.refundHistory = history({ action: 'refunded', at: now, refundNeeded: owed });
    order.updatedAt = now;
    await env.ORDERS_KV.put(kvKey, JSON.stringify(order));
    return jsonResponse({ success: true });
  } catch (err) {
    console.error('admin-guest-resolve error:', err);
    return jsonResponse({ error: 'Could not update the order. Please try again.' }, 500);
  }
}
