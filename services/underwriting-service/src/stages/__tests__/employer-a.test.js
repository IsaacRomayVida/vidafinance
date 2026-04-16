"use strict";

// ── Mock all external dependencies before require ─────────────────────
jest.mock("../../redis-client", () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue("OK"),
}));

jest.mock("../../verifik", () => ({
  checkSATTaxpayer: jest.fn(),
}));

jest.mock("../../sw-client", () => ({
  check69B: jest.fn(),
  checkArt69: jest.fn(),
}));

jest.mock("../../gov-apis", () => ({
  checkDENUE: jest.fn(),
  checkREPSE: jest.fn(),
}));

const redis = require("../../redis-client");
const { checkSATTaxpayer } = require("../../verifik");
const { check69B, checkArt69 } = require("../../sw-client");
const { checkDENUE, checkREPSE } = require("../../gov-apis");
const { runEmployerScreening } = require("../employer-a");

const EMPLOYER = { rfc: "ABC123456XYZ", companyName: "Vida Corp", stateCode: "09" };

function mockAllPass() {
  checkSATTaxpayer.mockResolvedValue({ rfc: EMPLOYER.rfc, statusSat: "ACTIVO", pass: true });
  check69B.mockResolvedValue({ rfc: EMPLOYER.rfc, situacion: null, pass: true, flag: false, hardReject: false });
  checkArt69.mockResolvedValue({ rfc: EMPLOYER.rfc, hasDebt: false, count: 0, pass: true });
  checkDENUE.mockResolvedValue({ found: true, count: 1, pass: true });
  checkREPSE.mockResolvedValue({ registrado: true, vigente: true, pass: true });
}

beforeEach(() => {
  jest.clearAllMocks();
  redis.get.mockResolvedValue(null);
  redis.set.mockResolvedValue("OK");
});

