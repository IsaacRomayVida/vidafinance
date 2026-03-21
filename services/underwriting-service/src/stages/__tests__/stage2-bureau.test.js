"use strict";

// ── Mock external dependencies before requiring the module ──────────────────
jest.mock("../../belvo-client", () => ({
  getIMSSEmployment: jest.fn(),
  getAFORE: jest.fn(),
}));

jest.mock("../../../../softcredito-adapter/src/underwrite", () => ({
  callUnderwrite: jest.fn(),
  parseBureauDecision: jest.fn(),
  parsePLD: jest.fn(),
}));

jest.mock("node-fetch", () => jest.fn());

const { getIMSSEmployment, getAFORE } = require("../../belvo-client");
const { callUnderwrite, parseBureauDecision, parsePLD } = require("../../../../softcredito-adapter/src/underwrite");
const fetch = require("node-fetch");

const {
  runStage2,
  parseIMSSEmployment,
  parseAFOREContributions,
  calculateLTI,
} = require("../stage2-bureau");

// ── Fixtures ────────────────────────────────────────────────────────────────

const BASE_PARAMS = {
  curp: "ROML900101HDFRRS01",
  rfc: "ROML900101XXX",
  nombre: "LUIS",
  apellidoPaterno: "ROMERO",
  apellidoMaterno: "MARTINEZ",
  fechaNacimiento: "1990-01-01",
  employerRfc: "EMP120101AAA",
  loanAmount: 3000,
  monthlyNetIncome: 15000,
};

const CLEAN_BUREAU = {
  score: 650,
  diasAtraso: 0,
  carteraVencida: false,
  cuentasActivas: 2,
  escalateToStage: 3,
  reason: null,
  pass: true,
};

const CLEAN_PLD = {
  bloqueoListaSat: false,
  bloqueado: false,
  pass: true,
  hardReject: false,
  reason: null,
};

const IMSS_ACTIVE = [
  {
    status: "activo",
    employer_rfc: "EMP120101AAA",
    tenure_months: 24,
    base_salary: 450,
  },
];

const AFORE_DATA = [{ total_balance: 85000 }];

function mockMLFetch() {
  fetch.mockImplementation((url) => {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        pDefault: url.includes("challenger") ? 0.08 : 0.05,
        model: url.includes("challenger") ? "xgboost" : "woe_scorecard",
      }),
      text: () => Promise.resolve(""),
    });
  });
}

// ── parseIMSSEmployment ─────────────────────────────────────────────────────

describe("parseIMSSEmployment", () => {
  it("rejects when no records found", () => {
    expect(parseIMSSEmployment(null, "RFC")).toEqual({
      found: false, active: false, pass: false, reason: "no_imss_record",
    });
    expect(parseIMSSEmployment([], "RFC")).toEqual({
      found: false, active: false, pass: false, reason: "no_imss_record",
    });
  });

  it("passes with active IMSS record and employer match", () => {
    const result = parseIMSSEmployment(IMSS_ACTIVE, "EMP120101AAA");
    expect(result.found).toBe(true);
    expect(result.active).toBe(true);
    expect(result.employerMatch).toBe(true);
    expect(result.tenureMonths).toBe(24);
    expect(result.pass).toBe(true);
  });

  it("flags employer mismatch but still passes if active", () => {
    const result = parseIMSSEmployment(IMSS_ACTIVE, "DIFFERENT_RFC");
    expect(result.active).toBe(true);
    expect(result.employerMatch).toBe(false);
    expect(result.pass).toBe(true);
  });

  it("fails when status is inactivo", () => {
    const inactive = [{ ...IMSS_ACTIVE[0], status: "inactivo" }];
    const result = parseIMSSEmployment(inactive, "EMP120101AAA");
    expect(result.active).toBe(false);
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("imss_inactive");
  });
});

// ── parseAFOREContributions ─────────────────────────────────────────────────

describe("parseAFOREContributions", () => {
  it("returns irregular with zero balance when no data", () => {
    expect(parseAFOREContributions(null)).toEqual({ regular: false, balance: 0 });
    expect(parseAFOREContributions([])).toEqual({ regular: false, balance: 0 });
  });

  it("returns regular with balance when data present", () => {
    const result = parseAFOREContributions(AFORE_DATA);
    expect(result.regular).toBe(true);
    expect(result.balance).toBe(85000);
  });
});

// ── calculateLTI ────────────────────────────────────────────────────────────

