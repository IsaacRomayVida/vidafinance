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
