"use strict";
/**
 * maxPDefaultCutoff.js — the Stage 3 auto-approve P(default) cutoff as
 * CONFIGURATION.
 *
 * ADR-005 Finding 5 / Decision item 5 declares the cutoff directly as
 * MAX_PDEFAULT instead of deriving it from APPROVAL_THRESHOLD. This module
 * makes it server-side configurable without a deploy, following the SAME
 * seam ADR-002 built for the loan fee rate
 * (functions/src/config/loanConfig.ts, getLoanConfigValues) and
 * src/config/competitorLenders.js already follows for the competitor list: a
 * compile-time SEED, a single Firestore document, and a read path that
 * returns the seed when the document does not exist yet and THROWS — rather
 * than silently substituting the seed — when the document exists but cannot
 * be trusted.
 *
 * SCOPE: this is the seam only. The cutoff VALUE (0.35) is the incumbent,
 * unratified commercial number ADR-005 C3 leaves with Isaac — switching the
 * mechanism by which it is read does not, by itself, change which
 * applicants auto-approve.
 */

const admin = require("firebase-admin");

// Incumbent, NOT ratified (ADR-005 C3) — carried over verbatim from the
// derived value this config replaces (1 - the old APPROVAL_THRESHOLD default
// of 0.65), so switching the mechanism does not, by itself, change who is
// currently auto-approved.
const SEED_MAX_PDEFAULT = 0.35;

const MAX_PDEFAULT_CONFIG_COLLECTION = "config";
const MAX_PDEFAULT_CONFIG_DOC_ID = "maxPDefault";
const MAX_PDEFAULT_CONFIG_DOC_PATH = `${MAX_PDEFAULT_CONFIG_COLLECTION}/${MAX_PDEFAULT_CONFIG_DOC_ID}`;

/** Thrown by the read path when the stored config cannot be trusted. */
class MaxPDefaultConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "MaxPDefaultConfigError";
  }
}

/** The compile-time seed, returned verbatim when the config document does not exist yet. */
function getSeedMaxPDefault() {
  return SEED_MAX_PDEFAULT;
}

/**
 * Domain validity only — NOT a commercial bound. A P(default) cutoff is a
 * probability threshold, so it must be a finite number in (0, 1]: 0 would
 * decline every applicant on this condition and 1 would clear it for
 * everyone, but both are structurally valid thresholds, not malformed data.
 * Anything outside that range cannot be a probability cutoff at all and is
 * rejected the same way an out-of-range fee rate is in loanConfig.ts.
 */
function assertValidMaxPDefault(value, context) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new MaxPDefaultConfigError(
      `${context}: value must be a finite number in (0, 1], got ${JSON.stringify(value)}`
    );
  }
  return value;
}

/**
 * The single read path for the P(default) cutoff, mirroring
 * getCompetitorLenderNames()/getLoanConfigValues(): document missing -> seed;
 * document present and valid -> the stored value; anything else -> THROW.
 *
 * There is no fourth branch that falls back to the seed on a read or parse
 * failure. An admin may have deliberately tightened or loosened the cutoff;
 * reverting to the seed on an unreadable document would silently move
 * credit policy nobody chose for this read. The caller (stage3-autoapprove.js)
 * does not catch this error either — a Stage 3 evaluation that cannot read
 * its own cutoff escalates to manual review rather than approving on a
 * value nobody confirmed (ADR-005 Finding 8: a pipeline that cannot see a
 * value must refuse rather than approve blind).
 */
async function getMaxPDefault() {
  let snapshot;
  try {
    snapshot = await admin
      .firestore()
      .collection(MAX_PDEFAULT_CONFIG_COLLECTION)
      .doc(MAX_PDEFAULT_CONFIG_DOC_ID)
      .get();
  } catch (err) {
    throw new MaxPDefaultConfigError(
      `MAX_PDEFAULT config at ${MAX_PDEFAULT_CONFIG_DOC_PATH} could not be read: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }

  if (!snapshot.exists) {
    return getSeedMaxPDefault();
  }

  const data = snapshot.data();
  if (!data || typeof data !== "object") {
    throw new MaxPDefaultConfigError(
      `MAX_PDEFAULT config at ${MAX_PDEFAULT_CONFIG_DOC_PATH} exists but has no data`
    );
  }

  return assertValidMaxPDefault(data.value, `MAX_PDEFAULT config at ${MAX_PDEFAULT_CONFIG_DOC_PATH}`);
}

module.exports = {
  SEED_MAX_PDEFAULT,
  MAX_PDEFAULT_CONFIG_COLLECTION,
  MAX_PDEFAULT_CONFIG_DOC_ID,
  MAX_PDEFAULT_CONFIG_DOC_PATH,
  MaxPDefaultConfigError,
  getSeedMaxPDefault,
  assertValidMaxPDefault,
  getMaxPDefault,
};
