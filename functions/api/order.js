// functions/api/order.js
//
// POST   /api/order   -> create a new order in KV
// GET    /api/order   -> fetch a single order by ?orderId=
// Used by: checkout flow + return page + admin

const PACKS = [3, 6, 9, 12, 15];
const PRICES = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- CREATE ORDER ----------
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    const emailRaw = body?.email ?? "";
    const packSizeRaw = body?.packSize;

    const email = String(emailRaw).trim();
    const packSize = Number(packSizeRaw);

    // Basic validation
    const emailOk = /\S+@\S+\.\S+/.test(email);
    if (!emailOk) {
      return jsonResponse({ error: "Please provide a valid email address." }, 400);
    }

    if (!PACKS.includes(packSize)) {
      return jsonResponse({ error: "Invalid pack size." }, 400);
    }

    const price = PRICES[packSize];

    // Build order object
    const orderId = crypto.randomUUID();
    const now = new Date().toISOString();

    const order = {
      orderId,
      email,
      packSize,
      pack: packSize,          // backwards-compat key used in some old code
      price,
      status: "draft",         // draft -> checkout_created -> paid -> printing/shipped/completed
      createdAt: now,
      images: [],              // { key, url } objects will be pushed by /api/upload
      stripeSessionId: null,
      stripePaymentIntentId: null,
    };

    // FIX: Added "order:" prefix to match how upload.js reads it
    await env.ORDERS_KV.put(`order:${orderId}`, JSON.stringify(order));

    return jsonResponse({ orderId });
  } catch (err) {
    console.error("ERROR in /api/order POST:", err);
    return jsonResponse({ error: "Failed to create order." }, 500);
  }
}

// ---------- GET SINGLE ORDER ----------
export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId");

    if (!orderId) {
      return jsonResponse({ error: "Missing orderId." }, 400);
    }

    // FIX: Added "order:" prefix here too so we can find it
    const raw = await env.ORDERS_KV.get(`order:${orderId}`);
    
    if (!raw) {
      return jsonResponse({ error: "Order not found." }, 404);
    }

    const order = JSON.parse(raw);

    // Make sure pack / price are present for older orders
    if (!order.pack && order.packSize) order.pack = order.packSize;
    if (!order.packSize && order.pack) order.packSize = order.pack;

    if (!order.price && order.packSize && PRICES[order.packSize]) {
      order.price = PRICES[order.packSize];
    }

    return jsonResponse(order);
  } catch (err) {
    console.error("ERROR in /api/order GET:", err);
    return jsonResponse({ error: "Failed to load order." }, 500);
  }
}