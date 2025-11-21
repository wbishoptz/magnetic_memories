// functions/api/admin-order-images.js
// GET /api/admin-order-images?orderId=<id>&key=ADMIN_DASH_KEY
//
// Lists R2 objects for the given orderId under prefix "orders/<orderId>/"

export const onRequestGet = async ({ request, env }) => {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const orderId = url.searchParams.get("orderId");

    if (!key || key !== env.ADMIN_DASH_KEY) {
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

    const images = (listRes.objects || []).map((obj) => {
      const filename = obj.key.substring(prefix.length);
      return {
        key: obj.key,
        filename,
        size: obj.size,
        uploadedAt: obj.uploaded,
      };
    });

    return json({ images });
  } catch (err) {
    console.error("admin-order-images error:", err);
    return json(
      { error: err.message || "Failed to list order images" },
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
