// functions/api/webhook.js
// Stripe webhook handler for checkout.session.completed

export const onRequestPost = async ({ request, env }) => {
  let rawBody = "";
  try {
    rawBody = await request.text();
    const event = JSON.parse(rawBody);

    const type = event?.type;
    const session = event?.data?.object;

    // Ignore non-completion events
    if (type !== "checkout.session.completed" || !session) {
      return json({ received: true, ignored: true });
    }

    // --- 1. Extract Order ID ---
    let orderId = session.metadata?.orderId;

    // Fallback: Check URLs if metadata is missing
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
      console.error("Stripe webhook: no orderId found", session.id);
      return json({ received: true, noOrderId: true });
    }

    const ordersKV = env.ORDERS_KV;
    if (!ordersKV) return json({ error: "ORDERS_KV missing" }, 200);

    // --- 2. Fetch Existing Order ---
    const kvKey = `order:${orderId}`;
    const rawOrder = await ordersKV.get(kvKey);

    if (!rawOrder) {
      console.error("Order not found:", orderId);
      return json({ received: true, orderNotFound: true });
    }

    const order = JSON.parse(rawOrder);

    // --- 3. Update Basic Fields ---
    order.status = "paid";
    order.paidAt = new Date().toISOString();
    order.stripeSessionId = session.id;
    order.stripePaymentIntentId = session.payment_intent || order.stripePaymentIntentId;

    // Capture Address (Check both locations)
    const shipping = session.shipping_details || session.customer_details;
    order.customer = {
      email: session.customer_details?.email || order.email,
      name: shipping?.name || session.customer_details?.name || null,
      address: shipping?.address || session.customer_details?.address || null,
    };

    // --- 4. VOUCHER LOGIC: Creation ---
    // If the customer BOUGHT a voucher (metadata passed from checkout.js)
    if (session.metadata?.isVoucher === "true") {
        const val = Number(session.metadata.voucherValue);
        // Generate a random code (e.g., MM-7X9K)
        const code = "MM-" + Math.random().toString(36).substring(2, 6).toUpperCase();
        
        // Save the new voucher to the database
        const voucherData = {
            code,
            value: val,
            redeemed: false,
            createdAt: new Date().toISOString(),
            purchasedBy: order.email,
            orderId: orderId
        };
        await env.ORDERS_KV.put(`voucher:${code}`, JSON.stringify(voucherData));

        // Save code to order so we know to send the specific email
        order.generatedVoucher = code;
        order.voucherValue = val;
    }

    // --- 5. VOUCHER LOGIC: Redemption ---
    // If the customer USED a voucher to pay
    if (session.metadata?.usedVoucher) {
        const code = session.metadata.usedVoucher;
        const vKey = `voucher:${code}`;
        const vRaw = await env.ORDERS_KV.get(vKey);
        if (vRaw) {
            const vData = JSON.parse(vRaw);
            vData.redeemed = true;
            vData.usedByOrder = orderId;
            await env.ORDERS_KV.put(vKey, JSON.stringify(vData));
        }
    }

    // --- 6. Save Order to Database ---
    await ordersKV.put(kvKey, JSON.stringify(order), {
      expirationTtl: 60 * 60 * 24 * 30, // 30 days
    });

    // --- 7. Send Notifications ---
    const notifications = [
        sendAdminEmail(order, env),
        sendPaidTelegram(order, env)
    ];

    if (order.generatedVoucher) {
        // Send Gift Voucher Email
        notifications.push(sendVoucherEmail(order.email, order.generatedVoucher, order.voucherValue, env));
    } else {
        // Send Standard "Preparing Order" Email
        notifications.push(sendPaidEmail(order, env));
    }

    await Promise.allSettled(notifications);

    return json({ received: true, updated: true });

  } catch (err) {
    console.error("Webhook error:", err, "Body:", rawBody);
    return json({ error: err.message || "Webhook error", received: true });
  }
};

// ==========================================
//             HELPER FUNCTIONS
// ==========================================

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

// HTML Escape for Telegram
function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Retry Logic for Telegram
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return res;
    } catch (err) {
      console.error(`Fetch attempt ${i + 1} failed:`, err);
    }
    if (i < retries - 1) await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

// ---------------- EMAILS ------------------

