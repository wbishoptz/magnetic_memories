// functions/api/guest-event.js
// Public: what a guest self-upload link (/guest?t=TOKEN) points at.
//   GET /api/guest-event?t=TOKEN
//     -> { open: true, event: { id, name, perTicketLimit, allowRepeat, maxPhotos } }
//     -> { open: false, reason: "invalid" | "closed" | "full" | "not-setup", event?: { id, name }, error }
// Never returns the token or range details.
import { jsonResponse } from './_shared.js';
import { resolveGuestToken, maxPhotosFor, GUEST_MESSAGES } from './_tickets.js';

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
    return jsonResponse({
      open: true,
      event: {
        id: ev.id,
        name: ev.name,
        perTicketLimit,
        allowRepeat: ev.allowRepeat === true,
        maxPhotos: maxPhotosFor(ev),
      },
    });
  } catch (err) {
    console.error('guest-event error:', err);
    return jsonResponse({ error: 'Could not load this event. Please try again.' }, 500);
  }
}
