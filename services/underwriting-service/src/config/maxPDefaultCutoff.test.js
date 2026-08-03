"use strict";

const mockGet = jest.fn();
jest.mock("firebase-admin", () => ({
  firestore: () => ({
    collection: () => ({
      doc: () => ({ get: mockGet }),
    }),
  }),
}));

const {
  SEED_MAX_PDEFAULT,
  MaxPDefaultConfigError,
  getSeedMaxPDefault,
  assertValidMaxPDefault,
  getMaxPDefault,
} = require("./maxPDefaultCutoff");

// ── getSeedMaxPDefault ────────────────────────────────────────────────────

describe("getSeedMaxPDefault", () => {
  it("returns the ratified value (ADR-006, 2026-08-03)", () => {
    expect(getSeedMaxPDefault()).toBe(0.15);
    expect(SEED_MAX_PDEFAULT).toBe(0.15);
  });
});

// ── assertValidMaxPDefault ────────────────────────────────────────────────

describe("assertValidMaxPDefault", () => {
  it("returns the value when it is a finite number in (0, 1]", () => {
    expect(assertValidMaxPDefault(0.35, "ctx")).toBe(0.35);
    expect(assertValidMaxPDefault(1, "ctx")).toBe(1);
    expect(assertValidMaxPDefault(0.0001, "ctx")).toBe(0.0001);
  });

  it("throws for 0 (not a usable cutoff, outside the accepted domain)", () => {
    expect(() => assertValidMaxPDefault(0, "ctx")).toThrow(MaxPDefaultConfigError);
  });

  it("throws for values above 1, negative values, NaN and non-numbers", () => {
    expect(() => assertValidMaxPDefault(1.5, "ctx")).toThrow(MaxPDefaultConfigError);
    expect(() => assertValidMaxPDefault(-0.1, "ctx")).toThrow(MaxPDefaultConfigError);
    expect(() => assertValidMaxPDefault(NaN, "ctx")).toThrow(MaxPDefaultConfigError);
    expect(() => assertValidMaxPDefault(Infinity, "ctx")).toThrow(MaxPDefaultConfigError);
    expect(() => assertValidMaxPDefault("0.35", "ctx")).toThrow(MaxPDefaultConfigError);
    expect(() => assertValidMaxPDefault(null, "ctx")).toThrow(MaxPDefaultConfigError);
    expect(() => assertValidMaxPDefault(undefined, "ctx")).toThrow(MaxPDefaultConfigError);
  });
});

// ── getMaxPDefault ────────────────────────────────────────────────────────

describe("getMaxPDefault", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("returns the seed when the config document does not exist", async () => {
    mockGet.mockResolvedValue({ exists: false });
    await expect(getMaxPDefault()).resolves.toBe(SEED_MAX_PDEFAULT);
  });

  it("returns the stored value when the document is valid", async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ value: 0.15 }) });
    await expect(getMaxPDefault()).resolves.toBe(0.15);
  });

  it("throws when 'value' is missing", async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({}) });
    await expect(getMaxPDefault()).rejects.toThrow(MaxPDefaultConfigError);
  });

  it("throws when 'value' is out of the (0, 1] domain", async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ value: 1.2 }) });
    await expect(getMaxPDefault()).rejects.toThrow(MaxPDefaultConfigError);
  });

  it("throws when 'value' is not a number", async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ value: "0.15" }) });
    await expect(getMaxPDefault()).rejects.toThrow(MaxPDefaultConfigError);
  });

  it("throws rather than falling back to the seed when the read fails", async () => {
    mockGet.mockRejectedValue(new Error("network down"));
    await expect(getMaxPDefault()).rejects.toThrow(MaxPDefaultConfigError);
  });

  it("throws rather than falling back to the seed when the document has no data", async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => null });
    await expect(getMaxPDefault()).rejects.toThrow(MaxPDefaultConfigError);
  });
});
