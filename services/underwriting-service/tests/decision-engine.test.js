"use strict";
/**
 * Decision Engine Tests
 * 12+ unit tests covering all stage transition paths.
 */

// ── Mock all external dependencies ─────────────────────────────────────
jest.mock("../src/sw-client", () => ({
  getSWToken: jest.fn(),
  check69B: jest.fn(),
  checkArt69: jest.fn(),
}));
jest.mock("../src/gov-apis", () => ({
  checkDENUE: jest.fn(),
  checkREPSE: jest.fn(),
  checkCNBVSector: jest.fn(),
  checkGeolocation: jest.fn(),
  checkCFDI: jest.fn(),
  checkCedula: jest.fn(),
  checkREPUVE: jest.fn(),
  checkCONDUSEF: jest.fn(),
}));
jest.mock("../src/belvo-client", () => ({
  getIMSSEmployment: jest.fn(),
  getINFONAVIT: jest.fn(),
  getAFORE: jest.fn(),
  verifyEmployerIMSS: jest.fn(),
  getISSSTE: jest.fn(),
  getClient: jest.fn(),
}));
jest.mock("../src/riskseal-client", () => ({
  checkDigitalFootprint: jest.fn(),
}));
jest.mock("../src/metamap-client", () => ({
  createVerification: jest.fn(),
  pollVerification: jest.fn(),
  checkBehavioralRisk: jest.fn(),
  STAGE_4_MODULES: ["document-verification", "liveness", "facematch", "device-fingerprint"],
  STAGE_5_MODULES: ["aml-screening", "criminal-records", "pep-check"],
}));
jest.mock("node-fetch", () => jest.fn());

const { runPipeline, sumCosts } = require("../src/decision-engine");
const { runEmployerScreening } = require("../src/stages/employer-a");
const { runEmployerDueDiligence } = require("../src/stages/employer-b");
const { runFraudGates } = require("../src/stages/stage0-fraud");
const { runIdentityValidation, parseAgeFromCurp, RFC_REGEX, CURP_REGEX } = require("../src/stages/stage1-identity");
const { evaluateAutoApprove } = require("../src/stages/stage3-autoapprove");
const { computeLTI } = require("../src/stages/stage2-bureau");

// Mocked modules
const sw = require("../src/sw-client");
const govApis = require("../src/gov-apis");
const belvo = require("../src/belvo-client");
const riskseal = require("../src/riskseal-client");
const metamap = require("../src/metamap-client");
const fetch = require("node-fetch");

// ── Test fixtures ──────────────────────────────────────────────────────
const GOOD_EMPLOYER = {
  rfc: "ABC123456XY0",
  companyName: "Acme Corp",
  stateCode: "09",
  payrollSystem: "SAP",
  employeeCount: 100,
  sampleCurps: ["CURP1", "CURP2", "CURP3"],
};

const GOOD_APPLICANT = {
  rfc: "GARA900101ABC",
  curp: "GARA900101HDFRRL09",
  email: "test@example.com",
  phone: "+5215512345678",
  ipAddress: "187.190.1.1",
  fullName: "Juan Garcia",
  firstName: "Juan",
  lastName: "Garcia",
  userId: "user-123",
  sessionKey: "session-abc",
  monthlySalary: 22000,
  principalAmount: 3000,
  employmentTenureMonths: 36,
  payFrequency: "biweekly",
  employerTier: 1,
  sectorCode: "52",
  age: 35,
};

