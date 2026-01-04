// functions/api/order.js

const PACKS = [3, 6, 9, 12, 15];
// Added pack 1 just for the event logic validation if needed
const PRICES = { 1: 3, 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };

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
    const eventTag = body?.event || null; 
    
    let orderId = body?.orderId;
    const isUpdate = !!orderId;

    const email = String(emailRaw).trim();
    const phone = String(phoneRaw).trim();

    if (!/\S+@\S+\.\S+/.test(email)) return jsonResponse({ error: "Invalid email." }, 400);
    if (phone.length < 6) return jsonResponse({ error: "Invalid phone." }, 400);

    let packSize = packSizeRaw;
    let price = 0;
    const isVoucher = String(packSizeRaw).startsWith("voucher_");

    if (isVoucher) {
        price = 0; 
    } else {
        const numericSize = Number(packSizeRaw);
        // Allow size 1 only if it's the bingo event, otherwise validate strict
        if (!PACKS.includes(numericSize) && numericSize !== 1) {
             return jsonResponse({ error: "Invalid pack size." }, 400);
        }
        packSize = numericSize;
        price = PRICES[numericSize] || 0;
    }

    if (!orderId) orderId = crypto.randomUUID();

    let existingOrder = {};
    if (isUpdate) {
        const rawKv = await env.ORDERS_KV.get(`order:${orderId}`);
        if (rawKv) existingOrder = JSON.parse(rawKv);
    }

    // --- BINGO ORDER NUMBER GENERATION ---
    let bingoNumber = existingOrder.bingoNumber || null;
    
    // Only generate a number if it's a BINGO event and doesn't have one yet
    if (eventTag === 'BINGO' && !bingoNumber) {
        try {
            // Get current counter
            const currentSeq = await env.ORDERS_KV.get('config:bingo_seq');
            let nextSeq = 1;
            if (currentSeq) {
                nextSeq = parseInt(currentSeq, 10) + 1;
            }
            // Save new counter
            await env.ORDERS_KV.put('config:bingo_seq', String(nextSeq));
            bingoNumber = nextSeq;
        } catch (e) {
            console.error("Failed to generate bingo number", e);
        }
    }
    // -------------------------------------

    const now = new Date().toISOString();

    const order = {
      orderId, email, phone, packSize, packType,
      socialPermission, shippingMethod, price,
      event: eventTag, 
      bingoNumber: bingoNumber, // Save the simple number
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
    
    if (!order.price && order.packSize && !String(order.packSize).startsWith("voucher_")) {
      order.price = PRICES[order.packSize];
    }
    return jsonResponse(order);
  } catch (err) {
    return jsonResponse({ error: "Failed to load order." }, 500);
  }
}