// functions/api/voucher-check.js
// POST /api/voucher-check { code: "ABC-123" }

export async function onRequestPost({ request, env }) {
  try {
    const { code } = await request.json();
    if (!code) return new Response("Missing code", { status: 400 });

    const cleanCode = code.trim().toUpperCase();
    const kvKey = `voucher:${cleanCode}`;
    
    const raw = await env.ORDERS_KV.get(kvKey);
    if (!raw) {
      return new Response(JSON.stringify({ valid: false, error: "Invalid code" }), { 
        headers: { "Content-Type": "application/json" }
      });
    }

    const voucher = JSON.parse(raw);

    if (voucher.redeemed) {
      return new Response(JSON.stringify({ valid: false, error: "Code already used" }), { 
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ 
      valid: true, 
      value: voucher.value,
      code: cleanCode 
    }), { headers: { "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Server error" }), { status: 500 });
  }
}