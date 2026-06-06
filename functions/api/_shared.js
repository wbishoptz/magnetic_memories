// Shared pricing, helpers, and notification functions used across API routes.

// ─── Pricing ───────────────────────────────────────────────────────────────

export const STANDARD_PACKS = [3, 6, 9, 12, 15];
export const STANDARD_PRICES = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };

export const BINGO_PACKS = [1, 3, 6, 12];
export const BINGO_PRICES = { 1: 4.00, 3: 10, 6: 20, 12: 35 };

export const VALENTINES_PACKS = [1, 2, 3, 4];
export const VALENTINES_PRICES = { 1: 12.50, 2: 25.00, 3: 30.00, 4: 35.00 };

export const FLEXI_PRICE = 12.50;

// Double-sided keyrings: 1 for £6, 2 for £10
export const KEYRING_PRICES = { 1: 6.00, 2: 10.00 };
export const keyringPrice = (qty) => KEYRING_PRICES[Number(qty) === 2 ? 2 : 1];

// Bottle-opener / mirror-keyring bundle: any 2 for £7
export const BUNDLE_PRICE = 7.00;

export const MOTHERS_PACKAGES = {
  "Box 1": 12.50,
  "Box 2": 25.00,
  "Box 3": 30.00,
  "Box 4": 35.00,
  // Legacy names kept for backward compatibility
  "Bouquet Bloom": 12.50,
  "Garden Party": 25.00,
  "Full Bloom": 30.00,
  "Mum's Treasure": 35.00
};

export const FRAME_PRICES = {
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
  },
  rattan: {
    4: { frame: 15, full: 20 }
  }
};

export const VOUCHERS = {
  "voucher_14": { price: 14, label: "£14 Gift Voucher" },
  "voucher_20": { price: 20, label: "£20 Gift Voucher" },
  "voucher_25": { price: 25, label: "£25 Gift Voucher" },
  "voucher_30": { price: 30, label: "£30 Gift Voucher" }
};

// ─── Utilities ─────────────────────────────────────────────────────────────

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return res;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) return res;
    } catch (err) {
      console.error(`Fetch attempt ${i + 1} failed:`, err);
    }
    if (i < retries - 1) await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

// ─── Stripe webhook signature verification ────────────────────────────────

export async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = {};
  sigHeader.split(',').forEach(p => {
    const [k, v] = p.split('=');
    if (k && v) parts[k] = v;
  });
  const { t, v1 } = parts;
  if (!t || !v1) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const payload = encoder.encode(`${t}.${rawBody}`);
  const sig = await crypto.subtle.sign('HMAC', key, payload);
  const computed = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return computed === v1;
}

// ─── Notifications ─────────────────────────────────────────────────────────

function buildTotalText(order) {
  if (typeof order.price === "number") return "£" + order.price.toFixed(2);
  return "£" + (order.price ?? "");
}

function buildProductLabel(order) {
  if (order.productType === 'keyring') return '🔑 Double-Sided Keyring';
  if (order.generatedVoucher) return `🎁 Voucher Purchase (£${order.voucherValue})`;
  if (order.productType === 'frame' || order.productType === 'frames' || order.frameStyle) {
    const style = (order.frameStyle || '').charAt(0).toUpperCase() + (order.frameStyle || '').slice(1);
    const slots = order.frameSize ? ` (${order.frameSize} slots)` : '';
    return `🖼️ ${style} Frame${slots}`;
  }
  return `${order.packSize} items (${order.packType || 'standard'})`;
}

export async function sendPaidEmail(order, env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  if (!apiKey || !from || !order.email) return;

  const totalText = buildTotalText(order);
  const productLabel = buildProductLabel(order);

  const html = `
    <div style="font-family: system-ui, sans-serif;">
      <h2>Thanks for your order!</h2>
      <p>We've received your payment and will start preparing your order shortly.</p>
      <p>
        <strong>Order ID:</strong> ${order.orderId}<br/>
        <strong>Product:</strong> ${productLabel}<br/>
        <strong>Total:</strong> ${totalText}
      </p>
      <p>Track your order here:<br/>
        <a href="https://magnetic-memories.pages.dev/return.html?orderId=${encodeURIComponent(order.orderId)}">Track Order</a>
      </p>
      <p>— Magnetic Memories</p>
    </div>
  `;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [order.email], subject: "We've received your Magnetic Memories order", html }),
  });
}

export async function sendBingoEmail(order, env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  if (!apiKey || !from || !order.email) return;

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
    body: JSON.stringify({ from, to: [order.email], subject: `Your Bonkers Bingo Order #${order.bingoNumber}`, html }),
  });
}

