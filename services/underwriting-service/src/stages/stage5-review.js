"use strict";
/**
 * stage5-review.js
 * Stage 5: AML + Criminal checks + Claude LLM risk narrative + human review queue.
 *
 * Triggered when: Stage 4 escalates, RiskSeal <30, bureau score <400, active defaults.
 *
 * Checks:
 *   1. MetaMap AML/Criminal verification (aml-screening, criminal-records, pep-check)
 *   2. Claude LLM risk narrative (all accumulated signals from Stages 0–4)
 *   3. Active learning routing (confidence 0.4–0.6 → prioritized in review queue)
 *
 * Output:
 *   - Write review_queue document to Firestore
 *   - 24-hour SLA timer starts at queuedAt
 */
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const {
  createVerification,
  pollVerification,
  STAGE_5_MODULES,
} = require("../metamap-client");

const ML_SERVICE_URL = () =>
  process.env.ML_SERVICE_URL || "http://localhost:8000";
const INTERNAL_SECRET = () => process.env.INTERNAL_SECRET || "";
const ANTHROPIC_API_KEY = () => process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";

// Active learning: cases with confidence in this range get prioritized
const UNCERTAINTY_LOW = 0.4;
const UNCERTAINTY_HIGH = 0.6;

/**
 * Run Stage 5 AML + Human Review.
 *
 * @param {object} context
 * @param {string} context.loanId
 * @param {string} context.correlationId
 * @param {object} context.applicant — { firstName, lastName, curp, rfc, email, phone, dateOfBirth }
 * @param {object} context.accumulatedSignals — all signals from Stages 0–4
 * @param {object} context.firestore — Firestore admin instance
 * @returns {{ decision, details, reviewQueueId }}
 */
async function runStage5(context) {
  const { loanId, correlationId, applicant, accumulatedSignals, firestore } = context;
  const startedAt = new Date().toISOString();

  // Run AML check and LLM narrative in parallel
  const [amlResult, llmResult] = await Promise.allSettled([
    runAMLCheck(applicant),
    generateRiskNarrative(loanId, applicant, accumulatedSignals),
  ]);

  const aml = amlResult.status === "fulfilled"
    ? amlResult.value
    : { error: amlResult.reason?.message || "AML check failed" };

  const llm = llmResult.status === "fulfilled"
    ? llmResult.value
    : {
        error: llmResult.reason?.message || "LLM narrative failed",
        risk_level: "unknown",
        summary: "Risk narrative generation failed",
        key_signals: [],
        recommendation: "manual_review",
        confidence: 0.5,
      };

  // Determine risk level from combined signals
  const riskLevel = determineRiskLevel(aml, llm);

  // Calculate queue priority (active learning)
  const priority = calculateQueuePriority(llm.confidence, aml);

  // Write to Firestore review_queue
  let reviewQueueId = null;
  if (firestore) {
    try {
      reviewQueueId = await writeToReviewQueue(firestore, {
        loanId,
        correlationId,
        riskLevel,
        llmNarrative: llm,
        amlResult: aml,
        signals: accumulatedSignals,
        priority,
        applicantName: `${applicant.firstName} ${applicant.lastName}`,
        applicantRfc: applicant.rfc,
      });
    } catch (err) {
      // Log but don't fail — the review data is still returned
      console.error(`[stage5] Failed to write review_queue for loan ${loanId}:`, err.message);
    }
  }

  return buildResult({
    loanId,
    correlationId,
    startedAt,
    decision: "pending_review",
    reason: buildReviewReason(aml, llm),
    riskLevel,
    priority,
    reviewQueueId,
    aml,
    llm,
  });
}

/**
 * Run MetaMap AML/Criminal verification.
 * AML hit → flag for human review, do NOT auto-reject.
 */
