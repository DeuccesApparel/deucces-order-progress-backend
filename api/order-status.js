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
body {
  margin: 0;
  padding: 40px 20px;
  font-family: system-ui, -apple-system, sans-serif;
  background: #ffffff;
  color: #111;
}
.card {
  max-width: 700px;
  margin: auto;
  border: 1px solid #eee;
  border-radius: 20px;
  padding: 30px;
}
h1 {
  margin-top: 0;
}
.timeline {
  display: flex;
  justify-content: space-between;
  margin: 40px 0;
}
.step {
  text-align: center;
  flex: 1;
  opacity: 0.4;
}
.step.active {
  opacity: 1;
}
.icon {
  font-size: 32px;
}
.label {
  margin-top: 10px;
  font-size: 14px;
}
.message {
  font-size: 18px;
  margin-top: 20px;
}
.meta {
  margin-top: 20px;
  font-size: 14px;
  color: #666;
}
@media (max-width: 600px) {
  .timeline {
    flex-direction: column;
    gap: 20px;
  }
}
</style>
</head>
<body>
  <div class="card">
    <h1>Bestellstatus</h1>
    <div><strong>Bestellung:</strong> ${orderName}</div>
    <div class="timeline">${timeline}</div>
    <div class="message">${message}</div>
    <div class="meta">Tage seit Bestellung: ${daysSince}</div>
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
