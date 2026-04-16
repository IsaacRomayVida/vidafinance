"use strict";

// ── Mock external dependencies before requiring the module ──────────────────
jest.mock("../../belvo-client", () => ({
  getIMSSEmployment: jest.fn(),
  getAFORE: jest.fn(),
}));

jest.mock("node-fetch", () => jest.fn());

const { getIMSSEmployment, getAFORE } = require("../../belvo-client");
const fetch = require("node-fetch");

const {
  runBureauAndEmployment,
  computeLTI,
} = require("../stage2-bureau");

// ── Fixtures ────────────────────────────────────────────────────────────────

const BASE_APPLICANT = {
  curp: "ROML900101HDFRRS01",
  rfc: "ROML900101XXX",
  fullName: "LUIS ROMERO MARTINEZ",
  dateOfBirth: "1990-01-01",
  principalAmount: 3000,
  monthlySalary: 15000,
  payFrequency: "biweekly",
  industryCode: 1,
};

const IMSS_ACTIVE = [
  {
    status: "activo",
    employer_rfc: "EMP120101AAA",
    tenure_months: 24,
    base_salary: 450,
  },
];

const AFORE_DATA = [{ balance: 85000 }];

function mockMLFetch(ok = true) {
  fetch.mockImplementation(() =>
    ok
      ? Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ pDefault: 0.05, model: "woe_scorecard" }),
        })
      : Promise.reject(new Error("ML service down"))
  );
}

function mockBureauFetch(ok = true) {
  // node-fetch is used for both bureau and ML calls in stage2
  // We mock a single implementation that serves both
  fetch.mockImplementation((url) => {
    if (!ok) return Promise.reject(new Error("Bureau service down"));
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve(
          url.includes("bureau")
            ? { bureau_score: 650, has_bureau_record: true, active_defaults: 0, competitor_loans: 0 }
            : { pDefault: 0.05, model: "woe_scorecard" }
        ),
    });
  });
}

// ── computeLTI ──────────────────────────────────────────────────────────────

describe("computeLTI", () => {
  it("calculates LTI as percentage", () => {
    expect(computeLTI(3000, 15000)).toBeCloseTo(20);
    expect(computeLTI(5000, 20000)).toBeCloseTo(25);
  });

  it("returns 100 when net income is 0 or negative", () => {
    expect(computeLTI(3000, 0)).toBe(100);
    expect(computeLTI(3000, -1000, 500)).toBe(100);
  });

  it("handles deductions", () => {
    // net = 15000 - 5000 = 10000, LTI = 3000/10000 * 100 = 30
    expect(computeLTI(3000, 15000, 5000)).toBeCloseTo(30);
  });
});

// ── runBureauAndEmployment ──────────────────────────────────────────────────

describe("runBureauAndEmployment", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    getIMSSEmployment.mockResolvedValue(IMSS_ACTIVE);
    getAFORE.mockResolvedValue(AFORE_DATA);
    mockBureauFetch();
  });

  it("returns IMSS data on success", async () => {
    const result = await runBureauAndEmployment(BASE_APPLICANT, {}, { logger });
    expect(result.pass).toBe(true);
    expect(result.data.imss.active).toBe(true);
    expect(result.data.imss.sbc).toBe(450);
    expect(result.data.imss.tenureMonths).toBe(24);
    expect(result.data.imss.employerRfc).toBe("EMP120101AAA");
  });

  it("returns AFORE data on success", async () => {
    const result = await runBureauAndEmployment(BASE_APPLICANT, {}, { logger });
    expect(result.data.afore.balance).toBe(85000);
    expect(result.data.afore.regular).toBe(true);
  });

  it("handles IMSS error gracefully with belvoDetail", async () => {
    const belvoError = new Error("getIMSSEmployment — status=400 — institution not available in sandbox");
    belvoError.belvoDetail = {
      context: "getIMSSEmployment",
      message: "institution not available in sandbox",
      code: 400,
      detail: "imss_mx_employment connector is not enabled for sandbox",
      body: { code: "institution_not_available", message: "institution not available in sandbox" },
      stack: belvoError.stack,
      summary: "getIMSSEmployment — status=400 — institution not available in sandbox",
    };
    getIMSSEmployment.mockRejectedValue(belvoError);

    const result = await runBureauAndEmployment(BASE_APPLICANT, {}, { logger });
    expect(result.data.imss.skipped).toBe(true);
    expect(result.data.imss.belvoDetail).toBeTruthy();
    expect(result.data.imss.belvoDetail.code).toBe(400);
    expect(result.data.imss.belvoDetail.context).toBe("getIMSSEmployment");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "stage2",
        belvoDetail: expect.objectContaining({ context: "getIMSSEmployment" }),
      }),
      expect.stringContaining("IMSS check failed")
    );
  });

  it("handles AFORE error gracefully with belvoDetail", async () => {
    const belvoError = new Error("getAFORE — status=400 — connector not enabled");
    belvoError.belvoDetail = {
      context: "getAFORE",
      message: "connector not enabled",
      code: 400,
      detail: null,
      body: null,
      stack: belvoError.stack,
      summary: "getAFORE — status=400 — connector not enabled",
    };
    getAFORE.mockRejectedValue(belvoError);

    const result = await runBureauAndEmployment(BASE_APPLICANT, {}, { logger });
    expect(result.data.afore.skipped).toBe(true);
    expect(result.data.afore.belvoDetail).toBeTruthy();
    expect(result.data.afore.belvoDetail.context).toBe("getAFORE");
    expect(result.data.afore.balance).toBe(0);
  });

  it("captures empty-message errors with fallback text", async () => {
    const emptyErr = new Error("");
    emptyErr.belvoDetail = {
      context: "getIMSSEmployment",
      message: "(empty message)",
      code: null,
      detail: null,
      body: null,
      stack: emptyErr.stack,
      summary: "getIMSSEmployment — (empty message)",
    };
    getIMSSEmployment.mockRejectedValue(emptyErr);

    const result = await runBureauAndEmployment(BASE_APPLICANT, {}, { logger });
    expect(result.data.imss.error).toBe("(empty message)");
    expect(result.data.imss.belvoDetail).toBeTruthy();
  });

  it("always passes (decision is in Stage 3)", async () => {
    const result = await runBureauAndEmployment(BASE_APPLICANT, {}, { logger });
    expect(result.pass).toBe(true);
  });

  it("tracks cost items", async () => {
    const result = await runBureauAndEmployment(BASE_APPLICANT, {}, { logger });
    const apis = result.cost.map(c => c.api);
    expect(apis).toContain("belvo-imss-employment");
    expect(apis).toContain("belvo-afore");
  });

  it("handles ML scoring errors gracefully", async () => {
    fetch.mockRejectedValue(new Error("ML service down"));
    const result = await runBureauAndEmployment(BASE_APPLICANT, {}, { logger });
    expect(result.pass).toBe(true);
    expect(result.data.mlScore.skipped).toBe(true);
  });
});
