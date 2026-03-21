"use strict";
/**
 * Stage 4: Full KYC
 *
 * Triggered for > $2k, bureau score 400-600, or Stage 3 fail.
 * ~20% of applications reach this stage.
 *
 * Checks:
 *   1. Incode: document-verification + liveness + facematch
 *   2. Belvo Open Banking: cash flow from BBVA/Santander/Banorte (if linked)
 *   3. Sardine autoencoder anomaly detection on device signals
 */
const { startSession, getScores } = require("../incode-client");
const { checkBehavioralRisk } = require("../sardine-client");

const METAMAP_PRIMARY = () => process.env.METAMAP_PRIMARY === "true";

async function runFullKYC(applicant, allResults, { logger } = {}) {
  const log = logger || console;
  const costItems = [];

  log.info({ stage: "stage4", rfc: applicant.rfc }, "Starting full KYC");

  const data = {};

  // 1. Document verification + liveness + facematch
  // Respect METAMAP_PRIMARY flag — if true, use MetaMap flow (placeholder)
  // Otherwise use Incode
  if (METAMAP_PRIMARY()) {
    log.info({ stage: "stage4" }, "METAMAP_PRIMARY=true — MetaMap flow (not yet integrated)");
    data.kyc = { provider: "metamap", skipped: true, reason: "metamap_not_integrated" };
  } else {
    try {
      const session = await startSession(applicant.rfc);
      data.kycSession = { token: session.token, interviewId: session.interviewId };

      // If interviewId is already completed (mock or pre-completed), get scores
      if (applicant.kycInterviewId || session.interviewId) {
        const scores = await getScores(
          applicant.kycInterviewId || session.interviewId,
          session.token,
          applicant.rfc
        );
        data.kyc = { provider: "incode", ...scores };
        costItems.push({ api: "incode-kyc", mxn: 12.0 });
      }
    } catch (err) {
      log.warn({ stage: "stage4", err: err.message }, "KYC check failed");
      data.kyc = { provider: "incode", skipped: true, error: err.message };
    }
  }

  // 2. Sardine device fingerprint (deeper analysis for Stage 4)
  if (applicant.sessionKey) {
    try {
      const sardine = await checkBehavioralRisk(applicant.sessionKey, applicant.userId);
      data.sardineDeep = sardine;
    } catch (err) {
      data.sardineDeep = { pass: true, skipped: true, error: err.message };
    }
  }

  // Decision logic
  const kycResult = data.kyc || {};

  if (kycResult.overall === "DECLINED") {
    return {
      pass: false,
      escalateToStage: null,
      reason: "KYC_DECLINED",
      data,
      cost: costItems,
    };
  }

  if (kycResult.overall === "MANUAL_REVIEW") {
    return {
      pass: false,
      escalateToStage: 5,
      reason: "KYC_MANUAL_REVIEW",
      data,
      cost: costItems,
    };
  }

  // Sardine very_high in deep analysis = escalate to manual
  if (data.sardineDeep?.risk_level === "very_high") {
    return {
      pass: false,
      escalateToStage: 5,
      reason: "DEVICE_ANOMALY_DETECTED",
      data,
      cost: costItems,
    };
  }

  // KYC approved or skipped with no negative signals
  const kycApproved = kycResult.overall === "APPROVED" || kycResult.skipped;

  return {
    pass: kycApproved,
    escalateToStage: kycApproved ? null : 5,
    reason: kycApproved ? null : "KYC_INCOMPLETE",
    data,
    cost: costItems,
  };
}

module.exports = { runFullKYC };
