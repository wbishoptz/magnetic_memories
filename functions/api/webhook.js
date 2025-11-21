// functions/api/webhook.js
// Stripe webhook handler for checkout.session.completed
//
// Env used:
//  - ORDERS_KV
//  - RESEND_API_KEY
//  - RESEND_FROM_EMAIL
//  - NOTIFY_EMAIL      (comma-separated list for internal notifications)
//  - TELEGRAM_BOT_TOKEN
//  - TELEGRAM_CHAT_ID  (comma-separated list)

export const onRequestPost = async ({ request, env }) => {
  let rawBody = "";
  try {
    rawBody = await request.text();
    const event = JSON.parse(rawBody);

    const type = event?.type;
    const session = event?.data?.object;

    if (type !== "checkout.session.completed" || !session) {
      // Not an event we care about – just acknowledge
      return json({ received: true, ignored: true });
    }

    // --- Extract orderId ---

    // 1) Ideal: from metadata
    let orderId = session.metadata?.orderId;

    // 2) Fallback: parse from success_url / cancel_url query
    if (!orderId && session.success_url) {
      try {
        const u = new URL(session.success_url);
        orderId = u.searchParams.get("orderId") || orderId;
      } catch {
        // ignore
      }
    }
    if (!orderId && session.cancel_url) {
      try {
        const u = new URL(session.cancel_url);
        orderId = u.searchParams.get("orderId") || orderId;
      } catch {
        // ignore
      }
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

    const kvKey = `order:${orderId}`;
    const rawOrder = await ordersKV.get(kvKey);

    if (!rawOrder) {
      console.error("Stripe webhook: order not found for orderId", orderId);
      return json({ received: true, orderNotFound: true });
    }

    const order = JSON.parse(rawOrder);

    // --- Update order fields ---

    order.status = "paid";
    order.paidAt = new Date().toISOString();
    order.stripeSessionId = session.id;
    order.stripePaymentIntentId =
      session.payment_intent || order.stripePaymentIntentId;

    order.customer = {
      email: session.customer_details?.email || order.email,
      name: session.customer_details?.name || null,
      address: session.customer_details?.address || null,
    };

    await ordersKV.put(kvKey, JSON.stringify(order), {
      expirationTtl: 60 * 60 * 24 * 30, // 30 days
    });

    // --- Wait for all notifications (customer + internal + telegram) ---

    await Promise.allSettled([
      sendPaidEmail(order, env),
      sendAdminEmail(order, env),
      sendPaidTelegram(order, env),
    ]);

    return json({ received: true, updated: true });
  } catch (err) {
    console.error("webhook error:", err, "rawBody:", rawBody);
    // Still return 200 so Stripe doesn’t spam retries
    return json({ error: err.message || "Webhook error", received: true });
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- Helpers ----------

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

  if (!apiKey || !from || !order.email) {
    console.log(
      "Skipping paid CUSTOMER email – missing RESEND config or order email",
      { hasApiKey: !!apiKey, hasFrom: !!from, email: order.email }
    );
    return;
  }

  const subject = "We’ve received your Magnetic Memories order";
  const totalText = buildTotalText(order);

  const html = `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
      <h2>Thanks for your order!</h2>
      <p>We’ve received your payment and will start preparing your magnets shortly.</p>
      <p>
        <strong>Order ID:</strong> ${order.orderId}<br/>
        <strong>Status:</strong> paid<br/>
        <strong>Pack:</strong> ${order.packSize || "?"} magnets<br/>
        <strong>Total:</strong> ${totalText}
      </p>
      <p>
        You can track your order status here:<br/>
        <a href="https://magnetic-memories.pages.dev/return.html?orderId=${encodeURIComponent(
          order.orderId
        )}">
          Track your order
        </a>
      </p>
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

// ------------- ADMIN / INTERNAL EMAIL (Resend) -------------

async function sendAdminEmail(order, env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  const notifyRaw = env.NOTIFY_EMAIL || "";

  const recipients = notifyRaw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  if (!apiKey || !from || recipients.length === 0) {
    console.log("Skipping ADMIN email – missing RESEND/NOTIFY_EMAIL config", {
      hasApiKey: !!apiKey,
      hasFrom: !!from,
      recipients,
    });
    return;
  }

  const subject = `New paid order – ${order.orderId}`;
  const totalText = buildTotalText(order);

  const customerEmail = order.email || order.customer?.email || "Unknown";

  const html = `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
      <h2>New paid order</h2>
      <p>A customer has just completed a Stripe checkout.</p>
      <p>
        <strong>Order ID:</strong> ${order.orderId}<br/>
        <strong>Status:</strong> ${order.status}<br/>
        <strong>Customer email:</strong> ${customerEmail}<br/>
        <strong>Pack:</strong> ${order.packSize || "?"} magnets<br/>
        <strong>Total:</strong> ${totalText}<br/>
        <strong>Created:</strong> ${order.createdAt || ""}<br/>
        <strong>Paid at:</strong> ${order.paidAt || ""}<br/>
      </p>
      <p>
        <strong>Stripe session:</strong> ${order.stripeSessionId || ""}<br/>
        <strong>Payment intent:</strong> ${order.stripePaymentIntentId || ""}<br/>
      </p>
      <p>
        Admin dashboard:<br/>
        <a href="https://magnetic-memories.pages.dev/admin.html">
          Open admin dashboard
        </a>
      </p>
      <p>
        Customer tracking page:<br/>
        <a href="https://magnetic-memories.pages.dev/return.html?orderId=${encodeURIComponent(
          order.orderId
        )}">
          View customer order page
        </a>
      </p>
      <hr/>
      <p style="font-size: 12px; color: #888;">
        This email was sent to: ${recipients.join(", ")}
      </p>
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

// ------------- TELEGRAM (admin group) -------------

async function sendPaidTelegram(order, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatIdsRaw = env.TELEGRAM_CHAT_ID;
  const notifyEmail = env.NOTIFY_EMAIL || "";

  if (!token || !chatIdsRaw) {
    console.log("Skipping paid Telegram – missing bot config");
    return;
  }

  const chatIds = chatIdsRaw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!chatIds.length) return;

  const lines = [
    "💳 New paid order",
    `Order ID: ${order.orderId}`,
    `Email: ${order.email || "Unknown"}`,
    `Pack: ${order.packSize || "?"} magnets`,
    typeof order.price === "number"
      ? `Total: £${order.price.toFixed(2)}`
      : null,
    notifyEmail ? `Internal notify: ${notifyEmail}` : null,
  ].filter(Boolean);

  const text = lines.join("\n");
  const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;

  await Promise.all(
    chatIds.map((chatId) =>
      fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
        }),
      }).catch((err) =>
        console.error("Telegram send error for chat", chatId, err)
      )
    )
  );
}
