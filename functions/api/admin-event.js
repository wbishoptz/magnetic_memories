// functions/api/admin-event.js
// Admin-only create / update / delete of named events.
//   POST { action: 'save', id?, name, rangeStart, rangeEnd, active, perTicketLimit? }
//   POST { action: 'delete', id }
//   POST { action: 'guest', id, guestUpload?: bool, allowRepeat?: bool }  (guest self-upload settings)
//   POST { action: 'regen-token', id }                                    (new guest link; old one stops working)
//   POST { action: 'overlay-mode', id, overlayMode: 'off'|'optional'|'required' }
//   POST { action: 'overlay-delete', id, overlayId }
//   POST { action: 'extras', id, extrasEnabled?, extraPrice?, maxExtras? } (paid extra magnets)
// Every success response is { success, event?, dbConnected } (dbConnected =
// events database bound). Overlays are uploaded by /api/admin-overlay.
//
// Guest links: event meta holds guestToken; KV event:guesttoken:{token} = eventId.
// "save" keeps overlays / overlayMode and the paid-extras settings as they are.
import { jsonResponse } from './_shared.js';
import { hasDb, usedNumbersStrict } from './_tickets.js';
import {
  OVERLAY_MODES, overlayList, adminEventView,
  parseExtraPrice, parseMaxExtras, MAX_EXTRAS_DEFAULT, EXTRA_PRICE_MIN, EXTRA_PRICE_MAX, MAX_EXTRAS_LIMIT,
} from './_guest.js';

const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function slugify(str) {
  return String(str).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'event';
}

// 12-char base62 token (rejection sampling keeps every character equally likely)
function randomToken(len = 12) {
  let out = '';
  while (out.length < len) {
    const bytes = new Uint8Array(len * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < 248 && out.length < len) out += TOKEN_CHARS[b % 62];
    }
  }
  return out;
}

async function newGuestToken(env) {
  for (let i = 0; i < 5; i++) {
    const t = randomToken(12);
    if (!(await env.ORDERS_KV.get(`event:guesttoken:${t}`))) return t;
  }
  return randomToken(12);
}

function ok(env, body) {
  const out = { success: true, ...body, dbConnected: hasDb(env) };
  if (out.event) out.event = adminEventView(out.event);
  return jsonResponse(out);
}

