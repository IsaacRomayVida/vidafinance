"use strict";
/**
 * Employer Part B: Due Diligence
 *
 * Computes employer score 0-100 from Part A signals + IMSS employee proxy.
 *   >= 70 = Tier 1 (auto-scale slots 10→20→...→100)
 *   40-69 = Tier 2 (manual gate, max 3 starting slots)
 *   < 40  = reject
 */
const { verifyEmployerIMSS } = require("../belvo-client");
const { getPayrollTier } = require("../payroll-software");

async function runEmployerDueDiligence(employer, partAResults, { logger } = {}) {
  const log = logger || console;
  const rfc = employer.rfc;
  const costItems = [];

  log.info({ stage: "employer-b", rfc }, "Starting employer due diligence");

  // Verify employee CURPs against employer RFC via IMSS
  let imssVerification = null;
  if (employer.sampleCurps && employer.sampleCurps.length > 0) {
    try {
      imssVerification = await verifyEmployerIMSS(employer.sampleCurps, rfc);
      costItems.push({ api: "belvo-imss", mxn: 3.0 });
    } catch (err) {
      log.warn({ stage: "employer-b", rfc, err: err.message }, "IMSS verification failed");
      imssVerification = { error: err.message, skipped: true };
    }
  }

  // Compute employer score
  let score = 50; // base

  // Part A signals (new format uses "signals", fallback to "data" for compat)
  const partA = partAResults.signals || partAResults.data || {};
  if (partA.sat?.pass) score += 10;
  if (partA.denue?.pass) score += 5;
  if (partA.repse?.pass) score += 5;
  if (partA.lista69B?.flag || partA.efos?.flag) score -= 15; // PRESUNTO flag

  // IMSS employee verification
  if (imssVerification && !imssVerification.skipped) {
    const matches = imssVerification.filter(r => r.rfcMatch);
    if (matches.length >= 2) score += 15;
    else if (matches.length === 1) score += 5;
    else score -= 10;

    // Tenure signal from verified employees
    const avgTenure = matches.reduce((sum, r) => sum + (r.tenure || 0), 0) / Math.max(matches.length, 1);
    if (avgTenure > 24) score += 5;
  }

  // Payroll system tier
  const payroll = getPayrollTier(employer.payrollSystem || "other");
  score += payroll.tier * 5; // Tier 2 = +10, Tier 1 = +5, Tier 0 = +0

  // Company size proxy
  const empCount = employer.employeeCount || 0;
  if (empCount >= 50) score += 5;
  if (empCount < 5) score -= 10;

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));

  // Tier assignment
  let tier, maxSlots;
  if (score >= 70) {
    tier = 1;
    maxSlots = 100; // auto-scale 10→20→...→100
  } else if (score >= 40) {
    tier = 2;
    maxSlots = 3; // manual gate
  } else {
    tier = 3;
    maxSlots = 0;
  }

  const pass = tier <= 2;

  log.info({ stage: "employer-b", rfc, score, tier, pass }, "Employer scoring complete");

  return {
    pass,
    escalateToStage: null,
    reason: pass ? null : "EMPLOYER_SCORE_LOW",
    data: {
      score,
      tier,
      maxSlots,
      imssVerification,
      payroll,
    },
    cost: costItems,
  };
}

module.exports = { runEmployerDueDiligence };
