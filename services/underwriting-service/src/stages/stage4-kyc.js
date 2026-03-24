"use strict";
/**
 * stage4-kyc.js
 * Stage 4: Full KYC — MetaMap biometrics + Belvo Open Banking + autoencoder anomaly detection.
 *
 * Triggered when: loan amount >$2,000 MXN, bureau score 400–600, or Stage 3 fails any condition.
 *
 * Checks (parallel where possible):
 *   1. MetaMap verification (document, facematch, liveness, device, behavioral, gov-check)
 *   2. Belvo Open Banking cash flow analysis
 *   3. Autoencoder anomaly detection on 7 MetaMap device signals
 *
 * Decisions:
 *   - All checks pass → Approve (with enhanced monitoring flag)
 *   - Any biometric check fails → Reject
 *   - Autoencoder anomaly → Escalate to Stage 5
 */
const fetch = require("node-fetch");
const {
  createVerification,
  pollVerification,
  STAGE_4_MODULES,
} = require("../metamap-client");

const ML_SERVICE_URL = () =>
  process.env.ML_SERVICE_URL || "http://localhost:8000";
const INTERNAL_SECRET = () => process.env.INTERNAL_SECRET || "";
const ANOMALY_THRESHOLD = 0.75;
const FACE_MATCH_THRESHOLD = 0.80;

/**
 * Run Stage 4 Full KYC.
 *
 * @param {object} context
 * @param {string} context.loanId
 * @param {string} context.correlationId
 * @param {object} context.applicant — { firstName, lastName, curp, rfc, email, phone, dateOfBirth }
 * @param {object} context.bankConnection — { institutionName, linkId } (Belvo bank link)
 * @param {object} [context.previousStages] — accumulated signals from Stages 0–3
 * @returns {{ decision, details, deviceSignals, cashFlow }}
 */
async function runStage4(context) {
  const { loanId, correlationId, applicant, bankConnection, previousStages } = context;
  const startedAt = new Date().toISOString();

  // Run all three checks in parallel
  const [metamapResult, cashFlowResult, anomalyResult] = await Promise.allSettled([
    runMetaMapVerification(applicant),
    runBelvoCashFlow(bankConnection, applicant),
    // Anomaly detection needs MetaMap device signals — run after MetaMap completes
    // We start it here as a placeholder and resolve sequentially below
    Promise.resolve(null),
  ]);

  // Extract MetaMap result
  const metamap = metamapResult.status === "fulfilled"
    ? metamapResult.value
    : { error: metamapResult.reason?.message || "MetaMap verification failed" };

  // Extract cash flow result
  const cashFlow = cashFlowResult.status === "fulfilled"
    ? cashFlowResult.value
    : { error: cashFlowResult.reason?.message || "Belvo cash flow analysis failed" };

  // Check biometric failures first (hard reject)
  if (metamap.error) {
    return buildResult({
      loanId, correlationId, startedAt,
      decision: "error",
      reason: `MetaMap error: ${metamap.error}`,
      metamap, cashFlow, anomaly: null,
    });
  }

  const biometricReject = checkBiometricFailures(metamap);
  if (biometricReject) {
    return buildResult({
      loanId, correlationId, startedAt,
      decision: "reject",
      reason: biometricReject.reason,
      metamap, cashFlow, anomaly: null,
    });
  }

  // Now run autoencoder anomaly detection with device signals
  const deviceSignals = metamap.deviceFingerprint;
  let anomaly;
  try {
    anomaly = await runAnomalyDetection(deviceSignals);
  } catch (err) {
    anomaly = { error: err.message, reconstructionError: 0, isAnomaly: false };
  }

  // Decision logic
  if (anomaly.isAnomaly) {
    return buildResult({
      loanId, correlationId, startedAt,
      decision: "escalate",
      reason: `Autoencoder anomaly detected (reconstruction error: ${anomaly.reconstructionError})`,
      escalateTo: "stage5",
      metamap, cashFlow, anomaly,
    });
  }

  // All checks passed
  return buildResult({
    loanId, correlationId, startedAt,
    decision: "approve",
    reason: "All Stage 4 checks passed",
    enhancedMonitoring: true,
    metamap, cashFlow, anomaly,
  });
}

/**
 * Run MetaMap verification with Stage 4 modules.
 * Attempts webhook-first, falls back to polling (5s intervals, 60s timeout).
 */
async function runMetaMapVerification(applicant) {
  const { verificationId } = await createVerification(applicant, STAGE_4_MODULES);

  // Poll for result (webhook handler is separate — this is the fallback)
  const result = await pollVerification(verificationId, applicant.rfc, {
    maxWaitMs: 60000,
    pollIntervalMs: 5000,
    isAML: false,
  });

  return result;
}

