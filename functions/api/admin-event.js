// functions/api/admin-event.js
// Admin-only create / update / delete of named events.
//   POST { action: 'save', id?, name, rangeStart, rangeEnd, active }
//   POST { action: 'delete', id }
import { jsonResponse } from './_shared.js';

function slugify(str) {
  return String(str).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'event';
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
    await env.ORDERS_KV.delete(`event:meta:${id}`);
    // Note: ticket reservations + orders are left intact for history.
    return jsonResponse({ success: true, deleted: id });
  }

  // save (create or update)
  const name = String(body?.name || '').trim();
  if (!name) return jsonResponse({ error: 'Event name is required.' }, 400);

  const rangeStart = Number(body?.rangeStart);
  const rangeEnd = Number(body?.rangeEnd);
  if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) || rangeStart < 0 || rangeEnd < rangeStart) {
    return jsonResponse({ error: 'Invalid ticket range.' }, 400);
  }
  if (rangeEnd - rangeStart > 5000) {
    return jsonResponse({ error: 'Ticket range too large (max 5000).' }, 400);
  }

  const id = body?.id || slugify(name);
  const existingRaw = await env.ORDERS_KV.get(`event:meta:${id}`);
  const existing = existingRaw ? JSON.parse(existingRaw) : {};

  // Per-ticket photo limit (0 = unlimited). Preserve existing when not provided.
  let perTicketLimit = existing.perTicketLimit || 0;
  if (body?.perTicketLimit !== undefined) {
    const n = Number(body.perTicketLimit);
    perTicketLimit = (Number.isInteger(n) && n > 0) ? n : 0;
  }

  const event = {
    id,
    name,
    rangeStart,
    rangeEnd,
    perTicketLimit,
    active: body?.active !== undefined ? !!body.active : (existing.active !== undefined ? existing.active : true),
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await env.ORDERS_KV.put(`event:meta:${id}`, JSON.stringify(event));
  return jsonResponse({ success: true, event });
}
