"use strict";
/**
 * lendingSlotGrowth.js — the Tier 1 lending-slot hybrid-growth tunables as
 * CONFIGURATION.
 *
 * ADR-007 (superseding ADR-003) ratifies the hybrid growth rule for Tier 1
 * employers: +10 slots earned per clean payroll cycle, credited only at a
 * due-diligence review, capped at 2 increments (20 slots) per review, never
 * exceeding the 100-slot Tier 1 ceiling. This module makes the three numbers
 * that encode that rule — increment size, per-review cap, and ceiling —
 * server-side configurable without a deploy, following the SAME seam
 * ADR-002 built for the loan fee rate (functions/src/config/loanConfig.ts,
 * getLoanConfigValues) and src/config/competitorLenders.js /
 * src/config/maxPDefaultCutoff.js already follow: a compile-time SEED, a
 * single Firestore document, and a read path that returns the seed when the
 * document does not exist yet and THROWS — rather than silently
 * substituting the seed — when the document exists but cannot be trusted.
 *
 * SCOPE: this is the seam only. The values themselves (10 / 2 / 100) ARE the
 * ratified commercial rule (Isaac, voice, 2026-08-03 — see ADR-007), unlike
 * competitorLenders.js/maxPDefaultCutoff.js where the seam was built ahead
 * of ratification. Moving them into Firestore does not change what was
 * ratified; it means changing them again later does not require a deploy.
 */

const admin = require("firebase-admin");

// Ratified (ADR-007): +10 slots per clean payroll cycle.
const SEED_SLOT_INCREMENT = 10;

// Ratified (ADR-007): max 2 increments (= 20 slots) credited per review —
// Isaac's words, "let's do two max" — so a weekly-payroll employer cannot
// outrun our own oversight cadence.
const SEED_MAX_INCREMENTS_PER_REVIEW = 2;

// Unchanged from the original tier definition: Tier 1 auto-scales
// 10 -> 20 -> ... -> 100 and never beyond.
const SEED_TIER_1_MAX_AUTO_SLOTS = 100;

const SLOT_GROWTH_CONFIG_COLLECTION = "config";
const SLOT_GROWTH_CONFIG_DOC_ID = "lendingSlotGrowth";
const SLOT_GROWTH_CONFIG_DOC_PATH = `${SLOT_GROWTH_CONFIG_COLLECTION}/${SLOT_GROWTH_CONFIG_DOC_ID}`;

/** Thrown by the read path when the stored config cannot be trusted. */
class LendingSlotGrowthConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "LendingSlotGrowthConfigError";
  }
}

/** The compile-time seed, returned verbatim when the config document does not exist yet. */
function getSeedSlotGrowthConfig() {
  return {
    slotIncrement: SEED_SLOT_INCREMENT,
    maxIncrementsPerReview: SEED_MAX_INCREMENTS_PER_REVIEW,
    tier1MaxAutoSlots: SEED_TIER_1_MAX_AUTO_SLOTS,
  };
}

/**
 * Domain validity only — NOT a re-litigation of the ratified numbers. Each
 * field must be a positive integer, and the ceiling must be reachable from
 * a positive increment; that is the whole check. Whether 10/2/100 remain
 * the right numbers is Isaac's call, recorded in ADR-007, not this
 * function's.
 */
function assertValidSlotGrowthConfig(value, context) {
  const isPositiveInt = (n) => typeof n === "number" && Number.isInteger(n) && n > 0;

  if (
    !value ||
    typeof value !== "object" ||
    !isPositiveInt(value.slotIncrement) ||
    !isPositiveInt(value.maxIncrementsPerReview) ||
    !isPositiveInt(value.tier1MaxAutoSlots) ||
    value.tier1MaxAutoSlots < value.slotIncrement
  ) {
    throw new LendingSlotGrowthConfigError(
      `${context}: value must have positive integer slotIncrement, ` +
        "maxIncrementsPerReview, and tier1MaxAutoSlots >= slotIncrement, " +
        `got ${JSON.stringify(value)}`
    );
  }
  return {
    slotIncrement: value.slotIncrement,
    maxIncrementsPerReview: value.maxIncrementsPerReview,
    tier1MaxAutoSlots: value.tier1MaxAutoSlots,
  };
}

/**
 * The single read path for the slot-growth tunables, mirroring
 * getMaxPDefault()/getCompetitorLenderNames()/getLoanConfigValues():
 * document missing -> seed; document present and valid -> the stored
 * values; anything else -> THROW.
 *
 * There is no fourth branch that falls back to the seed on a read or parse
 * failure. An admin may have deliberately tightened the per-review cap or
 * raised the ceiling; reverting to the seed on an unreadable document would
 * silently move credit-exposure policy nobody chose for this read — the
 * same failure class getMaxPDefault() and getCompetitorLenderNames()
 * refuse.
 */
async function getSlotGrowthConfig() {
  const seed = getSeedSlotGrowthConfig();

  let snapshot;
  try {
    snapshot = await admin
      .firestore()
      .collection(SLOT_GROWTH_CONFIG_COLLECTION)
      .doc(SLOT_GROWTH_CONFIG_DOC_ID)
      .get();
  } catch (err) {
    throw new LendingSlotGrowthConfigError(
      `Slot-growth config at ${SLOT_GROWTH_CONFIG_DOC_PATH} could not be read: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }

  if (!snapshot.exists) {
    return seed;
  }

  const data = snapshot.data();
  if (!data || typeof data !== "object") {
    throw new LendingSlotGrowthConfigError(
      `Slot-growth config at ${SLOT_GROWTH_CONFIG_DOC_PATH} exists but has no data`
    );
  }

  return assertValidSlotGrowthConfig(data, `Slot-growth config at ${SLOT_GROWTH_CONFIG_DOC_PATH}`);
}

module.exports = {
  SEED_SLOT_INCREMENT,
  SEED_MAX_INCREMENTS_PER_REVIEW,
  SEED_TIER_1_MAX_AUTO_SLOTS,
  SLOT_GROWTH_CONFIG_COLLECTION,
  SLOT_GROWTH_CONFIG_DOC_ID,
  SLOT_GROWTH_CONFIG_DOC_PATH,
  LendingSlotGrowthConfigError,
  getSeedSlotGrowthConfig,
  assertValidSlotGrowthConfig,
  getSlotGrowthConfig,
};
