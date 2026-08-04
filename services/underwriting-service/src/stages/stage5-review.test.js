"use strict";
/**
 * Unit tests for stage5-review.js
 * Covers: AML checks, LLM narrative, risk level determination, queue priority,
 * review queue writing, active learning routing, and timeout scenarios.
 */
const assert = require("assert");

// Set mock mode before requiring modules
process.env.METAMAP_MOCK = "true";
process.env.ANTHROPIC_API_KEY = ""; // Disable real API calls in tests

const {
  runStage5,
  runAMLCheck,
  calculateQueuePriority,
  determineRiskLevel,
  buildSignalSummary,
  UNCERTAINTY_LOW,
  UNCERTAINTY_HIGH,
} = require("./stage5-review");

// ─── Test Data ───────────────────────────────────────────────────────────────

const baseApplicant = {
  firstName: "Juan",
  lastName: "Pérez",
  curp: "PEPJ900101HDFRRL09",
  rfc: "PEPJ900101ABC",
  email: "juan@example.com",
  phone: "+5215512345678",
  dateOfBirth: "1990-01-01",
};

const baseSignals = {
  stage0: { infonavit: { balance: 50000 } },
  stage1: { satStatus: "active", employerRiskTier: 1 },
  stage2: { imssActive: true, tenureMonths: 24, monthlySalary: 18000 },
  stage3: { documentValid: true, faceMatchScore: 0.95, livenessPass: true },
  stage4: {
    decision: "escalate",
    reason: "Autoencoder anomaly",
    details: {
      metamap: { status: "verified", facematch: { score: 0.92 } },
      cashFlow: { salaryConfirmed: true, avgDailyBalance: 8500 },
      anomaly: { reconstructionError: 0.82, isAnomaly: true },
    },
    deviceSignals: {
      emulator_detected: 0, vpn_detected: 1, rooted_device: 0,
      device_age_days: 45, ip_reputation_score: 0.55,
      session_duration_seconds: 90, interaction_anomaly_score: 0.42,
    },
  },
  bureau: { score: 520, activeDefaults: false },
  riskseal: { score: 42, risk_level: "medium" },
  loan: { amount: 3000, loanToSalaryRatio: 0.17 },
};

// ─── Mock Firestore ──────────────────────────────────────────────────────────

function createMockFirestore() {
  const docs = [];
  return {
    collection: (name) => ({
      add: async (doc) => {
        const id = `mock-doc-${docs.length + 1}`;
        docs.push({ id, collection: name, ...doc });
        return { id };
      },
    }),
    _docs: docs,
  };
}

// ─── determineRiskLevel ──────────────────────────────────────────────────────

describe("stage5-review: determineRiskLevel", () => {
  it("should return critical for criminal record", () => {
    const level = determineRiskLevel(
      { criminalRecordFound: true, amlLists: [], isPEP: false },
      { risk_level: "medium", confidence: 0.7 }
    );
    assert.strictEqual(level, "critical");
  });

  it("should return critical for confirmed AML hit", () => {
    const level = determineRiskLevel(
      { criminalRecordFound: false, amlLists: [{ matchType: "CONFIRMED" }], isPEP: false },
      { risk_level: "medium", confidence: 0.7 }
    );
    assert.strictEqual(level, "critical");
  });

  it("should return high for PEP", () => {
    const level = determineRiskLevel(
      { criminalRecordFound: false, amlLists: [], isPEP: true },
      { risk_level: "medium", confidence: 0.7 }
    );
    assert.strictEqual(level, "high");
  });

  it("should return high for fuzzy AML match", () => {
    const level = determineRiskLevel(
      { criminalRecordFound: false, amlLists: [{ matchType: "FUZZY" }], isPEP: false },
      { risk_level: "low", confidence: 0.9 }
    );
    assert.strictEqual(level, "high");
  });

  it("should use LLM assessment when no AML flags", () => {
    const level = determineRiskLevel(
      { criminalRecordFound: false, amlLists: [], isPEP: false },
      { risk_level: "low", confidence: 0.85 }
    );
    assert.strictEqual(level, "low");
  });

  it("should default to medium when LLM risk_level is unknown", () => {
    const level = determineRiskLevel(
      { criminalRecordFound: false, amlLists: [], isPEP: false },
      { risk_level: "unknown", confidence: 0.5 }
    );
    assert.strictEqual(level, "medium");
  });
});

// ─── calculateQueuePriority ──────────────────────────────────────────────────

