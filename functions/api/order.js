// functions/api/order.js
//
// GET /api/order?orderId=...   (or ?id=...)
// Returns a single order JSON from ORDERS_KV

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const orderId =
    url.searchParams.get("orderId") || url.searchParams.get("id");

  if (!orderId) {
    return new Response(
      JSON.stringify({ error: "Missing orderId query parameter" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  try {
    // Use proper KV key prefix
    const key = `order:${orderId}`;
    const raw = await env.ORDERS_KV.get(key);

    if (!raw) {
      return new Response(JSON.stringify({ error: "Order not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // raw is already JSON string
    return new Response(raw, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error reading order from KV", err);
    return new Response(
      JSON.stringify({ error: "Internal error loading order" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
