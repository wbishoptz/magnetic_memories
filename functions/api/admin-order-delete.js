// functions/api/admin-order-delete.js
// POST /api/admin-order-delete

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { key, orderId } = body;

    // 1. Security Check
    // We assume you have set ADMIN_KEY in your Cloudflare Env Variables.
    // If you are using a hardcoded key in your code, replace env.ADMIN_KEY below with "your-secret-key"
    if (!key || key !== env.ADMIN_KEY) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!orderId) {
      return new Response(JSON.stringify({ error: "Missing orderId" }), { status: 400 });
    }

    // 2. Delete from Database (KV)
    const kvKey = `order:${orderId}`;
    await env.ORDERS_KV.delete(kvKey);

    // Note: This does not delete the images from R2 storage (to stay safe),
    // but it removes the order record so it vanishes from your Admin list.

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("Delete error:", err);
    return new Response(JSON.stringify({ error: "Server error" }), { status: 500 });
  }
}