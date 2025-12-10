// functions/api/webhook.js
// Stripe webhook handler for checkout.session.completed

export const onRequestPost = async ({ request, env }) => {
  let rawBody = "";
  try {
    rawBody = await request.text();
    const event = JSON.parse(rawBody);

    const type = event?.type;
    const session = event?.data?.object;

    if (type !== "checkout.session.completed" || !session) {
      return json({ received: true, ignored: true });
    }

    // --- Extract orderId ---
    let orderId = session.metadata?.orderId;

    if (!orderId && session.success_url) {
      try {
        const u = new URL(session.success_url);
        orderId = u.searchParams.get("orderId") || orderId;
      } catch {}
    }
    if (!orderId && session.cancel_url) {
      try {
        const u = new URL(session.cancel_url);
        orderId = u.searchParams.get("orderId") || orderId;
      } catch {}
    }

    if (!orderId) {
      console.error("Stripe webhook: no orderId found in session", session.id);
      return json({ received: true, noOrderId: true });
    }

    const ordersKV = env.ORDERS_KV;
    if (!ordersKV) {
      console.error("Stripe webhook: ORDERS_KV binding missing");
      return json({ error: "ORDERS_KV missing" }, 200);
    }

    // 1. Fetch existing order
    const kvKey = `order:${orderId}`;
    const rawOrder = await ordersKV.get(kvKey);

    if (!rawOrder) {
      console.error("Stripe webhook: order not found for orderId", orderId);
      return json({ received: true, orderNotFound: true });
    }

    const order = JSON.parse(rawOrder);

    // 2. Update order fields (Preserving existing data like phone/packType)
    order.status = "paid";
    order.paidAt = new Date().toISOString();
    order.stripeSessionId = session.id;
    order.stripePaymentIntentId = session.payment_intent || order.stripePaymentIntentId;

    // --- ADDRESS FIX: Check both shipping and customer details ---
    const shipping = session.shipping_details || session.customer_details;
    
    order.customer = {
      email: session.customer_details?.email || order.email,
      name: shipping?.name || session.customer_details?.name || null,
      address: shipping?.address || session.customer_details?.address || null,
    };

    // 3. Save back to KV
    await ordersKV.put(kvKey, JSON.stringify(order), {
      expirationTtl: 60 * 60 * 24 * 30, // 30 days
    });

    // 4. Send Notifications
    await Promise.allSettled([
      sendPaidEmail(order, env),
      sendAdminEmail(order, env),
      sendPaidTelegram(order, env),
    ]);

    return json({ received: true, updated: true });
  } catch (err) {
    console.error("webhook error:", err, "rawBody:", rawBody);
    return json({ error: err.message || "Webhook error", received: true });
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildTotalText(order) {
  if (typeof order.price === "number") {
    return "£" + order.price.toFixed(2);
  }
  return "£" + (order.price ?? "");
}

// ------------- CUSTOMER EMAIL (Resend) -------------
async function sendPaidEmail(order, env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;

  if (!apiKey || !from || !order.email) return;

  const subject = "We’ve received your Magnetic Memories order";
  const totalText = buildTotalText(order);

  const html = `
    <div style="font-family: system-ui, sans-serif;">
      <h2>Thanks for your order!</h2>
      <p>We’ve received your payment and will start preparing your magnets shortly.</p>
      <p>
        <strong>Order ID:</strong> ${order.orderId}<br/>
        <strong>Pack:</strong> ${order.packSize || "?"} magnets<br/>
        <strong>Total:</strong> ${totalText}
      </p>
      <p>
        Track your order here:<br/>
        <a href="https://magnetic-memories.pages.dev/return.html?orderId=${encodeURIComponent(order.orderId)}">Track Order</a>
      </p>
      <p>— Magnetic Memories</p>
    </div>
  `;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [order.email], subject, html }),
  });
}

// ------------- ADMIN EMAIL (Resend) -------------
async function sendAdminEmail(order, env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  const notifyRaw = env.NOTIFY_EMAIL || "";
  const recipients = notifyRaw.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);

  if (!apiKey || !from || recipients.length === 0) return;

  const subject = `New paid order – ${order.orderId}`;
  const totalText = buildTotalText(order);
  const customerEmail = order.email || order.customer?.email || "Unknown";
  
  // --- ADDED PHONE TO ADMIN EMAIL ---
  const customerPhone = order.phone || "No phone"; 

  const html = `
    <div style="font-family: system-ui, sans-serif;">
      <h2>New paid order</h2>
      <p>
        <strong>Order ID:</strong> ${order.orderId}<br/>
        <strong>Status:</strong> ${order.status}<br/>
        <strong>Customer:</strong> ${customerEmail}<br/>
        <strong>Phone:</strong> ${customerPhone}<br/>
        <strong>Pack:</strong> ${order.packSize} magnets (${order.packType || 'standard'})<br/>
        <strong>Total:</strong> ${totalText}
      </p>
      <p>
        <a href="https://magnetic-memories.pages.dev/admin.html">Open Admin Dashboard</a>
      </p>
    </div>
  `;

  await Promise.all(recipients.map(to => 
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
    })
  ));
}

// ------------- TELEGRAM -------------
async function sendPaidTelegram(order, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatIdsRaw = env.TELEGRAM_CHAT_ID;

  if (!token || !chatIdsRaw) return;

  const chatIds = chatIdsRaw.split(",").map((id) => id.trim()).filter(Boolean);
  if (!chatIds.length) return;

  const lines = [
    "💳 *New paid order*",
    `ID: \`${order.orderId}\``,
    `Email: ${order.email || "Unknown"}`,
    `Phone: ${order.phone || "No phone"}`,
    `Pack: ${order.packSize} magnets (${order.packType || 'standard'})`,
    typeof order.price === "number" ? `Total: £${order.price.toFixed(2)}` : null,
  ].filter(Boolean);

  const text = lines.join("\n");
  const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;

  await Promise.all(chatIds.map(chatId =>
    fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    }).catch(console.error)
  ));
}