describe("stage5-review: calculateQueuePriority", () => {
  it("should return priority 1 for criminal record", () => {
    const p = calculateQueuePriority(0.8, { criminalRecordFound: true, amlHit: false, isPEP: false });
    assert.strictEqual(p, 1);
  });

  it("should return priority 1 for AML hit", () => {
    const p = calculateQueuePriority(0.8, { criminalRecordFound: false, amlHit: true, isPEP: false });
    assert.strictEqual(p, 1);
  });

  it("should return priority 2 for PEP", () => {
    const p = calculateQueuePriority(0.8, { criminalRecordFound: false, amlHit: false, isPEP: true });
    assert.strictEqual(p, 2);
  });

  it("should return priority 3 for uncertain confidence (active learning)", () => {
    const p = calculateQueuePriority(0.5, { criminalRecordFound: false, amlHit: false, isPEP: false });
    assert.strictEqual(p, 3);
  });

  it("should return priority 3 at lower uncertainty boundary", () => {
    const p = calculateQueuePriority(UNCERTAINTY_LOW, { criminalRecordFound: false, amlHit: false, isPEP: false });
    assert.strictEqual(p, 3);
  });

  it("should return priority 3 at upper uncertainty boundary", () => {
    const p = calculateQueuePriority(UNCERTAINTY_HIGH, { criminalRecordFound: false, amlHit: false, isPEP: false });
    assert.strictEqual(p, 3);
  });

  it("should return priority 5 for high confidence", () => {
    const p = calculateQueuePriority(0.85, { criminalRecordFound: false, amlHit: false, isPEP: false });
    assert.strictEqual(p, 5);
  });

  it("should return priority 5 for low confidence (below uncertainty range)", () => {
    const p = calculateQueuePriority(0.2, { criminalRecordFound: false, amlHit: false, isPEP: false });
    assert.strictEqual(p, 5);
  });
});

// ─── buildSignalSummary ──────────────────────────────────────────────────────

describe("stage5-review: buildSignalSummary", () => {
  it("should include loan ID", () => {
    const summary = buildSignalSummary("loan-123", baseApplicant, {});
    assert.ok(summary.includes("loan-123"));
  });

  it("should include applicant name", () => {
    const summary = buildSignalSummary("loan-123", baseApplicant, {});
    assert.ok(summary.includes("Juan"));
    assert.ok(summary.includes("Pérez"));
  });

  it("should include all stage sections when provided", () => {
    const summary = buildSignalSummary("loan-123", baseApplicant, baseSignals);
    assert.ok(summary.includes("Stage 0"));
    assert.ok(summary.includes("Stage 1"));
    assert.ok(summary.includes("Stage 2"));
    assert.ok(summary.includes("Stage 3"));
    assert.ok(summary.includes("Stage 4"));
    assert.ok(summary.includes("Bureau"));
    assert.ok(summary.includes("RiskSeal"));
    assert.ok(summary.includes("Loan Details"));
  });

  it("should handle missing stages gracefully", () => {
    const summary = buildSignalSummary("loan-123", baseApplicant, { stage0: { infonavit: {} } });
    assert.ok(summary.includes("Stage 0"));
    assert.ok(!summary.includes("Stage 1"));
  });
});

// ─── runAMLCheck (mock mode) ─────────────────────────────────────────────────

describe("stage5-review: runAMLCheck", () => {
  it("should return clear status for normal applicant", async () => {
    const result = await runAMLCheck({ ...baseApplicant, rfc: "PEPJ900101ABC" });
    assert.strictEqual(result.status, "clear");
    assert.strictEqual(result.amlHit, false);
    assert.strictEqual(result.criminalRecordFound, false);
    assert.strictEqual(result.isPEP, false);
  });

  it("should return flagged for AML hit (XXX mock)", async () => {
    const result = await runAMLCheck({ ...baseApplicant, rfc: "PEPJ900101XXX" });
    assert.strictEqual(result.status, "flagged");
    assert.strictEqual(result.amlHit, true);
    assert.strictEqual(result.criminalRecordFound, true);
    assert.strictEqual(result.requiresHumanReview, true);
  });

  it("should return flagged for PEP (YYY mock)", async () => {
    const result = await runAMLCheck({ ...baseApplicant, rfc: "PEPJ900101YYY" });
    assert.strictEqual(result.status, "flagged");
    assert.strictEqual(result.isPEP, true);
    assert.ok(result.pepPosition);
  });

  it("should not auto-reject on AML hit (flag for human instead)", async () => {
    const result = await runAMLCheck({ ...baseApplicant, rfc: "PEPJ900101XXX" });
    // AML hit should flag for review, not return a reject decision
    assert.strictEqual(result.requiresHumanReview, true);
    assert.ok(!result.autoReject);
  });
});

