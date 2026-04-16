"use strict";
/**
 * decision-engine.js
 * 6-Stage Underwriting Decision Engine — Pipeline Orchestrator
 *
 * Pipeline flow:
 *   Employer Part A → Employer Part B → Stage 0 (Fraud) → Stage 1 (Identity)
 *   → Stage 2 (Bureau) → Stage 3 (Auto-Approve) → Stage 4 (KYC) → Stage 5 (Review)
 *
 * Each stage returns: { pass, escalateToStage, reason, data, cost }
 * Stages 4 and 5 are conditional — only triggered by escalation.
 */
const { runEmployerScreening }     = require("./stages/employer-a");
const { runEmployerDueDiligence }  = require("./stages/employer-b");
const { runFraudGates }            = require("./stages/stage0-fraud");
const { runIdentityValidation }    = require("./stages/stage1-identity");
const { runBureauAndEmployment }   = require("./stages/stage2-bureau");
const { runAutoApproveGate }       = require("./stages/stage3-autoapprove");
const { runStage4 }                = require("./stages/stage4-kyc");
const { runStage5 }                = require("./stages/stage5-review");

const STAGE_NAMES = [
  "employerA", "employerB", "stage0", "stage1",
  "stage2", "stage3", "stage4", "stage5",
];

function generateCorrelationId() {
  return `uw-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function sumCosts(results) {
  const items = [];
  for (const key of Object.keys(results)) {
    const stage = results[key];
    if (stage?.cost) items.push(...stage.cost);
  }
  const totalMXN = items.reduce((sum, c) => sum + (c.mxn || 0), 0);
  return { items, totalMXN };
}

/**
 * Run the full underwriting pipeline.
 *
 * @param {object} input
 * @param {object} input.applicant - Employee/borrower data
 * @param {object} input.employer  - Employer data (RFC, company name, etc.)
 * @param {object} [options]
 * @param {object} [options.logger]  - Structured logger (pino/bunyan compatible)
 * @param {object} [options.db]      - Firestore instance (for CNBV sector lookup)
 * @param {string} [options.correlationId] - Override correlation ID
 * @returns {Promise<object>} Pipeline result with decision, stages, cost
 */
async function runPipeline({ applicant, employer }, options = {}) {
  const log = options.logger || console;
  const correlationId = options.correlationId || generateCorrelationId();
  const startTime = Date.now();

  log.info({ correlationId, rfc: applicant.rfc }, "Pipeline started");

  const results = {};
  const stageOpts = { logger: log, db: options.db };

  // ── Employer Part A ──────────────────────────────────────────────────
  try {
    results.employerA = await runEmployerScreening(employer, stageOpts);
  } catch (err) {
    log.error({ correlationId, stage: "employerA", err: err.message }, "Stage failed");
    results.employerA = { pass: false, reason: "STAGE_ERROR", error: err.message, cost: [] };
  }

  if (!results.employerA.pass && results.employerA.escalateToStage === 5) {
    // Provider errors — skip to manual review
    return await runStage5AndFinalize(applicant, results, stageOpts, correlationId, startTime);
  }
  if (!results.employerA.pass && !results.employerA.escalateToStage) {
    return buildResult("rejected", results.employerA.reason, results, correlationId, startTime);
  }

  // ── Employer Part B ──────────────────────────────────────────────────
  try {
    results.employerB = await runEmployerDueDiligence(employer, results.employerA, stageOpts);
  } catch (err) {
    log.error({ correlationId, stage: "employerB", err: err.message }, "Stage failed");
    results.employerB = { pass: false, reason: "STAGE_ERROR", error: err.message, cost: [] };
  }

  if (!results.employerB.pass) {
    return buildResult("rejected", results.employerB.reason, results, correlationId, startTime);
  }

  // ── Stage 0: Fraud Gates ─────────────────────────────────────────────
  try {
    results.stage0 = await runFraudGates(applicant, results, stageOpts);
  } catch (err) {
    log.error({ correlationId, stage: "stage0", err: err.message }, "Stage failed");
    results.stage0 = { pass: false, reason: "STAGE_ERROR", error: err.message, cost: [] };
  }

  if (!results.stage0.pass && results.stage0.escalateToStage === 5) {
    // Skip to Stage 5
    return await runStage5AndFinalize(applicant, results, stageOpts, correlationId, startTime);
  }
  if (!results.stage0.pass && !results.stage0.escalateToStage) {
    return buildResult("rejected", results.stage0.reason, results, correlationId, startTime);
  }

  // ── Stage 1: Identity Validation ─────────────────────────────────────
  try {
    results.stage1 = await runIdentityValidation(applicant, results, stageOpts);
  } catch (err) {
    log.error({ correlationId, stage: "stage1", err: err.message }, "Stage failed");
    results.stage1 = { pass: false, reason: "STAGE_ERROR", error: err.message, cost: [] };
  }

  if (!results.stage1.pass) {
    return buildResult("rejected", results.stage1.reason, results, correlationId, startTime);
  }

  // ── Stage 2: Bureau & Employment ─────────────────────────────────────
  try {
    results.stage2 = await runBureauAndEmployment(applicant, results, stageOpts);
  } catch (err) {
    log.error({ correlationId, stage: "stage2", err: err.message }, "Stage failed");
    results.stage2 = { pass: true, reason: "STAGE_ERROR_DEGRADED", error: err.message, data: {}, cost: [] };
  }

  // ── Stage 3: Auto-Approve Gate ───────────────────────────────────────
  try {
    results.stage3 = await runAutoApproveGate(applicant, results, stageOpts);
  } catch (err) {
    log.error({ correlationId, stage: "stage3", err: err.message }, "Stage failed");
    results.stage3 = { pass: false, escalateToStage: 5, reason: "STAGE_ERROR", error: err.message, cost: [] };
  }

  if (results.stage3.pass) {
    return buildResult("approved", null, results, correlationId, startTime);
  }

  // ── Stage 4: Full KYC (conditional) ──────────────────────────────────
  if (results.stage3.escalateToStage === 4) {
    try {
      const stage4Raw = await runStage4({
        loanId: correlationId,
        correlationId,
        applicant,
        bankConnection: applicant.bankConnection || null,
        previousStages: results,
      });
      results.stage4 = {
        pass: stage4Raw.decision === "approve",
        escalateToStage: stage4Raw.escalateTo === "stage5" ? 5 : null,
        reason: stage4Raw.decision === "reject" ? "KYC_DECLINED" : stage4Raw.reason,
        data: stage4Raw.details || {},
        cost: [{ api: "metamap-kyc", mxn: 12.0 }],
      };
    } catch (err) {
      log.error({ correlationId, stage: "stage4", err: err.message }, "Stage failed");
      results.stage4 = { pass: false, escalateToStage: 5, reason: "STAGE_ERROR", error: err.message, cost: [] };
    }

    if (results.stage4.pass) {
      return buildResult("approved", null, results, correlationId, startTime);
    }

    if (results.stage4.escalateToStage === 5) {
      return await runStage5AndFinalize(applicant, results, stageOpts, correlationId, startTime);
    }

    // Stage 4 fail without escalation = reject
    return buildResult("rejected", results.stage4.reason, results, correlationId, startTime);
  }

  // ── Stage 5: Manual Review (conditional) ─────────────────────────────
  if (results.stage3.escalateToStage === 5) {
    return await runStage5AndFinalize(applicant, results, stageOpts, correlationId, startTime);
  }

  // Fallback: reject
  return buildResult("rejected", results.stage3.reason, results, correlationId, startTime);
}

async function runStage5AndFinalize(applicant, results, stageOpts, correlationId, startTime) {
  try {
    const stage5Raw = await runStage5({
      loanId: correlationId,
      correlationId,
      applicant,
      accumulatedSignals: results,
      firestore: stageOpts.db || null,
    });
    const amlDetails = stage5Raw.details?.aml || {};
    const isHardReject = amlDetails.criminalRecordFound ||
      (amlDetails.amlLists || []).some(l => l.matchType === "CONFIRMED");
    results.stage5 = {
      pass: false,
      pendingReview: !isHardReject,
      reason: isHardReject ? "AML_CRIMINAL_REJECT" : stage5Raw.reason,
      slaHours: 24,
      data: stage5Raw.details || {},
      cost: [{ api: "metamap-aml", mxn: 8.0 }],
    };
  } catch (err) {
    const log = stageOpts.logger || console;
    log.error({ correlationId, stage: "stage5", err: err.message }, "Stage failed");
    results.stage5 = { pass: false, reason: "STAGE_ERROR", pendingReview: true, slaHours: 24, cost: [] };
  }

  if (results.stage5.pass) {
    return buildResult("approved", null, results, correlationId, startTime);
  }

  if (results.stage5.pendingReview) {
    return buildResult("pending_review", results.stage5.reason, results, correlationId, startTime, {
      slaHours: results.stage5.slaHours || 24,
    });
  }

  return buildResult("rejected", results.stage5.reason, results, correlationId, startTime);
}

function buildResult(decision, reason, results, correlationId, startTime, extra = {}) {
  const cost = sumCosts(results);
  const durationMs = Date.now() - startTime;

  // Determine which stages were executed
  const stagesExecuted = STAGE_NAMES.filter(name => results[name]);
  const lastStage = stagesExecuted[stagesExecuted.length - 1] || "none";

  return {
    decision,
    reason,
    correlationId,
    durationMs,
    lastStage,
    stagesExecuted,
    cost,
    stages: results,
    ...extra,
  };
}

module.exports = { runPipeline, generateCorrelationId, sumCosts, STAGE_NAMES };
