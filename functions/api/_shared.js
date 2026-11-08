// Shared pricing, helpers, and notification functions used across API routes.

// ─── Pricing ───────────────────────────────────────────────────────────────

export const STANDARD_PACKS = [3, 6, 9, 12, 15];
export const STANDARD_PRICES = { 3: 7.95, 6: 14.95, 9: 20.95, 12: 25.95, 15: 30.95 };

// Large 65×90mm magnets (portrait/landscape/mix)
export const LARGE_MAGNET_PACKS = [3, 6, 9, 12, 15];
export const LARGE_MAGNET_PRICES = { 3: 9.95, 6: 17.95, 9: 25.95, 12: 33.95, 15: 35.95 };

export const BINGO_PACKS = [1, 3, 6, 12];
export const BINGO_PRICES = { 1: 4.95, 3: 10.95, 6: 20.95, 12: 35.95 };

export const VALENTINES_PACKS = [1, 2, 3, 4];
export const VALENTINES_PRICES = { 1: 13.45, 2: 25.95, 3: 30.95, 4: 35.95 };

export const FLEXI_PRICE = 13.45;

// Double-sided keyrings: 1 for £6.95, 2 for £10.95
export const KEYRING_PRICES = { 1: 6.95, 2: 10.95 };
export const keyringPrice = (qty) => KEYRING_PRICES[Number(qty) === 2 ? 2 : 1];

// Bottle-opener / mirror-keyring bundle: any 2 for £7.95
export const BUNDLE_PRICE = 7.95;

// Christmas colour-in ornaments (50x50 magnet in the middle): 1 / 2 / 3 / set of 4, any mix of designs
export const ORNAMENT_DESIGNS = { santa: 'Santa', tree: 'Christmas Tree', present: 'Wrapped Present', snowman: 'Snowman' };
export const ORNAMENT_PACKS = [1, 2, 3, 4];
export const ORNAMENT_PRICES = { 1: 8.50, 2: 16.00, 3: 22.50, 4: 30.00 };

