import crypto from "crypto";

// Dev-Dashboard apps no longer provide a permanent admin token.  Obtain a
// short-lived token from Shopify on demand instead, and reuse it while this
// serverless instance stays warm.
let cachedAccessToken;
let cachedAccessTokenExpiresAt = 0;

async function getShopifyAccessToken({ shop, clientId, clientSecret, legacyToken }) {
  if (!clientId || !clientSecret) return legacyToken;

  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) {
    return cachedAccessToken;
  }

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const payload = await response.json();

  if (!response.ok || !payload.access_token) {
    throw new Error(payload?.error_description || payload?.error || `Token exchange failed (${response.status})`);
  }

  cachedAccessToken = payload.access_token;
  // Refresh one minute early. Shopify currently issues these for 24 hours.
  cachedAccessTokenExpiresAt = Date.now() + Math.max((payload.expires_in || 86400) - 60, 60) * 1000;
  return cachedAccessToken;
}

/* ================================
   Proxy Signatur prüfen (optional)
================================ */

function verifyProxySignature(req, secret) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const params = Object.fromEntries(url.searchParams.entries());

  const provided = params.signature || params.hmac;
  if (!provided) return { ok: false };

  delete params.signature;
  delete params.hmac;

  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("");

  const digest = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  const ok = crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(provided)
  );

  return { ok };
}

/* ================================
   Shopify GraphQL Call
================================ */

