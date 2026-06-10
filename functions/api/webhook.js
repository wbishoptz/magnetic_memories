import {
  verifyStripeSignature,
  sendPaidEmail, sendBingoEmail, sendVoucherEmail, sendAdminEmail, sendPaidTelegram
} from './_shared.js';

export const onRequestPost = async ({ request, env }) => {
  let rawBody = "";
  try {
    rawBody = await request.text();

    // Verify Stripe signature if secret is configured
    if (env.STRIPE_WEBHOOK_SECRET) {
      const sig = request.headers.get('stripe-signature');
      const valid = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
      if (!valid) {
        console.error("Stripe webhook signature verification failed");
        return json({ error: "Invalid signature" }, 400);
      }
    } else {
      console.warn("STRIPE_WEBHOOK_SECRET not set — skipping signature verification");
    }

    const event = JSON.parse(rawBody);
    const type = event?.type;
    const session = event?.data?.object;

    if (type !== "checkout.session.completed" || !session) {
      return json({ received: true, ignored: true });
    }

    let orderId = session.metadata?.orderId;
    if (!orderId && session.success_url) {
      try { orderId = new URL(session.success_url).searchParams.get("orderId") || orderId; } catch {}
    }
    if (!orderId && session.cancel_url) {
      try { orderId = new URL(session.cancel_url).searchParams.get("orderId") || orderId; } catch {}
    }
    if (!orderId) {
      console.error("Stripe webhook: no orderId found", session.id);
      return json({ received: true, noOrderId: true });
    }

    const ordersKV = env.ORDERS_KV;
    if (!ordersKV) return json({ error: "ORDERS_KV missing" }, 200);

    const kvKey = `order:${orderId}`;
    const rawOrder = await ordersKV.get(kvKey);
    if (!rawOrder) {
      console.error("Order not found:", orderId);
      return json({ received: true, orderNotFound: true });
    }

    const order = JSON.parse(rawOrder);

    order.status = "paid";
    order.paidAt = new Date().toISOString();
    order.stripeSessionId = session.id;
    order.stripePaymentIntentId = session.payment_intent || order.stripePaymentIntentId;

    const shipping = session.shipping_details || session.customer_details;
    order.customer = {
      email: session.customer_details?.email || order.email,
      name: shipping?.name || session.customer_details?.name || null,
      address: shipping?.address || session.customer_details?.address || null,
    };

    // Voucher creation: customer bought a voucher
    if (session.metadata?.isVoucher === "true") {
      const val = Number(session.metadata.voucherValue);
      const code = "MM-" + Math.random().toString(36).substring(2, 6).toUpperCase();
      await env.ORDERS_KV.put(`voucher:${code}`, JSON.stringify({
        code, value: val, balance: val, redeemed: false,
        createdAt: new Date().toISOString(),
        purchasedBy: order.email,
        orderId
      }));
      order.generatedVoucher = code;
      order.voucherValue = val;
    }

    // Voucher redemption: customer used a voucher (partial discount paid via Stripe)
    if (session.metadata?.usedVoucher) {
      const code = session.metadata.usedVoucher;
      const vKey = `voucher:${code}`;
      const vRaw = await env.ORDERS_KV.get(vKey);
      if (vRaw) {
        const vData = JSON.parse(vRaw);
        // The voucher balance was fully consumed (discountAmount = full balance)
        vData.balance = 0;
        vData.redeemed = true;
        vData.usedByOrder = orderId;
        await env.ORDERS_KV.put(vKey, JSON.stringify(vData));
      }
    }

    // --- Basket: mark all basket orders paid ---
    const basketOrderIds = session.metadata?.basketOrderIds
      ? session.metadata.basketOrderIds.split(',').map(s => s.trim()).filter(Boolean)
      : null;

    if (basketOrderIds && basketOrderIds.length > 0) {
      const paidOrders = [];
      for (const bid of basketOrderIds) {
        const bKey = `order:${bid}`;
        const bRaw = await ordersKV.get(bKey);
        if (!bRaw) continue;
        const bOrder = JSON.parse(bRaw);
        bOrder.status = 'paid';
        bOrder.paidAt = new Date().toISOString();
        bOrder.stripeSessionId = session.id;
        bOrder.customer = order.customer; // same customer for all
        await ordersKV.put(bKey, JSON.stringify(bOrder), { expirationTtl: 60 * 60 * 24 * 30 });
        paidOrders.push(bOrder);
      }
      // Notify for EVERY item in the basket (admin email + telegram per item, plus
      // the customer's confirmation per item) so nothing is hidden.
      if (paidOrders.length > 0) {
        await Promise.allSettled([
          ...paidOrders.map(o => sendAdminEmail(o, env)),
          ...paidOrders.map(o => sendPaidTelegram(o, env)),
          ...paidOrders.map(o => sendPaidEmail(o, env))
        ]);
      }
      return json({ received: true, updated: true, basket: true });
    }

    // --- Single order ---
    await ordersKV.put(kvKey, JSON.stringify(order), {
      expirationTtl: 60 * 60 * 24 * 30, // 30 days
    });

    const notifications = [sendAdminEmail(order, env), sendPaidTelegram(order, env)];
    if (order.generatedVoucher) {
      notifications.push(sendVoucherEmail(order.email, order.generatedVoucher, order.voucherValue, env));
    } else if (order.event === 'BINGO') {
      notifications.push(sendBingoEmail(order, env));
    } else {
      notifications.push(sendPaidEmail(order, env));
    }
    await Promise.allSettled(notifications);

    return json({ received: true, updated: true });
  } catch (err) {
    console.error("Webhook error:", err, "Body:", rawBody);
    return json({ error: err.message || "Webhook error", received: true });
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
