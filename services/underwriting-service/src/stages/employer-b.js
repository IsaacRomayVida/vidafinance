"use strict";
/**
 * employer-b.js
 * Employer Part B — deep due diligence, tier scoring, and slot management.
 *
 * Computes an employer score (0-100) from Part A signals + additional checks,
 * assigns a tier (1/2/reject), and manages active employee loan slots.
 *
 * Scoring inputs:
 *   - SAT registration age (older = more stable)
 *   - DENUE establishment size
 *   - IMSS employee count proxy (Belvo employer query)
 *   - Fiscal debt amount from Art. 69
 *   - PRESUNTO flag from 69-B (penalty)
 *   - Industry sector risk classification
 *   - Payroll cycle history (existing employers with prior loans)
 *
 * Tier thresholds:
 *   Score >= 70 → Tier 1 (auto-scale slots 10→20→...→100)
 *   Score 40-69 → Tier 2 (manual gate, start 3 slots)
 *   Score < 40  → Reject
 */
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

// ── Score weights (must sum to 100) ─────────────────────────────────
const WEIGHTS = {
  satAge:           20,
  denue:            15,
  imssEmployees:    15,
  fiscalDebt:       15,
  presunto:         10,
  sectorRisk:       15,
  payrollHistory:   10,
};

// ── Tier thresholds ─────────────────────────────────────────────────
const TIER_1_THRESHOLD = 70;
const TIER_2_THRESHOLD = 40;

// ── Slot constants ──────────────────────────────────────────────────
const TIER_1_INITIAL_SLOTS   = 10;
const TIER_1_SLOT_INCREMENT  = 10;
const TIER_1_MAX_AUTO_SLOTS  = 100;

const TIER_2_INITIAL_SLOTS   = 3;
const TIER_2_EXPANSION_BANDS = [3, 6, 10];
const TIER_2_UPGRADE_CYCLES  = 10;

// ── Scoring functions ───────────────────────────────────────────────

/**
 * SAT registration age score.
 * >= 10 years = full points, linear scale down to 0 at 0 years.
 */
function scoreSATAge(registrationDate) {
  if (!registrationDate) return 0;
  const now = new Date();
  const regDate = new Date(registrationDate);
  const years = (now - regDate) / (365.25 * 24 * 60 * 60 * 1000);
  if (years >= 10) return WEIGHTS.satAge;
  if (years <= 0) return 0;
  return Math.round((years / 10) * WEIGHTS.satAge);
}

/**
 * DENUE establishment size score.
 * Larger establishment = more points.
 */
function scoreDENUE(denueResult) {
  if (!denueResult || !denueResult.found) return 0;
  const match = denueResult.topMatch;
  if (!match) return 0;

  // DENUE fecha_alta age bonus (establishment longevity)
  let score = Math.round(WEIGHTS.denue * 0.5); // base for being found

  if (match.fechaAlta) {
    const years = (new Date() - new Date(match.fechaAlta)) / (365.25 * 24 * 60 * 60 * 1000);
    if (years >= 5) score = WEIGHTS.denue;
    else if (years >= 2) score = Math.round(WEIGHTS.denue * 0.75);
  }

  return score;
}

/**
 * IMSS employee count proxy score.
 * More verified employees = higher confidence in employer legitimacy.
 */
function scoreIMSSEmployees(imssResults) {
  if (!imssResults || !Array.isArray(imssResults)) return 0;
  const verified = imssResults.filter((r) => r.rfcMatch && r.imssActive).length;
  const total = imssResults.length;
  if (total === 0) return 0;
  const ratio = verified / total;
  return Math.round(ratio * WEIGHTS.imssEmployees);
}

/**
 * Fiscal debt score. No debt = full points, any debt = 0.
 */
function scoreFiscalDebt(art69Result) {
  if (!art69Result) return WEIGHTS.fiscalDebt; // no data = assume clean
  return art69Result.hasDebt ? 0 : WEIGHTS.fiscalDebt;
}

/**
 * 69-B PRESUNTO flag penalty.
 * Clean = full points, PRESUNTO = 0.
 */