async function shopifyGraphQL({ shop, token, apiVersion, query, variables }) {
  const res = await fetch(
    `https://${shop}/admin/api/${apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const json = await res.json();

  if (!res.ok || json.errors) {
    throw new Error(
      json?.errors?.[0]?.message || `Shopify error (${res.status})`
    );
  }

  return json.data;
}

/* ================================
   Status Logik
================================ */

function computeStage(days) {
  if (days < 2) return "processing";
  if (days < 4) return "packing";
  return "shipped";
}

function getMessage(stage) {
  if (stage === "processing")
    return "Die Bestellung ist bei uns eingegangen und wird nun verarbeitet.";
  if (stage === "packing")
    return "Die Bestellung wird von unserem Lager verpackt, die Sendungsnummer erhältst du in Kürze per Mail.";
  return "Bestellung versendet.";
}

/* ================================
   HTML Rendering (Timeline UI)
================================ */

function renderHtml({ orderName, stage, message, daysSince }) {
  const steps = [
    { key: "processing", label: "Eingegangen", icon: "🧾" },
    { key: "packing", label: "Wird verpackt", icon: "📦" },
    { key: "shipped", label: "Versendet", icon: "🚚" },
  ];

  const currentIndex = steps.findIndex((s) => s.key === stage);

  const timeline = steps
    .map((step, index) => {
      const active = index <= currentIndex;
      return `
        <div class="step ${active ? "active" : ""}">
          <div class="icon">${step.icon}</div>
          <div class="label">${step.label}</div>
        </div>
      `;
    })
    .join("");

  return `
<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Bestellstatus</title>
<style>
:root {
  --navy: #07152e;
  --navy-deep: #030a19;
  --blue: #27b7ff;
  --pink: #ff4f9a;
  --ink: #eef4ff;
  --muted: #a8b6d0;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  padding: 34px 18px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: radial-gradient(circle at 15% 0%, #123c72 0, transparent 31%), radial-gradient(circle at 95% 100%, #412052 0, transparent 30%), var(--navy-deep);
  color: var(--ink);
}
.card {
  max-width: 720px;
  margin: auto;
  overflow: hidden;
  border: 1px solid rgba(110, 173, 255, .26);
  border-radius: 24px;
  background: rgba(7, 21, 46, .94);
  box-shadow: 0 22px 65px rgba(0, 0, 0, .38);
}
.brand {
  padding: 14px 30px 12px;
  border-bottom: 1px solid rgba(110, 173, 255, .2);
  background: linear-gradient(105deg, rgba(39, 183, 255, .14), rgba(255, 79, 154, .08));
}
.brand-logo-frame {
  width: 126px;
  height: 95px;
  overflow: hidden;
}
.brand-logo {
  display: block;
  width: 202px;
  max-width: none;
  height: auto;
  transform: translate(-41px, -15px);
}
.content { padding: 34px 30px 30px; }
.eyebrow {
  margin: 0 0 10px;
  color: var(--blue);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 1.8px;
  text-transform: uppercase;
}
h1 {
  margin: 0;
  color: #fff;
  font-size: clamp(28px, 6vw, 38px);
  line-height: 1.06;
  letter-spacing: -.7px;
}
.order {
  display: inline-flex;
  margin-top: 17px;
  padding: 8px 12px;
  border: 1px solid rgba(39, 183, 255, .38);
  border-radius: 999px;
  color: #dcedff;
  background: rgba(39, 183, 255, .10);
  font-size: 14px;
  font-weight: 700;
}
.timeline {
  display: flex;
  justify-content: space-between;
  position: relative;
  gap: 9px;
  margin: 38px 0 32px;
}
.timeline::before {
  position: absolute;
  z-index: 0;
  top: 20px;
  right: 12%;
  left: 12%;
  height: 2px;
  background: rgba(168, 182, 208, .26);
  content: "";
}
.step {
  position: relative;
  z-index: 1;
  text-align: center;
  flex: 1;
  color: var(--muted);
}
.step.active {
  color: #fff;
}
.icon {
  display: grid;
  width: 42px;
  height: 42px;
  margin: 0 auto;
  place-items: center;
  border: 2px solid #50617f;
  border-radius: 50%;
  background: var(--navy);
  color: var(--muted);
  font-size: 14px;
  font-weight: 800;
}
.step.active .icon {
  border-color: var(--blue);
  background: linear-gradient(135deg, #178fd0, #6755d8);
  color: #fff;
  box-shadow: 0 0 0 5px rgba(39, 183, 255, .11), 0 0 24px rgba(39, 183, 255, .35);
}
.label {
  margin-top: 13px;
  font-size: 13px;
  font-weight: 700;
}
.message {
  padding: 19px 20px;
  border-left: 3px solid var(--pink);
  border-radius: 0 12px 12px 0;
  background: rgba(255, 255, 255, .06);
  color: #fff;
  font-size: 16px;
  line-height: 1.5;
}
.meta {
  margin: 24px 0 0;
  color: var(--muted);
  font-size: 13px;
}
.footer {
  padding: 17px 30px;
  border-top: 1px solid rgba(110, 173, 255, .17);
  color: #8ca0c1;
  background: rgba(0, 0, 0, .13);
  font-size: 12px;
}
@media (max-width: 600px) {
  body { padding: 16px 12px; }
  .brand, .content { padding-right: 21px; padding-left: 21px; }
  .timeline {
    gap: 4px;
    margin: 31px 0 28px;
  }
  .timeline::before { right: 16%; left: 16%; }
  .label { font-size: 11px; }
  .footer { padding-right: 21px; padding-left: 21px; }
}
</style>
</head>
<body>
  <div class="card">
    <div class="brand"><div class="brand-logo-frame"><img class="brand-logo" width="202" height="135" src="https://cdn.shopify.com/s/files/1/0929/7995/4008/files/ChatGPT_Image_Jul_20_2026_02_30_37_PM.png?v=1790711078" alt="Deucces Apparel"></div></div>
    <main class="content">
      <p class="eyebrow">Live-Bestellstatus</p>
      <h1>Deine Bestellung<br>ist unterwegs.</h1>
      <div class="order">Bestellung ${orderName}</div>
      <div class="timeline">${timeline}</div>
      <div class="message">${message}</div>
      <p class="meta">Bestellt vor ${daysSince} ${daysSince === 1 ? "Tag" : "Tagen"}</p>
    </main>
    <footer class="footer">DEUCCES APPAREL — danke für deine Bestellung.</footer>
  </div>
</body>
</html>
`;
}

/* ================================
   API Handler
================================ */

export default async function handler(req, res) {
  try {
    const shop = process.env.SHOPIFY_SHOP; // 5z4ipr-iq.myshopify.com
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
    const legacyToken = process.env.SHOPIFY_ACCESS_TOKEN;
    const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-01";
    const secret = process.env.SHOPIFY_API_SECRET;

    if (!shop || (!legacyToken && (!clientId || !clientSecret))) {
      return res
        .status(500)
        .json({ error: "Missing Shopify credentials" });
    }

    if (secret) {
      const check = verifyProxySignature(req, secret);
      if (!check.ok)
        return res.status(401).json({ error: "Invalid proxy signature" });
    }

    const url = new URL(req.url, `https://${req.headers.host}`);
    const orderParam = (url.searchParams.get("order") || "").trim();
    const emailParam = (url.searchParams.get("email") || "").trim();

    if (!orderParam)
      return res.status(400).json({ error: "Missing order parameter" });

    const token = await getShopifyAccessToken({
      shop,
      clientId,
      clientSecret,
      legacyToken,
    });

    const normalized = orderParam.startsWith("#")
      ? orderParam
      : `#${orderParam}`;

    let queryString = `(name:${normalized} OR name:${orderParam})`;
    if (emailParam) queryString += ` AND email:${emailParam}`;

    const data = await shopifyGraphQL({
      shop,
      token,
      apiVersion,
      query: `
        query GetOrder($q: String!) {
          orders(first: 1, query: $q, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                name
                createdAt
                displayFulfillmentStatus
                fulfillments(first: 5) {
                  trackingInfo {
                    number
                  }
                }
              }
            }
          }
        }
      `,
      variables: { q: queryString },
    });

    const node = data?.orders?.edges?.[0]?.node;
    if (!node)
      return res.status(404).json({ error: "Order not found" });

    const createdAt = new Date(node.createdAt);
    const now = new Date();
    const daysSince = Math.floor(
      (now - createdAt) / (1000 * 60 * 60 * 24)
    );

    let stage = computeStage(daysSince);

    const hasTracking =
      node.fulfillments?.some((f) =>
        f.trackingInfo?.some((t) => t?.number)
      ) || false;

    if (
      hasTracking ||
      node.displayFulfillmentStatus === "FULFILLED"
    ) {
      stage = "shipped";
    }

    const message = getMessage(stage);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(
      renderHtml({
        orderName: node.name,
        stage,
        message,
        daysSince,
      })
    );
  } catch (err) {
    return res
      .status(500)
      .json({ error: "Server error", message: err.message });
  }
}
