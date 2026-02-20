import crypto from "crypto";

/**
 * Optional: App-Proxy Signatur prüfen (empfohlen).
 * Shopify App Proxy sendet i.d.R. `signature` (manchmal `hmac`).
 * Wenn SHOPIFY_API_SECRET nicht gesetzt ist, wird nicht geprüft.
 */
function verifyProxySignature(req, secret) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const params = Object.fromEntries(url.searchParams.entries());

  const provided = params.signature || params.hmac;
  if (!provided) return { ok: false, reason: "Missing signature/hmac" };

  // signature/hmac darf nicht in die Berechnung rein
  delete params.signature;
  delete params.hmac;

  // Alphabetisch sortieren und in query-string bauen
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("");

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");

  // Shopify sendet i.d.R. hex lowercase
  const ok = crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(provided));
  return ok ? { ok: true } : { ok: false, reason: "Invalid signature/hmac" };
}

async function shopifyGraphQL({ shop, token, apiVersion, query, variables }) {
  const res = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (!res.ok || json.errors) {
    const msg = json?.errors?.[0]?.message || `Shopify error (${res.status})`;
    throw new Error(msg);
  }
  return json.data;
}

function computeStage(days) {
  // exakt nach deiner Logik
  if (days < 2) {
    return {
      stage: "processing",
      message: 'Die Bestellung ist bei uns eingegangen und wird nun verarbeitet.',
    };
  }
  if (days < 4) {
    return {
      stage: "packing",
      message:
        'Die Bestellung wird von unserem Lager verpackt, die Sendungsnummer erhältst du in Kürze per Mail.',
    };
  }
  return { stage: "shipped", message: "Bestellung versendet." };
}

function wantsHtml(req) {
  const accept = req.headers?.accept || "";
  return accept.includes("text/html");
}

function renderHtml({ orderName, stage, message, daysSince }) {
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bestellstatus</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; margin:0; padding:32px; background:#fff; color:#111;}
    .card{max-width:720px; margin:0 auto; border:1px solid #e8e8e8; border-radius:16px; padding:24px;}
    .muted{color:#666; font-size:14px;}
    h1{margin:0 0 8px 0; font-size:22px;}
    .msg{margin-top:14px; font-size:18px; line-height:1.35;}
    .pill{display:inline-block; padding:6px 10px; border-radius:999px; border:1px solid #ddd; font-size:12px; text-transform:uppercase; letter-spacing:.06em;}
  </style>
</head>
<body>
  <div class="card">
    <div class="muted">Bestellung: <strong>${orderName || "-"}</strong></div>
    <h1>Bestellstatus</h1>
    <div class="pill">${stage}</div>
    <div class="msg">${message}</div>
    <div class="muted" style="margin-top:16px;">Tage seit Bestellung: ${daysSince}</div>
  </div>
</body>
</html>`;
}

export default async function handler(req, res) {
  try {
    const shop = process.env.SHOPIFY_SHOP; // z.B. deucces.myshopify.com
    const token = process.env.SHOPIFY_ACCESS_TOKEN;
    const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-01";
    const secret = process.env.SHOPIFY_API_SECRET; // empfohlen für Proxy-Verify

    if (!shop || !token) {
      return res.status(500).json({ error: "Missing SHOPIFY_SHOP / SHOPIFY_ACCESS_TOKEN env" });
    }

    // Optional: Proxy Signatur prüfen
    if (secret) {
      const check = verifyProxySignature(req, secret);
      if (!check.ok) {
        return res.status(401).json({ error: "Unauthorized proxy request", reason: check.reason });
      }
    }

    const url = new URL(req.url, `https://${req.headers.host}`);
    const orderParam = (url.searchParams.get("order") || "").trim(); // z.B. 1043
    const emailParam = (url.searchParams.get("email") || "").trim().toLowerCase();

    if (!orderParam) {
      return res.status(400).json({
        error: "Missing order",
        hint: "Nutze ?order=1043&email=kunde@mail.de",
      });
    }

    // Query bauen: mind. nach name/order_number suchen.
    // Bei Shopify heißt es meist name "#1043"
    // Mit email ist es deutlich sicherer (sonst könnte jeder Ordernummern raten).
    const parts = [];
    // name kann mit/ohne # vorkommen
    const normalized = orderParam.startsWith("#") ? orderParam : `#${orderParam}`;
    parts.push(`name:${normalized}`);
    parts.push(`name:${orderParam}`); // fallback

    let queryString = `(${parts.join(" OR ")})`;
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
                id
                name
                createdAt
                displayFulfillmentStatus
                fulfillments(first: 10) {
                  trackingInfo {
                    number
                    url
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
    if (!node) {
      return res.status(404).json({
        error: "Order not found",
        hint: "Prüfe order und (idealerweise) email Parameter",
      });
    }

    const createdAt = new Date(node.createdAt);
    const now = new Date();
    const daysSince = Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

    // Optional: Wenn Shopify schon Tracking hat, direkt "versendet"
    const hasTracking =
      (node.fulfillments || []).some((f) => (f.trackingInfo || []).some((t) => t?.number || t?.url));

    let stageObj = computeStage(daysSince);
    if (hasTracking || String(node.displayFulfillmentStatus).toUpperCase() === "FULFILLED") {
      stageObj = { stage: "shipped", message: "Bestellung versendet." };
    }

    const payload = {
      orderName: node.name,
      createdAt: node.createdAt,
      daysSince,
      ...stageObj,
    };

    if (wantsHtml(req)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(renderHtml(payload));
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json(payload);
  } catch (err) {
    return res.status(500).json({ error: "Server error", message: err?.message || String(err) });
  }
}
