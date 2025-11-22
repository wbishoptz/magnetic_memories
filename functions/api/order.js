// functions/api/order.js
//
// POST /api/order
//   → Create a new order in KV and return { orderId }
//
// GET /api/order?orderId=... 
//   → Return full order JSON (used by return page)

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    console.error("Failed to parse order JSON body:", err);
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Be deliberately permissive so we don't break the frontend.
  // We only *gently* validate email & packSize if present.
  const email = body.email;
  const packSize = body.packSize ?? body.pack ?? null;

  if (!email || typeof email !== "string") {
    return new Response(
      JSON.stringify({ error: "Email is required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // packSize is nice to have, but don't block the order if something is weird.
  const safePackSize =
    typeof packSize === "number"
      ? packSize
      : parseInt(packSize, 10) || null;

  const createdAt = new Date().toISOString();
  const orderId = crypto.randomUUID();

  const order = {
    orderId,
    email,
    packSize: safePackSize,
    price: body.price ?? null,
    // Preserve whatever else the frontend sends (files, crops, etc.)
    ...body,
    orderId, // ensure our generated ID wins
    status: "checkout_created",
    createdAt,
    updatedAt: createdAt,
  };

  try {
    const kvKey = `order:${orderId}`;
    await env.ORDERS_KV.put(kvKey, JSON.stringify(order));

    return new Response(
      JSON.stringify({ orderId }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    console.error("Failed to save order to KV:", err);
    return new Response(
      JSON.stringify({ error: "Failed to create order" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const orderId = url.searchParams.get("orderId");

  if (!orderId) {
    return new Response(
      JSON.stringify({ error: "orderId is required" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const kvKey = `order:${orderId}`;

  try {
    const raw = await env.ORDERS_KV.get(kvKey);
    if (!raw) {
      return new Response(
        JSON.stringify({ error: "Order not found" }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response(raw, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Failed to read order from KV:", err);
    return new Response(
      JSON.stringify({ error: "Failed to load order" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