const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function setupHappyPath() {
  // Employer Part A
  sw.check69B.mockResolvedValue({ pass: true, situacion: null, hardReject: false, flag: false });
  sw.checkArt69.mockResolvedValue({ pass: true, hasDebt: false });
  govApis.checkDENUE.mockResolvedValue({ pass: true, found: true });
  govApis.checkREPSE.mockResolvedValue({ pass: true, registrado: true, vigente: true });

  // Employer Part B
  belvo.verifyEmployerIMSS.mockResolvedValue([
    { curp: "CURP1", rfcMatch: true, sbc: 25000, tenure: 36 },
    { curp: "CURP2", rfcMatch: true, sbc: 20000, tenure: 24 },
    { curp: "CURP3", rfcMatch: false, sbc: 15000, tenure: 12 },
  ]);

  // Stage 0
  metamap.checkBehavioralRisk.mockResolvedValue({ risk_level: "low", score: 15, pass: true });
  belvo.getINFONAVIT.mockResolvedValue({ balance: 0, credit_status: "none" });
  riskseal.checkDigitalFootprint.mockResolvedValue({ score: 72, risk_level: "medium", pass: true });
  fetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ is_fraud: false, anomaly_score: 10 }),
  });

  // Stage 1
  govApis.checkCNBVSector.mockResolvedValue({ pass: true, riskLevel: "bajo" });

  // Stage 2
  belvo.getIMSSEmployment.mockResolvedValue([{
    base_salary: 22000, tenure_months: 36, employer_rfc: "ABC123456XY0",
  }]);
  belvo.getAFORE.mockResolvedValue([{ balance: 150000 }]);

  // Stage 4 & 5 (MetaMap)
  metamap.createVerification.mockResolvedValue({ verificationId: "mock-mm-123", flowRunUrl: null });
  metamap.pollVerification.mockResolvedValue({
    verificationId: "mock-mm-123",
    status: "verified",
    documentVerification: { passed: true },
    facematch: { passed: true, score: 0.95 },
    liveness: { passed: true },
    deviceFingerprint: { emulator_detected: 0, vpn_detected: 0, rooted_device: 0, device_age_days: 380, ip_reputation_score: 0.88, session_duration_seconds: 245, interaction_anomaly_score: 0.05 },
    behavioralAnalysis: { passed: true, anomalyScore: 0.08 },
    governmentCheck: { passed: true },
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  setupHappyPath();
  // ML service mock for bureau + scoring
  fetch.mockImplementation((url) => {
    if (typeof url === "string" && url.includes("/bureau/query")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ bureau_score: 720, has_bureau_record: true, active_defaults: 0, competitor_loans: 0 }),
      });
    }
    if (typeof url === "string" && url.includes("/score")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ underwritingScore: 0.82, probability: 0.18, default_probability: 0.18 }),
      });
    }
    // Default (fraud endpoint, etc.)
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ is_fraud: false, anomaly_score: 10 }),
    });
  });
});

