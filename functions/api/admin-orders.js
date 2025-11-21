// functions/api/admin-orders.js
// GET /api/admin-orders
//    -> ?key=ADMIN_DASH_KEY          (required)
//    -> optional ?orderId=<uuid>     (for full details of a single order)

export const onRequestGet = async ({ request, env }) => {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const orderId = url.searchParams.get("orderId");

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

    // Single order
    if (orderId) {
      const kvKey = `order:${orderId}`;
      const raw = await ordersKV.get(kvKey);
      if (!raw) {
        return json({ error: "Order not found", orderId }, 404);
      }

      const order = JSON.parse(raw);
      return json({ order });
    }

    // List all orders (summary)
    let cursor;
    const allKeys = [];
    const prefix = "order:";

    do {
      const res = await ordersKV.list({
        prefix,
        cursor,
        limit: 200,
      });
      allKeys.push(...res.keys);
      cursor = res.list_complete ? undefined : res.cursor;
    } while (cursor && allKeys.length < 1000);

    const summaries = [];

    for (const keyInfo of allKeys) {
      try {
        const raw = await ordersKV.get(keyInfo.name);
        if (!raw) continue;

        const order = JSON.parse(raw);
        summaries.push({
          orderId: order.orderId || keyInfo.name.replace(prefix, ""),
          email: order.email || null,
          packSize: order.packSize || null,
          price: order.price || null,
          status: order.status || "unknown",
          createdAt: order.createdAt || null,
        });
      } catch (e) {
        console.warn("Failed to parse order key:", keyInfo.name, e);
      }
    }

    summaries.sort((a, b) => {
      if (!a.createdAt && !b.createdAt) return 0;
      if (!a.createdAt) return 1;
      if (!b.createdAt) return -1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    return json({ orders: summaries });
  } catch (err) {
    console.error("admin-orders error:", err);
    return json(
      { error: err.message || "Failed to load admin orders" },
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
