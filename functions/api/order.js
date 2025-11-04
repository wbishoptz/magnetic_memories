// functions/api/order.js

// Handle POST /api/order  → create a new order
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { email, packSize } = body || {};

    // Basic validation
    const validSizes = [3, 6, 9, 12, 15];
    if (!email || !validSizes.includes(packSize)) {
      return new Response(JSON.stringify({ error: "Invalid input" }), { status: 400 });
    }

    // Prices
    const prices = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };

    // Create unique orderId
    const orderId = crypto.randomUUID();

    const order = {
      orderId,
      email,
      packSize,
      price: prices[packSize],
      status: "draft",
      createdAt: new Date().toISOString(),
    };

    // Store order in KV
    await env.ORDERS_KV.put(`order:${orderId}`, JSON.stringify(order));

    return new Response(JSON.stringify({ orderId }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

// Handle GET /api/order?id=...  → return order status
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");

  if (!id) {
    return new Response(JSON.stringify({ error: "Missing id" }), { status: 400 });
  }

  const orderJson = await env.ORDERS_KV.get(`order:${id}`);
  if (!orderJson) {
    return new Response(JSON.stringify({ error: "Order not found" }), { status: 404 });
  }

  const order = JSON.parse(orderJson);

  return new Response(JSON.stringify({ status: order.status || "unknown" }), {
    headers: { "Content-Type": "application/json" },
  });
}
