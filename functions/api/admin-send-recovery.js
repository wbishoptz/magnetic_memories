// functions/api/admin-send-recovery.js
// POST /api/admin-send-recovery
// Body: { key: "...", orderId: "..." }

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { orderId } = body;
    const key = request.headers.get("Authorization")?.replace("Bearer ", "") || body.key;

    if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    if (!orderId) {
      return new Response(JSON.stringify({ error: "Missing orderId" }), { status: 400 });
    }

    // 2. Fetch Order
    const kvKey = `order:${orderId}`;
    const raw = await env.ORDERS_KV.get(kvKey);
    if (!raw) return new Response(JSON.stringify({ error: "Order not found" }), { status: 404 });

    const order = JSON.parse(raw);

    if (!order.email) {
      return new Response(JSON.stringify({ error: "No email on file for this order" }), { status: 400 });
    }

    // 3. Send Email (Same template as trigger-recovery)
    const apiKey = env.RESEND_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: "Resend API Key missing" }), { status: 500 });

    const recoveryLink = `https://magnetic-memories.pages.dev/?resumeOrder=${order.orderId}`;
    
    const html = `
    <div style="font-family:sans-serif; color:#333; max-width:600px; margin:0 auto;">
      <h2>Don't forget your memories! 🧲</h2>
      <p>Hey,</p>
      <p>We noticed you started creating some custom magnets but didn't finish.</p>
      <p>We've saved your progress. Click the button below to pick up exactly where you left off:</p>
      <div style="margin: 25px 0;">
        <a href="${recoveryLink}" style="background:#59c9a5; color:#000; padding:12px 24px; text-decoration:none; border-radius:6px; font-weight:bold;">Resume Order</a>
      </div>
      <p style="color:#777; font-size:12px;">If you didn't mean to order, you can ignore this email.</p>
    </div>
    `;

    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            from: env.RESEND_FROM_EMAIL,
            to: [order.email],
            subject: "Complete your Magnetic Memories order",
            html
        })
    });

    if (!res.ok) {
        const txt = await res.text();
        return new Response(JSON.stringify({ error: "Resend failed: " + txt }), { status: 500 });
    }

    // 4. Update Order Status
    order.recoverySent = true;
    order.status = 'abandoned'; 
    order.updatedAt = new Date().toISOString();
    
    await env.ORDERS_KV.put(kvKey, JSON.stringify(order));

    return new Response(JSON.stringify({ success: true }));

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}