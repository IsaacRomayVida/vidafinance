"use strict";

// ════════════════════════════════════════════════════════════════════
// PENDING — THIS FEATURE DOES NOT EXIST. See #387.
//
// Every describe in this file is `describe.skip`. Nothing here is
// checked, and nothing here has ever passed. All three functions
// destructured below are `undefined` at require time:
// `../stage3-autoapprove` exports `runAutoApproveGate` and
// `evaluateAutoApprove` (stage3-autoapprove.js:185) and nothing else.
//
// This is not a rename. The shipped gate and the gate specified here
// disagree on which conditions are checked and on the numbers behind
// them:
//
//   - Competitor detection. The `hasCompetitorLoans` block below
//     specifies keyword matching on the creditor name (KUESKI /
//     MoneyMan / CREDITEA). Shipped, it is a numeric count the bureau
//     already handed us (stage3-autoapprove.js:66) — no names, no
//     matching.
//   - Three of ten conditions differ. This spec checks
//     dias_atraso_zero, cartera_vencida_false and xgboost_pdefault.
//     The shipped gate checks no_active_defaults and age_range
//     instead (stage3-autoapprove.js:104-119).
//   - The P(default) cutoff disagrees. "fails condition 10: xgboost
//     P(default) >= threshold" requires 0.20 to FAIL, and "pulls
//     xgboostPDefault from challenger model" requires 0.08 to pass,
//     so this spec puts the cutoff in (0.08, 0.20] — its own inline
//     comment says 0.15. The shipped gate derives the cutoff from
//     APPROVAL_THRESHOLD and lands on 0.35 (stage3-autoapprove.js:20,
//     :98), which would approve the very applicant this spec requires
//     us to escalate.
//   - LTI is in different units. Here it is a fraction: "passes
//     condition 4: LTI exactly 25%" passes 0.25 and "fails condition
//     4" fails 0.26. Shipped, it is a percentage compared against 25
//     (stage3-autoapprove.js:60), under which 0.26 sails through.
//
// Which of those is right is a credit-policy question, not an
// engineering one, so it is not being answered here. See
// docs/adr/ADR-003-lending-slot-autoscale-not-implemented.md.
//
// Unlike employer-b.test.js this suite does NOT contradict itself —
// it is implementable exactly as written once the cutoff and the
// condition set are ratified. #387's title says the spec
// self-contradicts; that is true of employer-b and not of this file.
//
// DO NOT make this green by weakening the assertions to match the
// current source, and do not delete it: it is the only surviving
// record of the intended ten-condition gate.
// ════════════════════════════════════════════════════════════════════

const {
  runStage3,
  evaluateGate,
  hasCompetitorLoans,
} = require("../stage3-autoapprove");

// ── Fixtures ────────────────────────────────────────────────────────────────

const ALL_PASS_PARAMS = {
  employerTier: 1,
  tenureMonths: 12,
  bureauScore: 700,
  lti: 0.20,
  cuentasActivas: [],
  riskSealScore: 75,
  sectorFlagged: false,
  diasAtraso: 0,
  carteraVencida: false,
  xgboostPDefault: 0.05,
};

const STAGE2_RESULT = {
  bureau: {
    score: 700,
    diasAtraso: 0,
    carteraVencida: false,
    cuentasActivas: 2,
  },
  employment: {
    tenureMonths: 12,
  },
  lti: 0.20,
  ml: {
    champion: { pDefault: 0.05, model: "woe_scorecard" },
    challenger: { pDefault: 0.08, model: "xgboost", shadow: true },
  },
};

// ── hasCompetitorLoans ──────────────────────────────────────────────────────

describe.skip("hasCompetitorLoans", () => {
  it("returns false for empty or null accounts", () => {
    expect(hasCompetitorLoans(null)).toBe(false);
    expect(hasCompetitorLoans([])).toBe(false);
  });

  it("returns false when no competitors present", () => {
    const accounts = [
      { otorgante: "BANCOMER" },
      { otorgante: "BANAMEX" },
    ];
    expect(hasCompetitorLoans(accounts)).toBe(false);
  });

  it("detects Kueski as competitor", () => {
    const accounts = [{ otorgante: "KUESKI PAY SA DE CV" }];
    expect(hasCompetitorLoans(accounts)).toBe(true);
  });

  it("detects MoneyMan as competitor (case insensitive)", () => {
    const accounts = [{ nombreOtorgante: "MoneyMan Mexico" }];
    expect(hasCompetitorLoans(accounts)).toBe(true);
  });

  it("detects multiple competitor keywords", () => {
    const accounts = [
      { otorgante: "BANCOMER" },
      { otorgante: "CREDITEA MX" },
    ];
    expect(hasCompetitorLoans(accounts)).toBe(true);
  });
});

// ── evaluateGate ────────────────────────────────────────────────────────────

