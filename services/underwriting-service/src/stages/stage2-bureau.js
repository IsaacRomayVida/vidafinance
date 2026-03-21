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

const ML_SERVICE_URL = () => process.env.ML_SERVICE_URL || "http://localhost:3005";
const SOFTCREDITO_URL = () => process.env.SOFTCREDITO_ADAPTER_URL || "http://localhost:3004";

async function fetchBureauScore(applicant) {
  const fetch = require("node-fetch");
  const res = await fetch(`${SOFTCREDITO_URL()}/bureau/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      curp: applicant.curp,
      fullName: applicant.fullName,
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(features),
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`ML score ${res.status}`);
  return res.json();
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
    log.warn({ stage: "stage2", err: err.message }, "IMSS check failed");
    data.imss = { active: false, skipped: true, error: err.message };
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
    log.warn({ stage: "stage2", err: err.message }, "AFORE check failed");
    data.afore = { balance: 0, regular: false, skipped: true, error: err.message };
  }

  // 3. Bureau score (SoftCrédito CDC + BDC)
  let bureauResult;
  try {
    bureauResult = await fetchBureauScore(applicant);
    costItems.push({ api: "softcredito", mxn: 8.0 });
    data.bureau = {
      score: bureauResult.bureau_score || bureauResult.score || 500,
      hasBureauRecord: bureauResult.has_bureau_record ?? true,
      activeDefaults: bureauResult.active_defaults || 0,
      competitorLoans: bureauResult.competitor_loans || 0,
      raw: bureauResult,
    };
  } catch (err) {
    log.warn({ stage: "stage2", err: err.message }, "Bureau check failed — using defaults");
    data.bureau = {
      score: 500,
      hasBureauRecord: false,
      activeDefaults: 0,
      competitorLoans: 0,
      skipped: true,
      error: err.message,
    };
  }

  // 4. LTI calculation
  const infonavitDeduction = priorResults?.stage0?.data?.infonavitDeduction || 0;
  const monthlySalary = data.imss.sbc || applicant.monthlySalary || 0;
  const lti = computeLTI(applicant.principalAmount || 0, monthlySalary, infonavitDeduction);
  data.lti = { value: lti, monthlySalary, infonavitDeduction, principalAmount: applicant.principalAmount };

  // 5. ML model score (Champions LR + Challenger XGBoost)
  let mlScore;
  try {
    mlScore = await fetchMLScore({
      employment_tenure_months: data.imss.tenureMonths || applicant.employmentTenureMonths || 0,
      monthly_salary: monthlySalary,
      pay_frequency_encoded: applicant.payFrequency === "weekly" ? 4 : applicant.payFrequency === "biweekly" ? 2 : 1,
      loan_to_salary_ratio: monthlySalary > 0 ? (applicant.principalAmount || 0) / monthlySalary : 0,
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

module.exports = { runBureauAndEmployment, computeLTI };
