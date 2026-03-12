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
 * IMSS employment records for a single employee CURP.
 * Returns: salary (SBC), tenure, employer RFC, IMSS active status, contribution history.
 * Used in Employee Stage 2.
 *
 * For IMSS fiscal connectors the "username" is the CURP and password
 * can be an empty string (Belvo handles the gov-portal auth).
 */
async function getIMSSEmployment(curp) {
  const c = await getClient();
  const link = await c.links.register("imss_mx_employment", curp, "", {
    accessMode: "single",
  });
  const records = await c.employmentRecords.retrieve(link.id);
  await c.links.delete(link.id).catch(() => {});
  return records;
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
  const c = await getClient();
  const link = await c.links.register("afore_mx", curp, "", {
    accessMode: "single",
  });
  const data = await c.incomes.retrieve(link.id);
  await c.links.delete(link.id).catch(() => {});
  return data;
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
};
