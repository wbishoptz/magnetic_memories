// functions/api/checkout.js
// POST /api/checkout -> create Stripe Checkout session

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
    const targetCountry = body?.country || "GI"; 
    const packType = body?.packType || "standard"; 

    if (!orderId) {
      return jsonResponse({ error: "Missing orderId." }, 400);
    }

    const kvKey = `order:${orderId}`;
    let kvOrder = null;
    try {
      const kvRaw = await env.ORDERS_KV.get(kvKey);
      if (kvRaw) kvOrder = JSON.parse(kvRaw);
    } catch (e) {
      console.error("KV get error:", e);
    }

    const emailFromBody = String(body?.email || "").trim();
    const packSizeFromBody = Number(body?.packSize || 0) || 3;

    const email = String((kvOrder && kvOrder.email) || emailFromBody || "").trim();
    let packSize = (kvOrder && Number(kvOrder.packSize || kvOrder.pack)) || packSizeFromBody || 3;
    if (!PACKS.includes(packSize)) packSize = 3;

    const price = (kvOrder && kvOrder.price) || PRICES[packSize] || PRICES[3];
    const amount = price * 100;

    const successUrl = `https://magnetic-memories.pages.dev/return.html?status=success&orderId=${encodeURIComponent(orderId)}`;
    const cancelUrl = `https://magnetic-memories.pages.dev/return.html?status=cancel&orderId=${encodeURIComponent(orderId)}`;

    const params = new URLSearchParams();

    params.append("mode", "payment");
    params.append("allow_promotion_codes", "true");
    
    // Disable currency conversion toggle
    params.append("automatic_tax[enabled]", "false");

    params.append("success_url", successUrl);
    params.append("cancel_url", cancelUrl);

    // --- PRODUCT DESCRIPTION ---
    let productName = `${packSize} custom photo magnets`;
    let productDesc = "50×50mm fridge magnets – printed using your uploaded photos.";
    
    if (packType === 'big_picture') {
        productName = `Jigsaw Picture (${packSize} magnets)`;
        productDesc = `One large photo split across ${packSize} magnets (Jigsaw style).`;
    }

    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", "gbp");
    params.append("line_items[0][price_data][product_data][name]", productName);
    params.append("line_items[0][price_data][product_data][description]", productDesc);
    params.append("line_items[0][price_data][unit_amount]", String(amount));

    if (email) params.append("customer_email", email);
    params.append("metadata[orderId]", orderId);

    // --- SMART SHIPPING LOGIC ---
    if (targetCountry === "GB") {
        params.append("shipping_address_collection[allowed_countries][0]", "GB");
        
        params.append("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
        params.append("shipping_options[0][shipping_rate_data][fixed_amount][amount]", "500");
        params.append("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "gbp");
        params.append("shipping_options[0][shipping_rate_data][display_name]", "UK Postage");
        params.append("shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]", "business_day");
        params.append("shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]", "5");
        params.append("shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]", "business_day");
        params.append("shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]", "10");
    } else {
        params.append("shipping_address_collection[allowed_countries][0]", "GI");

        params.append("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
        params.append("shipping_options[0][shipping_rate_data][fixed_amount][amount]", "0");
        params.append("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "gbp");
        params.append("shipping_options[0][shipping_rate_data][display_name]", "Local Delivery (Gibraltar)");
        params.append("shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]", "business_day");
        params.append("shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]", "1");
        params.append("shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]", "business_day");
        params.append("shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]", "2");
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

    // Save back to KV with PERMISSION preserved
    const now = new Date().toISOString();
    const updatedOrder = {
      orderId,
      email,
      packSize,
      packType: kvOrder?.packType || packType,
      phone: kvOrder?.phone || null, 
      socialPermission: kvOrder?.socialPermission || false, // <--- PRESERVE THIS!
      price,
      status: "checkout_created",
      createdAt: kvOrder?.createdAt || now,
      images: kvOrder?.images || [],
      stripeSessionId: session.id,
      stripePaymentIntentId: session.payment_intent ?? null,
    };

    try {
      await env.ORDERS_KV.put(kvKey, JSON.stringify(updatedOrder));
    } catch (e) {
      console.error("KV put error:", e);
    }

    return jsonResponse({ checkoutUrl: session.url });
  } catch (err) {
    console.error("ERROR in /api/checkout:", err);
    return jsonResponse({ error: "Failed to create checkout." }, 500);
  }
}