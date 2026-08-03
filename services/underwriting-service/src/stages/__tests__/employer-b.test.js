"use strict";

// ════════════════════════════════════════════════════════════════════
// See #387, #388, ADR-003 (superseded), ADR-007.
//
// ADR-007 (2026-08-03) ratified the slot-growth commercial rule ADR-003
// left open: Tier 1 earns +10 slots per clean payroll cycle, credited only
// at a due-diligence review, capped at 2 increments (20 slots) per review,
// never past the 100-slot ceiling. `assignTier`, `computeInitialSlots`,
// `autoScaleTier1`, and `expandTier2` implement that ruling.
//
// The weighted scoring engine (scoreSATAge through scorePayrollHistory,
// WEIGHTS) and the Firestore-integrated `runEmployerDueDiligence` rewrite
// this file specifies (#387/#388's scoring-model half) are now built in
// `../employer-b`. `runEmployerDueDiligence` returns the NEW shape —
// top-level `tier`, `score`, `maxActiveSlots`, `signals`, `requiresApproval`,
// `reason`; tier 0 (not 3) for a rejected employer — and
// stage3-autoapprove.js reads that shape (`allResults.employerB.tier`,
// with an upper AND lower bound so a spec-conformant 0 fails rather than
// clearing the gate — see stage3-autoapprove.js and
// __tests__/stage3-provenance.test.js).
//
// DO NOT make a still-skipped block green by weakening the assertions to
// match the current source. The assertions are the specification; the
// source is the thing that has not caught up.
//
// To un-skip further: implement the API, then replace `describe.skip` with
// `describe` one block at a time.
// ════════════════════════════════════════════════════════════════════

// ── Mock firebase-admin/firestore ───────────────────────────────────
const mockUpdate = jest.fn().mockResolvedValue();
const mockDoc = jest.fn(() => ({ update: mockUpdate }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));
// The employer document the ADR-008 guard reads inside the transaction to
// decide whether ops owns `maxActiveSlots`. Tests override it per-case.
let mockEmployerDocData = {};
const mockRunTransaction = jest.fn(async (fn) =>
  fn({
    get: jest.fn().mockResolvedValue({ data: () => mockEmployerDocData }),
    // Assert on `mockUpdate` with the payload only, so the existing
    // expectations keep reading the same regardless of doc-vs-transaction.
    update: (_ref, payload) => mockUpdate(payload),
  })
);
const mockGetFirestore = jest.fn(() => ({
  collection: mockCollection,
  runTransaction: mockRunTransaction,
}));

jest.mock("firebase-admin/firestore", () => ({
  getFirestore: mockGetFirestore,
  FieldValue: { serverTimestamp: jest.fn(() => "SERVER_TIMESTAMP") },
}));

const {
  runEmployerDueDiligence,
  scoreSATAge,
  scoreDENUE,
  scoreIMSSEmployees,
  scoreFiscalDebt,
  scorePresunto,
  scoreSectorRisk,
  scorePayrollHistory,
  assignTier,
  computeInitialSlots,
  autoScaleTier1,
  expandTier2,
  WEIGHTS,
  TIER_1_THRESHOLD,
  TIER_2_THRESHOLD,
  TIER_1_INITIAL_SLOTS,
  TIER_1_MAX_AUTO_SLOTS,
  TIER_2_INITIAL_SLOTS,
  TIER_2_EXPANSION_BANDS,
  TIER_2_UPGRADE_CYCLES,
} = require("../employer-b");

// ── Helpers ─────────────────────────────────────────────────────────
function makeEmployer(overrides = {}) {
  return {
    employerId: "emp_001",
    companyName: "Acme SA de CV",
    rfc: "ACM010101AAA",
    satRegistrationDate: "2010-01-15",
    industry: "manufacturing",
    employeeCount: 50,
    payrollSystem: "CONTPAQi",
    cleanPayrollCycles: 0,
    maxActiveSlots: 0,
    ...overrides,
  };
}

function makePartAResults(overrides = {}) {
  return {
    check69B: { pass: true, flag: false, hardReject: false },
    art69: { hasDebt: false, count: 0, pass: true },
    denue: {
      found: true,
      topMatch: { fechaAlta: "2015-03-01", sector: "31-33" },
      pass: true,
    },
    sectorRisk: { riskLevel: "bajo", pass: true },
    imssVerification: [
      { curp: "CURP1", rfcMatch: true, imssActive: true },
      { curp: "CURP2", rfcMatch: true, imssActive: true },
      { curp: "CURP3", rfcMatch: true, imssActive: true },
    ],
    ...overrides,
  };
}

