import {
  verifyStripeSignature,
  sendPaidEmail, sendBingoEmail, sendVoucherEmail, sendAdminEmail, sendPaidTelegram,
  sendTelegramText
} from './_shared.js';
import {
  UUID_RE, completeGuestOrder, loadOrder, loadEvent, formatGBP, toPence, round2, retrieveSession, addRefundNeeded,
} from './_guest.js';

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

    // Guest "extra magnets" payments (/api/guest-pay) are not shop orders: they
    // are handled here and never reach the orderId logic below.
    if (session && session.metadata?.guestExtras === "true") {
      if (type !== "checkout.session.completed" && type !== "checkout.session.async_payment_succeeded") {
        return json({ received: true, ignored: true, guestExtras: true });
      }
      return await handleGuestExtras(session, env);
    }

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

// ─── Guest extra magnets ─────────────────────────────────────────────────
// 1. record the payment in KV guestpay:{orderId} (a second paid session for
//    the same order: guestpay:{orderId}:{sessionId}),
// 2. "paid" Telegram alert (never a customer email - guests have no address),
// 3. finish the order from its saved photo list (pendingKeys), so a guest who
//    paid and closed the browser still gets a number and prints. Idempotent
//    with the guest's own /api/guest-finalize,
// 4. success -> "✅ ... got #N" alert; money we must give back -> refundNeeded
//    on the order (paid after the free-only finish / paid twice; "full" is
//    recorded by completeGuestOrder) and a refund alert.
// Stripe re-delivers the event while we answer non-2xx, so a refund alert (or
// refund record) that failed makes us answer 500. Re-running is idempotent:
// alertedAt / refundAlertedAt / doneAlertedAt / refundRecordedAt on the
// guestpay record stop successful steps from being repeated.
async function handleGuestExtras(payloadSession, env) {
  let session = payloadSession;
  if (!env.STRIPE_WEBHOOK_SECRET) {
    // Unsigned payload: trust only what Stripe itself says about this session.
    session = await retrieveSession(env, payloadSession.id);
    if (!session || session.metadata?.guestExtras !== "true") {
      console.error("Stripe webhook: unverified guest extras session", payloadSession.id);
      return json({ received: true, guestExtras: true, unverified: true });
    }
  }
  const orderId = String(session.metadata?.guestOrderId || "");
  if (!UUID_RE.test(orderId)) {
    console.error("Stripe webhook: guest extras session without a valid guestOrderId", session.id);
    return json({ received: true, guestExtras: true, noOrderId: true });
  }
  if (session.payment_status !== "paid") {
    return json({ received: true, guestExtras: true, unpaid: true });
  }
  if (!env.ORDERS_KV) return json({ error: "ORDERS_KV missing" }, 200);

  const short = orderId.slice(0, 8);
  const amountPence = Math.max(0, Math.round(Number(session.amount_total) || 0));
  const currency = String(session.currency || "gbp").toLowerCase();
  // Sessions are created in GBP with adaptive pricing off; anything else is
  // shown as-is (and is never accepted as payment by extrasPaymentStatus).
  const amountText = currency === "gbp"
    ? formatGBP(amountPence / 100)
    : `${(amountPence / 100).toFixed(2)} ${currency.toUpperCase()}`;
  const amountGbp = currency === "gbp" ? round2(amountPence / 100) : null;

  const order = await loadOrder(env, orderId).catch(() => null);
  const eventId = order?.eventId || session.metadata?.eventId || "";
  const ev = eventId ? await loadEvent(env, eventId).catch(() => null) : null;
  const eventName = ev?.name || eventId || "event";
  let n = Number(order?.extrasCount) || 0;
  if (!(n > 0) && toPence(order?.extraPrice) > 0) n = Math.round(amountPence / toPence(order.extraPrice));
  const what = n > 0 ? `${n} extra magnet${n === 1 ? "" : "s"}` : "extra magnets";
  const alert = (text) => sendTelegramText(text, env).catch(err => { console.error("Telegram alert failed:", err); return false; });
  const telegramReady = !!(env.TELEGRAM_BOT_TOKEN && String(env.TELEGRAM_CHAT_ID || "").split(",").some(s => s.trim()));

  // ── 1. Payment record (Stripe retries the webhook if this fails) ──
  const payKey = `guestpay:${orderId}`;
  let recKey = payKey;
  let duplicate = false;
  let record;
  try {
    let existing = null;
    try { existing = JSON.parse((await env.ORDERS_KV.get(payKey)) || "null"); } catch { existing = null; }
    if (existing && existing.sessionId && existing.sessionId !== session.id) {
      // A second checkout for the same order was paid as well.
      duplicate = true;
      recKey = `guestpay:${orderId}:${session.id}`;
      try { existing = JSON.parse((await env.ORDERS_KV.get(recKey)) || "null"); } catch { existing = null; }
    }
    record = existing && existing.sessionId === session.id ? existing : {
      sessionId: session.id,
      amount: amountPence / 100,
      amountPence,
      currency,
      email: session.customer_details?.email || null,
      paymentIntent: session.payment_intent || null,
      eventId: eventId || null,
      paidAt: new Date().toISOString(),
      ...(duplicate ? { duplicateOf: `guestpay:${orderId}` } : {}),
    };
    if (record !== existing) await env.ORDERS_KV.put(recKey, JSON.stringify(record));
  } catch (err) {
    console.error("Stripe webhook: could not record guest extras payment:", err);
    return json({ error: "Could not record payment", received: false }, 500);
  }
  const saveRecord = () => env.ORDERS_KV.put(recKey, JSON.stringify(record))
    .then(() => true, err => { console.error("Stripe webhook: guestpay record update failed:", err); return false; });

  // ── 2. Paid alert (once per session; best-effort) ──
  if (!duplicate && !record.alertedAt) {
    const sent = await alert(`💳 Guest extras paid - ${eventName}: ${what}, ${amountText} (order ${short})`);
    if (sent) {
      record.alertedAt = new Date().toISOString();
      await saveRecord();
    }
  }

  // ── 3. Finish the order (the guest's page can also do it) ──
  let done = null;
  try {
    done = await completeGuestOrder(env, orderId, {});
  } catch (err) {
    console.error("Stripe webhook: guest order completion failed:", err);
  }
  const number = done?.status === 200 ? done.body.number : null;

  // ── 4. What happened to this payment ──
  let refund = null;   // { reason?, text } - money to give back / someone must check
  let success = false; // finished with the paid extras
  let retry = false;   // answer 500 so Stripe delivers again
  if (duplicate) {
    refund = { reason: "paid-twice", text: `⚠️ Guest extras paid TWICE - refund one payment - ${eventName}: ${amountText} (order ${short}, session ${session.id})` };
  } else if (!done) {
    refund = { text: `⚠️ Guest extras paid but the upload could not be finished automatically (error) - check order ${short} - ${eventName}: ${amountText}` };
  } else if (done.status === 200 && done.order?.extrasPaid === true) {
    success = true;
  } else if (done.status === 200) {
    refund = { reason: "paid-after-skip", text: `⚠️ Guest extras paid after the photos were sent without extras - refund needed - ${eventName}: ${amountText} (order ${short}, #${number})` };
  } else if (done.status === 409 && done.body?.refunded) {
    // an admin already refunded this order: nothing more to do
  } else if (done.status === 409 && done.body?.full) {
    // completeGuestOrder saved fullAfterPayment + refundNeeded ("full")
    if (done.refundRecorded === false) retry = true;
    refund = { text: `⚠️ Guest extras paid but the event is FULL - refund needed - ${eventName}: ${amountText} (order ${short})` };
  } else if (done.status === 404 || done.status === 403) {
    refund = { text: `⚠️ Guest extras paid but the upload was not found - refund needed - ${eventName}: ${amountText} (order ${short})` };
  } else {
    // e.g. the saved photo list isn't visible here yet: the guest's own page
    // finishes the order when they come back - flag it in case they don't.
    console.error("Stripe webhook: guest order not finished:", done.status, done.body);
    refund = { text: `⚠️ Guest extras paid but the upload could not be finished automatically (${done.body?.error || done.status}) - check order ${short} - ${eventName}: ${amountText}` };
  }

  // Paid after the free-only finish / paid twice: record the refund on the
  // order. Only while nothing can race the write - the order is finished, or
  // waiting for an admin (fullAfterPayment) - otherwise Stripe tries again later.
  if (refund?.reason && !record.refundRecordedAt) {
    try {
      const fresh = await loadOrder(env, orderId);
      // (an admin-refunded order can never finish either, so it's equally safe)
      if (fresh && (fresh.raffleNumber != null || fresh.fullAfterPayment === true || fresh.extrasRefunded === true)) {
        const now = new Date().toISOString();
        if (addRefundNeeded(fresh, { amount: amountGbp ?? amountPence / 100, reason: refund.reason, sessionId: session.id, at: now })) {
          fresh.updatedAt = now;
          await env.ORDERS_KV.put(`order:${orderId}`, JSON.stringify(fresh));
        }
        record.refundRecordedAt = now;
        await saveRecord();
      } else if (fresh) {
        console.error("Stripe webhook: order not finished yet, refund recorded on a later delivery", orderId);
        retry = true;
      }
    } catch (err) {
      console.error("Stripe webhook: could not record the refund on the order:", err);
      retry = true;
    }
  }

  // Alerts: a refund alert must get through (else Stripe re-delivers); the
  // "got #N" follow-up is best-effort. Each is sent once per session.
  if (refund && !record.refundAlertedAt) {
    if (!telegramReady) {
      console.error("Stripe webhook: REFUND ALERT NOT SENT (Telegram not set up):", refund.text);
    } else if (await alert(refund.text)) {
      record.refundAlertedAt = new Date().toISOString();
      await saveRecord();
    } else {
      console.error("Stripe webhook: refund alert failed, asking Stripe to retry:", refund.text);
      retry = true;
    }
  } else if (success && !record.doneAlertedAt) {
    if (await alert(`✅ Guest extras order ${short} got #${number} - ${eventName}`)) {
      record.doneAlertedAt = new Date().toISOString();
      await saveRecord();
    }
  }

  if (retry) {
    return json({ error: "Guest extras payment needs another try", received: false, guestExtras: true, number }, 500);
  }
  return json({ received: true, guestExtras: true, number, ...(duplicate ? { duplicate: true } : {}) });
}
