export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get("orderId");
  const fileKey = url.searchParams.get("key");

  if (!orderId || !fileKey) return new Response("Missing params", { status: 400 });

  // Security: Only allow fetching if the fileKey actually belongs to this order folder
  // (This prevents people from using a valid orderId to fish for other files)
  if (!fileKey.includes(`/${orderId}/`)) {
    return new Response("Invalid file key for this order", { status: 403 });
  }

  // Stream the file from R2
  try {
    const obj = await env.R2_BUCKET.get(fileKey);
    if (!obj) return new Response("Not found", { status: 404 });

    const headers = new Headers();
    headers.set("Content-Type", obj.httpMetadata?.contentType || "image/jpeg");
    headers.set("Cache-Control", "public, max-age=31536000"); // Cache for 1 year

    return new Response(obj.body, { headers });
  } catch (e) {
    return new Response("Error", { status: 500 });
  }
}