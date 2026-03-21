"use strict";
/**
 * metamap-client.js
 * MetaMap unified KYC/AML/Biometrics — replaces Truora + Incode + Sardine + EFL.
 *
 * MetaMap uses OAuth2 JWT auth and flow-based verifications configured in the
 * dashboard. Webhooks deliver results; polling is the fallback.
 *
 * Set METAMAP_MOCK=true until dashboard credentials arrive; deterministic
 * mock results are seeded on the last 3 chars of RFC.
 *
 * Docs: https://docs.metamap.com/docs/api-guide
 */
const crypto = require("crypto");
const fetch = require("node-fetch");

/* ------------------------------------------------------------------ */
/*  Env helpers (lazy accessors for testability)                      */
/* ------------------------------------------------------------------ */
const MOCK       = () => process.env.METAMAP_MOCK === "true";
const BASE       = () => process.env.METAMAP_BASE_URL || "https://api.getmati.com";
const CLIENT_ID  = () => process.env.METAMAP_CLIENT_ID;
const SECRET     = () => process.env.METAMAP_CLIENT_SECRET;
const WH_SECRET  = () => process.env.METAMAP_WEBHOOK_SECRET;
const FLOW_KYC   = () => process.env.METAMAP_FLOW_ID_KYC;
const FLOW_AML   = () => process.env.METAMAP_FLOW_ID_AML;

/* ------------------------------------------------------------------ */
/*  Token cache                                                       */
/* ------------------------------------------------------------------ */
let _cachedToken = null;
let _tokenExpiresAt = 0;

/**
 * Authenticate and get/cache JWT token.
 * Token cached in memory, refreshed 60s before expiry.
 * @returns {Promise<string>} JWT access token
 */
async function getToken() {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiresAt) return _cachedToken;

  const credentials = Buffer.from(`${CLIENT_ID()}:${SECRET()}`).toString("base64");
  const res = await fetch(`${BASE()}/oauth`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    timeout: 15000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MetaMap auth ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  _cachedToken = data.access_token;
  // Refresh 60s before expiry
  _tokenExpiresAt = now + (data.expiresIn - 60) * 1000;
  return _cachedToken;
}

/** Reset token cache (for testing). */
function _resetTokenCache() {
  _cachedToken = null;
  _tokenExpiresAt = 0;
}

/* ------------------------------------------------------------------ */
/*  Rate limiter — token bucket, max 3 req/s                          */
/* ------------------------------------------------------------------ */
const _bucket = { tokens: 3, last: Date.now() };

function _waitForRateLimit() {
  return new Promise((resolve) => {
    const now = Date.now();
    const elapsed = now - _bucket.last;
    // Refill: 3 tokens per second
    _bucket.tokens = Math.min(3, _bucket.tokens + (elapsed / 1000) * 3);
    _bucket.last = now;
    if (_bucket.tokens >= 1) {
      _bucket.tokens -= 1;
      resolve();
    } else {
      const waitMs = ((1 - _bucket.tokens) / 3) * 1000;
      _bucket.tokens = 0;
      _bucket.last = now + waitMs;
      setTimeout(resolve, Math.ceil(waitMs));
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Retry with exponential backoff                                    */
/* ------------------------------------------------------------------ */
async function _fetchWithRetry(url, opts, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { timeout: 15000, ...opts });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`MetaMap ${res.status}: ${text.slice(0, 200)}`);
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
      }
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ */
/*  Mock helpers                                                      */
/* ------------------------------------------------------------------ */
function _mockVerification(rfc = "", flowType) {
  const seed = rfc.slice(-3);
  const vid = `mock-ver-${rfc}-${Date.now()}`;
  const iid = `mock-id-${rfc}`;

  if (seed === "XXX") return {
    verificationId: vid, identityId: iid,
    verificationUrl: `https://signup.getmati.com/?merchantToken=mock-xxx`,
    status: "rejected",
    mocked: true,
  };
  if (seed === "YYY") return {
    verificationId: vid, identityId: iid,
    verificationUrl: `https://signup.getmati.com/?merchantToken=mock-yyy`,
    status: "reviewNeeded",
    mocked: true,
  };
  return {
    verificationId: vid, identityId: iid,
    verificationUrl: `https://signup.getmati.com/?merchantToken=mock-clean`,
    status: "verified",
    mocked: true,
  };
}

function _mockResult(rfc = "") {
  const seed = rfc.slice(-3);

  if (seed === "XXX") return {
    status: "rejected",
    identity: { status: "rejected" },
    steps: [
      { id: "document-reading", status: 200, data: { documentType: "national-id" } },
      { id: "alteration-detection", status: 200, data: { detected: true, confidence: 0.95 } },
      { id: "liveness", status: 200, data: { liveness: true } },
      { id: "facematch", status: 200, data: { match: false, score: 0.32 } },
    ],
    documents: [{ type: "national-id", country: "MX" }],
    deviceFingerprint: {
      emulator: true, vpn: false, rooted: false,
      deviceAgeDays: 2, ipReputationScore: 0.15,
      sessionDurationSeconds: 45, interactionAnomalyScore: 0.88,
    },
    mocked: true,
  };

  if (seed === "YYY") return {
    status: "reviewNeeded",
    identity: { status: "reviewNeeded" },
    steps: [
      { id: "document-reading", status: 200, data: { documentType: "national-id" } },
      { id: "alteration-detection", status: 200, data: { detected: false } },
      { id: "liveness", status: 200, data: { liveness: true } },
      { id: "facematch", status: 200, data: { match: true, score: 0.91 } },
      { id: "watchlist", status: 200, data: { hits: 1, matchType: "PEP", confidence: 0.78 } },
    ],
    documents: [{ type: "national-id", country: "MX" }],
    deviceFingerprint: {
      emulator: false, vpn: false, rooted: false,
      deviceAgeDays: 365, ipReputationScore: 0.85,
      sessionDurationSeconds: 120, interactionAnomalyScore: 0.12,
    },
    mocked: true,
  };

  if (seed === "ZZZ") return {
    status: "rejected",
    identity: { status: "rejected" },
    steps: [
      { id: "document-reading", status: 200, data: { documentType: "national-id" } },
      { id: "alteration-detection", status: 200, data: { detected: false } },
      { id: "liveness", status: 200, data: { liveness: true } },
      { id: "facematch", status: 200, data: { match: true, score: 0.89 } },
    ],
    documents: [{ type: "national-id", country: "MX" }],
    deviceFingerprint: {
      emulator: true, vpn: true, rooted: true,
      deviceAgeDays: 0, ipReputationScore: 0.05,
      sessionDurationSeconds: 22, interactionAnomalyScore: 0.97,
    },
    mocked: true,
  };

  return {
    status: "verified",
    identity: { status: "verified" },
    steps: [
      { id: "document-reading", status: 200, data: { documentType: "national-id" } },
      { id: "alteration-detection", status: 200, data: { detected: false } },
      { id: "liveness", status: 200, data: { liveness: true } },
      { id: "facematch", status: 200, data: { match: true, score: 0.96 } },
    ],
    documents: [{ type: "national-id", country: "MX" }],
    deviceFingerprint: {
      emulator: false, vpn: false, rooted: false,
      deviceAgeDays: 730, ipReputationScore: 0.92,
      sessionDurationSeconds: 95, interactionAnomalyScore: 0.05,
    },
    mocked: true,
  };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Create a MetaMap verification for an applicant.
 * @param {{ curp?: string, rfc?: string, name?: string, email?: string, phone?: string, loanId: string, correlationId: string }} applicant
 * @param {'kyc'|'aml'} flowType — selects which flowId to use
 * @returns {Promise<{ verificationId: string, identityId: string, verificationUrl: string, status: string }>}
 */
async function createVerification(applicant, flowType) {
  if (MOCK()) return _mockVerification(applicant.rfc, flowType);

  await _waitForRateLimit();
  const token = await getToken();
  const flowId = flowType === "aml" ? FLOW_AML() : FLOW_KYC();

  const res = await _fetchWithRetry(`${BASE()}/v2/verifications`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      flowId,
      metadata: {
        loanId: applicant.loanId,
        correlationId: applicant.correlationId,
        curp: applicant.curp || "",
        rfc: applicant.rfc || "",
        stage: flowType === "aml" ? "5" : "4",
      },
    }),
  });

  const data = await res.json();
  return {
    verificationId: data.id,
    identityId: data.identity,
    verificationUrl: data.url,
    status: data.status || "pending",
  };
}

