"use strict";
/**
 * Pipeline escalation topology — end-to-end stage transitions.
 *
 * This file was `tests/decision-engine.test.js`. It was never collected by
 * jest (jest.config.js `roots` covered src/ only) and had never run once, so
 * it had drifted: it asserted reason codes that no stage emits, and it did not
 * mock redis-client or sat-blacklist-client, which made every case hang
 * forever rather than fail. See the commit that restored it.
 *
 * It is kept, rather than deleted as a duplicate of src/decision-engine.test.js,
 * because the two cover different halves of decision-engine.js. The src/ suite
 * covers Stage 0 fraud outcomes, the #458 CNBV provenance rule, and the
 * loanAmount input contract. It never reaches Stage 4 or Stage 5. Everything
 * from decision-engine.js:95 down — the escalation branches and the whole of
 * runStage5AndFinalize, including the AML hard-reject mapping that permanently
 * declines an applicant — had no test at any level. That is what this file
 * covers, and why it is named for the topology rather than for the module.
 *
 * Renamed off `decision-engine.test.js` deliberately: two files under that one
 * name, in sibling directories, only one of which ran, is a large part of why
 * nobody noticed this one was dead.
 */

// ── Mock all external dependencies ─────────────────────────────────────
// redis-client and sat-blacklist-client are mocked for the same reason the
// src/ suite mocks them: employer-a.js reads its cache at module scope
// (employer-a.js:48) and resolves its SAT provider from
// EMPLOYER_SAT_PROVIDER, which defaults to "local" — i.e. sat-blacklist-client,
// not sw-client. Omitting either was what made this suite hang: an unreachable
// Redis used to queue commands indefinitely instead of rejecting, so
// `redis.get()` never settled and no case could finish. Both the Redis client
// and this mock list have been fixed; keep both mocks.
jest.mock("./redis-client", () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue("OK"),
}));
jest.mock("./sw-client", () => ({
  getSWToken: jest.fn(),
  check69B: jest.fn(),
  checkArt69: jest.fn(),
}));
jest.mock("./sat-blacklist-client", () => ({
  getSWToken: jest.fn(),
  check69B: jest.fn(),
  checkArt69: jest.fn(),
}));
jest.mock("./gov-apis", () => ({
  checkDENUE: jest.fn(),
  checkREPSE: jest.fn(),
  checkCNBVSector: jest.fn(),
  checkGeolocation: jest.fn(),
  checkCFDI: jest.fn(),
  checkCedula: jest.fn(),
  checkREPUVE: jest.fn(),
  checkCONDUSEF: jest.fn(),
}));
jest.mock("./belvo-client", () => ({
  getIMSSEmployment: jest.fn(),
  getINFONAVIT: jest.fn(),
  getAFORE: jest.fn(),
  verifyEmployerIMSS: jest.fn(),
  getISSSTE: jest.fn(),
  getClient: jest.fn(),
  resolveBelvoBaseUrl: jest.fn(() => "https://sandbox.belvo.com"),
}));
jest.mock("./riskseal-client", () => ({
  checkDigitalFootprint: jest.fn(),
}));
jest.mock("./metamap-client", () => ({
  createVerification: jest.fn(),
  pollVerification: jest.fn(),
  getVerificationResult: jest.fn(),
  checkBehavioralRisk: jest.fn(),
  STAGE_4_MODULES: ["document-verification", "liveness", "facematch", "device-fingerprint"],
  STAGE_5_MODULES: ["aml-screening", "criminal-records", "pep-check"],
}));
jest.mock("node-fetch", () => jest.fn());
// stage3-autoapprove.js's MAX_PDEFAULT cutoff (ADR-005 Finding 5) and
// stage2-bureau.js's competitor-lender-by-name lookup (Finding 7) both read a
// Firestore config document through the same seam. Neither doc exists in
// this suite's world, so both resolve to their compile-time seed — the
// existing behaviour, unchanged. Without this mock, `admin.firestore()`
// throws synchronously ("no Firebase App '[DEFAULT]'") the first time either
// seam is touched, since index.js's `admin.initializeApp()` never runs here.
jest.mock("firebase-admin", () => ({
  firestore: () => ({
    collection: () => ({
      doc: () => ({ get: jest.fn().mockResolvedValue({ exists: false }) }),
    }),
  }),
}));

