// functions/api/admin-order-update.js
// POST /api/admin-order-update?key=ADMIN_DASH_KEY
// Body: { orderId: string, status: string }
//
// Updates the status of an order in KV and returns the updated order.

export const onRequestPost = async ({ request, env }) => {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");

    if (!key || key !== env.ADMIN_DASH_KEY) {
      return json({ error: "Unauthorized" }, 401);
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

    const body = await request.json().catch(() => ({}));
    const { orderId, status } = body || {};

    if (!orderId || !status) {
      return json(
        { error: "orderId and status are required in the body" },
        400
      );
    }

    const kvKey = `order:${orderId}`;
    const raw = await ordersKV.get(kvKey);
    if (!raw) {
      return json({ error: "Order not found", orderId }, 404);
    }

    const order = JSON.parse(raw);
    order.status = status;
    order.statusUpdatedAt = new Date().toISOString();

    await ordersKV.put(kvKey, JSON.stringify(order), {
      expirationTtl: 60 * 60 * 24 * 30,
    });

    return json({ order });
  } catch (err) {
    console.error("admin-order-update error:", err);
    return json(
      { error: err.message || "Failed to update order status" },
      500
    );
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
