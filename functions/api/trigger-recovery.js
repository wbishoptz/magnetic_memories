// functions/api/trigger-recovery.js
// GET /api/trigger-recovery?key=ADMIN_KEY
// Scans for 'draft' orders older than 1 hour.
// SKIPS if the customer has already placed a paid order.

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (key !== env.ADMIN_DASH_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  // 1. Fetch ALL orders to build context
  // Note: If you have >1000 orders, you'd need pagination here. 
  // For now, listing the default batch is usually fine for checking recent activity.
  const { keys } = await env.ORDERS_KV.list({ prefix: "order:" });
  
  const allOrders = [];
  
  // Fetch values in parallel
  const values = await Promise.all(keys.map(k => env.ORDERS_KV.get(k.name)));
  
  // Parse and sort
  for (const v of values) {
      if (!v) continue;
      try { allOrders.push(JSON.parse(v)); } catch (e) {}
  }

  // 2. Build a list of emails that have successfully PAID
  // We include 'printing', 'shipped', 'complete' as they imply payment.
  const paidEmails = new Set();
  const paidStatuses = ["paid", "printing", "shipped", "complete"];

  for (const o of allOrders) {
      if (o.email && paidStatuses.includes(o.status)) {
          paidEmails.add(o.email.toLowerCase().trim());
      }
  }

  let sentCount = 0;
  let skippedCount = 0;
  const now = new Date().getTime();
  const ONE_HOUR = 60 * 60 * 1000;

  // 3. Process Drafts
  for (const order of allOrders) {
    // Check criteria: Draft, Has Email, Not yet handled
    if (order.status === 'draft' && order.email && !order.recoverySent && !order.recoverySkipped) {
        
        const lastUpdate = new Date(order.updatedAt || order.createdAt).getTime();
        
        if (now - lastUpdate > ONE_HOUR) {
            const customerEmail = order.email.toLowerCase().trim();

            // SAFETY CHECK: Has this person paid for ANY order?
            if (paidEmails.has(customerEmail)) {
                // They already bought something! Don't annoy them.
                order.recoverySkipped = true;
                order.status = 'abandoned'; // Archive it
                await env.ORDERS_KV.put(`order:${order.orderId}`, JSON.stringify(order));
                skippedCount++;
                continue; 
            }

            // If we get here, they haven't bought anything yet. Send email.
            const didSend = await sendRecoveryEmail(order, env);
            if (didSend) {
                order.recoverySent = true;
                order.status = 'abandoned'; 
                await env.ORDERS_KV.put(`order:${order.orderId}`, JSON.stringify(order));
                sentCount++;
            }
        }
    }
  }

  return new Response(JSON.stringify({ sent: sentCount, skipped: skippedCount }), {
      headers: { "Content-Type": "application/json" }
  });
}

async function sendRecoveryEmail(order, env) {
    const apiKey = env.RESEND_API_KEY;
    if (!apiKey) return false;

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