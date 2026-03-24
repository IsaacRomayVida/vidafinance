"use strict";
/**
 * metamap-client.js
 * MetaMap (formerly Mati) — unified KYC, biometrics, AML, and device signals.
 *
 * Unified provider for KYC, behavioral biometrics, and AML. Supports
 * multiple verification flows:
 *   - KYC flow (Stage 3–4): document, facematch, liveness, device, behavioral, gov-check
 *   - AML flow (Stage 5): aml-screening, criminal-records, pep-check
 *
 * Auth: OAuth2 client_credentials → Bearer JWT (cached in memory).
 * Rate limit: 3 req/s (token bucket).
 * Retry: 3 attempts, exponential backoff (500ms base).
 *
 * Set METAMAP_MOCK=true until sandbox/production credentials arrive.
 *
 * Docs: https://docs.metamap.com
 */
const fetch = require("node-fetch");

const MOCK = () => process.env.METAMAP_MOCK === "true";
const BASE = () => process.env.METAMAP_BASE_URL || "https://api.getmati.com";

// Module sets for each stage
const STAGE_4_MODULES = [
  "document-verification",
  "facematch",
  "liveness",
  "device-fingerprint",
  "behavioral-analysis",
  "government-check",
];

const STAGE_5_MODULES = [
  "aml-screening",
  "criminal-records",
  "pep-check",
];

// ─── OAuth2 Token Cache ──────────────────────────────────────────────────────

let _tokenCache = null;

