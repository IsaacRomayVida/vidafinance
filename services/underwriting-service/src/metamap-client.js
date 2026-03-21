"use strict";
/**
 * metamap-client.js
 * MetaMap (Mati) — KYC identity verification webhooks + API client (Stage 4).
 *
 * Handles:
 *  - Webhook signature validation (HMAC-SHA256 via x-signature header)
 *  - Webhook payload parsing (verification_completed + step_completed events)
 *  - Fetching full verification results from the MetaMap API
 *
 * Docs: https://docs.metamap.com/reference/webhooks
 */
const crypto = require("crypto");
const fetch = require("node-fetch");

const BASE = () => process.env.METAMAP_API_URL || "https://api.getmati.com/v2";

/**
 * Parse and validate a MetaMap webhook payload.
 *
 * @param {object} body — parsed JSON body from the request
 * @param {string} signature — value of the x-signature header
 * @returns {{ valid: boolean, eventName?: string, verificationId?: string, step?: object, metadata?: object, flowId?: string }}
 */
function parseWebhook(body, signature) {
  if (!signature || !body) {
    return { valid: false };
  }

  const secret = process.env.METAMAP_WEBHOOK_SECRET;
  if (!secret) {
    return { valid: false };
  }

  const hash = crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(body))
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  let valid = false;
  try {
    valid = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
  } catch (_) {
    valid = false;
  }

  if (!valid) {
    return { valid: false };
  }

  // Extract verificationId from the resource URL
  const resource = body.resource || "";
  const verificationId = resource.split("/verifications/")[1] || null;

  return {
    valid: true,
    eventName: body.eventName,
    verificationId,
    step: body.step || null,
    metadata: body.metadata || null,
    flowId: body.flowId || null,
  };
}

/**
 * Fetch the full verification result from the MetaMap API.
 *
 * @param {string} verificationId
 * @returns {Promise<object>} — full verification object including identity, steps, status
 */
async function getVerificationResult(verificationId) {
  const token = await getAccessToken();

  const res = await fetch(`${BASE()}/verifications/${verificationId}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MetaMap getVerification ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Get a short-lived access token using client credentials.
 * MetaMap uses Basic auth (clientId:clientSecret) → POST /oauth to get a Bearer token.
 */
async function getAccessToken() {
  const clientId = process.env.METAMAP_CLIENT_ID;
  const clientSecret = process.env.METAMAP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("METAMAP_CLIENT_ID and METAMAP_CLIENT_SECRET are required");
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://api.getmati.com/oauth", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    timeout: 10000,
  });

  if (!res.ok) {
    throw new Error(`MetaMap OAuth failed: ${res.status}`);
  }

  const data = await res.json();
  return data.access_token;
}

module.exports = { parseWebhook, getVerificationResult };
