// functions/api/admin-overlay.js
// Admin-only: add a decorative overlay (transparent PNG/WebP frame) to an event.
//   POST /api/admin-overlay?eventId=ID&name=NAME
//   Authorization: Bearer <ADMIN_KEY>; multipart/form-data field "file"
//   -> { success, event, dbConnected }       errors: { error } 400/401/404/413
// Rules: event must exist, fewer than 8 overlays, <= 5 MB, real PNG or WebP
// (magic bytes), square within 2%, shortest side >= 500 px, longest side
// <= 3000 px (phones decode every design at full size).
// Stored in R2 at event-overlays/{eventId}/{overlayId}.png|.webp and appended to
// the event meta. The first overlay of an event switches overlayMode from "off"
// to "required". Served publicly by /api/event-overlay.
import { jsonResponse } from './_shared.js';
import { hasDb } from './_tickets.js';
import { OVERLAY_MODES, MAX_OVERLAYS, overlayList, adminEventView } from './_guest.js';

const MAX_BYTES = 5 * 1024 * 1024;
const MIN_SIDE = 500;
const MAX_SIDE = 3000;
const SQUARE_TOLERANCE = 0.02;
const NAME_MAX = 40;
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// 8-char base62 id (rejection sampling keeps every character equally likely)
function randomId(len = 8) {
  let out = '';
  while (out.length < len) {
    const bytes = new Uint8Array(len * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < 248 && out.length < len) out += ID_CHARS[b % 62];
    }
  }
  return out;
}

const u32be = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

// -> { type: 'png'|'webp', contentType, w, h } | null (not a PNG/WebP we can read)
export function sniffImage(bytes) {
  const b = bytes;
  // PNG: signature, then the IHDR chunk (width, height as big-endian uint32)
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) {
    if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return { type: 'png', contentType: 'image/png', w: 0, h: 0 };
    return { type: 'png', contentType: 'image/png', w: u32be(b, 16), h: u32be(b, 20) };
  }
  // WebP: "RIFF" size "WEBP", then the first chunk
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const out = { type: 'webp', contentType: 'image/webp', w: 0, h: 0 };
    if (b.length < 30) return out;
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8X') {
      // canvas width-1 / height-1 as 24-bit little-endian at 24 / 27
      out.w = u24le(b, 24) + 1;
      out.h = u24le(b, 27) + 1;
    } else if (chunk === 'VP8L') {
      // lossless: signature 0x2f, then 14 bits width-1, 14 bits height-1
      if (b[20] === 0x2f) {
        const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
        out.w = (bits & 0x3fff) + 1;
        out.h = ((bits >>> 14) & 0x3fff) + 1;
      }
    } else if (chunk === 'VP8 ') {
      // lossy: 3-byte frame tag, start code 9d 01 2a, then 14-bit width / height
      if (b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
        out.w = u16le(b, 26) & 0x3fff;
        out.h = u16le(b, 28) & 0x3fff;
      }
    }
    return out;
  }
  return null;
}

function cleanName(raw, fallback) {
  const s = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (s || fallback).slice(0, NAME_MAX).trim() || fallback;
}

