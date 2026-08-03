"use strict";

// ════════════════════════════════════════════════════════════════════
// PARTIALLY BUILT. See #387, #388, ADR-003 (superseded), ADR-007.
//
// ADR-007 (2026-08-03) ratified the slot-growth commercial rule ADR-003
// left open: Tier 1 earns +10 slots per clean payroll cycle, credited only
// at a due-diligence review, capped at 2 increments (20 slots) per review,
// never past the 100-slot ceiling. `assignTier`, `computeInitialSlots`,
// `autoScaleTier1`, and `expandTier2` are now implemented in
// `../employer-b` against that ruling and are un-skipped below.
//
// Everything else in this file is STILL `describe.skip` and still does not
// exist: the weighted scoring engine (scoreSATAge through
// scorePayrollHistory, WEIGHTS) and the Firestore-integrated
// `runEmployerDueDiligence` rewrite this file also specifies. That is a
// separate, larger feature build (#387/#388's scoring-model half) that
// ADR-007 does not cover and that was NOT part of what was ratified today.
// `runEmployerDueDiligence` in `../employer-b` still returns its original,
// simpler shape (tier 3 for reject, not 0; data.tier, not top-level tier)
// because stage3-autoapprove.js depends on that exact contract.
//
// DO NOT make the still-skipped blocks green by weakening the assertions to
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
const mockGetFirestore = jest.fn(() => ({ collection: mockCollection }));

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
    activeSlots: 0,
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

describe.skip("runEmployerDueDiligence", () => {
  describe("Tier 1 outcome", () => {
    it("assigns Tier 1 with 10 initial slots for a strong employer", async () => {
      const employer = makeEmployer({ satRegistrationDate: "2010-01-01" });
      const partA = makePartAResults();

      const result = await runEmployerDueDiligence(employer, partA);

      expect(result.pass).toBe(true);
      expect(result.tier).toBe(1);
      expect(result.score).toBeGreaterThanOrEqual(TIER_1_THRESHOLD);
      expect(result.activeSlots).toBe(TIER_1_INITIAL_SLOTS);
      expect(result.signals).toBeDefined();
    });

    // ADR-007 (2026-08-03): 4 clean cycles earn 40, but only 2 increments
    // (20 slots) are credited per review — "let's do two max" — so
    // 30 + 20 = 50, not the flat-math 40 ("// 30 + 10") this fixture
    // asserted before ADR-007 superseded ADR-003. The other 2 earned
    // cycles are forfeited under the conservative reading (see ADR-007's
    // open question), not banked for the next review.
    it("auto-scales returning Tier 1 employer, capped at 2 credited increments per review", async () => {
      const employer = makeEmployer({
        satRegistrationDate: "2010-01-01",
        activeSlots: 30,
        cleanPayrollCycles: 4,
      });
      const partA = makePartAResults();

      const result = await runEmployerDueDiligence(employer, partA);

      expect(result.pass).toBe(true);
      expect(result.tier).toBe(1);
      expect(result.activeSlots).toBe(50); // 30 + min(4, 2) * 10
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
      expect(result.activeSlots).toBe(TIER_2_INITIAL_SLOTS);
    });

    it("expands returning Tier 2 employer with manual gate", async () => {
      const employer = makeEmployer({
        satRegistrationDate: "2022-01-01",
        activeSlots: 3,
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
      expect(result.activeSlots).toBe(6); // expanded from 3→6
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
      expect(result.activeSlots).toBe(0);
      expect(result.reason).toContain("rejected");
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
          activeSlots: expect.any(Number),
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

    it("sets tier to null and activeSlots to 0 on rejection", async () => {
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
          activeSlots: 0,
        })
      );
    });

    it("skips Firestore update when no employerId", async () => {
      const employer = makeEmployer({ employerId: null });
      const partA = makePartAResults();

      await runEmployerDueDiligence(employer, partA);

      expect(mockCollection).not.toHaveBeenCalled();
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
