// functions/api/events.js
// Public read endpoint used by the in-field event page (event.html).
//   GET /api/events            -> { events: [{id,name,rangeStart,rangeEnd,active}] }
//   GET /api/events?id=EVENT   -> { event: {...}, used: [1,5,12] }  (used raffle numbers)
import { jsonResponse } from './_shared.js';

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');

    if (id) {
      const raw = await env.ORDERS_KV.get(`event:meta:${id}`);
      if (!raw) return jsonResponse({ error: 'Event not found.' }, 404);
      const event = JSON.parse(raw);

      // Collect already-used raffle numbers for this event
      const used = [];
      const list = await env.ORDERS_KV.list({ prefix: `event:ticket:${id}:` });
      for (const k of list.keys) {
        const n = Number(k.name.split(':').pop());
        if (!Number.isNaN(n)) used.push(n);
      }
      used.sort((a, b) => a - b);
      return jsonResponse({ event, used });
    }

    // List all events
    const list = await env.ORDERS_KV.list({ prefix: 'event:meta:' });
    const values = await Promise.all(list.keys.map(k => env.ORDERS_KV.get(k.name)));
    const events = values
      .map(v => { try { return JSON.parse(v); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return jsonResponse({ events });
  } catch (err) {
    console.error('events read error:', err);
    return jsonResponse({ error: 'Failed to load events.' }, 500);
  }
}
