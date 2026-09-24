// functions/api/upload.js
// Upload a file to R2 for a given order and update the order record.
// Guest self-upload orders (source "guest") are NOT written back here: their
// photo list is rebuilt from the R2 keys by /api/guest-finalize, so an upload
// that races the finalize can never overwrite the finished order.

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Content types we keep from the client; anything else is stored as
// application/octet-stream so it can never be served back as HTML/SVG/script.
const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif",
]);

function storedContentType(file) {
  const t = String(file.type || "").split(";")[0].trim().toLowerCase();
  return ALLOWED_TYPES.has(t) ? t : "application/octet-stream";
}

// Guest uploads are cropped to JPEG in the browser: accept only JPEGs, <= 15 MB.
const GUEST_MAX_BYTES = 15 * 1024 * 1024;

async function isGuestJpeg(file) {
  if (!(file.size > 0 && file.size <= GUEST_MAX_BYTES)) return false;
  try {
    const head = new Uint8Array(await file.slice(0, 3).arrayBuffer());
    return head.length === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  } catch {
    return false;
  }
}

const COMPLETE_MSG = "This upload is already complete.";

export async function onRequestPost({ request, env }) {
  try {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId");

    // NEW: Allow manual event page to set a specific filename (e.g. "Ticket-505-1.jpg")
    const customFilename = url.searchParams.get("filename");

    if (!orderId) {
      return json(400, { error: "Missing orderId." });
    }

    // 1. USE THE PREFIX (Fixes "Order not found")
    const kvKey = `order:${orderId}`;
    const order = await env.ORDERS_KV.get(kvKey, { type: "json" });

    if (!order) {
      return json(404, { error: "Order not found" });
    }

    const isGuest = order.source === "guest";

    // Guest self-upload that already has its number: no more photos
    if (isGuest && order.raffleNumber != null) {
      return json(409, { error: COMPLETE_MSG });
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

    if (isGuest && !(await isGuestJpeg(file))) {
      return json(400, { error: "Please upload a photo." });
    }

    // 2. RESTORE ADMIN COMPATIBILITY + SUPPORT CUSTOM NAMES
    // We prioritize the customFilename (from Event Page) if it exists.
    const originalName = customFilename || file.name || "photo.jpg";

    // Sanitize the name to be safe for file systems/URLs
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");

    // Keep your exact folder structure so Admin downloads work
    const r2Key = `orders/${orderId}/original/${Date.now()}_${safeName}`;

    await env.R2_BUCKET.put(r2Key, file.stream(), {
      httpMetadata: {
        contentType: isGuest ? "image/jpeg" : storedContentType(file),
      },
      customMetadata: {
        orderId: orderId,
        filename: safeName
      }
    });

    if (isGuest) {
      // If it was finalized (or deleted) while this file was uploading, don't
      // leave a stray photo behind. Otherwise we're done: finalize builds the
      // photo list from the keys the page sends, so the order is not rewritten.
      const fresh = await env.ORDERS_KV.get(kvKey, { type: "json" });
      if (!fresh || fresh.raffleNumber != null) {
        await env.R2_BUCKET.delete(r2Key).catch(() => {});
        return fresh
          ? json(409, { error: COMPLETE_MSG })
          : json(404, { error: "Order not found" });
      }
      return json(200, { ok: true, key: r2Key });
    }

    // Attach to order record
    order.images = order.images || [];
    order.images.push({
      key: r2Key,
      name: safeName, // Save the clean name (e.g. Ticket-505-1.jpg)
      uploadedAt: new Date().toISOString(),
    });

    await env.ORDERS_KV.put(kvKey, JSON.stringify(order));

    return json(200, { ok: true, key: r2Key });
  } catch (err) {
    console.error("Error in /api/upload:", err);
    return json(500, { error: "Failed to upload file." });
  }
}
