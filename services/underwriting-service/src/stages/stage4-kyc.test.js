"use strict";
/**
 * Unit tests for stage4-kyc.js
 * Covers: MetaMap verification, Belvo cash flow, autoencoder anomaly detection,
 * biometric rejection, escalation, approval, and timeout scenarios.
 */
const assert = require("assert");

// Set mock mode before requiring modules
process.env.METAMAP_MOCK = "true";
process.env.BELVO_SECRET_ID = "test";
process.env.BELVO_SECRET_PASSWORD = "test";
process.env.BELVO_BASE_URL = "https://sandbox.belvo.com";

const {
  runStage4,
  runBelvoCashFlow,
  checkBiometricFailures,
  identifyPayrollDeposits,
  identifyLoanPayments,
  calculateRegularity,
  getKycMode,
  buildMockMetamapResult,
  ANOMALY_THRESHOLD,
  FACE_MATCH_THRESHOLD,
} = require("./stage4-kyc");

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

const baseBankConnection = {
  institutionName: "BBVA",
  linkId: "test-link-123",
};

// ─── checkBiometricFailures ──────────────────────────────────────────────────

describe("stage4-kyc: checkBiometricFailures", () => {
  it("should return null when all biometrics pass", () => {
    const result = checkBiometricFailures({
      documentVerification: { passed: true },
      liveness: { passed: true },
      facematch: { passed: true, score: 0.95 },
    });
    assert.strictEqual(result, null);
  });

  it("should reject when document verification fails", () => {
    const result = checkBiometricFailures({
      documentVerification: { passed: false, reason: "EXPIRED_DOCUMENT" },
      liveness: { passed: true },
      facematch: { passed: true, score: 0.95 },
    });
    assert.notStrictEqual(result, null);
    assert.ok(result.reason.includes("Document verification failed"));
  });

  it("should reject when liveness fails", () => {
    const result = checkBiometricFailures({
      documentVerification: { passed: true },
      liveness: { passed: false },
      facematch: { passed: true, score: 0.95 },
    });
    assert.notStrictEqual(result, null);
    assert.ok(result.reason.includes("Liveness"));
  });

  it("should reject when face match is below threshold", () => {
    const result = checkBiometricFailures({
      documentVerification: { passed: true },
      liveness: { passed: true },
      facematch: { passed: false, score: 0.65 },
    });
    assert.notStrictEqual(result, null);
    assert.ok(result.reason.includes("Face match below threshold"));
  });

  it("should pass when face match is exactly at threshold", () => {
    const result = checkBiometricFailures({
      documentVerification: { passed: true },
      liveness: { passed: true },
      facematch: { passed: true, score: FACE_MATCH_THRESHOLD },
    });
    assert.strictEqual(result, null);
  });
});

// ─── identifyPayrollDeposits ─────────────────────────────────────────────────

describe("stage4-kyc: identifyPayrollDeposits", () => {
  it("should identify regular deposits of similar amounts", () => {
    const credits = [
      { amount: 15000, valueDate: "2024-01-15", description: "NOMINA" },
      { amount: 15200, valueDate: "2024-02-15", description: "NOMINA" },
      { amount: 14900, valueDate: "2024-03-15", description: "NOMINA" },
    ];
    const result = identifyPayrollDeposits(credits);
    assert.strictEqual(result.length, 3);
  });

  it("should exclude small deposits (<1000)", () => {
    const credits = [
      { amount: 500, valueDate: "2024-01-01", description: "TRANSFERENCIA" },
      { amount: 500, valueDate: "2024-02-01", description: "TRANSFERENCIA" },
    ];
    const result = identifyPayrollDeposits(credits);
    assert.strictEqual(result.length, 0);
  });

  it("should return empty for no credits", () => {
    assert.strictEqual(identifyPayrollDeposits([]).length, 0);
    assert.strictEqual(identifyPayrollDeposits(null).length, 0);
  });

  it("should not group deposits with >10% variation", () => {
    const credits = [
      { amount: 10000, valueDate: "2024-01-15", description: "DEP1" },
      { amount: 20000, valueDate: "2024-02-15", description: "DEP2" },
    ];
    const result = identifyPayrollDeposits(credits);
    // Each group has only 1 deposit, so none qualify as payroll
    assert.strictEqual(result.length, 0);
  });
});

// ─── identifyLoanPayments ────────────────────────────────────────────────────

