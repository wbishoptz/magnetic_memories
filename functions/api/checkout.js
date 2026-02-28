// functions/api/checkout.js

// --- PRICING CONFIGURATION ---
const STANDARD_PACKS = [3, 6, 9, 12, 15];
const STANDARD_PRICES = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };

const BINGO_PACKS = [1, 3, 6, 12];
// UPDATED: 1 magnet is now £4.00
const BINGO_PRICES = { 1: 4.00, 3: 10, 6: 20, 12: 35 };

const VALENTINES_PACKS = [1, 2, 3, 4];
const VALENTINES_PRICES = { 1: 12.50, 2: 25.00, 3: 30.00, 4: 35.00 };
const FLEXI_PRICE = 12.50;

// Mother's Day Packages (Custom + Premade Magnets)
const MOTHERS_PACKAGES = {
  "Bouquet Bloom": 12.50,
  "Garden Party": 25.00,
  "Full Bloom": 30.00,
  "Mum's Treasure": 35.00
};

// Frame Pricing
const FRAME_PRICES = {
  bohemian: {
    3: { frame: 8, full: 15 },
    4: { frame: 10, full: 17 },
    6: { frame: 12, full: 25 },
    9: { frame: 15, full: 30 }, 
  },
  sleek: {
    1: { frame: 5, full: 7 },
    2: { frame: 7, full: 12 },
    3: { frame: 8, full: 15 },
    4: { frame: 10, full: 17 },
  },
  rollercube: {
    4: { frame: 10, full: 17 }
  }
};

