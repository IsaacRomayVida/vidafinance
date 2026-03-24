"use strict";

const APPLICANT = {
  rfc: "ROMA850101ABC",
  curp: "ROMA850101HDFRML09",
  firstName: "Juan",
  lastName: "Romero",
  email: "juan@example.com",
  phone: "+5215512345678",
  ipAddress: "187.190.1.1",
  sessionKey: "session-ok",
  userId: "user-123",
  monthlySalary: 22000,
  principalAmount: 3000,
  employmentTenureMonths: 36,
  payFrequency: "biweekly",
  employerTier: 1,
  sectorCode: "52",
  age: 35,
};

const EMPLOYER = {
  rfc: "ABC123456XY0",
  companyName: "Acme Corp",
  stateCode: "09",
  payrollSystem: "SAP",
  employeeCount: 100,
  sampleCurps: ["CURP1", "CURP2", "CURP3"],
};

// Stubs — prefixed with "mock" so Jest allows them in factory scope
let mockMetamapResult;
let mockMetamapCalls;

jest.mock("./metamap-client", () => ({
  STAGE_4_MODULES: ["document-verification", "liveness", "facematch", "device-fingerprint"],
  STAGE_5_MODULES: ["aml-screening", "criminal-records", "pep-check"],
  createVerification: jest.fn(),
  pollVerification: jest.fn(),
  checkBehavioralRisk: jest.fn(),
}));
jest.mock("./belvo-client", () => ({
  getIMSSEmployment: jest.fn(() => Promise.resolve({ records: [], provider: "belvo" })),
  getINFONAVIT: jest.fn(() => Promise.resolve({ balance: 0, credit_status: "none" })),
  getAFORE: jest.fn(() => Promise.resolve([{ balance: 150000 }])),
  verifyEmployerIMSS: jest.fn(() => Promise.resolve([
    { curp: "CURP1", rfcMatch: true, sbc: 25000, tenure: 36 },
    { curp: "CURP2", rfcMatch: true, sbc: 20000, tenure: 24 },
    { curp: "CURP3", rfcMatch: false, sbc: 15000, tenure: 12 },
  ])),
  getClient: jest.fn(),
  getISSSTE: jest.fn(),
}));
jest.mock("./riskseal-client", () => ({
  checkDigitalFootprint: jest.fn(() => Promise.resolve({ score: 72, risk_level: "medium", pass: true })),
}));
jest.mock("./verifik", () => ({
  checkSATTaxpayer: jest.fn(() => Promise.resolve({ pass: true, statusSat: "ACTIVO" })),
  validateRFC: jest.fn(),
  checkRPP: jest.fn(),
}));
jest.mock("./sw-client", () => ({
  getSWToken: jest.fn(),
  check69B: jest.fn(() => Promise.resolve({ pass: true, situacion: null, hardReject: false, flag: false })),
  checkArt69: jest.fn(() => Promise.resolve({ pass: true, hasDebt: false })),
}));
jest.mock("./gov-apis", () => ({
  checkDENUE: jest.fn(() => Promise.resolve({ pass: true, found: true })),
  checkREPSE: jest.fn(() => Promise.resolve({ pass: true, registrado: true, vigente: true })),
  checkCNBVSector: jest.fn(() => Promise.resolve({ pass: true, riskLevel: "bajo" })),
  checkGeolocation: jest.fn(),
  checkCFDI: jest.fn(),
  checkCedula: jest.fn(),
  checkREPUVE: jest.fn(),
  checkCONDUSEF: jest.fn(),
}));
jest.mock("node-fetch", () => jest.fn(() => Promise.resolve({
  ok: true,
  json: () => Promise.resolve({ is_fraud: false, anomaly_score: 10 }),
})));

const { runPipeline, sumCosts, STAGE_NAMES } = require("./decision-engine");
const metamapClient = require("./metamap-client");

beforeEach(() => {
  jest.clearAllMocks();
  mockMetamapCalls = [];
  mockMetamapResult = { pass: true, mocked: true, verificationId: "mock-mm" };

  metamapClient.createVerification.mockImplementation((...args) => {
    mockMetamapCalls.push(args);
    return Promise.resolve(mockMetamapResult);
  });
  metamapClient.pollVerification.mockImplementation(() => Promise.resolve(mockMetamapResult));
  metamapClient.checkBehavioralRisk.mockImplementation(() =>
    Promise.resolve({ pass: true, risk_level: "low", score: 15, mocked: true })
  );
});

describe("Decision Engine — MetaMap integration", () => {
  it("uses MetaMap for behavioral risk in Stage 0", async () => {
    const fetch = require("node-fetch");
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

    const result = await runPipeline(
      { applicant: APPLICANT, employer: EMPLOYER },
      { logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }
    );

    expect(result.decision).toBe("approved");
    expect(metamapClient.checkBehavioralRisk).toHaveBeenCalled();
  });

  it("rejects when MetaMap behavioral signals detect very high risk", async () => {
    metamapClient.checkBehavioralRisk.mockImplementation(() =>
      Promise.resolve({ pass: false, risk_level: "very_high", score: 95, mocked: true })
    );

    const fetch = require("node-fetch");
    fetch.mockImplementation(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ is_fraud: false, anomaly_score: 10 }),
    }));

    const result = await runPipeline(
      { applicant: APPLICANT, employer: EMPLOYER },
      { logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }
    );

    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("DEVICE_FRAUD_DETECTED");
  });

  it("pipeline exports expected function names", () => {
    expect(STAGE_NAMES).toEqual([
      "employerA", "employerB", "stage0", "stage1",
      "stage2", "stage3", "stage4", "stage5",
    ]);
  });

  it("sumCosts aggregates across stages", () => {
    const results = {
      employerA: { cost: [{ api: "verifik", mxn: 1.5 }] },
      stage2: { cost: [{ api: "belvo", mxn: 3.0 }, { api: "metamap", mxn: 5.0 }] },
    };
    const { totalMXN, items } = sumCosts(results);
    expect(totalMXN).toBe(9.5);
    expect(items.length).toBe(3);
  });
});
