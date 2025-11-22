// functions/api/upload.js
// Upload a file to R2 for a given order and update the order record.

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId");

    if (!orderId) {
      return json(400, { error: "Missing orderId." });
    }

    // 1. USE THE PREFIX (Fixes "Order not found")
    const kvKey = `order:${orderId}`;
    const order = await env.ORDERS_KV.get(kvKey, { type: "json" });

    if (!order) {
      return json(404, { error: "Order not found" });
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      return json(400, { error: "Expected multipart/form-data upload." });
    }

    const form = await request.formData();
    const file = form.get("file");

    if (!file || typeof file === "string") {
      return json(400, { error: "Missing file upload." });
    }

    // 2. RESTORE ADMIN COMPATIBILITY
    // We must use "orders/{orderId}/..." so the Admin Dashboard can find them.
    const originalName = file.name || "photo.jpg";
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const r2Key = `orders/${orderId}/original/${Date.now()}_${safeName}`;

    await env.R2_BUCKET.put(r2Key, file.stream(), {
      httpMetadata: {
        contentType: file.type || "image/jpeg",
      },
      customMetadata: {
        orderId: orderId,
        filename: safeName
      }
    });

    // Attach to order record
    order.images = order.images || [];
    order.images.push({
      key: r2Key,
      name: originalName,
      uploadedAt: new Date().toISOString(),
    });

    await env.ORDERS_KV.put(kvKey, JSON.stringify(order));

    return json(200, { ok: true, key: r2Key });
  } catch (err) {
    console.error("Error in /api/upload:", err);
    return json(500, { error: "Failed to upload file." });
  }
}