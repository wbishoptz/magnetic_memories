// functions/api/guest-status.js
// Public: where a guest upload stands - used by the guest page when it comes
// back from Stripe (?ref=ORDER_ID) without its saved state (other browser,
// storage blocked).
//   GET /api/guest-status?ref=ORDER_UUID
//     -> { complete, number (int|null), eventId, freeCount, extrasCount,
//          extrasTotal, extrasPaid, paymentStarted, refunded, fullAfterPayment }
//     -> 404 { error } unknown id / not a guest upload
// Possession of the (random UUID) order id is the authorisation, as for
// /api/guest-finalize. Nothing personal is returned (no email, photo keys or
// Stripe ids). extrasPaid may ask Stripe (every session made for the order).
import { jsonResponse } from './_shared.js';
import { maxPhotosFor } from './_tickets.js';
import { UUID_RE, loadOrder, loadEvent, extrasPaymentStatus, orderSessionIds, round2 } from './_guest.js';

const NOT_FOUND = { error: 'Upload not found.' };

export async function onRequestGet({ request, env }) {
  try {
    const ref = String(new URL(request.url).searchParams.get('ref') || '').trim();
    if (!UUID_RE.test(ref)) return jsonResponse(NOT_FOUND, 404);
    const order = await loadOrder(env, ref);
    if (!order || order.source !== 'guest') return jsonResponse(NOT_FOUND, 404);

    const complete = order.raffleNumber != null;
    const number = complete && Number.isFinite(Number(order.raffleNumber)) ? Number(order.raffleNumber) : null;
    const skipped = order.extrasSkipped === true;
    const extrasCount = skipped ? 0 : Math.max(0, Math.floor(Number(order.extrasCount) || 0));
    const refunded = order.extrasRefunded === true;

    let freeCount = Number(order.freeCount);
    if (!(Number.isInteger(freeCount) && freeCount > 0)) {
      // orders from before the snapshot: the event's allowance
      freeCount = maxPhotosFor(await loadEvent(env, order.eventId).catch(() => null));
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
      extrasTotal: skipped ? 0 : round2(Number(order.extrasTotal) || 0),
      extrasPaid,
      paymentStarted: orderSessionIds(order).length > 0,
      refunded,
      fullAfterPayment: order.fullAfterPayment === true,
    });
  } catch (err) {
    console.error('guest-status error:', err);
    return jsonResponse({ error: 'Could not check this upload. Please try again.' }, 500);
  }
}