async function getAccessToken() {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }

  const credentials = Buffer.from(
    `${process.env.METAMAP_CLIENT_ID}:${process.env.METAMAP_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch(`${BASE()}/oauth`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    timeout: 10000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MetaMap OAuth ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  _tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expiresIn || 3600) * 1000,
  };
  return _tokenCache.token;
}

// ─── Rate Limiter (3 req/s token bucket) ─────────────────────────────────────

const _bucket = { tokens: 3, lastRefill: Date.now(), rate: 3, interval: 1000 };

async function acquireToken() {
  const now = Date.now();
  const elapsed = now - _bucket.lastRefill;
  _bucket.tokens = Math.min(_bucket.rate, _bucket.tokens + (elapsed / _bucket.interval) * _bucket.rate);
  _bucket.lastRefill = now;

  if (_bucket.tokens >= 1) {
    _bucket.tokens -= 1;
    return;
  }
  const waitMs = ((1 - _bucket.tokens) / _bucket.rate) * _bucket.interval;
  await new Promise(r => setTimeout(r, waitMs));
  _bucket.tokens = 0;
  _bucket.lastRefill = Date.now();
}

// ─── Retry with Exponential Backoff ──────────────────────────────────────────

async function withRetry(fn, maxAttempts = 3, baseDelayMs = 500) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ─── Mock Results ────────────────────────────────────────────────────────────

function mockKYCResult(rfc = "") {
  const seed = rfc.slice(-3);
  if (seed === "XXX") return {
    verificationId: `mock-kyc-${rfc}`,
    status: "rejected",
    documentVerification: { passed: false, reason: "DOCUMENT_ALTERED" },
    facematch: { passed: false, score: 0.42 },
    liveness: { passed: false },
    deviceFingerprint: mockDeviceSignals("XXX"),
    behavioralAnalysis: { passed: false, anomalyScore: 0.91 },
    governmentCheck: { passed: false },
    mocked: true,
  };
  if (seed === "YYY") return {
    verificationId: `mock-kyc-${rfc}`,
    status: "reviewNeeded",
    documentVerification: { passed: true },
    facematch: { passed: false, score: 0.65 },
    liveness: { passed: true },
    deviceFingerprint: mockDeviceSignals("YYY"),
    behavioralAnalysis: { passed: true, anomalyScore: 0.35 },
    governmentCheck: { passed: true },
    mocked: true,
  };
  if (seed === "ZZZ") return {
    verificationId: `mock-kyc-${rfc}`,
    status: "reviewNeeded",
    documentVerification: { passed: true },
    facematch: { passed: true, score: 0.92 },
    liveness: { passed: true },
    deviceFingerprint: mockDeviceSignals("ZZZ"),
    behavioralAnalysis: { passed: false, anomalyScore: 0.88 },
    governmentCheck: { passed: true },
    mocked: true,
  };
  return {
    verificationId: `mock-kyc-${rfc}`,
    status: "verified",
    documentVerification: { passed: true },
    facematch: { passed: true, score: 0.95 },
    liveness: { passed: true },
    deviceFingerprint: mockDeviceSignals("OK"),
    behavioralAnalysis: { passed: true, anomalyScore: 0.08 },
    governmentCheck: { passed: true },
    mocked: true,
  };
}

function mockDeviceSignals(seed) {
  if (seed === "ZZZ") return {
    emulator_detected: 1, vpn_detected: 1, rooted_device: 1,
    device_age_days: 2, ip_reputation_score: 0.15,
    session_duration_seconds: 12, interaction_anomaly_score: 0.92,
  };
  if (seed === "XXX") return {
    emulator_detected: 1, vpn_detected: 0, rooted_device: 1,
    device_age_days: 5, ip_reputation_score: 0.30,
    session_duration_seconds: 8, interaction_anomaly_score: 0.78,
  };
  if (seed === "YYY") return {
    emulator_detected: 0, vpn_detected: 1, rooted_device: 0,
    device_age_days: 45, ip_reputation_score: 0.55,
    session_duration_seconds: 90, interaction_anomaly_score: 0.42,
  };
  return {
    emulator_detected: 0, vpn_detected: 0, rooted_device: 0,
    device_age_days: 380, ip_reputation_score: 0.88,
    session_duration_seconds: 245, interaction_anomaly_score: 0.05,
  };
}

function mockAMLResult(rfc = "") {
  const seed = rfc.slice(-3);
  if (seed === "XXX") return {
    verificationId: `mock-aml-${rfc}`,
    status: "flagged",
    amlScreening: { hit: true, lists: [{ list: "OFAC", matchType: "CONFIRMED" }] },
    criminalRecords: { found: true, records: [{ type: "FRAUD", jurisdiction: "CDMX" }] },
    pepCheck: { isPEP: false },
    mocked: true,
  };
  if (seed === "YYY") return {
    verificationId: `mock-aml-${rfc}`,
    status: "flagged",
    amlScreening: { hit: true, lists: [{ list: "CNBV_LISTA_NEGRA", matchType: "FUZZY" }] },
    criminalRecords: { found: false, records: [] },
    pepCheck: { isPEP: true, position: "Municipal President" },
    mocked: true,
  };
  return {
    verificationId: `mock-aml-${rfc}`,
    status: "clear",
    amlScreening: { hit: false, lists: [] },
    criminalRecords: { found: false, records: [] },
    pepCheck: { isPEP: false },
    mocked: true,
  };
}

// ─── Core API Methods ────────────────────────────────────────────────────────

/**
 * Create a verification with specified modules.
 * @param {object} applicant — { firstName, lastName, curp, rfc, email, phone, dateOfBirth }
 * @param {string[]} modules — STAGE_4_MODULES or STAGE_5_MODULES
 * @returns {{ verificationId, flowRunUrl }}
 */
async function createVerification(applicant, modules) {
  const isAML = modules === STAGE_5_MODULES ||
    (modules.length > 0 && modules[0] === "aml-screening");

  if (MOCK()) {
    if (isAML) return { verificationId: `mock-aml-${applicant.rfc}`, flowRunUrl: null };
    return { verificationId: `mock-kyc-${applicant.rfc}`, flowRunUrl: null };
  }

  await acquireToken();
  return withRetry(async () => {
    const token = await getAccessToken();
    const flowId = isAML
      ? process.env.METAMAP_FLOW_ID_AML
      : process.env.METAMAP_FLOW_ID_KYC;

    const res = await fetch(`${BASE()}/v2/verifications`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        flowId,
        metadata: {
          firstName: applicant.firstName,
          lastName: applicant.lastName,
          curp: applicant.curp,
          email: applicant.email,
          dateOfBirth: applicant.dateOfBirth,
        },
      }),
      timeout: 15000,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MetaMap createVerification ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    return {
      verificationId: data.id || data._id,
      flowRunUrl: data.flowRunUrl || null,
    };
  });
}

/**
 * Poll verification status until completed or timeout.
 * @param {string} verificationId
 * @param {string} rfc — for mock seeding
 * @param {object} opts — { maxWaitMs, pollIntervalMs, isAML }
 */
async function pollVerification(verificationId, rfc, opts = {}) {
  const { maxWaitMs = 60000, pollIntervalMs = 5000, isAML = false } = opts;

  if (MOCK()) {
    return isAML ? mockAMLResult(rfc) : mockKYCResult(rfc);
  }

  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await acquireToken();
    const token = await getAccessToken();

    const res = await fetch(`${BASE()}/v2/verifications/${verificationId}`, {
      headers: { "Authorization": `Bearer ${token}` },
      timeout: 10000,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MetaMap poll ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    if (data.status === "completed" || data.status === "reviewNeeded" || data.status === "rejected") {
      return isAML ? parseAMLResult(data) : parseKYCResult(data);
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`MetaMap verification ${verificationId} timed out after ${maxWaitMs}ms`);
}

/**
 * Parse a webhook payload from MetaMap.
 * Validates HMAC-SHA256 signature if METAMAP_WEBHOOK_SECRET is set.
 */
function parseWebhook(body, signature) {
  const secret = process.env.METAMAP_WEBHOOK_SECRET;
  if (secret && signature) {
    const crypto = require("crypto");
    const expected = crypto
      .createHmac("sha256", secret)
      .update(typeof body === "string" ? body : JSON.stringify(body))
      .digest("hex");
    if (expected !== signature) {
      throw new Error("MetaMap webhook signature mismatch");
    }
  }

  const payload = typeof body === "string" ? JSON.parse(body) : body;
  const flowId = payload.flowId || "";
  const isAML = flowId === process.env.METAMAP_FLOW_ID_AML;

  return isAML ? parseAMLResult(payload) : parseKYCResult(payload);
}

// ─── Result Parsers ──────────────────────────────────────────────────────────

function parseKYCResult(data) {
  const steps = data.steps || [];
  const getStep = (name) => steps.find(s => s.id === name) || {};

  const docStep = getStep("document-verification");
  const faceStep = getStep("facematch");
  const liveStep = getStep("liveness");
  const deviceStep = getStep("device-fingerprint");
  const behavStep = getStep("behavioral-analysis");
  const govStep = getStep("government-check");

  return {
    verificationId: data.id || data._id,
    status: data.status || "unknown",
    documentVerification: {
      passed: docStep.status === "completed" && docStep.data?.documentValid !== false,
      reason: docStep.data?.rejectionReason || null,
    },
    facematch: {
      passed: (faceStep.data?.matchScore || 0) >= 0.80,
      score: faceStep.data?.matchScore || 0,
    },
    liveness: {
      passed: liveStep.status === "completed" && liveStep.data?.isAlive !== false,
    },
    deviceFingerprint: extractDeviceSignals(deviceStep.data || {}),
    behavioralAnalysis: {
      passed: !(behavStep.data?.anomalyDetected),
      anomalyScore: behavStep.data?.anomalyScore || 0,
    },
    governmentCheck: {
      passed: govStep.status === "completed" && govStep.data?.valid !== false,
    },
  };
}

function parseAMLResult(data) {
  const steps = data.steps || [];
  const getStep = (name) => steps.find(s => s.id === name) || {};

  const amlStep = getStep("aml-screening");
  const crimStep = getStep("criminal-records");
  const pepStep = getStep("pep-check");

  const amlHits = amlStep.data?.hits || [];
  const crimRecords = crimStep.data?.records || [];
  const isPEP = pepStep.data?.isPEP || false;

  return {
    verificationId: data.id || data._id,
    status: amlHits.length > 0 || crimRecords.length > 0 || isPEP ? "flagged" : "clear",
    amlScreening: {
      hit: amlHits.length > 0,
      lists: amlHits.map(h => ({ list: h.listName, matchType: h.matchType })),
    },
    criminalRecords: {
      found: crimRecords.length > 0,
      records: crimRecords,
    },
    pepCheck: {
      isPEP,
      position: pepStep.data?.position || null,
    },
  };
}

/**
 * Extract 7 device signals for the autoencoder anomaly model.
 * Returns a normalized feature vector.
 */
function extractDeviceSignals(deviceData) {
  return {
    emulator_detected: deviceData.isEmulator ? 1 : 0,
    vpn_detected: deviceData.isVPN ? 1 : 0,
    rooted_device: deviceData.isRooted ? 1 : 0,
    device_age_days: deviceData.deviceAgeDays || 0,
    ip_reputation_score: deviceData.ipReputationScore || 0,
    session_duration_seconds: deviceData.sessionDuration || 0,
    interaction_anomaly_score: deviceData.interactionAnomalyScore || 0,
  };
}

// ─── Behavioral Risk Check ────────────────────────────────────────────────────

/**
 * Check behavioral risk via MetaMap device/behavioral signals.
 * Used in Stage 0 fraud gates.
 * @param {string} sessionKey — device session identifier
 * @param {string} userId — applicant user ID
 * @returns {{ pass, risk_level, score }}
 */
async function checkBehavioralRisk(sessionKey, userId) {
  if (MOCK()) {
    return { pass: true, risk_level: "low", score: 15, mocked: true };
  }

  await acquireToken();
  return withRetry(async () => {
    const token = await getAccessToken();
    const res = await fetch(`${BASE()}/v2/verifications`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        flowId: process.env.METAMAP_FLOW_ID_BEHAVIORAL,
        metadata: { sessionKey, userId },
      }),
      timeout: 15000,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MetaMap behavioral check ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const verificationId = data.id || data._id;

    // Poll for result
    const result = await pollVerification(verificationId, "", {
      maxWaitMs: 30000,
      pollIntervalMs: 3000,
      isAML: false,
    });

    const anomalyScore = result.behavioralAnalysis?.anomalyScore || 0;
    const riskLevel = anomalyScore >= 0.9 ? "very_high"
      : anomalyScore >= 0.7 ? "high"
      : anomalyScore >= 0.4 ? "medium"
      : "low";

    return {
      pass: riskLevel !== "very_high",
      risk_level: riskLevel,
      score: Math.round(anomalyScore * 100),
    };
  });
}

module.exports = {
  createVerification,
  pollVerification,
  parseWebhook,
  parseKYCResult,
  parseAMLResult,
  extractDeviceSignals,
  checkBehavioralRisk,
  STAGE_4_MODULES,
  STAGE_5_MODULES,
};
