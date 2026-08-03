"use strict";
/**
 * Employer Part B: Due Diligence
 *
 * Computes employer score 0-100 from Part A signals + IMSS employee proxy.
 *   >= 70 = Tier 1 (auto-scale slots 10→20→...→100)
 *   40-69 = Tier 2 (manual gate, max 3 starting slots)
 *   < 40  = reject
 *
 * The tier-assignment and slot-growth helpers below (assignTier through
 * expandTier2) implement ADR-007's ratified hybrid growth rule and are used
 * by services that call them directly. `runEmployerDueDiligence` itself is
 * unchanged by ADR-007 — it does not yet call these helpers — because its
 * tier numbering (reject = 3, not 0) is a load-bearing contract for
 * stage3-autoapprove.js. Wiring due-diligence review time into
 * runEmployerDueDiligence is a separate, larger piece of work (the weighted
 * scoring engine and Firestore integration specified in
 * __tests__/employer-b.test.js's still-skipped `runEmployerDueDiligence`
 * describe block) that ADR-007 does not cover.
 */
const { verifyEmployerIMSS } = require("../belvo-client");
const { getPayrollTier } = require("../payroll-software");
const { getSeedSlotGrowthConfig } = require("../config/lendingSlotGrowth");

const TIER_1_THRESHOLD = 70;
const TIER_2_THRESHOLD = 40;
const TIER_1_INITIAL_SLOTS = 10;
const TIER_2_INITIAL_SLOTS = 3;
const TIER_2_EXPANSION_BANDS = Object.freeze([3, 6, 10]);
const TIER_2_UPGRADE_CYCLES = 10;
// Re-exported from the seed for callers/tests that reference the ceiling by
// name here; the server-configurable value lives in
// src/config/lendingSlotGrowth.js and is what autoScaleTier1 actually uses
// by default.
const TIER_1_MAX_AUTO_SLOTS = getSeedSlotGrowthConfig().tier1MaxAutoSlots;

/** score >= 70 -> Tier 1, 40-69 -> Tier 2, else reject (tier 0). Tier boundaries unchanged by ADR-007. */
function assignTier(score) {
  if (score >= TIER_1_THRESHOLD) return 1;
  if (score >= TIER_2_THRESHOLD) return 2;
  return 0;
}

/** Starting slot count for a fresh employer at the given tier. */
function computeInitialSlots(tier) {
  if (tier === 1) return TIER_1_INITIAL_SLOTS;
  if (tier === 2) return TIER_2_INITIAL_SLOTS;
  return 0;
}

/**
 * ADR-007 hybrid growth for a returning Tier 1 employer: +10 slots earned
 * per clean payroll cycle, credited only at this due-diligence review, and
 * capped at `config.maxIncrementsPerReview` increments per review (ratified
 * at 2 — "let's do two max", so a weekly-payroll employer cannot outrun our
 * own oversight cadence) — never exceeding `config.tier1MaxAutoSlots`.
 *
 * Conservative reading of an open question ADR-007 flags explicitly: clean
 * cycles earned beyond the per-review cap are FORFEITED, not carried
 * forward to the next review. `cyclesForfeited` surfaces that count so a
 * caller can log or display it; exposure cannot step twice in one
 * oversight window merely because an employer ran more payrolls than we
 * reviewed. This is a judgment call, not something the spec settles — see
 * ADR-007's "Open question" section.
 *
 * `config` defaults to the compile-time seed (10 / 2 / 100) so this stays a
 * synchronous pure function; callers wired to the server-side override
 * (src/config/lendingSlotGrowth.js's getSlotGrowthConfig()) should resolve
 * it first and pass the result in.
 */
function autoScaleTier1(currentSlots, cleanPayrollCycles, config) {
  const { slotIncrement, maxIncrementsPerReview, tier1MaxAutoSlots } = config || getSeedSlotGrowthConfig();

  const earnedCycles = Math.max(0, cleanPayrollCycles || 0);
  const incrementsCredited = Math.min(earnedCycles, maxIncrementsPerReview);
  const cyclesForfeited = earnedCycles - incrementsCredited;
  const potentialSlots = currentSlots + incrementsCredited * slotIncrement;
  const newSlots = Math.min(potentialSlots, tier1MaxAutoSlots);

  return {
    newSlots,
    requiresManualReview: potentialSlots > tier1MaxAutoSlots,
    incrementsCredited,
    cyclesForfeited,
  };
}

/**
 * Tier 2 manual-gate expansion: fixed bands (3 -> 6 -> 10), never past the
 * top band without a Tier 1 upgrade review. Unlike Tier 1, this is
 * unaffected by ADR-007 — it was never in contradiction and needed no
 * ruling (see the header of __tests__/employer-b.test.js).
 */
function expandTier2(currentSlots, cleanPayrollCycles) {
  const nextBand = TIER_2_EXPANSION_BANDS.find((band) => band > currentSlots);
  const newSlots = nextBand !== undefined ? nextBand : TIER_2_EXPANSION_BANDS[TIER_2_EXPANSION_BANDS.length - 1];
  const cycles = cleanPayrollCycles || 0;
  const eligibleForUpgrade = cycles >= TIER_2_UPGRADE_CYCLES;

  return {
    newSlots,
    requiresApproval: true,
    eligibleForUpgrade,
    reason: eligibleForUpgrade
      ? `${cycles} clean payroll cycles — eligible for Tier 1 upgrade review`
      : null,
  };
}

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

module.exports = {
  runEmployerDueDiligence,
  // ADR-007 hybrid growth: tier assignment and slot-growth helpers.
  TIER_1_THRESHOLD,
  TIER_2_THRESHOLD,
  TIER_1_INITIAL_SLOTS,
  TIER_2_INITIAL_SLOTS,
  TIER_2_EXPANSION_BANDS,
  TIER_2_UPGRADE_CYCLES,
  TIER_1_MAX_AUTO_SLOTS,
  assignTier,
  computeInitialSlots,
  autoScaleTier1,
  expandTier2,
};
