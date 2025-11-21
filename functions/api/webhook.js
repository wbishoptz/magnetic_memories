// functions/api/webhook.js
// Stripe webhook handler
//
// Config in Stripe Dashboard: endpoint = https://your-domain/api/webhook
// Events: checkout.session.completed
//
// This handler:
//  - marks the order as "paid" in KV
//  - stores Stripe session/payment IDs
//  - sends:
//      * email to customer (if RESEND_API_KEY etc. configured)
//      * email(s) to you (NOTIFY_EMAIL can be a comma-separated list)
//      * Telegram message (if TELEGRAM_* configured)

export const onRequestPost = async ({ request, env }) => {
  try {
    const payload = await request.json();

    if (!payload || !payload.type) {
      return json({ error: "Invalid payload" }, 400);
    }

    if (payload.type !== "checkout.session.completed") {
      // For now we only care about checkout completion
      return json({ received: true, ignoredType: payload.type });
    }

    const session = payload.data?.object;
    if (!session) {
      return json({ error: "No session object" }, 400);
    }

    const orderId = session.metadata?.orderId;
    if (!orderId) {
      console.warn("checkout.session.completed without orderId metadata");
      return json({ received: true });
    }

    const email =
      session.customer_email ||
      session.metadata?.email ||
      session.customer_details?.email;

    const ordersKV = env.ORDERS_KV;
    if (!ordersKV) {
      console.error("ORDERS_KV binding missing in webhook");
      return json({ error: "ORDERS_KV binding missing" }, 500);
    }

    const kvKey = `order:${orderId}`;
    const raw = await ordersKV.get(kvKey);
    if (!raw) {
      console.warn("Order not found in KV for orderId", orderId);
      return json({ received: true, warning: "Order not found" });
    }

    const order = JSON.parse(raw);

    order.status = "paid";
    order.statusUpdatedAt = new Date().toISOString();
    if (email && !order.email) {
      order.email = email;
    }
    order.stripeSessionId = session.id;
    order.stripePaymentIntentId = session.payment_intent;

    await ordersKV.put(kvKey, JSON.stringify(order), {
      expirationTtl: 60 * 60 * 24 * 30,
    });

    // Kick off notifications (fire-and-forget)
    notifyAll(order, env).catch((err) =>
      console.error("Notification error", err)
    );

    return json({ received: true, orderId, status: order.status });
  } catch (err) {
    console.error("Stripe webhook error:", err);
    return json(
      { error: err.message || "Webhook handler error" },
      500
    );
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function notifyAll(order, env) {
  await Promise.allSettled([
    sendCustomerEmail(order, env),
    sendOwnerEmail(order, env),
    sendTelegram(order, env),
  ]);
}

// -------- Customer email --------

async function sendCustomerEmail(order, env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  if (!apiKey || !from || !order.email) {
    console.log("Skipping customer email – missing config or email");
    return;
  }

  const subject = "Your Magnetic Memories order";
  const html = `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
      <h2>Thank you for your order 🎉</h2>
      <p>We've received your photos and payment. We'll start preparing your magnets shortly.</p>
      <p>
        <strong>Order ID:</strong> ${order.orderId}<br/>
        <strong>Pack:</strong> ${order.packSize || "?"} magnets<br/>
        <strong>Total:</strong> £${order.price ?? ""}.00
      </p>
      <p>If you need to contact us about this order, please include your order ID.</p>
      <p>— Magnetic Memories</p>
    </div>
  `;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [order.email],
      subject,
      html,
    }),
  });
}

// -------- Owner / admin email(s) --------

async function sendOwnerEmail(order, env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  const notify = env.NOTIFY_EMAIL;

  if (!apiKey || !from || !notify) {
    console.log("Skipping owner email – missing config");
    return;
  }

  // Support multiple addresses in NOTIFY_EMAIL separated by commas
  const recipients = notify
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  if (!recipients.length) {
    console.log("Skipping owner email – NOTIFY_EMAIL is empty after parsing");
    return;
  }

  const subject = `New order: ${order.orderId} (£${order.price ?? ""})`;
  const html = `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
      <h2>New paid order</h2>
      <p>
        <strong>Order ID:</strong> ${order.orderId}<br/>
        <strong>Email:</strong> ${order.email || "Unknown"}<br/>
        <strong>Pack:</strong> ${order.packSize || "?"} magnets<br/>
        <strong>Total:</strong> £${order.price ?? ""}.00<br/>
        <strong>Status:</strong> ${order.status}
      </p>
      <p>Open the admin dashboard to download images and update the status.</p>
    </div>
  `;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: recipients,
      subject,
      html,
    }),
  });
}

// -------- Telegram notification --------

async function sendTelegram(order, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("Skipping Telegram – missing config");
    return;
  }

  const text = [
    "🧲 New Magnetic Memories order",
    `Order ID: ${order.orderId}`,
    `Email: ${order.email || "Unknown"}`,
    `Pack: ${order.packSize || "?"} magnets`,
    `Total: £${order.price ?? ""}.00`,
    `Status: ${order.status}`,
  ].join("\n");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });
}