const { runPipeline } = require("./decision-engine");
const { parseAgeFromCurp, RFC_REGEX, CURP_REGEX } = require("./stages/stage1-identity");

// Mocked modules. employer-a.js picks its SAT provider at module load from
// EMPLOYER_SAT_PROVIDER; grab a handle on whichever one it actually loaded so
// these fixtures drive the calls it really makes.
const sat = require(
  (process.env.EMPLOYER_SAT_PROVIDER || "local") === "sw"
    ? "./sw-client"
    : "./sat-blacklist-client"
);
const govApis = require("./gov-apis");
const belvo = require("./belvo-client");
const riskseal = require("./riskseal-client");
const metamap = require("./metamap-client");
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

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

// A Firestore handle must be supplied for the CNBV sector lookup to run at all
// (stage1-identity.js:97). Since #458 an auto-approval requires the sector to
// have actually been read, so any fixture expecting an approval has to let the
// lookup happen. The mock ignores the handle, so `{}` is enough.
const approvableOpts = () => ({ logger: silentLogger, db: {} });

function mlFetch({ bureauScore = 720, activeDefaults = 0, competitorLoans = 0, pDefault = 0.18 } = {}) {
  fetch.mockImplementation((url) => {
    if (typeof url === "string" && url.includes("/bureau/query")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          bureau_score: bureauScore,
          has_bureau_record: true,
          active_defaults: activeDefaults,
          competitor_loans: competitorLoans,
        }),
      });
    }
    if (typeof url === "string" && url.includes("/score")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          underwritingScore: 1 - pDefault,
          probability: pDefault,
          default_probability: pDefault,
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ is_fraud: false, anomaly_score: 10 }),
    });
  });
}

function setupHappyPath() {
  // Employer Part A — reasons are lowercase snake_case (employer-a.js:92-131).
  sat.check69B.mockResolvedValue({ pass: true, situacion: null, hardReject: false, flag: false });
  sat.checkArt69.mockResolvedValue({ pass: true, hasDebt: false });
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
    deviceFingerprint: {
      emulator_detected: 0, vpn_detected: 0, rooted_device: 0, device_age_days: 380,
      ip_reputation_score: 0.88, session_duration_seconds: 245, interaction_anomaly_score: 0.05,
    },
    behavioralAnalysis: { passed: true, anomalyScore: 0.08 },
    governmentCheck: { passed: true },
  });

  mlFetch();
}

beforeEach(() => {
  jest.clearAllMocks();
  setupHappyPath();
});

// ── Terminal decisions on the employer legs ────────────────────────────
describe("employer screening rejects before any applicant data is read", () => {
  test("lista 69-B DEFINITIVO stops the pipeline at Employer Part A", async () => {
    sat.check69B.mockResolvedValue({ pass: false, situacion: "DEFINITIVO", hardReject: true, flag: false });

    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("lista_69b_definitivo");
    expect(result.lastStage).toBe("employerA");
    // Nothing downstream should have been touched.
    expect(result.stagesExecuted).toEqual(["employerA"]);
    expect(metamap.checkBehavioralRisk).not.toHaveBeenCalled();
  });

  test("a provider outage in Part A escalates to Stage 5 rather than rejecting", async () => {
    // employer-a.js:145 — Promise.allSettled turns provider errors into
    // `provider_errors_escalate` with escalateToStage 5. decision-engine.js:95
    // must route that to a human, not to a decline.
    sat.check69B.mockRejectedValue(new Error("GCS unreachable"));
    sat.checkArt69.mockRejectedValue(new Error("GCS unreachable"));
    metamap.pollVerification.mockResolvedValue({
      verificationId: "mock-aml", status: "clear",
      amlScreening: { hit: false, lists: [] },
      criminalRecords: { found: false, records: [] },
      pepCheck: { isPEP: false },
    });

    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.stagesExecuted).toContain("stage5");
    expect(result.decision).toBe("pending_review");
    // Skipped straight past the applicant stages.
    expect(result.stagesExecuted).not.toContain("stage0");
    expect(result.stagesExecuted).not.toContain("stage2");
  });

  test("a low employer score stops the pipeline at Employer Part B", async () => {
    sat.check69B.mockResolvedValue({ pass: true, situacion: "PRESUNTO", hardReject: false, flag: true });
    belvo.verifyEmployerIMSS.mockResolvedValue([
      { curp: "C1", rfcMatch: false },
      { curp: "C2", rfcMatch: false },
    ]);

    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: { ...GOOD_EMPLOYER, employeeCount: 2, payrollSystem: "manual" } },
      { logger: silentLogger }
    );

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("EMPLOYER_SCORE_LOW");
    expect(result.lastStage).toBe("employerB");
  });
});

