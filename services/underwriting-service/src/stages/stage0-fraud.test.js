"use strict";

// ── Mock external dependencies before requiring the module ──────────────────
jest.mock("../riskseal-client", () => ({
  checkDigitalFootprint: jest.fn(),
}));
jest.mock("../metamap-client", () => ({
  checkBehavioralRisk: jest.fn(),
}));
jest.mock("../belvo-client", () => ({
  getINFONAVIT: jest.fn(),
}));
jest.mock("node-fetch", () => jest.fn());

const { checkDigitalFootprint } = require("../riskseal-client");
const { checkBehavioralRisk } = require("../metamap-client");
const { getINFONAVIT } = require("../belvo-client");
const fetch = require("node-fetch");

const { runFraudGates } = require("./stage0-fraud");

const APPLICANT = {
  rfc: "ROMA850101ABC",
  curp: "ROMA850101HDFRML09",
  email: "juan@example.com",
  phone: "+5215512345678",
  ipAddress: "187.190.1.1",
  sessionKey: "session-ok",
  userId: "user-123",
  monthlySalary: 22000,
  principalAmount: 3000,
};

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function mockCleanRun() {
  checkBehavioralRisk.mockResolvedValue({ risk_level: "low", score: 15, pass: true });
  getINFONAVIT.mockResolvedValue({ balance: 0, credit_status: "none" });
  checkDigitalFootprint.mockResolvedValue({ score: 72, risk_level: "medium", pass: true });
  fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ is_fraud: false }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCleanRun();
});

describe("stage0-fraud: cost accounting", () => {
  it("bills the RiskSeal digital footprint call it makes on every applicant", async () => {
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(checkDigitalFootprint).toHaveBeenCalled();
    const risksealCost = result.cost.find(c => c.api === "riskseal");
    expect(risksealCost).toBeDefined();
    expect(risksealCost.mxn).toBeGreaterThan(0);
  });
});

