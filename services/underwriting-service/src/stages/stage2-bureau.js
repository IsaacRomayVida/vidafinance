"use strict";
/**
 * Stage 2: Bureau & Employment Verification
 *
 * Checks:
 *   1. Belvo IMSS employment verification + AFORE regularity
 *   2. Bureau scores (via ML service SoftCrédito adapter)
 *   3. LTI (loan-to-income) calculation
 *   4. Champions model (WoE LR) + Challenger (XGBoost) via ML service
 */
const { getIMSSEmployment, getAFORE } = require("../belvo-client");
const { getCompetitorLenderNames, matchesCompetitorLender } = require("../config/competitorLenders");

const ML_SERVICE_URL = () => process.env.ML_SERVICE_URL || "http://localhost:3005";
const SOFTCREDITO_URL = () => process.env.SOFTCREDITO_ADAPTER_URL || "http://localhost:3004";

async function fetchBureauScore(applicant) {
  const fetch = require("node-fetch");
  const res = await fetch(`${SOFTCREDITO_URL()}/bureau/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": process.env.ML_INTERNAL_SECRET || process.env.INTERNAL_SECRET || "",
    },
    body: JSON.stringify({
      curp: applicant.curp,
      fullName: applicant.fullName,
      dateOfBirth: applicant.dateOfBirth || "1990-01-01",
      rfc: applicant.rfc,
    }),
    timeout: 30000,
  });
  if (!res.ok) throw new Error(`Bureau query ${res.status}`);
  return res.json();
}

async function fetchMLScore(features) {
  const fetch = require("node-fetch");
  const res = await fetch(`${ML_SERVICE_URL()}/score`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": process.env.ML_INTERNAL_SECRET || process.env.INTERNAL_SECRET || "",
    },
    body: JSON.stringify(features),
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`ML score ${res.status}`);
  return res.json();
}

/**
 * Normalises one bureau account's creditor-name field to a SINGLE name,
 * `otorgante` — Buró de Crédito's own term for the field ("grantor"), not an
 * integrator's rename. This is the adapter boundary ADR-005 Finding 7 says
 * never settled: the never-executed spec matched `otorgante` OR
 * `nombreOtorgante` because nobody picked one. Both spellings are tolerated
 * on INPUT, since a real upstream payload may use either; exactly one is
 * emitted on OUTPUT, so every downstream consumer — including
 * matchesCompetitorLender below — reads a single field and never has to
 * guess again.
 */
function normalizeBureauAccount(rawAccount) {
  if (!rawAccount || typeof rawAccount !== "object") return rawAccount;
  const { otorgante, nombreOtorgante, ...rest } = rawAccount;
  return { ...rest, otorgante: otorgante || nombreOtorgante || null };
}

/**
 * Pay periods per month, as the ML model's `pay_frequency_encoded` feature.
 *
 * `biweekly` (every 14 days) and `semimonthly` (the 15th and the last day) are
 * both TWICE A MONTH for this feature's purpose, so both encode as 2.
 *
 * This was a ternary with an implicit `else` — `weekly ? 4 : biweekly ? 2 : 1`.
 * That was survivable only while `semimonthly` could not be written. #435 made
 * it selectable at onboarding (the tile reading "Quincenal" used to store
 * `biweekly`), and from that moment every borrower paid on the 15th fell
 * through to 1 and was scored as if paid monthly — understating how often a
 * borrower is paid, silently, inside a credit decision.
 *
 * Note what that implies about the bug it replaced: while "Quincenal" stored
 * `biweekly`, this feature was accidentally RIGHT (2) and the deduction date
 * was wrong. Correcting the cadence without correcting this line swapped which
 * half was broken rather than fixing either. The map is explicit so the next
 * cadence added cannot repeat it.
 */
const PAY_PERIODS_PER_MONTH = Object.freeze({
  weekly: 4,
  biweekly: 2,
  semimonthly: 2,
  monthly: 1,
});

/**
 * Unknown cadences still score as monthly — an application must not fail on an
 * unrecognised enum — but they are LOGGED. A silent default is what let this
 * run; a noisy one is a bug report.
 */
function encodePayFrequency(payFrequency, log) {
  const encoded = PAY_PERIODS_PER_MONTH[payFrequency];
  if (encoded === undefined) {
    log.warn({ stage: "stage2", payFrequency }, "Unknown pay frequency — scoring as monthly");
    return PAY_PERIODS_PER_MONTH.monthly;
  }
  return encoded;
}

function computeLTI(principalAmount, monthlySalary, existingDeductions = 0) {
  const netIncome = monthlySalary - existingDeductions;
  if (netIncome <= 0) return 100; // 100% = over-leveraged
  return Math.round((principalAmount / netIncome) * 100 * 100) / 100; // percentage with 2 decimals
}

async function runBureauAndEmployment(applicant, priorResults, { logger } = {}) {
  const log = logger || console;
  const costItems = [];

  log.info({ stage: "stage2", rfc: applicant.rfc }, "Starting bureau & employment");

  const data = {};

  // 1. IMSS Employment verification
  let imssResult;
  try {
    imssResult = await getIMSSEmployment(applicant.curp);
    costItems.push({ api: "belvo-imss-employment", mxn: 3.0 });
    const latest = Array.isArray(imssResult) ? imssResult[0] : imssResult;
    data.imss = {
      active: !!latest,
      sbc: latest?.base_salary || latest?.sbc || null,
      tenureMonths: latest?.tenure_months || latest?.tenureMonths || null,
      employerRfc: latest?.employer_rfc || latest?.employerRfc || null,
      raw: latest,
    };
  } catch (err) {
    const belvoDetail = err.belvoDetail || null;
    log.warn(
      {
        stage: "stage2",
        err: err.message || "(empty message)",
        belvoDetail,
        stack: err.stack,
      },
      "IMSS check failed — full error captured"
    );
    data.imss = {
      active: false,
      skipped: true,
      error: err.message || "(empty message)",
      belvoDetail,
    };
  }

  // 2. AFORE regularity
  let aforeResult;
  try {
    aforeResult = await getAFORE(applicant.curp);
    costItems.push({ api: "belvo-afore", mxn: 2.0 });
    const records = Array.isArray(aforeResult) ? aforeResult : [aforeResult];
    const totalBalance = records.reduce((sum, r) => sum + (r.balance || r.total || 0), 0);
    data.afore = {
      balance: totalBalance,
      regular: totalBalance > 0,
      raw: records[0],
    };
  } catch (err) {
    const belvoDetail = err.belvoDetail || null;
    log.warn(
      {
        stage: "stage2",
        err: err.message || "(empty message)",
        belvoDetail,
        stack: err.stack,
      },
      "AFORE check failed — full error captured"
    );
    data.afore = {
      balance: 0,
      regular: false,
      skipped: true,
      error: err.message || "(empty message)",
      belvoDetail,
    };
  }

  // 3. Bureau score (SoftCrédito CDC + BDC)
  let bureauResult;
  try {
    bureauResult = await fetchBureauScore(applicant);
    costItems.push({ api: "softcredito", mxn: 8.0 });
    const rawAccounts = bureauResult.cuentas || bureauResult.accounts || [];
    data.bureau = {
      score: bureauResult.bureau_score || bureauResult.score || 500,
      hasBureauRecord: bureauResult.has_bureau_record ?? true,
      activeDefaults: bureauResult.active_defaults || 0,
      competitorLoans: bureauResult.competitor_loans || 0,
      accounts: (Array.isArray(rawAccounts) ? rawAccounts : []).map(normalizeBureauAccount),
      raw: bureauResult,
    };
  } catch (err) {
    log.warn({ stage: "stage2", err: err.message }, "Bureau check failed — using defaults");
    data.bureau = {
      score: 500,
      hasBureauRecord: false,
      activeDefaults: 0,
      competitorLoans: 0,
      accounts: [],
      skipped: true,
      error: err.message,
    };
  }

  // 3b. Competitor-loan detection by creditor name — DERIVED, NOT GATING.
  //
  // ADR-005 Finding 7: `data.bureau.competitorLoans` above is an opaque
  // count SoftCrédito hands back; nothing has ever matched a creditor NAME
  // against a competitor list. This builds that capability —
  // `competitorLoansByName` — so a future caller COULD compare it against
  // the opaque count. It intentionally is not wired anywhere yet: whether a
  // competitor loan blocks approval, and which lenders count, is credit
  // policy reserved for Isaac (ADR-005 commercial C5), and
  // stage3-autoapprove.js's `no_competitor_loans` condition still reads only
  // the opaque count above, unchanged.
  //
  // Skipped entirely when the bureau block itself is `skipped` (failed
  // fetch): with no accounts read, "zero competitor matches" would be
  // fabricated, not observed — the same distinction stage3-autoapprove.js's
  // condition 5 comment draws for the opaque count's error stub.
  if (!data.bureau.skipped) {
    if (data.bureau.accounts.length === 0) {
      // No accounts to check is not "we don't know" — it is "there is
      // nothing here that could match", same reasoning stage3-autoapprove.js
      // condition 5 already applies to the opaque count on an empty report.
      data.bureau.competitorLoansByName = 0;
    } else {
      try {
        const competitorNames = await getCompetitorLenderNames();
        data.bureau.competitorLoansByName = data.bureau.accounts.filter((acct) =>
          matchesCompetitorLender(acct.otorgante, competitorNames)
        ).length;
      } catch (err) {
        log.warn(
          { stage: "stage2", err: err.message },
          "Competitor-lender config unavailable — skipping name-based match"
        );
      }
    }
  }

  // 4. LTI calculation
  //
  // ADR-005 Finding 4: this quantity gets computed twice, ten lines apart, in
  // two different units, and neither was named — the exact setup for a future
  // "dedup" that mixes a percentage into a fraction and ships a 100x credit
  // bug. `ltiPercent` (here) and `ltiRatio` (below, for the ML feature) are
  // now named distinctly on purpose; do not collapse them into one variable.
  const infonavitDeduction = priorResults?.stage0?.data?.infonavitDeduction || 0;
  const monthlySalary = data.imss.sbc || applicant.monthlySalary || 0;
  const ltiPercent = computeLTI(applicant.principalAmount || 0, monthlySalary, infonavitDeduction);
  // `value` is the field name kept for compatibility: `data.lti` is serialized
  // wholesale across the /underwrite HTTP boundary into `functions`
  // (index.js's response includes `stages`) and `value` is asserted directly
  // by decision-engine.test.js and read by stage3-autoapprove.js. Do not
  // rename or remove it. `ltiPercent` is the same number, explicitly named,
  // for any new consumer.
  data.lti = {
    value: ltiPercent,
    ltiPercent,
    monthlySalary,
    infonavitDeduction,
    principalAmount: applicant.principalAmount,
  };

  // Percentage-vs-fraction of the same LTI quantity, computed separately for
  // the ML feature (ml-service consumes LTI as a fraction throughout — see
  // ADR-005 Finding 4). This is intentionally NOT derived from `ltiPercent`
  // (e.g. `ltiPercent / 100`) so a rounding or unit change on one side cannot
  // silently move the other; they are two independent expressions of the same
  // ratio, named so nobody mistakes one for the other.
  const ltiRatio = monthlySalary > 0 ? (applicant.principalAmount || 0) / monthlySalary : 0;

  // 5. ML model score (Champions LR + Challenger XGBoost)
  let mlScore;
  try {
    mlScore = await fetchMLScore({
      employment_tenure_months: data.imss.tenureMonths || applicant.employmentTenureMonths || 0,
      monthly_salary: monthlySalary,
      pay_frequency_encoded: encodePayFrequency(applicant.payFrequency, log),
      loan_to_salary_ratio: ltiRatio,
      employer_industry_encoded: applicant.industryCode || 0,
      principal_amount: applicant.principalAmount || 0,
      bureau_score: data.bureau.score,
      has_bureau_record: data.bureau.hasBureauRecord ? 1 : 0,
    });
    data.mlScore = mlScore;
  } catch (err) {
    log.warn({ stage: "stage2", err: err.message }, "ML scoring failed");
    data.mlScore = { skipped: true, error: err.message };
  }

  // Stage 2 always passes — decision is in Stage 3
  return {
    pass: true,
    escalateToStage: null,
    reason: null,
    data,
    cost: costItems,
  };
}

module.exports = {
  runBureauAndEmployment,
  computeLTI,
  encodePayFrequency,
  PAY_PERIODS_PER_MONTH,
  normalizeBureauAccount,
};
