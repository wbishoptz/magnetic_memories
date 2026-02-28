// functions/api/order.js

// --- CONFIGURATION ---
const STANDARD_PACKS = [3, 6, 9, 12, 15];
const STANDARD_PRICES = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };

const BINGO_PACKS = [1, 3, 6, 12];
// UPDATED: 1 magnet is now £4.00
const BINGO_PRICES = { 1: 4.00, 3: 10, 6: 20, 12: 35 };

const VALENTINES_PACKS = [1, 2, 3, 4];
const VALENTINES_PRICES = { 1: 12.50, 2: 25.00, 3: 30.00, 4: 35.00 };
const FLEXI_PRICE = 12.50;

// Mother's Day Packages (Custom + Premade Magnets)
const MOTHERS_PACKAGES = {
  "Bouquet Bloom": 12.50,
  "Garden Party": 25.00,
  "Full Bloom": 30.00,
  "Mum's Treasure": 35.00
};

// Frame Pricing Configuration
const FRAME_PRICES = {
  bohemian: {
    3: { frame: 8, full: 15 },
    4: { frame: 10, full: 17 },
    6: { frame: 12, full: 25 },
    9: { frame: 15, full: 30 },
  },
  sleek: {
    1: { frame: 5, full: 7 },
    2: { frame: 7, full: 12 },
    3: { frame: 8, full: 15 },
    4: { frame: 10, full: 17 },
  },
  rollercube: {
    4: { frame: 10, full: 17 }
  }
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    
    // --- COMMON FIELDS ---
    const email = String(body?.email || "").trim();
    const phone = String(body?.phone || "").trim();
    const packSizeRaw = body?.packSize; 
    const eventTag = body?.event || null; 
    
    // --- SPECIAL FIELDS ---
    const productType = body?.productType || 'standard'; 
    const flexiColor = body?.flexiColor || null;
    const premadeSelections = body?.premadeSelections || []; 
    
    // --- MANUAL EVENT FIELDS (Restored) ---
    const raffleNumber = body?.raffleNumber || null; 
    const manualStatus = body?.status || "draft";    

    // --- FRAME FIELDS ---
    const frameStyle = body?.frameStyle;
    const frameSize = body?.frameSize;
    const frameColor = body?.frameColor;
    const includeMagnets = body?.includeMagnets;
    
    // --- MOTHERS DAY FIELDS ---
    const mothersPackage = body?.mothersPackage;

    if (!/\S+@\S+\.\S+/.test(email)) return jsonResponse({ error: "Invalid email." }, 400);

    let price = 0;
    const packSize = Number(packSizeRaw);

    // --- PRICING LOGIC ---
    if (eventTag === 'MANUAL') {
        price = 0; // Paid in cash/person
    } 
    else if (String(packSizeRaw).startsWith("voucher_")) {
        price = 0; 
    } 
    else if (eventTag === 'MOTHERS_DAY') {
        if (productType === 'frames') {
            const styleData = FRAME_PRICES[frameStyle];
            const sizeData = styleData ? styleData[frameSize] : null;
            if (!sizeData) return jsonResponse({ error: "Invalid frame configuration." }, 400);
            price = includeMagnets ? sizeData.full : sizeData.frame;
        } else {
            price = MOTHERS_PACKAGES[mothersPackage] || 0;
        }
    }
    else {
        if (eventTag === 'FRAMES') {
            const styleData = FRAME_PRICES[frameStyle];
            const sizeData = styleData ? styleData[frameSize] : null;
            if (!sizeData) return jsonResponse({ error: "Invalid frame configuration." }, 400);
            price = includeMagnets ? sizeData.full : sizeData.frame;
        } 
        else if (eventTag === 'VALENTINES') {
            if (productType === 'flexi') {
                price = FLEXI_PRICE;
            } else {
                if (!VALENTINES_PACKS.includes(packSize)) return jsonResponse({ error: "Invalid pack." }, 400);
                price = VALENTINES_PRICES[packSize];
            }
        } 
        else if (eventTag === 'BINGO') {
            if (!BINGO_PACKS.includes(packSize)) return jsonResponse({ error: "Invalid Bingo pack." }, 400);
            price = BINGO_PRICES[packSize];
        } 
        else {
            if (!STANDARD_PACKS.includes(packSize)) return jsonResponse({ error: "Invalid standard pack." }, 400);
            price = STANDARD_PRICES[packSize];
        }
    }

    let orderId = body?.orderId || crypto.randomUUID();
    
    // Get existing order if updating
    let existingOrder = {};
    if (body?.orderId) {
        const rawKv = await env.ORDERS_KV.get(`order:${orderId}`);
        if (rawKv) existingOrder = JSON.parse(rawKv);
    }

    const now = new Date().toISOString();

    // Handle boolean values correctly
    let socialPerm = existingOrder.socialPermission;
    if (body.socialPermission !== undefined) {
        socialPerm = body.socialPermission;
    }

    const order = {
      orderId, 
      email, 
      phone, 
      packSize, 
      price, 
      event: eventTag,
      raffleNumber, 
      
      productType, 
      flexiColor, 
      premadeSelections,
      mothersPackage, // Save the selected Mother's Day package name
      
      frameStyle,
      frameSize,
      frameColor,
      includeMagnets,
      
      // System fields
      // Allow manual 'paid' status for events, otherwise default to draft logic
      status: manualStatus === 'paid' ? 'paid' : (existingOrder.status || "draft"),
      
      createdAt: existingOrder.createdAt || now, 
      updatedAt: now,
      images: existingOrder.images || [],       
      stripeSessionId: existingOrder.stripeSessionId || null,
      recoverySent: existingOrder.recoverySent || false,
      
      // Smart shipping logic (Manual = Collect)
      shippingMethod: body?.shippingMethod || existingOrder.shippingMethod || (eventTag === 'MANUAL' ? 'COLLECT' : null),
      
      socialPermission: socialPerm,
      
      bingoNumber: existingOrder.bingoNumber
    };

    // Bingo Sequence Logic
    if (eventTag === 'BINGO' && !order.bingoNumber) {
        try {
            const currentSeq = await env.ORDERS_KV.get('config:bingo_seq');
            let nextSeq = 1;
            if (currentSeq) nextSeq = parseInt(currentSeq, 10) + 1;
            await env.ORDERS_KV.put('config:bingo_seq', String(nextSeq));
            order.bingoNumber = nextSeq;
        } catch (e) {}
    }

    await env.ORDERS_KV.put(`order:${orderId}`, JSON.stringify(order));

    return jsonResponse({ orderId });
  } catch (err) {
    console.error("Order Create Error:", err);
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
    return jsonResponse(JSON.parse(raw));
  } catch (err) {
    return jsonResponse({ error: "Failed to load order." }, 500);
  }
}