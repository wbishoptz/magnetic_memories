// functions/api/guest-finalize.js
// Public: finish a guest self-upload and give the guest their number.
//   POST { t, orderId, keys: [r2Key, ...] }  ->  { number }
// Possession of the (random UUID) orderId is the authorisation - the link token
// is NOT re-checked, so regenerating the link or switching guest uploads off
// mid-upload doesn't strand someone who has already sent their photos.
// Idempotent: calling again for a finished order returns the same number (and
// leaves the order untouched).
import { jsonResponse } from './_shared.js';
import { hasDb, allocateNext, maxPhotosFor, GUEST_MESSAGES } from './_tickets.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULL_MSG = 'Sorry - all numbers for this event have been taken.';
const MAX_PHOTO_BYTES = 15 * 1024 * 1024; // same limit as /api/upload for guests

// Every R2 object key under orders/{orderId}/ (all pages)
async function listOrderObjects(env, prefix) {
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
// (leftovers from retried uploads, or a late upload that raced this finalize -
// the admin prints everything under the prefix). Never fails the request.
async function sweepOrphans(env, prefix, wanted) {
  try {
    const orphans = (await listOrderObjects(env, prefix)).filter(k => !wanted.has(k));
    for (let i = 0; i < orphans.length; i += 1000) {
      await env.R2_BUCKET.delete(orphans.slice(i, i + 1000));
    }
  } catch (err) {
    console.error('guest-finalize: orphan cleanup failed:', err);
  }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!hasDb(env)) return jsonResponse({ error: GUEST_MESSAGES['not-setup'] }, 503);

    const body = await request.json().catch(() => null);
    const orderId = String(body?.orderId || '').trim();
    if (!UUID_RE.test(orderId)) return jsonResponse({ error: 'Missing or invalid upload id.' }, 400);

    const kvKey = `order:${orderId}`;
    const raw = await env.ORDERS_KV.get(kvKey);
    let order = null;
    try { order = raw ? JSON.parse(raw) : null; } catch { order = null; }
    if (!order) return jsonResponse({ error: 'Upload not found. Please start again.' }, 404);
    if (order.source !== 'guest') return jsonResponse({ error: 'This is not a guest upload.' }, 403);

    const eventRaw = order.eventId ? await env.ORDERS_KV.get(`event:meta:${order.eventId}`) : null;
    let event = null;
    try { event = eventRaw ? JSON.parse(eventRaw) : null; } catch { event = null; }
    if (!event) return jsonResponse({ error: 'This event no longer exists.' }, 404);

    // Already finished -> same answer again (order, incl. completedAt, untouched)
    if (order.raffleNumber != null) return jsonResponse({ number: Number(order.raffleNumber) });

    // ── Validate the photo list ──────────────────────────────────────
    const maxPhotos = maxPhotosFor(event);
    const keys = body?.keys;
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > maxPhotos) {
      return jsonResponse({ error: `Please send between 1 and ${maxPhotos} photo${maxPhotos > 1 ? 's' : ''}.` }, 400);
    }
    const prefix = `orders/${orderId}/`;
    const wanted = new Set();
    for (const k of keys) {
      if (typeof k !== 'string' || !k.startsWith(prefix) || k.length > 1024 || wanted.has(k)) {
        return jsonResponse({ error: 'Invalid photo list.' }, 400);
      }
      wanted.add(k);
    }
    const heads = await Promise.all(keys.map(k => env.R2_BUCKET.head(k)));
    const missing = [];
    heads.forEach((h, i) => { if (!h) missing.push(i + 1); });
    if (missing.length) {
      return jsonResponse({
        error: `Photo ${missing.join(', ')} didn't finish uploading. Please try again.`,
        missing,
      }, 400);
    }
    // Only JPEG photos (as stored by /api/upload for guests), max 15 MB each
    const invalid = [];
    heads.forEach((h, i) => {
      const type = String((h.httpMetadata && h.httpMetadata.contentType) || '').split(';')[0].trim().toLowerCase();
      const size = Number(h.size);
      if (type !== 'image/jpeg' || !Number.isFinite(size) || size > MAX_PHOTO_BYTES) invalid.push(i + 1);
    });
    if (invalid.length) {
      return jsonResponse({
        error: `Photo ${invalid.join(', ')} isn't a photo we can use. Please choose it again.`,
        invalid,
      }, 400);
    }

    // ── Give out the number (atomic, idempotent per order) ───────────
    const number = await allocateNext(env, event, orderId, 'guest');
    if (number == null) return jsonResponse({ error: FULL_MSG }, 409);

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

    // completedAt = when this completing write happens (the admin's capture order)
    const completedAt = new Date().toISOString();
    order.completedAt = completedAt;
    order.updatedAt = completedAt;
    await env.ORDERS_KV.put(kvKey, JSON.stringify(order));

    // Only now sweep leftovers: an upload that slipped in while we were
    // finishing (after its own "already complete?" check) is removed too.
    await sweepOrphans(env, prefix, wanted);

    // History / back-compat with the legacy KV ticket keys
    try {
      await env.ORDERS_KV.put(`event:ticket:${order.eventId}:${number}`, orderId);
    } catch (err) {
      console.error('guest-finalize: ticket key write failed:', err);
    }

    return jsonResponse({ number });
  } catch (err) {
    console.error('guest-finalize error:', err);
    return jsonResponse({ error: 'Something went wrong finishing your upload. Please try again.' }, 500);
  }
}
