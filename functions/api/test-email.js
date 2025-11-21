// functions/api/test-email.js
// GET /api/test-email?key=ADMIN_DASH_KEY[&to=extra@example.com]
//
// Sends a simple test email using Resend, so you can confirm
// RESEND_API_KEY, RESEND_FROM_EMAIL and NOTIFY_EMAIL are working.

export const onRequestGet = async ({ request, env }) => {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    const extraTo = url.searchParams.get("to");

    // Reuse your existing admin key so random people can't spam it
    if (!key || key !== env.ADMIN_DASH_KEY) {
      return json({ error: "Unauthorized" }, 401);
    }

    const apiKey = env.RESEND_API_KEY;
    const from = env.RESEND_FROM_EMAIL;
    const notify = env.NOTIFY_EMAIL;

    if (!apiKey || !from || !notify) {
      return json(
        {
          error:
            "Missing RESEND_API_KEY, RESEND_FROM_EMAIL, or NOTIFY_EMAIL in env",
        },
        500
      );
    }

    // Build recipient list:
    // - all emails in NOTIFY_EMAIL (comma separated)
    // - plus optional ?to= email if you want to test a different address
    const recipients = notify
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);

    if (extraTo) {
      recipients.push(extraTo);
    }

    if (!recipients.length) {
      return json({ error: "No valid recipients" }, 400);
    }

    const subject = "Magnetic Memories – test email";
    const html = `
      <div style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
        <h2>Test email from Magnetic Memories</h2>
        <p>This is a test email sent via Resend from your Cloudflare Function.</p>
        <p>If you're reading this, your email configuration is working 🎉</p>
      </div>
    `;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: recipients,
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return json(
        {
          error: "Resend API call failed",
          status: res.status,
          body: text,
        },
        500
      );
    }

    return json({
      ok: true,
      sentTo: recipients,
    });
  } catch (err) {
    console.error("test-email error:", err);
    return json(
      { error: err.message || "Failed to send test email" },
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