describe("stage4-kyc: identifyLoanPayments", () => {
  it("should identify transactions with loan keywords", () => {
    const debits = [
      { amount: -3000, valueDate: "2024-01-15", description: "PAGO CREDITO BANCOMER" },
      { amount: -500, valueDate: "2024-01-20", description: "TIENDA WALMART" },
      { amount: -2000, valueDate: "2024-02-15", description: "PRESTAMO PERSONAL" },
    ];
    const result = identifyLoanPayments(debits);
    assert.strictEqual(result.length, 2);
  });

  it("should return empty for no loan-related debits", () => {
    const debits = [
      { amount: -100, valueDate: "2024-01-15", description: "UBER" },
    ];
    assert.strictEqual(identifyLoanPayments(debits).length, 0);
  });

  it("should handle empty input", () => {
    assert.strictEqual(identifyLoanPayments([]).length, 0);
    assert.strictEqual(identifyLoanPayments(null).length, 0);
  });
});

// ─── calculateRegularity ─────────────────────────────────────────────────────

describe("stage4-kyc: calculateRegularity", () => {
  it("should return high regularity for evenly spaced deposits", () => {
    const deposits = [
      { date: "2024-01-15", amount: 15000 },
      { date: "2024-02-15", amount: 15000 },
      { date: "2024-03-15", amount: 15000 },
    ];
    const reg = calculateRegularity(deposits);
    assert.ok(reg > 0.8, `Expected regularity > 0.8, got ${reg}`);
  });

  it("should return low regularity for irregular deposits", () => {
    const deposits = [
      { date: "2024-01-01", amount: 15000 },
      { date: "2024-01-10", amount: 15000 },
      { date: "2024-03-25", amount: 15000 },
    ];
    const reg = calculateRegularity(deposits);
    assert.ok(reg < 0.5, `Expected regularity < 0.5, got ${reg}`);
  });

  it("should return 0 for fewer than 2 deposits", () => {
    assert.strictEqual(calculateRegularity([]), 0);
    assert.strictEqual(calculateRegularity([{ date: "2024-01-15", amount: 15000 }]), 0);
  });
});

// ─── runStage4 (integration with mocks) ──────────────────────────────────────

describe("stage4-kyc: runStage4", () => {
  it("should approve when all checks pass (default mock)", async () => {
    // Default mock (RFC not ending in XXX/YYY/ZZZ) → verified
    const result = await runStage4({
      loanId: "test-loan-001",
      correlationId: "corr-001",
      applicant: { ...baseApplicant, rfc: "PEPJ900101ABC" },
      bankConnection: null, // skip Belvo
      previousStages: {},
    });

    assert.strictEqual(result.stage, 4);
    assert.strictEqual(result.stageName, "full_kyc");
    assert.strictEqual(result.decision, "approve");
    assert.strictEqual(result.enhancedMonitoring, true);
    assert.ok(result.startedAt);
    assert.ok(result.completedAt);
  });

  it("should reject when document verification fails (XXX mock)", async () => {
    const result = await runStage4({
      loanId: "test-loan-002",
      correlationId: "corr-002",
      applicant: { ...baseApplicant, rfc: "PEPJ900101XXX" },
      bankConnection: null,
      previousStages: {},
    });

    assert.strictEqual(result.decision, "reject");
    assert.ok(result.reason.includes("Document verification failed"));
  });

  it("should reject when face match is below threshold (YYY mock)", async () => {
    const result = await runStage4({
      loanId: "test-loan-003",
      correlationId: "corr-003",
      applicant: { ...baseApplicant, rfc: "PEPJ900101YYY" },
      bankConnection: null,
      previousStages: {},
    });

    assert.strictEqual(result.decision, "reject");
    assert.ok(result.reason.includes("Face match below threshold"));
  });

  it("should return correct structure on approval", async () => {
    const result = await runStage4({
      loanId: "test-loan-004",
      correlationId: "corr-004",
      applicant: { ...baseApplicant, rfc: "PEPJ900101ABC" },
      bankConnection: null,
      previousStages: {},
    });

    // Check result structure
    assert.ok(result.details);
    assert.ok(result.details.metamap);
    assert.ok(result.details.metamap.verificationId);
    assert.ok(result.deviceSignals);
    assert.strictEqual(typeof result.deviceSignals.emulator_detected, "number");
    assert.strictEqual(typeof result.deviceSignals.vpn_detected, "number");
  });

  it("should handle cash flow unavailability gracefully", async () => {
    const result = await runStage4({
      loanId: "test-loan-005",
      correlationId: "corr-005",
      applicant: { ...baseApplicant, rfc: "PEPJ900101ABC" },
      bankConnection: null, // no bank connection
      previousStages: {},
    });

    // Should still approve — cash flow is supplementary
    assert.strictEqual(result.decision, "approve");
    assert.ok(result.details.cashFlow);
  });
});

// ─── Anomaly threshold ──────────────────────────────────────────────────────

describe("stage4-kyc: anomaly threshold", () => {
  it("should have a reasonable anomaly threshold", () => {
    assert.strictEqual(ANOMALY_THRESHOLD, 0.75);
  });

  it("should have correct face match threshold", () => {
    assert.strictEqual(FACE_MATCH_THRESHOLD, 0.80);
  });
});

