"use strict";

/**
 * Decision Engine Unit Tests — MetaMap as sole KYC/AML provider.
 *
 * Tests Stage 4 (Full KYC via MetaMap) and Stage 5 (AML via MetaMap)
 * through the pipeline orchestrator.
 */

const GOOD_EMPLOYER = {
  rfc: "ABC123456XY0",
  companyName: "Acme Corp",
  stateCode: "09",
  payrollSystem: "SAP",
  employeeCount: 100,
  sampleCurps: ["CURP1", "CURP2", "CURP3"],
};

const APPLICANT = {
  rfc: "ROMA850101ABC",
  curp: "ROMA850101HDFRML09",
  firstName: "Juan",
  lastName: "Romero",
  email: "juan@example.com",
  phone: "+5215512345678",
  sessionKey: "session-ok",
  userId: "user-001",
  monthlySalary: 22000,
  principalAmount: 3000,
  employmentTenureMonths: 36,
  payFrequency: "biweekly",
  employerTier: 1,
  sectorCode: "52",
  age: 35,
  ipAddress: "187.190.1.1",
};

// ── Mock all external dependencies ─────────────────────────────────────

jest.mock("./metamap-client", () => ({
  STAGE_4_MODULES: ["document-verification", "liveness", "facematch", "device-fingerprint", "behavioral-analysis", "government-check"],
  STAGE_5_MODULES: ["aml-screening", "criminal-records", "pep-check"],
  createVerification: jest.fn(),
  pollVerification: jest.fn(),
  checkBehavioralRisk: jest.fn(),
}));
jest.mock("./belvo-client", () => ({
  getIMSSEmployment: jest.fn(),
  getINFONAVIT: jest.fn(),
  getAFORE: jest.fn(),
  verifyEmployerIMSS: jest.fn(),
  getISSSTE: jest.fn(),
  getClient: jest.fn(),
}));
jest.mock("./riskseal-client", () => ({
  checkDigitalFootprint: jest.fn(),
}));
jest.mock("./verifik", () => ({
  checkSATTaxpayer: jest.fn(),
  validateRFC: jest.fn(),
  checkRPP: jest.fn(),
}));
jest.mock("./sw-client", () => ({
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
jest.mock("node-fetch", () => jest.fn());

const { runPipeline } = require("./decision-engine");
const metamapClient = require("./metamap-client");
const belvoClient = require("./belvo-client");
const riskseal = require("./riskseal-client");
const verifik = require("./verifik");
const sw = require("./sw-client");
const govApis = require("./gov-apis");
const fetch = require("node-fetch");

const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function setupHappyPath() {
  // Employer Part A
  verifik.checkSATTaxpayer.mockResolvedValue({ pass: true, statusSat: "ACTIVO" });
  sw.check69B.mockResolvedValue({ pass: true, situacion: null, hardReject: false, flag: false });
  sw.checkArt69.mockResolvedValue({ pass: true, hasDebt: false });
  govApis.checkDENUE.mockResolvedValue({ pass: true, found: true });
  govApis.checkREPSE.mockResolvedValue({ pass: true, registrado: true, vigente: true });

  // Employer Part B
  belvoClient.verifyEmployerIMSS.mockResolvedValue([
    { curp: "CURP1", rfcMatch: true, sbc: 25000, tenure: 36 },
    { curp: "CURP2", rfcMatch: true, sbc: 20000, tenure: 24 },
    { curp: "CURP3", rfcMatch: false, sbc: 15000, tenure: 12 },
  ]);

  // Stage 0
  metamapClient.checkBehavioralRisk.mockResolvedValue({ risk_level: "low", score: 15, pass: true });
  belvoClient.getINFONAVIT.mockResolvedValue({ balance: 0, credit_status: "none" });
  riskseal.checkDigitalFootprint.mockResolvedValue({ score: 72, risk_level: "medium", pass: true });
  fetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ is_fraud: false, anomaly_score: 10 }),
  });

  // Stage 1
  govApis.checkCNBVSector.mockResolvedValue({ pass: true, riskLevel: "bajo" });

  // Stage 2
  belvoClient.getIMSSEmployment.mockResolvedValue([{
    base_salary: 22000, tenure_months: 36, employer_rfc: "ABC123456XY0",
  }]);
  belvoClient.getAFORE.mockResolvedValue([{ balance: 150000 }]);
}

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
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ is_fraud: false, anomaly_score: 10 }),
    });
  });
});

describe("MetaMap as sole provider", () => {
  describe("Stage 0 — Behavioral biometrics via MetaMap", () => {
    it("calls MetaMap checkBehavioralRisk for device fingerprinting", async () => {
      await runPipeline(
        { applicant: APPLICANT, employer: GOOD_EMPLOYER },
        { logger: silentLogger }
      );

      expect(metamapClient.checkBehavioralRisk).toHaveBeenCalledWith(
        APPLICANT.sessionKey,
        APPLICANT.userId
      );
    });

    it("rejects when MetaMap behavioral returns very_high risk", async () => {
      metamapClient.checkBehavioralRisk.mockResolvedValue({
        risk_level: "very_high", score: 95, pass: false,
      });

      const result = await runPipeline(
        { applicant: APPLICANT, employer: GOOD_EMPLOYER },
        { logger: silentLogger }
      );

      expect(result.decision).toBe("rejected");
      expect(result.reason).toBe("DEVICE_FRAUD_DETECTED");
    });

    it("continues with flag when MetaMap behavioral returns high risk", async () => {
      metamapClient.checkBehavioralRisk.mockResolvedValue({
        risk_level: "high", score: 72, pass: false,
      });

      const result = await runPipeline(
        { applicant: APPLICANT, employer: GOOD_EMPLOYER },
        { logger: silentLogger }
      );

      // High risk flags but doesn't reject
      expect(result.decision).toBe("approved");
      expect(result.stages.stage0.flags.behavioralFlag).toBe(true);
    });
  });

  describe("Stage 4 — Full KYC via MetaMap", () => {
    it("reaches Stage 4 when bureau score requires escalation", async () => {
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

      const result = await runPipeline(
        { applicant: { ...APPLICANT, principalAmount: 5000 }, employer: GOOD_EMPLOYER },
        { logger: silentLogger }
      );

      expect(result.stagesExecuted).toContain("stage4");
    });
  });

  describe("Stage 5 — AML via MetaMap", () => {
    it("reaches Stage 5 when bureau score requires full review", async () => {
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

      const result = await runPipeline(
        { applicant: APPLICANT, employer: GOOD_EMPLOYER },
        { logger: silentLogger }
      );

      expect(result.stagesExecuted).toContain("stage5");
    });
  });
});
