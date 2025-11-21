// functions/api/checkout.js
// POST /api/checkout  ->  creates a Stripe Checkout Session and returns { checkoutUrl }

export const onRequestPost = async ({ request, env }) => {
  try {
    const body = await request.json();
    const { orderId } = body || {};

    if (!orderId) {
      return json({ error: "orderId is required" }, 400);
    }

    // Load order from KV (adjust ORDERS binding name if needed)
    const raw = await env.ORDERS.get(orderId);
    if (!raw) return json({ error: "Order not found" }, 404);

    const order = JSON.parse(raw);
    const packSize = Number(order.packSize);
    const email = order.email;

    // Amounts in pence (GBP)
    const priceMap = { 3: 700, 6: 1400, 9: 2000, 12: 2500, 15: 3000 };
    const amount = priceMap[packSize];
    if (!amount) return json({ error: "Unsupported pack size" }, 400);

    // Update order status (optional)
    order.status = "checkout_created";
    await env.ORDERS.put(orderId, JSON.stringify(order), {
      expirationTtl: 60 * 60 * 24 * 7,
    });

    const origin = new URL(request.url).origin;
    const successUrl = `${origin}/return.html?status=success&orderId=${encodeURIComponent(orderId)}`;
    const cancelUrl  = `${origin}/return.html?status=cancel&orderId=${encodeURIComponent(orderId)}`;

    // Build Stripe Checkout Session request
    const params = new URLSearchParams();

    params.set("mode", "payment");
    params.set("success_url", successUrl);
    params.set("cancel_url", cancelUrl);
    if (email) params.set("customer_email", email);

    params.set("billing_address_collection", "auto");
    params.set("allow_promotion_codes", "true");

    // Single line item, inline price
    params.set("line_items[0][price_data][currency]", "gbp");
    params.set("line_items[0][price_data][unit_amount]", String(amount));
    params.set("line_items[0][price_data][product_data][name]", `${packSize} Photo Magnets`);
    params.set(
      "line_items[0][price_data][product_data][description]",
      "50×50mm magnets, cropped by customer"
    );
    params.set("line_items[0][quantity]", "1");

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!stripeRes.ok) {
      const txt = await stripeRes.text();
      console.error("Stripe error:", txt);
      return json({ error: `Stripe error: ${txt}` }, 502);
    }

    const session = await stripeRes.json();

    // Store session id (optional but useful)
    order.stripeSessionId = session.id;
    await env.ORDERS.put(orderId, JSON.stringify(order), {
      expirationTtl: 60 * 60 * 24 * 7,
    });

    return json({ checkoutUrl: session.url });
  } catch (err) {
    console.error(err);
    return json({ error: err.message || "Failed to create Stripe checkout" }, 500);
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
