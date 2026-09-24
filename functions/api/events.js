// functions/api/events.js
// Public read endpoint used by the in-field event page (event.html).
//   GET /api/events            -> { events: [{id,name,rangeStart,rangeEnd,active,...}] }
//   GET /api/events?id=EVENT   -> { event: {...}, used: [1,5,12] }  (used raffle numbers)
// Used numbers are shared by staff (manual page) and guest self-uploads.
// The guest upload token is only included for the admin
// (Authorization: Bearer <ADMIN_KEY>), who also gets dbConnected.
// Overlays: the public sees [{ id, name, url }] and the effective overlayMode
// ("off" when there are none); the admin sees the stored overlays (with their
// storage keys) plus a url each, and the stored overlayMode.
import { jsonResponse } from './_shared.js';
import { usedNumbers, hasDb } from './_tickets.js';
import { publicEventView, adminEventView } from './_guest.js';

function isAdminRequest(request, env) {
  return !!env.ADMIN_KEY && request.headers.get('Authorization') === `Bearer ${env.ADMIN_KEY}`;
}

function forViewer(event, admin) {
  if (!event || typeof event !== 'object') return event;
  return admin ? adminEventView(event) : publicEventView(event);
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    const admin = isAdminRequest(request, env);

    if (id) {
      const raw = await env.ORDERS_KV.get(`event:meta:${id}`);
      if (!raw) return jsonResponse({ error: 'Event not found.' }, 404);
      const event = JSON.parse(raw);

      // Already-used raffle numbers for this event (staff + guests)
      const used = await usedNumbers(env, id);
      const out = { event: forViewer(event, admin), used };
      if (admin) out.dbConnected = hasDb(env);
      return jsonResponse(out);
    }

    // List all events
    const list = await env.ORDERS_KV.list({ prefix: 'event:meta:' });
    const values = await Promise.all(list.keys.map(k => env.ORDERS_KV.get(k.name)));
    const events = values
      .map(v => { try { return JSON.parse(v); } catch { return null; } })
      .filter(e => e && typeof e === 'object')
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .map(e => forViewer(e, admin));

    const out = { events };
    if (admin) out.dbConnected = hasDb(env);
    return jsonResponse(out);
  } catch (err) {
    console.error('events read error:', err);
    return jsonResponse({ error: 'Failed to load events.' }, 500);
  }
}
