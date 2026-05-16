// POST /api/admin-basket-flag
// Body: { enabled: bool }
// Authorization: Bearer ADMIN_KEY
// Toggles the basket feature flag in KV — no redeployment needed.

export async function onRequestPost({ request, env }) {
  const key = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }
  try {
    const { enabled } = await request.json();
    await env.ORDERS_KV.put('config:basket_enabled', enabled ? 'true' : 'false');
    return new Response(JSON.stringify({ success: true, basket: !!enabled }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
