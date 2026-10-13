"use strict";

// Unit tests for Stage 1 (identity validation). The regex/age primitives are
// also spot-checked in src/pipeline-escalation.test.js; this file covers
// runIdentityValidation itself — each rejection reason, the 18–65 age band at
// its edges, and the informational CNBV sector lookup.

jest.mock("../gov-apis", () => ({
  checkCNBVSector: jest.fn(),
}));

const { checkCNBVSector } = require("../gov-apis");
const {
  runIdentityValidation, parseAgeFromCurp, RFC_REGEX, CURP_REGEX,
} = require("./stage1-identity");

// Age is computed against "now", so the clock is pinned: 2026-06-15 local time.
const NOW = new Date(2026, 5, 15, 12, 0, 0);

const APPLICANT = {
  rfc: "GARA900101ABC",
  curp: "GARA900101HDFRRL09",
};

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

// Builds a valid CURP for a given YYMMDD date of birth.
const curpFor = (yymmdd) => `GARA${yymmdd}HDFRRL09`;

beforeAll(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "queueMicrotask", "setImmediate"] });
});
afterAll(() => {
  jest.useRealTimers();
});
beforeEach(() => {
  jest.clearAllMocks();
});

describe("stage1-identity: parseAgeFromCurp", () => {
  it("reads the date of birth out of positions 4–9", () => {
    expect(parseAgeFromCurp(curpFor("900101"))).toBe(36);
  });

  it("reads yy < 40 as the 2000s and yy >= 40 as the 1900s", () => {
    expect(parseAgeFromCurp(curpFor("080101"))).toBe(18);
    expect(parseAgeFromCurp(curpFor("400101"))).toBe(86);
  });

  it("does not count the birthday until it has arrived", () => {
    expect(parseAgeFromCurp(curpFor("080615"))).toBe(18);
    expect(parseAgeFromCurp(curpFor("080616"))).toBe(17);
  });

  it("returns null for a missing or truncated CURP", () => {
    expect(parseAgeFromCurp(undefined)).toBeNull();
    expect(parseAgeFromCurp("GARA9001")).toBeNull();
  });
});

describe("stage1-identity: format regexes", () => {
  it("RFC_REGEX accepts persona física (4 letters) and moral (3 letters), incl. Ñ and &", () => {
    expect(RFC_REGEX.test("GARA900101ABC")).toBe(true);
    expect(RFC_REGEX.test("ABC900101XY0")).toBe(true);
    expect(RFC_REGEX.test("Ñ&A900101AB1")).toBe(true);
    expect(RFC_REGEX.test("GARA90010ABC")).toBe(false);
    expect(RFC_REGEX.test("gara900101abc")).toBe(false); // caller upper-cases first
  });

  it("CURP_REGEX requires the H/M sex marker and the 18-character layout", () => {
    expect(CURP_REGEX.test("GARA900101HDFRRL09")).toBe(true);
    expect(CURP_REGEX.test("GARA900101MDFRRL09")).toBe(true);
    expect(CURP_REGEX.test("GARA900101XDFRRL09")).toBe(false);
    expect(CURP_REGEX.test("GARA900101HDFRRL0")).toBe(false);
  });
});