// ['santa','snowman','santa'] -> "2× Santa, Snowman" (first-seen order; unknown keys skipped)
export function ornamentDesignsText(designs) {
  if (!Array.isArray(designs)) return "";
  const counts = new Map();
  for (const d of designs) {
    if (typeof d !== 'string' || !Object.hasOwn(ORNAMENT_DESIGNS, d)) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  return [...counts].map(([d, n]) => (n > 1 ? `${n}× ` : '') + ORNAMENT_DESIGNS[d]).join(', ');
}

// Letter from Santa: each letter comes with a Santa Cam magnet (£4.99), or with the Santa Cam
// set in a red / green / bronze hanging bauble instead (£6.99). 1-10 letters, any mix.
export const SANTA_LETTER_DESIGNS = { airmail: 'Airmail letter', merry: 'Merry Christmas letter' };
export const SANTA_BAUBLES = { red: 'Red', green: 'Green', bronze: 'Bronze' };
export const SANTA_LETTER_PRICE = 4.99;
export const SANTA_BAUBLE_PRICE = 6.99;
export const SANTA_LETTER_MAX = 10;

// One letter -> validated { design, bauble } (bauble null = loose Santa Cam magnet), or null
function santaLetterItem(item) {
  if (!item || typeof item !== 'object') return null;
  const { design, bauble } = item;
  if (typeof design !== 'string' || !Object.hasOwn(SANTA_LETTER_DESIGNS, design)) return null;
  if (bauble !== null && (typeof bauble !== 'string' || !Object.hasOwn(SANTA_BAUBLES, bauble))) return null;
  return { design, bauble };
}

// Validated copy of exactly n letters (n a whole number 1..SANTA_LETTER_MAX, repeats
// allowed, whitelisted keys only) - or null if anything about it is off
export function santaLetterItems(raw, n) {
  if (!Number.isInteger(n) || n < 1 || n > SANTA_LETTER_MAX) return null;
  if (!Array.isArray(raw) || raw.length !== n) return null;
  const items = [];
  for (const item of raw) {
    const ok = santaLetterItem(item);
    if (!ok) return null;
    items.push(ok);
  }
  return items;
}

// Total in £ for the letters (added up in pence so it never picks up float errors), or null
export function santaLetterTotal(items) {
  const letters = santaLetterItems(items, Array.isArray(items) ? items.length : 0);
  if (!letters) return null;
  const letterPence = Math.round(SANTA_LETTER_PRICE * 100);
  const baublePence = Math.round(SANTA_BAUBLE_PRICE * 100);
  let pence = 0;
  for (const l of letters) pence += l.bauble ? baublePence : letterPence;
  return pence / 100;
}

// [{airmail,null},{airmail,null},{merry,'green'}]
//   -> "2× Airmail letter + Santa Cam magnet, Merry Christmas letter + green bauble"
// (first-seen order; unknown entries skipped)
export function santaLetterText(items) {
  if (!Array.isArray(items)) return "";
  const counts = new Map();
  for (const item of items) {
    const ok = santaLetterItem(item);
    if (!ok) continue;
    const key = `${ok.design}|${ok.bauble || ''}`;
    const prev = counts.get(key);
    counts.set(key, { ...ok, n: prev ? prev.n + 1 : 1 });
  }
  return [...counts.values()].map(({ design, bauble, n }) => (n > 1 ? `${n}× ` : '')
    + SANTA_LETTER_DESIGNS[design]
    + (bauble ? ` + ${SANTA_BAUBLES[bauble].toLowerCase()} bauble` : ' + Santa Cam magnet')).join(', ');
}

// Photo bauble cards: a flat 3D-printed bauble with the customer's photo on a 50x50 magnet in
// its window (the same magnet as the ornament), mounted on a printed Christmas card.
// 1 / 2 / 3 for a whole-pack price; each bauble has its own colour, photo and card (any mix).
export const BAUBLE_CARD_COLOURS = { red: 'Red', sparkle_red: 'Sparkle Red', green: 'Green', silver: 'Silver', blue: 'Sparkle Blue' };
export const BAUBLE_CARD_CARDS = { berries: 'Berries & Bow', stripes: 'Green Stripes', wreath: 'Pine Wreath' };
export const BAUBLE_CARD_PACKS = [1, 2, 3];
export const BAUBLE_CARD_PRICES = { 1: 7.50, 2: 14.00, 3: 20.00 };

// One bauble -> validated { colour, card } (exactly those two keys, nothing else), or null
function baubleCardItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (Object.keys(item).length !== 2 || !Object.hasOwn(item, 'colour') || !Object.hasOwn(item, 'card')) return null;
  const { colour, card } = item;
  if (typeof colour !== 'string' || !Object.hasOwn(BAUBLE_CARD_COLOURS, colour)) return null;
  if (typeof card !== 'string' || !Object.hasOwn(BAUBLE_CARD_CARDS, card)) return null;
  return { colour, card };
}

// Validated copy of exactly n baubles (n one of BAUBLE_CARD_PACKS, repeats allowed,
// whitelisted keys only) - or null if anything about it is off
export function baubleCardItems(list, n) {
  if (!BAUBLE_CARD_PACKS.includes(n)) return null;
  if (!Array.isArray(list) || list.length !== n) return null;
  const items = [];
  for (const item of list) {
    const ok = baubleCardItem(item);
    if (!ok) return null;
    items.push(ok);
  }
  return items;
}

// [{red,wreath},{silver,stripes},{silver,stripes}]
//   -> "Red bauble · Pine Wreath card, 2× Silver bauble · Green Stripes card"
// (first-seen order; unknown entries skipped)
export function baubleCardText(items) {
  if (!Array.isArray(items)) return "";
  const counts = new Map();
  for (const item of items) {
    const ok = baubleCardItem(item);
    if (!ok) continue;
    const key = `${ok.colour}|${ok.card}`;
    const prev = counts.get(key);
    counts.set(key, { ...ok, n: prev ? prev.n + 1 : 1 });
  }
  return [...counts.values()].map(({ colour, card, n }) => (n > 1 ? `${n}× ` : '')
    + `${BAUBLE_CARD_COLOURS[colour]} bauble · ${BAUBLE_CARD_CARDS[card]} card`).join(', ');
}

export const MOTHERS_PACKAGES = {
  "Box 1": 13.45,
  "Box 2": 25.95,
  "Box 3": 30.95,
  "Box 4": 35.95,
  // Legacy names kept for backward compatibility
  "Bouquet Bloom": 13.45,
  "Garden Party": 25.95,
  "Full Bloom": 30.95,
  "Mum's Treasure": 35.95
};