// ── Decision branches ──────────────────────────────────────────────────
// Each gate in runFraudGates, in the order the function evaluates them. The
// pipeline suites reach these only through the full decision engine; here each
// branch is pinned against the stage's own return shape.
describe("stage0-fraud: decision branches", () => {
  it("passes a clean applicant with no flags and all four checks recorded", async () => {
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.pass).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.escalateToStage).toBeNull();
    expect(result.flags).toEqual({ behavioralFlag: false, infonavitFlag: false });
    expect(Object.keys(result.data).sort()).toEqual(
      ["infonavit", "metamapBehavioral", "mlFraud", "riskseal"]
    );
    expect(checkBehavioralRisk).toHaveBeenCalledWith("session-ok", "user-123");
    expect(getINFONAVIT).toHaveBeenCalledWith(APPLICANT.curp);
    expect(checkDigitalFootprint).toHaveBeenCalledWith({
      email: APPLICANT.email, phone: APPLICANT.phone, ip: APPLICANT.ipAddress, rfc: APPLICANT.rfc,
    });
  });

  it("hard-rejects on MetaMap behavioral risk very_high", async () => {
    checkBehavioralRisk.mockResolvedValue({ risk_level: "very_high" });
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.pass).toBe(false);
    expect(result.reason).toBe("DEVICE_FRAUD_DETECTED");
    expect(result.escalateToStage).toBeNull();
  });

  it("flags but passes on MetaMap behavioral risk high", async () => {
    checkBehavioralRisk.mockResolvedValue({ risk_level: "high" });
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.pass).toBe(true);
    expect(result.flags.behavioralFlag).toBe(true);
  });

  it("hard-rejects when the ML service reports an anomaly", async () => {
    fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ is_fraud: true }) });
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.pass).toBe(false);
    expect(result.reason).toBe("ANOMALY_DETECTED");
    expect(result.escalateToStage).toBeNull();
  });

  it("sends the ML service the amount-to-salary ratio it scores on", async () => {
    await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toMatch(/\/underwrite\/employee$/);
    const body = JSON.parse(init.body);
    expect(body.monthlySalary).toBe(APPLICANT.monthlySalary);
    expect(body.amountToSalaryRatio).toBeCloseTo(APPLICANT.principalAmount / APPLICANT.monthlySalary, 10);
  });

  it("does not reject when the ML service errors — the check is recorded as skipped", async () => {
    fetch.mockResolvedValue({ ok: false, status: 503 });
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.pass).toBe(true);
    expect(result.data.mlFraud).toMatchObject({ is_fraud: false, skipped: true });
    expect(result.data.mlFraud.error).toMatch(/503/);
  });

  it("escalates to Stage 5 on a RiskSeal score below 30", async () => {
    checkDigitalFootprint.mockResolvedValue({ score: 29 });
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.pass).toBe(false);
    expect(result.reason).toBe("LOW_DIGITAL_FOOTPRINT");
    expect(result.escalateToStage).toBe(5);
  });

  it("does not escalate at a RiskSeal score of exactly 30", async () => {
    checkDigitalFootprint.mockResolvedValue({ score: 30 });
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.pass).toBe(true);
  });

  it("does not escalate on a RiskSeal provider error", async () => {
    checkDigitalFootprint.mockRejectedValue(new Error("riskseal timeout"));
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.pass).toBe(true);
    expect(result.data.riskseal).toMatchObject({ pass: false, skipped: true, error: "riskseal timeout" });
  });

  it("checks device fraud before ML anomaly when both fire", async () => {
    checkBehavioralRisk.mockResolvedValue({ risk_level: "very_high" });
    fetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ is_fraud: true }) });
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.reason).toBe("DEVICE_FRAUD_DETECTED");
  });

  it("sets infonavitFlag and sums only the active INFONAVIT credits' deductions", async () => {
    getINFONAVIT.mockResolvedValue([
      { credit_status: "active", monthly_deduction: 1200 },
      { balance: 5000, deduction: 300 },
    ]);
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.pass).toBe(true);
    expect(result.flags.infonavitFlag).toBe(true);
    expect(result.data.infonavitFlag).toBe(true);
    expect(result.data.infonavitDeduction).toBe(1200 + 300);
  });

  it("leaves closed INFONAVIT credits out of the deduction when mixed with active ones", async () => {
    getINFONAVIT.mockResolvedValue([
      { credit_status: "active", monthly_deduction: 1200 },
      { balance: 5000, deduction: 300 },
      { credit_status: "closed", balance: 0, monthly_deduction: 999 },
    ]);
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.flags.infonavitFlag).toBe(true);
    // A closed credit carries no current payroll deduction, and Stage 2
    // subtracts this sum from the current monthly salary for LTI.
    expect(result.data.infonavitDeduction).toBe(1200 + 300);
  });

  it("neither flags nor sets a deduction when every INFONAVIT credit is closed", async () => {
    getINFONAVIT.mockResolvedValue([
      { credit_status: "closed", balance: 0, monthly_deduction: 999 },
      { credit_status: "closed", balance: 0, deduction: 450 },
    ]);
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.pass).toBe(true);
    expect(result.flags.infonavitFlag).toBe(false);
    expect(result.data.infonavitFlag).toBeUndefined();
    expect(result.data.infonavitDeduction).toBeUndefined();
  });

  it("treats a closed INFONAVIT credit as closed even when it still shows a balance", async () => {
    getINFONAVIT.mockResolvedValue([
      { credit_status: "closed", balance: 1800, monthly_deduction: 999 },
      { balance: 5000, deduction: 300 },
    ]);
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.flags.infonavitFlag).toBe(true);
    expect(result.data.infonavitDeduction).toBe(300);
  });

  it("does not flag when the only INFONAVIT credit is closed with a leftover balance", async () => {
    getINFONAVIT.mockResolvedValue({ credit_status: "closed", balance: 1800, monthly_deduction: 999 });
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.pass).toBe(true);
    expect(result.flags.infonavitFlag).toBe(false);
    expect(result.data.infonavitDeduction).toBeUndefined();
  });

  it("neither flags nor sets a deduction when there are no INFONAVIT credits", async () => {
    getINFONAVIT.mockResolvedValue([]);
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.pass).toBe(true);
    expect(result.flags.infonavitFlag).toBe(false);
    expect(result.data.infonavitDeduction).toBeUndefined();
  });

  it("skips MetaMap and INFONAVIT (and their cost) when sessionKey and CURP are absent", async () => {
    const bare = { ...APPLICANT };
    delete bare.sessionKey;
    delete bare.curp;
    const result = await runFraudGates(bare, {}, { logger: silentLogger });

    expect(checkBehavioralRisk).not.toHaveBeenCalled();
    expect(getINFONAVIT).not.toHaveBeenCalled();
    expect(result.pass).toBe(true);
    expect(result.data.metamapBehavioral).toMatchObject({ skipped: true, reason: "no_session_key" });
    expect(result.data.infonavit).toMatchObject({ skipped: true, reason: "no_curp" });
    expect(result.cost.map(c => c.api)).toEqual(["riskseal"]);
  });

  it("treats a MetaMap or INFONAVIT provider error as skipped, not as a rejection", async () => {
    checkBehavioralRisk.mockRejectedValue(new Error("metamap down"));
    getINFONAVIT.mockRejectedValue(new Error("belvo down"));
    const result = await runFraudGates(APPLICANT, {}, { logger: silentLogger });

    expect(result.pass).toBe(true);
    expect(result.data.metamapBehavioral).toMatchObject({ skipped: true, error: "metamap down" });
    expect(result.data.infonavit).toMatchObject({ skipped: true, error: "belvo down" });
    expect(result.flags.infonavitFlag).toBe(false);
  });
});
