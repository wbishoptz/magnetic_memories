// functions/api/admin-event.js
// Admin-only create / update / delete of named events.
//   POST { action: 'save', id?, name, rangeStart, rangeEnd, active, perTicketLimit? }
//   POST { action: 'delete', id }
//   POST { action: 'guest', id, guestUpload?: bool, allowRepeat?: bool }  (guest self-upload settings)
//   POST { action: 'regen-token', id }                                    (new guest link; old one stops working)
// Every success response includes dbConnected (events database bound).
//
// Guest links: event meta holds guestToken; KV event:guesttoken:{token} = eventId.
import { jsonResponse } from './_shared.js';
import { hasDb } from './_tickets.js';

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
  return jsonResponse({ success: true, ...body, dbConnected: hasDb(env) });
}

async function loadEvent(env, id) {
  const raw = await env.ORDERS_KV.get(`event:meta:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
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
  const existing = (await loadEvent(env, id)) || {};

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

  const event = {
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
  };

  await env.ORDERS_KV.put(`event:meta:${id}`, JSON.stringify(event));
  return ok(env, { event });
}