async function runAMLCheck(applicant) {
  const { verificationId } = await createVerification(applicant, STAGE_5_MODULES);

  const result = await pollVerification(verificationId, applicant.rfc, {
    maxWaitMs: 120000,
    pollIntervalMs: 10000,
    isAML: true,
  });

  return {
    verificationId: result.verificationId,
    status: result.status,
    amlHit: result.amlScreening?.hit || false,
    amlLists: result.amlScreening?.lists || [],
    criminalRecordFound: result.criminalRecords?.found || false,
    criminalRecords: result.criminalRecords?.records || [],
    isPEP: result.pepCheck?.isPEP || false,
    pepPosition: result.pepCheck?.position || null,
    requiresHumanReview: result.status === "flagged",
  };
}

/**
 * Generate Claude LLM risk narrative from all accumulated signals.
 * Loads prompt from prompts/stage5_risk_narrative_v1.7.0.md
 */
async function generateRiskNarrative(loanId, applicant, accumulatedSignals) {
  const apiKey = ANTHROPIC_API_KEY();
  if (!apiKey) {
    return {
      risk_level: "unknown",
      summary: "LLM risk narrative unavailable — ANTHROPIC_API_KEY not configured",
      key_signals: [],
      recommendation: "manual_review",
      confidence: 0.5,
    };
  }

  // Load prompt template
  const promptPath = path.resolve(
    __dirname, "..", "..", "..", "..", "prompts", "stage5_risk_narrative_v1.7.0.md"
  );

  let promptTemplate;
  try {
    promptTemplate = fs.readFileSync(promptPath, "utf-8");
  } catch {
    // Fallback inline prompt if file not found
    promptTemplate = getDefaultPrompt();
  }

  // Build signal summary for the LLM
  const signalSummary = buildSignalSummary(loanId, applicant, accumulatedSignals);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      system: promptTemplate,
      messages: [
        {
          role: "user",
          content: `Analyze the following loan application signals and provide a risk assessment:\n\n${signalSummary}`,
        },
      ],
    }),
    timeout: 30000,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Claude API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const responseText = data.content?.[0]?.text || "";

  // Parse structured response
  try {
    const parsed = JSON.parse(responseText);
    return {
      risk_level: parsed.risk_level || "unknown",
      summary: parsed.summary || "",
      key_signals: parsed.key_signals || [],
      recommendation: parsed.recommendation || "manual_review",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    };
  } catch {
    // If LLM didn't return valid JSON, wrap the text response
    return {
      risk_level: "unknown",
      summary: responseText.slice(0, 500),
      key_signals: [],
      recommendation: "manual_review",
      confidence: 0.5,
    };
  }
}

/**
 * Build a structured signal summary for the LLM from all stage data.
 */