/**
 * Retrieve full verification result (polling fallback).
 * @param {string} verificationId
 * @param {string} [rfc] — used only in mock mode for seeding
 * @returns {Promise<{ status: string, identity: Object, steps: Array, documents: Array }>}
 */
async function getVerificationResult(verificationId, rfc) {
  if (MOCK()) return _mockResult(rfc);

  const token = await getToken();
  const res = await _fetchWithRetry(`${BASE()}/v2/verifications/${verificationId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = await res.json();
  return {
    status: data.status,
    identity: data.identity,
    steps: data.steps || [],
    documents: data.documents || [],
    deviceFingerprint: data.deviceFingerprint || null,
  };
}

/**
 * Validate and parse incoming MetaMap webhook.
 * @param {Object|string} payload — raw webhook body
 * @param {string} signature — value of x-signature header
 * @returns {{ valid: boolean, eventName: string, verificationId: string, step?: Object, metadata?: Object }}
 */
function parseWebhook(payload, signature) {
  const secret = WH_SECRET();
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const hash = crypto.createHmac("sha256", secret).update(body).digest("hex");

  let valid = false;
  try {
    valid = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
  } catch {
    valid = false;
  }

  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  return {
    valid,
    eventName: parsed.eventName || parsed.event || "",
    verificationId: parsed.resource || parsed.verificationId || "",
    step: parsed.step || undefined,
    metadata: parsed.metadata || undefined,
  };
}

/**
 * Extract 7 ML features from MetaMap device/behavioral signals.
 * These feed into the Stage 4 autoencoder for anomaly detection.
 * @param {Object} verificationResult — full verification from getVerificationResult
 * @returns {{ emulator_detected: number, vpn_detected: number, rooted_device: number, device_age_days: number, ip_reputation_score: number, session_duration_seconds: number, interaction_anomaly_score: number }}
 */
function parseDeviceSignals(verificationResult) {
  const fp = verificationResult.deviceFingerprint || {};
  return {
    emulator_detected:        fp.emulator ? 1 : 0,
    vpn_detected:             fp.vpn ? 1 : 0,
    rooted_device:            fp.rooted ? 1 : 0,
    device_age_days:          typeof fp.deviceAgeDays === "number" ? fp.deviceAgeDays : -1,
    ip_reputation_score:      typeof fp.ipReputationScore === "number" ? fp.ipReputationScore : 0,
    session_duration_seconds: typeof fp.sessionDurationSeconds === "number" ? fp.sessionDurationSeconds : 0,
    interaction_anomaly_score: typeof fp.interactionAnomalyScore === "number" ? fp.interactionAnomalyScore : 0,
  };
}

module.exports = {
  getToken,
  createVerification,
  getVerificationResult,
  parseWebhook,
  parseDeviceSignals,
  _resetTokenCache,
};
