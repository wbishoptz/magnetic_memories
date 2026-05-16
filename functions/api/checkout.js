import {
  STANDARD_PACKS, STANDARD_PRICES,
  BINGO_PACKS, BINGO_PRICES,
  VALENTINES_PACKS, VALENTINES_PRICES,
  FLEXI_PRICE, MOTHERS_PACKAGES, FRAME_PRICES, VOUCHERS,
  jsonResponse,
  sendPaidEmail, sendBingoEmail, sendAdminEmail, sendPaidTelegram
} from './_shared.js';

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    const orderId = body?.orderId;
    const voucherCode = body?.voucherCode;
    let eventTag = body?.event || null;

    if (!orderId) return jsonResponse({ error: "Missing orderId." }, 400);

    const kvKey = `order:${orderId}`;
    let kvOrder = null;
    try {
      const kvRaw = await env.ORDERS_KV.get(kvKey);
      if (kvRaw) kvOrder = JSON.parse(kvRaw);
    } catch (e) {
      console.error("KV get error:", e);
    }

    let successPage = "return.html";
    if (kvOrder?.event === 'BINGO') successPage = "bingo-return.html";
    const successUrl = `https://magnetic-memories.pages.dev/${successPage}?status=success&orderId=${encodeURIComponent(orderId)}`;

    if (kvOrder && ['paid', 'printing', 'shipped', 'completed'].includes(kvOrder.status)) {
      return jsonResponse({ checkoutUrl: successUrl });
    }

    if (kvOrder && kvOrder.stripeSessionId) {
      try {
        const sessionRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${kvOrder.stripeSessionId}`, {
          headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
        });
        if (sessionRes.ok) {
          const existing = await sessionRes.json();
          if (existing.status === 'open') return jsonResponse({ checkoutUrl: existing.url });
        }
      } catch (e) {
        console.error("Session check failed:", e);
      }
    }

    if (!eventTag && kvOrder?.event) eventTag = kvOrder.event;
    const productType = kvOrder?.productType || body?.productType || 'standard';
    const packSizeRaw = kvOrder?.packSize || body?.packSize;

    let price = 0;
    let productName = "";
    let productDesc = "";
    let isVoucherPurchase = false;

    if (typeof packSizeRaw === 'string' && packSizeRaw.startsWith('voucher_')) {
      const v = VOUCHERS[packSizeRaw];
      if (!v) return jsonResponse({ error: "Invalid voucher type" }, 400);
      price = v.price;
      productName = v.label;
      productDesc = "Digital code sent via email upon payment.";
      isVoucherPurchase = true;
    } else if (productType === 'keyring') {
      price = 6.00;
      productName = "Double-Sided Photo Keyring";
      productDesc = "Premium keyring with front and back photos";
    } else {
      let size = Number(packSizeRaw);

      if (eventTag === 'MOTHERS_DAY') {
        if (productType === 'frames') {
          const style = kvOrder.frameStyle || 'bohemian';
          const fSize = kvOrder.frameSize || size;
          const pData = FRAME_PRICES[style]?.[fSize];
          if (pData) {
            price = kvOrder.includeMagnets ? pData.full : pData.frame;
            const styleName = style.charAt(0).toUpperCase() + style.slice(1);
            productName = `Mother's Day: ${styleName} Frame (${kvOrder.frameColor || 'White'})`;
            productDesc = kvOrder.includeMagnets ? `With ${fSize} personalised magnets` : `Frame only (${fSize} slots)`;
          } else {
            price = 0; productName = "Unknown Frame Configuration";
          }
        } else {
          price = MOTHERS_PACKAGES[kvOrder.mothersPackage] || 0;
          productName = `Mother's Day: ${kvOrder.mothersPackage}`;
          productDesc = `${size} magnets included`;
        }
      } else if (eventTag === 'FRAMES') {
        if (productType === 'flexi') {
          price = FLEXI_PRICE;
          const color = kvOrder.flexiColor || kvOrder.frameColor || 'Standard';
          productName = `Heart Buddy (${color})`;
          productDesc = "1 Custom Photo Face";
        } else {
          const style = kvOrder.frameStyle || 'bohemian';
          const fSize = kvOrder.frameSize || size;
          const withMags = kvOrder.includeMagnets || false;
          const color = kvOrder.frameColor || 'White';
          const pData = FRAME_PRICES[style]?.[fSize];
          if (pData) {
            price = withMags ? pData.full : pData.frame;
            const styleName = style.charAt(0).toUpperCase() + style.slice(1);
            productName = `${styleName} Frame (${color})`;
            productDesc = withMags ? `With ${fSize} personalised magnets` : `Frame only (${fSize} slots)`;
          } else {
            price = 0; productName = "Unknown Frame Configuration";
          }
        }
      } else if (eventTag === 'VALENTINES') {
        if (productType === 'flexi') {
          price = FLEXI_PRICE;
          const color = kvOrder?.flexiColor || "Standard";
          productName = `Heart Buddy (${color})`;
          productDesc = "1 Custom Photo Face";
        } else {
          price = VALENTINES_PRICES[size] || 0;
          productName = `Valentine's Box (${size} magnets)`;
          productDesc = "Custom Photos + Pre-made Designs";
        }
      } else if (eventTag === 'BINGO') {
        price = BINGO_PRICES[size] || 20;
        productName = `Bingo Special (${size} magnets)`;
        productDesc = "Collect at the stall";
      } else {
        if (!STANDARD_PACKS.includes(size)) size = 3;
        price = STANDARD_PRICES[size];
        productName = `${size} Custom Photo Magnets`;
        productDesc = "50×50mm fridge magnets";
        const type = kvOrder?.packType || body?.packType || "standard";
        if (type === 'big_picture') {
          productName = `Jigsaw Picture (${size} magnets)`;
          productDesc = "One large photo split across magnets.";
        }
      }
    }

    if (eventTag === 'BINGO' && kvOrder?.bingoNumber) {
      productName = `Order #${kvOrder.bingoNumber} - ${productName}`;
    }

    const cancelUrl = `https://magnetic-memories.pages.dev/return.html?status=cancel&orderId=${encodeURIComponent(orderId)}`;

    // --- Voucher discount ---
    let discountAmount = 0;
    let finalPrice = price;
    let voucherData = null;
    let voucherKey = null;

    if (voucherCode && !isVoucherPurchase) {
      voucherKey = `voucher:${voucherCode.trim().toUpperCase()}`;
      const vRaw = await env.ORDERS_KV.get(voucherKey);
      if (vRaw) {
        voucherData = JSON.parse(vRaw);
        const currentBalance = (typeof voucherData.balance === 'number') ? voucherData.balance : voucherData.value;
        if (!voucherData.redeemed && currentBalance > 0) {
          discountAmount = Math.min(price, currentBalance);
          finalPrice = Math.max(0, price - discountAmount);
        }
      }
    }

    // Fully covered by voucher — skip Stripe
    if (voucherCode && discountAmount > 0 && finalPrice === 0) {
      const currentBalance = (typeof voucherData.balance === 'number') ? voucherData.balance : voucherData.value;
      const newBalance = currentBalance - discountAmount;
      voucherData.balance = newBalance;
      if (newBalance <= 0) { voucherData.redeemed = true; voucherData.balance = 0; }
      voucherData.usedByOrder = orderId;
      await env.ORDERS_KV.put(voucherKey, JSON.stringify(voucherData));

      kvOrder.status = "paid";
      kvOrder.paidAt = new Date().toISOString();
      kvOrder.price = 0;
      kvOrder.usedVoucher = voucherCode;
      await env.ORDERS_KV.put(kvKey, JSON.stringify(kvOrder));

      const notifs = [sendAdminEmail(kvOrder, env), sendPaidTelegram(kvOrder, env)];
      if (eventTag === 'BINGO') notifs.push(sendBingoEmail(kvOrder, env));
      else notifs.push(sendPaidEmail(kvOrder, env));
      await Promise.allSettled(notifs);

      return jsonResponse({ checkoutUrl: successUrl });
    }

    // --- Build Stripe params ---
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", successUrl);
    params.append("cancel_url", cancelUrl);
    if (kvOrder?.email) params.append("customer_email", kvOrder.email);
    params.append("metadata[orderId]", orderId);
    if (eventTag) params.append("metadata[event]", eventTag);
    if (isVoucherPurchase) {
      params.append("metadata[isVoucher]", "true");
      params.append("metadata[voucherValue]", String(price));
    }
    if (voucherCode) params.append("metadata[usedVoucher]", voucherCode);

    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", "gbp");
    params.append("line_items[0][price_data][product_data][name]", productName);
    let desc = productDesc;
    if (discountAmount > 0) desc += ` (Voucher ${voucherCode}: -£${discountAmount})`;
    params.append("line_items[0][price_data][product_data][description]", desc);
    params.append("line_items[0][price_data][unit_amount]", String(Math.round(finalPrice * 100)));

    if (!isVoucherPurchase) {
      const targetCountry = body?.country || kvOrder?.shippingMethod || "GI_COLLECT";
      if (targetCountry === "GB") {
        params.append("shipping_address_collection[allowed_countries][0]", "GB");
        params.append("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
        params.append("shipping_options[0][shipping_rate_data][fixed_amount][amount]", "500");
        params.append("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "gbp");
        params.append("shipping_options[0][shipping_rate_data][display_name]", "UK Postage");
      } else if (targetCountry === "GI_DELIVER") {
        params.append("shipping_address_collection[allowed_countries][0]", "GI");
        params.append("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
        params.append("shipping_options[0][shipping_rate_data][fixed_amount][amount]", "300");
        params.append("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "gbp");
        params.append("shipping_options[0][shipping_rate_data][display_name]", "Local Delivery");
      } else {
        params.append("shipping_address_collection[allowed_countries][0]", "GI");
        params.append("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
        params.append("shipping_options[0][shipping_rate_data][fixed_amount][amount]", "0");
        params.append("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "gbp");
        params.append("shipping_options[0][shipping_rate_data][display_name]", "Collection (Atlantic Suites)");
      }
    }

    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) {
      console.error("Stripe error:", session);
      return jsonResponse({ error: "Failed to create checkout." }, 500);
    }

    kvOrder.stripeSessionId = session.id;
    if (voucherCode && discountAmount > 0) kvOrder.usedVoucher = voucherCode;
    await env.ORDERS_KV.put(kvKey, JSON.stringify(kvOrder));

    return jsonResponse({ checkoutUrl: session.url });
  } catch (err) {
    console.error("Checkout Error:", err);
    return jsonResponse({ error: "Checkout failed" }, 500);
  }
}
