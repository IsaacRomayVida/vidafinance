"use strict";
/**
 * gov-apis.js — fail-open audit.
 *
 * The contract these tests hold gov-apis.js to is the one its live consumers
 * already implement:
 *
 *   - employer-a.js:62-65 wraps every gov-apis call in `Promise.allSettled` and
 *     maps a REJECTION to `{pass: false, skipped: true}`; it then treats
 *     `!x.pass && !x.skipped` as a genuine failure (employer REJECTED) and any
 *     truthy `skipped` as a provider outage (escalate to Stage 5 manual review).
 *     So: to escalate, a gov-apis function must THROW. Returning `pass: false`
 *     is an accusation against the employer, not a report of an outage.
 *
 *   - stage3-autoapprove.js:65 `provenanceOf(block)` =
 *     `block && block.skipped !== true ? "read" : "assumed"`, and every
 *     auto-approve condition requires `source === "read"` (#458). So: a lookup
 *     that did not resolve a value must carry `skipped: true`, or the gate will
 *     score its own ignorance as a clean reading.
 *
 * Only three of the eight exported functions have a production consumer:
 * checkDENUE + checkREPSE (employer-a.js:35) and checkCNBVSector
 * (stage1-identity.js:18). The other five are exported but uncalled outside
 * tests, so their shapes are not exercised here.
 */

jest.mock("./redis-client", () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue("OK"),
}));

// employer-a.js resolves its SAT provider at module load; mock it so the
// integration cases below exercise the REAL gov-apis without touching GCS.
jest.mock("./sat-blacklist-client", () => ({
  check69B: jest.fn(),
  checkArt69: jest.fn(),
}));
jest.mock("./sw-client", () => ({
  check69B: jest.fn(),
  checkArt69: jest.fn(),
}));

// stage3-autoapprove.js -> config/maxPDefaultCutoff.js -> firebase-admin.
jest.mock("firebase-admin", () => ({
  firestore: () => ({
    collection: () => ({ doc: () => ({ get: jest.fn() }) }),
  }),
}));

const fetch = require("node-fetch");
const redis = require("./redis-client");
const { checkDENUE, checkREPSE, checkCNBVSector } = require("./gov-apis");
const { check69B, checkArt69 } = require("./sat-blacklist-client");
const { runEmployerScreening } = require("./stages/employer-a");
const { evaluateAutoApprove } = require("./stages/stage3-autoapprove");

const EMPLOYER = { rfc: "ABC123456XYZ", companyName: "Vida Corp", stateCode: "09" };

/** An STPS REPSE 503 served as an HTML maintenance page — not JSON. */
function repseErrorPage(status = 503) {
  return {
    ok: false,
    status,
    text: () => Promise.resolve("<html><body>Servicio no disponible</body></html>"),
    json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON at position 0")),
  };
}

