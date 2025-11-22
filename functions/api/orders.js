// functions/api/orders.js

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

export async function onRequestGet({ env }) {
  try {
    const { keys } = await env.ORDERS_KV.list();

    const orders = [];
    for (const { name } of keys) {
      const data = await env.ORDERS_KV.get(name, "json");
      if (!data) continue;
      orders.push(withDerivedPrice(data));
    }

    // Newest first
    orders.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });

    return new Response(JSON.stringify({ orders }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.error("orders API error", err);
    return new Response(JSON.stringify({ error: "Failed to load orders" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