function buildSignalSummary(loanId, applicant, signals) {
  const sections = [`Loan ID: ${loanId}`];

  if (applicant) {
    sections.push(`Applicant: ${applicant.firstName} ${applicant.lastName} (RFC: ${applicant.rfc})`);
  }

  if (signals?.stage0) {
    const s = signals.stage0;
    sections.push(`\n--- Stage 0 (Initial Checks) ---`);
    sections.push(`INFONAVIT: ${JSON.stringify(s.infonavit || "N/A")}`);
    sections.push(`Geolocation: ${JSON.stringify(s.geolocation || "N/A")}`);
  }

  if (signals?.stage1) {
    const s = signals.stage1;
    sections.push(`\n--- Stage 1 (Employer Verification) ---`);
    sections.push(`SAT Status: ${s.satStatus || "N/A"}`);
    sections.push(`Employer Risk Tier: ${s.employerRiskTier || "N/A"}`);
    sections.push(`Fiscal Debt: ${JSON.stringify(s.fiscalDebt || "N/A")}`);
  }

  if (signals?.stage2) {
    const s = signals.stage2;
    sections.push(`\n--- Stage 2 (Employment Verification) ---`);
    sections.push(`IMSS Active: ${s.imssActive ?? "N/A"}`);
    sections.push(`Employment Tenure: ${s.tenureMonths || "N/A"} months`);
    sections.push(`Monthly Salary: $${s.monthlySalary || "N/A"} MXN`);
    sections.push(`Payroll OCR Match: ${s.payrollOcrMatch ?? "N/A"}`);
  }

  if (signals?.stage3) {
    const s = signals.stage3;
    sections.push(`\n--- Stage 3 (Identity Verification) ---`);
    sections.push(`Document Valid: ${s.documentValid ?? "N/A"}`);
    sections.push(`Face Match Score: ${s.faceMatchScore ?? "N/A"}`);
    sections.push(`Liveness: ${s.livenessPass ?? "N/A"}`);
  }

  if (signals?.stage4) {
    const s = signals.stage4;
    sections.push(`\n--- Stage 4 (Full KYC) ---`);
    sections.push(`Decision: ${s.decision || "N/A"}`);
    sections.push(`Reason: ${s.reason || "N/A"}`);
    if (s.details?.metamap) {
      sections.push(`MetaMap Status: ${s.details.metamap.status || "N/A"}`);
      sections.push(`Face Match: ${JSON.stringify(s.details.metamap.facematch || "N/A")}`);
    }
    if (s.details?.cashFlow) {
      sections.push(`Cash Flow: salary confirmed=${s.details.cashFlow.salaryConfirmed}, avg balance=$${s.details.cashFlow.avgDailyBalance} MXN`);
    }
    if (s.details?.anomaly) {
      sections.push(`Anomaly: reconstruction error=${s.details.anomaly.reconstructionError}, is_anomaly=${s.details.anomaly.isAnomaly}`);
    }
    if (s.deviceSignals) {
      sections.push(`Device Signals: ${JSON.stringify(s.deviceSignals)}`);
    }
  }

  if (signals?.bureau) {
    sections.push(`\n--- Bureau ---`);
    sections.push(`Bureau Score: ${signals.bureau.score || "N/A"}`);
    sections.push(`Active Defaults: ${signals.bureau.activeDefaults ?? "N/A"}`);
  }

  if (signals?.riskseal) {
    sections.push(`\n--- RiskSeal Digital Footprint ---`);
    sections.push(`Score: ${signals.riskseal.score || "N/A"}`);
    sections.push(`Risk Level: ${signals.riskseal.risk_level || "N/A"}`);
  }

  if (signals?.loan) {
    sections.push(`\n--- Loan Details ---`);
    sections.push(`Amount: $${signals.loan.amount || "N/A"} MXN`);
    sections.push(`Loan-to-Salary Ratio: ${signals.loan.loanToSalaryRatio || "N/A"}`);
  }

  return sections.join("\n");
}

/**
 * Determine overall risk level from AML + LLM results.
 */
function determineRiskLevel(aml, llm) {
  // Criminal record → critical
  if (aml.criminalRecordFound) return "critical";

  // Confirmed AML hit → critical
  const confirmedAML = (aml.amlLists || []).some(l => l.matchType === "CONFIRMED");
  if (confirmedAML) return "critical";

  // PEP → high
  if (aml.isPEP) return "high";

  // Fuzzy AML → high
  const fuzzyAML = (aml.amlLists || []).some(l => l.matchType === "FUZZY");
  if (fuzzyAML) return "high";

  // AML/criminal/PEP screening failed outright — we have no signal either way,
  // so this cannot default to "medium" as if the screen had come back clean.
  if (aml.error) return "high";

  // Use LLM assessment
  if (llm.risk_level && llm.risk_level !== "unknown") return llm.risk_level;

  return "medium";
}

/**
 * Calculate queue priority for active learning.
 * Highest-uncertainty cases (confidence 0.4–0.6) get prioritized.
 * Lower priority number = processed first.
 */
function calculateQueuePriority(confidence, aml) {
  // AML/criminal flags always highest priority
  if (aml.criminalRecordFound || aml.amlHit) return 1;
  if (aml.isPEP) return 2;

  // The screen itself failed to run — zero AML/criminal/PEP signal is worse
  // than a screened-but-uncertain case, so it outranks active learning.
  if (aml.error) return 1;

  // Active learning: uncertain cases get priority 3
  if (typeof confidence === "number" &&
      confidence >= UNCERTAINTY_LOW &&
      confidence <= UNCERTAINTY_HIGH) {
    return 3;
  }

  // High confidence cases get lower priority
  return 5;
}