function repseOk(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function denueOk(rows) {
  return { ok: true, status: 200, json: () => Promise.resolve(rows) };
}

/** Firestore doc handle for the cnbv_sector_risk registry. */
function firestoreWith(doc) {
  return { collection: jest.fn(() => ({ doc: jest.fn(() => ({ get: jest.fn(() => Promise.resolve(doc)) })) })) };
}

beforeEach(() => {
  jest.clearAllMocks();
  redis.get.mockResolvedValue(null);
  redis.set.mockResolvedValue("OK");
  process.env.DENUE_API_URL = "https://denue.test/app/api/denue/v1/consulta";
  process.env.DENUE_API_KEY = "test-token";
  process.env.REPSE_URL = "https://repse.test/consulta";
});

// ─────────────────────────────────────────────────────────────────────
// DEFECT 1 — REPSE turns a provider outage into an employer rejection
// ─────────────────────────────────────────────────────────────────────
describe("checkREPSE — non-2xx / unparseable body", () => {
  it("throws on a non-2xx response instead of returning a verdict", async () => {
    fetch.mockResolvedValue(repseErrorPage(503));
    await expect(checkREPSE(EMPLOYER.rfc)).rejects.toThrow(/REPSE API 503/);
  });

  it("throws on a 200 whose body is not JSON", async () => {
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token <")),
      text: () => Promise.resolve("<html>captive portal</html>"),
    });
    await expect(checkREPSE(EMPLOYER.rfc)).rejects.toThrow();
  });

  it("does not cache a verdict derived from a failed response", async () => {
    fetch.mockResolvedValue(repseErrorPage(500));
    await expect(checkREPSE(EMPLOYER.rfc)).rejects.toThrow();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("still returns a real not-registered verdict when REPSE genuinely answers", async () => {
    fetch.mockResolvedValue(repseOk({ valido: false, vigente: false }));
    const result = await checkREPSE(EMPLOYER.rfc);
    expect(result).toMatchObject({ registrado: false, vigente: false, pass: false });
    expect(result.skipped).toBeUndefined();
    expect(redis.set).toHaveBeenCalled();
  });

  it("passes a registered, current employer", async () => {
    fetch.mockResolvedValue(repseOk({ valido: true, vigente: true, fechaVigencia: "2027-01-01" }));
    await expect(checkREPSE(EMPLOYER.rfc)).resolves.toMatchObject({
      registrado: true,
      vigente: true,
      pass: true,
      fechaVigencia: "2027-01-01",
    });
  });

  // The consequence, end to end, through the real employer-a gate.
  it("escalates a REPSE outage to Stage 5 rather than rejecting the employer", async () => {
    check69B.mockResolvedValue({ pass: true, flag: false, hardReject: false });
    checkArt69.mockResolvedValue({ pass: true, hasDebt: false });
    fetch.mockImplementation((url) => {
      if (String(url).includes("denue")) return Promise.resolve(denueOk([{ Nombre: "Vida Corp" }]));
      return Promise.resolve(repseErrorPage(503));
    });

    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const result = await runEmployerScreening(EMPLOYER, { logger: log });

    expect(result.reason).not.toBe("repse_not_registered");
    expect(result.escalateToStage).toBe(5);
    expect(result.reason).toBe("provider_errors_escalate");
    expect(result.skippedChecks).toContain("repse");
  });
});

// ─────────────────────────────────────────────────────────────────────
// DEFECT 2 — an absent CNBV sector record is scored as a clean reading
// ─────────────────────────────────────────────────────────────────────
describe("checkCNBVSector — sector code absent from the registry", () => {
  it("marks a missing document as unread, not as a pass", async () => {
    const db = firestoreWith({ exists: false });
    const result = await checkCNBVSector(db, "999999");
    expect(result.riskLevel).toBe("unknown");
    expect(result.skipped).toBe(true);
    expect(result.pass).toBe(false);
  });

  it("reads a present document normally", async () => {
    const db = firestoreWith({ exists: true, data: () => ({ riskLevel: "bajo" }) });
    const result = await checkCNBVSector(db, "541110");
    expect(result).toMatchObject({ riskLevel: "bajo", pass: true, flag: false });
    expect(result.skipped).toBeUndefined();
  });

  it("still flags and fails an 'alto' sector", async () => {
    const db = firestoreWith({ exists: true, data: () => ({ riskLevel: "alto" }) });
    await expect(checkCNBVSector(db, "522110")).resolves.toMatchObject({
      riskLevel: "alto",
      pass: false,
      flag: true,
    });
  });

  // The consequence, through the real #458 provenance gate.
  it("cannot clear stage 3 condition 7 with a sector nobody resolved (#458)", async () => {
    const db = firestoreWith({ exists: false });
    const cnbv = await checkCNBVSector(db, "999999");

    const sector = evaluateAutoApprove(
      { rfc: EMPLOYER.rfc, age: 35 },
      { stage1: { data: { age: 35, cnbv } } }
    ).find((c) => c.name === "sector_safe");

    expect(sector.value).toBe("unknown");
    expect(sector.source).toBe("assumed");
    expect(sector.pass).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// REFUTATION GUARDS — these hold on shipped code and must keep holding
// ─────────────────────────────────────────────────────────────────────
describe("checkDENUE — retry and timeout behaviour is already fail-closed", () => {
  it("retries once and returns the retry's result", async () => {
    fetch
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce(denueOk([{ Nombre: "Vida Corp", Razon_social: "Vida Corp SA" }]));
    const result = await checkDENUE("Vida Corp", "09");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ found: true, count: 1, pass: true });
  });

  it("propagates a retry failure so employer-a records it skipped, not failed", async () => {
    fetch.mockRejectedValue(new Error("ETIMEDOUT"));
    await expect(checkDENUE("Vida Corp", "09")).rejects.toThrow("ETIMEDOUT");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws on a non-2xx rather than reporting the business as not found", async () => {
    fetch.mockResolvedValue({ ok: false, status: 502, text: () => Promise.resolve("bad gateway") });
    await expect(checkDENUE("Vida Corp", "09")).rejects.toThrow(/DENUE API 502/);
  });

  it("throws when its env vars are unconfigured", async () => {
    delete process.env.DENUE_API_KEY;
    await expect(checkDENUE("Vida Corp", "09")).rejects.toThrow(/DENUE_API_KEY/);
  });

  it("reports a genuinely unfound business as a real failure, not a skip", async () => {
    fetch.mockResolvedValue(denueOk([]));
    const result = await checkDENUE("Ghost Corp", "09");
    expect(result).toMatchObject({ found: false, count: 0, pass: false });
    expect(result.skipped).toBeUndefined();
  });
});
