// functions/api/trigger-recovery.js
// GET /api/trigger-recovery?key=ADMIN_KEY
// Scans for 'draft' orders older than 1 hour and sends recovery emails.

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (key !== env.ADMIN_DASH_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { keys } = await env.ORDERS_KV.list({ prefix: "order:" });
  let sentCount = 0;
  const now = new Date().getTime();
  const ONE_HOUR = 60 * 60 * 1000;

  for (const k of keys) {
    const raw = await env.ORDERS_KV.get(k.name);
    if (!raw) continue;
    
    let order;
    try { order = JSON.parse(raw); } catch (e) { continue; }

    // CRITERIA:
    // 1. Status is 'draft'
    // 2. Has Email
    // 3. Created/Updated more than 1 hour ago
    // 4. Has NOT already been sent a recovery email
    
    if (order.status === 'draft' && order.email && !order.recoverySent) {
        const lastUpdate = new Date(order.updatedAt || order.createdAt).getTime();
        
        if (now - lastUpdate > ONE_HOUR) {
            // Send the email
            const didSend = await sendRecoveryEmail(order, env);
            if (didSend) {
                order.recoverySent = true;
                order.status = 'abandoned'; 
                await env.ORDERS_KV.put(k.name, JSON.stringify(order));
                sentCount++;
            }
        }
    }
  }

  return new Response(JSON.stringify({ sent: sentCount }), {
      headers: { "Content-Type": "application/json" }
  });
}

async function sendRecoveryEmail(order, env) {
    const apiKey = env.RESEND_API_KEY;
    if (!apiKey) return false;

    // The link that restores their session
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

    return res.ok;
}