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
jest.mock("./sw-client", () => ({
  getSWToken: jest.fn(),
  check69B: jest.fn(() => Promise.resolve({ pass: true, situacion: null, hardReject: false, flag: false })),
  checkArt69: jest.fn(() => Promise.resolve({ pass: true, hasDebt: false })),
}));
// EMPLOYER_SAT_PROVIDER defaults to "local" (sat-blacklist-client), not "sw" —
// mock the default provider too so employer-a doesn't hit real GCS/firebase-admin.
jest.mock("./sat-blacklist-client", () => ({
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
jest.mock("./redis-client", () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue("OK"),
}));
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
          json: () =>
            Promise.resolve({
              bureau_score: 720,
              has_bureau_record: true,
              active_defaults: 0,
              competitor_loans: 0,
              // ADR-006 conditions 11/12 read these; a clean bureau file states
              // them explicitly rather than leaving them unread and failing closed.
              dias_atraso: 0,
              cartera_vencida: false,
            }),
        });
      }
      if (typeof url === "string" && url.includes("/score")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            // Real `/score` wire shape (ml-service/main.py:485-494): championScore
            // is P(repayment), so this is the same applicant at P(default) 0.12.
            Promise.resolve({ championScore: 0.88 }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ is_fraud: false, anomaly_score: 10 }),
      });
    });

    // A Firestore handle has to be supplied for the CNBV sector lookup to run
    // at all (stage1-identity.js:97 — without `db` the result is
    // `{pass: true, skipped: true}`). `checkCNBVSector` is already mocked above
    // to return `bajo`; it was simply never being called. Since #458 an
    // auto-approval requires the sector to have actually been read, so a
    // fixture that wants an approval has to let the lookup happen. The mock
    // ignores the handle, so an empty object is enough.
    const result = await runPipeline(
      { applicant: APPLICANT, employer: EMPLOYER },
      { logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, db: {} }
    );

    expect(result.decision).toBe("approved");
    expect(metamapClient.checkBehavioralRisk).toHaveBeenCalled();
    // Every condition the gate cleared was cleared on data it actually read.
    for (const cond of result.stages.stage3.data.conditions) {
      expect(cond.source).toBe("read");
    }
  });

  it("escalates the same applicant when the CNBV sector was never looked up (#458)", async () => {
    // Identical to the case above but with no Firestore handle, so stage 1
    // returns `{pass: true, skipped: true}` for CNBV. That shape used to clear
    // condition 7 — `pass !== false` — and this applicant was auto-approved
    // with a sector nobody had resolved. It now escalates to a human.
    const fetch = require("node-fetch");
    fetch.mockImplementation((url) => {
      if (typeof url === "string" && url.includes("/bureau/query")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              bureau_score: 720,
              has_bureau_record: true,
              active_defaults: 0,
              competitor_loans: 0,
              // ADR-006 conditions 11/12 read these; a clean bureau file states
              // them explicitly rather than leaving them unread and failing closed.
              dias_atraso: 0,
              cartera_vencida: false,
            }),
        });
      }
      if (typeof url === "string" && url.includes("/score")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            // Real `/score` wire shape (ml-service/main.py:485-494): championScore
            // is P(repayment), so this is the same applicant at P(default) 0.12.
            Promise.resolve({ championScore: 0.88 }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ is_fraud: false, anomaly_score: 10 }) });
    });

    const result = await runPipeline(
      { applicant: APPLICANT, employer: EMPLOYER },
      { logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }
    );

    expect(result.decision).not.toBe("approved");
    const failed = result.stages.stage3.data.failedConditions;
    expect(failed.map((c) => c.name)).toEqual(["sector_safe"]);
    expect(failed[0].source).toBe("assumed");
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

  // Regression: `POST /underwrite` receives the principal as a sibling of
  // `applicant` (`loanAmount`), but every stage reads it as
  // `applicant.principalAmount`. The endpoint destructured `loanAmount` and then
  // never passed it on, so the pipeline underwrote every borrower as if they had
  // requested 0 MXN — silently disabling the Stage 3 LTI gate, the Stage 3
  // escalation threshold, and the Stage 0 amount-to-salary fraud feature.
  describe("loan amount reaches the pipeline", () => {
    const quietLog = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });
    const applicantWithoutAmount = () => {
      const { principalAmount, ...rest } = APPLICANT;
      return rest;
    };
    const happyPathFetch = () => {
      const fetch = require("node-fetch");
      fetch.mockImplementation((url) => {
        if (typeof url === "string" && url.includes("/bureau/query")) {
          return Promise.resolve({
            ok: true,
            json: () =>
            Promise.resolve({
              bureau_score: 720,
              has_bureau_record: true,
              active_defaults: 0,
              competitor_loans: 0,
              // ADR-006 conditions 11/12 read these; a clean bureau file states
              // them explicitly rather than leaving them unread and failing closed.
              dias_atraso: 0,
              cartera_vencida: false,
            }),
          });
        }
        if (typeof url === "string" && url.includes("/score")) {
          return Promise.resolve({
            ok: true,
            json: () =>
            // Real `/score` wire shape (ml-service/main.py:485-494): championScore
            // is P(repayment), so this is the same applicant at P(default) 0.12.
            Promise.resolve({ championScore: 0.88 }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ is_fraud: false, anomaly_score: 10 }) });
      });
    };

    it("threads a sibling loanAmount through to the Stage 2 LTI calculation", async () => {
      happyPathFetch();
      const result = await runPipeline(
        { applicant: applicantWithoutAmount(), employer: EMPLOYER, loanAmount: 3000 },
        { logger: quietLog() }
      );
      // 3000 / 22000 salary = 13.64%, not the 0% a dropped amount would produce.
      expect(result.stages.stage2.data.lti.principalAmount).toBe(3000);
      expect(result.stages.stage2.data.lti.value).toBeCloseTo(13.64, 1);
    });

    it("lets the LTI gate actually fail on an unaffordable loan", async () => {
      happyPathFetch();
      const result = await runPipeline(
        { applicant: applicantWithoutAmount(), employer: EMPLOYER, loanAmount: 12000 },
        { logger: quietLog() }
      );
      // 12000 / 22000 = 54.55%, far past the 25% ceiling. Before the fix this
      // borrower cleared the gate, because it only ever saw 0.
      const lti = result.stages.stage3.data.conditions.find((c) => c.name === "lti");
      expect(lti.value).toBeCloseTo(54.55, 1);
      expect(lti.pass).toBe(false);
      expect(result.stages.stage3.data.allPass).toBe(false);
      expect(result.decision).not.toBe("approved");
    });

    it("still accepts the principal supplied on the applicant", async () => {
      happyPathFetch();
      const result = await runPipeline(
        { applicant: APPLICANT, employer: EMPLOYER },
        { logger: quietLog() }
      );
      expect(result.stages.stage2.data.lti.principalAmount).toBe(3000);
    });

    it("prefers an explicit loanAmount over a stale applicant.principalAmount", async () => {
      happyPathFetch();
      const result = await runPipeline(
        { applicant: APPLICANT, employer: EMPLOYER, loanAmount: 5000 },
        { logger: quietLog() }
      );
      expect(result.stages.stage2.data.lti.principalAmount).toBe(5000);
    });

    it.each([
      ["omitted", undefined],
      ["zero", 0],
      ["negative", -500],
      ["a string", "3000"],
      ["NaN", NaN],
    ])("refuses to underwrite when the amount is %s", async (_label, loanAmount) => {
      await expect(
        runPipeline(
          { applicant: applicantWithoutAmount(), employer: EMPLOYER, loanAmount },
          { logger: quietLog() }
        )
      ).rejects.toThrow("MISSING_LOAN_AMOUNT");
    });

    it("does not mutate the caller's applicant object", async () => {
      happyPathFetch();
      const applicant = applicantWithoutAmount();
      await runPipeline({ applicant, employer: EMPLOYER, loanAmount: 3000 }, { logger: quietLog() });
      expect(applicant.principalAmount).toBeUndefined();
    });
  });

  it("sumCosts aggregates across stages", () => {
    const results = {
      stage0: { cost: [{ api: "riskseal", mxn: 1.5 }] },
      stage2: { cost: [{ api: "belvo", mxn: 3.0 }, { api: "metamap", mxn: 5.0 }] },
    };
    const { totalMXN, items } = sumCosts(results);
    expect(totalMXN).toBe(9.5);
    expect(items.length).toBe(3);
  });
});
