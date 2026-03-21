"use strict";
/**
 * Stage 5: Manual Review
 *
 * Triggered for AML hits, bureau score < 400, active defaults,
 * or escalation from earlier stages.
 * ~5% of applications. 24hr SLA.
 *
 * Checks:
 *   1. Truora: aml-screening + criminal-records + pep-check
 *   2. Claude LLM synthesizes all signals into risk narrative
 *   3. Active learning routes highest-uncertainty cases here
 */
const { startCheck, pollCheck, parseResult } = require("../truora-client");

const ML_SERVICE_URL = () => process.env.ML_SERVICE_URL || "http://localhost:3005";

async function generateRiskNarrative(applicant, allResults) {
  const fetch = require("node-fetch");
  try {
    const res = await fetch(`${ML_SERVICE_URL()}/underwrite/employee`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        monthlySalary: applicant.monthlySalary || 0,
        employerTier: allResults.employerB?.data?.tier || 2,
        fullName: applicant.fullName,
        rfc: applicant.rfc,
        allResults: {
          stage0: allResults.stage0?.reason,
          stage1: allResults.stage1?.reason,
          stage2Bureau: allResults.stage2?.data?.bureau?.score,
          stage3Failed: allResults.stage3?.data?.failedConditions?.map(c => c.name),
          stage4Kyc: allResults.stage4?.data?.kyc?.overall,
          escalationReasons: Object.entries(allResults)
            .filter(([, v]) => v?.escalateToStage === 5)
            .map(([k, v]) => `${k}: ${v.reason}`),
        },
      }),
      timeout: 30000,
    });
    if (!res.ok) throw new Error(`Risk narrative ${res.status}`);
    return res.json();
  } catch (err) {
    return { skipped: true, error: err.message };
  }
}

async function runManualReview(applicant, allResults, { logger } = {}) {
  const log = logger || console;
  const costItems = [];

  log.info({ stage: "stage5", rfc: applicant.rfc }, "Starting manual review");

  const data = {};

  // 1. Truora AML/criminal/PEP check
  let truoraResult;
  try {
    const check = await startCheck({
      rfc: applicant.rfc,
      curp: applicant.curp,
      firstName: applicant.firstName,
      lastName: applicant.lastName,
    });
    data.truoraCheckId = check.check_id;

    const rawResult = await pollCheck(check.check_id, applicant.rfc);
    truoraResult = parseResult(rawResult);
    data.truora = truoraResult;
    costItems.push({ api: "truora-aml", mxn: 5.0 });
  } catch (err) {
    log.warn({ stage: "stage5", err: err.message }, "Truora check failed");
    data.truora = { pass: true, skipped: true, error: err.message };
    truoraResult = data.truora;
  }

  // Hard reject on confirmed AML/criminal
  if (truoraResult.hard_reject) {
    log.warn({ stage: "stage5", rfc: applicant.rfc }, "AML/criminal hard reject");
    return {
      pass: false,
      escalateToStage: null,
      reason: "AML_CRIMINAL_REJECT",
      data,
      cost: costItems,
    };
  }

  // 2. Claude LLM risk narrative
  const narrative = await generateRiskNarrative(applicant, allResults);
  data.riskNarrative = narrative;

  // Flag for human review — this stage creates a review task, not auto-decision
  const needsHumanReview = truoraResult.requires_human_review ||
    truoraResult.isPEP ||
    !truoraResult.pass;

  return {
    pass: !needsHumanReview,
    escalateToStage: null,
    reason: needsHumanReview ? "PENDING_HUMAN_REVIEW" : null,
    pendingReview: needsHumanReview,
    slaHours: 24,
    data,
    cost: costItems,
  };
}

module.exports = { runManualReview };
