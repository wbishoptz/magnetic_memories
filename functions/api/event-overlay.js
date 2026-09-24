// functions/api/event-overlay.js
// Public: serve one of an event's overlay images (used by the guest and staff
// pages to draw the design onto photos).
//   GET /api/event-overlay?e=EVENT_ID&id=OVERLAY_ID
// The overlay is looked up in the event meta - a raw storage key is never
// accepted. Only PNG / WebP are served; everything else is 404.
// Overlay ids are never reused, so the response is cached as immutable.

const CSP = "default-src 'none'; sandbox";
const ALLOWED = new Set(['image/png', 'image/webp']);

function notFound() {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const eventId = String(url.searchParams.get('e') || '');
    const overlayId = String(url.searchParams.get('id') || '');
    if (!eventId || eventId.length > 200 || !/^[A-Za-z0-9]{8}$/.test(overlayId)) return notFound();

    const raw = await env.ORDERS_KV.get(`event:meta:${eventId}`);
    if (!raw) return notFound();
    let event;
    try { event = JSON.parse(raw); } catch { return notFound(); }
    const overlay = (Array.isArray(event && event.overlays) ? event.overlays : []).find(o => o && o.id === overlayId);
    if (!overlay || typeof overlay.key !== 'string' || !overlay.key.startsWith(`event-overlays/${eventId}/`)) return notFound();

    const obj = await env.R2_BUCKET.get(overlay.key);
    if (!obj) return notFound();
    const type = String(overlay.contentType || (obj.httpMetadata && obj.httpMetadata.contentType) || '')
      .split(';')[0].trim().toLowerCase();
    if (!ALLOWED.has(type)) return notFound();

    const headers = new Headers();
    headers.set('Content-Type', type);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', CSP);
    if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
    return new Response(obj.body, { headers });
  } catch (err) {
    console.error('event-overlay error:', err);
    return new Response('Error', { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
