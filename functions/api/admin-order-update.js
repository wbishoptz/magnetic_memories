// functions/api/admin-order-update.js
// POST /api/admin-order-update?key=ADMIN_DASH_KEY
//
// Body: { "orderId": "...", "status": "printing" | "shipped" | "completed" | ... }
//
// - Validates admin key
// - Loads order from ORDERS_KV
// - Updates status
// - Saves back to KV
// - Triggers notifications (Telegram + optional email) for status changes
//   to: printing, shipped, completed

export const onRequestPost = async ({ request, env }) => {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");

    if (!key || key !== env.ADMIN_DASH_KEY) {
      return json({ error: "Unauthorized" }, 401);
    }

    const ordersKV = env.ORDERS_KV;
    if (!ordersKV) {
      console.error("ORDERS_KV binding missing");
      return json({ error: "ORDERS_KV binding missing" }, 500);
    }

    const body = await request.json().catch(() => null);
    if (!body || !body.orderId || !body.status) {
      return json(
        { error: "Missing orderId or status in request body" },
        400
      );
    }

    const { orderId, status } = body;

    const allowedStatuses = [
      "checkout_created",
      "paid",
      "printing",
      "shipped",
      "completed",
      "draft",
    ];

    if (!allowedStatuses.includes(status)) {
      return json(
        {
          error: "Invalid status",
          allowed: allowedStatuses,
        },
        400
      );
    }

    const kvKey = `order:${orderId}`;
    const raw = await ordersKV.get(kvKey);
    if (!raw) {
      return json({ error: "Order not found" }, 404);
    }

    const order = JSON.parse(raw);
    const previousStatus = order.status || "unknown";

    order.status = status;
    order.statusUpdatedAt = new Date().toISOString();

    await ordersKV.put(kvKey, JSON.stringify(order), {
      expirationTtl: 60 * 60 * 24 * 30,
    });

    // Fire-and-forget notifications for relevant status changes
    notifyStatusChange(order, previousStatus, env).catch((err) =>
      console.error("Status change notification error:", err)
    );

    return json({ order });
  } catch (err) {
    console.error("admin-order-update error:", err);
    return json(
      { error: err.message || "Failed to update order" },
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

// ---------------- NOTIFICATIONS ----------------

async function notifyStatusChange(order, previousStatus, env) {
  const newStatus = (order.status || "").toLowerCase();

  // Only notify on these transitions
  const statusesToNotify = new Set(["printing", "shipped", "completed"]);

  if (!statusesToNotify.has(newStatus)) {
    return;
  }

  // Avoid spamming if status didn't actually change
  if (previousStatus && previousStatus.toLowerCase() === newStatus) {
    return;
  }

  await Promise.allSettled([
    sendStatusTelegram(order, previousStatus, env),
    sendStatusEmail(order, previousStatus, env),
  ]);
}

// ------- Telegram for status changes -------

async function sendStatusTelegram(order, previousStatus, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatIdsRaw = env.TELEGRAM_CHAT_ID;

  if (!token || !chatIdsRaw) {
    console.log("Skipping Telegram status notification – missing config");
    return;
  }

  // Support single ID or comma-separated list (e.g. group + extra chats)
  const chatIds = chatIdsRaw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!chatIds.length) {
    console.log(
      "Skipping Telegram status notification – TELEGRAM_CHAT_ID empty after parsing"
    );
    return;
  }

  const status = order.status || "unknown";
  const prev = previousStatus || "unknown";

  const emoji =
    status === "printing"
      ? "🖨"
      : status === "shipped"
      ? "🚚"
      : status === "completed"
      ? "✅"
      : "ℹ️";

  const lines = [
    `${emoji} Order status updated`,
    `Order ID: ${order.orderId}`,
    `From: ${prev} → ${status}`,
    `Email: ${order.email || "Unknown"}`,
    `Pack: ${order.packSize || "?"} magnets`,
    typeof order.price === "number"
      ? `Total: £${order.price.toFixed(2)}`
      : null,
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
        console.error("Telegram status send error for chat", chatId, err)
      )
    )
  );
}

// ------- Email for status changes (customer) -------

async function sendStatusEmail(order, previousStatus, env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;

  if (!apiKey || !from || !order.email) {
    console.log(
      "Skipping status email – missing RESEND config or order email"
    );
    return;
  }

  const status = (order.status || "").toLowerCase();

  let subject;
  let intro;

  switch (status) {
    case "printing":
      subject = "Your Magnetic Memories order is being printed";
      intro = "Good news – your magnets are now in our print queue.";
      break;
    case "shipped":
      subject = "Your Magnetic Memories order has been shipped";
      intro =
        "Your magnets have been shipped. They’ll be with you very soon.";
      break;
    case "completed":
      subject = "Your Magnetic Memories order is complete";
      intro =
        "Your order is now complete. We hope you love your magnets!";
      break;
    default:
      // Should not happen because we filter statuses earlier
      subject = "Update to your Magnetic Memories order";
      intro = "We've updated the status of your order.";
  }

  const html = `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
      <h2>${subject}</h2>
      <p>${intro}</p>
      <p>
        <strong>Order ID:</strong> ${order.orderId}<br/>
        <strong>Status:</strong> ${order.status}<br/>
        <strong>Pack:</strong> ${order.packSize || "?"} magnets<br/>
        <strong>Total:</strong> ${
          typeof order.price === "number"
            ? "£" + order.price.toFixed(2)
            : "£" + (order.price ?? "")
        }
      </p>
      <p>
        You can keep an eye on your order status here:<br/>
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
  }).catch((err) =>
    console.error("Resend status email error for", order.orderId, err)
  );
}
