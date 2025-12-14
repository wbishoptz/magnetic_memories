// functions/api/checkout.js
// POST /api/checkout

const PACKS = [3, 6, 9, 12, 15];
const PRICES = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };

// NEW VOUCHER CONFIGURATION
const VOUCHERS = { 
    "voucher_14": { price: 14, label: "£14 Gift Voucher (6 Magnets)" },
    "voucher_20": { price: 20, label: "£20 Gift Voucher (9 Magnets)" },
    "voucher_25": { price: 25, label: "£25 Gift Voucher (12 Magnets)" },
    "voucher_30": { price: 30, label: "£30 Gift Voucher (15 Magnets)" }
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);
    const orderId = body?.orderId;
    const targetCountry = body?.country || "GI"; 
    const voucherCode = body?.voucherCode; // <--- NEW: User applying a code

    if (!orderId) {
      return jsonResponse({ error: "Missing orderId." }, 400);
    }

    const kvKey = `order:${orderId}`;
    let kvOrder = null;
    try {
      const kvRaw = await env.ORDERS_KV.get(kvKey);
      if (kvRaw) kvOrder = JSON.parse(kvRaw);
    } catch (e) {
      console.error("KV get error:", e);
    }

    // --- DETERMINE PRODUCT (Magnets vs Voucher) ---
    const packSizeRaw = kvOrder?.packSize || body?.packSize;
    let price = 0;
    let productName = "";
    let productDesc = "";
    let isVoucherPurchase = false;

    // Check if buying a voucher
    if (typeof packSizeRaw === 'string' && packSizeRaw.startsWith('voucher_')) {
        const v = VOUCHERS[packSizeRaw];
        if (!v) return jsonResponse({ error: "Invalid voucher type" }, 400);
        price = v.price;
        productName = v.label;
        productDesc = "Digital code sent via email upon payment.";
        isVoucherPurchase = true;
    } else {
        // Normal magnets
        let size = Number(packSizeRaw) || 3;
        if (!PACKS.includes(size)) size = 3;
        price = PRICES[size];
        
        let type = kvOrder?.packType || body?.packType || "standard";
        productName = `${size} custom photo magnets`;
        productDesc = "50×50mm fridge magnets";
        if (type === 'big_picture') {
            productName = `Jigsaw Picture (${size} magnets)`;
            productDesc = "One large photo split across magnets.";
        }
    }

    // --- APPLY DISCOUNT CODE (If Redeeming) ---
    let discountAmount = 0;
    let finalPrice = price;
    
    if (voucherCode && !isVoucherPurchase) {
        const vKey = `voucher:${voucherCode.trim().toUpperCase()}`;
        const vRaw = await env.ORDERS_KV.get(vKey);
        if (vRaw) {
            const vData = JSON.parse(vRaw);
            if (!vData.redeemed) {
                discountAmount = vData.value;
                finalPrice = Math.max(0, price - discountAmount);
            }
        }
    }

    // --- STRIPE SESSION ---
    const successUrl = `https://magnetic-memories.pages.dev/return.html?status=success&orderId=${encodeURIComponent(orderId)}`;
    const cancelUrl = `https://magnetic-memories.pages.dev/return.html?status=cancel&orderId=${encodeURIComponent(orderId)}`;

    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", successUrl);
    params.append("cancel_url", cancelUrl);
    if (kvOrder?.email) params.append("customer_email", kvOrder.email);
    params.append("metadata[orderId]", orderId);
    
    // Pass isVoucher flag to metadata so Webhook knows to generate a code later
    if (isVoucherPurchase) {
        params.append("metadata[isVoucher]", "true");
        params.append("metadata[voucherValue]", String(price));
    }
    
    // Record used code in metadata to mark it redeemed later
    if (voucherCode && discountAmount > 0) {
        params.append("metadata[usedVoucher]", voucherCode);
    }

    // Line Item 1: The Product
    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", "gbp");
    params.append("line_items[0][price_data][product_data][name]", productName);
    params.append("line_items[0][price_data][product_data][description]", productDesc);
    params.append("line_items[0][price_data][unit_amount]", String(price * 100)); // Original price

    // Handle Discount logic
    // Stripe Checkout coupons are complex to create on the fly. 
    // Easier hack: Send "Price" as the discounted amount if a voucher is used.
    // OR: If finalPrice is 0 (fully covered), we can't use Stripe Checkout normally (it requires >£0.30).
    // For MVP: If fully covered, we skip Stripe and just confirm order immediately.
    
    if (voucherCode && discountAmount > 0) {
        if (finalPrice === 0) {
            // --- 100% DISCOUNT FLOW ---
            // Mark voucher redeemed immediately and return "Success" URL directly
            const vKey = `voucher:${voucherCode.trim().toUpperCase()}`;
            const vRaw = await env.ORDERS_KV.get(vKey);
            const vData = JSON.parse(vRaw);
            vData.redeemed = true;
            vData.usedByOrder = orderId;
            await env.ORDERS_KV.put(vKey, JSON.stringify(vData));

            // Update Order
            kvOrder.status = "paid";
            kvOrder.paidAt = new Date().toISOString();
            kvOrder.price = 0;
            kvOrder.usedVoucher = voucherCode;
            await env.ORDERS_KV.put(kvKey, JSON.stringify(kvOrder));

            return jsonResponse({ checkoutUrl: successUrl });
        } else {
            // Partial payment needed - Overwrite the unit_amount to the lower price
            // We verify this is safe because we controlled the calculation above.
            params.set("line_items[0][price_data][unit_amount]", String(finalPrice * 100));
            // Add note to description
            params.set("line_items[0][price_data][product_data][description]", `${productDesc} (Voucher ${voucherCode} applied: -£${discountAmount})`);
        }
    }

    // Shipping Logic (Only add shipping if it's NOT a digital voucher purchase)
    if (!isVoucherPurchase) {
        if (targetCountry === "GB") {
            params.append("shipping_address_collection[allowed_countries][0]", "GB");
            params.append("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
            params.append("shipping_options[0][shipping_rate_data][fixed_amount][amount]", "500");
            params.append("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "gbp");
            params.append("shipping_options[0][shipping_rate_data][display_name]", "UK Postage");
        } else {
            params.append("shipping_address_collection[allowed_countries][0]", "GI");
            params.append("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
            params.append("shipping_options[0][shipping_rate_data][fixed_amount][amount]", "0");
            params.append("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "gbp");
            params.append("shipping_options[0][shipping_rate_data][display_name]", "Local Delivery");
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

    // Save session ID
    kvOrder.stripeSessionId = session.id;
    if (voucherCode && discountAmount > 0) kvOrder.usedVoucher = voucherCode;
    
    await env.ORDERS_KV.put(kvKey, JSON.stringify(kvOrder));

    return jsonResponse({ checkoutUrl: session.url });

  } catch (err) {
    console.error("Checkout Error:", err);
    return jsonResponse({ error: "Checkout failed" }, 500);
  }
}