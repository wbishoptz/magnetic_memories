// functions/api/test-telegram.js
// GET /api/test-telegram?key=ADMIN_DASH_KEY[&message=Hello]
//
// Sends a simple test message to your Telegram chat using the bot.
// Uses TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from env.

export const onRequestGet = async ({ request, env }) => {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const customMessage = url.searchParams.get("message");

    // Protect with same admin key you use for the admin dashboard
    if (!key || key !== env.ADMIN_DASH_KEY) {
      return json({ error: "Unauthorized" }, 401);
    }

    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      return json(
        {
          error:
            "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in environment",
        },
        500
      );
    }

    const text =
      customMessage ||
      "Test message from Magnetic Memories – if you see this, Telegram notifications are working 🎉";

    const apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;

    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    });

    const body = await res.json().catch(() => null);

    if (!res.ok || !body?.ok) {
      return json(
        {
          error: "Telegram API call failed",
          status: res.status,
          response: body,
        },
        500
      );
    }

    return json({
      ok: true,
      sentTo: chatId,
      message: text,
    });
  } catch (err) {
    console.error("test-telegram error:", err);
    return json(
      { error: err.message || "Failed to send test telegram" },
      500
    );
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