describe("Decision Engine — Pipeline", () => {
  test("happy path: good employer + good applicant → approved at Stage 3", async () => {
    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.decision).toBe("approved");
    expect(result.correlationId).toMatch(/^uw-/);
    expect(result.stagesExecuted).toContain("employerA");
    expect(result.stagesExecuted).toContain("stage3");
    expect(result.stagesExecuted).not.toContain("stage4");
    expect(result.stagesExecuted).not.toContain("stage5");
    expect(result.cost.totalMXN).toBeGreaterThan(0);
  });

  test("EFOS DEFINITIVO → rejected at Employer Part A", async () => {
    sw.check69B.mockResolvedValue({ pass: false, situacion: "DEFINITIVO", hardReject: true, flag: false });

    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("EFOS_DEFINITIVO");
    expect(result.lastStage).toBe("employerA");
  });

  test("SAT inactive employer → rejected at Employer Part A", async () => {

    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("SAT_INACTIVE");
  });

  test("low employer score → rejected at Employer Part B", async () => {
    // Make everything fail to get a very low score
    sw.check69B.mockResolvedValue({ pass: false, situacion: "PRESUNTO", hardReject: false, flag: true });
    govApis.checkDENUE.mockResolvedValue({ pass: false, found: false });
    govApis.checkREPSE.mockResolvedValue({ pass: false, registrado: false });
    // But SAT inactive triggers employer A reject, so let's use a different approach:
    // SAT passes but EFOS is PRESUNTO + all others fail → escalates to Part B
    belvo.verifyEmployerIMSS.mockResolvedValue([
      { curp: "C1", rfcMatch: false },
      { curp: "C2", rfcMatch: false },
    ]);

    const lowEmployer = { ...GOOD_EMPLOYER, employeeCount: 2, payrollSystem: "manual" };
    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: lowEmployer },
      { logger: silentLogger }
    );

    // With PRESUNTO flag (-15) + no IMSS matches (-10) + small company (-10) + manual payroll (+0)
    // Score: 50 + 10(SAT) - 0(DENUE fail is flag) - 0(REPSE fail is flag) - 15(PRESUNTO) - 10(no IMSS match) - 10(small) = 25 → Tier 3 → reject
    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("EMPLOYER_SCORE_LOW");
  });

  test("device fraud detected → rejected at Stage 0", async () => {
    metamap.checkBehavioralRisk.mockResolvedValue({ risk_level: "very_high", score: 95, pass: false });

    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("DEVICE_FRAUD_DETECTED");
  });

  test("low RiskSeal score → escalated to Stage 5", async () => {
    riskseal.checkDigitalFootprint.mockResolvedValue({ score: 12, risk_level: "very_high", pass: false });

    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.stagesExecuted).toContain("stage5");
    expect(result.stagesExecuted).not.toContain("stage1"); // skipped intermediate stages
  });

  test("invalid RFC → rejected at Stage 1", async () => {
    const badApplicant = { ...GOOD_APPLICANT, rfc: "INVALID" };

    const result = await runPipeline(
      { applicant: badApplicant, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("INVALID_RFC_FORMAT");
  });

  test("underage applicant → rejected at Stage 1", async () => {
    // CURP with DOB in 2015 → age ~11
    const youngApplicant = { ...GOOD_APPLICANT, curp: "GARA150101HDFRRL09" };

    const result = await runPipeline(
      { applicant: youngApplicant, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("UNDERAGE");
  });

  test("Stage 3 fail with high amount → escalates to Stage 4 → approved with KYC", async () => {
    // Bureau score in the middle range, high amount
    fetch.mockImplementation((url) => {
      if (typeof url === "string" && url.includes("/bureau/query")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ bureau_score: 550, has_bureau_record: true, active_defaults: 0, competitor_loans: 0 }),
        });
      }
      if (typeof url === "string" && url.includes("/score")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ underwritingScore: 0.55, default_probability: 0.45 }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ is_fraud: false }),
      });
    });

    const result = await runPipeline(
      { applicant: { ...GOOD_APPLICANT, principalAmount: 5000 }, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.stagesExecuted).toContain("stage4");
    // KYC mock returns APPROVED → should be approved
    expect(result.decision).toBe("approved");
  });

  test("Stage 4 KYC declined → rejected", async () => {
    // Force Stage 3 to escalate to Stage 4
    fetch.mockImplementation((url) => {
      if (typeof url === "string" && url.includes("/bureau/query")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ bureau_score: 550, has_bureau_record: true, active_defaults: 0, competitor_loans: 0 }),
        });
      }
      if (typeof url === "string" && url.includes("/score")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ underwritingScore: 0.55, default_probability: 0.45 }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ is_fraud: false }),
      });
    });

    metamap.pollVerification.mockResolvedValue({
      verificationId: "mock-mm-declined",
      status: "rejected",
      documentVerification: { passed: false, reason: "DOCUMENT_ALTERED" },
      facematch: { passed: false, score: 0.42 },
      liveness: { passed: false },
      deviceFingerprint: { emulator_detected: 0, vpn_detected: 0, rooted_device: 0, device_age_days: 380, ip_reputation_score: 0.88, session_duration_seconds: 245, interaction_anomaly_score: 0.05 },
      behavioralAnalysis: { passed: false, anomalyScore: 0.91 },
      governmentCheck: { passed: false },
    });

    const result = await runPipeline(
      { applicant: { ...GOOD_APPLICANT, principalAmount: 5000 }, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("KYC_DECLINED");
  });

  test("active defaults → escalates to Stage 5 → pending review", async () => {
    fetch.mockImplementation((url) => {
      if (typeof url === "string" && url.includes("/bureau/query")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ bureau_score: 350, has_bureau_record: true, active_defaults: 2, competitor_loans: 1 }),
        });
      }
      if (typeof url === "string" && url.includes("/score")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ underwritingScore: 0.3, default_probability: 0.7 }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ is_fraud: false }),
      });
    });

    // MetaMap returns fuzzy AML hit → human review
    metamap.pollVerification.mockResolvedValue({
      verificationId: "mock-aml-fuzzy",
      status: "flagged",
      amlScreening: { hit: true, lists: [{ list: "CNBV_LISTA_NEGRA", matchType: "FUZZY" }] },
      criminalRecords: { found: false, records: [] },
      pepCheck: { isPEP: false },
    });

    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.stagesExecuted).toContain("stage5");
    expect(result.decision).toBe("pending_review");
    expect(result.slaHours).toBe(24);
  });

  test("AML confirmed → hard rejected at Stage 5", async () => {
    fetch.mockImplementation((url) => {
      if (typeof url === "string" && url.includes("/bureau/query")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ bureau_score: 350, has_bureau_record: true, active_defaults: 2 }),
        });
      }
      if (typeof url === "string" && url.includes("/score")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ underwritingScore: 0.3, default_probability: 0.7 }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ is_fraud: false }),
      });
    });

    // MetaMap returns confirmed AML + criminal record
    metamap.pollVerification.mockResolvedValue({
      verificationId: "mock-aml-confirmed",
      status: "flagged",
      amlScreening: { hit: true, lists: [{ list: "OFAC", matchType: "CONFIRMED" }] },
      criminalRecords: { found: true, records: [{ type: "FRAUD", jurisdiction: "CDMX" }] },
      pepCheck: { isPEP: false },
    });

    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("AML_CRIMINAL_REJECT");
  });

  test("correlation ID flows through all stages", async () => {
    const customId = "uw-test-custom-123";
    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger, correlationId: customId }
    );

    expect(result.correlationId).toBe(customId);
  });

  test("total cost is calculated across all stages", async () => {
    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.cost).toBeDefined();
    expect(result.cost.totalMXN).toBeGreaterThan(0);
    expect(result.cost.items.length).toBeGreaterThan(0);
    expect(result.cost.items.every(i => i.api && i.mxn > 0)).toBe(true);
  });

  test("MetaMap is used as KYC provider in Stage 4", async () => {
    // Force into Stage 4
    fetch.mockImplementation((url) => {
      if (typeof url === "string" && url.includes("/bureau/query")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ bureau_score: 550, has_bureau_record: true, active_defaults: 0, competitor_loans: 0 }),
        });
      }
      if (typeof url === "string" && url.includes("/score")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ underwritingScore: 0.55, default_probability: 0.45 }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ is_fraud: false }),
      });
    });

    const result = await runPipeline(
      { applicant: { ...GOOD_APPLICANT, principalAmount: 5000 }, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.stagesExecuted).toContain("stage4");
    expect(metamap.createVerification).toHaveBeenCalled();
  });
});

