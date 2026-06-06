// functions/api/cleanup-images.js
// Deletes order PHOTOS from R2 once an order is older than RETENTION_DAYS.
// The order record itself is KEPT (for your sales history) — only the images
// are removed, and the order is flagged imagesPurged so it isn't re-processed.
//
// Auth: ?key=ADMIN_DASH_KEY (so an external cron can call it), or the admin
//       Authorization: Bearer <ADMIN_KEY> header (for the manual admin button).
//
// Call: GET or POST /api/cleanup-images?key=...   (optional &days=30 override)

const RETENTION_DAYS = 30;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function handle(request, env) {
  const url = new URL(request.url);
  const key = request.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("key");
  if (key !== env.ADMIN_DASH_KEY && key !== env.ADMIN_KEY) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!env.ORDERS_KV || !env.R2_BUCKET) {
    return json({ error: "Storage bindings missing." }, 500);
  }

  // Auto mode (called on admin load): only actually run once per ~day
  const auto = url.searchParams.get("auto") === "1";
  if (auto) {
    const last = await env.ORDERS_KV.get("config:cleanup_last");
    if (last && (Date.now() - Number(last) < 23 * 60 * 60 * 1000)) {
      return json({ ok: true, skipped: true, reason: "ran within last 24h" });
    }
  }

  const days = Number(url.searchParams.get("days")) > 0 ? Number(url.searchParams.get("days")) : RETENTION_DAYS;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const { keys } = await env.ORDERS_KV.list({ prefix: "order:" });
  let ordersPurged = 0;
  let filesDeleted = 0;
  let scanned = 0;

  for (const k of keys) {
    const raw = await env.ORDERS_KV.get(k.name);
    if (!raw) continue;
    let order;
    try { order = JSON.parse(raw); } catch { continue; }
    scanned++;

    // Already cleaned, or nothing to clean
    if (order.imagesPurged || !Array.isArray(order.images) || order.images.length === 0) continue;

    // Age check — use createdAt (fall back to first image upload time)
    const stamp = order.createdAt || order.images[0]?.uploadedAt;
    if (!stamp) continue;
    if (new Date(stamp).getTime() > cutoff) continue; // not old enough yet

    // Delete the R2 objects (delete accepts an array of keys)
    const objectKeys = order.images.map(i => i.key).filter(Boolean);
    if (objectKeys.length) {
      try {
        await env.R2_BUCKET.delete(objectKeys);
        filesDeleted += objectKeys.length;
      } catch (e) {
        // If a bulk delete fails, skip this order this run; try again next time
        continue;
      }
    }

    // Keep the order record but drop the photos
    order.images = [];
    order.imagesPurged = true;
    order.imagesPurgedAt = new Date().toISOString();
    await env.ORDERS_KV.put(k.name, JSON.stringify(order));
    ordersPurged++;
  }

  // Record the run so auto mode waits ~a day before running again
  await env.ORDERS_KV.put("config:cleanup_last", String(Date.now()));

  return json({ ok: true, retentionDays: days, scanned, ordersPurged, filesDeleted });
}

export const onRequestGet = ({ request, env }) => handle(request, env);
export const onRequestPost = ({ request, env }) => handle(request, env);
