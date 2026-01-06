// functions/api/order.js

// --- CONFIGURATION ---

// 1. Standard Website
const STANDARD_PACKS = [3, 6, 9, 12, 15];
const STANDARD_PRICES = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };

// 2. Bingo Event (1, 3, 6, 12)
const BINGO_PACKS = [1, 3, 6, 12];
const BINGO_PRICES = { 1: 3.50, 3: 10, 6: 20, 12: 35 };

// 3. Valentines Event (Pack IDs 1, 2, 3, 4)
const VALENTINES_PACKS = [1, 2, 3, 4];
const VALENTINES_PRICES = { 1: 12.50, 2: 25.00, 3: 30.00, 4: 35.00 };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    
    // Core Fields
    const emailRaw = body?.email ?? "";
    const phoneRaw = body?.phone ?? ""; 
    const packSizeRaw = body?.packSize;
    const packType = body?.packType || "standard";
    const socialPermission = body?.socialPermission || false;
    const shippingMethod = body?.shippingMethod || "GI_COLLECT"; 
    
    // Event Specifics
    const eventTag = body?.event || null; // 'BINGO', 'VALENTINES', or null
    const premadeSelections = body?.premadeSelections || []; // For Valentines
    
    let orderId = body?.orderId;
    const isUpdate = !!orderId;

    // Validation
    const email = String(emailRaw).trim();
    const phone = String(phoneRaw).trim();

    if (!/\S+@\S+\.\S+/.test(email)) return jsonResponse({ error: "Invalid email." }, 400);
    if (phone.length < 6) return jsonResponse({ error: "Invalid phone." }, 400);

    // --- PRICE & PACK VALIDATION ---
    let packSize = Number(packSizeRaw);
    let price = 0;
    const isVoucher = String(packSizeRaw).startsWith("voucher_");

    if (isVoucher) {
        // Gift Voucher Purchase (Price handled in checkout based on code value)
        price = 0; 
    } else {
        if (eventTag === 'VALENTINES') {
            // Valentines Logic
            if (!VALENTINES_PACKS.includes(packSize)) {
                return jsonResponse({ error: "Invalid Valentine's pack selection." }, 400);
            }
            price = VALENTINES_PRICES[packSize];
        } 
        else if (eventTag === 'BINGO') {
            // Bingo Logic
            if (!BINGO_PACKS.includes(packSize)) {
                return jsonResponse({ error: "Invalid Bingo pack selection." }, 400);
            }
            price = BINGO_PRICES[packSize];
        } 
        else {
            // Standard Website Logic
            if (!STANDARD_PACKS.includes(packSize)) {
                return jsonResponse({ error: "Invalid pack size." }, 400);
            }
            price = STANDARD_PRICES[packSize];
        }
    }

    if (!orderId) orderId = crypto.randomUUID();

    // Fetch existing if updating (to preserve creation date or other flags)
    let existingOrder = {};
    if (isUpdate) {
        const rawKv = await env.ORDERS_KV.get(`order:${orderId}`);
        if (rawKv) existingOrder = JSON.parse(rawKv);
    }

    // --- BINGO ORDER NUMBER ---
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
      premadeSelections: premadeSelections, // Save heart choices
      bingoNumber: bingoNumber,             // Save simple number
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
    
    // Fallback price logic for display if missing
    if (!order.price && order.packSize && !String(order.packSize).startsWith("voucher_")) {
        if (order.event === 'VALENTINES') order.price = VALENTINES_PRICES[order.packSize];
        else if (order.event === 'BINGO') order.price = BINGO_PRICES[order.packSize];
        else order.price = STANDARD_PRICES[order.packSize];
    }
    return jsonResponse(order);
  } catch (err) {
    return jsonResponse({ error: "Failed to load order." }, 500);
  }
}