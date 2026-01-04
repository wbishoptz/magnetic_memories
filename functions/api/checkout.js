// functions/api/checkout.js

const STANDARD_PACKS = [3, 6, 9, 12, 15];
const STANDARD_PRICES = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };

const BINGO_PRICES = { 1: 3.5, 3: 10, 6: 20, 12: 35 };

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
    const targetCountry = body?.country || "GI_COLLECT"; 
    const voucherCode = body?.voucherCode; 

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

    // --- DETERMINE PRODUCT & PRICE ---
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
    } else {
        let size = Number(packSizeRaw);
        
        // CHECK IF BINGO OR STANDARD
        const isBingo = (kvOrder?.event === 'BINGO');
        
        if (isBingo) {
            price = BINGO_PRICES[size] || 20; // Default fallback to 6 pack price if error
        } else {
            // Standard Validation
            if (!STANDARD_PACKS.includes(size)) size = 3;
            price = STANDARD_PRICES[size];
        }
        
        let type = kvOrder?.packType || body?.packType || "standard";
        productName = `${size} custom photo magnets`;
        productDesc = "50×50mm fridge magnets";
        if (type === 'big_picture') {
            productName = `Jigsaw Picture (${size} magnets)`;
            productDesc = "One large photo split across magnets.";
        }
    }

    // --- INJECT BINGO ORDER NUMBER ---
    const isBingo = (kvOrder?.event === 'BINGO');
    if (isBingo && kvOrder?.bingoNumber) {
        productName = `Order #${kvOrder.bingoNumber} - ${productName}`;
    }

    // Determine Success URL based on event
    const successPage = isBingo ? "bingo-return.html" : "return.html";
    const successUrl = `https://magnetic-memories.pages.dev/${successPage}?status=success&orderId=${encodeURIComponent(orderId)}`;
    const cancelUrl = `https://magnetic-memories.pages.dev/return.html?status=cancel&orderId=${encodeURIComponent(orderId)}`;

    // --- DISCOUNT LOGIC ---
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
                const deduction = Math.min(price, currentBalance);
                discountAmount = deduction;
                finalPrice = Math.max(0, price - discountAmount);
            }
        }
    }

    // --- STRIPE SESSION ---
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", successUrl);
    params.append("cancel_url", cancelUrl);
    if (kvOrder?.email) params.append("customer_email", kvOrder.email);
    params.append("metadata[orderId]", orderId);
    if (isBingo) params.append("metadata[event]", "BINGO"); 
    
    if (isVoucherPurchase) {
        params.append("metadata[isVoucher]", "true");
        params.append("metadata[voucherValue]", String(price));
    }
    
    if (voucherCode && discountAmount > 0) {
        params.append("metadata[usedVoucher]", voucherCode);
    }

    params.append("line_items[0][quantity]", "1");
    params.append("line_items[0][price_data][currency]", "gbp");
    params.append("line_items[0][price_data][product_data][name]", productName);
    params.append("line_items[0][price_data][product_data][description]", productDesc);
    params.append("line_items[0][price_data][unit_amount]", String(price * 100)); 

    // --- 100% DISCOUNT HANDLING ---
    if (voucherCode && discountAmount > 0) {
        if (finalPrice === 0) {
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

            const notifs = [
                sendAdminEmail(kvOrder, env),
                sendPaidTelegram(kvOrder, env),
                isBingo ? sendBingoEmail(kvOrder, env) : sendPaidEmail(kvOrder, env)
            ];
            await Promise.allSettled(notifs);

            return jsonResponse({ checkoutUrl: successUrl });
        } else {
            params.set("line_items[0][price_data][unit_amount]", String(finalPrice * 100));
            params.set("line_items[0][price_data][product_data][description]", `${productDesc} (Voucher ${voucherCode}: -£${discountAmount})`);
        }
    }

    // --- SHIPPING LOGIC ---
    if (!isVoucherPurchase) {
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

// --- HELPERS ---

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

// STANDARD EMAIL
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

// BINGO SPECIFIC EMAIL
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

async function sendAdminEmail(order, env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  const notifyRaw = env.NOTIFY_EMAIL || "";
  const recipients = notifyRaw.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);

  if (!apiKey || !from || recipients.length === 0) return;

  const title = order.event === 'BINGO' ? `🎱 BINGO ORDER #${order.bingoNumber}` : `New Order ${order.orderId}`;
  
  const subject = `${title} - Paid`;
  const html = `
    <div style="font-family: system-ui, sans-serif;">
      <h2>${title}</h2>
      <p><strong>Customer:</strong> ${order.email}</p>
      <p><strong>Pack:</strong> ${order.packSize} magnets</p>
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

async function sendPaidTelegram(order, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatIdsRaw = env.TELEGRAM_CHAT_ID;
  if (!token || !chatIdsRaw) return;

  const chatIds = chatIdsRaw.split(",").map((id) => id.trim()).filter(Boolean);
  
  // Custom Bingo Alert
  let header = "💳 <b>New Order</b>";
  let details = `ID: <code>${esc(order.orderId)}</code>`;
  
  if (order.event === 'BINGO') {
      header = `🎱 <b>BINGO ORDER #${order.bingoNumber}</b>`;
      details = `Pack: ${order.packSize} magnets`;
  }

  const text = `${header}\n${details}\nEmail: ${esc(order.email)}`;

  const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;
  await Promise.all(chatIds.map(chatId =>
    fetchWithRetry(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    })
  ));
}