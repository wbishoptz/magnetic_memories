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

    // Address Capture
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

// Helper: Escape HTML characters for Telegram
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Helper: Retry Fetch (3 attempts)
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      // If it's a 400 error (Bad Request), retrying won't help, so stop.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return res;
    } catch (err) {
      console.error(`Fetch attempt ${i + 1} failed:`, err);
    }
    // Wait 1 second before retrying
    if (i < retries - 1) await new Promise(r => setTimeout(r, 1000));
  }
  return null;
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

// ------------- TELEGRAM (UPDATED: HTML + Retry) -------------
async function sendPaidTelegram(order, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatIdsRaw = env.TELEGRAM_CHAT_ID;

  if (!token || !chatIdsRaw) return;

  const chatIds = chatIdsRaw.split(",").map((id) => id.trim()).filter(Boolean);
  if (!chatIds.length) return;

  const total = typeof order.price === "number" ? `£${order.price.toFixed(2)}` : "Paid";
  const jigsaw = order.packType === 'big_picture' ? ' (🧩 Jigsaw)' : '';

  // Use HTML tags (<b>, <code>) instead of Markdown (*, `)
  const lines = [
    "💳 <b>New paid order</b>",
    `ID: <code>${esc(order.orderId)}</code>`,
    `Email: ${esc(order.email || "Unknown")}`,
    `Phone: ${esc(order.phone || "No phone")}`,
    `Pack: ${esc(order.packSize)} magnets${jigsaw}`,
    `Total: ${esc(total)}`
  ].filter(Boolean);

  const text = lines.join("\n");
  const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;

  // Send to all admin chats with Retry
  await Promise.all(chatIds.map(chatId =>
    fetchWithRetry(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
          chat_id: chatId, 
          text, 
          parse_mode: "HTML" // <--- SWITCHED TO HTML (Safe!)
      }),
    }).then(res => {
       if (!res || !res.ok) console.error("Telegram failed:", res ? res.status : "Network Error");
    })
  ));
}