// functions/api/checkout.js

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const kv = env.ORDERS_KV;

    const body = await request.json();
    const { orderId } = body || {};

    if (!orderId) {
      return jsonResponse(400, { error: "Missing orderId" });
    }

    const raw = await kv.get(orderId);
    if (!raw) {
      return jsonResponse(404, { error: "Order not found" });
    }

    const order = JSON.parse(raw);

    // --- Make sure packSize is a number ---
    const packSize = Number(order.packSize);

    if (!order.email || !packSize || Number.isNaN(packSize)) {
      return jsonResponse(400, {
        error: "Order is missing email or pack size.",
      });
    }

    // Validate image count vs pack size
    if (!Array.isArray(order.images) || order.images.length !== packSize) {
      return jsonResponse(400, {
        error: `You must upload exactly ${packSize} photos for this pack.`,
      });
    }

    // Optional: make sure all images are cropped if you track a `cropped` flag
    const notCropped = order.images.find(
      (img) => img && img.cropped === false
    );
    if (notCropped) {
      return jsonResponse(400, {
        error: "Please crop all of your photos before paying.",
      });
    }

    // Price table in pence
    const amountByPack = {
      3: 700,  // £7.00
      6: 1200, // £12.00
      9: 1600, // £16.00
    };

    const unitAmount = amountByPack[packSize];
    if (!unitAmount) {
      return jsonResponse(400, { error: "Unsupported pack size." });
    }

    const origin = new URL(request.url).origin;

    // Build form-encoded payload for Stripe Checkout Session
    const params = new URLSearchParams({
      mode: "payment",
      success_url: `${origin}/return.html?status=success&orderId=${orderId}`,
      cancel_url: `${origin}/return.html?status=cancel&orderId=${orderId}`,
      "customer_email": order.email,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "gbp",
      "line_items[0][price_data][unit_amount]": String(unitAmount),
      "line_items[0][price_data][product_data][name]": `${packSize} custom photo magnets`,
      "line_items[0][price_data][product_data][description]": `${packSize} × 50×50mm photo magnets`,
      "metadata[orderId]": orderId,
      "metadata[email]": order.email,
      "metadata[packSize]": String(packSize),
    });

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const stripeJson = await stripeRes.json();

    if (!stripeRes.ok) {
      console.error("Stripe error creating checkout:", stripeJson);
      return jsonResponse(500, {
        error: "Failed to create checkout session with Stripe.",
      });
    }

    const sessionId = stripeJson.id;
    const sessionUrl = stripeJson.url;

    // Update order in KV with checkout info
    const updatedOrder = {
      ...order,
      status: "checkout_created",
      stripeSessionId: sessionId,
      // store price in pounds so admin table shows £ properly
      price: unitAmount / 100,
      updatedAt: new Date().toISOString(),
    };

    await kv.put(orderId, JSON.stringify(updatedOrder));

    return jsonResponse(200, {
      url: sessionUrl,
      order: updatedOrder,
    });
  } catch (err) {
    console.error("Error in /api/checkout:", err);
    return jsonResponse(500, {
      error: "Failed to create checkout session",
    });
  }
}