export async function sendVoucherEmail(email, code, value, env) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey || !email) return;

  const html = `
    <div style="font-family:sans-serif; text-align:center; padding:20px; color:#333;">
      <h1 style="color:#333;">🎁 Here is your Gift Voucher!</h1>
      <p>Thank you for purchasing a Magnetic Memories voucher.</p>
      <div style="background:#f4f4f4; padding:24px; border-radius:12px; margin:24px 0; border:2px dashed #ccc;">
        <h2 style="color:#59c9a5; font-size:32px; margin:0; letter-spacing:1px;">${code}</h2>
        <p style="margin-top:8px; font-weight:bold; color:#555;">Value: £${value}</p>
      </div>
      <p>To use this, simply enter the code at checkout on our website.</p>
      <p><a href="https://magnetic-memories.pages.dev">Visit Store</a></p>
    </div>
  `;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [email], subject: "Your Gift Voucher Code 🎁", html }),
  });
}

export async function sendAdminEmail(order, env) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  const notifyRaw = env.NOTIFY_EMAIL || "";
  const recipients = notifyRaw.split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);
  if (!apiKey || !from || recipients.length === 0) return;

  let title = `New Order ${order.orderId}`;
  if (order.productType === 'keyring') title = `🔑 KEYRING ORDER`;
  else if (order.event === 'BINGO') title = `🎱 BINGO ORDER #${order.bingoNumber}`;
  else if (order.event === 'VALENTINES') title = `💘 VALENTINES ORDER`;
  else if (order.event === 'MOTHERS_DAY') title = `🌸 MOTHER'S DAY ORDER`;
  else if (order.event === 'FRAMES') title = `🖼️ FRAME ORDER`;

  const packLabel = buildProductLabel(order);
  const totalText = buildTotalText(order);
  const customerEmail = order.email || order.customer?.email || "Unknown";
  const customerPhone = order.phone || "No phone";

  const html = `
    <div style="font-family: system-ui, sans-serif;">
      <h2>${title}</h2>
      <p>
        <strong>Order ID:</strong> ${order.orderId}<br/>
        <strong>Status:</strong> ${order.status}<br/>
        <strong>Customer:</strong> ${customerEmail}<br/>
        <strong>Phone:</strong> ${customerPhone}<br/>
        <strong>Item:</strong> ${packLabel}<br/>
        <strong>Total:</strong> ${totalText}
      </p>
      <p><a href="https://magnetic-memories.pages.dev/admin.html">Open Admin Dashboard</a></p>
    </div>
  `;

  await Promise.all(recipients.map(to =>
    fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject: `${title} - Paid`, html }),
    })
  ));
}

export async function sendPaidTelegram(order, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatIdsRaw = env.TELEGRAM_CHAT_ID;
  if (!token || !chatIdsRaw) return;

  const chatIds = chatIdsRaw.split(",").map(id => id.trim()).filter(Boolean);
  if (!chatIds.length) return;

  const total = typeof order.price === "number" ? `£${order.price.toFixed(2)}` : "Paid";

  let header = "💳 <b>New paid order</b>";
  if (order.productType === 'keyring') header = `🔑 <b>KEYRING ORDER</b>`;
  else if (order.event === 'BINGO') header = `🎱 <b>BINGO ORDER #${order.bingoNumber}</b>`;
  else if (order.event === 'VALENTINES') header = `💘 <b>VALENTINES ORDER</b>`;
  else if (order.event === 'MOTHERS_DAY') header = `🌸 <b>MOTHER'S DAY ORDER</b>`;
  else if (order.event === 'FRAMES') header = `🖼️ <b>FRAME ORDER</b>`;

  let packLine = `Pack: ${esc(String(order.packSize))} items`;
  if (order.productType === 'keyring') packLine = `Product: 🔑 Double-Sided Keyring`;
  if (order.productType === 'frame' || order.productType === 'frames' || order.frameStyle) {
    const style = (order.frameStyle || '').charAt(0).toUpperCase() + (order.frameStyle || '').slice(1);
    packLine = `Product: 🖼️ ${esc(style)} Frame (${esc(String(order.frameSize || '?'))} slots)`;
  }
  if (order.packType === 'big_picture') packLine += ' (🧩 Jigsaw)';
  if (order.generatedVoucher) packLine = `🎁 <b>Voucher Purchase</b> (£${order.voucherValue})`;

  const lines = [
    header,
    `ID: <code>${esc(order.orderId)}</code>`,
    `Email: ${esc(order.email || "Unknown")}`,
    `Phone: ${esc(order.phone || "No phone")}`,
    packLine,
    `Total: ${esc(total)}`
  ];

  const text = lines.join("\n");
  const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;

  await Promise.all(chatIds.map(chatId =>
    fetchWithRetry(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    })
  ));
}
