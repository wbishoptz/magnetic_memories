// functions/api/order.js
// Creates a new order (POST) and returns an order by ID (GET)

const PACK_PRICES = {
  3: 7,
  6: 14,
  9: 20,
  12: 25,
  15: 30,
};

/**
 * Utility: create a simple UUID using crypto
 */
function generateOrderId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback – good enough for our use here
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).substring(2, 10)
  );
}

/**
 * POST /api/order
 * Body: { email, packSize, images: [...], cropping: [...] }
 * - validates payload
 * - creates order in KV with status "checkout_created"
 * - creates Stripe Checkout Session
 * - updates order with stripeSessionId
 * - returns { orderId, checkoutUrl }
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();

    const email = (body.email || "").trim().toLowerCase();
    const packSize = Number(body.packSize);
    const images = Array.isArray(body.images) ? body.images : [];
    const cropping = Array.isArray(body.cropping) ? body.cropping : [];

    // Basic validation
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return jsonResponse(
        { error: "Invalid email address" },
        { status: 400 }
      );
    }

    if (!PACK_PRICES[packSize]) {
      return jsonResponse(
        { error: "Invalid pack size" },
        { status: 400 }
      );
    }

    if (images.length !== packSize) {
      return jsonResponse(
        {
          error: `You must upload exactly ${packSize} photos for this pack.`,
        },
        { status: 400 }
      );
    }

    const price = PACK_PRICES[packSize]; // numeric, in £
    const amountInPence = price * 100;

    const orderId = generateOrderId();
    const createdAt = new Date().toISOString();

    // Initial order record
    const orderRecord = {
      orderId,
      email,
      packSize,
      price, // numeric £ value
      status: "checkout_created",
      createdAt,
      images,
      cropping,
      stripeSessionId: null,
      stripePaymentIntentId: null,
    };

    // Save initial order to KV
    await env.ORDERS_KV.put(
      `order:${orderId}`,
      JSON.stringify(orderRecord)
    );

    // Create Stripe Checkout Session
    const stripeSecretKey = env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey) {
      return jsonResponse(
        { error: "Stripe not configured" },
        { status: 500 }
      );
    }

    const successUrl = `https://magnetic-memories.pages.dev/return.html?status=success&orderId=${orderId}`;
    const cancelUrl = `https://magnetic-memories.pages.dev/return.html?status=cancel&orderId=${orderId}`;

    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("success_url", successUrl);
    params.set("cancel_url", cancelUrl);
    params.set("currency", "gbp");
    params.set("billing_address_collection", "auto");
    params.set("allow_promotion_codes", "true");

    // line_items[0]…
    params.set("line_items[0][quantity]", "1");
    params.set("line_items[0][price_data][currency]", "gbp");
    params.set("line_items[0][price_data][unit_amount]", String(amountInPence));
    params.set(
      "line_items[0][price_data][product_data][name]",
      `${packSize} magnets`
    );
    params.set(
      "line_items[0][price_data][product_data][description]",
      `${packSize} custom photo magnets`
    );

    const stripeRes = await fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      }
    );

    if (!stripeRes.ok) {
      const errText = await stripeRes.text();
      console.error("Stripe error:", errText);

      // mark order as failed in KV
      orderRecord.status = "checkout_failed";
      orderRecord.stripeError = errText;
      await env.ORDERS_KV.put(
        `order:${orderId}`,
        JSON.stringify(orderRecord)
      );

      return jsonResponse(
        {
          error: "Failed to create Stripe checkout session",
        },
        { status: 500 }
      );
    }

    const session = await stripeRes.json();

    // Update order with Stripe session IDs
    orderRecord.stripeSessionId = session.id || null;
    orderRecord.stripePaymentIntentId =
      (session.payment_intent && session.payment_intent.id) ||
      session.payment_intent ||
      null;

    await env.ORDERS_KV.put(
      `order:${orderId}`,
      JSON.stringify(orderRecord)
    );

    return jsonResponse({
      orderId,
      checkoutUrl: session.url,
    });
  } catch (err) {
    console.error("Error in POST /api/order:", err);
    return jsonResponse(
      { error: "Failed to create order" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/order?orderId=...
 * Returns a single order record (used by return.html)
 */
export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId");

    if (!orderId) {
      return jsonResponse(
        { error: "Missing orderId" },
        { status: 400 }
      );
    }

    const raw = await env.ORDERS_KV.get(`order:${orderId}`);
    if (!raw) {
      return jsonResponse(
        { error: "Order not found" },
        { status: 404 }
      );
    }

    const order = JSON.parse(raw);
    return jsonResponse(order);
  } catch (err) {
    console.error("Error in GET /api/order:", err);
    return jsonResponse(
      { error: "Failed to load order" },
      { status: 500 }
    );
  }
}

/**
 * Small helper to build JSON responses
 */
function jsonResponse(data, { status = 200 } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
