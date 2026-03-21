"use strict";
/**
 * stage3-autoapprove.js
 * Stage 3: Auto-Approve Gate — 10 conditions, ALL must pass.
 *
 * Conditions:
 *   1. Employer tier >= 1
 *   2. IMSS tenure > 6 months
 *   3. Bureau score > 600
 *   4. LTI <= 25%
 *   5. No competitor loans (from bureau cuentasActivas analysis)
 *   6. RiskSeal score > 60
 *   7. Sector not flagged (CNBV sector risk = safe)
 *   8. diasAtraso = 0
 *   9. carteraVencida = false
 *  10. XGBoost P(default) < approval threshold
 *
 * ALL 10 pass → Approve + Disburse (skip biometrics). ~55% approved here.
 * Any fail → Escalate to Stage 4.
 */

const APPROVAL_THRESHOLD = parseFloat(process.env.XGBOOST_APPROVAL_THRESHOLD || "0.15");
const COMPETITOR_KEYWORDS = [
  "kueski", "moneyman", "creditea", "dineria", "yotepresto",
  "konfio", "aspiria", "prestadero", "lendera", "coru",
];

/**
 * Analyze bureau cuentasActivas for competitor loans.
 * Returns true if competitor loans are found.
 */
function hasCompetitorLoans(cuentasActivas) {
  if (!cuentasActivas || !Array.isArray(cuentasActivas)) return false;
  return cuentasActivas.some(cuenta => {
    const name = (cuenta.otorgante || cuenta.nombreOtorgante || "").toLowerCase();
    return COMPETITOR_KEYWORDS.some(kw => name.includes(kw));
  });
}

/**
 * Evaluate all 10 auto-approve conditions.
 *
 * @param {object} params
 * @param {number} params.employerTier - Employer risk tier (1, 2, or 3)
 * @param {number} params.tenureMonths - IMSS tenure in months
 * @param {number} params.bureauScore - CDC/BDC score
 * @param {number} params.lti - Loan-to-income ratio
 * @param {Array}  params.cuentasActivas - Bureau active accounts for competitor check
 * @param {number} params.riskSealScore - RiskSeal digital footprint score
 * @param {boolean} params.sectorFlagged - CNBV sector risk flagged
 * @param {number} params.diasAtraso - Days past due from bureau
 * @param {boolean} params.carteraVencida - Past-due portfolio flag from bureau
 * @param {number|null} params.xgboostPDefault - XGBoost P(default) from challenger model
 * @returns {object} Gate result with individual condition outcomes
 */
function evaluateGate({
  employerTier,
  tenureMonths,
  bureauScore,
  lti,
  cuentasActivas,
  riskSealScore,
  sectorFlagged,
  diasAtraso,
  carteraVencida,
  xgboostPDefault,
}) {
  const conditions = [
    {
      id: 1,
      name: "employer_tier",
      pass: employerTier != null && employerTier >= 1 && employerTier <= 2,
      value: employerTier,
      rule: "employer tier >= 1 (not tier 3)",
    },
    {
      id: 2,
      name: "imss_tenure",
      pass: tenureMonths != null && tenureMonths > 6,
      value: tenureMonths,
      rule: "IMSS tenure > 6 months",
    },
    {
      id: 3,
      name: "bureau_score",
      pass: bureauScore != null && bureauScore > 600,
      value: bureauScore,
      rule: "bureau score > 600",
    },
    {
      id: 4,
      name: "lti",
      pass: lti != null && lti <= 0.25,
      value: lti,
      rule: "LTI <= 25%",
    },
    {
      id: 5,
      name: "no_competitor_loans",
      pass: !hasCompetitorLoans(cuentasActivas),
      value: cuentasActivas ? cuentasActivas.length : 0,
      rule: "no competitor loans in cuentasActivas",
    },
    {
      id: 6,
      name: "riskseal_score",
      pass: riskSealScore != null && riskSealScore > 60,
      value: riskSealScore,
      rule: "RiskSeal score > 60",
    },
    {
      id: 7,
      name: "sector_safe",
      pass: sectorFlagged === false,
      value: sectorFlagged,
      rule: "CNBV sector risk = safe (not flagged)",
    },
    {
      id: 8,
      name: "dias_atraso_zero",
      pass: diasAtraso === 0,
      value: diasAtraso,
      rule: "diasAtraso = 0",
    },
    {
      id: 9,
      name: "cartera_vencida_false",
      pass: carteraVencida === false,
      value: carteraVencida,
      rule: "carteraVencida = false",
    },
    {
      id: 10,
      name: "xgboost_pdefault",
      pass: xgboostPDefault != null && xgboostPDefault < APPROVAL_THRESHOLD,
      value: xgboostPDefault,
      rule: `XGBoost P(default) < ${APPROVAL_THRESHOLD}`,
    },
  ];

  const allPass = conditions.every(c => c.pass);
  const failures = conditions.filter(c => !c.pass);

  return {
    stage: 3,
    decision: allPass ? "approved" : "escalate",
    escalateToStage: allPass ? null : 4,
    allPass,
    conditionsPassed: conditions.filter(c => c.pass).length,
    conditionsTotal: conditions.length,
    failures: failures.map(f => ({ id: f.id, name: f.name, value: f.value, rule: f.rule })),
    conditions,
  };
}

/**
 * Run Stage 3: Auto-Approve Gate.
 *
 * Gathers inputs from Stage 2 results and additional lookups,
 * then evaluates all 10 conditions.
 *
 * @param {object} params
 * @param {object} params.stage2Result - Output from runStage2()
 * @param {number} params.employerTier - Employer risk tier
 * @param {number} params.riskSealScore - RiskSeal digital footprint score
 * @param {boolean} params.sectorFlagged - CNBV sector risk flagged
 * @param {Array}  [params.cuentasActivasDetail] - Detailed cuentasActivas from bureau
 * @returns {object} Auto-approve gate result
 */
function runStage3({
  stage2Result,
  employerTier,
  riskSealScore,
  sectorFlagged,
  cuentasActivasDetail = null,
}) {
  const { bureau, employment, lti, ml } = stage2Result;

  return evaluateGate({
    employerTier,
    tenureMonths: employment?.tenureMonths ?? null,
    bureauScore: bureau?.score ?? null,
    lti,
    cuentasActivas: cuentasActivasDetail,
    riskSealScore,
    sectorFlagged,
    diasAtraso: bureau?.diasAtraso ?? null,
    carteraVencida: bureau?.carteraVencida ?? null,
    xgboostPDefault: ml?.challenger?.pDefault ?? null,
  });
}

module.exports = {
  runStage3,
  evaluateGate,
  hasCompetitorLoans,
  COMPETITOR_KEYWORDS,
};
