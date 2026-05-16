// functions/api/admin-order-update.js
//
// POST /api/admin-order-update?key=ADMIN_KEY
// Body: { orderId: string, status: string }
//
// Used by the admin dashboard to move orders through:
//   checkout_created → paid → printing → shipped → complete
//
// On success we:
//   1) Update the order in KV
//   2) Optionally email the customer for printing/shipped/complete
//   3) Return { success: true, order } as JSON

const CUSTOMER_STATUS_MESSAGES = {
  printing: {
    subject: "Your Magnetic Memories order is being prepared 🖨️",
    intro: "Good news — we’ve started preparing your order!",
    body: "We’re carefully making it so it looks absolutely perfect.",
  },
  shipped: {
    subject: "Your Magnetic Memories order is on its way 🚚",
    intro: "Your order has been shipped!",
    body: "It’ll be with you soon. Thanks for ordering from Magnetic Memories.",
  },
  complete: {
    subject: "Your Magnetic Memories order is complete ✅",
    intro: "Your order is now complete.",
    body: "We hope you love your new memories. Thanks again for your order!",
  },
};

export async function onRequestPost(context) {
  const { env, request } = context;

  // --- 1. Check admin key ---
  const url = new URL(request.url);
  const key = request.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("key");

  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // --- 2. Parse body ---
  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    console.error("admin-order-update: invalid JSON body", err);
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { orderId, status } = payload || {};

  if (!orderId || !status) {
    return jsonResponse(
      { error: "orderId and status are required" },
      400
    );
  }

  const kvKey = `order:${orderId}`;

  // --- 3. Load existing order ---
  let raw;
  try {
    raw = await env.ORDERS_KV.get(kvKey);
  } catch (err) {
    console.error("admin-order-update: KV get failed", err);
    return jsonResponse({ error: "Failed to load order" }, 500);
  }

  if (!raw) {
    return jsonResponse({ error: "Order not found" }, 404);
  }

  let order;
  try {
    order = JSON.parse(raw);
  } catch (err) {
    console.error("admin-order-update: invalid JSON in KV", err);
    return jsonResponse({ error: "Stored order is invalid JSON" }, 500);
  }

  const previousStatus = order.status;

  // --- 4. Update order ---
  const now = new Date().toISOString();
  order.status = status;
  order.updatedAt = now;

  try {
    await env.ORDERS_KV.put(kvKey, JSON.stringify(order));
  } catch (err) {
    console.error("admin-order-update: KV put failed", err);
    return jsonResponse({ error: "Failed to update order" }, 500);
  }

  // --- 5. Optionally email customer on certain statuses ---
  try {
    await maybeSendCustomerStatusEmail(env, order, previousStatus, status);
  } catch (err) {
    // Do NOT fail the update if email sending fails
    console.error("admin-order-update: failed to send status email", err);
  }

  // --- 6. Return clean JSON so admin.js is happy ---
  return jsonResponse({ success: true, order }, 200);
}

// Helper to send JSON responses
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Send customer email when we move into printing / shipped / complete
async function maybeSendCustomerStatusEmail(env, order, prevStatus, newStatus) {
  const messageDef = CUSTOMER_STATUS_MESSAGES[newStatus];
  if (!messageDef) return; // nothing to do for other statuses

  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  const to = order.email;

  if (!apiKey || !from || !to) {
    console.warn(
      "admin-order-update: missing email config; skipping customer status email"
    );
    return;
  }

  const subject = messageDef.subject;
  const html = buildCustomerEmailHtml(order, newStatus, messageDef);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(
      "admin-order-update: Resend email failed",
      res.status,
      text
    );
  }
}

// Very simple HTML email body
function buildCustomerEmailHtml(order, status, messageDef) {
  const prettyStatus =
    status.charAt(0).toUpperCase() + status.slice(1);

  return `
  <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #111;">
    <h2>Magnetic Memories – Order update</h2>
    <p>${messageDef.intro}</p>
    <p>${messageDef.body}</p>
    <hr />
    <p><strong>Order ID:</strong> ${order.orderId}</p>
    <p><strong>Current status:</strong> ${prettyStatus}</p>
    ${
      order.productType === 'keyring' 
      ? `<p><strong>Product:</strong> Double-Sided Keyring</p>` 
      : (order.packSize ? `<p><strong>Pack:</strong> ${order.packSize} items</p>` : "")
    }
    <p style="margin-top: 24px; font-size: 13px; color: #555;">
      If you have any questions, just reply to this email.
    </p>
  </div>
  `;
}