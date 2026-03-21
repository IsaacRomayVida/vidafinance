"use strict";
/**
 * Stage 3: Auto-Approve Gate
 *
 * 10 conditions ALL must pass:
 *   1. Employer tier >= 1 (not rejected)
 *   2. IMSS tenure > 6 months
 *   3. Bureau score > 600
 *   4. LTI <= 25%
 *   5. No competitor loans
 *   6. RiskSeal > 60
 *   7. Sector safe (CNBV not "alto")
 *   8. XGBoost/ML P(default) < threshold
 *   9. No active defaults
 *  10. Age 18-65 (already validated in Stage 1, re-checked here)
 *
 * 55% approved here. Cost: $21-47 MXN total pipeline.
 */

const APPROVAL_THRESHOLD = () => parseFloat(process.env.APPROVAL_THRESHOLD || "0.65");

function evaluateAutoApprove(applicant, allResults) {
  const conditions = [];
  const employerData = allResults.employerB?.data || {};
  const stage0Data = allResults.stage0?.data || {};
  const stage1Data = allResults.stage1?.data || {};
  const stage2Data = allResults.stage2?.data || {};

  // 1. Employer tier >= 1
  const employerTier = employerData.tier || applicant.employerTier || 3;
  conditions.push({
    name: "employer_tier",
    pass: employerTier <= 2,
    value: employerTier,
    required: "<= 2",
  });

  // 2. IMSS tenure > 6 months
  const tenure = stage2Data.imss?.tenureMonths || applicant.employmentTenureMonths || 0;
  conditions.push({
    name: "imss_tenure",
    pass: tenure > 6,
    value: tenure,
    required: "> 6 months",
  });

  // 3. Bureau score > 600
  const bureauScore = stage2Data.bureau?.score || 500;
  conditions.push({
    name: "bureau_score",
    pass: bureauScore > 600,
    value: bureauScore,
    required: "> 600",
  });

  // 4. LTI <= 25%
  const lti = stage2Data.lti?.value || 0;
  conditions.push({
    name: "lti",
    pass: lti <= 25,
    value: lti,
    required: "<= 25%",
  });

  // 5. No competitor loans
  const competitorLoans = stage2Data.bureau?.competitorLoans || 0;
  conditions.push({
    name: "no_competitor_loans",
    pass: competitorLoans === 0,
    value: competitorLoans,
    required: "0",
  });

  // 6. RiskSeal > 60
  const risksealScore = stage0Data.riskseal?.score ?? 100;
  conditions.push({
    name: "riskseal_score",
    pass: risksealScore > 60,
    value: risksealScore,
    required: "> 60",
  });

  // 7. Sector safe
  const sectorSafe = stage1Data.cnbv?.pass !== false;
  conditions.push({
    name: "sector_safe",
    pass: sectorSafe,
    value: stage1Data.cnbv?.riskLevel || "unknown",
    required: "not alto",
  });

  // 8. ML P(default) < threshold
  const mlScore = stage2Data.mlScore;
  const pDefault = mlScore?.default_probability || mlScore?.probability || (1 - (mlScore?.underwritingScore || 0.5));
  const threshold = APPROVAL_THRESHOLD();
  conditions.push({
    name: "ml_default_prob",
    pass: !mlScore?.skipped && pDefault < (1 - threshold),
    value: pDefault,
    required: `< ${1 - threshold}`,
  });

  // 9. No active defaults
  const activeDefaults = stage2Data.bureau?.activeDefaults || 0;
  conditions.push({
    name: "no_active_defaults",
    pass: activeDefaults === 0,
    value: activeDefaults,
    required: "0",
  });

  // 10. Age 18-65
  const age = stage1Data.age || applicant.age;
  conditions.push({
    name: "age_range",
    pass: age >= 18 && age <= 65,
    value: age,
    required: "18-65",
  });

  return conditions;
}

async function runAutoApproveGate(applicant, allResults, { logger } = {}) {
  const log = logger || console;

  log.info({ stage: "stage3", rfc: applicant.rfc }, "Evaluating auto-approve gate");

  const conditions = evaluateAutoApprove(applicant, allResults);
  const allPass = conditions.every(c => c.pass);
  const failedConditions = conditions.filter(c => !c.pass);

  const data = { conditions, allPass, failedConditions };

  if (allPass) {
    log.info({ stage: "stage3", rfc: applicant.rfc }, "Auto-approved");
    return {
      pass: true,
      escalateToStage: null,
      reason: null,
      data,
      cost: [],
    };
  }

  // Determine escalation: Stage 4 or Stage 5
  const bureauScore = allResults.stage2?.data?.bureau?.score || 500;
  const activeDefaults = allResults.stage2?.data?.bureau?.activeDefaults || 0;
  const principalAmount = applicant.principalAmount || 0;

  // Stage 5 triggers: AML hits, score < 400, active defaults
  if (activeDefaults > 0 || bureauScore < 400) {
    log.info({ stage: "stage3", rfc: applicant.rfc }, "Escalating to Stage 5 — manual review");
    return {
      pass: false,
      escalateToStage: 5,
      reason: "MANUAL_REVIEW_REQUIRED",
      data,
      cost: [],
    };
  }

  // Stage 4 triggers: > $2k, score 400-600, or Stage 3 fail
  if (principalAmount > 2000 || (bureauScore >= 400 && bureauScore <= 600)) {
    log.info({ stage: "stage3", rfc: applicant.rfc }, "Escalating to Stage 4 — full KYC");
    return {
      pass: false,
      escalateToStage: 4,
      reason: "FULL_KYC_REQUIRED",
      data,
      cost: [],
    };
  }

  // Default: escalate to Stage 4
  return {
    pass: false,
    escalateToStage: 4,
    reason: "AUTO_APPROVE_FAILED",
    data,
    cost: [],
  };
}

module.exports = { runAutoApproveGate, evaluateAutoApprove };
