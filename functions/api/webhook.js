// functions/api/webhook.js
// POST /api/webhook
// Verifies Stripe signature and marks orders as paid on checkout.session.completed

export const onRequestPost = async ({ request, env }) => {
  try {
    const sig = request.headers.get("stripe-signature");
    const whSecret = env.STRIPE_WEBHOOK_SECRET;

    if (!sig || !whSecret) {
      return new Response("Missing Stripe signature or secret", { status: 400 });
    }

    const rawBody = await request.text();
    const valid = await verifyStripeSignatureAsync(rawBody, sig, whSecret);

    if (!valid) {
      console.warn("Invalid Stripe signature");
      return new Response("Invalid signature", { status: 400 });
    }

    const event = JSON.parse(rawBody);

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      let orderId = null;
      try {
        const successUrl = session.success_url || "";
        const u = new URL(successUrl);
        orderId = u.searchParams.get("orderId");
      } catch (e) {
        console.error("Failed to parse success_url", e);
      }

      if (orderId) {
        const ordersKV = env.ORDERS_KV; // use your binding name
        if (ordersKV) {
          const raw = await ordersKV.get(orderId);
          if (raw) {
            const order = JSON.parse(raw);
            order.status = "paid";
            order.stripeSessionId = session.id;
            order.stripePaymentIntentId = session.payment_intent || null;

            await ordersKV.put(orderId, JSON.stringify(order), {
              expirationTtl: 60 * 60 * 24 * 30,
            });

            console.log("Order marked paid:", orderId);
          } else {
            console.warn("Order not found for webhook:", orderId);
          }
        } else {
          console.error("ORDERS_KV binding missing in webhook");
        }
      } else {
        console.warn("No orderId found in success_url");
      }
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("Webhook error:", err);
    return new Response("Webhook handler failed", { status: 500 });
  }
};

// ---------- Stripe signature verification (async, Workers-safe) ----------

async function verifyStripeSignatureAsync(payload, header, secret) {
  // header example: "t=1698770206,v1=abcdef...,v1=..."
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k.trim(), v];
    })
  );

  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(signedPayload)
  );

  const actual = toHex(new Uint8Array(signature));
  return timingSafeEqual(actual, v1);
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}
