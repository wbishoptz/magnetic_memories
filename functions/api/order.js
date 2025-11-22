// functions/api/order.js
// Create a new order in KV (no photo-count validation here)

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError("Invalid JSON body", 400);
  }

  const rawEmail = (body.email || "").trim();
  const packSize = Number(body.packSize);

  const PACKS = [3, 6, 9, 12, 15];
  const PRICES = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };

  // 🔧 Simpler, correct email check
  // Allows things like: test@gmail.com, name.surname@domain.co.uk, etc.
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+(\.[^\s@]+)*$/;
  if (!emailRegex.test(rawEmail)) {
    return jsonError("Please provide a valid email address.", 400);
  }

  if (!PACKS.includes(packSize)) {
    return jsonError("Invalid pack size.", 400);
  }

  const orderId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const price = PRICES[packSize];

  const order = {
    orderId,
    email: rawEmail,
    packSize,
    price,
    status: "draft", // will move to checkout_created, paid, etc.
    createdAt,
    imageKeys: [], // /api/upload will push into this
    stripeSessionId: null,
    stripePaymentIntentId: null,
  };

  // KV binding: ORDERS_KV (configured in Cloudflare Pages)
  await env.ORDERS_KV.put(`order:${orderId}`, JSON.stringify(order));

  return new Response(JSON.stringify({ orderId }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
