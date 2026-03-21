"use strict";
/**
 * decision-engine.js
 * Stage-escalation logic for underwriting decisions (Stages 4 & 5).
 *
 * Feature flag: METAMAP_PRIMARY (env var, default false)
 *   false → Legacy providers authoritative, MetaMap runs in shadow mode
 *   true  → MetaMap authoritative, legacy providers disabled
 *
 * Belvo Open Banking is ALWAYS called at Stage 4 regardless of flag.
 */
const incodeClient  = require("./incode-client");
const sardineClient = require("./sardine-client");
const truoraClient  = require("./truora-client");
const belvoClient   = require("./belvo-client");
const metamapClient = require("./metamap-client");

const METAMAP_PRIMARY = () => process.env.METAMAP_PRIMARY === "true";
const METAMAP_ENABLED = () =>
  process.env.METAMAP_MOCK === "true" || !!process.env.METAMAP_API_KEY;

/**
 * Log MetaMap shadow results. In production this would write to Firestore
 * collection `metamap_shadow_log`. For now logs structured JSON.
 */
function logToShadow(loanId, correlationId, stage, result) {
  const entry = {
    timestamp: new Date().toISOString(),
    loanId,
    correlationId,
    stage,
    result,
  };
  // Structured log — picked up by Cloud Logging / stdout collector
  console.log(JSON.stringify({ level: "info", msg: "metamap_shadow_log", ...entry }));
  return entry;
}

/**
 * Run Stage 4: Identity verification + device fraud + open banking.
 *
 * Legacy path: Incode (doc + liveness + facematch) + Sardine (device/behavioral)
 * MetaMap path: MetaMap (doc-verification + liveness + facematch + device-fingerprint)
 * Belvo Open Banking: ALWAYS runs regardless of flag.
 *
 * @param {object} applicant — { rfc, curp, firstName, lastName, email, phone, sessionKey, interviewId, incodeToken }
 * @param {string} loanId
 * @param {string} correlationId
 * @returns {Promise<object>} stage 4 decision
 */
async function runStage4(applicant, loanId, correlationId) {
  // Belvo Open Banking — always called
  const belvoPromise = belvoClient.getIMSSEmployment(applicant.curp)
    .catch(err => ({ error: err.message, provider: "belvo" }));

  if (METAMAP_PRIMARY()) {
    // MetaMap is authoritative — skip legacy providers
    const [metamapResult, belvoResult] = await Promise.all([
      metamapClient.createVerification(applicant, metamapClient.STAGE_4_MODULES),
      belvoPromise,
    ]);

    return {
      stage: 4,
      provider: "metamap",
      identity: metamapResult,
      openBanking: belvoResult,
      pass: metamapResult.pass !== false,
    };
  }

  // Legacy providers are authoritative
  const [incodeResult, sardineResult, belvoResult] = await Promise.all([
    incodeClient.getScores(applicant.interviewId, applicant.incodeToken, applicant.rfc),
    sardineClient.checkBehavioralRisk(applicant.sessionKey, applicant.rfc),
    belvoPromise,
  ]);

  // Fire-and-forget MetaMap shadow call — never blocks the primary path
  if (METAMAP_ENABLED()) {
    metamapClient.createVerification(applicant, metamapClient.STAGE_4_MODULES)
      .then(result => logToShadow(loanId, correlationId, "stage4", result))
      .catch(err => console.warn(JSON.stringify({
        level: "warn", msg: "MetaMap shadow call failed", stage: "stage4", loanId, error: err.message,
      })));
  }

  return {
    stage: 4,
    provider: "legacy",
    identity: incodeResult,
    behavioral: sardineResult,
    openBanking: belvoResult,
    pass: incodeResult.overall === "APPROVED" && sardineResult.pass !== false,
  };
}

/**
 * Run Stage 5: AML / criminal records / PEP screening.
 *
 * Legacy path: Truora (AML + criminal + PEP + sanctions)
 * MetaMap path: MetaMap (aml-screening + criminal-records + pep-check)
 *
 * @param {object} applicant — { rfc, curp, firstName, lastName }
 * @param {string} loanId
 * @param {string} correlationId
 * @returns {Promise<object>} stage 5 decision
 */
async function runStage5(applicant, loanId, correlationId) {
  if (METAMAP_PRIMARY()) {
    // MetaMap is authoritative — skip legacy providers
    const metamapResult = await metamapClient.createVerification(
      applicant,
      metamapClient.STAGE_5_MODULES
    );

    return {
      stage: 5,
      provider: "metamap",
      compliance: metamapResult,
      pass: metamapResult.pass !== false,
      hard_reject: !!metamapResult.hard_reject,
      requires_human_review: !!metamapResult.requires_human_review,
    };
  }

  // Legacy provider: Truora
  const checkRef = await truoraClient.startCheck(applicant);
  const rawResult = await truoraClient.pollCheck(checkRef.check_id, applicant.rfc);
  const truoraResult = truoraClient.parseResult(rawResult);

  // Fire-and-forget MetaMap shadow call — never blocks the primary path
  if (METAMAP_ENABLED()) {
    metamapClient.createVerification(applicant, metamapClient.STAGE_5_MODULES)
      .then(result => logToShadow(loanId, correlationId, "stage5", result))
      .catch(err => console.warn(JSON.stringify({
        level: "warn", msg: "MetaMap shadow call failed", stage: "stage5", loanId, error: err.message,
      })));
  }

  return {
    stage: 5,
    provider: "legacy",
    compliance: truoraResult,
    pass: truoraResult.pass,
    hard_reject: truoraResult.hard_reject,
    requires_human_review: truoraResult.requires_human_review,
  };
}

module.exports = { runStage4, runStage5, logToShadow };
