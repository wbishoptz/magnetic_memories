import {
  STANDARD_PACKS, STANDARD_PRICES,
  BINGO_PACKS, BINGO_PRICES,
  VALENTINES_PACKS, VALENTINES_PRICES,
  FLEXI_PRICE, MOTHERS_PACKAGES, FRAME_PRICES,
  keyringPrice, BUNDLE_PRICE,
  LARGE_MAGNET_PACKS, LARGE_MAGNET_PRICES,
  jsonResponse
} from './_shared.js';

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json().catch(() => null);

    const email = String(body?.email || "").trim();
    const phone = String(body?.phone || "").trim();
    const packSizeRaw = body?.packSize;
    const packType = body?.packType || 'standard';
    const eventTag = body?.event || null;

    const productType = body?.productType || 'standard';
    const flexiColor = body?.flexiColor || null;
    const premadeSelections = body?.premadeSelections || [];

    const raffleNumber = body?.raffleNumber || null;
    const eventId = body?.eventId || null;
    const manualStatus = body?.status || "draft";

    // Event ticket: block duplicate raffle numbers within the same event
    if (eventTag === 'MANUAL' && eventId && raffleNumber != null && !body?.orderId) {
      const ticketKey = `event:ticket:${eventId}:${raffleNumber}`;
      const taken = await env.ORDERS_KV.get(ticketKey);
      if (taken) {
        return jsonResponse({ error: `Ticket #${raffleNumber} is already used for this event.` }, 409);
      }
    }

    const frameStyle = body?.frameStyle;
    const frameSize = body?.frameSize;
    const frameColor = body?.frameColor;
    const includeMagnets = body?.includeMagnets;
    const bandColor = body?.bandColor;

    // Message Frame personalisation (text hard-capped at 20 chars server-side)
    const customText = body?.customText != null ? String(body.customText).trim().slice(0, 20) : undefined;
    const borderColor = body?.borderColor;
    const bodyColor = body?.bodyColor;
    const textColor = body?.textColor;

    const mothersPackage = body?.mothersPackage;

    const isBasketDraft = body?.basketDraft === true;
    // Basket drafts skip email validation — real email is added at basket checkout time
    if (!isBasketDraft && !/\S+@\S+\.\S+/.test(email)) {
      return jsonResponse({ error: "Invalid email." }, 400);
    }

    // Voucher orders: keep packSizeRaw as a string, don't convert to Number
    const isVoucher = typeof packSizeRaw === 'string' && packSizeRaw.startsWith("voucher_");
    const packSize = isVoucher ? packSizeRaw : Number(packSizeRaw);

    let price = 0;

    if (eventTag === 'MANUAL') {
      price = 0;
    } else if (isVoucher) {
      price = 0;
    } else if (eventTag === 'MOTHERS_DAY') {
      if (productType === 'frames') {
        const styleData = FRAME_PRICES[frameStyle];
        const sizeData = styleData ? styleData[frameSize] : null;
        if (!sizeData) return jsonResponse({ error: "Invalid frame configuration." }, 400);
        price = includeMagnets ? sizeData.full : sizeData.frame;
      } else {
        price = MOTHERS_PACKAGES[mothersPackage] || 0;
      }
    } else if (eventTag === 'FRAMES') {
      if (productType === 'flexi') {
        price = FLEXI_PRICE;
      } else {
        const styleData = FRAME_PRICES[frameStyle];
        const sizeData = styleData ? styleData[frameSize] : null;
        if (!sizeData) return jsonResponse({ error: "Invalid frame configuration." }, 400);
        price = includeMagnets ? sizeData.full : sizeData.frame;
      }
    } else if (eventTag === 'VALENTINES') {
      if (productType === 'flexi') {
        price = FLEXI_PRICE;
      } else {
        if (!VALENTINES_PACKS.includes(packSize)) return jsonResponse({ error: "Invalid pack." }, 400);
        price = VALENTINES_PRICES[packSize];
      }
    } else if (eventTag === 'BINGO') {
      if (!BINGO_PACKS.includes(packSize)) return jsonResponse({ error: "Invalid Bingo pack." }, 400);
      price = BINGO_PRICES[packSize];
    } else if (productType === 'keyring') {
      price = keyringPrice(packSize);
    } else if (productType === 'bundle') {
      price = BUNDLE_PRICE;
    } else if (productType === 'large_magnet') {
      if (!LARGE_MAGNET_PACKS.includes(packSize)) return jsonResponse({ error: "Invalid pack." }, 400);
      price = LARGE_MAGNET_PRICES[packSize];
    } else {
      if (!STANDARD_PACKS.includes(packSize)) return jsonResponse({ error: "Invalid standard pack." }, 400);
      price = STANDARD_PRICES[packSize];
    }

    let orderId = body?.orderId || crypto.randomUUID();

    let existingOrder = {};
    if (body?.orderId) {
      const rawKv = await env.ORDERS_KV.get(`order:${orderId}`);
      if (rawKv) existingOrder = JSON.parse(rawKv);
    }

    const now = new Date().toISOString();

    let socialPerm = existingOrder.socialPermission;
    if (body.socialPermission !== undefined) {
      socialPerm = body.socialPermission;
    }

    let finalStatus = existingOrder.status || "checkout_created";
    if (manualStatus === 'paid') {
      finalStatus = 'paid';
    } else if (finalStatus === 'draft' || finalStatus === 'abandoned') {
      finalStatus = 'checkout_created';
    }

    const order = {
      orderId,
      email: email || existingOrder.email,
      phone: phone || existingOrder.phone,
      packSize: packSize || existingOrder.packSize,
      packType: packType || existingOrder.packType,
      price,
      event: eventTag || existingOrder.event,
      raffleNumber: raffleNumber || existingOrder.raffleNumber,
      eventId: eventId || existingOrder.eventId || null,

      productType: productType || existingOrder.productType,
      flexiColor: flexiColor || existingOrder.flexiColor,
      premadeSelections: premadeSelections.length ? premadeSelections : existingOrder.premadeSelections,
      mothersPackage: mothersPackage || existingOrder.mothersPackage,

      frameStyle: frameStyle || existingOrder.frameStyle,
      frameSize: frameSize || existingOrder.frameSize,
      frameColor: frameColor || existingOrder.frameColor,
      includeMagnets: includeMagnets !== undefined ? includeMagnets : existingOrder.includeMagnets,
      customText: customText !== undefined ? customText : (existingOrder.customText || null),
      borderColor: borderColor || existingOrder.borderColor || null,
      bodyColor: bodyColor || existingOrder.bodyColor || null,
      textColor: textColor || existingOrder.textColor || null,
      bandColor: bandColor || existingOrder.bandColor || null,
      bandColors: body?.bandColors || existingOrder.bandColors || null,
      bundleItems: body?.bundleItems || existingOrder.bundleItems || null,
      magnetOrientations: body?.magnetOrientations || existingOrder.magnetOrientations || null,

      status: finalStatus,

      createdAt: existingOrder.createdAt || now,
      updatedAt: now,
      images: existingOrder.images || [],
      stripeSessionId: existingOrder.stripeSessionId || null,
      recoverySent: existingOrder.recoverySent || false,

      shippingMethod: body?.shippingMethod || existingOrder.shippingMethod || (eventTag === 'MANUAL' ? 'COLLECT' : null),
      socialPermission: socialPerm,
      bingoNumber: existingOrder.bingoNumber,
      basketDraft: isBasketDraft || existingOrder.basketDraft || false
    };

    if (eventTag === 'BINGO' && !order.bingoNumber) {
      try {
        const currentSeq = await env.ORDERS_KV.get('config:bingo_seq');
        let nextSeq = 1;
        if (currentSeq) nextSeq = parseInt(currentSeq, 10) + 1;
        await env.ORDERS_KV.put('config:bingo_seq', String(nextSeq));
        order.bingoNumber = nextSeq;
      } catch (e) {}
    }

    await env.ORDERS_KV.put(`order:${orderId}`, JSON.stringify(order));

    // Reserve the event ticket number so it can't be reused
    if (order.event === 'MANUAL' && order.eventId && order.raffleNumber != null) {
      await env.ORDERS_KV.put(`event:ticket:${order.eventId}:${order.raffleNumber}`, orderId);
    }

    return jsonResponse({ orderId });
  } catch (err) {
    console.error("Order Create Error:", err);
    return jsonResponse({ error: "Failed to create order." }, 500);
  }
}

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const orderId = url.searchParams.get("orderId");
    if (!orderId) return jsonResponse({ error: "Missing orderId." }, 400);
    const raw = await env.ORDERS_KV.get(`order:${orderId}`);
    if (!raw) return jsonResponse({ error: "Order not found." }, 404);
    // Only return fields needed by the public tracking page
    const o = JSON.parse(raw);
    return jsonResponse({
      orderId: o.orderId,
      status: o.status,
      productType: o.productType,
      packSize: o.packSize,
      packType: o.packType,
      frameStyle: o.frameStyle,
      frameSize: o.frameSize,
      event: o.event,
      bingoNumber: o.bingoNumber,
      createdAt: o.createdAt,
      email: o.email,
      phone: o.phone,
      shippingMethod: o.shippingMethod,
      socialPermission: o.socialPermission,
    });
  } catch (err) {
    return jsonResponse({ error: "Failed to load order." }, 500);
  }
}
