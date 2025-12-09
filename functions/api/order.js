// functions/api/order.js
// POST   /api/order   -> create a new order in KV
// GET    /api/order   -> fetch a single order by ?orderId=

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
    const phoneRaw = body?.phone ?? ""; // <--- GET PHONE
    const packSizeRaw = body?.packSize;
    const packType = body?.packType || "standard";

    const email = String(emailRaw).trim();
    const phone = String(phoneRaw).trim();
    const packSize = Number(packSizeRaw);

    // Basic validation
    const emailOk = /\S+@\S+\.\S+/.test(email);
    if (!emailOk) {
      return jsonResponse({ error: "Please provide a valid email address." }, 400);
    }
    
    // Simple phone check (just to ensure it's not empty/too short)
    if (phone.length < 6) {
        return jsonResponse({ error: "Please provide a valid phone number." }, 400);
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
      phone, // <--- SAVE PHONE
      packSize,
      packType,
      price,
      status: "draft",         
      createdAt: now,
      images: [],
      stripeSessionId: null,
      stripePaymentIntentId: null,
    };

    // Save with "order:" prefix
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

    const raw = await env.ORDERS_KV.get(`order:${orderId}`);
    
    if (!raw) {
      return jsonResponse({ error: "Order not found." }, 404);
    }

    const order = JSON.parse(raw);

    if (!order.price && order.packSize && PRICES[order.packSize]) {
      order.price = PRICES[order.packSize];
    }

    return jsonResponse(order);
  } catch (err) {
    console.error("ERROR in /api/order GET:", err);
    return jsonResponse({ error: "Failed to load order." }, 500);
  }
}