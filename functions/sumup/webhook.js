// functions/sumup/webhook.js
// This endpoint is called by SumUp after a payment attempt.
// We look for a successful result and mark the order as "paid".

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const raw = await request.text();
    // SumUp may post JSON; parse safely
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }

    // SumUp sends a variety of event shapes depending on product.
    // We rely on the checkout_reference we set (the orderId).
    const orderId =
      payload?.checkout_reference ||
      payload?.payment_reference ||
      payload?.transaction_code ||
      payload?.id || null;

    // Basic success detection: check common fields
    const status =
      payload?.status ||
      payload?.event_type ||
      payload?.event ||
      payload?.transaction_status ||
      "";

    const looksSuccessful =
      /success/i.test(status) ||
      /paid/i.test(status) ||
      payload?.result?.code === "SUCCESS";

    if (!orderId) {
      // No order id we can map — log and ignore gracefully
      return new Response(JSON.stringify({ ok: false, reason: "No orderId" }), {
        status: 200, // 200 so SumUp doesn't retry forever
        headers: { "Content-Type": "application/json" }
      });
    }

    // Fetch order
    const orderKey = `order:${orderId}`;
    const orderJson = await env.ORDERS_KV.get(orderKey);
    if (!orderJson) {
      // Unknown order — acknowledge to avoid retries, but keep note
      return new Response(JSON.stringify({ ok: false, reason: "Order not found" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const order = JSON.parse(orderJson);

    if (looksSuccessful) {
      order.status = "paid";
      order.paidAt = new Date().toISOString();
      order.paymentInfo = {
        rawStatus: status,
        sumupPayloadHint: {
          id: payload?.id ?? null,
          amount: payload?.amount ?? null,
          currency: payload?.currency ?? null,
          transaction_code: payload?.transaction_code ?? null
        }
      };
      order.updatedAt = new Date().toISOString();

      await env.ORDERS_KV.put(orderKey, JSON.stringify(order));
    } else {
      // You could optionally store failed/abandoned attempts
      order.status = order.status === "paid" ? "paid" : "failed";
      order.updatedAt = new Date().toISOString();
      await env.ORDERS_KV.put(orderKey, JSON.stringify(order));
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    // Always 200 to avoid infinite retries, but include info
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
}
