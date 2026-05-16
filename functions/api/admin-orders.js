// functions/api/admin-orders.js
// GET /api/admin-orders?key=...

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const targetId = url.searchParams.get("orderId");
  const key = request.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("key");

  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  // Case 1: Get Single Order Details (Full Object)
  if (targetId) {
    const raw = await env.ORDERS_KV.get(`order:${targetId}`);
    if (!raw) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    return new Response(JSON.stringify({ order: JSON.parse(raw) }));
  }

  // Case 2: List All Orders (Summary)
  try {
    const list = await env.ORDERS_KV.list({ prefix: "order:" });
    
    // Fetch all values in parallel
    const values = await Promise.all(list.keys.map(k => env.ORDERS_KV.get(k.name)));

    const orders = values
      .map(v => {
        try {
          const o = JSON.parse(v);
          return {
            orderId: o.orderId,
            email: o.email,
            phone: o.phone,
            status: o.status,
            createdAt: o.createdAt,
            packSize: o.packSize,
            packType: o.packType || 'standard',
            productType: o.productType,
            frameStyle: o.frameStyle,
            frameSize: o.frameSize,
            mothersPackage: o.mothersPackage,
            price: o.price,
            wasRecovered: o.wasRecovered,
            usedVoucher: o.usedVoucher,
            // NEW: Pass this flag so Admin knows if email was sent
            recoverySent: o.recoverySent || (o.status === 'abandoned') 
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return new Response(JSON.stringify({ orders }));
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}