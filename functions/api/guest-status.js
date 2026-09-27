// functions/api/guest-status.js
// Public: where a guest upload stands - used by the guest page when it comes
// back from Stripe (?ref=ORDER_ID) without its saved state (other browser,
// storage blocked), and for the "add more magnets" offer on a ticket.
//   GET /api/guest-status?ref=ORDER_UUID
//     -> { complete, number (int|null), eventId, freeCount, extrasCount,
//          extrasTotal, extrasPaid, paymentStarted, refunded, fullAfterPayment,
//          addon, addonTo, cancelled, addOn }
//     -> 404 { error } unknown id / not a guest upload
// Add-on magnets:
//   addon      this order is an add-on (more magnets for an existing ticket)
//   addonTo    its root order id (null for a ticket's own order)
//   cancelled  an add-on the guest chose not to add ("don't add them")
//   For an add-on, number is the ticket it joins (the root's number) even
//   before it is complete, freeCount is 0 and extrasCount / extrasTotal are its
//   own (kept when cancelled).
//   addOn (a COMPLETE ticket order only, else null): can more magnets be added?
//     { available, remaining, price, bought, reason: null|"extrasOff"|"closed"|"limit" }
//     bought = the ticket's own paid extras + every completed add-on.
// Possession of the (random UUID) order id is the authorisation, as for
// /api/guest-finalize. Nothing personal is returned (no email, photo keys or
// Stripe ids). extrasPaid may ask Stripe (every session made for the order).
import { jsonResponse } from './_shared.js';
import { maxPhotosFor, hasDb } from './_tickets.js';
import {
  UUID_RE, loadOrder, loadEvent, extrasPaymentStatus, orderSessionIds, round2,
  isAddon, addonRootNumber, addonAllowance,
} from './_guest.js';

const NOT_FOUND = { error: 'Upload not found.' };

// The add-on offer for a complete ticket order. Never fails the request: when
// it can't be worked out, nothing is offered.
async function addOnFor(env, root) {
  const own = root.extrasPaid === true ? Math.max(0, Math.floor(Number(root.extrasCount) || 0)) : 0;
  const none = { available: false, remaining: 0, price: null, bought: own, reason: 'closed' };
  if (!hasDb(env)) return none;
  try {
    const event = await loadEvent(env, root.eventId);
    const a = await addonAllowance(env, root, event);
    return { available: a.available, remaining: a.remaining, price: a.price, bought: a.bought, reason: a.reason };
  } catch (err) {
    console.error('guest-status: add-on offer failed:', err);
    return none;
  }
}

export async function onRequestGet({ request, env }) {
  try {
    const ref = String(new URL(request.url).searchParams.get('ref') || '').trim();
    if (!UUID_RE.test(ref)) return jsonResponse(NOT_FOUND, 404);
    const order = await loadOrder(env, ref);
    if (!order || order.source !== 'guest') return jsonResponse(NOT_FOUND, 404);

    const addon = isAddon(order);
    const complete = order.raffleNumber != null;
    let number = complete && Number.isFinite(Number(order.raffleNumber)) ? Number(order.raffleNumber) : null;
    const skipped = order.extrasSkipped === true;
    const cancelled = addon && !complete && (order.status === 'cancelled' || skipped);
    // An add-on keeps its own count / total when cancelled (a late payment still counts)
    const extrasCount = skipped && !addon ? 0 : Math.max(0, Math.floor(Number(order.extrasCount) || 0));
    const refunded = order.extrasRefunded === true;

    let freeCount = 0;
    if (!addon) {
      freeCount = Number(order.freeCount);
      if (!(Number.isInteger(freeCount) && freeCount > 0)) {
        // orders from before the snapshot: the event's allowance
        freeCount = maxPhotosFor(await loadEvent(env, order.eventId).catch(() => null));
      }
    }

    if (addon && number == null) {
      // The ticket it joins: the root's number (else the one saved when it was started)
      const root = UUID_RE.test(String(order.addonTo)) ? await loadOrder(env, String(order.addonTo)).catch(() => null) : null;
      number = addonRootNumber(root, order);
      const saved = order.addonNumber == null ? NaN : Number(order.addonNumber);
      if (number == null && Number.isSafeInteger(saved)) number = saved;
    }

    let extrasPaid = order.extrasPaid === true && !refunded;
    if (!extrasPaid && !complete && !refunded && extrasCount > 0) {
      extrasPaid = (await extrasPaymentStatus(env, order)).paid === true;
    }

    return jsonResponse({
      complete,
      number,
      eventId: order.eventId || null,
      freeCount,
      extrasCount,
      extrasTotal: skipped && !addon ? 0 : round2(Number(order.extrasTotal) || 0),
      extrasPaid,
      paymentStarted: orderSessionIds(order).length > 0,
      refunded,
      fullAfterPayment: order.fullAfterPayment === true,
      addon,
      addonTo: addon ? String(order.addonTo) : null,
      cancelled,
      addOn: !addon && complete ? await addOnFor(env, order) : null,
    });
  } catch (err) {
    console.error('guest-status error:', err);
    return jsonResponse({ error: 'Could not check this upload. Please try again.' }, 500);
  }
}