function scorePresunto(check69BResult) {
  if (!check69BResult) return WEIGHTS.presunto; // no data = assume clean
  if (check69BResult.hardReject) return 0;
  if (check69BResult.flag) return 0;
  return WEIGHTS.presunto;
}

/**
 * Industry sector risk score.
 * Based on CNBV risk classification: bajo=full, medio=half, alto=0.
 */
function scoreSectorRisk(sectorResult) {
  if (!sectorResult) return WEIGHTS.sectorRisk;
  const level = (sectorResult.riskLevel || "").toLowerCase();
  if (level === "bajo") return WEIGHTS.sectorRisk;
  if (level === "medio") return Math.round(WEIGHTS.sectorRisk * 0.5);
  if (level === "alto") return 0;
  return Math.round(WEIGHTS.sectorRisk * 0.75); // unknown
}

/**
 * Payroll cycle history score.
 * Based on number of clean payroll cycles for existing employers.
 */
function scorePayrollHistory(cleanCycles) {
  if (!cleanCycles || cleanCycles <= 0) return 0;
  if (cleanCycles >= 6) return WEIGHTS.payrollHistory;
  return Math.round((cleanCycles / 6) * WEIGHTS.payrollHistory);
}

// ── Tier assignment ─────────────────────────────────────────────────

function assignTier(score) {
  if (score >= TIER_1_THRESHOLD) return 1;
  if (score >= TIER_2_THRESHOLD) return 2;
  return 0; // reject
}

// ── Slot management ─────────────────────────────────────────────────

/**
 * Compute initial slot allocation for a newly tiered employer.
 */
function computeInitialSlots(tier) {
  if (tier === 1) return TIER_1_INITIAL_SLOTS;
  if (tier === 2) return TIER_2_INITIAL_SLOTS;
  return 0;
}

/**
 * Tier 1 auto-scaling: add 10 slots per clean payroll cycle, cap at 100.
 * Returns { newSlots, requiresManualReview }.
 */
function autoScaleTier1(currentSlots, cleanCycles) {
  let slots = currentSlots;
  for (let i = 0; i < cleanCycles; i++) {
    slots += TIER_1_SLOT_INCREMENT;
    if (slots >= TIER_1_MAX_AUTO_SLOTS) {
      return {
        newSlots: TIER_1_MAX_AUTO_SLOTS,
        requiresManualReview: true,
        reason: "Reached auto-scale cap of 100 — manual review required to expand beyond",
      };
    }
  }
  return { newSlots: slots, requiresManualReview: false };
}

/**
 * Tier 2 manual gate: expansion follows bands 3→6→10.
 * After 10 clean cycles, eligible for Tier 1 upgrade review.
 * Returns { newSlots, requiresApproval, eligibleForUpgrade }.
 */
function expandTier2(currentSlots, totalCleanCycles) {
  const eligibleForUpgrade = totalCleanCycles >= TIER_2_UPGRADE_CYCLES;

  // Find next band
  let nextSlots = currentSlots;
  for (const band of TIER_2_EXPANSION_BANDS) {
    if (band > currentSlots) {
      nextSlots = band;
      break;
    }
  }

  // If already at max band, stay there
  if (nextSlots === currentSlots) {
    nextSlots = TIER_2_EXPANSION_BANDS[TIER_2_EXPANSION_BANDS.length - 1];
  }

  return {
    newSlots: nextSlots,
    requiresApproval: true,
    eligibleForUpgrade,
    reason: eligibleForUpgrade
      ? `${totalCleanCycles} clean cycles — eligible for Tier 1 upgrade review`
      : `Manual approval required — expansion to ${nextSlots} slots`,
  };
}

// ── Main entry point ────────────────────────────────────────────────

/**
 * Run employer Part B due diligence: compute score, assign tier, set slots.
 *
 * @param {object} employer - Employer document from Firestore
 * @param {object} partAResults - Signals from Part A stage
 * @param {object} partAResults.check69B - 69-B blacklist result
 * @param {object} partAResults.art69 - Art. 69 fiscal debt result
 * @param {object} partAResults.denue - DENUE business registry result
 * @param {object} partAResults.sectorRisk - CNBV sector risk result
 * @param {object} [partAResults.imssVerification] - Belvo IMSS employer verification
 * @returns {object} { pass, tier, score, activeSlots, reason, signals }
 */