export const FRAME_PRICES = {
  bohemian: {
    3: { frame: 8.95, full: 15.95 },
    4: { frame: 10.95, full: 17.95 },
    6: { frame: 12.95, full: 25.95 },
    9: { frame: 15.95, full: 30.95 },
  },
  sleek: {
    1: { frame: 5.95, full: 7.95 },
    2: { frame: 7.95, full: 12.95 },
    3: { frame: 8.95, full: 15.95 },
    4: { frame: 10.95, full: 17.95 },
  },
  rollercube: {
    4: { frame: 10.95, full: 17.95 }
  },
  rattan: {
    4: { frame: 15.95, full: 20.95 }
  },
  message: {
    6: { frame: 12.95, full: 25.95 }   // Message Frame: 6 slots + custom text
  }
};

// Percentage discount codes (site-wide sale codes). code → % off.
// Reusable (no balance), case-insensitive. Add/remove/edit here.
// (No active sale codes — SUN20 summer sale ended.)
export const PROMO_CODES = {};
export function promoPercent(code) {
  if (!code) return 0;
  return PROMO_CODES[String(code).trim().toUpperCase()] || 0;
}

export const VOUCHERS = {
  "voucher_14": { price: 14, label: "£14 Gift Voucher" },
  "voucher_20": { price: 20, label: "£20 Gift Voucher" },
  "voucher_25": { price: 25, label: "£25 Gift Voucher" },
  "voucher_30": { price: 30, label: "£30 Gift Voucher" }
};

// Price of a stored shop order, worked out again from the price lists above (same rules as
// order.js), or null if it isn't something the basket can sell. Basket checkout uses this
// instead of the stored price, which a stale or hand-made draft (e.g. /api/save-cart) could
// leave at £0. Staff MANUAL tickets are paid in person, and gift vouchers are only issued
// by the single-item checkout, so neither can be bought here.
export function shopPrice(order) {
  if (!order || order.event === 'MANUAL') return null;
  const packSize = order.packSize;
  if (typeof packSize === 'string' && packSize.startsWith('voucher_')) return null;
  const n = Number(packSize);
  const framePrice = () => {
    const p = FRAME_PRICES[order.frameStyle]?.[order.frameSize];
    return p ? (order.includeMagnets ? p.full : p.frame) : null;
  };
  let price = null;
  if (order.event === 'MOTHERS_DAY') {
    price = order.productType === 'frames' ? framePrice() : MOTHERS_PACKAGES[order.mothersPackage];
  } else if (order.event === 'FRAMES') {
    price = order.productType === 'flexi' ? FLEXI_PRICE : framePrice();
  } else if (order.event === 'VALENTINES') {
    price = order.productType === 'flexi' ? FLEXI_PRICE : (VALENTINES_PACKS.includes(n) ? VALENTINES_PRICES[n] : null);
  } else if (order.event === 'BINGO') {
    price = BINGO_PACKS.includes(n) ? BINGO_PRICES[n] : null;
  } else if (order.productType === 'keyring') {
    price = keyringPrice(n);
  } else if (order.productType === 'bundle') {
    price = BUNDLE_PRICE;
  } else if (order.productType === 'large_magnet') {
    price = LARGE_MAGNET_PACKS.includes(n) ? LARGE_MAGNET_PRICES[n] : null;
  } else if (order.productType === 'ornament') {
    price = ORNAMENT_PACKS.includes(n) ? ORNAMENT_PRICES[n] : null;
  } else if (order.productType === 'santa_letter') {
    // Worked out from the stored letters, which must still match the pack size
    price = santaLetterTotal(santaLetterItems(order.santaLetters, n));
  } else if (order.productType === 'bauble_card') {
    // Whole-pack price; the stored baubles must still match the pack size
    price = baubleCardItems(order.baubleCards, n) ? BAUBLE_CARD_PRICES[n] : null;
  } else {
    price = STANDARD_PACKS.includes(n) ? STANDARD_PRICES[n] : null;
  }
  return Number.isFinite(price) && price > 0 ? price : null;
}

// ─── Utilities ─────────────────────────────────────────────────────────────

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Staff access for the event page (event.html): "Authorization: Bearer <key>" with the admin
// key, or STAFF_KEY when that's set (a key helpers can use that opens nothing else).
export function isStaffRequest(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return !!key && ((!!env.ADMIN_KEY && key === env.ADMIN_KEY) || (!!env.STAFF_KEY && key === env.STAFF_KEY));
}