// ── Terminal decisions on the applicant legs ───────────────────────────
describe("applicant gates reject without escalating", () => {
  test("device fraud at Stage 0 rejects outright", async () => {
    metamap.checkBehavioralRisk.mockResolvedValue({ risk_level: "very_high", score: 95, pass: false });

    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("DEVICE_FRAUD_DETECTED");
    expect(result.stagesExecuted).not.toContain("stage5");
  });

  test("an invalid RFC rejects at Stage 1", async () => {
    const result = await runPipeline(
      { applicant: { ...GOOD_APPLICANT, rfc: "INVALID" }, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("INVALID_RFC_FORMAT");
    expect(result.lastStage).toBe("stage1");
  });

  test("an underage applicant rejects at Stage 1", async () => {
    // CURP with a 2015 date of birth.
    const result = await runPipeline(
      { applicant: { ...GOOD_APPLICANT, curp: "GARA150101HDFRRL09" }, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("UNDERAGE");
  });
});

// ── Escalation topology — the branches src/decision-engine.test.js never
//    reaches. decision-engine.js:123-203 and runStage5AndFinalize.
describe("escalation routing", () => {
  test("a weak digital footprint jumps Stage 0 straight to Stage 5", async () => {
    // stage0-fraud.js:121 — LOW_DIGITAL_FOOTPRINT sets escalateToStage 5, and
    // decision-engine.js:123 must skip stages 1-4 entirely rather than
    // continuing down the pipeline.
    riskseal.checkDigitalFootprint.mockResolvedValue({ score: 12, risk_level: "very_high", pass: false });
    metamap.pollVerification.mockResolvedValue({
      verificationId: "mock-aml", status: "clear",
      amlScreening: { hit: false, lists: [] },
      criminalRecords: { found: false, records: [] },
      pepCheck: { isPEP: false },
    });

    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.stagesExecuted).toContain("stage5");
    expect(result.stagesExecuted).not.toContain("stage1");
    expect(result.stagesExecuted).not.toContain("stage2");
    expect(result.stagesExecuted).not.toContain("stage4");
  });

  test("a mid-band bureau score routes Stage 3 to Stage 4, and a clean KYC approves", async () => {
    mlFetch({ bureauScore: 550, pDefault: 0.45 });

    const result = await runPipeline(
      { applicant: { ...GOOD_APPLICANT, principalAmount: 5000 }, employer: GOOD_EMPLOYER },
      approvableOpts()
    );

    expect(result.stagesExecuted).toContain("stage4");
    expect(result.stagesExecuted).not.toContain("stage5");
    expect(result.decision).toBe("approved");
    expect(metamap.createVerification).toHaveBeenCalled();
  });

  test("a declined KYC at Stage 4 rejects with KYC_DECLINED", async () => {
    mlFetch({ bureauScore: 550, pDefault: 0.45 });
    metamap.pollVerification.mockResolvedValue({
      verificationId: "mock-mm-declined",
      status: "rejected",
      documentVerification: { passed: false, reason: "DOCUMENT_ALTERED" },
      facematch: { passed: false, score: 0.42 },
      liveness: { passed: false },
      deviceFingerprint: {
        emulator_detected: 0, vpn_detected: 0, rooted_device: 0, device_age_days: 380,
        ip_reputation_score: 0.88, session_duration_seconds: 245, interaction_anomaly_score: 0.05,
      },
      behavioralAnalysis: { passed: false, anomalyScore: 0.91 },
      governmentCheck: { passed: false },
    });

    const result = await runPipeline(
      { applicant: { ...GOOD_APPLICANT, principalAmount: 5000 }, employer: GOOD_EMPLOYER },
      approvableOpts()
    );

    expect(result.decision).toBe("rejected");
    // decision-engine.js:176 maps a stage-4 "reject" onto this code regardless
    // of which biometric failed.
    expect(result.reason).toBe("KYC_DECLINED");
  });
});

// ── runStage5AndFinalize: pending_review vs permanent decline ───────────
// decision-engine.js:216-217 decides, from the AML detail block alone, whether
// an applicant goes to a human or is declined outright. Nothing else tests it:
// stage5-review.test.js covers runStage5 itself, but not this wrapper's reading
// of its output.
describe("Stage 5 outcome mapping", () => {
  const escalatingFetch = () => mlFetch({ bureauScore: 350, activeDefaults: 2, competitorLoans: 1, pDefault: 0.7 });

  test("a fuzzy AML match goes to a human with a 24h SLA", async () => {
    escalatingFetch();
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
    expect(result.reason).not.toBe("AML_CRIMINAL_REJECT");
  });

  test("a confirmed AML list match is a permanent decline, not a review", async () => {
    escalatingFetch();
    metamap.pollVerification.mockResolvedValue({
      verificationId: "mock-aml-confirmed",
      status: "flagged",
      amlScreening: { hit: true, lists: [{ list: "OFAC", matchType: "CONFIRMED" }] },
      criminalRecords: { found: false, records: [] },
      pepCheck: { isPEP: false },
    });

    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("AML_CRIMINAL_REJECT");
    expect(result.slaHours).toBeUndefined();
  });

  test("a criminal record is a permanent decline on its own, with no AML hit", async () => {
    escalatingFetch();
    metamap.pollVerification.mockResolvedValue({
      verificationId: "mock-criminal",
      status: "flagged",
      amlScreening: { hit: false, lists: [] },
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
});

// ── Result envelope ────────────────────────────────────────────────────
describe("pipeline result envelope", () => {
  test("a caller-supplied correlation ID survives to the result", async () => {
    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger, correlationId: "uw-test-custom-123" }
    );
    expect(result.correlationId).toBe("uw-test-custom-123");
  });

  test("a generated correlation ID is namespaced", async () => {
    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      { logger: silentLogger }
    );
    expect(result.correlationId).toMatch(/^uw-/);
  });

  test("cost is aggregated from the stages that actually ran", async () => {
    const result = await runPipeline(
      { applicant: GOOD_APPLICANT, employer: GOOD_EMPLOYER },
      approvableOpts()
    );

    expect(result.cost.totalMXN).toBeGreaterThan(0);
    expect(result.cost.items.length).toBeGreaterThan(0);
    expect(result.cost.items.every((i) => i.api && i.mxn > 0)).toBe(true);
    // The total is the sum of the items, not an independently tracked number.
    const summed = result.cost.items.reduce((s, i) => s + i.mxn, 0);
    expect(result.cost.totalMXN).toBeCloseTo(summed, 6);
  });
});

// ── Stage 1 identity primitives ────────────────────────────────────────
// stage1-identity.js has no test file of its own anywhere in the package;
// these three exports are otherwise reached only indirectly. computeLTI,
// sumCosts and evaluateAutoApprove were also asserted here originally and have
// been dropped — they are covered directly by
// src/stages/__tests__/stage2-bureau.test.js, src/decision-engine.test.js and
// src/stages/__tests__/stage3-autoapprove.test.js respectively.
describe("stage 1 identity primitives", () => {
  test("parseAgeFromCurp reads the date of birth out of the CURP", () => {
    // Born 1990-01-01. Asserted as a range so the test does not expire on a
    // birthday; the 1900s/2000s century split is the part worth pinning.
    const age = parseAgeFromCurp("GARA900101HDFRRL09");
    expect(age).toBeGreaterThanOrEqual(35);
    expect(age).toBeLessThanOrEqual(36);
    // A 2015 CURP must not be read as 1915.
    expect(parseAgeFromCurp("GARA150101HDFRRL09")).toBeLessThan(18);
  });

  test("RFC_REGEX accepts both persona física and persona moral", () => {
    expect(RFC_REGEX.test("GARA900101ABC")).toBe(true);
    expect(RFC_REGEX.test("ABC123456XY0")).toBe(true);
    expect(RFC_REGEX.test("AB")).toBe(false);
    expect(RFC_REGEX.test("")).toBe(false);
  });

  test("CURP_REGEX rejects anything that is not an 18-character CURP", () => {
    expect(CURP_REGEX.test("GARA900101HDFRRL09")).toBe(true);
    expect(CURP_REGEX.test("INVALID")).toBe(false);
  });
});