async function runEmployerDueDiligence(employer, partAResults) {
  const signals = {};

  // 1. Score each dimension
  signals.satAge = scoreSATAge(employer.satRegistrationDate);
  signals.denue = scoreDENUE(partAResults.denue);
  signals.imssEmployees = scoreIMSSEmployees(partAResults.imssVerification);
  signals.fiscalDebt = scoreFiscalDebt(partAResults.art69);
  signals.presunto = scorePresunto(partAResults.check69B);
  signals.sectorRisk = scoreSectorRisk(partAResults.sectorRisk);
  signals.payrollHistory = scorePayrollHistory(employer.cleanPayrollCycles || 0);

  // 2. Compute total score
  const score = Object.values(signals).reduce((sum, v) => sum + v, 0);

  // 3. Assign tier
  const tier = assignTier(score);
  const pass = tier > 0;

  // 4. Compute slot allocation
  let activeSlots = 0;
  let slotInfo = {};

  if (tier === 1) {
    // For returning employers, auto-scale based on history
    const existingSlots = employer.activeSlots || 0;
    const cleanCycles = employer.cleanPayrollCycles || 0;

    if (existingSlots > 0 && cleanCycles > 0) {
      slotInfo = autoScaleTier1(existingSlots, 1); // scale by 1 cycle
      activeSlots = slotInfo.newSlots;
    } else {
      activeSlots = computeInitialSlots(1);
    }
  } else if (tier === 2) {
    const existingSlots = employer.activeSlots || 0;
    const cleanCycles = employer.cleanPayrollCycles || 0;

    if (existingSlots > 0 && cleanCycles > 0) {
      slotInfo = expandTier2(existingSlots, cleanCycles);
      activeSlots = slotInfo.newSlots;
    } else {
      activeSlots = computeInitialSlots(2);
    }
  }

  // 5. Build reason
  let reason;
  if (!pass) {
    reason = `Employer rejected — score ${score} below threshold ${TIER_2_THRESHOLD}`;
  } else if (slotInfo.reason) {
    reason = slotInfo.reason;
  } else {
    reason = `Tier ${tier} assigned — score ${score}, ${activeSlots} active slots`;
  }

  const result = {
    pass,
    tier,
    score,
    activeSlots,
    reason,
    signals,
    ...(slotInfo.requiresManualReview !== undefined && {
      requiresManualReview: slotInfo.requiresManualReview,
    }),
    ...(slotInfo.requiresApproval !== undefined && {
      requiresApproval: slotInfo.requiresApproval,
    }),
    ...(slotInfo.eligibleForUpgrade !== undefined && {
      eligibleForUpgrade: slotInfo.eligibleForUpgrade,
    }),
  };

  // 6. Update Firestore
  if (employer.employerId) {
    const db = getFirestore();
    await db.collection("employers").doc(employer.employerId).update({
      tier:               pass ? tier : null,
      employerScore:      score,
      activeSlots:        pass ? activeSlots : 0,
      tierAssignedAt:     FieldValue.serverTimestamp(),
      lastDueDiligenceAt: FieldValue.serverTimestamp(),
      dueDiligenceResult: result,
    });
  }

  return result;
}

module.exports = {
  runEmployerDueDiligence,
  // Exported for testing
  scoreSATAge,
  scoreDENUE,
  scoreIMSSEmployees,
  scoreFiscalDebt,
  scorePresunto,
  scoreSectorRisk,
  scorePayrollHistory,
  assignTier,
  computeInitialSlots,
  autoScaleTier1,
  expandTier2,
  WEIGHTS,
  TIER_1_THRESHOLD,
  TIER_2_THRESHOLD,
  TIER_1_INITIAL_SLOTS,
  TIER_1_SLOT_INCREMENT,
  TIER_1_MAX_AUTO_SLOTS,
  TIER_2_INITIAL_SLOTS,
  TIER_2_EXPANSION_BANDS,
  TIER_2_UPGRADE_CYCLES,
};
