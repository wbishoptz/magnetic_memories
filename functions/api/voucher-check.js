// functions/api/voucher-check.js
// POST /api/voucher-check { code: "ABC-123" }

import { promoPercent } from './_shared.js';

export async function onRequestPost({ request, env }) {
  try {
    const { code } = await request.json();
    if (!code) return new Response("Missing code", { status: 400 });

    const cleanCode = code.trim().toUpperCase();

    // Percentage sale code (e.g. SUN20) — reusable, no stored balance
    const pct = promoPercent(cleanCode);
    if (pct > 0) {
      return new Response(JSON.stringify({ valid: true, percent: pct, code: cleanCode, promo: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    const kvKey = `voucher:${cleanCode}`;
    
    const raw = await env.ORDERS_KV.get(kvKey);
    if (!raw) {
      return new Response(JSON.stringify({ valid: false, error: "Invalid code" }), { 
        headers: { "Content-Type": "application/json" }
      });
    }

    const voucher = JSON.parse(raw);

    // LOGIC CHANGE: Handle Balance
    // If 'balance' is undefined, we assume it equals 'value' (legacy support)
    const currentBalance = (typeof voucher.balance === 'number') ? voucher.balance : voucher.value;

    if (voucher.redeemed || currentBalance <= 0) {
      return new Response(JSON.stringify({ valid: false, error: "Code fully redeemed" }), { 
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ 
      valid: true, 
      value: currentBalance, // Return the remaining balance, not the original value
      code: cleanCode 
    }), { headers: { "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Server error" }), { status: 500 });
  }
}