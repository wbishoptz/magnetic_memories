// functions/api/order.js
// POST   /api/order   -> create or update an order in KV
// GET    /api/order   -> fetch a single order by ?orderId=

const PACKS = [3, 6, 9, 12, 15];
const PRICES = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- CREATE / UPDATE ORDER ----------
export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    
    // Incoming fields
    const emailRaw = body?.email ?? "";
    const phoneRaw = body?.phone ?? ""; 
    const packSizeRaw = body?.packSize;
    const packType = body?.packType || "standard";
    const socialPermission = body?.socialPermission || false;
    const shippingMethod = body?.shippingMethod || "GI_COLLECT"; // NEW: Capture shipping selection
    
    // Check if updating an existing draft
    let orderId = body?.orderId;
    const isUpdate = !!orderId;

    const email = String(emailRaw).trim();
    const phone = String(phoneRaw).trim();

    // Validation
    if (!/\S+@\S+\.\S+/.test(email)) {
      return jsonResponse({ error: "Please provide a valid email address." }, 400);
    }
    
    if (phone.length < 6) {
        return jsonResponse({ error: "Please provide a valid phone number." }, 400);
    }

    // --- YOUR CUSTOM VALIDATION (Vouchers vs Magnets) ---
    let packSize = packSizeRaw;
    let price = 0;
    const isVoucher = String(packSizeRaw).startsWith("voucher_");

    if (isVoucher) {
        // If it's a voucher (e.g. "voucher_14"), we allow it.
        // Price is set to 0 here because real price is calculated in checkout.js
        price = 0; 
    } else {
        // If it's magnets, ensure it matches a valid pack size
        const numericSize = Number(packSizeRaw);
        if (!PACKS.includes(numericSize)) {
            return jsonResponse({ error: "Invalid pack size." }, 400);
        }
        packSize = numericSize;
        price = PRICES[numericSize];
    }
    // ----------------------------------------------------

    // Generate ID if this is a new order
    if (!orderId) {
        orderId = crypto.randomUUID();
    }

    // Retrieve existing data to preserve history (like images or original creation date)
    let existingOrder = {};
    if (isUpdate) {
        const rawKv = await env.ORDERS_KV.get(`order:${orderId}`);
        if (rawKv) existingOrder = JSON.parse(rawKv);
    }

    const now = new Date().toISOString();

    const order = {
      orderId,
      email,
      phone, 
      packSize, 
      packType,
      socialPermission,
      shippingMethod, // NEW: Save this to KV
      price,
      status: existingOrder.status || "draft",         
      createdAt: existingOrder.createdAt || now, // Keep original date if updating
      updatedAt: now,
      images: existingOrder.images || [],        // Keep existing images
      stripeSessionId: existingOrder.stripeSessionId || null,
      recoverySent: existingOrder.recoverySent || false,
      recoverySkipped: existingOrder.recoverySkipped || false
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