// ─── runStage5 (integration with mocks) ──────────────────────────────────────

describe("stage5-review: runStage5", () => {
  it("should return pending_review decision", async () => {
    const result = await runStage5({
      loanId: "test-loan-001",
      correlationId: "corr-001",
      applicant: { ...baseApplicant, rfc: "PEPJ900101ABC" },
      accumulatedSignals: baseSignals,
      firestore: null, // skip Firestore write
    });

    assert.strictEqual(result.stage, 5);
    assert.strictEqual(result.stageName, "aml_review");
    assert.strictEqual(result.decision, "pending_review");
    assert.ok(result.riskLevel);
    assert.ok(result.priority);
    assert.ok(result.slaDeadline);
    assert.ok(result.startedAt);
    assert.ok(result.completedAt);
  });

  it("should write to review queue when firestore is provided", async () => {
    const mockFS = createMockFirestore();
    const result = await runStage5({
      loanId: "test-loan-002",
      correlationId: "corr-002",
      applicant: { ...baseApplicant, rfc: "PEPJ900101ABC" },
      accumulatedSignals: baseSignals,
      firestore: mockFS,
    });

    assert.ok(result.reviewQueueId);
    assert.strictEqual(mockFS._docs.length, 1);
    assert.strictEqual(mockFS._docs[0].collection, "review_queue");
    assert.strictEqual(mockFS._docs[0].loanId, "test-loan-002");
    assert.strictEqual(mockFS._docs[0].status, "pending");
    assert.strictEqual(mockFS._docs[0].assignedTo, null);
    assert.ok(mockFS._docs[0].slaDeadline);
  });

  it("should set critical risk level for AML hit", async () => {
    const result = await runStage5({
      loanId: "test-loan-003",
      correlationId: "corr-003",
      applicant: { ...baseApplicant, rfc: "PEPJ900101XXX" },
      accumulatedSignals: baseSignals,
      firestore: null,
    });

    assert.strictEqual(result.riskLevel, "critical");
    assert.strictEqual(result.priority, 1);
    assert.ok(result.reason.includes("AML hit") || result.reason.includes("Criminal record"));
  });

  it("should set high risk level for PEP (YYY mock has AML fuzzy + PEP)", async () => {
    const result = await runStage5({
      loanId: "test-loan-004",
      correlationId: "corr-004",
      applicant: { ...baseApplicant, rfc: "PEPJ900101YYY" },
      accumulatedSignals: baseSignals,
      firestore: null,
    });

    // YYY mock has both fuzzy AML hit and PEP → high risk, priority 1 (AML hit flag)
    assert.strictEqual(result.riskLevel, "high");
    assert.strictEqual(result.priority, 1);
    assert.ok(result.reason.includes("PEP") || result.reason.includes("AML"));
  });

  it("should include LLM narrative in details (fallback when no API key)", async () => {
    const result = await runStage5({
      loanId: "test-loan-005",
      correlationId: "corr-005",
      applicant: { ...baseApplicant, rfc: "PEPJ900101ABC" },
      accumulatedSignals: baseSignals,
      firestore: null,
    });

    assert.ok(result.details.llm);
    assert.ok(result.details.llm.summary);
    assert.strictEqual(result.details.llm.recommendation, "manual_review");
  });

  it("should handle firestore write failure gracefully", async () => {
    const brokenFS = {
      collection: () => ({
        add: async () => { throw new Error("Firestore unavailable"); },
      }),
    };

    const result = await runStage5({
      loanId: "test-loan-006",
      correlationId: "corr-006",
      applicant: { ...baseApplicant, rfc: "PEPJ900101ABC" },
      accumulatedSignals: baseSignals,
      firestore: brokenFS,
    });

    // Should still return a result, just without reviewQueueId
    assert.strictEqual(result.decision, "pending_review");
    assert.strictEqual(result.reviewQueueId, null);
  });

  it("should include SLA deadline (24 hours from now)", async () => {
    const result = await runStage5({
      loanId: "test-loan-007",
      correlationId: "corr-007",
      applicant: { ...baseApplicant, rfc: "PEPJ900101ABC" },
      accumulatedSignals: baseSignals,
      firestore: null,
    });

    const deadline = new Date(result.slaDeadline);
    const now = new Date();
    const hoursUntilDeadline = (deadline - now) / (1000 * 60 * 60);
    assert.ok(hoursUntilDeadline > 23 && hoursUntilDeadline <= 24.1,
      `SLA deadline should be ~24 hours away, got ${hoursUntilDeadline} hours`);
  });

  it("should include AML details in result", async () => {
    const result = await runStage5({
      loanId: "test-loan-008",
      correlationId: "corr-008",
      applicant: { ...baseApplicant, rfc: "PEPJ900101ABC" },
      accumulatedSignals: baseSignals,
      firestore: null,
    });

    assert.ok(result.details.aml);
    assert.strictEqual(typeof result.details.aml.amlHit, "boolean");
    assert.ok(Array.isArray(result.details.aml.amlLists));
  });
});