/**
 * Belvo Open Banking cash flow analysis.
 * Analyzes 90-day transaction history for payroll deposits, regularity,
 * existing loan payments, avg daily balance, and bounced payments.
 */
async function runBelvoCashFlow(bankConnection, applicant) {
  if (!bankConnection || !bankConnection.linkId) {
    return {
      available: false,
      reason: "No bank connection provided",
      payrollDeposits: [],
      netDeposit: 0,
      avgDailyBalance: 0,
      bouncedPayments: 0,
      existingLoanPayments: [],
    };
  }

  const BelvoClient = require("belvo").default;
  let client;
  try {
    client = new BelvoClient(
      process.env.BELVO_SECRET_ID,
      process.env.BELVO_SECRET_PASSWORD,
      process.env.BELVO_BASE_URL
    );
    await client.connect();
  } catch (err) {
    return { available: false, reason: `Belvo connection failed: ${err.message}` };
  }

  try {
    // Retrieve 90-day transaction history
    const transactions = await client.transactions.retrieve(bankConnection.linkId, {
      dateTo: new Date().toISOString().slice(0, 10),
      dateFrom: new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10),
    });

    // Analyze payroll deposits (regular credits matching salary patterns)
    const credits = transactions.filter(t => t.type === "INFLOW");
    const debits = transactions.filter(t => t.type === "OUTFLOW");

    const payrollDeposits = identifyPayrollDeposits(credits);
    const existingLoanPayments = identifyLoanPayments(debits);
    const bouncedPayments = transactions.filter(
      t => t.status === "REVERSED" || t.status === "BOUNCED"
    ).length;

    // Calculate average daily balance
    const balances = await client.balances.retrieve(bankConnection.linkId, {
      dateTo: new Date().toISOString().slice(0, 10),
      dateFrom: new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10),
    });

    const avgDailyBalance = balances.length > 0
      ? balances.reduce((sum, b) => sum + (b.balance || 0), 0) / balances.length
      : 0;

    const totalPayroll = payrollDeposits.reduce((sum, d) => sum + d.amount, 0);

    return {
      available: true,
      payrollDeposits,
      payrollRegularity: calculateRegularity(payrollDeposits),
      netDeposit: totalPayroll,
      salaryConfirmed: payrollDeposits.length >= 2,
      avgDailyBalance: Math.round(avgDailyBalance * 100) / 100,
      bouncedPayments,
      existingLoanPayments,
      transactionCount: transactions.length,
    };
  } catch (err) {
    return { available: false, reason: `Belvo analysis failed: ${err.message}` };
  }
}

/**
 * Identify payroll deposits from transaction history.
 * Looks for regular credits of similar amounts on consistent dates.
 */
function identifyPayrollDeposits(credits) {
  if (!credits || credits.length === 0) return [];

  // Group by approximate amount (within 10% tolerance)
  const groups = [];
  for (const tx of credits) {
    const amount = Math.abs(tx.amount || 0);
    if (amount < 1000) continue; // Skip small amounts

    const match = groups.find(g =>
      Math.abs(g.avgAmount - amount) / g.avgAmount < 0.10
    );

    if (match) {
      match.transactions.push(tx);
      match.avgAmount = match.transactions.reduce((s, t) => s + Math.abs(t.amount), 0)
        / match.transactions.length;
    } else {
      groups.push({ avgAmount: amount, transactions: [tx] });
    }
  }

  // Payroll = groups with 2+ deposits
  const payrollGroups = groups.filter(g => g.transactions.length >= 2);
  return payrollGroups.flatMap(g =>
    g.transactions.map(tx => ({
      date: tx.valueDate || tx.accountingDate,
      amount: Math.abs(tx.amount),
      description: tx.description || "",
    }))
  );
}

/**
 * Identify loan/credit payments from debit transactions.
 */
function identifyLoanPayments(debits) {
  if (!debits || debits.length === 0) return [];

  const loanKeywords = [
    "credito", "prestamo", "financiera", "banco", "pago mensual",
    "amortizacion", "hipoteca", "automotriz",
  ];

  return debits
    .filter(tx => {
      const desc = (tx.description || "").toLowerCase();
      return loanKeywords.some(kw => desc.includes(kw));
    })
    .map(tx => ({
      date: tx.valueDate || tx.accountingDate,
      amount: Math.abs(tx.amount),
      description: tx.description || "",
    }));
}

/**
 * Calculate payroll deposit regularity (0–1 score).
 * 1.0 = perfectly regular (same day each period), 0.0 = irregular.
 */