describe("calculateLTI", () => {
  it("calculates LTI correctly", () => {
    expect(calculateLTI(3000, 15000)).toBeCloseTo(0.2);
    expect(calculateLTI(5000, 20000)).toBeCloseTo(0.25);
  });

  it("returns Infinity when income is 0 or negative", () => {
    expect(calculateLTI(3000, 0)).toBe(Infinity);
    expect(calculateLTI(3000, -1000)).toBe(Infinity);
  });

  it("returns 0 when loan amount is 0", () => {
    expect(calculateLTI(0, 15000)).toBe(0);
  });
});

// ── runStage2 ───────────────────────────────────────────────────────────────

describe("runStage2", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getIMSSEmployment.mockResolvedValue(IMSS_ACTIVE);
    getAFORE.mockResolvedValue(AFORE_DATA);
    callUnderwrite.mockResolvedValue({ cdc: { score: 650, diasAtraso: 0, carteraVencida: false, cuentasActivas: 2 } });
    parseBureauDecision.mockReturnValue(CLEAN_BUREAU);
    parsePLD.mockReturnValue(CLEAN_PLD);
    mockMLFetch();
  });

  it("rejects when no IMSS record found", async () => {
    getIMSSEmployment.mockResolvedValue(null);
    const result = await runStage2(BASE_PARAMS);
    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("no_imss_record");
    expect(result.bureau).toBeNull();
  });

  it("rejects on PLD hard reject", async () => {
    parsePLD.mockReturnValue({
      ...CLEAN_PLD,
      pass: false,
      hardReject: true,
      reason: "pld_sat_blacklist",
    });
    const result = await runStage2(BASE_PARAMS);
    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("pld_sat_blacklist");
  });

  it("continues to stage 3 with clean bureau", async () => {
    const result = await runStage2(BASE_PARAMS);
    expect(result.decision).toBe("continue");
    expect(result.escalateToStage).toBe(3);
    expect(result.employment.active).toBe(true);
    expect(result.bureau.score).toBe(650);
    expect(result.lti).toBeCloseTo(0.2);
  });

  it("escalates to stage 4 with score 400-599", async () => {
    parseBureauDecision.mockReturnValue({
      ...CLEAN_BUREAU,
      score: 500,
      escalateToStage: 4,
      reason: "score_400_599",
      pass: false,
    });
    const result = await runStage2(BASE_PARAMS);
    expect(result.decision).toBe("escalate");
    expect(result.escalateToStage).toBe(4);
  });

  it("escalates to stage 5 with carteraVencida", async () => {
    parseBureauDecision.mockReturnValue({
      ...CLEAN_BUREAU,
      carteraVencida: true,
      escalateToStage: 5,
      reason: "active_default",
      pass: false,
    });
    const result = await runStage2(BASE_PARAMS);
    expect(result.decision).toBe("escalate");
    expect(result.escalateToStage).toBe(5);
  });

  it("calls both ML models in parallel", async () => {
    await runStage2(BASE_PARAMS);
    expect(fetch).toHaveBeenCalledTimes(2);
    const calls = fetch.mock.calls;
    const urls = calls.map(c => c[0]);
    expect(urls.every(u => u.includes("/score/credit"))).toBe(true);
  });

  it("returns ML scores with champion and challenger", async () => {
    const result = await runStage2(BASE_PARAMS);
    expect(result.ml.champion.model).toBe("woe_scorecard");
    expect(result.ml.challenger.model).toBe("xgboost");
    expect(result.ml.challenger.shadow).toBe(true);
  });

  it("handles Belvo IMSS error gracefully (rejects)", async () => {
    getIMSSEmployment.mockRejectedValue(new Error("Belvo timeout"));
    const result = await runStage2(BASE_PARAMS);
    expect(result.decision).toBe("rejected");
    expect(result.reason).toBe("no_imss_record");
  });

  it("handles ML model errors gracefully", async () => {
    fetch.mockRejectedValue(new Error("ML service down"));
    const result = await runStage2(BASE_PARAMS);
    expect(result.ml.champion.error).toBeTruthy();
    expect(result.ml.challenger.error).toBeTruthy();
    // Stage 2 still completes — ML errors don't block
    expect(result.decision).toBe("continue");
  });

  it("calculates LTI from params", async () => {
    const result = await runStage2({ ...BASE_PARAMS, loanAmount: 5000, monthlyNetIncome: 20000 });
    expect(result.lti).toBeCloseTo(0.25);
  });
});
