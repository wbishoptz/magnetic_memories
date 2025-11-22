// functions/api/checkout.js
//
// POST /api/checkout  -> create Stripe Checkout session for an order

const PACKS = [3, 6, 9, 12, 15];
const PRICES = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    const orderId = body?.orderId;

    if (!orderId) {
      return jsonResponse({ error: "Missing orderId." }, 400);
    }

    // Try to load the order from KV (normal path)
    let kvOrder = null;
    try {
      const kvRaw = await env.ORDERS_KV.get(orderId);
      if (kvRaw) kvOrder = JSON.parse(kvRaw);
    } catch (e) {
      console.error("KV get error in /api/checkout:", e);
    }

    // Fallback data coming from the request body
    const emailFromBody = String(body?.email || "").trim();
    const packSizeFromBody = Number(body?.packSize || 0) || 3;

    const email = String(
      (kvOrder && kvOrder.email) || emailFromBody || ""
    ).trim();

    let packSize =
      (kvOrder && Number(kvOrder.packSize || kvOrder.pack)) ||
      packSizeFromBody ||
      3;

    if (!PACKS.includes(packSize)) packSize = 3;

    const price =
      (kvOrder && kvOrder.price) || PRICES[packSize] || PRICES[3];

    const amount = price * 100;

    const successUrl = `https://magnetic-memories.pages.dev/return.html?status=success&orderId=${encodeURIComponent(
      orderId
    )}`;
    const cancelUrl = `https://magnetic-memories.pages.dev/return.html?status=cancel&orderId=${encodeURIComponent(
      orderId
    )}`;

    const params = new URLSearchParams();

    params.append("mode", "payment");
    params.append("success_url", successUrl);
    params.append("cancel_url", cancelUrl);

    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", "gbp");
    params.append(
      "line_items[0][price_data][product_data][name]",
      `${packSize} custom photo magnets`
    );
    params.append(
      "line_items[0][price_data][product_data][description]",
      "50×50mm fridge magnets – printed using your uploaded photos."
    );
    params.append(
      "line_items[0][price_data][unit_amount]",
      String(amount)
    );

    if (email) {
      params.append("customer_email", email);
    }

    const stripeRes = await fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      }
    );

    const session = await stripeRes.json();

    if (!stripeRes.ok) {
      console.error("Stripe error:", session);
      return jsonResponse(
        { error: "Failed to create Stripe checkout." },
        500
      );
    }

    // Build / update the order in KV (even if it didn't exist before)
    const now = new Date().toISOString();
    const updatedOrder = {
      orderId,
      email,
      packSize,
      pack: packSize,
      price,
      status: "checkout_created",
      createdAt: kvOrder?.createdAt || now,
      images: kvOrder?.images || [],
      stripeSessionId: session.id,
      stripePaymentIntentId: session.payment_intent ?? null,
    };

    try {
      await env.ORDERS_KV.put(orderId, JSON.stringify(updatedOrder));
    } catch (e) {
      console.error("KV put error in /api/checkout:", e);
      // still continue – payment session exists
    }

    return jsonResponse({ checkoutUrl: session.url });
  } catch (err) {
    console.error("ERROR in /api/checkout:", err);
    return jsonResponse({ error: "Failed to create checkout." }, 500);
  }
}
