"use strict";
/**
 * belvo-client.js
 * Belvo open-finance SDK wrapper for IMSS, INFONAVIT, and bank connectors.
 *
 * Connectors used:
 *   imss_mx_employment  — Employee Stage 2: salary (SBC), tenure, contribution history
 *   imss_mx             — Employer Part B: verify 3-employee CURPs against patron RFC
 *   infonavit_mx        — Employee Stage 0: housing loan balance + monthly deduction
 *   afore_mx            — Employee Stage 2: AFORE savings + contribution regularity
 *   issste_mx           — Employee Stage 1: government-worker parallel to IMSS
 *   bank connectors     — Employee Stage 4: 90-day transaction history (open banking)
 *
 * SDK: belvo@0.28.0 (archived Dec 2023 — works fine, no new features).
 * Docs: https://developers.belvo.com/docs/employment-and-income-mexico
 */
const BelvoClient = require("belvo").default;

const BELVO_SANDBOX_URL = "https://sandbox.belvo.com";

// The belvo SDK (0.28.0, archived) wraps axios internally and does not expose
// a per-call timeout or cancellation option through its public API (register/
// retrieve/delete take no request config). Every SDK call sits directly in
// the credit-decision path, so a hung Belvo request — sandbox flakiness, a
// stuck gov-portal login, a dead connection — would otherwise hang the
// underwriting stage indefinitely. BELVO_TIMEOUT_MS bounds how long we wait
// for any single SDK call; same env-var-with-default convention as
// SC_HTTP_TIMEOUT_MS in softcredito-adapter.
const BELVO_TIMEOUT_MS = () => Number(process.env.BELVO_TIMEOUT_MS) || 15000;

/**
 * Distinct, identifiable error for a Belvo call that exceeded BELVO_TIMEOUT_MS.
 * Callers must be able to tell "Belvo timed out" apart from "Belvo said no" —
 * this is never null/undefined, always a real Error with a stable `.code`.
 */
class BelvoTimeoutError extends Error {
  constructor(label, ms) {
    super(`Belvo call timed out after ${ms}ms: ${label}`);
    this.name = "BelvoTimeoutError";
    this.code = "BELVO_TIMEOUT";
    this.isTimeout = true;
  }
}

/**
 * Race a Belvo SDK call against a timer. The underlying HTTP request may
 * still complete in the background (the SDK gives us no cancellation hook),
 * but callers stop waiting and get a distinct BelvoTimeoutError instead of
 * hanging forever.
 */
function withTimeout(promise, label) {
  const ms = BELVO_TIMEOUT_MS();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BelvoTimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

let _client = null;

/**
 * Resolve the Belvo API base URL.
 * Explicit BELVO_BASE_URL always wins. Otherwise: non-production environments
 * default to sandbox (so local/staging never needs the var set), but a
 * production environment with no explicit URL fails loudly instead of
 * silently falling back to sandbox and returning fake underwriting data.
 */
function resolveBelvoBaseUrl() {
  if (process.env.BELVO_BASE_URL) return process.env.BELVO_BASE_URL;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "BELVO_BASE_URL is not set and NODE_ENV=production. Refusing to " +
      "silently default to the Belvo sandbox, which would return fake " +
      "underwriting data for real borrowers. Set BELVO_BASE_URL explicitly."
    );
  }
  return BELVO_SANDBOX_URL;
}

async function getClient() {
  if (_client) return _client;
  const client = new BelvoClient(
    process.env.BELVO_SECRET_ID,
    process.env.BELVO_SECRET_PASSWORD,
    resolveBelvoBaseUrl()
  );
  await withTimeout(client.connect(), "connect");
  _client = client;
  return _client;
}

/**
 * Extract full error details from a Belvo SDK error.
 * The SDK often throws errors with empty `.message` but rich detail
 * in `.detail`, `.body`, `.statusCode`, or nested response objects.
 */
function extractBelvoError(err, context) {
  const detail = {
    context,
    message: err.message || "(empty message)",
    code: err.code || err.statusCode || err.status || null,
    detail: err.detail || null,
    body: null,
    stack: err.stack || null,
  };

  // Belvo SDK may attach response body as .body or .response
  if (err.body) {
    try {
      detail.body = typeof err.body === "string" ? JSON.parse(err.body) : err.body;
    } catch (_) {
      detail.body = err.body;
    }
  } else if (err.response) {
    try {
      detail.body = typeof err.response === "string"
        ? JSON.parse(err.response)
        : err.response?.body || err.response?.data || err.response;
    } catch (_) {
      detail.body = String(err.response);
    }
  }

  // Build a descriptive message for upstream consumers
  const parts = [context];
  if (detail.code) parts.push(`status=${detail.code}`);
  if (err.message) parts.push(err.message);
  if (detail.detail) parts.push(detail.detail);
  if (detail.body && !err.message) {
    parts.push(typeof detail.body === "string" ? detail.body : JSON.stringify(detail.body));
  }
  detail.summary = parts.join(" — ");

  return detail;
}