// ─── KYC_MODE (VID3-641) ────────────────────────────────────────────────────

describe("stage4-kyc: getKycMode", () => {
  afterEach(() => {
    delete process.env.KYC_MODE;
  });

  it("should default to 'real' when KYC_MODE is not set", () => {
    delete process.env.KYC_MODE;
    assert.strictEqual(getKycMode(), "real");
  });

  it("should return 'mock_pass' when set", () => {
    process.env.KYC_MODE = "mock_pass";
    assert.strictEqual(getKycMode(), "mock_pass");
  });

  it("should return 'mock_fail' when set", () => {
    process.env.KYC_MODE = "mock_fail";
    assert.strictEqual(getKycMode(), "mock_fail");
  });

  it("should be case-insensitive", () => {
    process.env.KYC_MODE = "MOCK_PASS";
    assert.strictEqual(getKycMode(), "mock_pass");
  });

  it("should fall back to 'real' for invalid values", () => {
    process.env.KYC_MODE = "invalid_value";
    assert.strictEqual(getKycMode(), "real");
  });
});

describe("stage4-kyc: buildMockMetamapResult", () => {
  it("should return verified result for mock_pass", () => {
    const result = buildMockMetamapResult("mock_pass");
    assert.strictEqual(result.verified, true);
    assert.strictEqual(result.status, "verified");
    assert.strictEqual(result.liveness.passed, true);
    assert.strictEqual(result.documentVerification.passed, true);
    assert.strictEqual(result.facematch.passed, true);
    assert.ok(result.deviceFingerprint);
  });

  it("should return rejected result for mock_fail", () => {
    const result = buildMockMetamapResult("mock_fail");
    assert.strictEqual(result.verified, false);
    assert.strictEqual(result.status, "rejected");
    assert.strictEqual(result.documentVerification.passed, false);
    assert.strictEqual(result.documentVerification.reason, "document_quality");
  });
});

describe("stage4-kyc: runStage4 with KYC_MODE", () => {
  afterEach(() => {
    delete process.env.KYC_MODE;
  });

  it("should approve with mock_pass and skip MetaMap", async () => {
    process.env.KYC_MODE = "mock_pass";
    const result = await runStage4({
      loanId: "test-mock-001",
      correlationId: "corr-mock-001",
      applicant: baseApplicant,
      bankConnection: null,
      previousStages: {},
    });

    assert.strictEqual(result.decision, "approve");
    assert.ok(result.reason.includes("KYC_MODE=mock_pass"));
    assert.strictEqual(result.details.metamap.verificationId, "mock-kyc-pass");
    assert.strictEqual(result.enhancedMonitoring, true);
  });

  it("should reject with mock_fail due to biometric failures", async () => {
    process.env.KYC_MODE = "mock_fail";
    const result = await runStage4({
      loanId: "test-mock-002",
      correlationId: "corr-mock-002",
      applicant: baseApplicant,
      bankConnection: null,
      previousStages: {},
    });

    assert.strictEqual(result.decision, "reject");
    assert.ok(result.reason.includes("Document verification failed"));
  });
});

// ─── runBelvoCashFlow — Belvo base URL resolution ────────────────────────────

describe("stage4-kyc: runBelvoCashFlow — Belvo base URL resolution", () => {
  const BelvoClientMock = require("belvo").default;
  const ORIGINAL_BASE_URL = process.env.BELVO_BASE_URL;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    BelvoClientMock.mockClear();
  });

  afterEach(() => {
    process.env.BELVO_BASE_URL = ORIGINAL_BASE_URL;
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it("uses the explicit BELVO_BASE_URL when set", async () => {
    process.env.BELVO_BASE_URL = "https://api.belvo.com";
    process.env.NODE_ENV = "production";

    await runBelvoCashFlow(baseBankConnection, baseApplicant);

    expect(BelvoClientMock).toHaveBeenCalledWith("test", "test", "https://api.belvo.com");
  });

  it("defaults to sandbox when BELVO_BASE_URL is unset and NODE_ENV is not production", async () => {
    delete process.env.BELVO_BASE_URL;
    process.env.NODE_ENV = "staging";

    await runBelvoCashFlow(baseBankConnection, baseApplicant);

    expect(BelvoClientMock).toHaveBeenCalledWith("test", "test", "https://sandbox.belvo.com");
  });

  it("fails loudly instead of defaulting to sandbox when BELVO_BASE_URL is unset in production", async () => {
    delete process.env.BELVO_BASE_URL;
    process.env.NODE_ENV = "production";

    const result = await runBelvoCashFlow(baseBankConnection, baseApplicant);

    expect(BelvoClientMock).not.toHaveBeenCalled();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/BELVO_BASE_URL/);
  });
});