const VOUCHERS = { 
    "voucher_14": { price: 14, label: "£14 Gift Voucher" },
    "voucher_20": { price: 20, label: "£20 Gift Voucher" },
    "voucher_25": { price: 25, label: "£25 Gift Voucher" },
    "voucher_30": { price: 30, label: "£30 Gift Voucher" }
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
    const voucherCode = body?.voucherCode; 
    let eventTag = body?.event || null; 
    
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

    // Determine Success Page
    let successPage = "return.html";
    if (kvOrder?.event === 'BINGO') successPage = "bingo-return.html";
    const successUrl = `https://magnetic-memories.pages.dev/${successPage}?status=success&orderId=${encodeURIComponent(orderId)}`;

    // --- CHECK 1: IS IT ALREADY PAID? ---
    if (kvOrder && ['paid', 'printing', 'shipped', 'completed'].includes(kvOrder.status)) {
        return jsonResponse({ checkoutUrl: successUrl });
    }

    // --- CHECK 2: REUSE EXISTING STRIPE SESSION ---
    if (kvOrder && kvOrder.stripeSessionId) {
        try {
            const sessionRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${kvOrder.stripeSessionId}`, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
                },
            });

            if (sessionRes.ok) {
                const existingSession = await sessionRes.json();
                if (existingSession.status === 'open') {
                    return jsonResponse({ checkoutUrl: existingSession.url });
                }
            }
        } catch (e) {
            console.error("Session check failed (ignoring):", e);
        }
    }

    // Ensure we have the event/product info from KV if not passed in body
    if (!eventTag && kvOrder?.event) eventTag = kvOrder.event;
    const productType = kvOrder?.productType || body?.productType || 'standard';

    // --- DETERMINE PRODUCT & PRICE ---
    const packSizeRaw = kvOrder?.packSize || body?.packSize;
    let price = 0;
    let productName = "";
    let productDesc = "";
    let isVoucherPurchase = false;

    if (typeof packSizeRaw === 'string' && packSizeRaw.startsWith('voucher_')) {
        // 1. BUYING A GIFT VOUCHER
        const v = VOUCHERS[packSizeRaw];
        if (!v) return jsonResponse({ error: "Invalid voucher type" }, 400);
        price = v.price;
        productName = v.label;
        productDesc = "Digital code sent via email upon payment.";
        isVoucherPurchase = true;
    } else {
        // 2. BUYING PHYSICAL ITEMS
        let size = Number(packSizeRaw);
        
        if (eventTag === 'MOTHERS_DAY') {
            // --- MOTHER'S DAY LOGIC ---
            if (productType === 'frames') {
                const style = kvOrder.frameStyle || 'bohemian';
                const fSize = kvOrder.frameSize || size;
                const pData = FRAME_PRICES[style]?.[fSize];
                
                if (pData) {
                    price = kvOrder.includeMagnets ? pData.full : pData.frame;
                    const styleName = style.charAt(0).toUpperCase() + style.slice(1);
                    productName = `Mother's Day: ${styleName} Frame (${kvOrder.frameColor || 'White'})`;
                    productDesc = `With ${fSize} personalised magnets`;
                } else {
                    price = 0; productName = "Unknown Frame Configuration";
                }
            } else {
                price = MOTHERS_PACKAGES[kvOrder.mothersPackage] || 0;
                productName = `Mother's Day: ${kvOrder.mothersPackage}`;
                productDesc = `${size} magnets included`;
            }

        } else if (eventTag === 'FRAMES') {
            // --- NEW FRAMES LOGIC ---
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

        } else if (eventTag === 'VALENTINES') {
            // --- VALENTINES LOGIC ---
            if (productType === 'flexi') {
                price = FLEXI_PRICE;
                const color = kvOrder?.flexiColor || "Standard";
                productName = `Flexi Heart (${color})`;
                productDesc = "1 Custom Photo Face";
            } else {
                price = VALENTINES_PRICES[size] || 0;
                productName = `Valentine's Box (${size} magnets)`;
                productDesc = "Custom Photos + Pre-made Designs";
            }

        } else if (eventTag === 'BINGO') {
            // --- BINGO LOGIC ---
            price = BINGO_PRICES[size] || 20; 
            productName = `Bingo Special (${size} magnets)`;
            productDesc = "Collect at the stall";

        } else {
            // --- STANDARD LOGIC ---
            if (!STANDARD_PACKS.includes(size)) size = 3;
            price = STANDARD_PRICES[size];
            productName = `${size} Custom Photo Magnets`;
            productDesc = "50×50mm fridge magnets";
            
            let type = kvOrder?.packType || body?.packType || "standard";
            if (type === 'big_picture') {
                productName = `Jigsaw Picture (${size} magnets)`;
                productDesc = "One large photo split across magnets.";
            }
        }
    }

    // --- INJECT BINGO ORDER NUMBER ---
    if (eventTag === 'BINGO' && kvOrder?.bingoNumber) {
        productName = `Order #${kvOrder.bingoNumber} - ${productName}`;
    }

    const cancelUrl = `https://magnetic-memories.pages.dev/return.html?status=cancel&orderId=${encodeURIComponent(orderId)}`;

    // --- STRIPE SESSION PARAMS ---
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", successUrl);
    params.append("cancel_url", cancelUrl);
    if (kvOrder?.email) params.append("customer_email", kvOrder.email);
    params.append("metadata[orderId]", orderId);
    if (eventTag) params.append("metadata[event]", eventTag); 
    
    // Voucher Metadata
    if (isVoucherPurchase) {
        params.append("metadata[isVoucher]", "true");
        params.append("metadata[voucherValue]", String(price));
    }
    if (voucherCode) {
        params.append("metadata[usedVoucher]", voucherCode);
    }

    // APPLY VOUCHER DISCOUNT LOGIC
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

    // CREATE STRIPE LINE ITEM
    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", "gbp");
    params.append("line_items[0][price_data][product_data][name]", productName);
    params.append("line_items[0][price_data][product_data][description]", productDesc);
    params.append("line_items[0][price_data][unit_amount]", String(Math.round(finalPrice * 100))); 

    if (discountAmount > 0) {
        params.set("line_items[0][price_data][product_data][description]", `${productDesc} (Voucher ${voucherCode}: -£${discountAmount})`);
    }

    // --- 100% DISCOUNT HANDLING (SKIP STRIPE) ---
    if (voucherCode && discountAmount > 0 && finalPrice === 0) {
        // Update Voucher
        const currentBalance = (typeof voucherData.balance === 'number') ? voucherData.balance : voucherData.value;
        const newBalance = currentBalance - discountAmount;
        voucherData.balance = newBalance;
        if (newBalance <= 0) {
            voucherData.redeemed = true;
            voucherData.balance = 0;
        }
        voucherData.usedByOrder = orderId; 
        await env.ORDERS_KV.put(voucherKey, JSON.stringify(voucherData));

        // Update Order
        kvOrder.status = "paid";
        kvOrder.paidAt = new Date().toISOString();
        kvOrder.price = 0;
        kvOrder.usedVoucher = voucherCode;
        await env.ORDERS_KV.put(kvKey, JSON.stringify(kvOrder));

        // Notifications
        const notifs = [sendAdminEmail(kvOrder, env), sendPaidTelegram(kvOrder, env)];
        if (eventTag === 'BINGO') notifs.push(sendBingoEmail(kvOrder, env));
        else notifs.push(sendPaidEmail(kvOrder, env));
        
        await Promise.allSettled(notifs);

        return jsonResponse({ checkoutUrl: successUrl });
    }

    // --- SHIPPING LOGIC ---
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

    // --- SAVE SESSION ID TO DB ---
    kvOrder.stripeSessionId = session.id;
    if (voucherCode && discountAmount > 0) kvOrder.usedVoucher = voucherCode;
    
    await env.ORDERS_KV.put(kvKey, JSON.stringify(kvOrder));

    return jsonResponse({ checkoutUrl: session.url });

  } catch (err) {
    console.error("Checkout Error:", err);
    return jsonResponse({ error: "Checkout failed" }, 500);
  }
}

