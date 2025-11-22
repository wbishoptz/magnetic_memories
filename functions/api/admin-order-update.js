// functions/api/admin-order-update.js
//
// POST /api/admin-order-update?key=ADMIN_KEY
// Body: { "orderId": "...", "status": "printing" | "shipped" | "complete" | ... }
//
// - Updates order status in ORDERS_KV
// - Returns updated order JSON
// - Sends customer + admin emails when status moves to printing/shipped/complete

// -------------------- Email helper using Resend --------------------

async function sendEmail({ env, to, subject, html, text }) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;

  if (!apiKey || !from) {
    console.warn("Resend not configured; skipping email send");
    return;
  }

  const body = {
    from,
    to,
    subject,
    html,
    text,
  };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error("Resend email failed:", res.status, errorText);
  }
}

// -------------------- Email content builders --------------------

function buildCustomerEmail(order, newStatus) {
  const humanStatus =
    newStatus === "printing"
      ? "Printing"
      : newStatus === "shipped"
      ? "Shipped"
      : newStatus === "complete"
      ? "Completed"
      : newStatus;

  const subject = `Your Magnetic Memories order is now ${humanStatus}`;

  const textLines = [
    `Hi ${order.email || "there"},`,
    "",
    `Good news – your order ${order.orderId} is now: ${humanStatus}.`,
    "",
    newStatus === "printing"
      ? "We're now printing your magnets and checking everything looks perfect."
      : newStatus === "shipped"
      ? "Your magnets have left us and are on their way to you."
      : newStatus === "complete"
      ? "Your order is complete. We hope you love your magnets!"
      : `Status updated to ${humanStatus}.`,
    "",
    "Thank you for ordering from Magnetic Memories.",
  ];

  const text = textLines.join("\n");

  const html = `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6;">
      <p>Hi ${order.email || "there"},</p>
      <p>Good news – your order <strong>${order.orderId}</strong> is now:</p>
      <p style="font-size: 18px; font-weight: 600;">${humanStatus}</p>
      <p>
        ${
          newStatus === "printing"
            ? "We're now printing your magnets and checking everything looks perfect."
            : newStatus === "shipped"
            ? "Your magnets have left us and are on their way to you."
            : newStatus === "complete"
            ? "Your order is complete. We hope you love your magnets!"
            : `Status updated to ${humanStatus}.`
        }
      </p>
      <p>Thank you for ordering from <strong>Magnetic Memories</strong>.</p>
    </div>
  `;

  return { subject, text, html };
}

function buildAdminEmail(order, newStatus) {
  const subject = `Order ${order.orderId} marked as ${newStatus}`;

  const text = [
    `Order ${order.orderId} status changed to ${newStatus}.`,
    "",
    `Email: ${order.email}`,
    `Pack size: ${order.packSize}`,
    `Price: £${order.price}`,
  ].join("\n");

  const html = `
    <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6;">
      <p>Order <strong>${order.orderId}</strong> status changed to <strong>${newStatus}</strong>.</p>
      <ul>
        <li><strong>Email:</strong> ${order.email}</li>
        <li><strong>Pack size:</strong> ${order.packSize}</li>
        <li><strong>Price:</strong> £${order.price}</li>
      </ul>
    </div>
  `;

  return { subject, text, html };
}

// -------------------- Main handler --------------------

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Simple admin auth using ?key=...
  const adminKey = url.searchParams.get("key");
  if (!adminKey || adminKey !== env.ADMIN_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { orderId, status: newStatus } = body || {};
  if (!orderId || !newStatus) {
    return new Response(
      JSON.stringify({ error: "orderId and status are required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const kvKey = `order:${orderId}`;

  try {
    const raw = await env.ORDERS_KV.get(kvKey);
    if (!raw) {
      return new Response(JSON.stringify({ error: "Order not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const order = JSON.parse(raw);
    const previousStatus = order.status;

    order.status = newStatus;
    order.updatedAt = new Date().toISOString();

    await env.ORDERS_KV.put(kvKey, JSON.stringify(order));

    // Decide whether to send status emails
    const interestingStatuses = new Set(["printing", "shipped", "complete"]);
    const statusChanged = previousStatus !== newStatus;

    if (statusChanged && interestingStatuses.has(newStatus)) {
      try {
        // 1) Customer email
        if (order.email) {
          const msg = buildCustomerEmail(order, newStatus);
          await sendEmail({
            env,
            to: order.email,
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
          });
        }

        // 2) Admin notification email (NOTIFY_EMAIL can be comma-separated list)
        if (env.NOTIFY_EMAIL) {
          const to = env.NOTIFY_EMAIL.split(",").map((s) => s.trim()).filter(Boolean);
          if (to.length > 0) {
            const msg = buildAdminEmail(order, newStatus);
            await sendEmail({
              env,
              to,
              subject: msg.subject,
              html: msg.html,
              text: msg.text,
            });
          }
        }
      } catch (err) {
        console.error("Error sending status emails:", err);
        // Don't fail the API just because email failed
      }
    }

    return new Response(JSON.stringify(order), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Error updating order in KV:", err);
    return new Response(
      JSON.stringify({ error: "Failed to update order" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
