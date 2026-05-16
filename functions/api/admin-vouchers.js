// functions/api/admin-vouchers.js
// GET /api/admin-vouchers?key=ADMIN_KEY
// Lists all vouchers or searches for a specific one.

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const search = url.searchParams.get("search");
  const key = request.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("key");

  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  try {
    // 2. List Vouchers (Prefix "voucher:")
    // Note: KV list limit is 1000 by default. If you have more, you'd need pagination.
    const list = await env.ORDERS_KV.list({ prefix: "voucher:" });
    
    // 3. Fetch details in parallel
    const values = await Promise.all(list.keys.map(k => env.ORDERS_KV.get(k.name)));

    const vouchers = values
      .map(v => {
        try {
          const d = JSON.parse(v);
          
          // --- LOGIC FIX START ---
          // 1. Calculate balance (default to value if missing)
          let currentBalance = (typeof d.balance === 'number') ? d.balance : d.value;
          
          // 2. If the old 'redeemed' flag is true, force balance to 0
          // This fixes the issue where legacy vouchers showed full balance.
          if (d.redeemed) {
            currentBalance = 0;
          }
          // --- LOGIC FIX END ---
          
          return {
            code: d.code,
            value: d.value,
            balance: currentBalance,
            redeemed: d.redeemed || (currentBalance <= 0),
            createdAt: d.createdAt,
            purchasedBy: d.purchasedBy,
            orderId: d.orderId // The order that bought this voucher
          };
        } catch { return null; }
      })
      .filter(Boolean)
      // Sort: Most recently created first
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // 4. Optional Search Filter
    let result = vouchers;
    if (search) {
        const q = search.trim().toUpperCase();
        result = vouchers.filter(v => v.code && v.code.includes(q));
    }

    return new Response(JSON.stringify({ vouchers: result }));
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}