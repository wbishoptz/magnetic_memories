// POST /api/basket-checkout
// Creates one Stripe checkout session for multiple draft orders (basket).
// Body: { orderIds, email, phone, shippingMethod, socialPermission, voucherCode? }

import { jsonResponse, VOUCHERS, sendAdminEmail, sendPaidTelegram, sendPaidEmail } from './_shared.js';

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { orderIds, email, phone, shippingMethod, socialPermission, voucherCode } = body;

    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return jsonResponse({ error: 'No items in basket.' }, 400);
    }
    if (!email || !/\S+@\S+\.\S+/.test(email)) {
      return jsonResponse({ error: 'Invalid email address.' }, 400);
    }
    if (!phone || phone.length < 6) {
      return jsonResponse({ error: 'Please enter a phone number.' }, 400);
    }
    if (!shippingMethod) {
      return jsonResponse({ error: 'Please select a shipping method.' }, 400);
    }

    // Load and update all orders with the real customer details
    const orders = [];
    let itemsTotal = 0;

    for (const orderId of orderIds) {
      const raw = await env.ORDERS_KV.get(`order:${orderId}`);
      if (!raw) return jsonResponse({ error: `Item not found: ${orderId}` }, 400);

      const order = JSON.parse(raw);

      // Reject if already paid (e.g. browser back button edge case)
      if (['paid', 'printing', 'shipped', 'completed'].includes(order.status)) continue;

      order.email = email;
      order.phone = phone;
      order.shippingMethod = shippingMethod;
      order.socialPermission = socialPermission;
      order.status = 'checkout_created';
      order.basketDraft = false; // now a real order
      order.updatedAt = new Date().toISOString();

      await env.ORDERS_KV.put(`order:${orderId}`, JSON.stringify(order));
      orders.push(order);
      itemsTotal += Number(order.price) || 0;
    }

    if (orders.length === 0) {
      return jsonResponse({ error: 'All basket items are already paid.' }, 400);
    }

    // Voucher discount
    let discountAmount = 0;
    let voucherData = null;
    let voucherKey = null;

    if (voucherCode) {
      voucherKey = `voucher:${voucherCode.trim().toUpperCase()}`;
      const vRaw = await env.ORDERS_KV.get(voucherKey);
      if (vRaw) {
        voucherData = JSON.parse(vRaw);
        const balance = typeof voucherData.balance === 'number' ? voucherData.balance : voucherData.value;
        if (!voucherData.redeemed && balance > 0) {
          discountAmount = Math.min(itemsTotal, balance);
        }
      }
    }

    const finalItemsTotal = Math.max(0, itemsTotal - discountAmount);

    // Shipping cost
    let shipCost = 0;
    if (shippingMethod === 'GB') shipCost = 5;
    else if (shippingMethod === 'GI_DELIVER') shipCost = 3;

    // Build the success URL — use first orderId as the tracking reference
    const firstOrderId = orders[0].orderId;
    const allOrderIds = orders.map(o => o.orderId).join(',');
    const successUrl = `https://magnetic-memories.pages.dev/return.html?status=success&orderId=${encodeURIComponent(firstOrderId)}&basketIds=${encodeURIComponent(allOrderIds)}`;
    const cancelUrl = `https://magnetic-memories.pages.dev/return.html?status=cancel&orderId=${encodeURIComponent(firstOrderId)}`;

    // Fully covered by voucher — skip Stripe
    if (discountAmount > 0 && finalItemsTotal === 0 && shipCost === 0) {
      const balance = typeof voucherData.balance === 'number' ? voucherData.balance : voucherData.value;
      const newBalance = balance - discountAmount;
      voucherData.balance = Math.max(0, newBalance);
      if (voucherData.balance <= 0) voucherData.redeemed = true;
      voucherData.usedByOrder = firstOrderId;
      await env.ORDERS_KV.put(voucherKey, JSON.stringify(voucherData));

      for (const order of orders) {
        order.status = 'paid';
        order.paidAt = new Date().toISOString();
        order.price = 0;
        order.usedVoucher = voucherCode;
        await env.ORDERS_KV.put(`order:${order.orderId}`, JSON.stringify(order));
      }

      const firstOrder = { ...orders[0], basketOrderIds: allOrderIds };
      await Promise.allSettled([sendAdminEmail(firstOrder, env), sendPaidTelegram(firstOrder, env)]);
      for (const order of orders) await sendPaidEmail(order, env);

      return jsonResponse({ checkoutUrl: successUrl });
    }

    // Build Stripe params
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', successUrl);
    params.append('cancel_url', cancelUrl);
    params.append('customer_email', email);
    params.append('metadata[basketOrderIds]', allOrderIds);
    if (voucherCode && discountAmount > 0) params.append('metadata[usedVoucher]', voucherCode);

    // Product line items
    orders.forEach((order, i) => {
      const itemPrice = Math.max(0, (Number(order.price) || 0) - (i === 0 ? discountAmount : 0));
      let name = '';
      if (order.productType === 'keyring') name = 'Double-Sided Photo Keyring';
      else if (order.productType === 'frame' || order.productType === 'frames' || order.frameStyle) {
        const style = (order.frameStyle || '').charAt(0).toUpperCase() + (order.frameStyle || '').slice(1);
        name = `${style} Frame (${order.frameSize || '?'} slots)`;
      } else {
        name = `${order.packSize} Custom Photo Magnets`;
        if (order.packType === 'big_picture') name = `Jigsaw Picture (${order.packSize} magnets)`;
      }

      params.append(`line_items[${i}][quantity]`, '1');
      params.append(`line_items[${i}][price_data][currency]`, 'gbp');
      params.append(`line_items[${i}][price_data][product_data][name]`, name);
      params.append(`line_items[${i}][price_data][unit_amount]`, String(Math.round(itemPrice * 100)));
    });

    // Shipping
    const shipIdx = orders.length;
    if (shippingMethod === 'GB') {
      params.append('shipping_address_collection[allowed_countries][0]', 'GB');
      params.append(`shipping_options[0][shipping_rate_data][type]`, 'fixed_amount');
      params.append(`shipping_options[0][shipping_rate_data][fixed_amount][amount]`, '500');
      params.append(`shipping_options[0][shipping_rate_data][fixed_amount][currency]`, 'gbp');
      params.append(`shipping_options[0][shipping_rate_data][display_name]`, 'UK Postage');
    } else if (shippingMethod === 'GI_DELIVER') {
      params.append('shipping_address_collection[allowed_countries][0]', 'GI');
      params.append(`shipping_options[0][shipping_rate_data][type]`, 'fixed_amount');
      params.append(`shipping_options[0][shipping_rate_data][fixed_amount][amount]`, '300');
      params.append(`shipping_options[0][shipping_rate_data][fixed_amount][currency]`, 'gbp');
      params.append(`shipping_options[0][shipping_rate_data][display_name]`, 'Local Delivery');
    } else {
      params.append('shipping_address_collection[allowed_countries][0]', 'GI');
      params.append(`shipping_options[0][shipping_rate_data][type]`, 'fixed_amount');
      params.append(`shipping_options[0][shipping_rate_data][fixed_amount][amount]`, '0');
      params.append(`shipping_options[0][shipping_rate_data][fixed_amount][currency]`, 'gbp');
      params.append(`shipping_options[0][shipping_rate_data][display_name]`, 'Collection (Atlantic Suites)');
    }

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) {
      console.error('Stripe basket checkout error:', session);
      return jsonResponse({ error: 'Failed to create checkout.' }, 500);
    }

    // Save session ID on first order for dedup protection
    orders[0].stripeSessionId = session.id;
    await env.ORDERS_KV.put(`order:${orders[0].orderId}`, JSON.stringify(orders[0]));

    return jsonResponse({ checkoutUrl: session.url });
  } catch (err) {
    console.error('Basket checkout error:', err);
    return jsonResponse({ error: 'Basket checkout failed.' }, 500);
  }
}