// ── Reset mocks ─────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  mockEmployerDocData = {};
});

// ═══════════════════════════════════════════════════════════════════
// Individual scoring functions
// ═══════════════════════════════════════════════════════════════════

describe("scoreSATAge", () => {
  it("returns full weight for >= 10 years", () => {
    expect(scoreSATAge("2010-01-01")).toBe(WEIGHTS.satAge);
  });

  it("returns 0 for null/missing date", () => {
    expect(scoreSATAge(null)).toBe(0);
    expect(scoreSATAge(undefined)).toBe(0);
  });

  it("returns partial score for dates between 0 and 10 years", () => {
    const fiveYearsAgo = new Date();
    fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
    const score = scoreSATAge(fiveYearsAgo.toISOString());
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(WEIGHTS.satAge);
  });

  it("returns 0 for future dates", () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 5);
    expect(scoreSATAge(future.toISOString())).toBe(0);
  });
});

describe("scoreDENUE", () => {
  it("returns full weight for established business (>= 5 years)", () => {
    const result = { found: true, topMatch: { fechaAlta: "2015-01-01" } };
    expect(scoreDENUE(result)).toBe(WEIGHTS.denue);
  });

  it("returns 0 for not found", () => {
    expect(scoreDENUE({ found: false })).toBe(0);
    expect(scoreDENUE(null)).toBe(0);
  });

  it("returns partial score for 2-5 year establishment", () => {
    const threeYearsAgo = new Date();
    threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
    const result = { found: true, topMatch: { fechaAlta: threeYearsAgo.toISOString() } };
    expect(scoreDENUE(result)).toBe(Math.round(WEIGHTS.denue * 0.75));
  });

  it("returns base score when found but no fechaAlta", () => {
    const result = { found: true, topMatch: {} };
    expect(scoreDENUE(result)).toBe(Math.round(WEIGHTS.denue * 0.5));
  });
});

describe("scoreIMSSEmployees", () => {
  it("returns full weight when all employees verified", () => {
    const results = [
      { rfcMatch: true, imssActive: true },
      { rfcMatch: true, imssActive: true },
      { rfcMatch: true, imssActive: true },
    ];
    expect(scoreIMSSEmployees(results)).toBe(WEIGHTS.imssEmployees);
  });

  it("returns 0 for no results", () => {
    expect(scoreIMSSEmployees(null)).toBe(0);
    expect(scoreIMSSEmployees([])).toBe(0);
  });

  it("returns partial score for partial matches", () => {
    const results = [
      { rfcMatch: true, imssActive: true },
      { rfcMatch: false, imssActive: true },
      { rfcMatch: true, imssActive: false },
    ];
    const score = scoreIMSSEmployees(results);
    expect(score).toBe(Math.round((1 / 3) * WEIGHTS.imssEmployees));
  });
});

describe("scoreFiscalDebt", () => {
  it("returns full weight when no debt", () => {
    expect(scoreFiscalDebt({ hasDebt: false })).toBe(WEIGHTS.fiscalDebt);
  });

  it("returns 0 when debt exists", () => {
    expect(scoreFiscalDebt({ hasDebt: true })).toBe(0);
  });

  it("returns full weight when no data", () => {
    expect(scoreFiscalDebt(null)).toBe(WEIGHTS.fiscalDebt);
  });
});

describe("scorePresunto", () => {
  it("returns full weight when clean", () => {
    expect(scorePresunto({ pass: true, flag: false, hardReject: false })).toBe(WEIGHTS.presunto);
  });

  it("returns 0 for PRESUNTO flag", () => {
    expect(scorePresunto({ pass: false, flag: true, hardReject: false })).toBe(0);
  });

  it("returns 0 for DEFINITIVO hardReject", () => {
    expect(scorePresunto({ pass: false, flag: false, hardReject: true })).toBe(0);
  });

  it("returns full weight when no data", () => {
    expect(scorePresunto(null)).toBe(WEIGHTS.presunto);
  });
});

