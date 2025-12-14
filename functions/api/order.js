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
    const phoneRaw = body?.phone ?? ""; 
    const packSizeRaw = body?.packSize;
    const packType = body?.packType || "standard";
    const socialPermission = body?.socialPermission || false;

    const email = String(emailRaw).trim();
    const phone = String(phoneRaw).trim();

    if (!/\S+@\S+\.\S+/.test(email)) {
      return jsonResponse({ error: "Please provide a valid email address." }, 400);
    }
    
    if (phone.length < 6) {
        return jsonResponse({ error: "Please provide a valid phone number." }, 400);
    }

    // --- FIX START: Better validation that accepts Vouchers ---
    let packSize = packSizeRaw;
    let price = 0;
    const isVoucher = String(packSizeRaw).startsWith("voucher_");

    if (isVoucher) {
        // If it's a voucher (e.g. "voucher_14"), we allow it.
        // We set price to 0 here because the real price is calculated 
        // in checkout.js later.
        price = 0; 
    } else {
        // If it's magnets, we must ensure it matches a valid pack size (3, 6, etc)
        const numericSize = Number(packSizeRaw);
        if (!PACKS.includes(numericSize)) {
            return jsonResponse({ error: "Invalid pack size." }, 400);
        }
        packSize = numericSize;
        price = PRICES[numericSize];
    }
    // --- FIX END ---

    const orderId = crypto.randomUUID();
    const now = new Date().toISOString();

    const order = {
      orderId,
      email,
      phone, 
      packSize, // This now stores either the number 6 OR the string "voucher_14"
      packType,
      socialPermission,
      price,
      status: "draft",         
      createdAt: now,
      images: [],
      stripeSessionId: null,
      stripePaymentIntentId: null,
    };

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
    
    // Fallback price calculation for display
    if (!order.price && order.packSize && !String(order.packSize).startsWith("voucher_")) {
      order.price = PRICES[order.packSize];
    }

    return jsonResponse(order);
  } catch (err) {
    console.error("ERROR in /api/order GET:", err);
    return jsonResponse({ error: "Failed to load order." }, 500);
  }
}