// Makes sure an earlier Stripe Checkout session can't be paid any more (its order is changing,
// or being checked out again). Returns 'expired' (can't be paid), 'complete' (it has already
// been paid) or null (Stripe couldn't say - the caller should refuse and let them retry).
export async function expireCheckoutSession(env, sessionId) {
  const url = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`;
  const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  try {
    const res = await fetch(`${url}/expire`, { method: "POST", headers });
    if (res.ok) return "expired";
    // Only open sessions can be expired: find out whether it's already expired or paid
    const check = await fetch(url, { headers });
    if (check.status === 404) return "expired"; // unknown to Stripe, so nothing can pay it
    if (check.ok) {
      const s = await check.json();
      if (s.status === "expired" || s.status === "complete") return s.status;
    }
  } catch (err) {
    console.error("Stripe session expire failed:", err);
  }
  return null;
}

// ─── Gift vouchers ─────────────────────────────────────────────────────────
// Stored as voucher:<CODE> (upper case, e.g. MM-ABCD) = { value, balance, redeemed, ... }.

const pounds = (n) => Math.round(Number(n) * 100) / 100;

// The code as it's stored, whatever the customer typed ('' when there's none)
export function cleanVoucherCode(code) {
  return code == null ? '' : String(code).trim().toUpperCase();
}

// What's left to spend (a legacy voucher without a balance is worth its value)
export function voucherBalance(voucher) {
  if (!voucher || voucher.redeemed) return 0;
  const b = typeof voucher.balance === 'number' ? voucher.balance : Number(voucher.value);
  return Number.isFinite(b) && b > 0 ? pounds(b) : 0;
}

// A Stripe checkout that takes money off a gift voucher leaves a hold,
// voucherhold:<CODE>:<sessionId>, until the webhook takes the amount off the balance.
// A voucher pays for one checkout at a time: before it's used again, every other
// checkout still holding it is expired (so two open checkouts can't both spend it).
// The hold outlives Stripe's 24h sessions and its 3 days of webhook retries.
const HOLD_TTL = 60 * 60 * 24 * 5;
const holdPrefix = (code) => `voucherhold:${code}:`;
export const voucherHoldKey = (code, sessionId) => holdPrefix(code) + sessionId;

export async function holdVoucher(env, code, sessionId, amount, orderIds) {
  try {
    await env.ORDERS_KV.put(voucherHoldKey(code, sessionId),
      JSON.stringify({ code, sessionId, amount, orderIds, at: new Date().toISOString() }),
      { expirationTtl: HOLD_TTL, metadata: { amount } });
  } catch (err) {
    console.error("Voucher hold failed:", code, sessionId, err);
  }
}

// Frees a voucher for a new checkout by expiring the other checkouts holding it. Returns
// the amount still owed by ones that were paid but haven't reached the webhook yet (to
// keep off the balance), or null if Stripe couldn't say (refuse, and let them retry).
export async function releaseVoucherHolds(env, code, voucher) {
  const settled = new Set((voucher?.redemptions || []).map(r => r.sessionId).filter(Boolean));
  let pending = 0;
  let cursor;
  do {
    const list = await env.ORDERS_KV.list({ prefix: holdPrefix(code), cursor });
    for (const k of list.keys) {
      const sessionId = k.name.slice(holdPrefix(code).length);
      const result = settled.has(sessionId) ? 'settled' : await expireCheckoutSession(env, sessionId);
      if (result === 'complete') pending += Number(k.metadata?.amount) || 0;
      else if (result) await env.ORDERS_KV.delete(k.name); // expired, or already taken off
      else return null;
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return pounds(pending);
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
  if (order.productType === 'large_magnet') return `🧲 ${order.packSize} Large Magnets (65×90mm)`;
  if (order.productType === 'keyring') return '🔑 Double-Sided Keyring';
  if (order.productType === 'ornament') {
    const n = Number(order.packSize);
    const designs = ornamentDesignsText(order.ornamentDesigns);
    return `🎄 ${esc(String(order.packSize))} Christmas Colour-In Ornament${n === 1 ? '' : 's'}${designs ? ` — ${esc(designs)}` : ''}`;
  }
  if (order.productType === 'santa_letter') {
    const n = Number(order.packSize);
    const letters = santaLetterText(order.santaLetters);
    return `🎅 ${esc(String(order.packSize))} Letter${n === 1 ? '' : 's'} from Santa${letters ? ` — ${esc(letters)}` : ''}`;
  }
  if (order.productType === 'bauble_card') {
    const n = Number(order.packSize);
    const cards = baubleCardText(order.baubleCards);
    return `🎄 ${esc(String(order.packSize))} Photo Bauble Card${n === 1 ? '' : 's'}${cards ? ` — ${esc(cards)}` : ''}`;
  }
  if (order.generatedVoucher) return `🎁 Voucher Purchase (£${order.voucherValue})`;
  if (order.productType === 'frame' || order.productType === 'frames' || order.frameStyle) {
    const style = (order.frameStyle || '').charAt(0).toUpperCase() + (order.frameStyle || '').slice(1);
    const slots = order.frameSize ? ` (${order.frameSize} slots)` : '';
    const txt = order.customText ? ` — “${order.customText}”` : '';
    return `🖼️ ${style} Frame${slots}${txt}`;
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
  else if (order.productType === 'ornament') title = `🎄 ORNAMENT ORDER`;
  else if (order.productType === 'santa_letter') title = `🎅 SANTA LETTER ORDER`;
  else if (order.productType === 'bauble_card') title = `🎄 BAUBLE CARD ORDER`;
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

// Plain-text Telegram alert to every configured chat (TELEGRAM_CHAT_ID may be a
// comma-separated list). Sent WITHOUT parse_mode, so no escaping is needed.
// -> true when at least one chat accepted it.
export async function sendTelegramText(text, env) {
  const token = env && env.TELEGRAM_BOT_TOKEN;
  const chatIdsRaw = env && env.TELEGRAM_CHAT_ID;
  if (!token || !chatIdsRaw) return false;

  const chatIds = String(chatIdsRaw).split(",").map(id => id.trim()).filter(Boolean);
  if (!chatIds.length) return false;

  const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;
  const results = await Promise.all(chatIds.map(chatId =>
    fetchWithRetry(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: String(text) }),
    }).catch(() => null)
  ));
  return results.some(r => r && r.ok);
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
  else if (order.productType === 'ornament') header = `🎄 <b>ORNAMENT ORDER</b>`;
  else if (order.productType === 'santa_letter') header = `🎅 <b>SANTA LETTER ORDER</b>`;
  else if (order.productType === 'bauble_card') header = `🎄 <b>BAUBLE CARD ORDER</b>`;
  else if (order.event === 'BINGO') header = `🎱 <b>BINGO ORDER #${order.bingoNumber}</b>`;
  else if (order.event === 'VALENTINES') header = `💘 <b>VALENTINES ORDER</b>`;
  else if (order.event === 'MOTHERS_DAY') header = `🌸 <b>MOTHER'S DAY ORDER</b>`;
  else if (order.event === 'FRAMES') header = `🖼️ <b>FRAME ORDER</b>`;

  let packLine = `Pack: ${esc(String(order.packSize))} items`;
  if (order.productType === 'keyring') packLine = `Product: 🔑 Double-Sided Keyring`;
  if (order.productType === 'ornament') {
    const designs = ornamentDesignsText(order.ornamentDesigns);
    packLine = `Product: 🎄 ${esc(String(order.packSize))}× Colour-In Ornament${designs ? ` — ${esc(designs)}` : ''}`;
  }
  if (order.productType === 'santa_letter') {
    const letters = santaLetterText(order.santaLetters);
    packLine = `Product: 🎅 ${esc(String(order.packSize))}× Letter from Santa${letters ? ` — ${esc(letters)}` : ''}`;
  }
  if (order.productType === 'bauble_card') {
    // One line per bauble, numbered like its photo (bauble1-…, "B1" on the print sheet)
    const cards = Array.isArray(order.baubleCards) ? order.baubleCards : [];
    const list = cards.map((b, i) => {
      const text = baubleCardText([b]);
      return text ? `B${i + 1}: ${esc(text)}` : null;
    }).filter(Boolean);
    packLine = `Product: 🎄 ${esc(String(order.packSize))}× Photo Bauble Card${list.length ? '\n' + list.join('\n') : ''}`;
  }
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