// --- HELPER FUNCTIONS ---

function esc(str) { return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return res;
    } catch (err) { }
    if (i < retries - 1) await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

// Standard Email
async function sendPaidEmail(order, env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  if (!apiKey || !from || !order.email) return;

  const subject = "We’ve received your Magnetic Memories order";
  const html = `
    <div style="font-family: system-ui, sans-serif;">
      <h2>Thanks for your order!</h2>
      <p>We’ve received your payment and will start preparing your magnets shortly.</p>
      <p><strong>Order ID:</strong> ${order.orderId}</p>
      <p><a href="https://magnetic-memories.pages.dev/return.html?orderId=${encodeURIComponent(order.orderId)}">Track Order</a></p>
    </div>
  `;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [order.email], subject, html }),
  });
}

// Bingo Email
async function sendBingoEmail(order, env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  if (!apiKey || !from || !order.email) return;

  const subject = `Your Bonkers Bingo Order #${order.bingoNumber}`;
  const html = `
    <div style="font-family: system-ui, sans-serif; background-color: #0f172a; color: white; padding: 20px; border-radius: 10px;">
      <h2 style="color: #eb2f96;">ORDER #${order.bingoNumber} RECEIVED!</h2>
      <p>Thanks for ordering at Bonkers Bingo! 🎱</p>
      <p>We are printing your magnets right now. Keep an eye on the tracking page or listen for your number.</p>
      <p>
        <a href="https://magnetic-memories.pages.dev/bingo-return.html?orderId=${encodeURIComponent(order.orderId)}" 
           style="background-color: #1a9a8a; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">
           VIEW LIVE STATUS
        </a>
      </p>
    </div>
  `;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [order.email], subject, html }),
  });
}

// Admin Alert Email
async function sendAdminEmail(order, env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  const notifyRaw = env.NOTIFY_EMAIL || "";
  const recipients = notifyRaw.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);

  if (!apiKey || !from || recipients.length === 0) return;

  let title = `New Order ${order.orderId}`;
  if (order.event === 'BINGO') title = `🎱 BINGO ORDER #${order.bingoNumber}`;
  if (order.event === 'VALENTINES') title = `💘 VALENTINES ORDER`;
  if (order.event === 'MOTHERS_DAY') title = `🌸 MOTHER'S DAY ORDER`;
  if (order.event === 'FRAMES') title = `🖼️ FRAME ORDER`;

  const subject = `${title} - Paid`;
  const html = `
    <div style="font-family: system-ui, sans-serif;">
      <h2>${title}</h2>
      <p><strong>Customer:</strong> ${order.email}</p>
      <p><strong>Product:</strong> ${order.event === 'FRAMES' || order.productType === 'frames' ? 'Frame' : order.packSize + ' magnets'}</p>
      <p><a href="https://magnetic-memories.pages.dev/admin.html">Open Admin Dashboard</a></p>
    </div>
  `;

  await Promise.all(recipients.map(to => 
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
    })
  ));
}

// Telegram Alert
async function sendPaidTelegram(order, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatIdsRaw = env.TELEGRAM_CHAT_ID;
  if (!token || !chatIdsRaw) return;

  const chatIds = chatIdsRaw.split(",").map((id) => id.trim()).filter(Boolean);
  
  let header = "💳 <b>New Order</b>";
  if (order.event === 'BINGO') header = `🎱 <b>BINGO ORDER #${order.bingoNumber}</b>`;
  if (order.event === 'VALENTINES') header = `💘 <b>VALENTINES ORDER</b>`;
  if (order.event === 'MOTHERS_DAY') header = `🌸 <b>MOTHER'S DAY ORDER</b>`;
  if (order.event === 'FRAMES') header = `🖼️ <b>FRAME ORDER</b>`;

  const text = `${header}\nID: <code>${esc(order.orderId)}</code>\nEmail: ${esc(order.email)}`;

  const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;
  await Promise.all(chatIds.map(chatId =>
    fetchWithRetry(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    })
  ));
}