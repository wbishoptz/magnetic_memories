// functions/api/order.js

const PACK_PRICES = {
  3: 7,
  6: 14,
  9: 20,
  12: 25,
  15: 30,
};

function withDerivedPrice(order) {
  if (!order) return order;
  if (order.price != null) return order;

  const packSize = Number(order.packSize);
  const derived = PACK_PRICES[packSize];

  return {
    ...order,
    price: derived != null ? derived : null,
  };
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const orderId =
      url.searchParams.get("id") || url.searchParams.get("orderId");

    if (!orderId) {
      return new Response(
        JSON.stringify({ error: "Missing orderId in query string" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const order = await env.ORDERS_KV.get(orderId, "json");

    if (!order) {
      return new Response(JSON.stringify({ error: "Order not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const enriched = withDerivedPrice(order);

    return new Response(JSON.stringify(enriched), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.error("order API error", err);
    return new Response(JSON.stringify({ error: "Failed to load order" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