/**
 * Write review queue document to Firestore.
 * @returns {string} Document ID
 */
async function writeToReviewQueue(firestore, data) {
  const doc = {
    loanId: data.loanId,
    correlationId: data.correlationId,
    risk_level: data.riskLevel,
    llm_narrative: {
      risk_level: data.llmNarrative.risk_level,
      summary: data.llmNarrative.summary,
      key_signals: data.llmNarrative.key_signals,
      recommendation: data.llmNarrative.recommendation,
      confidence: data.llmNarrative.confidence,
    },
    aml_result: {
      amlHit: data.amlResult.amlHit,
      amlLists: data.amlResult.amlLists,
      criminalRecordFound: data.amlResult.criminalRecordFound,
      isPEP: data.amlResult.isPEP,
    },
    signals: data.signals || {},
    priority: data.priority,
    applicantName: data.applicantName,
    applicantRfc: data.applicantRfc,
    queuedAt: new Date().toISOString(),
    assignedTo: null,
    status: "pending",
    slaDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    reviewedAt: null,
    reviewedBy: null,
    reviewDecision: null,
    reviewNotes: null,
  };

  const ref = await firestore.collection("review_queue").add(doc);
  return ref.id;
}

/**
 * Build human-readable reason for review.
 */
function buildReviewReason(aml, llm) {
  const reasons = [];

  if (aml.error) reasons.push(`AML/criminal screening failed: ${aml.error}`);
  if (aml.criminalRecordFound) reasons.push("Criminal record found");
  if (aml.amlHit) {
    const lists = (aml.amlLists || []).map(l => l.list).join(", ");
    reasons.push(`AML hit: ${lists}`);
  }
  if (aml.isPEP) reasons.push(`PEP: ${aml.pepPosition || "position unknown"}`);
  if (llm.risk_level === "high" || llm.risk_level === "critical") {
    reasons.push(`LLM risk assessment: ${llm.risk_level}`);
  }
  if (reasons.length === 0) reasons.push("Escalated from Stage 4 for manual review");

  return reasons.join("; ");
}

/**
 * Fallback prompt if file not found.
 */
function getDefaultPrompt() {
  return `You are a credit risk analyst for VIDA Finance, a Mexican SOFOM (Sociedad Financiera de Objeto Múltiple) that provides payroll-deducted microloans.

Analyze the accumulated underwriting signals from all stages and produce a structured risk assessment.

Respond ONLY with valid JSON in this exact format:
{
  "risk_level": "low" | "medium" | "high" | "critical",
  "summary": "2-3 sentence risk narrative",
  "key_signals": ["signal1", "signal2", ...],
  "recommendation": "approve" | "approve_with_conditions" | "manual_review" | "reject",
  "confidence": 0.0 to 1.0
}`;
}

/**
 * Build standardized Stage 5 result object.
 */
function buildResult({ loanId, correlationId, startedAt, decision, reason, riskLevel, priority, reviewQueueId, aml, llm }) {
  return {
    stage: 5,
    stageName: "aml_review",
    loanId,
    correlationId,
    decision,
    reason,
    riskLevel,
    priority,
    reviewQueueId,
    startedAt,
    completedAt: new Date().toISOString(),
    details: {
      aml: {
        verificationId: aml.verificationId || null,
        status: aml.status || null,
        amlHit: aml.amlHit,
        amlLists: aml.amlLists || [],
        criminalRecordFound: aml.criminalRecordFound,
        isPEP: aml.isPEP,
        error: aml.error || null,
      },
      llm: {
        risk_level: llm.risk_level,
        summary: llm.summary,
        key_signals: llm.key_signals,
        recommendation: llm.recommendation,
        confidence: llm.confidence,
      },
    },
    slaDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

module.exports = {
  runStage5,
  runAMLCheck,
  generateRiskNarrative,
  calculateQueuePriority,
  writeToReviewQueue,
  determineRiskLevel,
  buildSignalSummary,
  UNCERTAINTY_LOW,
  UNCERTAINTY_HIGH,
};
