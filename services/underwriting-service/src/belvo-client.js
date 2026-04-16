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

let _client = null;

async function getClient() {
  if (_client) return _client;
  _client = new BelvoClient(
    process.env.BELVO_SECRET_ID,
    process.env.BELVO_SECRET_PASSWORD,
    process.env.BELVO_BASE_URL
  );
  await _client.connect();
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
    const link = await c.links.register("imss_mx_employment", curp, "", {
      accessMode: "single",
    });
    linkId = link.id;
    const records = await c.employmentRecords.retrieve(link.id);
    await c.links.delete(link.id).catch(() => {});
    return records;
  } catch (err) {
    if (linkId) {
      const c = await getClient().catch(() => null);
      if (c) await c.links.delete(linkId).catch(() => {});
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
  const link = await c.links.register("infonavit_mx", curp, "", {
    accessMode: "single",
  });
  const data = await c.incomes.retrieve(link.id);
  await c.links.delete(link.id).catch(() => {});
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
    const link = await c.links.register("afore_mx", curp, "", {
      accessMode: "single",
    });
    linkId = link.id;
    const data = await c.incomes.retrieve(link.id);
    await c.links.delete(link.id).catch(() => {});
    return data;
  } catch (err) {
    if (linkId) {
      const c = await getClient().catch(() => null);
      if (c) await c.links.delete(linkId).catch(() => {});
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
      const link = await c.links.register("imss_mx", curp, "", {
        accessMode: "single",
      });
      const records = await c.employmentRecords.retrieve(link.id);
      const latest = records?.[0] || null;
      const match = latest?.employer_rfc === patronRfc;
      results.push({
        curp,
        imssActive: !!latest,
        rfcMatch:   match,
        sbc:        latest?.base_salary || null,
        tenure:     latest?.tenure_months || null,
      });
      await c.links.delete(link.id).catch(() => {});
    } catch (e) {
      results.push({ curp, error: e.message });
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
  const link = await c.links.register("issste_mx", curp, "", {
    accessMode: "single",
  });
  const records = await c.employmentRecords.retrieve(link.id);
  await c.links.delete(link.id).catch(() => {});
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
};
