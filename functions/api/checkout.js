// functions/api/checkout.js

import Stripe from "stripe";

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: "2020-08-27",
    });

    const body = await request.json();
    const { orderId } = body || {};

    if (!orderId) {
      return jsonResponse(400, { error: "Missing orderId" });
    }

    const kv = env.ORDERS_KV;
    const raw = await kv.get(orderId);
    if (!raw) {
      return jsonResponse(404, { error: "Order not found" });
    }

    const order = JSON.parse(raw);

    // --- Coerce packSize to a number (THIS IS THE IMPORTANT BIT) ---
    const packSize = Number(order.packSize);

    if (!order.email || !packSize || Number.isNaN(packSize)) {
      return jsonResponse(400, { error: "Order is missing email or pack size." });
    }

    // Ensure we have exactly N images in KV
    if (
      !Array.isArray(order.images) ||
      order.images.length !== packSize
    ) {
      return jsonResponse(400, {
        error: `You must upload exactly ${packSize} photos for this pack.`,
      });
    }

    // Optional: ensure all images are cropped if you track that flag
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
      3: 700,   // £7.00
      6: 1200,  // £12.00
      9: 1600,  // £16.00
    };

    const unitAmount = amountByPack[packSize];
    if (!unitAmount) {
      return jsonResponse(400, { error: "Unsupported pack size." });
    }

    const origin = new URL(request.url).origin;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: order.email,
      line_items: [
        {
          price_data: {
            currency: "gbp",
            unit_amount: unitAmount,
            product_data: {
              name: `${packSize} custom photo magnets`,
              description: `${packSize} × 50×50mm photo magnets`,
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${origin}/return.html?status=success&orderId=${orderId}`,
      cancel_url: `${origin}/return.html?status=cancel&orderId=${orderId}`,
      metadata: {
        orderId,
        email: order.email,
        packSize: String(packSize),
      },
    });

    // Update order in KV
    const updated = {
      ...order,
      status: "checkout_created",
      stripeSessionId: session.id,
      // store price in pounds for admin view
      price: unitAmount / 100,
      updatedAt: new Date().toISOString(),
    };

    await kv.put(orderId, JSON.stringify(updated));

    return jsonResponse(200, {
      url: session.url,
      order: updated,
    });
  } catch (err) {
    console.error("Error in /api/checkout:", err);
    return jsonResponse(500, {
      error: "Failed to create checkout session",
    });
  }
}