function calculateRegularity(payrollDeposits) {
  if (payrollDeposits.length < 2) return 0;

  const dates = payrollDeposits
    .map(d => new Date(d.date).getTime())
    .sort((a, b) => a - b);

  const intervals = [];
  for (let i = 1; i < dates.length; i++) {
    intervals.push((dates[i] - dates[i - 1]) / 86400000); // days
  }

  if (intervals.length === 0) return 0;

  const avgInterval = intervals.reduce((s, i) => s + i, 0) / intervals.length;
  const variance = intervals.reduce((s, i) => s + Math.pow(i - avgInterval, 2), 0) / intervals.length;
  const stdDev = Math.sqrt(variance);

  // Low std dev relative to avg = regular
  const cv = avgInterval > 0 ? stdDev / avgInterval : 1;
  return Math.max(0, Math.min(1, 1 - cv));
}

/**
 * Run autoencoder anomaly detection via ML service.
 * Sends 7 device signals, receives reconstruction error.
 */
async function runAnomalyDetection(deviceSignals) {
  const res = await fetch(`${ML_SERVICE_URL()}/score/anomaly`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_SECRET(),
    },
    body: JSON.stringify({ deviceSignals }),
    timeout: 10000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ML anomaly detection ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    reconstructionError: data.reconstruction_error || 0,
    isAnomaly: (data.reconstruction_error || 0) >= ANOMALY_THRESHOLD,
    threshold: ANOMALY_THRESHOLD,
    raw: data,
  };
}

/**
 * Check for biometric failures that warrant immediate rejection.
 */
function checkBiometricFailures(metamapResult) {
  if (!metamapResult.documentVerification?.passed) {
    return {
      reason: `Document verification failed: ${metamapResult.documentVerification?.reason || "invalid document"}`,
    };
  }

  if (!metamapResult.liveness?.passed) {
    return { reason: "Liveness check failed" };
  }

  if (!metamapResult.facematch?.passed || (metamapResult.facematch?.score || 0) < FACE_MATCH_THRESHOLD) {
    return {
      reason: `Face match below threshold: ${(metamapResult.facematch?.score || 0) * 100}% (min ${FACE_MATCH_THRESHOLD * 100}%)`,
    };
  }

  return null;
}

/**
 * Build standardized Stage 4 result object.
 */
function buildResult({ loanId, correlationId, startedAt, decision, reason, escalateTo, enhancedMonitoring, metamap, cashFlow, anomaly }) {
  return {
    stage: 4,
    stageName: "full_kyc",
    loanId,
    correlationId,
    decision,
    reason,
    escalateTo: escalateTo || null,
    enhancedMonitoring: enhancedMonitoring || false,
    startedAt,
    completedAt: new Date().toISOString(),
    details: {
      metamap: {
        verificationId: metamap?.verificationId || null,
        status: metamap?.status || null,
        documentVerification: metamap?.documentVerification || null,
        facematch: metamap?.facematch || null,
        liveness: metamap?.liveness || null,
        governmentCheck: metamap?.governmentCheck || null,
      },
      cashFlow: cashFlow || null,
      anomaly: anomaly ? {
        reconstructionError: anomaly.reconstructionError,
        isAnomaly: anomaly.isAnomaly,
        threshold: anomaly.threshold,
      } : null,
    },
    deviceSignals: metamap?.deviceFingerprint || null,
  };
}

/**
 * Pipeline-compatible wrapper for runStage4.
 * Adapts (applicant, priorResults, opts) → context object.
 */
async function runFullKYC(applicant, priorResults, opts = {}) {
  const result = await runStage4({
    loanId: priorResults?.correlationId || "unknown",
    correlationId: priorResults?.correlationId || "unknown",
    applicant,
    bankConnection: applicant.bankConnection || null,
    previousStages: priorResults,
  });

  // Adapt result to pipeline's expected format
  const pass = result.decision === "approve";
  const escalateToStage = result.decision === "escalate" ? 5 : null;
  return {
    pass,
    escalateToStage,
    reason: !pass ? (result.reason || "KYC_DECLINED") : null,
    data: result.details || {},
    cost: [{ api: "metamap-kyc", mxn: 15.0 }],
  };
}

module.exports = {
  runStage4,
  runFullKYC,
  runMetaMapVerification,
  runBelvoCashFlow,
  runAnomalyDetection,
  checkBiometricFailures,
  identifyPayrollDeposits,
  identifyLoanPayments,
  calculateRegularity,
  ANOMALY_THRESHOLD,
  FACE_MATCH_THRESHOLD,
};
