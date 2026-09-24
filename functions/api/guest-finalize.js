// functions/api/guest-finalize.js
// Public: finish a guest self-upload and give the guest their number.
//   POST { t, orderId, keys?: [r2Key, ...], skipExtras? }  ->  { number, paidExtras? }
// keys may be left out when the order already has its photo list saved
// (pendingKeys, by /api/guest-pay) - that list is used then.
// Possession of the (random UUID) orderId is the authorisation - the link token
// is NOT re-checked, so regenerating the link or switching guest uploads off
// mid-upload doesn't strand someone who has already sent their photos.
// Idempotent: calling again for a finished order returns the same number (and
// leaves the order untouched).
//
// Orders with paid extra magnets: the payment must have arrived (else 402
// { needsPayment: true }), or skipExtras: true finishes with only the free
// photos (409 { alreadyPaid: true } when the extras turn out to be paid).
// Waiting for the team (until an admin resolves it):
//   409 { full: true, paid: true }  paid, but every number went meanwhile
//   409 { refunded: true }          the extras payment was refunded
// The logic lives in _guest.js (completeGuestOrder), shared with the webhook.
import { jsonResponse } from './_shared.js';
import { hasDb, GUEST_MESSAGES } from './_tickets.js';
import { completeGuestOrder } from './_guest.js';

export async function onRequestPost({ request, env }) {
  try {
    if (!hasDb(env)) return jsonResponse({ error: GUEST_MESSAGES['not-setup'] }, 503);

    const body = await request.json().catch(() => null);
    const res = await completeGuestOrder(env, String(body?.orderId || '').trim(), {
      keys: body?.keys,
      skipExtras: body?.skipExtras === true,
    });
    return jsonResponse(res.body, res.status);
  } catch (err) {
    console.error('guest-finalize error:', err);
    return jsonResponse({ error: 'Something went wrong finishing your upload. Please try again.' }, 500);
  }
}
