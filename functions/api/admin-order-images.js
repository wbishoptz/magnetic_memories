// functions/api/admin-order-images.js
// GET /api/admin-order-images?orderId=<id>&key=ADMIN_DASH_KEY
//
// Lists R2 objects for the given orderId under prefix "orders/<orderId>/".
// Finished guest self-uploads (source "guest" with a number) list ONLY the
// photos recorded on the order (order.images) - anything else under the
// prefix (unpaid extras, a stray late upload) is never printed. If the order
// can't be read, the full listing is returned as before.

export const onRequestGet = async ({ request, env }) => {
  try {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId");
    const key = request.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("key");

    if (!key || (key !== env.ADMIN_DASH_KEY && key !== env.ADMIN_KEY)) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (!orderId) {
      return json({ error: "orderId is required" }, 400);
    }

    const bucket = env.R2_BUCKET;
    if (!bucket) {
      return json(
        {
          error:
            "R2_BUCKET binding missing. Check Pages → Settings → Functions → R2 buckets.",
        },
        500
      );
    }

    const prefix = `orders/${orderId}/`;
    const listRes = await bucket.list({
      prefix,
      limit: 100,
    });

    let images = (listRes.objects || []).map((obj) => {
      const filename = obj.key.substring(prefix.length);
      return {
        key: obj.key,
        filename,
        size: obj.size,
        uploadedAt: obj.uploaded,
      };
    });

    const recorded = await recordedGuestKeys(env, orderId);
    if (recorded) images = images.filter((img) => recorded.has(img.key));

    return json({ images });
  } catch (err) {
    console.error("admin-order-images error:", err);
    return json(
      { error: err.message || "Failed to list order images" },
      500
    );
  }
};

// Set of the photo keys recorded on a FINISHED guest order, or null (not a
// finished guest order, nothing recorded, or the order could not be read).
async function recordedGuestKeys(env, orderId) {
  if (!env.ORDERS_KV) return null;
  let order;
  try {
    const raw = await env.ORDERS_KV.get(`order:${orderId}`);
    order = raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error("admin-order-images: order read failed, listing everything:", err);
    return null;
  }
  if (!order || order.source !== "guest" || order.raffleNumber == null || !Array.isArray(order.images)) return null;
  const keys = order.images.map((im) => im && im.key).filter((k) => typeof k === "string" && k);
  return keys.length ? new Set(keys) : null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
