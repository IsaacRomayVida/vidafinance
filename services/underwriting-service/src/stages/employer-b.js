"use strict";
/**
 * Employer Part B: Due Diligence
 *
 * Computes employer score 0-100 via the weighted signal engine below
 * (WEIGHTS through scorePayrollHistory) from Part A signals, SAT
 * registration age, and IMSS employee verification.
 *   >= 70 = Tier 1 (auto-scale slots 10→20→...→100, ADR-007 hybrid growth)
 *   40-69 = Tier 2 (manual gate, max 3 starting slots, expands 3→6→10)
 *   < 40  = reject (tier 0)
 *
 * `runEmployerDueDiligence` wires the weighted engine and the ADR-007
 * tier/slot helpers (assignTier through expandTier2) together and persists
 * the outcome to `employers/{employerId}` in Firestore. Its top-level return
 * shape (`{pass, tier, score, maxActiveSlots, slotGrowth, signals,
 * requiresApproval, reason}`) is specified by __tests__/employer-b.test.js's
 * `runEmployerDueDiligence` describe block.
 *
 * `maxActiveSlots` is CAPACITY, not slots-in-use (ADR-008) — the number of
 * concurrent loans this employer's employees are allowed to hold, computed
 * from the due-diligence tier/score. It is a distinct concept from the
 * slots-IN-USE count that `functions/src/index.ts`'s requestLoan transaction
 * computes separately via an aggregate `count()` query; the two must never
 * be wired into each other.
 */
