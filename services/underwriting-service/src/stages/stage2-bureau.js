"use strict";
/**
 * stage2-bureau.js
 * Stage 2: Bureau + Employment verification.
 *
 * Calls two external providers in parallel:
 *   1. Belvo IMSS — employment verification (tenure, employer match, AFORE)
 *   2. SoftCrédito — CDC/BDC bureau scoring + PLD
 *
 * Then calculates LTI and calls ML models (champion + challenger).
 *
 * Outputs:
 *   - IMSS employment status (reject if no record)
 *   - Bureau decision with stage escalation
 *   - LTI ratio
 *   - ML P(default) scores
 */
const { getIMSSEmployment, getAFORE } = require("../belvo-client");
const { callUnderwrite, parseBureauDecision, parsePLD } = require("../../../softcredito-adapter/src/underwrite");
const fetch = require("node-fetch");

const ML_BASE = () => process.env.ML_SERVICE_URL || "http://localhost:8000";
const ML_AUTH = () => ({ "x-internal-secret": process.env.INTERNAL_SECRET || "" });

/**
 * Call ML champion model (WoE scorecard) via POST /score/credit.
 * Returns P(default) calibrated via Platt scaling.
 */
async function callChampionModel(features) {
  try {
    const res = await fetch(`${ML_BASE()}/score/credit`, {
      method: "POST",
      headers: { ...ML_AUTH(), "Content-Type": "application/json" },
      body: JSON.stringify({ model: "champion", ...features }),
      timeout: 15000,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ML champion ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } catch (e) {
    console.error("[stage2] Champion model error:", e.message);
    return { pDefault: null, error: e.message };
  }
}

/**
 * Call ML challenger model (XGBoost) in shadow mode.
 * Logged but NOT used for decisions yet.
 */
async function callChallengerModel(features) {
  try {
    const res = await fetch(`${ML_BASE()}/score/credit`, {
      method: "POST",
      headers: { ...ML_AUTH(), "Content-Type": "application/json" },
      body: JSON.stringify({ model: "challenger", ...features }),
      timeout: 15000,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ML challenger ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } catch (e) {
    console.error("[stage2] Challenger model error (shadow):", e.message);
    return { pDefault: null, error: e.message };
  }
}

/**
 * Parse IMSS employment records from Belvo response.
 * Returns standardized employment data.
 */
function parseIMSSEmployment(records, employerRfc) {
  if (!records || records.length === 0) {
    return {
      found: false,
      active: false,
      pass: false,
      reason: "no_imss_record",
    };
  }

  const latest = records[0];
  const active = !!latest.status && latest.status.toLowerCase() !== "inactivo";
  const employerMatch = latest.employer_rfc === employerRfc;
  const tenureMonths = latest.tenure_months || 0;

  return {
    found: true,
    active,
    employerMatch,
    tenureMonths,
    baseSalary: latest.base_salary || null,
    employerRfc: latest.employer_rfc || null,
    pass: active,
    reason: active ? null : "imss_inactive",
  };
}

/**
 * Parse AFORE contribution regularity from Belvo response.
 */
function parseAFOREContributions(aforeData) {
  if (!aforeData || aforeData.length === 0) {
    return { regular: false, balance: 0 };
  }
  const latest = aforeData[0];
  return {
    regular: true,
    balance: latest.total_balance || 0,
  };
}

/**
 * Calculate Loan-to-Income ratio.
 * LTI > 0.25 → fails Stage 3 auto-approve condition.
 */
function calculateLTI(loanAmount, monthlyNetIncome) {
  if (!monthlyNetIncome || monthlyNetIncome <= 0) return Infinity;
  return loanAmount / monthlyNetIncome;
}

/**
 * Run Stage 2: Bureau + Employment verification.
 *
 * @param {object} params
 * @param {string} params.curp - Employee CURP
 * @param {string} params.rfc - Employee RFC
 * @param {string} params.nombre - First name
 * @param {string} params.apellidoPaterno - Paternal surname
 * @param {string} params.apellidoMaterno - Maternal surname
 * @param {string} params.fechaNacimiento - Date of birth (YYYY-MM-DD)
 * @param {string} params.employerRfc - Employer RFC for match verification
 * @param {number} params.loanAmount - Requested loan amount
 * @param {number} params.monthlyNetIncome - Monthly net income
 * @param {object} [params.mlFeatures] - Additional ML feature inputs
 * @returns {object} Stage 2 result with employment, bureau, LTI, and ML scores
 */
async function runStage2({
  curp, rfc, nombre, apellidoPaterno, apellidoMaterno, fechaNacimiento,
  employerRfc, loanAmount, monthlyNetIncome, mlFeatures = {},
}) {
  // ── 1. Call Belvo IMSS + SoftCrédito in parallel ──────────────────────
  const [imssResult, aforeResult, scResponse] = await Promise.all([
    getIMSSEmployment(curp).catch(e => {
      console.error("[stage2] Belvo IMSS error:", e.message);
      return null;
    }),
    getAFORE(curp).catch(e => {
      console.error("[stage2] Belvo AFORE error:", e.message);
      return null;
    }),
    callUnderwrite({ curp, rfc, nombre, apellidoPaterno, apellidoMaterno, fechaNacimiento }),
  ]);

  // ── 2. Parse IMSS employment ──────────────────────────────────────────
  const employment = parseIMSSEmployment(imssResult, employerRfc);
  if (!employment.found) {
    return {
      stage: 2,
      decision: "rejected",
      reason: "no_imss_record",
      employment,
      bureau: null,
      pld: null,
      lti: null,
      ml: null,
    };
  }

  // ── 3. Parse AFORE contributions ──────────────────────────────────────
  const afore = parseAFOREContributions(aforeResult);

  // ── 4. Parse bureau decision ──────────────────────────────────────────
  const bureau = parseBureauDecision(scResponse);
  const pld = parsePLD(scResponse);

  if (pld.hardReject) {
    return {
      stage: 2,
      decision: "rejected",
      reason: pld.reason,
      employment,
      afore,
      bureau,
      pld,
      lti: null,
      ml: null,
    };
  }

  // ── 5. Calculate LTI ──────────────────────────────────────────────────
  const lti = calculateLTI(loanAmount, monthlyNetIncome);

  // ── 6. Call ML models (champion + challenger in parallel) ─────────────
  const features = {
    curp,
    bureauScore: bureau.score,
    diasAtraso: bureau.diasAtraso,
    tenureMonths: employment.tenureMonths,
    monthlyNetIncome,
    loanAmount,
    lti,
    ...mlFeatures,
  };

  const [champion, challenger] = await Promise.all([
    callChampionModel(features),
    callChallengerModel(features),
  ]);

  console.log("[stage2] Challenger shadow result:", JSON.stringify(challenger));

  const ml = {
    champion: {
      pDefault: champion.pDefault ?? null,
      model: "woe_scorecard",
      error: champion.error || null,
    },
    challenger: {
      pDefault: challenger.pDefault ?? null,
      model: "xgboost",
      error: challenger.error || null,
      shadow: true,
    },
  };

  // ── 7. Determine stage escalation ─────────────────────────────────────
  const escalateToStage = bureau.escalateToStage;

  return {
    stage: 2,
    decision: escalateToStage === 3 ? "continue" : "escalate",
    escalateToStage,
    reason: bureau.reason,
    employment,
    afore,
    bureau,
    pld,
    lti,
    ml,
  };
}

module.exports = {
  runStage2,
  parseIMSSEmployment,
  parseAFOREContributions,
  calculateLTI,
  callChampionModel,
  callChallengerModel,
};
