// functions/api/order.js

// STANDARD SITE CONFIG
const STANDARD_PACKS = [3, 6, 9, 12, 15];
const STANDARD_PRICES = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };

// BINGO EVENT CONFIG
const BINGO_PACKS = [1, 3, 6, 12];
// 1 = £3.50, 3 = £10, 6 = £20, 12 = £35
const BINGO_PRICES = { 1: 3.5, 3: 10, 6: 20, 12: 35 };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    
    const emailRaw = body?.email ?? "";
    const phoneRaw = body?.phone ?? ""; 
    const packSizeRaw = body?.packSize;
    const packType = body?.packType || "standard";
    const socialPermission = body?.socialPermission || false;
    const shippingMethod = body?.shippingMethod || "GI_COLLECT"; 
    const eventTag = body?.event || null; // 'BINGO' or null
    
    let orderId = body?.orderId;
    const isUpdate = !!orderId;

    const email = String(emailRaw).trim();
    const phone = String(phoneRaw).trim();

    if (!/\S+@\S+\.\S+/.test(email)) return jsonResponse({ error: "Invalid email." }, 400);
    if (phone.length < 6) return jsonResponse({ error: "Invalid phone." }, 400);

    let packSize = Number(packSizeRaw);
    let price = 0;
    const isVoucher = String(packSizeRaw).startsWith("voucher_");

    if (isVoucher) {
        price = 0; 
    } else {
        // --- PRICING SPLIT LOGIC ---
        if (eventTag === 'BINGO') {
            if (!BINGO_PACKS.includes(packSize)) {
                return jsonResponse({ error: "Invalid pack size for Bingo event." }, 400);
            }
            price = BINGO_PRICES[packSize];
        } else {
            if (!STANDARD_PACKS.includes(packSize)) {
                return jsonResponse({ error: "Invalid pack size." }, 400);
            }
            price = STANDARD_PRICES[packSize];
        }
    }

    if (!orderId) orderId = crypto.randomUUID();

    let existingOrder = {};
    if (isUpdate) {
        const rawKv = await env.ORDERS_KV.get(`order:${orderId}`);
        if (rawKv) existingOrder = JSON.parse(rawKv);
    }

    // Generate simple order number for Bingo
    let bingoNumber = existingOrder.bingoNumber || null;
    if (eventTag === 'BINGO' && !bingoNumber) {
        try {
            const currentSeq = await env.ORDERS_KV.get('config:bingo_seq');
            let nextSeq = 1;
            if (currentSeq) nextSeq = parseInt(currentSeq, 10) + 1;
            await env.ORDERS_KV.put('config:bingo_seq', String(nextSeq));
            bingoNumber = nextSeq;
        } catch (e) {
            console.error("Failed to generate bingo number", e);
        }
    }

    const now = new Date().toISOString();

    const order = {
      orderId, email, phone, packSize, packType,
      socialPermission, shippingMethod, price,
      event: eventTag, 
      bingoNumber: bingoNumber,
      status: existingOrder.status || "draft",         
      createdAt: existingOrder.createdAt || now, 
      updatedAt: now,
      images: existingOrder.images || [],       
      stripeSessionId: existingOrder.stripeSessionId || null,
      recoverySent: existingOrder.recoverySent || false,
      recoverySkipped: existingOrder.recoverySkipped || false
    };

    await env.ORDERS_KV.put(`order:${orderId}`, JSON.stringify(order));

    return jsonResponse({ orderId });
  } catch (err) {
    return jsonResponse({ error: "Failed to create order." }, 500);
  }
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId");
    if (!orderId) return jsonResponse({ error: "Missing orderId." }, 400);
    const raw = await env.ORDERS_KV.get(`order:${orderId}`);
    if (!raw) return jsonResponse({ error: "Order not found." }, 404);
    const order = JSON.parse(raw);
    
    return jsonResponse(order);
  } catch (err) {
    return jsonResponse({ error: "Failed to load order." }, 500);
  }
}