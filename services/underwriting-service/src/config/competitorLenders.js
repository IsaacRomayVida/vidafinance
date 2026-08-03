"use strict";
/**
 * competitorLenders.js — the competitor-lender list as CONFIGURATION.
 *
 * ADR-005 Finding 7 / Decision item 7: three brand names hardcoded in a
 * credit gate go stale the week a fourth lender launches, and refreshing
 * them must not require a deploy. This follows the SAME seam ADR-002 built
 * for the loan fee rate (functions/src/config/loanConfig.ts,
 * getLoanConfigValues): a compile-time SEED, a single Firestore document,
 * and a read path that returns the seed when the document does not exist
 * yet and THROWS — rather than silently substituting the seed — when the
 * document exists but cannot be trusted.
 *
 * SCOPE: this is the seam only. ADR-005 C5 ratified that a competitor loan
 * blocks auto-approval only (never a hard decline) and left two things open:
 * which lenders count, and whether `no_competitor_loans` should read this
 * named-match signal at all instead of the opaque SoftCrédito count. ADR-006
 * (2026-08-03) ratified the seeded list below as-is and closed both:
 * `stage3-autoapprove.js`'s `no_competitor_loans` condition now reads
 * `competitorLoansByName` (derived in stage2-bureau.js from this module),
 * not the opaque count.
 */

const admin = require("firebase-admin");

// Incumbent, NOT ratified (ADR-005 C5) — carried over verbatim from the
// hardcoded list this config replaces, so switching the mechanism does not,
// by itself, change who is currently detected as a competitor.
const SEED_COMPETITOR_LENDERS = Object.freeze(["KUESKI", "MoneyMan", "CREDITEA"]);

const COMPETITOR_CONFIG_COLLECTION = "config";
const COMPETITOR_CONFIG_DOC_ID = "competitorLenders";
const COMPETITOR_CONFIG_DOC_PATH = `${COMPETITOR_CONFIG_COLLECTION}/${COMPETITOR_CONFIG_DOC_ID}`;

/** Thrown by the read path when the stored config cannot be trusted. */
class CompetitorConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "CompetitorConfigError";
  }
}

/** The compile-time seed, returned verbatim when the config document does not exist yet. */
function getSeedCompetitorLenders() {
  return [...SEED_COMPETITOR_LENDERS];
}

/**
 * The single read path for the competitor-lender list, mirroring
 * getLoanConfigValues(): document missing -> seed; document present and
 * valid -> the stored list; anything else -> THROW.
 *
 * There is no fourth branch that falls back to the seed on a read or parse
 * failure. An admin may have deliberately edited or emptied the list;
 * silently reverting to the seed on an unreadable document would resurrect
 * a lender someone removed, the same failure class getLoanConfigValues()
 * refuses for the fee rate.
 */
async function getCompetitorLenderNames() {
  const seed = getSeedCompetitorLenders();

  let snapshot;
  try {
    snapshot = await admin
      .firestore()
      .collection(COMPETITOR_CONFIG_COLLECTION)
      .doc(COMPETITOR_CONFIG_DOC_ID)
      .get();
  } catch (err) {
    throw new CompetitorConfigError(
      `Competitor-lender config at ${COMPETITOR_CONFIG_DOC_PATH} could not be read: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }

  if (!snapshot.exists) {
    return seed;
  }

  const data = snapshot.data();
  const names = data && data.names;
  if (!Array.isArray(names) || names.length === 0 || names.some((n) => typeof n !== "string" || !n.trim())) {
    throw new CompetitorConfigError(
      `Competitor-lender config at ${COMPETITOR_CONFIG_DOC_PATH} exists but 'names' is not a ` +
        "non-empty array of non-empty strings"
    );
  }

  return names;
}

/**
 * Normalises a string for competitor-name matching: case-insensitive,
 * accent/diacritic-insensitive, and collapsed to single-space-separated
 * alphanumeric words so surrounding legal-entity noise ("SAPI DE CV") cannot
 * change whether a brand token matches.
 */
function normalizeForMatch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/**
 * Whether `creditorName` names one of `competitorNames`.
 *
 * Deliberately NOT `normalized.includes(token)`. A plain substring test
 * matches a short brand token inside an unrelated word — e.g. a future
 * token "AEF" would false-positive on "BANCO AEFISA MEXICO" — and the whole
 * point of making this list admin-editable is that someone can add a short
 * token later without touching this function. Instead both sides are
 * normalised to space-separated words and padded with a leading/trailing
 * space, so the check is for the token as a whole word (or contiguous word
 * sequence) bounded on both sides, never as part of a longer one.
 */
function matchesCompetitorLender(creditorName, competitorNames) {
  const normalizedName = normalizeForMatch(creditorName);
  if (!normalizedName) return false;
  const padded = ` ${normalizedName} `;
  return (competitorNames || []).some((token) => {
    const normalizedToken = normalizeForMatch(token);
    return normalizedToken.length > 0 && padded.includes(` ${normalizedToken} `);
  });
}

/**
 * Whether `accounts` (bureau accounts, each carrying an `otorgante` —
 * see stage2-bureau.js's normalizeBureauAccount — or a raw `nombreOtorgante`)
 * includes a competitor loan. A thin, synchronous wrapper around
 * `matchesCompetitorLender` for callers that have a whole account list
 * rather than one creditor name at a time; defaults to the compile-time
 * seed so it is usable without a Firestore round trip.
 */
function hasCompetitorLoans(accounts, competitorNames = getSeedCompetitorLenders()) {
  if (!Array.isArray(accounts) || accounts.length === 0) return false;
  return accounts.some((acct) =>
    matchesCompetitorLender(acct?.otorgante ?? acct?.nombreOtorgante, competitorNames)
  );
}

module.exports = {
  SEED_COMPETITOR_LENDERS,
  COMPETITOR_CONFIG_COLLECTION,
  COMPETITOR_CONFIG_DOC_ID,
  COMPETITOR_CONFIG_DOC_PATH,
  CompetitorConfigError,
  getSeedCompetitorLenders,
  getCompetitorLenderNames,
  normalizeForMatch,
  matchesCompetitorLender,
  hasCompetitorLoans,
};
