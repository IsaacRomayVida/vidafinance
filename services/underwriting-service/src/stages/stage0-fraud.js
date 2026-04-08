"use strict";
/**
 * Stage 0: Fraud Gates
 *
 * Checks:
 *   1. Device fingerprint (MetaMap behavioral biometrics)
 *   2. INFONAVIT/FONACOT senior claimant detection (Belvo)
 *   3. RiskSeal digital footprint: < 30 → escalate to Stage 5
 *   4. Isolation Forest anomaly detection (ML service)
 *
 * ~20% reject rate.
 */
const { checkDigitalFootprint } = require("../riskseal-client");
const { checkBehavioralRisk } = require("../metamap-client");
const { getINFONAVIT } = require("../belvo-client");

const ML_SERVICE_URL = () => process.env.ML_SERVICE_URL || "http://localhost:3005";

async function callFraudScore(applicant) {
  const fetch = require("node-fetch");
  const res = await fetch(`${ML_SERVICE_URL()}/underwrite/employee`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": process.env.ML_INTERNAL_SECRET || process.env.INTERNAL_SECRET || "" },
    body: JSON.stringify({
      monthlySalary: applicant.monthlySalary || 0,
      employerTier: applicant.employerTier || 2,
      requestsLastHour: applicant.requestsLastHour || 0,
      amountToSalaryRatio: applicant.principalAmount
        ? applicant.principalAmount / Math.max(applicant.monthlySalary || 1, 1)
        : 0,
    }),
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`ML fraud score ${res.status}`);
  return res.json();
}

async function runFraudGates(applicant, _priorResults, { logger } = {}) {
  const log = logger || console;
  const costItems = [];

  log.info({ stage: "stage0", rfc: applicant.rfc }, "Starting fraud gates");

  const checks = [];

  // 1. Device fingerprint (MetaMap behavioral biometrics)
  if (applicant.sessionKey) {
    checks.push(
      checkBehavioralRisk(applicant.sessionKey, applicant.userId)
        .then(r => ({ key: "metamapBehavioral", result: r }))
        .catch(err => ({ key: "metamapBehavioral", result: { pass: true, skipped: true, error: err.message } }))
    );
  } else {
    checks.push(Promise.resolve({ key: "metamapBehavioral", result: { pass: true, skipped: true, reason: "no_session_key" } }));
  }

  // 2. INFONAVIT/FONACOT senior claimant detection
  if (applicant.curp) {
    checks.push(
      getINFONAVIT(applicant.curp)
        .then(r => ({ key: "infonavit", result: r }))
        .catch(err => ({ key: "infonavit", result: { skipped: true, error: err.message } }))
    );
    costItems.push({ api: "belvo-infonavit", mxn: 2.0 });
  } else {
    checks.push(Promise.resolve({ key: "infonavit", result: { skipped: true, reason: "no_curp" } }));
  }

  // 3. RiskSeal digital footprint
  checks.push(
    checkDigitalFootprint({
      email: applicant.email,
      phone: applicant.phone,
      ip: applicant.ipAddress,
      rfc: applicant.rfc,
    })
      .then(r => ({ key: "riskseal", result: r }))
      .catch(err => ({ key: "riskseal", result: { pass: true, skipped: true, error: err.message } }))
  );

  // 4. ML anomaly detection
  checks.push(
    callFraudScore(applicant)
      .then(r => ({ key: "mlFraud", result: r }))
      .catch(err => ({ key: "mlFraud", result: { is_fraud: false, skipped: true, error: err.message } }))
  );

  const results = await Promise.all(checks);
  const data = {};
  for (const { key, result } of results) {
    data[key] = result;
  }

  // Decision logic
  // MetaMap behavioral very_high = hard reject
  if (data.metamapBehavioral.risk_level === "very_high") {
    return {
      pass: false,
      escalateToStage: null,
      reason: "DEVICE_FRAUD_DETECTED",
      data,
      cost: costItems,
    };
  }

  // ML anomaly detection
  if (data.mlFraud.is_fraud) {
    return {
      pass: false,
      escalateToStage: null,
      reason: "ANOMALY_DETECTED",
      data,
      cost: costItems,
    };
  }

  // RiskSeal < 30 → escalate to Stage 5 (manual review)
  if (data.riskseal.score !== undefined && data.riskseal.score < 30 && !data.riskseal.skipped) {
    return {
      pass: false,
      escalateToStage: 5,
      reason: "LOW_DIGITAL_FOOTPRINT",
      data,
      cost: costItems,
    };
  }

  // INFONAVIT senior claimant detection
  const infonavitData = data.infonavit;
  if (infonavitData && !infonavitData.skipped) {
    const records = Array.isArray(infonavitData) ? infonavitData : [infonavitData];
    const hasActiveCredit = records.some(r =>
      r.credit_status === "active" || r.balance > 0
    );
    if (hasActiveCredit) {
      // Not a rejection — just flag for LTI calculation in Stage 2
      data.infonavitFlag = true;
      data.infonavitDeduction = records.reduce(
        (sum, r) => sum + (r.monthly_deduction || r.deduction || 0), 0
      );
    }
  }

  // MetaMap behavioral high = flag but continue
  const behavioralFlag = data.metamapBehavioral.risk_level === "high";

  return {
    pass: true,
    escalateToStage: null,
    reason: null,
    flags: { behavioralFlag, infonavitFlag: !!data.infonavitFlag },
    data,
    cost: costItems,
  };
}

module.exports = { runFraudGates };