/**
 * IMSS employment records for a single employee CURP.
 * Returns: salary (SBC), tenure, employer RFC, IMSS active status, contribution history.
 * Used in Employee Stage 2.
 *
 * For IMSS fiscal connectors the "username" is the CURP and password
 * can be an empty string (Belvo handles the gov-portal auth).
 */
async function getIMSSEmployment(curp) {
  let linkId;
  try {
    const c = await getClient();
    const link = await withTimeout(
      c.links.register("imss_mx_employment", curp, "", { accessMode: "single" }),
      "getIMSSEmployment:links.register"
    );
    linkId = link.id;
    const records = await withTimeout(
      c.employmentRecords.retrieve(link.id),
      "getIMSSEmployment:employmentRecords.retrieve"
    );
    await withTimeout(c.links.delete(link.id), "getIMSSEmployment:links.delete").catch(() => {});
    return records;
  } catch (err) {
    if (linkId) {
      const c = await getClient().catch(() => null);
      if (c) await withTimeout(c.links.delete(linkId), "getIMSSEmployment:links.delete(cleanup)").catch(() => {});
    }
    const detail = extractBelvoError(err, "getIMSSEmployment");
    const enriched = new Error(detail.summary);
    enriched.belvoDetail = detail;
    throw enriched;
  }
}

/**
 * INFONAVIT housing loan balance + monthly deduction.
 * Used in Employee Stage 0 to compute net disposable income.
 */
async function getINFONAVIT(curp) {
  const c = await getClient();
  const link = await withTimeout(
    c.links.register("infonavit_mx", curp, "", { accessMode: "single" }),
    "getINFONAVIT:links.register"
  );
  const data = await withTimeout(c.incomes.retrieve(link.id), "getINFONAVIT:incomes.retrieve");
  await withTimeout(c.links.delete(link.id), "getINFONAVIT:links.delete").catch(() => {});
  return data;
}

/**
 * AFORE retirement savings balance + contribution history.
 * Used in Employee Stage 2.
 * 0 AFORE balance = possible informal worker = flag.
 * Regular contributions = employment stability signal.
 */
async function getAFORE(curp) {
  let linkId;
  try {
    const c = await getClient();
    const link = await withTimeout(
      c.links.register("afore_mx", curp, "", { accessMode: "single" }),
      "getAFORE:links.register"
    );
    linkId = link.id;
    const data = await withTimeout(c.incomes.retrieve(link.id), "getAFORE:incomes.retrieve");
    await withTimeout(c.links.delete(link.id), "getAFORE:links.delete").catch(() => {});
    return data;
  } catch (err) {
    if (linkId) {
      const c = await getClient().catch(() => null);
      if (c) await withTimeout(c.links.delete(linkId), "getAFORE:links.delete(cleanup)").catch(() => {});
    }
    const detail = extractBelvoError(err, "getAFORE");
    const enriched = new Error(detail.summary);
    enriched.belvoDetail = detail;
    throw enriched;
  }
}

/**
 * Employer Part B: verify up to 3 employee CURPs against the patron RFC
 * via the IMSS general connector. Confirms employees are actually registered
 * under this employer (direct payroll) or dispersora RFC (outsourced).
 */
async function verifyEmployerIMSS(curps, patronRfc) {
  const c = await getClient();
  const results = [];
  for (const curp of curps.slice(0, 3)) {
    try {
      const link = await withTimeout(
        c.links.register("imss_mx", curp, "", { accessMode: "single" }),
        "verifyEmployerIMSS:links.register"
      );
      const records = await withTimeout(
        c.employmentRecords.retrieve(link.id),
        "verifyEmployerIMSS:employmentRecords.retrieve"
      );
      const latest = records?.[0] || null;
      const match = latest?.employer_rfc === patronRfc;
      results.push({
        curp,
        imssActive: !!latest,
        rfcMatch:   match,
        sbc:        latest?.base_salary || null,
        tenure:     latest?.tenure_months || null,
      });
      await withTimeout(c.links.delete(link.id), "verifyEmployerIMSS:links.delete").catch(() => {});
    } catch (e) {
      results.push({ curp, error: e.message, timeout: e.code === "BELVO_TIMEOUT" });
    }
  }
  return results;
}

/**
 * ISSSTE employment records for government workers.
 * Parallel to IMSS — used in Employee Stage 1 when employer
 * is a government entity.
 */
async function getISSSTE(curp) {
  const c = await getClient();
  const link = await withTimeout(
    c.links.register("issste_mx", curp, "", { accessMode: "single" }),
    "getISSSTE:links.register"
  );
  const records = await withTimeout(
    c.employmentRecords.retrieve(link.id),
    "getISSSTE:employmentRecords.retrieve"
  );
  await withTimeout(c.links.delete(link.id), "getISSSTE:links.delete").catch(() => {});
  return records;
}

module.exports = {
  getClient,
  getIMSSEmployment,
  getINFONAVIT,
  getAFORE,
  verifyEmployerIMSS,
  getISSSTE,
  extractBelvoError,
  resolveBelvoBaseUrl,
  BELVO_SANDBOX_URL,
  BELVO_TIMEOUT_MS,
  BelvoTimeoutError,
};
