// functions/api/order.js
// Create an order in KV and return orderId

const PACK_PRICES = {
  3: 7,
  6: 14,
  9: 20,
  12: 25,
  15: 30,
};

const ALLOWED_PACKS = [3, 6, 9, 12, 15];

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const data = await request.json().catch(() => null);
    if (!data) {
      return json(400, { error: "Invalid JSON body." });
    }

    const rawEmail = (data.email || "").trim();
    const packSizeNum = Number(data.packSize);

    if (!rawEmail || !/\S+@\S+\.\S+/.test(rawEmail)) {
      return json(400, { error: "Please provide a valid email address." });
    }

    if (!ALLOWED_PACKS.includes(packSizeNum)) {
      return json(400, { error: "Invalid pack size." });
    }

    const price = PACK_PRICES[packSizeNum];
    if (typeof price !== "number") {
      return json(400, { error: "Price not configured for this pack size." });
    }

    const orderId = crypto.randomUUID();

    const order = {
      orderId,
      email: rawEmail,
      packSize: packSizeNum,
      price,
      status: "draft",
      createdAt: new Date().toISOString(),
      images: [], // will be filled by /api/upload
    };

    // IMPORTANT: consistent key format for all endpoints
    const kvKey = `order:${orderId}`;
    await env.ORDERS_KV.put(kvKey, JSON.stringify(order));

    return json(200, { orderId });
  } catch (err) {
    console.error("Error in /api/order:", err);
    return json(500, { error: "Failed to create order." });
  }
}
