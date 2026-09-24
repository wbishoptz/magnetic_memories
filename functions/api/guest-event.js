// functions/api/guest-event.js
// Public: what a guest self-upload link (/guest?t=TOKEN) points at.
//   GET /api/guest-event?t=TOKEN
//     -> { open: true, event: { id, name, perTicketLimit, allowRepeat, maxPhotos,
//                               freePhotos, extras: { price, max } | null,
//                               overlays: [{ id, name, url }], overlayMode } }
//     -> { open: false, reason: "invalid" | "closed" | "full" | "not-setup", event?: { id, name }, error }
// freePhotos (= maxPhotos, kept for older pages) is the free allowance; extras
// is set only while paid extra magnets are available. overlayMode is the
// effective mode ("off" when there are no overlays). Never returns the token,
// range details or overlay storage keys.
import { jsonResponse } from './_shared.js';
import { resolveGuestToken, maxPhotosFor, GUEST_MESSAGES } from './_tickets.js';
import { extrasConfig, publicOverlays, effectiveOverlayMode } from './_guest.js';

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const state = await resolveGuestToken(env, url.searchParams.get('t'));

    if (!state.open) {
      const out = { open: false, reason: state.reason, error: GUEST_MESSAGES[state.reason] };
      if (state.event) out.event = { id: state.event.id, name: state.event.name };
      return jsonResponse(out);
    }

    const ev = state.event;
    const perTicketLimit = Number(ev.perTicketLimit) > 0 ? Number(ev.perTicketLimit) : 0;
    const freePhotos = maxPhotosFor(ev);
    return jsonResponse({
      open: true,
      event: {
        id: ev.id,
        name: ev.name,
        perTicketLimit,
        allowRepeat: ev.allowRepeat === true,
        maxPhotos: freePhotos,
        freePhotos,
        extras: extrasConfig(ev),
        overlays: publicOverlays(ev),
        overlayMode: effectiveOverlayMode(ev),
      },
    });
  } catch (err) {
    console.error('guest-event error:', err);
    return jsonResponse({ error: 'Could not load this event. Please try again.' }, 500);
  }
}
