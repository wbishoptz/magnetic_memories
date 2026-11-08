// POST /api/basket-checkout
// Creates one Stripe checkout session for multiple draft orders (basket).
// Body: { orderIds, email, phone, shippingMethod, socialPermission, voucherCode? }

import {
  jsonResponse, promoPercent, sendAdminEmail, sendPaidTelegram, sendPaidEmail, shopPrice, expireCheckoutSession,
  cleanVoucherCode, voucherBalance, holdVoucher, releaseVoucherHolds,
} from './_shared.js';

const pounds = (n) => Math.round(Number(n) * 100) / 100;

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const { orderIds, email, phone, shippingMethod, socialPermission } = body;
    // Gift vouchers are stored upper case (voucher:MM-ABCD): use that form everywhere below
    const voucherCode = cleanVoucherCode(body.voucherCode);

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

      // Event guest uploads are never shop items (same guard as checkout.js)
      if (order.source === 'guest') return jsonResponse({ error: "This order can't be paid here." }, 400);

      // Reject if already paid (e.g. browser back button edge case)
      if (['paid', 'printing', 'shipped', 'completed'].includes(order.status)) continue;

      // Always charge the real price from the price list, never just what's stored
      const p = shopPrice(order);
      if (p == null) {
        const isVoucher = typeof order.packSize === 'string' && order.packSize.startsWith('voucher_');
        return jsonResponse({ error: isVoucher
          ? "Gift vouchers can't be bought in the basket - please remove it and buy it on its own."
          : "One of the basket items can't be bought here - please remove it." }, 400);
      }
      order.price = p;

      order.email = email;
      order.phone = phone;
      order.shippingMethod = shippingMethod;
      order.socialPermission = socialPermission;
      order.status = 'checkout_created';
      order.basketDraft = false; // now a real order
      order.updatedAt = new Date().toISOString();

      orders.push(order); // saved below, once any earlier checkout of these items is closed
      itemsTotal += p;
    }

    if (orders.length === 0) {
      return jsonResponse({ error: 'All basket items are already paid.' }, 400);
    }

    // Checked out before (e.g. back from Stripe, then the delivery changed): that session
    // charges the old basket, so expire it before these orders change - it must never be
    // paid now. A session that was already paid means the basket is paid.
    for (const sid of new Set(orders.map(o => o.stripeSessionId).filter(Boolean))) {
      const result = await expireCheckoutSession(env, sid);
      if (result === 'complete') return jsonResponse({ error: 'This basket has already been paid.' }, 409);
      if (!result) return jsonResponse({ error: 'Basket checkout failed - please try again.' }, 503);
    }
    for (const order of orders) {
      order.stripeSessionId = null;
      await env.ORDERS_KV.put(`order:${order.orderId}`, JSON.stringify(order));
    }

    // Voucher / promo discount
    let discountAmount = 0;
    let voucherData = null;
    let voucherKey = null;
    let promoPct = 0;

    if (voucherCode) {
      promoPct = promoPercent(voucherCode);
      if (promoPct > 0) {
        // Percentage sale code (e.g. SUN20) — applied to every line item below
        discountAmount = Math.round(itemsTotal * promoPct) / 100;
      } else {
        voucherKey = `voucher:${voucherCode}`;
        const vRaw = await env.ORDERS_KV.get(voucherKey);
        if (vRaw) {
          voucherData = JSON.parse(vRaw);
          const balance = voucherBalance(voucherData);
          if (balance > 0) {
            // One checkout at a time per voucher (any other open one is expired)
            const pending = await releaseVoucherHolds(env, voucherCode, voucherData);
            if (pending === null) return jsonResponse({ error: 'Basket checkout failed - please try again.' }, 503);
            discountAmount = pounds(Math.min(itemsTotal, Math.max(0, balance - pending)));
          }
        }
      }
    }

    const finalItemsTotal = Math.max(0, pounds(itemsTotal - discountAmount));

    // Shipping cost
    let shipCost = 0;
    if (shippingMethod === 'GB') shipCost = 5;
    else if (shippingMethod === 'GI_DELIVER') shipCost = 3;

    // Build the success URL — use first orderId as the tracking reference
    const firstOrderId = orders[0].orderId;
    const allOrderIds = orders.map(o => o.orderId).join(',');
    const successUrl = `https://magnetic-memories.pages.dev/return.html?status=success&orderId=${encodeURIComponent(firstOrderId)}&basketIds=${encodeURIComponent(allOrderIds)}`;
    const cancelUrl = `https://magnetic-memories.pages.dev/return.html?status=cancel&orderId=${encodeURIComponent(firstOrderId)}`;

    // Fully covered by a GIFT VOUCHER — skip Stripe (percentage codes never hit this)
    if (discountAmount > 0 && finalItemsTotal === 0 && shipCost === 0 && voucherData) {
      voucherData.balance = Math.max(0, pounds(voucherBalance(voucherData) - discountAmount));
      if (voucherData.balance <= 0) voucherData.redeemed = true;
      voucherData.usedByOrder = firstOrderId;
      voucherData.redemptions = [...(voucherData.redemptions || []),
        { sessionId: null, orderId: firstOrderId, amount: discountAmount, at: new Date().toISOString() }];
      await env.ORDERS_KV.put(voucherKey, JSON.stringify(voucherData));

      for (const order of orders) {
        order.status = 'paid';
        order.paidAt = new Date().toISOString();
        order.price = 0;
        order.usedVoucher = voucherCode;
        await env.ORDERS_KV.put(`order:${order.orderId}`, JSON.stringify(order));
      }

      await Promise.allSettled([
        ...orders.map(o => sendAdminEmail(o, env)),
        ...orders.map(o => sendPaidTelegram(o, env)),
        ...orders.map(o => sendPaidEmail(o, env))
      ]);

      return jsonResponse({ checkoutUrl: successUrl });
    }

    // Build Stripe params
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', successUrl);
    params.append('cancel_url', cancelUrl);
    params.append('customer_email', email);
    params.append('metadata[basketOrderIds]', allOrderIds);

    // Item prices. Percentage code: take % off each item. Gift voucher: spend it on the
    // items in order (as much of each as is left), so the basket total drops by all of it.
    let voucherLeft = promoPct > 0 ? 0 : discountAmount;
    const itemPrices = orders.map(order => {
      const base = Number(order.price) || 0;
      if (promoPct > 0) return Math.round(base * (100 - promoPct)) / 100;
      const take = Math.min(voucherLeft, base);
      voucherLeft = pounds(voucherLeft - take);
      return Math.max(0, pounds(base - take));
    });
    const voucherUsed = promoPct > 0 ? 0 : pounds(discountAmount - voucherLeft);

    if (voucherCode && discountAmount > 0) {
      params.append('metadata[usedVoucher]', voucherCode);
      // What the gift voucher took off: the webhook takes exactly this off its balance
      if (voucherData) params.append('metadata[voucherDiscount]', voucherUsed.toFixed(2));
    }

    // Product line items
    orders.forEach((order, i) => {
      const itemPrice = itemPrices[i];
      let name = '';
      if (order.productType === 'keyring') name = 'Double-Sided Photo Keyring';
      else if (order.productType === 'ornament') name = Number(order.packSize) === 1 ? 'Christmas Colour-In Ornament' : `${order.packSize} Christmas Colour-In Ornaments`;
      else if (order.productType === 'santa_letter') name = Number(order.packSize) === 1 ? 'Letter from Santa' : `${Number(order.packSize)} Letters from Santa`;
      else if (order.productType === 'bauble_card') name = Number(order.packSize) === 1 ? 'Photo Bauble Card' : `${Number(order.packSize)} Photo Bauble Cards`;
      else if (order.productType === 'magnet_card') name = Number(order.packSize) === 1 ? 'Christmas Magnet Card' : `${Number(order.packSize)} Christmas Magnet Cards`;
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

    if (voucherData && voucherUsed > 0) {
      await holdVoucher(env, voucherCode, session.id, voucherUsed, orders.map(o => o.orderId));
    }

    // Save the session ID on every item (not just the first): if any item is changed later,
    // order.js expires this session so it can't be paid for the old basket.
    for (const order of orders) {
      order.stripeSessionId = session.id;
      await env.ORDERS_KV.put(`order:${order.orderId}`, JSON.stringify(order));
    }

    return jsonResponse({ checkoutUrl: session.url });
  } catch (err) {
    console.error('Basket checkout error:', err);
    return jsonResponse({ error: 'Basket checkout failed.' }, 500);
  }
}
