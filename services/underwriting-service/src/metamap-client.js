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
const crypto = require("crypto");
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

/** Single GET of a verification resource. Returns the raw MetaMap payload. */
async function fetchVerification(verificationId) {
  await acquireToken();
  const token = await getAccessToken();

  const res = await fetch(`${BASE()}/v2/verifications/${verificationId}`, {
    headers: { "Authorization": `Bearer ${token}` },
    timeout: 10000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MetaMap ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Fetch a verification once and parse it. No polling.
 *
 * This is the fetch-once primitive the module was missing. index.js:134 has
 * always called `metamapClient.getVerificationResult(verificationId)` from the
 * `verification_completed` webhook branch — where the verification is by
 * definition already finished and polling would be wrong — but the function
 * did not exist on the module after #346. Every such webhook therefore threw
 * `TypeError: metamapClient.getVerificationResult is not a function`, was
 * swallowed by that handler's catch, and landed in incident_log instead of
 * metamap_shadow_log.
 *
 * @param {string} verificationId
 * @param {string} [rfc] — mock seeding only
 * @param {object} [opts] — { isAML }
 */
async function getVerificationResult(verificationId, rfc = "", opts = {}) {
  const { isAML = false } = opts;
  if (MOCK()) {
    return isAML ? mockAMLResult(rfc) : mockKYCResult(rfc);
  }
  const data = await fetchVerification(verificationId);
  return isAML ? parseAMLResult(data) : parseKYCResult(data);
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
    const data = await fetchVerification(verificationId);
    if (data.status === "completed" || data.status === "reviewNeeded" || data.status === "rejected") {
      return isAML ? parseAMLResult(data) : parseKYCResult(data);
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`MetaMap verification ${verificationId} timed out after ${maxWaitMs}ms`);
}

/**
 * Parse a webhook payload from MetaMap.
 *
 * Returns an envelope, not a bare result:
 *   { valid, eventName, verificationId, step, metadata, result }
 *
 * This shape is what the only production caller — the `POST /webhooks/metamap`
 * handler in index.js:114 — destructures. It used to return the parsed
 * verification result directly (no `valid` key) and to THROW on a signature
 * mismatch, which broke that handler in two ways at once:
 *
 *   1. `valid` was always `undefined`, so every correctly-signed webhook took
 *      the `if (!valid)` branch: 401 to MetaMap and an `invalid_signature`
 *      row in incident_log. No webhook has ever reached the shadow log.
 *   2. A genuinely bad signature threw out of an async Express handler with no
 *      try/catch, producing an unhandled rejection and no response at all —
 *      the one case the 401 branch was written for was the one it never saw.
 *
 * The mismatch dates to #346 (Verifik removal), which rewrote this module's
 * API without migrating index.js. It stayed invisible because
 * src/webhook-metamap.test.js mocks this module with the *old* shape, so the
 * webhook tests asserted against a contract the real module had stopped
 * honouring. See the contract test at the bottom of that file.
 *
 * `valid` is false — never thrown — for a bad or malformed signature, so the
 * caller can answer 401 and log an incident. `eventName`, `step` and
 * `metadata` come off the raw payload; `result` is the parsed KYC/AML view of
 * it for callers that do not want to re-fetch.
 *
 * An unset METAMAP_WEBHOOK_SECRET means `valid: false`, not `valid: true`.
 * This used to initialise `valid = true` and only re-derive it inside
 * `if (secret)`, so a missing variable accepted every payload with no
 * signature at all — and .env.example ships that variable empty, with no boot
 * guard for it, so the default configuration was the open one. The previous
 * note here argued the route "only writes to metamap_shadow_log and makes no
 * credit decision", but writing is the exposure: an anonymous caller could put
 * a document of their choosing into metamap_shadow_log under a verificationId
 * of their choosing (set(), no merge, so an existing legitimate entry is
 * overwritten), tag it with any loanId, and drive one credential-bearing
 * getVerificationResult call into our MetaMap tenant per request. Fail closed;
 * an environment missing the variable now 401s and lands in incident_log
 * instead of silently accepting strangers. functions/src/webhooks/metamap.ts
 * has always taken this stance for the same events.
 *
 * Deliberately NOT a boot guard, unlike INTERNAL_SECRET at the top of
 * index.js: that secret gates the credit-decision path, this one gates a
 * shadow log, and refusing to start underwriting over a missing observability
 * secret trades a contained hole for an outage on the lending path.
 */
function parseWebhook(body, signature) {
  const secret = process.env.METAMAP_WEBHOOK_SECRET;
  const raw = typeof body === "string" ? body : JSON.stringify(body);

  let valid = false;
  if (secret) {
    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    // timingSafeEqual throws on a length mismatch, which an attacker controls,
    // so compare lengths first and only then in constant time.
    const given = typeof signature === "string" ? signature : "";
    valid =
      given.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }

  let payload;
  try {
    payload = typeof body === "string" ? JSON.parse(body) : body || {};
  } catch {
    return { valid: false, eventName: "", verificationId: "", step: undefined, metadata: undefined, result: null };
  }

  const isAML = (payload.flowId || "") === process.env.METAMAP_FLOW_ID_AML;

  return {
    valid,
    eventName: payload.eventName || "",
    // MetaMap names the verification id `resource` on webhooks and `id`/`_id`
    // on the REST resource itself.
    verificationId: payload.resource || payload.id || payload._id || "",
    step: payload.step,
    metadata: payload.metadata,
    result: valid ? (isAML ? parseAMLResult(payload) : parseKYCResult(payload)) : null,
  };
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

// Exposed for tests only. `_tokenCache` and `_bucket` are module-level and
// survive `jest.resetModules()`-free suites, so without this nothing about the
// OAuth cache or the rate limiter can be exercised twice in one file: the
// second case reuses the first case's token and a drained bucket, and asserting
// on fetch call counts becomes order-dependent. The tests/ suite reached for a
// `_resetTokenCache` export that no longer existed; this is the same idea under
// the name sat-blacklist-client.js already uses (`__resetForTests`), and it
// resets the rate limiter too, which the old name did not.
function __resetForTests() {
  _tokenCache = null;
  _bucket.tokens = _bucket.rate;
  _bucket.lastRefill = Date.now();
}

module.exports = {
  getAccessToken,
  createVerification,
  getVerificationResult,
  pollVerification,
  parseWebhook,
  parseKYCResult,
  parseAMLResult,
  extractDeviceSignals,
  checkBehavioralRisk,
  STAGE_4_MODULES,
  STAGE_5_MODULES,
  __resetForTests,
};