export async function onRequestPost({ request, env }) {
  try {
    const auth = request.headers.get('Authorization')?.replace('Bearer ', '');
    if (!env.ADMIN_KEY || auth !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

    const url = new URL(request.url);
    const eventId = String(url.searchParams.get('eventId') || '').trim();
    if (!eventId || eventId.length > 200) return jsonResponse({ error: 'Missing eventId.' }, 400);

    const metaKey = `event:meta:${eventId}`;
    const loadEvent = async () => {
      const raw = await env.ORDERS_KV.get(metaKey);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    };
    const event = await loadEvent();
    if (!event) return jsonResponse({ error: 'Event not found.' }, 404);
    if (overlayList(event).length >= MAX_OVERLAYS) {
      return jsonResponse({ error: `An event can have at most ${MAX_OVERLAYS} overlays. Delete one first.` }, 400);
    }

    // Refuse obviously oversized bodies before reading them
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES + 64 * 1024) {
      return jsonResponse({ error: 'The overlay file is too big (max 5 MB).' }, 413);
    }
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      return jsonResponse({ error: 'Expected multipart/form-data upload.' }, 400);
    }
    let form;
    try { form = await request.formData(); } catch { return jsonResponse({ error: 'Could not read the upload.' }, 400); }
    const file = form.get('file');
    if (!file || typeof file === 'string') return jsonResponse({ error: 'Missing file upload.' }, 400);
    if (file.size > MAX_BYTES) return jsonResponse({ error: 'The overlay file is too big (max 5 MB).' }, 413);
    if (!(file.size > 0)) return jsonResponse({ error: 'The overlay file is empty.' }, 400);

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) return jsonResponse({ error: 'The overlay file is too big (max 5 MB).' }, 413);
    const info = sniffImage(bytes);
    if (!info) return jsonResponse({ error: 'The overlay must be a PNG or WebP image.' }, 400);
    const { w, h } = info;
    if (!(w > 0 && h > 0)) return jsonResponse({ error: 'Could not read the image size - please re-export the design.' }, 400);
    if (Math.abs(w - h) / Math.max(w, h) > SQUARE_TOLERANCE) {
      return jsonResponse({ error: `The overlay must be square (this one is ${w}×${h} px).` }, 400);
    }
    if (Math.min(w, h) < MIN_SIDE) {
      return jsonResponse({ error: `The overlay is too small (${w}×${h} px) - it needs to be at least ${MIN_SIDE}×${MIN_SIDE} px.` }, 400);
    }
    if (Math.max(w, h) > MAX_SIDE) {
      return jsonResponse({ error: `The overlay is too large (${w}×${h} px) - it can be at most ${MAX_SIDE}×${MAX_SIDE} px. Please export it smaller.` }, 400);
    }

    const existingIds = new Set(overlayList(event).map(o => o.id));
    let id = randomId(8);
    while (existingIds.has(id)) id = randomId(8);
    const key = `event-overlays/${eventId}/${id}.${info.type}`;
    const name = cleanName(url.searchParams.get('name'), `Design ${overlayList(event).length + 1}`);

    await env.R2_BUCKET.put(key, bytes, {
      httpMetadata: { contentType: info.contentType },
      customMetadata: { eventId, overlayId: id },
    });

    // Re-read just before writing (keeps changes made meanwhile), then append.
    const fresh = await loadEvent();
    if (!fresh) {
      try { await env.R2_BUCKET.delete(key); } catch { /* best-effort */ }
      return jsonResponse({ error: 'Event not found.' }, 404);
    }
    const overlays = overlayList(fresh);
    if (overlays.length >= MAX_OVERLAYS) {
      try { await env.R2_BUCKET.delete(key); } catch { /* best-effort */ }
      return jsonResponse({ error: `An event can have at most ${MAX_OVERLAYS} overlays. Delete one first.` }, 400);
    }
    const now = new Date().toISOString();
    overlays.push({ id, name, key, contentType: info.contentType, w, h, bytes: bytes.byteLength, createdAt: now });
    fresh.overlays = overlays;
    const mode = OVERLAY_MODES.includes(fresh.overlayMode) ? fresh.overlayMode : 'off';
    fresh.overlayMode = overlays.length === 1 && mode === 'off' ? 'required' : mode;
    fresh.updatedAt = now;
    await env.ORDERS_KV.put(metaKey, JSON.stringify(fresh));

    return jsonResponse({ success: true, event: adminEventView(fresh), dbConnected: hasDb(env) });
  } catch (err) {
    console.error('admin-overlay error:', err);
    return jsonResponse({ error: 'Could not save the overlay. Please try again.' }, 500);
  }
}
