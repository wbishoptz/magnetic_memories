// GET /api/feature-flags
// Returns { basket: bool }
// Controlled via config:basket_enabled in ORDERS_KV — instant toggle, no redeployment needed.

export async function onRequestGet({ env }) {
  try {
    const val = await env.ORDERS_KV.get('config:basket_enabled');
    return new Response(JSON.stringify({ basket: val === 'true' }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ basket: false }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
