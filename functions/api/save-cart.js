// functions/api/save-cart.js
// POST /api/save-cart

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { orderId, email, phone, packSize, packType, isRecovery } = body;

    if (!email || !orderId) return new Response("Missing info", { status: 400 });

    const kvKey = `order:${orderId}`;
    
    let order = {};
    const raw = await env.ORDERS_KV.get(kvKey);
    if (raw) {
        order = JSON.parse(raw);
    } else {
        order = { 
            orderId, 
            status: 'draft', 
            createdAt: new Date().toISOString() 
        };
    }

    // FIX: Stronger check to prevent downgrades
    const protectedStatuses = ['paid', 'printing', 'shipped', 'completed', 'abandoned'];
    if (protectedStatuses.includes(order.status)) {
        return new Response("Order already protected", { status: 200 });
    }

    order.email = email;
    order.phone = phone || order.phone;
    order.packSize = packSize || order.packSize;
    order.packType = packType || order.packType;
    order.updatedAt = new Date().toISOString();
    
    if (isRecovery) {
        order.wasRecovered = true;
    }

    await env.ORDERS_KV.put(kvKey, JSON.stringify(order));

    return new Response(JSON.stringify({ ok: true }), { 
        headers: { "Content-Type": "application/json" } 
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}