// functions/api/admin-order-image.js
// GET /api/admin-order-image?orderId=<id>&objectKey=<key>&key=ADMIN_DASH_KEY[&download=1]
//
// Streams a single R2 image. If download=1, sends Content-Disposition: attachment.

export const onRequestGet = async ({ request, env }) => {
  try {
    const url = new URL(request.url);
    const adminKey = url.searchParams.get("key");
    const orderId = url.searchParams.get("orderId");
    const objectKey = url.searchParams.get("objectKey");
    const download = url.searchParams.get("download");

    if (!adminKey || adminKey !== env.ADMIN_DASH_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (!orderId || !objectKey) {
      return new Response("orderId and objectKey are required", {
        status: 400,
      });
    }

    const bucket = env.R2_BUCKET;
    if (!bucket) {
      return new Response(
        "R2_BUCKET binding missing. Check Pages → Settings → Functions → R2 buckets.",
        { status: 500 }
      );
    }

    const expectedPrefix = `orders/${orderId}/`;
    if (!objectKey.startsWith(expectedPrefix)) {
      return new Response("Invalid objectKey for this order", { status: 400 });
    }

    const object = await bucket.get(objectKey);
    if (!object) {
      return new Response("Not found", { status: 404 });
    }

    const headers = new Headers();

    const contentType =
      (object.httpMetadata && object.httpMetadata.contentType) ||
      "image/jpeg";

    headers.set("Content-Type", contentType);

    const filename = objectKey.substring(expectedPrefix.length) || "photo.jpg";

    if (download) {
      headers.set(
        "Content-Disposition",
        `attachment; filename="${sanitizeFilename(filename)}"`
      );
    } else {
      headers.set("Content-Disposition", `inline; filename="${sanitizeFilename(
        filename
      )}"`);
    }

    return new Response(object.body, {
      status: 200,
      headers,
    });
  } catch (err) {
    console.error("admin-order-image error:", err);
    return new Response("Failed to load image", { status: 500 });
  }
};

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
