// functions/api/debug-order.js
// GET /api/debug-order?orderId=<uuid>
// Handy debugging endpoint to see exactly what is stored in KV for an order.

export const onRequestGet = async ({ request, env }) => {
  try {
    const url = new URL(request.url);

    // Require the admin key (header or ?key=) — this exposes full customer data
    const authKey = request.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("key");
    if (authKey !== env.ADMIN_KEY && authKey !== env.ADMIN_DASH_KEY) {
      return json({ error: "Unauthorized" }, 401);
    }

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