async function loadEvent(env, id) {
  const raw = await env.ORDERS_KV.get(`event:meta:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Defaults for the overlay / paid-extras fields (older events have none).
function withFeatureDefaults(event) {
  const maxExtras = parseMaxExtras(event.maxExtras);
  return {
    ...event,
    overlays: overlayList(event),
    overlayMode: OVERLAY_MODES.includes(event.overlayMode) ? event.overlayMode : 'off',
    extrasEnabled: event.extrasEnabled === true,
    extraPrice: parseExtraPrice(event.extraPrice),
    maxExtras: maxExtras ?? MAX_EXTRAS_DEFAULT,
  };
}

// Remove an event's overlay images from R2 (best-effort).
async function deleteOverlayObjects(env, eventId, overlays) {
  const prefix = `event-overlays/${eventId}/`;
  const keys = new Set(overlays.map(o => o && o.key).filter(k => typeof k === 'string' && k.startsWith(prefix)));
  try {
    const listed = await env.R2_BUCKET.list({ prefix });
    for (const obj of (listed && listed.objects) || []) keys.add(obj.key);
  } catch (err) {
    console.error('admin-event: overlay listing failed:', err);
  }
  if (!keys.size) return;
  try {
    await env.R2_BUCKET.delete([...keys]);
  } catch (err) {
    console.error('admin-event: overlay delete failed:', err);
  }
}

export async function onRequestPost({ request, env }) {
  const key = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Bad JSON' }, 400); }

  const action = body?.action || 'save';

  if (action === 'delete') {
    const id = body?.id;
    if (!id) return jsonResponse({ error: 'Missing id.' }, 400);
    const existing = await loadEvent(env, id);
    await env.ORDERS_KV.delete(`event:meta:${id}`);
    if (existing?.guestToken) await env.ORDERS_KV.delete(`event:guesttoken:${existing.guestToken}`);
    await deleteOverlayObjects(env, id, existing ? overlayList(existing) : []);
    // Note: ticket reservations + orders are left intact for history.
    return ok(env, { deleted: id });
  }

  if (action === 'guest' || action === 'regen-token') {
    const id = body?.id;
    if (!id) return jsonResponse({ error: 'Missing id.' }, 400);
    const event = await loadEvent(env, id);
    if (!event) return jsonResponse({ error: 'Event not found.' }, 404);

    event.guestUpload = event.guestUpload === true;
    event.allowRepeat = event.allowRepeat === true;
    event.guestToken = event.guestToken || null;

    let oldToken = null;
    if (action === 'guest') {
      if (body?.guestUpload !== undefined) event.guestUpload = !!body.guestUpload;
      if (body?.allowRepeat !== undefined) event.allowRepeat = !!body.allowRepeat;
      if (event.guestUpload && !event.guestToken) event.guestToken = await newGuestToken(env);
    } else {
      oldToken = event.guestToken;
      event.guestToken = await newGuestToken(env);
    }
    event.updatedAt = new Date().toISOString();

    // Mapping first, then meta (a guest link is only valid when both agree),
    // then retire the old link.
    if (event.guestToken) await env.ORDERS_KV.put(`event:guesttoken:${event.guestToken}`, id);
    await env.ORDERS_KV.put(`event:meta:${id}`, JSON.stringify(event));
    if (oldToken && oldToken !== event.guestToken) {
      await env.ORDERS_KV.delete(`event:guesttoken:${oldToken}`);
    }
    return ok(env, { event });
  }

  if (action === 'overlay-mode' || action === 'overlay-delete' || action === 'extras') {
    const id = body?.id;
    if (!id) return jsonResponse({ error: 'Missing id.' }, 400);
    const stored = await loadEvent(env, id);
    if (!stored) return jsonResponse({ error: 'Event not found.' }, 404);
    const event = withFeatureDefaults(stored);

    if (action === 'overlay-mode') {
      const mode = body?.overlayMode;
      if (!OVERLAY_MODES.includes(mode)) {
        return jsonResponse({ error: 'Overlay mode must be "off", "optional" or "required".' }, 400);
      }
      event.overlayMode = mode;
    } else if (action === 'overlay-delete') {
      const overlayId = String(body?.overlayId || '');
      const target = event.overlays.find(o => o.id === overlayId);
      if (!overlayId || !target) return jsonResponse({ error: 'Overlay not found.' }, 404);
      event.overlays = event.overlays.filter(o => o.id !== overlayId);
      // overlayMode is kept as is: with no overlays left the effective mode is "off".
      if (typeof target.key === 'string' && target.key.startsWith(`event-overlays/${id}/`)) {
        try { await env.R2_BUCKET.delete(target.key); } catch (err) {
          console.error('admin-event: overlay object delete failed:', err);
        }
      }
    } else {
      // Paid extra magnets
      if (body?.extraPrice !== undefined) {
        if (body.extraPrice === null || body.extraPrice === '') {
          event.extraPrice = null;
        } else {
          const price = parseExtraPrice(body.extraPrice);
          if (price == null) {
            return jsonResponse({
              error: `Enter a price per extra magnet between £${EXTRA_PRICE_MIN.toFixed(2)} and £${EXTRA_PRICE_MAX.toFixed(2)} (e.g. 3.00).`,
            }, 400);
          }
          event.extraPrice = price;
        }
      }
      if (body?.maxExtras !== undefined) {
        const max = parseMaxExtras(body.maxExtras);
        if (max == null) {
          return jsonResponse({ error: `Max extras per guest must be a whole number from 1 to ${MAX_EXTRAS_LIMIT}.` }, 400);
        }
        event.maxExtras = max;
      }
      if (body?.extrasEnabled !== undefined) event.extrasEnabled = !!body.extrasEnabled;
      if (event.extrasEnabled) {
        const lim = Number(event.perTicketLimit);
        if (!(Number.isInteger(lim) && lim > 0)) {
          return jsonResponse({ error: 'Set how many free photos each guest gets first.' }, 400);
        }
        if (event.extraPrice == null) {
          return jsonResponse({ error: 'Enter a price per extra magnet.' }, 400);
        }
      }
    }

    event.updatedAt = new Date().toISOString();
    await env.ORDERS_KV.put(`event:meta:${id}`, JSON.stringify(event));
    return ok(env, { event });
  }

  if (action !== 'save') return jsonResponse({ error: 'Unknown action.' }, 400);

  // save (create or update)
  // Updating an existing event (body.id): anything not sent keeps its stored value.
  // The event id - and with it the guest link / QR code - never changes.
  const byId = body?.id ? await loadEvent(env, String(body.id)) : null;
  const startSent = body?.rangeStart !== undefined, endSent = body?.rangeEnd !== undefined;
  if (startSent !== endSent) return jsonResponse({ error: 'Send both the first and the last ticket number.' }, 400);
  if (body?.id && !byId && (!startSent || body?.name == null)) {
    return jsonResponse({ error: 'Event not found - it may have been deleted. Refresh the list.' }, 404);
  }

  const name = String(body?.name ?? (byId ? byId.name : '')).trim();
  if (!name) return jsonResponse({ error: 'Event name is required.' }, 400);

  // The range of an EXISTING event only changes on an explicit range edit (rangeEdit:
  // true, sent by the admin's Ticket Range editor). Older admin pages still send the
  // range they loaded with every Set Active / photo-limit save - ignoring it means a tab
  // left open from before a range edit can never quietly put the old range back.
  const applyRange = startSent && (!byId || body?.rangeEdit === true);
  if (!applyRange && !byId) return jsonResponse({ error: 'Invalid ticket range.' }, 400);
  const rangeStart = Number(applyRange ? body.rangeStart : byId.rangeStart);
  const rangeEnd = Number(applyRange ? body.rangeEnd : byId.rangeEnd);
  if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) || rangeStart < 0 || rangeEnd < rangeStart) {
    return jsonResponse({ error: 'Invalid ticket range.' }, 400);
  }
  if (rangeEnd - rangeStart > 5000) {
    return jsonResponse({ error: 'Ticket range too large (max 5000).' }, 400);
  }

  let id = body?.id ? String(body.id) : null;
  if (!id) {
    // Creating: never merge into an existing event. The same name is refused; a
    // different name that happens to make the same id gets the next free one (-2, -3…).
    const base = slugify(name);
    id = base;
    for (let i = 2; ; i++) {
      const clash = await loadEvent(env, id);
      if (!clash) break;
      if (String(clash.name || '').trim().toLowerCase() === name.toLowerCase()) {
        return jsonResponse({ error: `An event called "${clash.name}" already exists - open it in the list to change its settings.` }, 409);
      }
      if (i > 50) return jsonResponse({ error: 'Too many events with a similar name - please choose a different name.' }, 409);
      id = `${base}-${i}`;
    }
  }
  const existing = byId || {};

  // Changing the range of an event that's already running: numbers already given out
  // are never taken away. If some would newly fall outside the new range the admin must
  // confirm them (they keep their numbers and still print; new numbers come from the new
  // range). dryRun: true answers the same checks without saving, so the admin can show
  // every warning before anything changes.
  const changed = !!existing.id && (rangeStart !== Number(existing.rangeStart) || rangeEnd !== Number(existing.rangeEnd));
  let rangeInfo = null, newlyOutside = [];
  if (changed) {
    let used;
    try { used = await usedNumbersStrict(env, id); } catch (err) {
      console.error('admin-event: could not read used numbers:', err);
      return jsonResponse({ error: 'Could not check which numbers are already used - please try again in a moment.' }, 503);
    }
    const outside = used.filter(n => n < rangeStart || n > rangeEnd);
    const inside = used.length - outside.length;
    rangeInfo = { used: used.length, outside: outside.length, free: (rangeEnd - rangeStart + 1) - inside };
    // Only numbers this change newly leaves out need confirming (ones already outside
    // the old range were accepted before - no need to ask again on every edit).
    const oldStart = Number(existing.rangeStart), oldEnd = Number(existing.rangeEnd);
    newlyOutside = outside.filter(n => n >= oldStart && n <= oldEnd);
  }
  if (body?.dryRun === true) {
    if (!existing.id) return jsonResponse({ error: 'Event not found.' }, 404);
    return ok(env, { dryRun: true, changed, rangeInfo, outOfRange: newlyOutside, event: existing });
  }
  if (newlyOutside.length) {
    // confirmOutOfRange: true = all of them, or the list the admin was shown (anything
    // that became outside since then must be confirmed again)
    const confirmed = body?.confirmOutOfRange === true ? null
      : new Set((Array.isArray(body?.confirmOutOfRange) ? body.confirmOutOfRange : []).map(Number));
    const unconfirmed = confirmed ? newlyOutside.filter(n => !confirmed.has(n)) : [];
    if (unconfirmed.length) {
      const list = unconfirmed.slice(0, 10).map(n => '#' + n).join(', ') + (unconfirmed.length > 10 ? ` and ${unconfirmed.length - 10} more` : '');
      return jsonResponse({
        error: `${unconfirmed.length} ticket${unconfirmed.length === 1 ? ' already has a number' : 's already have numbers'} outside ${rangeStart}–${rangeEnd}: ${list}.`,
        needsConfirm: true, outOfRange: unconfirmed, rangeInfo,
      }, 409);
    }
  }

  // Per-ticket photo limit (0 = unlimited). Preserve existing when not provided.
  let perTicketLimit = existing.perTicketLimit || 0;
  if (body?.perTicketLimit !== undefined) {
    const n = Number(body.perTicketLimit);
    perTicketLimit = (Number.isInteger(n) && n > 0) ? n : 0;
  }

  // Guest self-upload settings: preserved unless explicitly provided
  // (the Set Active/Inactive toggle only sends id/name/range/active).
  const guestUpload = body?.guestUpload !== undefined ? !!body.guestUpload : existing.guestUpload === true;
  const allowRepeat = body?.allowRepeat !== undefined ? !!body.allowRepeat : existing.allowRepeat === true;
  let guestToken = existing.guestToken || null;
  if (guestUpload && !guestToken) {
    guestToken = await newGuestToken(env);
    await env.ORDERS_KV.put(`event:guesttoken:${guestToken}`, id);
  }

  // Overlays and paid-extras settings are only changed by their own actions:
  // whatever the body says about them, the stored values are kept.
  const event = withFeatureDefaults({
    ...existing,
    id,
    name,
    rangeStart,
    rangeEnd,
    perTicketLimit,
    active: body?.active !== undefined ? !!body.active : (existing.active !== undefined ? existing.active : true),
    guestUpload,
    guestToken,
    allowRepeat,
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await env.ORDERS_KV.put(`event:meta:${id}`, JSON.stringify(event));
  return ok(env, rangeInfo ? { event, rangeInfo } : { event });
}
