// functions/api/checkout.js

export async function onRequestPost(context) {
  const { request, env } = context;
  const { ORDERS_KV, STRIPE_SECRET_KEY } = env;

  try {
    const body = await request.json();
    let { orderId, email, packSize, price } = body || {};

    if (!orderId || !email || !packSize || !price) {
      return jsonError("Missing required fields.", 400);
    }

    // Normalise types
    packSize = Number(packSize);
    price = Number(price);

    if (!Number.isFinite(packSize) || !Number.isFinite(price)) {
      return jsonError("Invalid packSize or price.", 400);
    }

    // Load any existing order (created during uploads)
    const existingJson = await ORDERS_KV.get(orderId);
    const existing = existingJson ? JSON.parse(existingJson) : null;

    const now = new Date().toISOString();

    // Merge + ensure we keep images and any other fields from upload.js
    const order = {
      ...(existing || {}),
      orderId,
      email,
      packSize,
      price,
      status: "checkout_created",
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    // Persist draft / checkout_created order
    await ORDERS_KV.put(orderId, JSON.stringify(order));

    // Create Stripe Checkout Session
    const origin = new URL(request.url).origin;
    const successUrl = `${origin}/return.html?status=success&orderId=${orderId}`;
    const cancelUrl = `${origin}/return.html?status=cancel&orderId=${orderId}`;

    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", successUrl);
    params.append("cancel_url", cancelUrl);
    params.append("customer_email", email);

    // Single line item, amount in pence
    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", "gbp");
    params.append(
      "line_items[0][price_data][unit_amount]",
      String(Math.round(price * 100))
    );
    params.append(
      "line_items[0][price_data][product_data][name]",
      `${packSize} magnets`
    );
    params.append(
      "line_items[0][price_data][product_data][description]",
      `Custom photo magnets (${packSize}-pack)`
    );

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!stripeRes.ok) {
      const text = await stripeRes.text();
      console.error("Stripe checkout error:", text);
      return jsonError("Failed to create checkout.", 500, text);
    }

    const session = await stripeRes.json();

    // Store Stripe IDs back on the order
    order.stripeSessionId = session.id;
    // PaymentIntent will be attached later, but store if already present
    if (session.payment_intent) {
      order.stripePaymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent.id;
    }

    await ORDERS_KV.put(orderId, JSON.stringify(order));

    return new Response(
      JSON.stringify({
        ok: true,
        url: session.url,
        orderId,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("Checkout handler error:", err);
    return jsonError("Unexpected error during checkout.", 500, String(err));
  }
}

function jsonError(message, status = 400, details) {
  const body = { error: message };
  if (details) body.details = details;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
