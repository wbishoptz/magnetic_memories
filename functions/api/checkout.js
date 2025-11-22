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

    const raw = await env.ORDERS_KV.get(orderId);
    if (!raw) {
      return jsonResponse({ error: "Order not found." }, 404);
    }

    const order = JSON.parse(raw);

    const email = String(order.email || "").trim();
    const packSize = Number(order.packSize || order.pack || 3);
    const validPack = PACKS.includes(packSize) ? packSize : 3;
    const price = order.price ?? PRICES[validPack] ?? PRICES[3];

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

    // One line item with dynamic price
    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", "gbp");
    params.append(
      "line_items[0][price_data][product_data][name]",
      `${validPack} custom photo magnets`
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

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const session = await stripeRes.json();

    if (!stripeRes.ok) {
      console.error("Stripe error:", session);
      return jsonResponse({ error: "Failed to create Stripe checkout." }, 500);
    }

    // Update order in KV
    const updated = {
      ...order,
      packSize: validPack,
      pack: validPack,
      price,
      status: "checkout_created",
      stripeSessionId: session.id,
      stripePaymentIntentId: session.payment_intent ?? null,
    };

    await env.ORDERS_KV.put(orderId, JSON.stringify(updated));

    return jsonResponse({ checkoutUrl: session.url });
  } catch (err) {
    console.error("ERROR in /api/checkout:", err);
    return jsonResponse({ error: "Failed to create checkout." }, 500);
  }
}
