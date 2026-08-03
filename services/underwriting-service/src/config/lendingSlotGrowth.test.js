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
  SEED_SLOT_INCREMENT,
  SEED_MAX_INCREMENTS_PER_REVIEW,
  SEED_TIER_1_MAX_AUTO_SLOTS,
  LendingSlotGrowthConfigError,
  getSeedSlotGrowthConfig,
  assertValidSlotGrowthConfig,
  getSlotGrowthConfig,
} = require("./lendingSlotGrowth");

// ── getSeedSlotGrowthConfig ─────────────────────────────────────────────

describe("getSeedSlotGrowthConfig", () => {
  it("returns the ratified (ADR-007) values", () => {
    expect(getSeedSlotGrowthConfig()).toEqual({
      slotIncrement: 10,
      maxIncrementsPerReview: 2,
      tier1MaxAutoSlots: 100,
    });
    expect(SEED_SLOT_INCREMENT).toBe(10);
    expect(SEED_MAX_INCREMENTS_PER_REVIEW).toBe(2);
    expect(SEED_TIER_1_MAX_AUTO_SLOTS).toBe(100);
  });
});

// ── assertValidSlotGrowthConfig ─────────────────────────────────────────

describe("assertValidSlotGrowthConfig", () => {
  it("returns the value when all fields are positive integers and the ceiling is reachable", () => {
    const value = { slotIncrement: 10, maxIncrementsPerReview: 2, tier1MaxAutoSlots: 100 };
    expect(assertValidSlotGrowthConfig(value, "ctx")).toEqual(value);
  });

  it("throws when a field is missing, zero, negative, non-integer, or non-numeric", () => {
    const base = { slotIncrement: 10, maxIncrementsPerReview: 2, tier1MaxAutoSlots: 100 };
    expect(() => assertValidSlotGrowthConfig({ ...base, slotIncrement: 0 }, "ctx")).toThrow(
      LendingSlotGrowthConfigError
    );
    expect(() => assertValidSlotGrowthConfig({ ...base, maxIncrementsPerReview: -1 }, "ctx")).toThrow(
      LendingSlotGrowthConfigError
    );
    expect(() => assertValidSlotGrowthConfig({ ...base, tier1MaxAutoSlots: 5.5 }, "ctx")).toThrow(
      LendingSlotGrowthConfigError
    );
    expect(() => assertValidSlotGrowthConfig({ ...base, slotIncrement: "10" }, "ctx")).toThrow(
      LendingSlotGrowthConfigError
    );
    expect(() => assertValidSlotGrowthConfig(null, "ctx")).toThrow(LendingSlotGrowthConfigError);
    expect(() => assertValidSlotGrowthConfig(undefined, "ctx")).toThrow(LendingSlotGrowthConfigError);
  });

  it("throws when the ceiling is below the increment (an unreachable rule)", () => {
    expect(() =>
      assertValidSlotGrowthConfig(
        { slotIncrement: 10, maxIncrementsPerReview: 2, tier1MaxAutoSlots: 5 },
        "ctx"
      )
    ).toThrow(LendingSlotGrowthConfigError);
  });
});

// ── getSlotGrowthConfig ──────────────────────────────────────────────────

describe("getSlotGrowthConfig", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("returns the seed when the config document does not exist", async () => {
    mockGet.mockResolvedValue({ exists: false });
    await expect(getSlotGrowthConfig()).resolves.toEqual(getSeedSlotGrowthConfig());
  });

  it("returns the stored values when the document is valid", async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ slotIncrement: 5, maxIncrementsPerReview: 3, tier1MaxAutoSlots: 100 }),
    });
    await expect(getSlotGrowthConfig()).resolves.toEqual({
      slotIncrement: 5,
      maxIncrementsPerReview: 3,
      tier1MaxAutoSlots: 100,
    });
  });

  it("throws when a field is missing", async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ slotIncrement: 10 }) });
    await expect(getSlotGrowthConfig()).rejects.toThrow(LendingSlotGrowthConfigError);
  });

  it("throws when a field is out of domain", async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ slotIncrement: 10, maxIncrementsPerReview: 0, tier1MaxAutoSlots: 100 }),
    });
    await expect(getSlotGrowthConfig()).rejects.toThrow(LendingSlotGrowthConfigError);
  });

  it("throws rather than falling back to the seed when the read fails", async () => {
    mockGet.mockRejectedValue(new Error("network down"));
    await expect(getSlotGrowthConfig()).rejects.toThrow(LendingSlotGrowthConfigError);
  });

  it("throws rather than falling back to the seed when the document has no data", async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => null });
    await expect(getSlotGrowthConfig()).rejects.toThrow(LendingSlotGrowthConfigError);
  });
});
