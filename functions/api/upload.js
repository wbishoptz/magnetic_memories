// functions/api/upload.js
// Receives multipart/form-data with a single "file" field
// Requires ?orderId=... in the querystring
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // 1) Get orderId from the URL
    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId");
    if (!orderId) {
      return new Response(JSON.stringify({ error: "Missing orderId" }), { status: 400 });
    }

    // 2) Make sure the order exists
    const orderKey = `order:${orderId}`;
    const orderJson = await env.ORDERS_KV.get(orderKey);
    if (!orderJson) {
      return new Response(JSON.stringify({ error: "Order not found" }), { status: 404 });
    }

    // 3) Parse multipart form and get the file
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || typeof file === "string") {
      return new Response(JSON.stringify({ error: "No file uploaded" }), { status: 400 });
    }

    // 4) Validate file
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/heic",
      "image/heif"
    ];
    const maxBytes = 10 * 1024 * 1024; // 10MB

    if (!allowedTypes.includes(file.type)) {
      return new Response(JSON.stringify({ error: "Unsupported file type" }), { status: 415 });
    }
    if (file.size > maxBytes) {
      return new Response(JSON.stringify({ error: "File too large (max 10MB)" }), { status: 413 });
    }

    // 5) Create a safe object key in R2
    const safeName = sanitizeFilename(file.name || "upload");
    const ts = Date.now();
    const r2Key = `orders/${orderId}/original/${ts}_${safeName}`;

    // 6) Write to R2 (stream for efficiency)
    await env.R2_BUCKET.put(r2Key, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata: {
        orderId,
        filename: safeName
      }
    });

    // (Optional) You could update the order with a simple counter. Skipping for v1.

    return new Response(JSON.stringify({ ok: true, key: r2Key }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}

// Simple filename sanitizer
function sanitizeFilename(name) {
  return String(name)
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 140);
}
