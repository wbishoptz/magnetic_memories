// functions/api/admin-orders.js
// GET /api/admin-orders?key=...
// Summaries carry the guest paid-extras fields. Money is always GBP:
// extrasAmount (paid), extrasTotal (the order's snapshot), extraPrice (per
// extra), refundNeeded { amount, reason, at } | null.
import { orderSessionIds, round2 } from './_guest.js';

const gbp = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : round2(v));

function refundSummary(r) {
  if (!r || typeof r !== 'object') return null;
  return { amount: gbp(r.amount), reason: r.reason || null, at: r.at || null };
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const targetId = url.searchParams.get("orderId");
  const key = request.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("key");

  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  // Case 1: Get Single Order Details (Full Object)
  if (targetId) {
    const raw = await env.ORDERS_KV.get(`order:${targetId}`);
    if (!raw) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    return new Response(JSON.stringify({ order: JSON.parse(raw) }));
  }

  // Case 2: List All Orders (Summary)
  try {
    const list = await env.ORDERS_KV.list({ prefix: "order:" });
    
    // Fetch all values in parallel
    const values = await Promise.all(list.keys.map(k => env.ORDERS_KV.get(k.name)));

    const orders = values
      .map(v => {
        try {
          const o = JSON.parse(v);
          return {
            orderId: o.orderId,
            email: o.email,
            phone: o.phone,
            status: o.status,
            createdAt: o.createdAt,
            packSize: o.packSize,
            packType: o.packType || 'standard',
            productType: o.productType,
            frameStyle: o.frameStyle,
            frameSize: o.frameSize,
            mothersPackage: o.mothersPackage,
            event: o.event,
            eventId: o.eventId,
            raffleNumber: o.raffleNumber,
            source: o.source,
            completedAt: o.completedAt,
            // Guest paid extra magnets (amounts in GBP)
            freeCount: o.freeCount,
            extrasCount: o.extrasCount,
            extraPrice: o.extraPrice === undefined ? undefined : gbp(o.extraPrice),
            extrasTotal: o.extrasTotal === undefined ? undefined : gbp(o.extrasTotal),
            extrasPaid: o.extrasPaid === true,
            extrasAmount: o.extrasAmount === undefined ? undefined : gbp(o.extrasAmount),
            extrasSkipped: o.extrasSkipped === true,
            extrasStarted: orderSessionIds(o).length > 0,
            fullAfterPayment: o.fullAfterPayment === true || undefined,
            refundNeeded: refundSummary(o.refundNeeded),
            extrasRefunded: o.extrasRefunded === true,
            bingoNumber: o.bingoNumber,
            stripeSessionId: o.stripeSessionId,
            price: o.price,
            wasRecovered: o.wasRecovered,
            usedVoucher: o.usedVoucher,
            // NEW: Pass this flag so Admin knows if email was sent
            recoverySent: o.recoverySent || (o.status === 'abandoned') 
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return new Response(JSON.stringify({ orders }));
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}