describe("runEmployerScreening", () => {
  // ── All checks pass ───────────────────────────────────────────────
  it("returns pass when all 5 checks succeed", async () => {
    mockAllPass();

    const result = await runEmployerScreening(EMPLOYER);

    expect(result.pass).toBe(true);
    expect(result.hardReject).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.signals).toHaveProperty("sat");
    expect(result.signals).toHaveProperty("lista69B");
    expect(result.signals).toHaveProperty("art69");
    expect(result.signals).toHaveProperty("denue");
    expect(result.signals).toHaveProperty("repse");
    expect(result).toHaveProperty("cost");
    expect(result).toHaveProperty("durationMs");
  });

  it("runs all 5 checks in parallel", async () => {
    mockAllPass();

    await runEmployerScreening(EMPLOYER);

    expect(checkSATTaxpayer).toHaveBeenCalledWith(EMPLOYER.rfc);
    expect(check69B).toHaveBeenCalledWith(EMPLOYER.rfc);
    expect(checkArt69).toHaveBeenCalledWith(EMPLOYER.rfc);
    expect(checkDENUE).toHaveBeenCalledWith(EMPLOYER.companyName, EMPLOYER.stateCode);
    expect(checkREPSE).toHaveBeenCalledWith(EMPLOYER.rfc);
  });

  // ── DEFINITIVO = hard reject ──────────────────────────────────────
  it("hard rejects on lista 69-B DEFINITIVO", async () => {
    mockAllPass();
    check69B.mockResolvedValue({ rfc: EMPLOYER.rfc, situacion: "DEFINITIVO", pass: false, flag: false, hardReject: true });

    const result = await runEmployerScreening(EMPLOYER);

    expect(result.pass).toBe(false);
    expect(result.hardReject).toBe(true);
    expect(result.reason).toBe("lista_69b_definitivo");
  });

  // ── PRESUNTO = flag, continue to Part B ────────────────────────────
  it("flags PRESUNTO but still passes", async () => {
    mockAllPass();
    check69B.mockResolvedValue({ rfc: EMPLOYER.rfc, situacion: "PRESUNTO", pass: false, flag: true, hardReject: false });

    const result = await runEmployerScreening(EMPLOYER);

    // PRESUNTO is a flag, not a hard rejection — passes stage but signals flag
    expect(result.pass).toBe(true);
    expect(result.hardReject).toBe(false);
    expect(result.signals.lista69B.flag).toBe(true);
  });

  // ── SAT inactive = fail ────────────────────────────────────────────
  it("fails when SAT status is not ACTIVO", async () => {
    mockAllPass();
    checkSATTaxpayer.mockResolvedValue({ rfc: EMPLOYER.rfc, statusSat: "CANCELADO", pass: false });

    const result = await runEmployerScreening(EMPLOYER);

    expect(result.pass).toBe(false);
    expect(result.hardReject).toBe(false);
    expect(result.reason).toBe("sat_inactive");
  });

  // ── Art. 69 fiscal debt = fail ─────────────────────────────────────
  it("fails when Art. 69 shows fiscal debt", async () => {
    mockAllPass();
    checkArt69.mockResolvedValue({ rfc: EMPLOYER.rfc, hasDebt: true, count: 3, pass: false });

    const result = await runEmployerScreening(EMPLOYER);

    expect(result.pass).toBe(false);
    expect(result.reason).toBe("art69_fiscal_debt");
  });

  // ── DENUE not found = fail ─────────────────────────────────────────
  it("fails when DENUE finds no matching business", async () => {
    mockAllPass();
    checkDENUE.mockResolvedValue({ found: false, count: 0, pass: false });

    const result = await runEmployerScreening(EMPLOYER);

    expect(result.pass).toBe(false);
    expect(result.reason).toBe("denue_not_found");
  });

  // ── REPSE not registered = fail ────────────────────────────────────
  it("fails when REPSE registration is invalid", async () => {
    mockAllPass();
    checkREPSE.mockResolvedValue({ registrado: false, vigente: false, pass: false });

    const result = await runEmployerScreening(EMPLOYER);

    expect(result.pass).toBe(false);
    expect(result.reason).toBe("repse_not_registered");
  });

  // ── Provider error → escalate (never pass silently) ────────────────
  it("escalates to manual review when an API call fails", async () => {
    mockAllPass();
    checkDENUE.mockRejectedValue(new Error("DENUE timeout"));

    const result = await runEmployerScreening(EMPLOYER);

    expect(result.pass).toBe(false);
    expect(result.escalateToStage).toBe(5);
    expect(result.reason).toBe("provider_errors_escalate");
    expect(result.skippedChecks).toContain("denue");
    expect(result.signals.denue.skipped).toBe(true);
    expect(result.signals.denue.error).toContain("DENUE timeout");
  });

  it("escalates to manual review when multiple APIs fail", async () => {
    mockAllPass();
    checkDENUE.mockRejectedValue(new Error("DENUE down"));
    checkREPSE.mockRejectedValue(new Error("REPSE down"));

    const result = await runEmployerScreening(EMPLOYER);

    expect(result.pass).toBe(false);
    expect(result.escalateToStage).toBe(5);
    expect(result.reason).toBe("provider_errors_escalate");
    expect(result.skippedChecks).toContain("denue");
    expect(result.skippedChecks).toContain("repse");
    expect(result.signals.denue.skipped).toBe(true);
    expect(result.signals.repse.skipped).toBe(true);
  });

  it("hard rejects even when other APIs fail", async () => {
    mockAllPass();
    check69B.mockResolvedValue({ rfc: EMPLOYER.rfc, situacion: "DEFINITIVO", pass: false, flag: false, hardReject: true });
    checkDENUE.mockRejectedValue(new Error("DENUE down"));

    const result = await runEmployerScreening(EMPLOYER);

    expect(result.pass).toBe(false);
    expect(result.hardReject).toBe(true);
    expect(result.reason).toBe("lista_69b_definitivo");
  });

  // ── Redis caching ─────────────────────────────────────────────────
  it("caches results in Redis with 24h TTL", async () => {
    mockAllPass();

    await runEmployerScreening(EMPLOYER);

    expect(redis.set).toHaveBeenCalledWith(
      `employer-a:${EMPLOYER.rfc}`,
      expect.any(String),
      "EX",
      86400,
    );
  });

  it("returns cached result on cache hit", async () => {
    const cachedResult = { pass: true, hardReject: false, reason: null, signals: {}, cost: 1, durationMs: 50 };
    redis.get.mockResolvedValue(JSON.stringify(cachedResult));

    const result = await runEmployerScreening(EMPLOYER);

    expect(result).toEqual(cachedResult);
    // No API calls should have been made
    expect(checkSATTaxpayer).not.toHaveBeenCalled();
    expect(check69B).not.toHaveBeenCalled();
  });

  // ── Default stateCode ─────────────────────────────────────────────
  it("uses stateCode '00' when not provided", async () => {
    mockAllPass();

    await runEmployerScreening({ rfc: "TEST123", companyName: "Test Co" });

    expect(checkDENUE).toHaveBeenCalledWith("Test Co", "00");
  });
});
