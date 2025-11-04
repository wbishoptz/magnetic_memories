// functions/api/checkout.js
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { orderId } = await request.json();
    if (!orderId) {
      return new Response(JSON.stringify({ error: "Missing orderId" }), { status: 400 });
    }

    // 1) Fetch the order
    const orderKey = `order:${orderId}`;
    const orderJson = await env.ORDERS_KV.get(orderKey);
    if (!orderJson) {
      return new Response(JSON.stringify({ error: "Order not found" }), { status: 404 });
    }

    const order = JSON.parse(orderJson);
    const amount = order.price;
    const currency = env.CURRENCY || "GBP";

    // 2) Get a SumUp access token
    const tokenRes = await fetch("https://api.sumup.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.SUMUP_CLIENT_ID,
        client_secret: env.SUMUP_CLIENT_SECRET,
      }),
    });

    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      throw new Error("Failed to get SumUp token: " + txt);
    }

    const { access_token } = await tokenRes.json();

    // 3) Create the checkout session
    const checkoutRes = await fetch("https://api.sumup.com/v0.1/checkouts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount,
        currency,
        checkout_reference: orderId,
        description: `Magnetic Memories (${order.packSize} magnets)`,
        pay_to_email: "", // optional; can stay empty for your own account
        return_url: `${env.APP_BASE_URL}/return?orderId=${orderId}`,
      }),
    });

    if (!checkoutRes.ok) {
      const txt = await checkoutRes.text();
      throw new Error("Failed to create checkout: " + txt);
    }

    const checkoutData = await checkoutRes.json();
    const checkoutUrl = checkoutData.checkout_url;

    // 4) Update order status in KV
    order.status = "awaiting_payment";
    order.checkoutId = checkoutData.id || null;
    order.updatedAt = new Date().toISOString();
    await env.ORDERS_KV.put(orderKey, JSON.stringify(order));

    return new Response(JSON.stringify({ checkoutUrl }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