const { verifyEmployerIMSS } = require("../belvo-client");
const { getSeedSlotGrowthConfig } = require("../config/lendingSlotGrowth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

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

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Per-signal weights for the weighted scoring engine. Sums to 100, matching
 * this file's documented 0-100 score range.
 */
const WEIGHTS = Object.freeze({
  satAge: 15,
  denue: 10,
  imssEmployees: 20,
  fiscalDebt: 15,
  presunto: 15,
  sectorRisk: 10,
  payrollHistory: 15,
});

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

/**
 * SAT registration age: full weight at 10+ years, 0 for a missing or
 * future-dated registration, linear between. A future date is not a data
 * error the function refuses to score — the same fail-toward-zero shape as
 * the rest of this file's signals.
 */
function scoreSATAge(satRegistrationDate) {
  if (!satRegistrationDate) return 0;
  const years = (Date.now() - new Date(satRegistrationDate).getTime()) / MS_PER_YEAR;
  if (years <= 0) return 0;
  if (years >= 10) return WEIGHTS.satAge;
  return Math.round(WEIGHTS.satAge * (years / 10));
}

/**
 * DENUE business-establishment age: full weight at 5+ years, 3/4 weight for
 * 2-5 years, half weight for under 2 years or for a match with no
 * `fechaAlta` on record (treated the same — an unknown establishment date
 * is no stronger a signal than a young one), 0 when DENUE has no match at
 * all.
 */
function scoreDENUE(result) {
  if (!result || !result.found) return 0;
  const fechaAlta = result.topMatch && result.topMatch.fechaAlta;
  if (!fechaAlta) return Math.round(WEIGHTS.denue * 0.5);
  const years = (Date.now() - new Date(fechaAlta).getTime()) / MS_PER_YEAR;
  if (years >= 5) return WEIGHTS.denue;
  if (years >= 2) return Math.round(WEIGHTS.denue * 0.75);
  return Math.round(WEIGHTS.denue * 0.5);
}

/**
 * IMSS employee verification: weight scaled by the fraction of sampled
 * CURPs that both match the employer's RFC and show as IMSS-active. A
 * result missing either flag does not count as verified.
 */
function scoreIMSSEmployees(results) {
  if (!results || results.length === 0) return 0;
  const verified = results.filter((r) => r.rfcMatch && r.imssActive).length;
  return Math.round((verified / results.length) * WEIGHTS.imssEmployees);
}

/** Fiscal debt (Art. 69 CFF): full weight when clean or unchecked, 0 on any debt. */
function scoreFiscalDebt(result) {
  if (!result) return WEIGHTS.fiscalDebt;
  return result.hasDebt ? 0 : WEIGHTS.fiscalDebt;
}

/** SAT 69-B presumed/definitive EFOS listing: full weight when clean or unchecked, 0 on either flag. */
function scorePresunto(result) {
  if (!result) return WEIGHTS.presunto;
  if (result.flag || result.hardReject) return 0;
  return WEIGHTS.presunto;
}

/** Sector risk band from Part A: bajo full, medio half, alto zero, unknown/unchecked 3/4. */
function scoreSectorRisk(result) {
  if (!result) return WEIGHTS.sectorRisk;
  switch (result.riskLevel) {
    case "bajo":
      return WEIGHTS.sectorRisk;
    case "medio":
      return Math.round(WEIGHTS.sectorRisk * 0.5);
    case "alto":
      return 0;
    default:
      return Math.round(WEIGHTS.sectorRisk * 0.75);
  }
}

/** Clean payroll cycle history: full weight at 6+ cycles, 0 with none, linear between. */
function scorePayrollHistory(cleanPayrollCycles) {
  const cycles = cleanPayrollCycles || 0;
  if (cycles <= 0) return 0;
  if (cycles >= 6) return WEIGHTS.payrollHistory;
  return Math.round((cycles / 6) * WEIGHTS.payrollHistory);
}

/**
 * Runs the weighted scoring engine against Part A + employer signals,
 * assigns a tier and slot count via the ADR-007 helpers, persists the
 * outcome to Firestore, and returns the flat result the pipeline and its
 * callers consume.
 *
 * `partAResults` accepts either the raw signal object directly
 * (`{check69B, art69, denue, sectorRisk, imssVerification}`, as isolated
 * callers and tests pass it) or a full Part A stage result with those
 * signals nested under `.signals` (as decision-engine.js passes
 * `results.employerA`). Part A's own signal is exposed under the key
 * `lista69B`, the same check69B() result under a different name, so both
 * spellings are accepted for that one field.
 *
 * IMSS employee verification prefers a live check against
 * `employer.sampleCurps` (the same call and cost line the previous ad-hoc
 * heuristic made) and falls back to `partAResults.imssVerification` when the
 * caller already supplies it and no CURPs are available to check directly.
 */
async function runEmployerDueDiligence(employer, partAResults, { logger } = {}) {
  const log = logger || console;
  const rfc = employer.rfc;
  const costItems = [];

  log.info({ stage: "employer-b", rfc }, "Starting employer due diligence");

  const partA = partAResults.signals || partAResults || {};
  const check69B = partA.check69B || partA.lista69B || null;

  let imssResults = partA.imssVerification || null;
  if (employer.sampleCurps && employer.sampleCurps.length > 0) {
    try {
      imssResults = await verifyEmployerIMSS(employer.sampleCurps, rfc);
      costItems.push({ api: "belvo-imss", mxn: 3.0 });
    } catch (err) {
      log.warn({ stage: "employer-b", rfc, err: err.message }, "IMSS verification failed");
      imssResults = partA.imssVerification || null;
    }
  }

  const signals = {
    satAge: scoreSATAge(employer.satRegistrationDate),
    denue: scoreDENUE(partA.denue),
    imssEmployees: scoreIMSSEmployees(imssResults),
    fiscalDebt: scoreFiscalDebt(partA.art69),
    presunto: scorePresunto(check69B),
    sectorRisk: scoreSectorRisk(partA.sectorRisk),
    payrollHistory: scorePayrollHistory(employer.cleanPayrollCycles),
  };
  const score = Object.values(signals).reduce((sum, value) => sum + value, 0);
  const tier = assignTier(score);
  const pass = tier > 0;

  // ── ADR-007 slot ledger ───────────────────────────────────────────
  // TWO distinct cycle counters, deliberately not one field (ADR-009):
  //
  //   `cleanPayrollCycles`            — LIFETIME clean cycles. Feeds
  //     scorePayrollHistory (full weight at 6+) and expandTier2's Tier-1
  //     upgrade clock (>= 10), both of which ADR-005 Finding 1 item 2
  //     ratified as *lifetime* quantities. Monotonic; never reset.
  //   `cleanPayrollCyclesSinceReview` — cycles ACCRUED since the last
  //     due-diligence review. This is the quantity ADR-007's hybrid rule
  //     actually operates on: "earns one growth increment per clean
  //     payroll cycle SINCE its last due-diligence review", credited at
  //     the review and forfeited beyond the 2-increment cap.
  //
  // Aliasing both onto the single `cleanPayrollCycles` field — which is
  // what this function did before — makes the two ratified rules
  // mutually unsatisfiable: forfeiting the Tier-1 accrual to zero would
  // also zero the Tier-2 employer's lifetime upgrade clock, so no Tier-2
  // employer could ever reach the 10 cycles that earn an upgrade review.
  //
  // NEITHER counter is written by anything in this repository today
  // (measured, not assumed — see ADR-009 Q1). With the accrual counter
  // pinned at 0, autoScaleTier1 credits 0 increments and PRESERVES the
  // stored cap instead of growing it, which is what makes wiring this
  // ledger into the live path provably exposure-neutral until Isaac
  // settles Q1 and Q2.
  const currentSlots = employer.maxActiveSlots || 0;
  const lifetimeCleanCycles = employer.cleanPayrollCycles || 0;
  const cyclesSinceReview = employer.cleanPayrollCyclesSinceReview || 0;

  // The tier this employer held at its LAST review, when known. A stored
  // slot count is a position on ONE tier's ladder, not a portable number.
  // Re-entering Tier 2 carrying a Tier-1 cap of 50 would hand a DOWNGRADED
  // employer expandTier2's top band (10) rather than the initial band (3);
  // re-entering Tier 1 carrying a Tier-2 cap of 3 would cut an UPGRADED
  // employer below the 10 slots a fresh Tier 1 is granted. So a slot count
  // earned on a different tier's ladder is treated as no ladder position
  // at all, and the employer starts that tier fresh.
  //
  // An ABSENT prior tier still counts as returning: that is the state of
  // every employer written before this field existed, and demoting them
  // all to a fresh grant would move caps nobody chose. Same fail-direction
  // reasoning as initialSlotsForEmployerTier in functions/src/index.ts.
  const priorTier = typeof employer.tier === "number" ? employer.tier : null;
  const isReturningOnTier = (ladder) =>
    currentSlots > 0 && (priorTier === null || priorTier === ladder);

  let maxActiveSlots = 0;
  let requiresApproval = false;
  // Populated only when ADR-007's hybrid growth actually ran, so a credit
  // event (and the cycles it forfeited) is observable to the caller that
  // persists and audit-logs it, rather than being silently folded into a
  // single new number.
  let slotGrowth = null;
  if (tier === 1) {
    if (isReturningOnTier(1)) {
      const autoScale = autoScaleTier1(currentSlots, cyclesSinceReview);
      maxActiveSlots = autoScale.newSlots;
      requiresApproval = autoScale.requiresManualReview;
      slotGrowth = {
        cyclesConsidered: cyclesSinceReview,
        incrementsCredited: autoScale.incrementsCredited,
        cyclesForfeited: autoScale.cyclesForfeited,
        slotsBefore: currentSlots,
        slotsAfter: autoScale.newSlots,
      };
    } else {
      maxActiveSlots = computeInitialSlots(1);
    }
  } else if (tier === 2) {
    requiresApproval = true;
    maxActiveSlots = isReturningOnTier(2)
      ? expandTier2(currentSlots, lifetimeCleanCycles).newSlots
      : computeInitialSlots(2);
  }

  const reason = pass
    ? null
    : `Employer rejected: score ${score} below the Tier 2 threshold of ${TIER_2_THRESHOLD}`;

  log.info({ stage: "employer-b", rfc, score, tier, pass }, "Employer scoring complete");

  if (employer.employerId) {
    const db = getFirestore();
    const ref = db.collection("employers").doc(employer.employerId);
    // ADR-008: an ops-approved expansion (updateEmployerTier's
    // `approve_expansion`, which tags `maxActiveSlotsSource: 'ops_override'`)
    // outranks this automated re-score. Read the stored source inside a
    // transaction and leave `maxActiveSlots` alone when ops owns it —
    // otherwise this write silently reverts a human decision on the next
    // due-diligence run. Everything else (score, tier, timestamps) is still
    // refreshed. A MISSING source is NOT an override.
    //
    // This write is guarded, not left to throw: score/tier/maxActiveSlots
    // above are already fully computed from Part A + IMSS signals in hand,
    // and this transaction only persists an audit trail plus the cache the
    // NEXT due-diligence run reads. Before this guard, a Firestore outage
    // here rejected the whole function, which decision-engine.js's stage
    // try/catch turned into `results.employerB = {pass:false, reason:
    // "STAGE_ERROR"}` — and decision-engine.js:111 answers THAT with
    // `decision: "rejected", reason: "EMPLOYER_SCORE_LOW"`, a specific,
    // plausible-sounding business reason for what was actually a database
    // hiccup unrelated to the employer's creditworthiness. A correctly
    // scored, Tier 1 employer's employees would be denied loans on a
    // "score too low" reason that was never true. Persistence failing here
    // must cost the next run its fresh cache, not this applicant their
    // decision.
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const opsOwnsCap = (snap.data() || {}).maxActiveSlotsSource === "ops_override";
        const update = {
          employerScore: score,
          tier: pass ? tier : null,
          tierAssignedAt: FieldValue.serverTimestamp(),
          lastDueDiligenceAt: FieldValue.serverTimestamp(),
          dueDiligenceResult: { pass, tier, score },
        };
        if (!opsOwnsCap) {
          update.maxActiveSlots = maxActiveSlots;
          update.maxActiveSlotsSource = "due_diligence";
        }
        tx.update(ref, update);
      });
    } catch (err) {
      log.error(
        { stage: "employer-b", rfc, employerId: employer.employerId, err: err.message },
        "Failed to persist due-diligence result to Firestore — returning the already-computed result anyway"
      );
    }
  }

  return {
    pass,
    tier,
    score,
    maxActiveSlots,
    // null unless ADR-007 hybrid growth ran this review. See the ledger
    // comment above; requestLoan persists and audit-logs this.
    slotGrowth,
    signals,
    requiresApproval,
    reason,
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
  // Weighted scoring engine — see WEIGHTS' own comment.
  WEIGHTS,
  scoreSATAge,
  scoreDENUE,
  scoreIMSSEmployees,
  scoreFiscalDebt,
  scorePresunto,
  scoreSectorRisk,
  scorePayrollHistory,
};
