"use strict";
/**
 * riskseal-smoke.test.js
 * Unit tests for GET /riskseal/smoke — VID3-713.
 *
 * Tests the handler directly (no supertest dep) with mocked
 * riskseal-client so we cover both happy path and error path.
 */

jest.mock("./riskseal-client", () => ({
  checkDigitalFootprint: jest.fn(),
}));

const { checkDigitalFootprint } = require("./riskseal-client");
const { riskSealSmokeHandler, DEFAULTS } = require("./riskseal-smoke");

// Minimal Express-ish req/res helpers
function mockReq(query = {}) {
  return { query };
}
function mockRes() {
  const res = {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  jest.resetAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /riskseal/smoke", () => {
  test("200: reports envMock=false and returns result when RISKSEAL_MOCK is false", async () => {
    process.env.RISKSEAL_MOCK = "false";
    process.env.RISKSEAL_BASE_URL = "https://latam-1.riskseal.io";
    process.env.RISKSEAL_API_KEY = "test-key";

    checkDigitalFootprint.mockResolvedValueOnce({
      score: 612,
      trust_score: 88,
      risk_level: "low",
      pass: true,
      signals: { email_age_days: 1200, total_accounts: 7 },
    });

    const req = mockReq({ email: "alice@example.com" });
    const res = mockRes();
    await riskSealSmokeHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.envMock).toBe(false);
    expect(res.body.baseUrl).toBe("https://latam-1.riskseal.io");
    expect(res.body.apiKeyPresent).toBe(true);
    expect(typeof res.body.durationMs).toBe("number");
    expect(res.body.result.score).toBe(612);
    expect(res.body.result.risk_level).toBe("low");

    // Passed-through query params, not defaults
    expect(checkDigitalFootprint).toHaveBeenCalledWith({
      email: "alice@example.com",
      phone: DEFAULTS.phone,
      ip: DEFAULTS.ip,
      rfc: DEFAULTS.rfc,
    });
  });

  test("200: reports envMock=true when RISKSEAL_MOCK=true (mock adapter answers)", async () => {
    process.env.RISKSEAL_MOCK = "true";
    process.env.RISKSEAL_BASE_URL = "";
    process.env.RISKSEAL_API_KEY = "";

    checkDigitalFootprint.mockResolvedValueOnce({
      score: 72, risk_level: "medium", pass: true, signals: {}, mocked: true,
    });

    const req = mockReq();
    const res = mockRes();
    await riskSealSmokeHandler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.envMock).toBe(true);
    expect(res.body.apiKeyPresent).toBe(false);
    expect(res.body.result.mocked).toBe(true);
  });

  test("502: returns riskseal_call_failed when adapter throws", async () => {
    process.env.RISKSEAL_MOCK = "false";
    process.env.RISKSEAL_BASE_URL = "https://latam-1.riskseal.io";
    process.env.RISKSEAL_API_KEY = "test-key";

    checkDigitalFootprint.mockRejectedValueOnce(new Error("RiskSeal 401: unauthorized"));

    const req = mockReq();
    const res = mockRes();
    await riskSealSmokeHandler(req, res);

    expect(res.statusCode).toBe(502);
    expect(res.body.error).toBe("riskseal_call_failed");
    expect(res.body.message).toMatch(/401/);
    expect(res.body.envMock).toBe(false);
    expect(res.body.baseUrl).toBe("https://latam-1.riskseal.io");
    expect(res.body.apiKeyPresent).toBe(true);
  });

  test("truncates oversized inputs to prevent abuse", async () => {
    process.env.RISKSEAL_MOCK = "false";
    checkDigitalFootprint.mockResolvedValueOnce({ score: 0 });

    const longString = "x".repeat(2000);
    const req = mockReq({ email: longString, phone: longString, ip: longString, rfc: longString });
    const res = mockRes();
    await riskSealSmokeHandler(req, res);

    const call = checkDigitalFootprint.mock.calls[0][0];
    expect(call.email.length).toBeLessThanOrEqual(320);
    expect(call.phone.length).toBeLessThanOrEqual(32);
    expect(call.ip.length).toBeLessThanOrEqual(64);
    expect(call.rfc.length).toBeLessThanOrEqual(32);
  });
});