// ─── Active Learning Routing ─────────────────────────────────────────────────

describe("stage5-review: active learning routing", () => {
  it("should have correct uncertainty boundaries", () => {
    assert.strictEqual(UNCERTAINTY_LOW, 0.4);
    assert.strictEqual(UNCERTAINTY_HIGH, 0.6);
  });

  it("should prioritize uncertain cases in review queue", async () => {
    const mockFS = createMockFirestore();

    // Clean case — low priority
    await runStage5({
      loanId: "test-clean",
      correlationId: "corr-clean",
      applicant: { ...baseApplicant, rfc: "PEPJ900101ABC" },
      accumulatedSignals: baseSignals,
      firestore: mockFS,
    });

    const doc = mockFS._docs[0];
    // Without API key, LLM returns confidence 0.5 (in uncertain range)
    // so priority should be 3 (active learning)
    assert.strictEqual(doc.priority, 3);
  });
});

// ─── AML/Criminal Screening Failure ──────────────────────────────────────────

describe("stage5-review: AML/criminal screening failure", () => {
  const originalMetamapMock = process.env.METAMAP_MOCK;
  const fetchMock = require("node-fetch");

  afterEach(() => {
    process.env.METAMAP_MOCK = originalMetamapMock;
    fetchMock.mockReset();
  });

  it("does not let a failed AML/criminal/PEP screen look identical to a clean one", async () => {
    // Simulate a MetaMap outage during the AML screen itself (createVerification
    // never gets past auth), the same shape of failure that previously caused
    // Belvo and SAT lookups elsewhere in this codebase to silently clear flags.
    process.env.METAMAP_MOCK = "false";
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await runStage5({
      loanId: "test-aml-outage",
      correlationId: "corr-aml-outage",
      applicant: { ...baseApplicant, rfc: "PEPJ900101ABC" },
      accumulatedSignals: baseSignals,
      firestore: null,
    });

    // A screen we couldn't run at all must not be indistinguishable from one
    // that came back clean: the reviewer needs to be told the screen failed
    // instead of reading a generic "Escalated from Stage 4" as "AML is clear",
    // risk level should not default to "medium" as if nothing were wrong, and
    // it should be queued at top priority since we have zero AML signal —
    // higher urgency than a case we actually screened and are merely unsure about.
    assert.ok(/aml|screening/i.test(result.reason),
      `reason should mention the AML screening failure, got: ${result.reason}`);
    assert.strictEqual(result.riskLevel, "high",
      `an unscreened applicant should not default to riskLevel "medium", got: ${result.riskLevel}`);
    assert.strictEqual(result.priority, 1,
      `an AML screening failure should get top queue priority, got: ${result.priority}`);
  }, 15000);
});

// ─── Review Queue Document Structure ─────────────────────────────────────────

describe("stage5-review: review queue document", () => {
  it("should have all required fields", async () => {
    const mockFS = createMockFirestore();

    await runStage5({
      loanId: "test-structure",
      correlationId: "corr-structure",
      applicant: { ...baseApplicant, rfc: "PEPJ900101ABC" },
      accumulatedSignals: baseSignals,
      firestore: mockFS,
    });

    const doc = mockFS._docs[0];
    assert.ok(doc.loanId, "Missing loanId");
    assert.ok(doc.correlationId, "Missing correlationId");
    assert.ok(doc.risk_level, "Missing risk_level");
    assert.ok(doc.llm_narrative, "Missing llm_narrative");
    assert.ok(doc.queuedAt, "Missing queuedAt");
    assert.strictEqual(doc.assignedTo, null, "assignedTo should be null");
    assert.strictEqual(doc.status, "pending", "status should be pending");
    assert.ok(doc.slaDeadline, "Missing slaDeadline");
    assert.strictEqual(doc.reviewedAt, null, "reviewedAt should be null");
    assert.strictEqual(doc.reviewedBy, null, "reviewedBy should be null");
    assert.strictEqual(doc.reviewDecision, null, "reviewDecision should be null");
    assert.strictEqual(doc.reviewNotes, null, "reviewNotes should be null");
    assert.ok(typeof doc.priority === "number", "priority should be a number");
  });
});