// 1. New: Send Voucher Code to Customer
async function sendVoucherEmail(email, code, value, env) {
    const apiKey = env.RESEND_API_KEY;
    if (!apiKey || !email) return;

    const html = `
      <div style="font-family:sans-serif; text-align:center; padding:20px; color:#333;">
        <h1 style="color:#333;">🎁 Here is your Gift Voucher!</h1>
        <p>Thank you for purchasing a Magnetic Memories voucher.</p>
        <div style="background:#f4f4f4; padding:24px; border-radius:12px; margin:24px 0; border:2px dashed #ccc;">
            <h2 style="color:#59c9a5; font-size:32px; margin:0; letter-spacing:1px;">${code}</h2>
            <p style="margin-top:8px; font-weight:bold; color:#555;">Value: £${value}</p>
        </div>
        <p>To use this, simply enter the code at checkout on our website.</p>
        <p><a href="https://magnetic-memories.pages.dev">Visit Store</a></p>
      </div>
    `;

    await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            from: env.RESEND_FROM_EMAIL,
            to: [email],
            subject: "Your Gift Voucher Code 🎁",
            html
        })
    });
}

// 2. Existing: Send Standard Order Confirmation
async function sendPaidEmail(order, env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;

  if (!apiKey || !from || !order.email) return;

  const subject = "We’ve received your Magnetic Memories order";
  const totalText = buildTotalText(order);

  const html = `
    <div style="font-family: system-ui, sans-serif;">
      <h2>Thanks for your order!</h2>
      <p>We’ve received your payment and will start preparing your order shortly.</p>
      <p>
        <strong>Order ID:</strong> ${order.orderId}<br/>
        <strong>Product:</strong> ${order.productType === 'keyring' ? 'Keyring' : (order.packSize ? order.packSize + ' items' : "?")}<br/>
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

// 3. Existing: Send Admin Notification
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
  
  // Custom label if it's a keyring or voucher purchase
  const packLabel = order.productType === 'keyring' 
    ? `🔑 Double-Sided Keyring` 
    : (order.generatedVoucher 
        ? `🎁 Voucher Purchase (£${order.voucherValue})` 
        : `${order.packSize} items (${order.packType || 'standard'})`);

  const html = `
    <div style="font-family: system-ui, sans-serif;">
      <h2>New paid order</h2>
      <p>
        <strong>Order ID:</strong> ${order.orderId}<br/>
        <strong>Status:</strong> ${order.status}<br/>
        <strong>Customer:</strong> ${customerEmail}<br/>
        <strong>Phone:</strong> ${customerPhone}<br/>
        <strong>Item:</strong> ${packLabel}<br/>
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

// 4. Existing: Send Telegram Notification (HTML Mode)
async function sendPaidTelegram(order, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatIdsRaw = env.TELEGRAM_CHAT_ID;

  if (!token || !chatIdsRaw) return;

  const chatIds = chatIdsRaw.split(",").map((id) => id.trim()).filter(Boolean);
  if (!chatIds.length) return;

  const total = typeof order.price === "number" ? `£${order.price.toFixed(2)}` : "Paid";
  
  let header = "💳 <b>New paid order</b>";
  if (order.productType === 'keyring') header = `🔑 <b>KEYRING ORDER</b>`;
  else if (order.event === 'BINGO') header = `🎱 <b>BINGO ORDER #${order.bingoNumber}</b>`;
  else if (order.event === 'VALENTINES') header = `💘 <b>VALENTINES ORDER</b>`;
  else if (order.event === 'MOTHERS_DAY') header = `🌸 <b>MOTHER'S DAY ORDER</b>`;
  else if (order.event === 'FRAMES') header = `🖼️ <b>FRAME ORDER</b>`;
  
  let packLine = `Pack: ${esc(order.packSize)} items`;
  if (order.productType === 'keyring') packLine = `Product: 🔑 Double-Sided Keyring`;
  if (order.packType === 'big_picture') packLine += ' (🧩 Jigsaw)';
  if (order.generatedVoucher) packLine = `🎁 <b>Voucher Purchase</b> (£${order.voucherValue})`;

  const lines = [
    header,
    `ID: <code>${esc(order.orderId)}</code>`,
    `Email: ${esc(order.email || "Unknown")}`,
    `Phone: ${esc(order.phone || "No phone")}`,
    packLine,
    `Total: ${esc(total)}`
  ].filter(Boolean);

  const text = lines.join("\n");
  const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;

  await Promise.all(chatIds.map(chatId =>
    fetchWithRetry(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
          chat_id: chatId, 
          text, 
          parse_mode: "HTML" 
      }),
    }).then(res => {
       if (!res || !res.ok) console.error("Telegram failed:", res ? res.status : "Network Error");
    })
  ));
}