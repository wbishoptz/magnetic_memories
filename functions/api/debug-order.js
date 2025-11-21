// functions/api/debug-order.js
// GET /api/debug-order?orderId=<uuid>
// Handy debugging endpoint to see exactly what is stored in KV for an order.

export const onRequestGet = async ({ request, env }) => {
  try {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId");

    if (!orderId) {
      return json({ error: "orderId query param is required" }, 400);
    }

    const ordersKV = env.ORDERS_KV;
    if (!ordersKV) {
      return json(
        {
          error:
            "ORDERS_KV binding missing. Check Pages → Settings → Functions → KV namespaces.",
        },
        500
      );
    }

    const key = `order:${orderId}`;
    const raw = await ordersKV.get(key);

    if (!raw) {
      return json({ error: "Order not found in KV", key }, 404);
    }

    // Return the stored JSON as-is
    return new Response(raw, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("debug-order error:", err);
    return json({ error: err.message || "debug-order failed" }, 500);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