describe("stage1-identity: runIdentityValidation", () => {
  it("passes a valid applicant with no CNBV lookup when no db is supplied", async () => {
    const result = await runIdentityValidation(APPLICANT, {}, { logger: silentLogger });

    expect(result.pass).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.escalateToStage).toBeNull();
    expect(result.data).toMatchObject({ rfcValid: true, curpValid: true, age: 36 });
    expect(result.data.cnbv).toEqual({ pass: true, skipped: true });
    expect(result.flags).toEqual({ cnbvHighRisk: false });
    expect(result.cost).toEqual([]);
    expect(checkCNBVSector).not.toHaveBeenCalled();
  });

  it("accepts lower-case RFC and CURP input", async () => {
    const result = await runIdentityValidation(
      { rfc: APPLICANT.rfc.toLowerCase(), curp: APPLICANT.curp.toLowerCase() },
      {}, { logger: silentLogger }
    );
    expect(result.pass).toBe(true);
    expect(result.data.age).toBe(36);
  });

  it("rejects a malformed RFC before looking at the CURP", async () => {
    const result = await runIdentityValidation(
      { rfc: "NOTANRFC", curp: "bad" }, {}, { logger: silentLogger }
    );
    expect(result.pass).toBe(false);
    expect(result.reason).toBe("INVALID_RFC_FORMAT");
    expect(result.escalateToStage).toBeNull();
    expect(result.data).toEqual({ rfcValid: false });
  });

  it("rejects a missing RFC as malformed rather than throwing", async () => {
    const result = await runIdentityValidation({ curp: APPLICANT.curp }, {}, { logger: silentLogger });
    expect(result.reason).toBe("INVALID_RFC_FORMAT");
  });

  it("rejects a malformed or missing CURP", async () => {
    const bad = await runIdentityValidation(
      { rfc: APPLICANT.rfc, curp: "GARA900101XDFRRL09" }, {}, { logger: silentLogger }
    );
    expect(bad.pass).toBe(false);
    expect(bad.reason).toBe("INVALID_CURP_FORMAT");
    expect(bad.data).toEqual({ rfcValid: true, curpValid: false });

    const missing = await runIdentityValidation({ rfc: APPLICANT.rfc }, {}, { logger: silentLogger });
    expect(missing.reason).toBe("INVALID_CURP_FORMAT");
  });

  it.each([
    ["080616", 17, false, "UNDERAGE"],
    ["080615", 18, true, null],
    ["610615", 65, true, null],
    ["600615", 66, false, "OVERAGE"],
  ])("born %s (age %i) → pass=%s reason=%s", async (yymmdd, age, pass, reason) => {
    const result = await runIdentityValidation(
      { rfc: APPLICANT.rfc, curp: curpFor(yymmdd) }, {}, { logger: silentLogger }
    );
    expect(result.data.age).toBe(age);
    expect(result.pass).toBe(pass);
    expect(result.reason).toBe(reason);
  });

  it("does not call CNBV when a db is supplied but the applicant has no sectorCode", async () => {
    const db = {};
    const result = await runIdentityValidation(APPLICANT, {}, { logger: silentLogger, db });
    expect(checkCNBVSector).not.toHaveBeenCalled();
    expect(result.data.cnbv).toEqual({ pass: true, skipped: true });
  });

  it("records the CNBV sector read and passes a low-risk sector unflagged", async () => {
    const db = {};
    checkCNBVSector.mockResolvedValue({ riskLevel: "bajo", pass: true, flag: false });
    const result = await runIdentityValidation(
      { ...APPLICANT, sectorCode: "461110" }, {}, { logger: silentLogger, db }
    );
    expect(checkCNBVSector).toHaveBeenCalledWith(db, "461110");
    expect(result.pass).toBe(true);
    expect(result.data.cnbv).toEqual({ riskLevel: "bajo", pass: true, flag: false });
    expect(result.flags.cnbvHighRisk).toBe(false);
  });

  it("flags a high-risk CNBV sector but does not reject — the check is informational", async () => {
    checkCNBVSector.mockResolvedValue({ riskLevel: "alto", pass: false, flag: true });
    const result = await runIdentityValidation(
      { ...APPLICANT, sectorCode: "713210" }, {}, { logger: silentLogger, db: {} }
    );
    expect(result.pass).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.flags.cnbvHighRisk).toBe(true);
  });

  it("records a CNBV lookup failure as skipped with pass: false, still passing the stage", async () => {
    checkCNBVSector.mockRejectedValue(new Error("firestore unavailable"));
    const result = await runIdentityValidation(
      { ...APPLICANT, sectorCode: "461110" }, {}, { logger: silentLogger, db: {} }
    );
    expect(result.pass).toBe(true);
    expect(result.data.cnbv).toEqual({ pass: false, skipped: true, error: "firestore unavailable" });
    expect(result.flags.cnbvHighRisk).toBe(false);
  });
});