describe.skip("evaluateGate", () => {
  it("approves when all 10 conditions pass", () => {
    const result = evaluateGate(ALL_PASS_PARAMS);
    expect(result.decision).toBe("approved");
    expect(result.allPass).toBe(true);
    expect(result.conditionsPassed).toBe(10);
    expect(result.conditionsTotal).toBe(10);
    expect(result.failures).toHaveLength(0);
    expect(result.escalateToStage).toBeNull();
  });

  it("escalates to stage 4 when any condition fails", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, bureauScore: 500 });
    expect(result.decision).toBe("escalate");
    expect(result.escalateToStage).toBe(4);
    expect(result.allPass).toBe(false);
  });

  // ── Individual condition failures ───────────────────────────────────────

  it("fails condition 1: employer tier 3", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, employerTier: 3 });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 1);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("employer_tier");
  });

  it("fails condition 2: tenure <= 6 months", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, tenureMonths: 6 });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 2);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("imss_tenure");
  });

  it("fails condition 3: bureau score <= 600", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, bureauScore: 600 });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 3);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("bureau_score");
  });

  it("fails condition 4: LTI > 25%", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, lti: 0.26 });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 4);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("lti");
  });

  it("passes condition 4: LTI exactly 25%", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, lti: 0.25 });
    const cond = result.conditions.find(c => c.id === 4);
    expect(cond.pass).toBe(true);
  });

  it("fails condition 5: competitor loans found", () => {
    const accounts = [{ otorgante: "KUESKI PAY" }];
    const result = evaluateGate({ ...ALL_PASS_PARAMS, cuentasActivas: accounts });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 5);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("no_competitor_loans");
  });

  it("fails condition 6: RiskSeal score <= 60", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, riskSealScore: 60 });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 6);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("riskseal_score");
  });

  it("fails condition 7: sector flagged", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, sectorFlagged: true });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 7);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("sector_safe");
  });

  it("fails condition 8: diasAtraso > 0", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, diasAtraso: 1 });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 8);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("dias_atraso_zero");
  });

  it("fails condition 9: carteraVencida true", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, carteraVencida: true });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 9);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("cartera_vencida_false");
  });

  it("fails condition 10: xgboost P(default) >= threshold", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, xgboostPDefault: 0.20 });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 10);
    expect(failure).toBeDefined();
    expect(failure.name).toBe("xgboost_pdefault");
  });

  it("fails condition 10: xgboost P(default) is null", () => {
    const result = evaluateGate({ ...ALL_PASS_PARAMS, xgboostPDefault: null });
    expect(result.allPass).toBe(false);
    const failure = result.failures.find(f => f.id === 10);
    expect(failure).toBeDefined();
  });

  it("reports multiple failures", () => {
    const result = evaluateGate({
      ...ALL_PASS_PARAMS,
      employerTier: 3,
      bureauScore: 400,
      diasAtraso: 5,
    });
    expect(result.allPass).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
    expect(result.conditionsPassed).toBeLessThan(10);
  });

  it("handles null values safely", () => {
    const result = evaluateGate({
      employerTier: null,
      tenureMonths: null,
      bureauScore: null,
      lti: null,
      cuentasActivas: null,
      riskSealScore: null,
      sectorFlagged: null,
      diasAtraso: null,
      carteraVencida: null,
      xgboostPDefault: null,
    });
    expect(result.allPass).toBe(false);
    // Only condition 5 (no_competitor_loans) passes with null cuentasActivas
    expect(result.failures.length).toBe(9);
  });
});

// ── runStage3 ───────────────────────────────────────────────────────────────

describe.skip("runStage3", () => {
  it("approves when stage2 result + lookups all pass", () => {
    const result = runStage3({
      stage2Result: STAGE2_RESULT,
      employerTier: 1,
      riskSealScore: 75,
      sectorFlagged: false,
      cuentasActivasDetail: [],
    });
    expect(result.decision).toBe("approved");
    expect(result.allPass).toBe(true);
  });

  it("escalates when stage2 bureau score too low", () => {
    const result = runStage3({
      stage2Result: {
        ...STAGE2_RESULT,
        bureau: { ...STAGE2_RESULT.bureau, score: 550 },
      },
      employerTier: 1,
      riskSealScore: 75,
      sectorFlagged: false,
    });
    expect(result.decision).toBe("escalate");
    expect(result.escalateToStage).toBe(4);
  });

  it("pulls xgboostPDefault from challenger model", () => {
    const result = runStage3({
      stage2Result: STAGE2_RESULT,
      employerTier: 1,
      riskSealScore: 75,
      sectorFlagged: false,
    });
    // xgboostPDefault = 0.08 from challenger, < 0.15 threshold
    const cond10 = result.conditions.find(c => c.id === 10);
    expect(cond10.value).toBe(0.08);
    expect(cond10.pass).toBe(true);
  });

  it("fails when employer tier is missing from stage2", () => {
    const result = runStage3({
      stage2Result: STAGE2_RESULT,
      employerTier: 3,
      riskSealScore: 75,
      sectorFlagged: false,
    });
    expect(result.allPass).toBe(false);
    expect(result.failures.some(f => f.name === "employer_tier")).toBe(true);
  });
});
