// functions/api/guest-order.js
// Public: start a guest self-upload.
//   POST { t: TOKEN, count, expectedPrice?, expectedExtras? }
//     -> { orderId, freeCount, extrasCount, extraPrice, extrasTotal }
// The response is the order's snapshot (what /api/guest-pay will charge) - the
// page shows these numbers, not its own. The order is created with status
// "uploading" and NO number; the number is only given out by
// /api/guest-finalize once every photo has arrived.
//
// Paid extra magnets: count may go over the free allowance (maxPhotosFor) only
// when the event sells extras and count - free <= maxExtras.
//   expectedExtras (optional int): how many extras the page thinks this is.
//     If it differs from the server's count (the free allowance changed) ->
//     409 { error, limitsChanged: true, freePhotos, extras: { price, max } | null }
//     (also when the count is now over the limit)
//   expectedPrice must match the current price per extra to the penny, else
//     409 { error, priceChanged: true, price }
// The price is snapshotted on the order (what /api/guest-pay charges).
// Errors: { error } with 400 / 403 / 409 / 503.
import { jsonResponse } from './_shared.js';
import { hasDb, resolveGuestToken, maxPhotosFor, GUEST_MESSAGES } from './_tickets.js';
import { extrasConfig, toPence, round2, formatGBP } from './_guest.js';

const STATUS_FOR_REASON = { invalid: 403, closed: 403, full: 409, 'not-setup': 503 };
const LIMITS_CHANGED_MSG = 'The number of free photos for this event has changed.';

// Optional non-negative integer (number or numeric string). -> int | null (not
// sent) | NaN (sent but not a valid count)
function parseExpectedExtras(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'object') return NaN;
  const s = String(value).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : NaN;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!hasDb(env)) return jsonResponse({ error: GUEST_MESSAGES['not-setup'] }, 503);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return jsonResponse({ error: 'Bad request.' }, 400);

    const state = await resolveGuestToken(env, body.t);
    if (!state.open) {
      return jsonResponse({ error: GUEST_MESSAGES[state.reason] }, STATUS_FOR_REASON[state.reason] || 403);
    }
    const event = state.event;

    const freeCount = maxPhotosFor(event);
    const extras = extrasConfig(event);
    const maxPhotos = freeCount + (extras ? extras.max : 0);
    const expectedExtras = parseExpectedExtras(body.expectedExtras);
    if (Number.isNaN(expectedExtras)) return jsonResponse({ error: 'Bad request.' }, 400);
    const limitsChanged = () => jsonResponse({
      error: LIMITS_CHANGED_MSG,
      limitsChanged: true,
      freePhotos: freeCount,
      extras,
    }, 409);

    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > maxPhotos) {
      // The page worked the count out from limits that have since changed
      if (expectedExtras != null && Number.isInteger(count) && count > maxPhotos) return limitsChanged();
      return jsonResponse({ error: `Please add between 1 and ${maxPhotos} photo${maxPhotos > 1 ? 's' : ''}.` }, 400);
    }

    const extrasCount = Math.max(0, count - freeCount);
    if (expectedExtras != null && expectedExtras !== extrasCount) return limitsChanged();
    if (extrasCount > 0) {
      // extras is non-null here (count <= freeCount otherwise)
      const expected = body.expectedPrice;
      const expectedNum = typeof expected === 'number' ? expected : Number(String(expected ?? '').trim());
      if (expected == null || expected === '' || !Number.isFinite(expectedNum)
          || toPence(expectedNum) !== toPence(extras.price)) {
        return jsonResponse({
          error: `The price for extra magnets is now ${formatGBP(extras.price)}.`,
          priceChanged: true,
          price: extras.price,
        }, 409);
      }
    }
    const extraPrice = extrasCount > 0 ? extras.price : null;

    const orderId = crypto.randomUUID();
    const now = new Date().toISOString();
    const order = {
      orderId,
      email: `guest-${event.id}-${orderId.slice(0, 8)}@event.local`,
      phone: '00000000',
      packSize: count,
      packType: 'standard',
      price: 0,
      event: 'MANUAL',
      eventId: event.id,
      source: 'guest',
      raffleNumber: null,
      productType: 'standard',
      status: 'uploading',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      images: [],
      stripeSessionId: null,
      recoverySent: false,
      shippingMethod: 'COLLECT',
      basketDraft: false,
      // Paid extra magnets (snapshot at order time)
      freeCount,
      extrasCount,
      extraPrice,
      extrasTotal: extrasCount > 0 ? round2((extrasCount * toPence(extraPrice)) / 100) : 0,
      extrasPaid: false,
      extrasSessionId: null,
      extrasSkipped: false,
      pendingKeys: null,
    };

    await env.ORDERS_KV.put(`order:${orderId}`, JSON.stringify(order));
    return jsonResponse({
      orderId,
      freeCount: order.freeCount,
      extrasCount: order.extrasCount,
      extraPrice: order.extraPrice,
      extrasTotal: order.extrasTotal,
    });
  } catch (err) {
    console.error('guest-order error:', err);
    return jsonResponse({ error: 'Could not start your upload. Please try again.' }, 500);
  }
}
