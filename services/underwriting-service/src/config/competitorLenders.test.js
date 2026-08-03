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
  SEED_COMPETITOR_LENDERS,
  CompetitorConfigError,
  getSeedCompetitorLenders,
  getCompetitorLenderNames,
  normalizeForMatch,
  matchesCompetitorLender,
} = require("./competitorLenders");

// ── getSeedCompetitorLenders ─────────────────────────────────────────────

describe("getSeedCompetitorLenders", () => {
  it("returns the incumbent list", () => {
    expect(getSeedCompetitorLenders()).toEqual(["KUESKI", "MoneyMan", "CREDITEA"]);
  });

  it("returns a fresh array each call — callers cannot mutate the seed", () => {
    const first = getSeedCompetitorLenders();
    first.push("SOMETHING_ELSE");
    expect(getSeedCompetitorLenders()).toEqual(["KUESKI", "MoneyMan", "CREDITEA"]);
  });
});

// ── normalizeForMatch ─────────────────────────────────────────────────────

describe("normalizeForMatch", () => {
  it("uppercases, strips accents, and collapses punctuation to single spaces", () => {
    expect(normalizeForMatch("Kuéski, S.A.P.I. de C.V.")).toBe("KUESKI S A P I DE C V");
  });

  it("returns an empty string for null/undefined/empty input", () => {
    expect(normalizeForMatch(null)).toBe("");
    expect(normalizeForMatch(undefined)).toBe("");
    expect(normalizeForMatch("")).toBe("");
  });
});

// ── matchesCompetitorLender ───────────────────────────────────────────────

describe("matchesCompetitorLender", () => {
  const names = ["KUESKI", "MoneyMan", "CREDITEA"];

  it("matches case-insensitively", () => {
    expect(matchesCompetitorLender("kueski pay sa de cv", names)).toBe(true);
  });

  it("matches through surrounding legal-entity noise", () => {
    expect(matchesCompetitorLender("KUESKI SAPI DE CV", names)).toBe(true);
    expect(matchesCompetitorLender("CREDITEA MX", names)).toBe(true);
    expect(matchesCompetitorLender("MoneyMan Mexico", names)).toBe(true);
  });

  it("matches accent-insensitively", () => {
    expect(matchesCompetitorLender("KÜÉSKI PAY", names)).toBe(true);
  });

  it("returns false for non-competitor lenders", () => {
    expect(matchesCompetitorLender("BANCOMER", names)).toBe(false);
    expect(matchesCompetitorLender("BANAMEX", names)).toBe(false);
  });

  it("does not substring-match a short token inside an unrelated word", () => {
    // A short future token embedded inside a longer, unrelated legal name
    // must not match — the whole reason for word-boundary matching.
    expect(matchesCompetitorLender("BANCO AEFISA MEXICO", ["AEF"])).toBe(false);
    expect(matchesCompetitorLender("SUPERKUESKIPAY SA", ["KUESKI"])).toBe(false);
  });

  it("returns false for null, empty, or all-whitespace input", () => {
    expect(matchesCompetitorLender(null, names)).toBe(false);
    expect(matchesCompetitorLender("", names)).toBe(false);
    expect(matchesCompetitorLender("   ", names)).toBe(false);
    expect(matchesCompetitorLender("KUESKI", [])).toBe(false);
    expect(matchesCompetitorLender("KUESKI", null)).toBe(false);
  });
});

// ── getCompetitorLenderNames ──────────────────────────────────────────────

describe("getCompetitorLenderNames", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("returns the seed when the config document does not exist", async () => {
    mockGet.mockResolvedValue({ exists: false });
    await expect(getCompetitorLenderNames()).resolves.toEqual([...SEED_COMPETITOR_LENDERS]);
  });

  it("returns the stored list when the document is valid", async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ names: ["KUESKI", "NEWLENDER"] }) });
    await expect(getCompetitorLenderNames()).resolves.toEqual(["KUESKI", "NEWLENDER"]);
  });

  it("throws when 'names' is not an array", async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ names: "not-an-array" }) });
    await expect(getCompetitorLenderNames()).rejects.toThrow(CompetitorConfigError);
  });

  it("throws when 'names' is an empty array", async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ names: [] }) });
    await expect(getCompetitorLenderNames()).rejects.toThrow(CompetitorConfigError);
  });

  it("throws when the stored array has a blank entry", async () => {
    mockGet.mockResolvedValue({ exists: true, data: () => ({ names: ["KUESKI", ""] }) });
    await expect(getCompetitorLenderNames()).rejects.toThrow(CompetitorConfigError);
  });

  it("throws rather than falling back to the seed when the read fails", async () => {
    mockGet.mockRejectedValue(new Error("network down"));
    await expect(getCompetitorLenderNames()).rejects.toThrow(CompetitorConfigError);
  });
});