describe("Stage Utilities", () => {
  test("parseAgeFromCurp extracts correct age", () => {
    // Born Jan 1, 1990 → age ~36 in 2026
    const age = parseAgeFromCurp("GARA900101HDFRRL09");
    expect(age).toBeGreaterThanOrEqual(35);
    expect(age).toBeLessThanOrEqual(36);
  });

  test("RFC_REGEX validates correct RFC formats", () => {
    expect(RFC_REGEX.test("GARA900101ABC")).toBe(true);  // persona fisica
    expect(RFC_REGEX.test("ABC123456XY0")).toBe(true);   // persona moral
    expect(RFC_REGEX.test("AB")).toBe(false);
    expect(RFC_REGEX.test("")).toBe(false);
  });

  test("CURP_REGEX validates correct CURP formats", () => {
    expect(CURP_REGEX.test("GARA900101HDFRRL09")).toBe(true);
    expect(CURP_REGEX.test("INVALID")).toBe(false);
  });

  test("computeLTI calculates correctly", () => {
    expect(computeLTI(3000, 22000, 0)).toBeCloseTo(13.64, 1);
    expect(computeLTI(5000, 22000, 2000)).toBe(25);
    expect(computeLTI(1000, 0, 0)).toBe(100); // zero income
  });

  test("sumCosts aggregates across stages", () => {
    const results = {
      stage2: { cost: [{ api: "belvo", mxn: 3.0 }, { api: "softcredito", mxn: 8.0 }] },
    };
    const { totalMXN, items } = sumCosts(results);
    expect(totalMXN).toBe(12.5);
    expect(items.length).toBe(3);
  });

  test("evaluateAutoApprove checks all 10 conditions", () => {
    const conditions = evaluateAutoApprove(GOOD_APPLICANT, {
      employerB: { data: { tier: 1 } },
      stage0: { data: { riskseal: { score: 72 } } },
      stage1: { data: { age: 35, cnbv: { pass: true } } },
      stage2: {
        data: {
          imss: { tenureMonths: 36 },
          bureau: { score: 720, activeDefaults: 0, competitorLoans: 0 },
          lti: { value: 13.64 },
          mlScore: { default_probability: 0.18, underwritingScore: 0.82 },
        },
      },
    });

    expect(conditions.length).toBe(10);
    expect(conditions.every(c => c.pass)).toBe(true);
  });
});
