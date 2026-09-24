// functions/api/guest-order.js
// Public: start a guest self-upload.
//   POST { t: TOKEN, count }  ->  { orderId }
// The order is created with status "uploading" and NO number; the number is
// only given out by /api/guest-finalize once every photo has arrived.
// Errors: { error } with 400 / 403 / 409 / 503.
import { jsonResponse } from './_shared.js';
import { hasDb, resolveGuestToken, maxPhotosFor, GUEST_MESSAGES } from './_tickets.js';

const STATUS_FOR_REASON = { invalid: 403, closed: 403, full: 409, 'not-setup': 503 };

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

    const maxPhotos = maxPhotosFor(event);
    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > maxPhotos) {
      return jsonResponse({ error: `Please add between 1 and ${maxPhotos} photo${maxPhotos > 1 ? 's' : ''}.` }, 400);
    }

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
    };

    await env.ORDERS_KV.put(`order:${orderId}`, JSON.stringify(order));
    return jsonResponse({ orderId });
  } catch (err) {
    console.error('guest-order error:', err);
    return jsonResponse({ error: 'Could not start your upload. Please try again.' }, 500);
  }
}