describe("scoreSectorRisk", () => {
  it("returns full weight for bajo", () => {
    expect(scoreSectorRisk({ riskLevel: "bajo" })).toBe(WEIGHTS.sectorRisk);
  });

  it("returns half weight for medio", () => {
    expect(scoreSectorRisk({ riskLevel: "medio" })).toBe(Math.round(WEIGHTS.sectorRisk * 0.5));
  });

  it("returns 0 for alto", () => {
    expect(scoreSectorRisk({ riskLevel: "alto" })).toBe(0);
  });

  it("returns 75% for unknown", () => {
    expect(scoreSectorRisk({ riskLevel: "unknown" })).toBe(Math.round(WEIGHTS.sectorRisk * 0.75));
  });

  it("returns full weight when no data", () => {
    expect(scoreSectorRisk(null)).toBe(WEIGHTS.sectorRisk);
  });
});

describe("scorePayrollHistory", () => {
  it("returns full weight for >= 6 clean cycles", () => {
    expect(scorePayrollHistory(6)).toBe(WEIGHTS.payrollHistory);
    expect(scorePayrollHistory(12)).toBe(WEIGHTS.payrollHistory);
  });

  it("returns 0 for no cycles", () => {
    expect(scorePayrollHistory(0)).toBe(0);
    expect(scorePayrollHistory(null)).toBe(0);
  });

  it("returns partial score for 1-5 cycles", () => {
    expect(scorePayrollHistory(3)).toBe(Math.round((3 / 6) * WEIGHTS.payrollHistory));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Tier assignment
// ═══════════════════════════════════════════════════════════════════

describe("assignTier", () => {
  it("assigns Tier 1 for score >= 70", () => {
    expect(assignTier(70)).toBe(1);
    expect(assignTier(85)).toBe(1);
    expect(assignTier(100)).toBe(1);
  });

  it("assigns Tier 2 for score 40-69", () => {
    expect(assignTier(40)).toBe(2);
    expect(assignTier(55)).toBe(2);
    expect(assignTier(69)).toBe(2);
  });

  it("rejects for score < 40", () => {
    expect(assignTier(0)).toBe(0);
    expect(assignTier(20)).toBe(0);
    expect(assignTier(39)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Slot management
// ═══════════════════════════════════════════════════════════════════

describe("computeInitialSlots", () => {
  it("returns 10 for Tier 1", () => {
    expect(computeInitialSlots(1)).toBe(TIER_1_INITIAL_SLOTS);
  });

  it("returns 3 for Tier 2", () => {
    expect(computeInitialSlots(2)).toBe(TIER_2_INITIAL_SLOTS);
  });

  it("returns 0 for rejected (tier 0)", () => {
    expect(computeInitialSlots(0)).toBe(0);
  });
});

describe("autoScaleTier1", () => {
  it("adds 10 slots per clean cycle", () => {
    const result = autoScaleTier1(10, 1);
    expect(result.newSlots).toBe(20);
    expect(result.requiresManualReview).toBe(false);
  });

  // ADR-007 (2026-08-03) ratified the hybrid rule ADR-003 found this fixture
  // contradicting: +10/cycle EARNED, but credited only at a review and
  // capped at 2 increments (20 slots) per review. 3 clean cycles earn 30,
  // but only 2 increments (20) are credited this review, so 10 + 20 = 30,
  // not the flat-math 40 this fixture asserted before ADR-007. The
  // remaining clean cycle is forfeited under the conservative reading (see
  // ADR-007's open question) — it does not carry forward to the next
  // review.
  it("caps at 2 credited increments per review even when more cycles were earned", () => {
    const result = autoScaleTier1(10, 3);
    expect(result.newSlots).toBe(30);
    expect(result.requiresManualReview).toBe(false);
    expect(result.incrementsCredited).toBe(2);
    expect(result.cyclesForfeited).toBe(1);
  });

  it("caps at 100 and flags manual review", () => {
    const result = autoScaleTier1(90, 2);
    expect(result.newSlots).toBe(TIER_1_MAX_AUTO_SLOTS);
    expect(result.requiresManualReview).toBe(true);
  });

  it("flags manual review when already at cap", () => {
    const result = autoScaleTier1(95, 1);
    expect(result.newSlots).toBe(TIER_1_MAX_AUTO_SLOTS);
    expect(result.requiresManualReview).toBe(true);
  });

  it("handles scaling from initial slots", () => {
    const result = autoScaleTier1(10, 0);
    expect(result.newSlots).toBe(10);
    expect(result.requiresManualReview).toBe(false);
  });
});

describe("expandTier2", () => {
  it("expands from 3 to 6", () => {
    const result = expandTier2(3, 1);
    expect(result.newSlots).toBe(6);
    expect(result.requiresApproval).toBe(true);
    expect(result.eligibleForUpgrade).toBe(false);
  });

  it("expands from 6 to 10", () => {
    const result = expandTier2(6, 3);
    expect(result.newSlots).toBe(10);
    expect(result.requiresApproval).toBe(true);
  });

  it("stays at 10 when at max band", () => {
    const result = expandTier2(10, 5);
    expect(result.newSlots).toBe(10);
    expect(result.requiresApproval).toBe(true);
  });

  it("marks eligible for upgrade at 10 clean cycles", () => {
    const result = expandTier2(10, 10);
    expect(result.eligibleForUpgrade).toBe(true);
    expect(result.reason).toContain("eligible for Tier 1 upgrade review");
  });

  it("marks eligible for upgrade beyond 10 cycles", () => {
    const result = expandTier2(6, 15);
    expect(result.eligibleForUpgrade).toBe(true);
  });

  it("not eligible for upgrade below 10 cycles", () => {
    const result = expandTier2(3, 9);
    expect(result.eligibleForUpgrade).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Integration: runEmployerDueDiligence
// ═══════════════════════════════════════════════════════════════════

describe("runEmployerDueDiligence", () => {
  describe("Tier 1 outcome", () => {
    it("assigns Tier 1 with 10 initial slots for a strong employer", async () => {
      const employer = makeEmployer({ satRegistrationDate: "2010-01-01" });
      const partA = makePartAResults();

      const result = await runEmployerDueDiligence(employer, partA);

      expect(result.pass).toBe(true);
      expect(result.tier).toBe(1);
      expect(result.score).toBeGreaterThanOrEqual(TIER_1_THRESHOLD);
      expect(result.maxActiveSlots).toBe(TIER_1_INITIAL_SLOTS);
      expect(result.signals).toBeDefined();
    });

    // ADR-007 (2026-08-03): 4 clean cycles earn 40, but only 2 increments
    // (20 slots) are credited per review — "let's do two max" — so
    // 30 + 20 = 50, not the flat-math 40 ("// 30 + 10") this fixture
    // asserted before ADR-007 superseded ADR-003. The other 2 earned
    // cycles are forfeited under the conservative reading (see ADR-007's
    // open question), not banked for the next review.
    // ADR-009: the accrual now reads `cleanPayrollCyclesSinceReview`, not the
    // LIFETIME `cleanPayrollCycles`. Both are 4 here so the score (which uses
    // the lifetime count) and the credited increments are unchanged from the
    // fixture ADR-007 set — only the field the growth rule reads moved.
    it("auto-scales returning Tier 1 employer, capped at 2 credited increments per review", async () => {
      const employer = makeEmployer({
        satRegistrationDate: "2010-01-01",
        maxActiveSlots: 30,
        cleanPayrollCycles: 4,
        cleanPayrollCyclesSinceReview: 4,
      });
      const partA = makePartAResults();

      const result = await runEmployerDueDiligence(employer, partA);

      expect(result.pass).toBe(true);
      expect(result.tier).toBe(1);
      expect(result.maxActiveSlots).toBe(50); // 30 + min(4, 2) * 10
    });
  });

  describe("Tier 2 outcome", () => {
    it("assigns Tier 2 with 3 initial slots for a marginal employer", async () => {
      // Weaken signals to get score between 40-69
      const employer = makeEmployer({
        satRegistrationDate: "2022-01-01", // young company
        cleanPayrollCycles: 0,
      });
      const partA = makePartAResults({
        imssVerification: [
          { curp: "CURP1", rfcMatch: true, imssActive: true },
          { curp: "CURP2", rfcMatch: false, imssActive: true },
          { curp: "CURP3", rfcMatch: false, imssActive: false },
        ],
        sectorRisk: { riskLevel: "medio" },
      });

      const result = await runEmployerDueDiligence(employer, partA);

      expect(result.pass).toBe(true);
      expect(result.tier).toBe(2);
      expect(result.score).toBeGreaterThanOrEqual(TIER_2_THRESHOLD);
      expect(result.score).toBeLessThan(TIER_1_THRESHOLD);
      expect(result.maxActiveSlots).toBe(TIER_2_INITIAL_SLOTS);
    });

    it("expands returning Tier 2 employer with manual gate", async () => {
      const employer = makeEmployer({
        satRegistrationDate: "2022-01-01",
        maxActiveSlots: 3,
        cleanPayrollCycles: 2,
      });
      const partA = makePartAResults({
        imssVerification: [
          { curp: "CURP1", rfcMatch: true, imssActive: true },
          { curp: "CURP2", rfcMatch: false, imssActive: true },
          { curp: "CURP3", rfcMatch: false, imssActive: false },
        ],
        sectorRisk: { riskLevel: "medio" },
      });

      const result = await runEmployerDueDiligence(employer, partA);

      expect(result.pass).toBe(true);
      expect(result.tier).toBe(2);
      expect(result.maxActiveSlots).toBe(6); // expanded from 3→6
      expect(result.requiresApproval).toBe(true);
    });
  });

  describe("Reject outcome", () => {
    it("rejects employer with score < 40", async () => {
      const employer = makeEmployer({
        satRegistrationDate: null, // no SAT date: 0
        cleanPayrollCycles: 0,     // no history: 0
      });
      const partA = makePartAResults({
        check69B: { pass: false, flag: true, hardReject: false }, // PRESUNTO: 0
        art69: { hasDebt: true, count: 3, pass: false },          // debt: 0
        denue: { found: false },                                   // not found: 0
        sectorRisk: { riskLevel: "alto" },                         // high risk: 0
        imssVerification: [],                                      // none: 0
      });

      const result = await runEmployerDueDiligence(employer, partA);

      expect(result.pass).toBe(false);
      expect(result.tier).toBe(0);
      expect(result.score).toBeLessThan(TIER_2_THRESHOLD);
      expect(result.maxActiveSlots).toBe(0);
      expect(result.reason).toContain("rejected");
    });
  });

  // ═════════════════════════════════════════════════════════════════
  // ADR-009: the slot accrual ledger.
  //
  // Two separate counters, and which one each ratified rule reads:
  //   `cleanPayrollCycles`            (LIFETIME)      -> payrollHistory
  //                                                      score, Tier-2
  //                                                      upgrade clock
  //                                                      (ADR-005 F1 item 2)
  //   `cleanPayrollCyclesSinceReview` (SINCE REVIEW)  -> ADR-007 hybrid
  //                                                      growth
  // Before this split both rules aliased onto one field, which makes them
  // mutually unsatisfiable: forfeiting the Tier-1 accrual to zero also
  // zeroes the lifetime clock a Tier-2 employer needs to reach 10 cycles.
  // ═════════════════════════════════════════════════════════════════
  describe("ADR-009 slot accrual ledger", () => {
    it("credits growth from cycles-since-review, NOT from the lifetime count", async () => {
      // 12 lifetime cycles but none accrued since the last review: a long
      // clean history is not repeatedly re-spendable growth.
      const employer = makeEmployer({
        satRegistrationDate: "2010-01-01",
        maxActiveSlots: 30,
        cleanPayrollCycles: 12,
        cleanPayrollCyclesSinceReview: 0,
      });

      const result = await runEmployerDueDiligence(employer, makePartAResults());

      expect(result.tier).toBe(1);
      expect(result.maxActiveSlots).toBe(30); // preserved, not grown
      expect(result.slotGrowth).toMatchObject({
        cyclesConsidered: 0,
        incrementsCredited: 0,
        cyclesForfeited: 0,
        slotsBefore: 30,
        slotsAfter: 30,
      });
    });

    it("caps credit at 2 increments and reports the forfeited surplus", async () => {
      const employer = makeEmployer({
        satRegistrationDate: "2010-01-01",
        maxActiveSlots: 20,
        cleanPayrollCycles: 5,
        cleanPayrollCyclesSinceReview: 5,
      });

      const result = await runEmployerDueDiligence(employer, makePartAResults());

      expect(result.maxActiveSlots).toBe(40); // 20 + min(5, 2) * 10
      expect(result.slotGrowth).toMatchObject({
        cyclesConsidered: 5,
        incrementsCredited: 2,
        cyclesForfeited: 3, // ADR-007: forfeited, NOT carried forward
      });
    });

    it("clamps at the Tier 1 ceiling and flags manual review", async () => {
      const employer = makeEmployer({
        satRegistrationDate: "2010-01-01",
        maxActiveSlots: 90,
        cleanPayrollCycles: 4,
        cleanPayrollCyclesSinceReview: 2,
      });

      const result = await runEmployerDueDiligence(employer, makePartAResults());

      expect(result.maxActiveSlots).toBe(TIER_1_MAX_AUTO_SLOTS); // 90 + 20 -> 100
      expect(result.requiresApproval).toBe(true);
    });

    it("reports no slotGrowth for a first-time Tier 1 grant", async () => {
      const employer = makeEmployer({ satRegistrationDate: "2010-01-01" });

      const result = await runEmployerDueDiligence(employer, makePartAResults());

      expect(result.maxActiveSlots).toBe(TIER_1_INITIAL_SLOTS);
      expect(result.slotGrowth).toBeNull();
    });

    // A stored slot count is a position on ONE tier's ladder. Carrying it
    // across a tier change puts the employer on the wrong rung in whichever
    // direction it moved.
    it("grants an upgraded Tier-2 employer the Tier-1 initial slots, not an increment off its Tier-2 cap", async () => {
      const employer = makeEmployer({
        satRegistrationDate: "2010-01-01",
        tier: 2,
        maxActiveSlots: 3,
        cleanPayrollCycles: 4,
        cleanPayrollCyclesSinceReview: 4,
      });

      const result = await runEmployerDueDiligence(employer, makePartAResults());

      expect(result.tier).toBe(1);
      // Not autoScaleTier1(3, 4) === 23, and never below a fresh Tier 1.
      expect(result.maxActiveSlots).toBe(TIER_1_INITIAL_SLOTS);
      expect(result.slotGrowth).toBeNull();
    });

    it("drops a downgraded Tier-1 employer to the Tier-2 initial band, not expandTier2's top band", async () => {
      const employer = makeEmployer({
        satRegistrationDate: "2022-01-01",
        tier: 1,
        maxActiveSlots: 50,
        cleanPayrollCycles: 2,
      });
      const partA = makePartAResults({
        imssVerification: [
          { curp: "CURP1", rfcMatch: true, imssActive: true },
          { curp: "CURP2", rfcMatch: false, imssActive: true },
          { curp: "CURP3", rfcMatch: false, imssActive: false },
        ],
        sectorRisk: { riskLevel: "medio" },
      });

      const result = await runEmployerDueDiligence(employer, partA);

      expect(result.tier).toBe(2);
      // expandTier2(50, 2) would clamp to the top band (10). A Tier-1 cap is
      // not a rung on the Tier-2 ladder.
      expect(result.maxActiveSlots).toBe(TIER_2_INITIAL_SLOTS);
    });

    // Every employer written before `tier` existed has it absent. Treating
    // that as "fresh" would move caps nobody chose, on the whole book at once.
    it("treats an ABSENT prior tier as returning, preserving the stored cap", async () => {
      const employer = makeEmployer({
        satRegistrationDate: "2010-01-01",
        maxActiveSlots: 40,
        cleanPayrollCycles: 3,
      });

      const result = await runEmployerDueDiligence(employer, makePartAResults());

      expect(result.tier).toBe(1);
      expect(result.maxActiveSlots).toBe(40);
      expect(result.slotGrowth).not.toBeNull();
    });

    it("keeps the LIFETIME count driving the Tier-2 upgrade clock", async () => {
      const employer = makeEmployer({
        satRegistrationDate: "2022-01-01",
        tier: 2,
        maxActiveSlots: 3,
        cleanPayrollCycles: TIER_2_UPGRADE_CYCLES,
        cleanPayrollCyclesSinceReview: 0, // accrual spent; upgrade clock is not
      });
      // A full 10-cycle lifetime history scores the full payrollHistory
      // weight, so the other signals have to be weak enough to keep this
      // employer inside the 40-69 Tier 2 band.
      const partA = makePartAResults({
        imssVerification: [
          { curp: "CURP1", rfcMatch: true, imssActive: true },
          { curp: "CURP2", rfcMatch: false, imssActive: true },
          { curp: "CURP3", rfcMatch: false, imssActive: false },
        ],
        denue: { found: false },
        sectorRisk: { riskLevel: "alto" },
      });

      const result = await runEmployerDueDiligence(employer, partA);

      expect(result.tier).toBe(2);
      expect(result.maxActiveSlots).toBe(6); // band 3 -> 6
      expect(expandTier2(3, employer.cleanPayrollCycles).eligibleForUpgrade).toBe(true);
    });
  });

  describe("Firestore update", () => {
    it("updates employer document with tier and score", async () => {
      const employer = makeEmployer();
      const partA = makePartAResults();

      await runEmployerDueDiligence(employer, partA);

      expect(mockCollection).toHaveBeenCalledWith("employers");
      expect(mockDoc).toHaveBeenCalledWith("emp_001");
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          employerScore: expect.any(Number),
          maxActiveSlots: expect.any(Number),
          tierAssignedAt: "SERVER_TIMESTAMP",
          lastDueDiligenceAt: "SERVER_TIMESTAMP",
          dueDiligenceResult: expect.objectContaining({
            pass: expect.any(Boolean),
            tier: expect.any(Number),
            score: expect.any(Number),
          }),
        })
      );
    });

    it("sets tier to null and maxActiveSlots to 0 on rejection", async () => {
      const employer = makeEmployer({ satRegistrationDate: null });
      const partA = makePartAResults({
        check69B: { pass: false, flag: true, hardReject: false },
        art69: { hasDebt: true },
        denue: { found: false },
        sectorRisk: { riskLevel: "alto" },
        imssVerification: [],
      });

      await runEmployerDueDiligence(employer, partA);

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          tier: null,
          maxActiveSlots: 0,
        })
      );
    });

    it("skips Firestore update when no employerId", async () => {
      const employer = makeEmployer({ employerId: null });
      const partA = makePartAResults();

      await runEmployerDueDiligence(employer, partA);

      expect(mockCollection).not.toHaveBeenCalled();
    });

    // ── ADR-008: ops override outranks the automated re-score ─────────
    it("does NOT overwrite maxActiveSlots when ops owns the cap", async () => {
      mockEmployerDocData = { maxActiveSlots: 25, maxActiveSlotsSource: "ops_override" };
      const employer = makeEmployer();
      const partA = makePartAResults();

      await runEmployerDueDiligence(employer, partA);

      const payload = mockUpdate.mock.calls[0][0];
      expect(payload).not.toHaveProperty("maxActiveSlots");
      expect(payload).not.toHaveProperty("maxActiveSlotsSource");
      // score/tier/timestamps are still refreshed — only the cap is frozen
      expect(payload).toHaveProperty("employerScore");
      expect(payload.lastDueDiligenceAt).toBe("SERVER_TIMESTAMP");
    });

    it("writes maxActiveSlots tagged due_diligence when no ops override exists", async () => {
      mockEmployerDocData = { maxActiveSlots: 3 };
      const employer = makeEmployer();
      const partA = makePartAResults();

      await runEmployerDueDiligence(employer, partA);

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          maxActiveSlots: expect.any(Number),
          maxActiveSlotsSource: "due_diligence",
        })
      );
    });

    it("treats a MISSING maxActiveSlotsSource as not-an-override", async () => {
      mockEmployerDocData = { maxActiveSlots: 7 };
      const employer = makeEmployer();
      const partA = makePartAResults();

      await runEmployerDueDiligence(employer, partA);

      expect(mockUpdate.mock.calls[0][0]).toHaveProperty("maxActiveSlots");
    });
  });

  describe("signals", () => {
    it("returns all scoring signals in result", async () => {
      const employer = makeEmployer();
      const partA = makePartAResults();

      const result = await runEmployerDueDiligence(employer, partA);

      expect(result.signals).toHaveProperty("satAge");
      expect(result.signals).toHaveProperty("denue");
      expect(result.signals).toHaveProperty("imssEmployees");
      expect(result.signals).toHaveProperty("fiscalDebt");
      expect(result.signals).toHaveProperty("presunto");
      expect(result.signals).toHaveProperty("sectorRisk");
      expect(result.signals).toHaveProperty("payrollHistory");
    });

    it("score equals sum of all signals", async () => {
      const employer = makeEmployer();
      const partA = makePartAResults();

      const result = await runEmployerDueDiligence(employer, partA);

      const signalSum = Object.values(result.signals).reduce((s, v) => s + v, 0);
      expect(result.score).toBe(signalSum);
    });
  });
});
