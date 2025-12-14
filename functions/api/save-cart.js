// functions/api/save-cart.js
// POST /api/save-cart
// Saves a "draft" order to KV so we can recover it later.

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { orderId, email, phone, packSize, packType } = body;

    if (!email || !orderId) return new Response("Missing info", { status: 400 });

    const kvKey = `order:${orderId}`;
    
    // 1. Check if order exists
    let order = {};
    const raw = await env.ORDERS_KV.get(kvKey);
    if (raw) {
        order = JSON.parse(raw);
    } else {
        // New Draft
        order = { 
            orderId, 
            status: 'draft', 
            createdAt: new Date().toISOString() 
        };
    }

    // 2. Only update if it's still in draft mode (don't overwrite paid orders)
    if (order.status !== 'draft' && order.status !== 'abandoned') {
        return new Response("Order already processed", { status: 200 });
    }

    // 3. Update fields
    order.email = email;
    order.phone = phone || order.phone;
    order.packSize = packSize || order.packSize;
    order.packType = packType || order.packType;
    order.updatedAt = new Date().toISOString();

    await env.ORDERS_KV.put(kvKey, JSON.stringify(order));

    return new Response(JSON.stringify({ ok: true }), { 
        headers: { "Content-Type": "application/json" } 
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}